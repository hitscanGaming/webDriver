import { useState, useEffect, useRef, useCallback } from 'react';
import { WebHIDService } from '../services/WebHIDService.js';
import { fwinfo as dfuFwinfo, parseDfuZip, dfuTransfer } from '../services/DFUService.js';

// Slot capacity per pm_static.yml / CH32V305 SRAM image buffer.
// Image size is checked against this before the user can hit Start.
const SLOT_MAX_BYTES_BY_TARGET = {
  mouse: 0x7c000,    // 496 KB — hitscan_nrf52840/pm_static.yml
  dongle: 0x1c000,   // 112 KB — hitscan52820_nrf52820/pm_static.yml
  ch32v305: 0x4000,  // 16 KB — firmware/ch32v305/User/dfu.c DFU_IMAGE_BUFFER_BYTES
};

// Manifest `board` field expected for each target. Used to warn when a user
// drops a zip built for the other target.
const EXPECTED_BOARD_BY_TARGET = {
  mouse: 'hitscan',         // matches "hitscan" / "hitscan_nrf52840"
  dongle: 'hitscan52820',
  ch32v305: 'ch32v305',
};

const TARGET_LABEL = {
  mouse: 'Mouse',
  dongle: 'Dongle',
  ch32v305: 'CH32V305',
};

const formatBytes = (n) => `${(n / 1024).toFixed(1)} KB`;
const formatPct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '0%');
const formatDuration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const phaseLabel = (phase) => {
  if (!phase) return 'idle';
  if (phase.startsWith('resuming')) return `Resuming at ${phase.slice('resuming-at-'.length)} B…`;
  switch (phase) {
    case 'computing-csum': return 'Computing checksum…';
    case 'syncing':        return 'Syncing with device…';
    case 'erasing-slot':   return 'Erasing destination slot…';
    case 'storing':        return 'Device is writing to flash…';
    case 'transferring':   return 'Transferring image…';
    case 'finalising':     return 'Finalising…';
    case 'rebooting':      return 'Rebooting — wait for reconnect…';
    default:               return phase;
  }
};

export const FirmwareView = ({ onProtocolError, onUpdatingChange, isDongle = false }) => {
  // Dongle handles can reach two DFU targets: the dongle itself (SPI
  // recipient=2) and the CH32V305 bridge (SPI recipient=3). Mouse DFU is
  // wired-only — pushing the ~100 KB mouse image over the slow ESB config
  // channel is impractical, so it isn't offered wirelessly. Wired-mouse
  // handles reach only the mouse. Persist the dongle-side selection across
  // reloads for ergonomics.
  const availableTargets = isDongle ? ['dongle', 'ch32v305'] : ['mouse'];
  const [target, setTarget] = useState(() => {
    if (!isDongle) return 'mouse';
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('hitscan.dfu.target') : null;
    return availableTargets.includes(stored) ? stored : availableTargets[0];
  });
  useEffect(() => {
    if (isDongle && typeof localStorage !== 'undefined') {
      localStorage.setItem('hitscan.dfu.target', target);
    }
  }, [isDongle, target]);

  const [fwInfoState, setFwInfoState] = useState({ loading: true, info: null, error: null });
  const [imageState, setImageState] = useState({ file: null, bytes: null, slotName: null, error: null });
  const [transfer, setTransfer] = useState({ running: false, bytesSent: 0, total: 0, phase: '', startedAt: 0, error: null, ok: false });
  const abortRef = useRef(null);
  // Hidden + custom-button file picker — Chrome localizes the native
  // <input type="file"> button text to the OS locale, which surfaces e.g.
  // "选择文件" on Chinese systems. The hidden-input + label-as-button pattern
  // lets us own the button text.
  const fileInputRef = useRef(null);

  // Resolve dfuMod lazily inside callbacks/effects — calling
  // WebHIDService.findDfuModule() in the render body returns a new object
  // identity every render, which would invalidate any [dfuMod]-deps callback
  // and trigger an infinite useEffect loop.

  const loadFwInfo = useCallback(async () => {
    setFwInfoState({ loading: true, info: null, error: null });
    // Dongle discovery is lazy: only runs the ~11 extra round trips when the
    // Firmware tab is actually opened against a dongle handle.
    if (target === 'dongle' && !WebHIDService.dongleConfigMap) {
      const discovered = await WebHIDService.discoverDongleConfig?.();
      if (!discovered) {
        setFwInfoState({ loading: false, info: null, error: 'Dongle did not respond to config-channel discovery. Confirm dongle DFU build is flashed.' });
        return;
      }
    }
    const dfuMod = WebHIDService.findDfuModule?.(target);
    if (!dfuMod) {
      setFwInfoState({ loading: false, info: null, error: `DFU module not discovered for target=${target}.` });
      return;
    }
    try {
      const info = await dfuFwinfo(WebHIDService, dfuMod.id, dfuMod.options.fwinfo ?? 5, dfuMod.recipient);
      if (!info) {
        setFwInfoState({ loading: false, info: null, error: 'fwinfo fetch returned no data.' });
        return;
      }
      setFwInfoState({ loading: false, info, error: null });
    } catch (e) {
      setFwInfoState({ loading: false, info: null, error: e.message });
    }
  }, [target]);

  useEffect(() => { loadFwInfo(); }, [loadFwInfo]);

  // Notify App that an update is in progress (so it can pause the battery poll).
  useEffect(() => {
    onUpdatingChange?.(transfer.running);
  }, [transfer.running, onUpdatingChange]);

  // After the mouse reboots into the new slot, the prior HID handle is dead and
  // the React reconnect path can't resync reliably. Easiest reset is a full page
  // reload — WebHID permissions persist for the origin, so the browser auto-
  // grants the new handle on reload.
  const [reloadIn, setReloadIn] = useState(null);
  useEffect(() => {
    if (!transfer.ok) return;
    setReloadIn(5);
    const tick = setInterval(() => {
      setReloadIn((n) => {
        if (n <= 1) {
          clearInterval(tick);
          window.location.reload();
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [transfer.ok]);

  const onPickFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!fwInfoState.info) {
      setImageState({ file: null, bytes: null, slotName: null, error: 'Wait for fwinfo to load first.' });
      return;
    }
    let parsed;
    try {
      parsed = await parseDfuZip(file, fwInfoState.info.flashAreaId);
    } catch {
      // Surface zip-parse failures (missing manifest, malformed JSON, no slot
      // entry) with a single user-friendly message rather than the raw error.
      setImageState({ file: null, bytes: null, slotName: null, error: 'zip package is not valid.' });
      return;
    }
    const { imageBytes, slotBinName, targetSlot, semver, manifestJson } = parsed;
    const slotMax = SLOT_MAX_BYTES_BY_TARGET[target] ?? SLOT_MAX_BYTES_BY_TARGET.mouse;
    if (imageBytes.byteLength > slotMax) {
      setImageState({
        file: null, bytes: null, slotName: null,
        error: `Image is ${formatBytes(imageBytes.byteLength)} — exceeds ${target} slot capacity ${formatBytes(slotMax)}.`,
      });
      return;
    }
    // Sanity-check the manifest's board against the connected target so a
    // user who drops a mouse zip while connected via dongle (or vice versa)
    // sees a clear error before kicking off a multi-minute transfer.
    const expectedBoard = EXPECTED_BOARD_BY_TARGET[target];
    const manifestBoard = manifestJson?.files?.[0]?.board ?? '';
    const boardMatches = manifestBoard.startsWith(expectedBoard);
    if (!boardMatches) {
      setImageState({
        file: null, bytes: null, slotName: null,
        error: `This zip targets board "${manifestBoard || 'unknown'}" but you're connected via ${target}. Pick a zip built for the ${target} target.`,
      });
      return;
    }
    // Prefer SemVer from the VERSION sidecar (scripts/build.ps1 injects it).
    // Older zips without VERSION fall back to '—' so the row stays present.
    setImageState({ file, bytes: imageBytes, slotName: slotBinName, targetSlot, version: semver ?? '—', error: null });
  };

  const onStart = async () => {
    const dfuMod = WebHIDService.findDfuModule?.(target);
    if (!imageState.bytes || !dfuMod) return;
    abortRef.current = new AbortController();
    const startedAt = Date.now();
    setTransfer({ running: true, bytesSent: 0, total: imageState.bytes.byteLength, phase: 'preparing', startedAt, error: null, ok: false });

    // dfuTransfer's exchanges re-throw on a send failure (e.g. the dongle/bridge
    // dropping the handle mid-transfer -- common in wireless). Without this
    // try/catch a throw escapes here and leaves transfer.running stuck true,
    // which permanently disables the Choose file + Start buttons until reload.
    let result;
    try {
      result = await dfuTransfer(WebHIDService, dfuMod, imageState.bytes, {
        signal: abortRef.current.signal,
        onProgress: (sent, total) => {
          setTransfer((t) => ({ ...t, bytesSent: sent, total }));
        },
        onPhase: (phase) => {
          setTransfer((t) => ({ ...t, phase }));
        },
      });
    } catch (e) {
      result = { ok: false, error: e?.message ? `transfer failed: ${e.message}` : 'transfer failed (device disconnected?)' };
    }

    if (result.ok) {
      setTransfer((t) => ({ ...t, running: false, phase: 'rebooting', ok: true, error: null }));
    } else {
      setTransfer((t) => ({ ...t, running: false, error: result.error, ok: false }));
      if (onProtocolError) onProtocolError('DFU transfer', result.error);
    }
  };

  const onCancel = () => {
    abortRef.current?.abort();
  };

  const renderFwInfo = () => {
    if (fwInfoState.loading) return <p className="text-sm text-statusInfo">Reading firmware info…</p>;
    if (fwInfoState.error)   return <p className="text-sm text-statusDanger">{fwInfoState.error}</p>;
    const i = fwInfoState.info;
    if (!i) return null;
    const fwVersion = `${i.verMajor}.${i.verMinor}.${i.verRev}`;
    return (
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="text-gray-400">Version</div>
        <div className="font-mono">{fwVersion}</div>
        <div className="text-gray-400">Image Size</div>
        <div className="font-mono">{formatBytes(i.imageLen)}</div>
      </div>
    );
  };

  const renderImage = () => {
    if (imageState.error) {
      return <p className="text-sm text-statusDanger">{imageState.error}</p>;
    }
    if (!imageState.bytes) {
      return <p className="text-sm text-gray-400">Pick a <code>.zip</code> package built for this device.</p>;
    }
    const i = fwInfoState.info;
    // CH32V305 is single-bank: always overwrite, no slot check. mouse/dongle
    // use B0 dual-bank and require the zip's slot to be opposite the running one.
    const targetMatches = target === 'ch32v305'
      ? !!i
      : i && imageState.targetSlot === (1 - i.flashAreaId);
    return (
      <div className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-2 items-center text-sm">
        <div className="text-gray-400">File</div>
        <div className="font-mono break-all">{imageState.file?.name}</div>
        <div className="text-gray-400">Version</div>
        <div className="font-mono">{imageState.version}</div>
        <div className="text-gray-400">Status</div>
        <div className={targetMatches ? 'text-statusSuccess' : 'text-statusDanger'}>
          {targetMatches ? '✓ Ready to install' : 'Not compatible with current firmware.'}
        </div>
        <div className="text-gray-400">Image Size</div>
        <div className="font-mono">{formatBytes(imageState.bytes.byteLength)}</div>
      </div>
    );
  };

  const renderTransfer = () => {
    const { running, bytesSent, total, phase, startedAt, error, ok } = transfer;
    if (!running && !error && !ok) return null;

    const elapsed = startedAt ? Date.now() - startedAt : 0;
    const rate = elapsed > 0 ? bytesSent / (elapsed / 1000) : 0;
    const remaining = rate > 0 ? Math.round(((total - bytesSent) / rate) * 1000) : 0;
    const pct = formatPct(bytesSent, total);

    return (
      <div className="space-y-2">
        <div className="h-3 w-full bg-inputDark rounded overflow-hidden">
          <div
            className={`h-full transition-all duration-200 ${ok ? 'bg-statusSuccess' : error ? 'bg-statusDanger' : 'bg-statusInfo'}`}
            style={{ width: pct }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-400 font-mono">
          <span>{formatBytes(bytesSent)} / {formatBytes(total)} ({pct})</span>
          <span>{phaseLabel(phase)}</span>
        </div>
        {running && (
          <div className="flex justify-between text-xs text-gray-400 font-mono">
            <span>Elapsed: {formatDuration(elapsed)}</span>
            {rate > 0 && bytesSent > 0 && <span>ETA: ~{formatDuration(remaining)}</span>}
          </div>
        )}
        {error && <p className="text-sm text-statusDanger">DFU failed: {error}</p>}
        {ok && (
          <p className="text-sm text-statusSuccess">
            Transfer complete. The {TARGET_LABEL[target].toLowerCase()} is rebooting — reloading the web driver{reloadIn !== null ? ` in ${reloadIn}s…` : '…'}
          </p>
        )}
      </div>
    );
  };

  const canStart = !!imageState.bytes && !transfer.running && !!fwInfoState.info && (
    target === 'ch32v305'
      ? true
      : imageState.targetSlot === (1 - (fwInfoState.info?.flashAreaId ?? -2))
  );

  return (
    <div className="absolute inset-0 overflow-y-auto space-y-6 p-4 animate-[slideInRight_0.3s]">
      {availableTargets.length > 1 && (
        <section className="bg-panelDark border border-borderDark rounded-lg p-4 space-y-2">
          <div className="text-xs text-gray-400">Target chip</div>
          <div className="inline-flex rounded border border-borderDark overflow-hidden">
            {availableTargets.map((t) => (
              <button
                key={t}
                onClick={() => {
                  if (transfer.running) return;
                  setTarget(t);
                  setImageState({ file: null, bytes: null, slotName: null, error: null });
                }}
                disabled={transfer.running}
                className={`px-4 py-1.5 text-sm transition-colors ${
                  target === t
                    ? 'bg-statusInfo text-black font-semibold'
                    : 'bg-inputDark text-gray-300 hover:bg-borderDark'
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {TARGET_LABEL[t]}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="bg-panelDark border border-borderDark rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Current firmware <span className="text-xs text-gray-500 font-normal">— {TARGET_LABEL[target]}</span>
          </h2>
          <button
            className="text-xs text-statusInfo hover:underline"
            onClick={loadFwInfo}
            disabled={fwInfoState.loading || transfer.running}
          >
            Refresh
          </button>
        </div>
        {renderFwInfo()}
      </section>

      <section className="bg-panelDark border border-borderDark rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Update firmware</h2>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/zip"
            onChange={onPickFile}
            disabled={transfer.running}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={transfer.running}
            className="bg-inputDark border border-borderDark hover:border-gray-500 text-gray-200 text-sm px-3 py-1 rounded disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Choose file
          </button>
        </div>
        {renderImage()}
      </section>

      <section className="bg-panelDark border border-borderDark rounded-lg p-4 space-y-3">
        <h2 className="text-lg font-semibold">Update</h2>
        <p className="text-xs text-gray-400">
          {target === 'dongle' &&
            'The transfer typically runs ~30 seconds over the USB SPI bridge. Do not unplug. The dongle will reboot automatically when it finishes — please unplug and replug the dongle once the page reloads.'}
          {target === 'ch32v305' &&
            'The transfer typically runs ~10 seconds over the USB HID bridge. The CH32V305 stages the image in SRAM, then erases and rewrites its own flash in a single blocking pass. Do not unplug. The mouse will be unusable for ~1 second during the commit.'}
          {target === 'mouse' &&
            'The transfer typically runs 5–10 minutes over the wired USB cable. Do not unplug. The mouse will reboot automatically when it finishes.'}
        </p>
        <div className="flex gap-2">
          <button
            onClick={onStart}
            disabled={!canStart}
            className="bg-statusInfo text-black font-semibold px-4 py-2 rounded disabled:opacity-40"
          >
            Start update
          </button>
          {transfer.running && (
            <button onClick={onCancel} className="bg-statusDanger text-black font-semibold px-4 py-2 rounded">
              Cancel
            </button>
          )}
        </div>
        {renderTransfer()}
      </section>
    </div>
  );
};
