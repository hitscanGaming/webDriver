// DFU Service — wired-only firmware update over the HID config channel.
//
// Pure-logic port of C:\ncs\v3.0.2\nrf\scripts\hid_configurator\modules\dfu.py
// against the WebHIDService transport. No React; UI calls dfuTransfer() with
// an AbortSignal + progress callback.
//
// Wire formats (LE throughout):
//   fwinfo  FETCH response  13 B  <B I B B H I> = [flash_area_id, image_len,
//                                                  ver_major, ver_minor,
//                                                  ver_rev (u16), ver_build_nr (u32)]
//   sync    FETCH response  15 B  <B I I I H>   = [dfu_state, img_length,
//                                                  img_csum, offset,
//                                                  sync_buffer_size (u16)]
//   start   SET request     12 B  <I I I>       = [length, csum, offset]
//   data    SET request     up to 9 B raw bytes
//   reboot  FETCH response   1 B  <?>           = scheduled
//
// DFU state values from firmware/mouse/src/modules/dfu.c:
export const DFU_STATE = Object.freeze({
  INACTIVE: 0x00,
  ACTIVE_CONFIG_CHANNEL: 0x01,
  STORING: 0x02,
  CLEANING: 0x03,
  ACTIVE_OTHER: 0x04,
});

// Max data bytes per DFU `data` SET. The transport caps event_data_len at
// REPORT_USER_CONFIG_SIZE(29) - TRANSPORT_HEADER(4) = 25.
//
// The full 25 works on the WIRED/mouse path (recipient 0, direct USB) --
// verified byte-identical on hardware. But on the DONGLE path (recipient 0x02,
// via the CH32V305 SPI bridge) the 25th data byte lands at the last byte of the
// CH32V305's UserConfigData copy and comes through STALE -- every 25-byte chunk
// loses its last byte, corrupting the image (flash diff: mismatch at chunk-
// relative offset 24, every 25 bytes; wired at 25 shows 0 mismatches). Root
// cause is a 1-byte off-by-one in the CH32V305 SET_REPORT copy path. Until that
// firmware framing is fixed, cap the DONGLE path at 24; the wired path keeps 25.
const chunkMaxForRecipient = (recipient) => (recipient === RECIPIENT_MOUSE ? 25 : 24);

import { ConfigStatus, buildEventId, RECIPIENT_MOUSE } from './WebHIDService.js';
import { unthrottledSleep } from './unthrottledSleep.js';

// Multi-minute DFU keeps running when the user switches tabs / apps. Browsers
// throttle setTimeout to ~1 s once the tab is hidden (and worse after 5 min),
// which would stretch a 5-10 min transfer into an hour. unthrottledSleep is
// driven by a Web Worker (not throttled in background) so the chunk loop and
// sync polls keep their full cadence regardless of foreground state.
const DFU_OPTS = { sleep: unthrottledSleep, verbose: false };

// CRC-32 IEEE 802.3 with seed = 1 (matches Python zlib.crc32(data, 1)).
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32Init1(bytes) {
  let c = (~1) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (~c) >>> 0;
}

// Low-level wire helpers — each returns null on failure.
//
// All require a discovered DFU module descriptor (svc.findDfuModule()).
//
async function dfuExchange(svc, recipient, modId, optId, status, dataBytes = null, opts = {}) {
  const eventId = buildEventId(modId, optId);
  const data = dataBytes ? dataBytes.buffer.slice(dataBytes.byteOffset, dataBytes.byteOffset + dataBytes.byteLength) : null;
  // Merge caller opts on top of DFU_OPTS so per-call pollIntervalMs etc. wins
  // but the unthrottled sleeper + verbose=false defaults always apply.
  return await svc.exchangeFeatureReport(recipient, eventId, status, data, { ...DFU_OPTS, ...opts });
}

export async function fwinfo(svc, modId, optId, recipient = RECIPIENT_MOUSE) {
  const r = await dfuExchange(svc, recipient, modId, optId, ConfigStatus.FETCH);
  if (!r || r.byteLength < 13) return null;
  const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
  return {
    flashAreaId: v.getUint8(0),
    imageLen:    v.getUint32(1, true),
    verMajor:    v.getUint8(5),
    verMinor:    v.getUint8(6),
    verRev:      v.getUint16(7, true),
    verBuildNr:  v.getUint32(9, true),
  };
}

export async function syncFetch(svc, modId, optId, recipient = RECIPIENT_MOUSE, opts = {}) {
  const r = await dfuExchange(svc, recipient, modId, optId, ConfigStatus.FETCH, null, opts);
  if (!r || r.byteLength < 15) return null;
  const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
  return {
    state:           v.getUint8(0),
    imgLength:       v.getUint32(1, true),
    imgCsum:         v.getUint32(5, true),
    offset:          v.getUint32(9, true),
    syncBufferSize:  v.getUint16(13, true),
  };
}

export async function startSet(svc, modId, optId, length, csum, offset, recipient = RECIPIENT_MOUSE) {
  const buf = new ArrayBuffer(12);
  const v = new DataView(buf);
  v.setUint32(0, length, true);
  v.setUint32(4, csum, true);
  v.setUint32(8, offset, true);
  const r = await dfuExchange(svc, recipient, modId, optId, ConfigStatus.SET, new Uint8Array(buf));
  return r != null;
}

export async function sendDataChunk(svc, modId, optId, chunkBytes, recipient = RECIPIENT_MOUSE, opts = {}) {
  const r = await dfuExchange(svc, recipient, modId, optId, ConfigStatus.SET, chunkBytes, opts);
  return r != null;
}

export async function rebootRequest(svc, modId, optId, recipient = RECIPIENT_MOUSE) {
  const r = await dfuExchange(svc, recipient, modId, optId, ConfigStatus.FETCH);
  return r != null;
}

// Wait while STORING or CLEANING. Returns the last sync info, or null on failure / abort.
async function waitUntilNotBusy(svc, modId, optSync, recipient, { signal, onPhase } = {}) {
  const STORING_INITIAL_DELAY_MS = 300;
  const STORING_MAX_DELAY_MS = 1000;
  let delay = STORING_INITIAL_DELAY_MS;

  // A sync FETCH is an idempotent read of DFU state, so a lost response on the
  // dongle's SPI bridge (#107) is always safe to retry -- unlike a data SET. The
  // bridge drops responses more often while the slot is actively storing, which
  // is exactly when this loop runs, so retry a bounded number of times before
  // treating the device as truly unresponsive.
  const MAX_SYNC_RETRIES = 40;
  let syncRetries = 0;

  while (true) {
    if (signal?.aborted) return null;
    const info = await syncFetch(svc, modId, optSync, recipient, { verbose: false });
    if (!info) {
      if (++syncRetries > MAX_SYNC_RETRIES) return null;
      await unthrottledSleep(20);
      continue;
    }
    syncRetries = 0;
    if (info.state !== DFU_STATE.STORING && info.state !== DFU_STATE.CLEANING) {
      return info;
    }
    onPhase?.(info.state === DFU_STATE.CLEANING ? 'erasing-slot' : 'storing');
    await unthrottledSleep(delay);
    delay = Math.min(delay * 2, STORING_MAX_DELAY_MS);
  }
}

// Pure JS helper to find the right .bin in a dfu_application.zip given the
// device's current flash_area_id. We pick the slot opposite the running one.
// Tolerates manifest format-version 0 and 1.
//
// Slot-0 and slot-1 binaries have different naming conventions even within the
// same NCS toolchain — slot 0 commonly ships as `signed_by_b0_<app>_<board>.bin`
// while slot 1 is the canonical `signed_by_b0_s1_image.bin`. Always trust the
// manifest's `file` field instead of pattern-matching the filename.
//
// Returns { imageBytes, slotBinName, manifestJson, targetSlot }
export async function parseDfuZip(file, currentFlashAreaId) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(file);
  const targetSlot = 1 - currentFlashAreaId;

  if (!zip.files['manifest.json']) {
    throw new Error('zip is missing manifest.json; not a valid dfu_application.zip');
  }
  let manifestJson;
  try {
    const txt = await zip.files['manifest.json'].async('string');
    manifestJson = JSON.parse(txt);
  } catch (e) {
    throw new Error(`manifest.json is malformed: ${e.message}`);
  }

  const fileList = manifestJson.files || [];
  // Match the slot field; manifest stores it as a string in format-version 1,
  // possibly as an int in format-version 0. Compare numerically to be safe.
  //
  // Single-bank targets (CH32V305) ship a one-file manifest with no `slot`
  // field; fall back to that single entry when slot matching would be
  // ambiguous. This keeps the dual-bank (mouse, dongle) path unchanged.
  let slotEntry = fileList.find((f) => Number(f.slot) === targetSlot);
  if (!slotEntry && fileList.length === 1 && fileList[0].slot === undefined) {
    slotEntry = fileList[0];
  }
  if (!slotEntry || !slotEntry.file) {
    const available = fileList.map((f) => `${f.file}(slot=${f.slot})`).join(', ');
    throw new Error(`manifest has no entry for slot ${targetSlot}. Found: ${available || '(none)'}`);
  }

  const entry = zip.files[slotEntry.file];
  if (!entry) {
    throw new Error(`zip references ${slotEntry.file} in manifest but the file is missing`);
  }
  const imageBytes = new Uint8Array(await entry.async('arraybuffer'));

  // Optional sidecar VERSION file (injected by scripts/build.ps1) carries SemVer
  // matching what fwinfo reports for the installed image. Falls back to null —
  // older zips built before the injection step have no VERSION entry.
  let semver = null;
  if (zip.files['VERSION']) {
    const versionText = await zip.files['VERSION'].async('string');
    const pick = (k) => versionText.match(new RegExp(`^${k}\\s*=\\s*(\\S+)`, 'm'))?.[1];
    const major = pick('VERSION_MAJOR');
    const minor = pick('VERSION_MINOR');
    const patch = pick('PATCHLEVEL');
    if (major != null && minor != null && patch != null) {
      semver = `${major}.${minor}.${patch}`;
    }
  }

  return { imageBytes, slotBinName: slotEntry.file, manifestJson, targetSlot, semver };
}

// Main DFU state machine — port of dfu.py::dfu_transfer.
// callbacks: { onProgress(bytesSent, total), onPhase(phaseName), signal: AbortSignal }
// dfuMod must include `recipient` (RECIPIENT_MOUSE or RECIPIENT_DONGLE_LOCAL)
// alongside `id` and `options`; findDfuModule(target) returns this shape.
export async function dfuTransfer(svc, dfuMod, imageBytes, { onProgress, onPhase, signal } = {}) {
  const modId = dfuMod.id;
  const recipient = dfuMod.recipient ?? RECIPIENT_MOUSE;
  const optStart  = dfuMod.options.start  ?? 1;
  const optData   = dfuMod.options.data   ?? 2;
  const optSync   = dfuMod.options.sync   ?? 3;
  const optReboot = dfuMod.options.reboot ?? 4;
  const chunkMax  = chunkMaxForRecipient(recipient);

  const total = imageBytes.byteLength;
  if (total === 0) return { ok: false, error: 'empty image' };

  onPhase?.('computing-csum');
  const csum = crc32Init1(imageBytes);

  onPhase?.('syncing');
  let info = await waitUntilNotBusy(svc, modId, optSync, recipient, { signal, onPhase });
  if (!info) return { ok: false, error: signal?.aborted ? 'aborted' : 'initial sync failed' };

  let offset = 0;
  if (info.state === DFU_STATE.ACTIVE_CONFIG_CHANNEL &&
      info.imgLength === total &&
      info.imgCsum === csum &&
      info.offset <= total) {
    offset = info.offset;
    onPhase?.(`resuming-at-${offset}`);
  } else if (info.state !== DFU_STATE.INACTIVE) {
    return { ok: false, error: `device busy or wrong image (state=${info.state})` };
  }

  // If the destination slot still holds data (e.g. a previous interrupted DFU),
  // the firmware's first `start` only KICKS OFF a background erase and returns
  // to INACTIVE without activating -- the host must re-issue `start` once the
  // slot is clean. Loop until the device reports ACTIVE at our offset. Bounded
  // so a device that never activates fails instead of spinning.
  const MAX_START_ATTEMPTS = 4;
  let activated = false;
  for (let attempt = 0; attempt < MAX_START_ATTEMPTS && !activated; attempt++) {
    if (!(await startSet(svc, modId, optStart, total, csum, offset, recipient))) {
      return { ok: false, error: 'start rejected' };
    }
    // After start, the device may run a CLEANING pass for the destination slot.
    info = await waitUntilNotBusy(svc, modId, optSync, recipient, { signal, onPhase });
    if (!info) return { ok: false, error: signal?.aborted ? 'aborted' : 'sync after start failed' };
    if (info.state === DFU_STATE.ACTIVE_CONFIG_CHANNEL && info.offset === offset) {
      activated = true;
    } else if (info.state === DFU_STATE.INACTIVE) {
      // Erase finished but DFU is not yet active -- re-issue start.
      continue;
    } else {
      return { ok: false, error: `start did not activate (state=${info.state} offset=${info.offset})` };
    }
  }
  if (!activated) {
    return { ok: false, error: 'start did not activate after slot erase' };
  }

  const syncBufferSize = Math.max(info.syncBufferSize || 512, 64);

  onPhase?.('transferring');
  onProgress?.(offset, total);

  let nextCheckpoint = offset + syncBufferSize;
  // Faster polling during the data pump keeps the wall-clock down. The default
  // 20 ms × 200 retries = 4 s budget is fine; the bottleneck is the round-trip
  // count, not individual poll latency.
  const chunkOpts = { pollIntervalMs: 5, verbose: false };

  // A data SET whose confirmation is lost on the dongle's SPI bridge (#107)
  // must NOT be resent: the firmware appends every chunk it receives to its RAM
  // sync buffer, so resending would double the bytes. Instead we flush+resync
  // to the device's authoritative cur_offset and continue. Syncing on the FIRST
  // unconfirmed chunk keeps that chunk last-in-buffer, so the flush is never a
  // shifted/corrupt window -- only ever short and cleanly resumable. Bounded so
  // a genuinely wedged link still fails instead of spinning forever.
  const MAX_RESYNCS = 40;
  let resyncs = 0;

  while (offset < total) {
    if (signal?.aborted) return { ok: false, error: 'aborted' };

    const chunkStart = offset;
    const chunkEnd = Math.min(offset + chunkMax, total, nextCheckpoint);
    const chunk = imageBytes.subarray(chunkStart, chunkEnd);

    if (!(await sendDataChunk(svc, modId, optData, chunk, recipient, chunkOpts))) {
      // Unconfirmed, not rejected. Flush + resync to device truth.
      if (++resyncs > MAX_RESYNCS) {
        return { ok: false, error: `too many unconfirmed chunks near offset ${chunkStart}` };
      }
      const rs = await waitUntilNotBusy(svc, modId, optSync, recipient, { signal, onPhase });
      if (!rs) return { ok: false, error: signal?.aborted ? 'aborted' : 'resync failed' };
      if (rs.offset < chunkStart || rs.offset > chunkEnd) {
        // Device offset outside [chunkStart, chunkEnd] means the sync response
        // itself is untrustworthy or the device state diverged -- bail rather
        // than write from a bad cursor.
        return { ok: false, error: `resync offset out of range: device=${rs.offset}, window=[${chunkStart},${chunkEnd}]` };
      }
      // rs.offset === chunkEnd: chunk landed, ack was lost -> skip ahead.
      // rs.offset === chunkStart: chunk didn't land -> resume, safely resend.
      offset = rs.offset;
      onProgress?.(offset, total);
      nextCheckpoint = offset + (rs.syncBufferSize || syncBufferSize);
      continue;
    }
    resyncs = 0;
    offset = chunkEnd;
    onProgress?.(offset, total);

    if (offset >= nextCheckpoint || offset >= total) {
      const cp = await waitUntilNotBusy(svc, modId, optSync, recipient, { signal, onPhase });
      if (!cp) return { ok: false, error: signal?.aborted ? 'aborted' : 'checkpoint sync failed' };
      if (cp.offset !== offset) {
        // Device flushed a different amount than we sent -- a real byte loss in
        // this window (not just a lost ack). Resync to device truth and retry
        // the shortfall rather than aborting outright.
        if (++resyncs > MAX_RESYNCS) {
          return { ok: false, error: `checkpoint offset mismatch: device=${cp.offset}, host=${offset}` };
        }
        offset = cp.offset;
        onProgress?.(offset, total);
      }
      nextCheckpoint = offset + (cp.syncBufferSize || syncBufferSize);
    }
  }

  onPhase?.('finalising');
  // One more wait to absorb any tail STORING work before reboot.
  const finalInfo = await waitUntilNotBusy(svc, modId, optSync, recipient, { signal, onPhase });
  if (!finalInfo) {
    return { ok: false, error: signal?.aborted ? 'aborted' : 'final sync failed' };
  }

  onPhase?.('rebooting');
  await rebootRequest(svc, modId, optReboot, recipient);

  return { ok: true };
}
