import { useState, useEffect, useRef, useCallback } from 'react';
import { WebHIDService } from '../services/WebHIDService.js';
import { fwinfo as dfuFwinfo, parseDfuZip, dfuTransfer } from '../services/DFUService.js';

const SLOT_MAX_BYTES = 0x7c000; // 496 KB — matches pm_static.yml s0_image / s1_image size

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

export const FirmwareView = ({ onProtocolError, onUpdatingChange }) => {
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
    const dfuMod = WebHIDService.findDfuModule?.();
    if (!dfuMod) {
      setFwInfoState({ loading: false, info: null, error: 'DFU module not discovered on this device.' });
      return;
    }
    try {
      const info = await dfuFwinfo(WebHIDService, dfuMod.id, dfuMod.options.fwinfo ?? 5);
      if (!info) {
        setFwInfoState({ loading: false, info: null, error: 'fwinfo fetch returned no data.' });
        return;
      }
      setFwInfoState({ loading: false, info, error: null });
    } catch (e) {
      setFwInfoState({ loading: false, info: null, error: e.message });
    }
  }, []);

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
    const { imageBytes, slotBinName, targetSlot, semver } = parsed;
    if (imageBytes.byteLength > SLOT_MAX_BYTES) {
      setImageState({
        file: null, bytes: null, slotName: null,
        error: `Image is ${formatBytes(imageBytes.byteLength)} — exceeds slot capacity ${formatBytes(SLOT_MAX_BYTES)}.`,
      });
      return;
    }
    // Prefer SemVer from the VERSION sidecar (scripts/build.ps1 injects it).
    // Older zips without VERSION fall back to '—' so the row stays present.
    setImageState({ file, bytes: imageBytes, slotName: slotBinName, targetSlot, version: semver ?? '—', error: null });
  };

  const onStart = async () => {
    const dfuMod = WebHIDService.findDfuModule?.();
    if (!imageState.bytes || !dfuMod) return;
    abortRef.current = new AbortController();
    const startedAt = Date.now();
    setTransfer({ running: true, bytesSent: 0, total: imageState.bytes.byteLength, phase: 'preparing', startedAt, error: null, ok: false });

    const result = await dfuTransfer(WebHIDService, dfuMod, imageState.bytes, {
      signal: abortRef.current.signal,
      onProgress: (sent, total) => {
        setTransfer((t) => ({ ...t, bytesSent: sent, total }));
      },
      onPhase: (phase) => {
        setTransfer((t) => ({ ...t, phase }));
      },
    });

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
    const targetMatches = i && imageState.targetSlot === (1 - i.flashAreaId);
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
            Transfer complete. The mouse is rebooting — reloading the web driver{reloadIn !== null ? ` in ${reloadIn}s…` : '…'}
          </p>
        )}
      </div>
    );
  };

  const canStart = !!imageState.bytes && !transfer.running && !!fwInfoState.info &&
                   imageState.targetSlot === (1 - (fwInfoState.info?.flashAreaId ?? -2));

  return (
    <div className="absolute inset-0 overflow-y-auto space-y-6 p-4 animate-[slideInRight_0.3s]">
      <section className="bg-panelDark border border-borderDark rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Current firmware</h2>
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
          The transfer typically runs 5–10 minutes over the wired USB cable. Do not unplug. The mouse will reboot automatically when it finishes.
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
