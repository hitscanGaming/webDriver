/*
 * Profile import/export helpers. Reads/writes a JSON snapshot of every
 * runtime-tunable option exposed by PR1..PR4 (motion_sync, debounce,
 * auto-sleep, keymap, polling rate). Profile slot is host-side only for
 * now (firmware active_slot is informational; per-module slot rotation
 * is deferred).
 */
import { WebHIDService } from './WebHIDService.js';

const PROFILE_SCHEMA_VERSION = 1;

// Each entry: [moduleName, optionName, kind] where kind is the cast applied
// to the fetched numeric value. JSON values are always numbers/booleans;
// the firmware sees uint8 / uint32 little-endian via setConfig.
const OPTIONS = [
  ['motion', 'motion_sync', 'bool'],
  ['motion', 'rest2', 'uint32'],
  ['motion', 'cpi', 'uint32'],
  ['motion', 'cpi_stage_1', 'uint32'],
  ['motion', 'cpi_stage_2', 'uint32'],
  ['motion', 'cpi_stage_3', 'uint32'],
  ['motion', 'cpi_stage_4', 'uint32'],
  ['motion', 'cpi_stage_active', 'uint32'],
  ['motion', 'lod', 'uint32'],
  ['motion', 'ripple_control', 'bool'],
  ['motion', 'angle_snap', 'bool'],
  ['polling', 'poll_esb', 'uint32'],
  ['polling', 'poll_usb', 'uint32'],
  // Auto Sleep (PR3) lives on power_cfg, not motion — motion/sleep_enable was
  // removed from the firmware when Sleep Time moved here.
  ['power_cfg', 'sleep_time', 'uint32'],
  ['buttons_cfg', 'debounce_ms', 'uint8'],
  ['buttons_cfg', 'keymap_btn_1', 'uint8'],
  ['buttons_cfg', 'keymap_btn_2', 'uint8'],
  ['buttons_cfg', 'keymap_btn_3', 'uint8'],
  ['buttons_cfg', 'keymap_btn_4', 'uint8'],
  ['buttons_cfg', 'keymap_btn_5', 'uint8'],
  ['buttons_cfg', 'keymap_btn_6', 'uint8'],
];

const castOut = (kind, raw) => {
  if (raw === null || raw === undefined) return null;
  if (kind === 'bool') return raw === 1;
  return raw;
};

const castIn = (kind, value) => {
  if (kind === 'bool') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  return 0;
};

export async function exportProfile() {
  const data = {};
  const failures = [];
  for (const [mod, opt, kind] of OPTIONS) {
    try {
      const v = await WebHIDService.getConfig(mod, opt);
      data[`${mod}/${opt}`] = castOut(kind, v);
    } catch (e) {
      failures.push(`${mod}/${opt}: ${e.message}`);
      data[`${mod}/${opt}`] = null;
    }
  }
  return {
    blob: {
      schema: PROFILE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      options: data,
    },
    failures,
  };
}

export async function importProfile(parsed) {
  if (!parsed || parsed.schema !== PROFILE_SCHEMA_VERSION) {
    throw new Error(`Unsupported profile schema (expected ${PROFILE_SCHEMA_VERSION})`);
  }
  if (!parsed.options || typeof parsed.options !== 'object') {
    throw new Error('Profile JSON missing "options" object');
  }
  const failures = [];
  const applied = [];
  for (const [mod, opt, kind] of OPTIONS) {
    const key = `${mod}/${opt}`;
    if (!(key in parsed.options)) continue;
    const raw = parsed.options[key];
    if (raw === null || raw === undefined) continue;
    try {
      const wireValue = castIn(kind, raw);
      const ok = await WebHIDService.setConfig(mod, opt, wireValue);
      if (ok) {
        applied.push(key);
      } else {
        failures.push(`${key}: setConfig returned false`);
      }
    } catch (e) {
      failures.push(`${key}: ${e.message}`);
    }
  }
  return { applied, failures };
}

export function profileToBlob(profileObj) {
  const json = JSON.stringify(profileObj, null, 2);
  return new Blob([json], { type: 'application/json' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept = '.json,application/json') {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) reject(new Error('No file selected'));
      else resolve(file);
    };
    input.click();
  });
}

export async function readFileAsJson(file) {
  const text = await file.text();
  return JSON.parse(text);
}
