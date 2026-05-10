import { useState, useRef } from 'react';
import { WebHIDService, DfuState } from '../services/WebHIDService';
import { McubootImage, McubootImageParseError } from '../services/McubootImage';
import { Icons } from '../components/Icons';

// Phases drive the UI layout. The order on screen mirrors the user journey.
const Phase = {
    IDLE: 'idle',           // panel open, no DFU in progress
    PARSED: 'parsed',       // file picked, header validated, awaiting confirm
    PREFLIGHT: 'preflight', // dfuSync + dfuStart in flight
    UPLOADING: 'uploading', // streaming chunks
    REBOOTING: 'rebooting', // dfuReboot fired, waiting for re-enumeration
    VERIFYING: 'verifying', // device back, reading fwinfo
    DONE: 'done',
    ERROR: 'error',
};

const CHUNK_SIZE = 25; // REPORT_USER_CONFIG_SIZE (29) - 4-byte header

function formatVersion(v) {
    return v ? `${v.major}.${v.minor}.${v.revision}+${v.build}` : '—';
}

export function SettingsPanel({ show, onClose, deviceInfo, onDfuStart, onDfuEnd }) {
    const [phase, setPhase] = useState(Phase.IDLE);
    const [picked, setPicked] = useState(null);          // { file, image }
    const [progress, setProgress] = useState({ sent: 0, total: 0 });
    const [error, setError] = useState('');
    const [statusLine, setStatusLine] = useState('');
    const cancelRef = useRef(false);
    const fileInputRef = useRef(null);

    const reset = () => {
        setPhase(Phase.IDLE);
        setPicked(null);
        setProgress({ sent: 0, total: 0 });
        setError('');
        setStatusLine('');
        cancelRef.current = false;
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleFile = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const buf = await file.arrayBuffer();
            const image = McubootImage.parse(buf);
            setPicked({ file, image });
            setPhase(Phase.PARSED);
            setError('');
        } catch (err) {
            setError(err instanceof McubootImageParseError ? err.message : `Failed to read file: ${err.message}`);
            setPhase(Phase.ERROR);
        }
    };

    const runUpload = async () => {
        if (!picked) return;
        cancelRef.current = false;
        setError('');
        setPhase(Phase.PREFLIGHT);
        setStatusLine('Checking device state…');
        onDfuStart?.();

        // Snapshot the pre-DFU fwinfo so we can detect "version changed = success"
        // without comparing against the picked file's MCUboot header (which uses
        // imgtool's sem_ver — different from the B0 fw_info_find() path's
        // build_num that the firmware actually reports).
        const preFwInfo = await WebHIDService.dfuFwInfo({ timeoutMs: 600 });

        const { image } = picked;
        const total = image.bytes.length;

        try {
            // 1) Sync probe — decide whether to resume or start fresh.
            let sync = await WebHIDService.dfuSync();
            if (!sync) throw new Error('Device did not respond to dfu/sync');

            if (sync.state === DfuState.ACTIVE_OTHER) {
                throw new Error('Another DFU transport is active. Restart the device and retry.');
            }
            if (sync.state === DfuState.CLEANING) {
                setStatusLine('Erasing flash slot… (this can take a few seconds)');
                // poll until cleaning finishes
                for (let i = 0; i < 60 && sync.state === DfuState.CLEANING; i++) {
                    if (cancelRef.current) throw new Error('Cancelled');
                    await new Promise(r => setTimeout(r, 500));
                    sync = await WebHIDService.dfuSync();
                    if (!sync) throw new Error('Device unresponsive during erase');
                }
                if (sync.state === DfuState.CLEANING) throw new Error('Flash erase timed out');
            }

            const matchesPrior = sync.imgSize === total && sync.checksum === image.checksum && sync.offset > 0;
            const startOffset = matchesPrior ? sync.offset : 0;
            if (matchesPrior) {
                setStatusLine(`Resuming from ${startOffset} / ${total} bytes…`);
            } else {
                setStatusLine('Starting upload…');
            }

            // 2) Start handshake.
            const ok = await WebHIDService.dfuStart(total, image.checksum, startOffset);
            if (!ok) throw new Error('dfu/start rejected');

            // dfuStart triggers a slot erase if the partition is dirty.
            // Sending dfuData while the firmware is still in CLEANING causes
            // sendFeatureReport to reject ("Failed to write the feature report")
            // because the USB stack stalls during erase. Wait for state to
            // settle out of CLEANING before pushing chunks.
            setStatusLine('Preparing slot…');
            const eraseDeadline = performance.now() + 30000;
            while (performance.now() < eraseDeadline) {
                if (cancelRef.current) throw new Error('Cancelled');
                const s = await WebHIDService.dfuSync();
                if (!s) throw new Error('dfu/sync stopped responding during erase wait');
                if (s.state !== DfuState.CLEANING) break;
                await new Promise(r => setTimeout(r, 200));
            }

            setPhase(Phase.UPLOADING);
            setProgress({ sent: startOffset, total });
            setStatusLine('Uploading…');

            // 3) Upload chunks; sync after each sync-buffer's worth to flush to flash.
            const flushEvery = Math.max(1, Math.floor(sync.syncBufBytes / CHUNK_SIZE));
            let offset = startOffset;
            let chunksSinceFlush = 0;
            const t0 = performance.now();
            let lastUiUpdate = 0;

            while (offset < total) {
                if (cancelRef.current) throw new Error('Cancelled');

                const end = Math.min(offset + CHUNK_SIZE, total);
                const chunk = image.bytes.subarray(offset, end);
                let sent;
                try {
                    sent = await WebHIDService.dfuData(chunk);
                } catch (err) {
                    // Transient USB stalls happen during flash erase windows.
                    // Brief pause + retry once before giving up.
                    await new Promise(r => setTimeout(r, 100));
                    try {
                        sent = await WebHIDService.dfuData(chunk);
                    } catch (err2) {
                        throw new Error(`USB write failed at offset ${offset}: ${err2.message || err.message}`, { cause: err2 });
                    }
                }
                if (!sent) throw new Error(`Chunk @${offset} rejected`);
                offset = end;
                chunksSinceFlush++;

                // Throttle UI updates: ~10 Hz is enough; React rerenders are not free.
                const now = performance.now();
                if (now - lastUiUpdate > 100 || offset === total) {
                    setProgress({ sent: offset, total });
                    lastUiUpdate = now;
                }

                if (chunksSinceFlush >= flushEvery || offset === total) {
                    // dfuSync returns the *current* flash offset (cur_offset),
                    // but the firmware's RAM-to-flash write is an async
                    // delayable work. The first sync call schedules the flush;
                    // we have to keep polling until cur_offset catches up to
                    // what we've buffered. The first flush after dfuStart may
                    // also need to wait for slot erase, which is slow on a
                    // fresh partition (seconds).
                    const flushDeadline = performance.now() + 10000;
                    let flushed;
                    while (performance.now() < flushDeadline) {
                        if (cancelRef.current) throw new Error('Cancelled');
                        flushed = await WebHIDService.dfuSync();
                        if (!flushed) throw new Error('Sync flush failed');
                        if (flushed.offset >= offset) break;
                        if (offset === total) {
                            setStatusLine(`Flushing ${flushed.offset.toLocaleString()} / ${total.toLocaleString()} bytes…`);
                        }
                        await new Promise(r => setTimeout(r, 50));
                    }
                    if (!flushed || flushed.offset < offset) {
                        throw new Error(`Flush stalled: device=${flushed?.offset ?? 'no-response'}, host=${offset}`);
                    }
                    chunksSinceFlush = 0;
                }
            }

            const elapsed = (performance.now() - t0) / 1000;
            setStatusLine(`Upload complete in ${elapsed.toFixed(1)} s. Finalizing…`);

            // Mirror upstream `dfu_sync_wait_until_inactive`: the per-flush
            // poll only confirms `cur_offset` advanced — the firmware may
            // still be in DFU_STATE_STORING for one more page write or
            // post-upload bookkeeping. Wait for state to settle to INACTIVE
            // before issuing reboot; otherwise the swap-and-reset can race
            // an in-flight flash write.
            const settleDeadline = performance.now() + 10000;
            let finalSync;
            while (performance.now() < settleDeadline) {
                if (cancelRef.current) throw new Error('Cancelled');
                finalSync = await WebHIDService.dfuSync();
                if (!finalSync) throw new Error('dfu/sync stopped responding before reboot');
                if (finalSync.state === DfuState.INACTIVE) break;
                await new Promise(r => setTimeout(r, 100));
            }
            if (!finalSync || finalSync.state !== DfuState.INACTIVE) {
                throw new Error(`DFU did not settle to inactive (state=${finalSync?.state}, offset=${finalSync?.offset})`);
            }
            if (finalSync.offset !== total) {
                throw new Error(`Final offset mismatch: device=${finalSync.offset}, host=${total}`);
            }

            setStatusLine('Rebooting…');
            setPhase(Phase.REBOOTING);

            // 4) Reboot — fire-and-forget; device disconnects.
            await WebHIDService.dfuReboot();

            // 5) Wait for reconnect (the App-level pollConnectionStatus will reopen the device
            //    via HID events). We just poll fwinfo here until it returns.
            setPhase(Phase.VERIFYING);
            setStatusLine('Verifying new firmware…');
            let fwinfo = null;
            for (let i = 0; i < 30; i++) {
                if (cancelRef.current) break;
                await new Promise(r => setTimeout(r, 1000));
                try {
                    fwinfo = await WebHIDService.dfuFwInfo({ timeoutMs: 800 });
                    if (fwinfo) break;
                } catch {
                    // device still down; keep polling
                }
            }

            if (!fwinfo) {
                throw new Error('Device did not return after reboot. Check the mouse and reconnect.');
            }

            // Compare pre vs post device-side fwinfo. The Hitscan mouse uses
            // B0+MCUboot, so the firmware's fwinfo path reports
            // build_num=CONFIG_FW_INFO_FIRMWARE_VERSION with major/minor/revision
            // forced to 0 — comparing against the picked file's MCUboot
            // sem_ver (imgtool-driven) would always mismatch even on success.
            const sameAsBefore = preFwInfo
                && preFwInfo.version.major === fwinfo.version.major
                && preFwInfo.version.minor === fwinfo.version.minor
                && preFwInfo.version.revision === fwinfo.version.revision
                && preFwInfo.version.build === fwinfo.version.build;
            if (sameAsBefore) {
                throw new Error(`Device booted the previous firmware (${formatVersion(fwinfo.version)}). MCUboot likely reverted — check the image signature / version.`);
            }

            setStatusLine(`Updated to ${formatVersion(fwinfo.version)}.`);
            setPhase(Phase.DONE);
        } catch (err) {
            setError(err.message || String(err));
            setPhase(Phase.ERROR);
        } finally {
            onDfuEnd?.();
        }
    };

    if (!show) return null;

    const pct = progress.total > 0 ? Math.floor((progress.sent / progress.total) * 100) : 0;
    const inFlight = phase === Phase.PREFLIGHT || phase === Phase.UPLOADING || phase === Phase.REBOOTING || phase === Phase.VERIFYING;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={inFlight ? undefined : onClose}>
            <div className="w-[520px] bg-panelDark border border-borderDark rounded-lg shadow-2xl ring-1 ring-white/5" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between px-5 h-10 border-b border-borderDark">
                    <span className="text-sm font-bold tracking-wide text-white">Settings</span>
                    <button onClick={onClose} disabled={inFlight} className="text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed">
                        <Icons.X />
                    </button>
                </div>

                <div className="p-5 space-y-5 text-xs">
                    {/* Device info */}
                    <div className="grid grid-cols-[110px_1fr] gap-y-1.5 gap-x-3 font-mono text-[11px]">
                        <span className="text-gray-500">Board</span><span className="text-gray-200 truncate">{deviceInfo?.boardName || '—'}</span>
                        <span className="text-gray-500">HWID</span><span className="text-gray-200 truncate">{deviceInfo?.hwid || '—'}</span>
                        <span className="text-gray-500">Firmware</span><span className="text-gray-200">{deviceInfo?.fwVersion || '—'}</span>
                        <span className="text-gray-500">Bootloader</span><span className="text-gray-200">{deviceInfo?.bootloader || '—'}</span>
                    </div>

                    <hr className="border-borderDark" />

                    {/* DFU section */}
                    <div className="space-y-3">
                        <div className="text-gray-300 font-bold tracking-wide">Firmware Update</div>

                        {phase === Phase.IDLE && (
                            <>
                                <p className="text-gray-500 leading-relaxed">
                                    Pick a signed <span className="font-mono">app_update.bin</span> produced by the build. The mouse must be wired via USB.
                                </p>
                                <input ref={fileInputRef} type="file" accept=".bin" onChange={handleFile} className="block text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-statusInfo file:text-black file:font-bold file:cursor-pointer hover:file:bg-blue-400" />
                            </>
                        )}

                        {phase === Phase.PARSED && picked && (
                            <>
                                <div className="grid grid-cols-[110px_1fr] gap-y-1 gap-x-3 font-mono text-[11px]">
                                    <span className="text-gray-500">File</span><span className="text-gray-200 truncate">{picked.file.name}</span>
                                    <span className="text-gray-500">Size</span><span className="text-gray-200">{picked.image.totalSize.toLocaleString()} bytes</span>
                                    <span className="text-gray-500">Format</span><span className="text-gray-200">{picked.image.format === 'mcuboot' ? 'MCUboot signed' : 'B0-signed / raw'}</span>
                                    <span className="text-gray-500">New version</span><span className="text-gray-200">{picked.image.version ? formatVersion(picked.image.version) : '— (verified via device after reboot)'}</span>
                                    <span className="text-gray-500">CRC-32</span><span className="text-gray-200">0x{picked.image.checksum.toString(16).padStart(8, '0')}</span>
                                </div>
                                <div className="flex justify-end gap-2 pt-2">
                                    <button onClick={reset} className="px-3 py-1.5 text-xs text-gray-300 hover:text-white">Pick different file</button>
                                    <button onClick={runUpload} className="px-4 py-1.5 text-xs font-bold text-black bg-statusInfo hover:bg-blue-400 rounded">Start Update</button>
                                </div>
                            </>
                        )}

                        {inFlight && (
                            <>
                                <div className="space-y-2">
                                    <div className="flex justify-between text-gray-400">
                                        <span>{statusLine}</span>
                                        <span className="font-mono">{phase === Phase.UPLOADING ? `${pct}%` : ''}</span>
                                    </div>
                                    <div className="h-2 bg-[#0b0b0b] rounded overflow-hidden border border-borderDark">
                                        <div className="h-full bg-statusInfo transition-[width] duration-100" style={{ width: phase === Phase.UPLOADING ? `${pct}%` : (phase === Phase.PREFLIGHT ? '5%' : '100%') }} />
                                    </div>
                                    <div className="text-[10px] text-gray-600 font-mono">{progress.sent.toLocaleString()} / {progress.total.toLocaleString()} bytes</div>
                                </div>
                                {phase === Phase.UPLOADING && (
                                    <button onClick={() => { cancelRef.current = true; }} className="px-3 py-1.5 text-xs text-gray-300 hover:text-statusDanger">Cancel</button>
                                )}
                            </>
                        )}

                        {phase === Phase.DONE && (
                            <>
                                <div className="bg-statusSuccess/15 border border-statusSuccess/40 text-statusSuccess px-3 py-2 rounded">
                                    {statusLine}
                                </div>
                                <button onClick={reset} className="text-gray-400 hover:text-white">Update another image</button>
                            </>
                        )}

                        {phase === Phase.ERROR && (
                            <>
                                <div className="bg-statusDanger/15 border border-statusDanger/40 text-statusDanger px-3 py-2 rounded">
                                    {error || 'Update failed.'}
                                </div>
                                <p className="text-gray-500 leading-relaxed">
                                    The previous firmware is unaffected — MCUboot only swaps after a complete, verified upload.
                                </p>
                                <button onClick={reset} className="px-3 py-1.5 text-xs text-gray-300 hover:text-white">Try again</button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
