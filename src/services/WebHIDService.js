// WebHID Service (Nordic HID Protocol Implementation)

const REPORT_ID = 6;
// Matches firmware/mouse/configuration/common/hid_report_user_config.h. The
// "common" header is shared by mouse and dongle builds, so both targets and
// the CH32V305 SPI bridge are all framed at 29 bytes end-to-end.
const REPORT_USER_CONFIG_SIZE = 29;
const REPORT_SIZE = 1 + REPORT_USER_CONFIG_SIZE;
export const VENDOR_ID = 0x1915;

const OPT_MODULE_DESCR = 0;
const END_OF_TRANSFER_CHAR = '\n';
const OPT_NAME_MODULE_VARIANT = 'module_variant';
const POLL_INTERVAL_DEFAULT_MS = 20;
const POLL_RETRY_DEFAULT = 200;

// event_id = (module_id << 4) | option_id; both 4-bit. Wire option id is 1-indexed
// because 0 == MODULE_DESCR (discovery cursor). See memory project-config-channel-encoding.
export function buildEventId(modId, optId) {
  return ((modId & 0x0f) << 4) | (optId & 0x0f);
}

export const ConfigStatus = {
  PENDING: 0,
  GET_MAX_MOD_ID: 1,
  GET_HWID: 2,
  GET_BOARD_NAME: 3,
  INDEX_PEERS: 4,
  GET_PEER: 5,
  SET: 6,
  FETCH: 7,
  SUCCESS: 8,
  TIMEOUT: 9,
  REJECT: 10,
  WRITE_FAIL: 11,
  DISCONNECTED: 12,
  GET_PEERS_CACHE: 13,
  FAULT: 99,
};

// HARDCODED_CONFIG mirrors the mouse's `config_channel_modules` linker
// section. Since issue #89, module IDs are deterministic: each module's
// marker lives in a named subsection (config_channel_modules.<mod_name>)
// and nrf_desktop.ld SORTs them, so IDs are ALPHABETICAL BY MODULE NAME
// (battery_meas < dfu < motion) on every build config — LTO and CMake
// order no longer matter. Regenerate via `.\scripts\hid_dump_ids.ps1
// -Format js` after adding/removing a config-channel module.
// ble_bond is not compiled on either target (DESKTOP_BT=n), so it's not
// listed. After discovery the dfu key becomes "dfu/B0" via the bootloader
// variant suffix; findDfuModule resolves it.
//
// Wire option IDs are 1-indexed (firmware opt_id = wire - 1); 0 is reserved
// for MODULE_DESCR (discovery cursor).
const HARDCODED_CONFIG = {
  battery_meas: {
    id: 0,
    options: { bat_level: 1 },
  },
  dfu: {
    id: 1,
    options: {
      start: 1,
      data: 2,
      sync: 3,
      reboot: 4,
      fwinfo: 5,
      module_variant: 6,
      devinfo: 7,
    },
  },
  'motion/paw3395': {
    id: 2,
    options: {
      module_variant: 1,
      cpi: 2,
      downshift: 3,
      rest1: 4,
      rest2: 5,
      cpi_stage_1: 6,
      cpi_stage_2: 7,
      cpi_stage_3: 8,
      cpi_stage_4: 9,
      cpi_stage_active: 10,
      poll_esb: 11,
      poll_usb: 12,
      ripple_control: 13,
      angle_snap: 14,
      lod: 15,
    },
  },
};

const STATUS_TO_MESSAGE = {
  [ConfigStatus.PENDING]: 'pending',
  [ConfigStatus.SUCCESS]: 'ok',
  [ConfigStatus.TIMEOUT]: 'device did not respond in time',
  [ConfigStatus.REJECT]: 'device rejected the request',
  [ConfigStatus.WRITE_FAIL]: 'device write failed',
  [ConfigStatus.DISCONNECTED]: 'device disconnected',
  [ConfigStatus.FAULT]: 'protocol fault',
};

export const WebHIDService = {
  device: null,
  configMap: HARDCODED_CONFIG,
  isConnecting: false,
  // Shared in-flight promise for checkConnection(). React 18 StrictMode
  // double-mounts useEffect in dev, calling syncFromAttachedDevice twice in
  // quick succession; without this, both invocations sail past the
  // "already opened" early-return (this.device is still null), both call
  // pairedDevice.open() (one fails with "operation in progress"), and both
  // call _discoverAndAssignConfig() -- two parallel walkers fight over the
  // firmware's single MODULE_DESCR cursor and discovery bails.
  _checkConnectionInFlight: null,
  lastStatus: ConfigStatus.SUCCESS,
  // Serialization mutex. WebHID's receiveFeatureReport returns whatever response
  // is in the device's shared feature-report buffer — if two callers issue
  // exchangeFeatureReport concurrently, the second's response can land while
  // the first is still polling, causing the first to see a Mismatch and the
  // second to time out. _enqueue funnels every exchange so each one fully
  // completes (send + poll-until-non-PENDING + return) before the next starts.
  // See memory: project-webhid-concurrent-exchange-race.
  _pending: Promise.resolve(),

  _enqueue(fn) {
    const run = () => fn();
    const next = this._pending.then(run, run);
    this._pending = next.catch(() => {});
    return next;
  },

  statusToMessage(code) {
    return STATUS_TO_MESSAGE[code] || `status ${code}`;
  },

  cleanString(str) {
    return str.replace(/\0/g, '').replace(/[^\x20-\x7E]/g, '').trim();
  },

  toHexString(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  },

  async connect() {
    if (!navigator.hid) throw new Error('WebHID not supported in this browser.');

    const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR_ID }] });
    if (devices.length === 0) throw new Error('No device selected');

    this.device = devices[0];
    if (!this.device.opened) await this.device.open();

    console.log(`[HID] Connected to ${this.device.productName} (PID: 0x${this.device.productId.toString(16)})`);

    const isDongle = (this.device.productId & 0xf000) === 0xf000;
    console.log(`[HID] Device Type: ${isDongle ? 'Wireless Dongle' : 'Wired Mouse'}`);

    // Discovery walks MODULE_DESCR to learn current mouse-side module IDs.
    // Run on dongle handles too: requests forwarded over ESB target the
    // mouse's link order, which is what discovery enumerates. Skipping on
    // dongle left HARDCODED IDs addressing wrong modules after DFU enabled.
    await this._discoverAndAssignConfig();

    return { device: this.device, isDongle };
  },

  _discoverAndAssignConfig() {
    // Runtime discovery costs ~3 s on the wireless path (~30 FETCH MODULE_DESCR
    // round-trips, each ~100 ms gated by the mouse's 100 ms ESB keepalive
    // window that carries the reverse-config piggyback). HARDCODED_CONFIG is
    // accurate today; when firmware link order changes, regenerate it via
    // `scripts/hid_dump_ids.ps1` (wired-mouse only -- the CH32V305 bridge
    // doesn't honor HidD_GetFeature yet) which prints a paste-ready block.
    // The discoverDeviceConfig() helpers below remain in place for diagnostic
    // use and a future caching layer keyed by HWID + firmware version.
    this.configMap = HARDCODED_CONFIG;
  },

  async checkConnection() {
    if (this._checkConnectionInFlight) {
      return this._checkConnectionInFlight;
    }
    this._checkConnectionInFlight = this._checkConnection().finally(() => {
      this._checkConnectionInFlight = null;
    });
    return this._checkConnectionInFlight;
  },

  async _checkConnection() {
    if (!navigator.hid) return null;
    if (this.device && this.device.opened) {
      return {
        device: this.device,
        isDongle: (this.device.productId & 0xf000) === 0xf000,
      };
    }

    const devices = await navigator.hid.getDevices();
    const pairedDevice = devices.find((d) => d.vendorId === VENDOR_ID);

    if (pairedDevice) {
      try {
        if (!pairedDevice.opened) await pairedDevice.open();
        this.device = pairedDevice;
        console.log(`[HID] Reconnected to ${pairedDevice.productName} (PID: 0x${pairedDevice.productId.toString(16)})`);
        const isDongle = (pairedDevice.productId & 0xf000) === 0xf000;
        await this._discoverAndAssignConfig();
        return { device: this.device, isDongle };
      } catch (e) {
        console.warn(`[HID] Failed to open paired device: ${e.message}`);
      }
    }
    return null;
  },

  async disconnect() {
    if (this.device && this.device.opened) await this.device.close();
    this.device = null;
  },

  exchangeFeatureReport(recipient, eventId, status, data = null, opts = {}) {
    return this._enqueue(async () => {
      if (!this.device || !this.device.opened) throw new Error('Device not connected');

      const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_DEFAULT_MS;
      const maxRetries = opts.maxRetries ?? POLL_RETRY_DEFAULT;
      const verbose = opts.verbose ?? true;
      // Caller (DFUService) passes a worker-driven sleeper so long-running
      // transfers survive background-tab throttling. Default = setTimeout
      // for the common config-channel path that always runs foregrounded.
      const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

      const buffer = new Uint8Array(REPORT_USER_CONFIG_SIZE);
      buffer[0] = recipient;
      buffer[1] = eventId;
      buffer[2] = status;
      buffer[3] = data ? data.byteLength : 0;

      if (data) {
        if (data.byteLength > REPORT_USER_CONFIG_SIZE - 4) throw new Error('Data too long for HID report');
        buffer.set(new Uint8Array(data), 4);
      }

      if (verbose) {
        console.log(`[HID] Sending: ID=${REPORT_ID} event=${eventId} Payload=${this.toHexString(buffer)}`);
      }

      try {
        await this.device.sendFeatureReport(REPORT_ID, buffer);
      } catch (e) {
        console.error('[HID] Send Error:', e);
        this.lastStatus = ConfigStatus.DISCONNECTED;
        throw e;
      }

      for (let i = 0; i < maxRetries; i++) {
        await sleep(pollIntervalMs);

        try {
          const view = await this.device.receiveFeatureReport(REPORT_ID);

          if (verbose && view && view.buffer) {
            console.log(`[HID] RAW DATA: ${this.toHexString(view.buffer)}`);
          }

          if (!view || !(view instanceof DataView)) continue;

          let offset = 0;
          if (view.byteLength === REPORT_SIZE && view.getUint8(0) === REPORT_ID) {
            offset = 1;
          }

          if (view.byteLength < 4 + offset) continue;

          const r_rcpt = view.getUint8(0 + offset);
          const r_evt = view.getUint8(1 + offset);
          const r_stat = view.getUint8(2 + offset);
          const r_len = view.getUint8(3 + offset);

          // Treat status==request_status (CH32V305 echoes the request on its
          // USER_CONFIG_TX slot until the dongle pushes the actual response)
          // identically to PENDING — keep polling until SUCCESS / failure.
          const isEcho = r_stat === status;

          if (verbose && ((r_stat !== ConfigStatus.PENDING && !isEcho) || i % 20 === 0)) {
            console.log(`[HID] Poll ${i}: Rcpt=${r_rcpt}, Evt=${r_evt}, Stat=${r_stat} (Offset=${offset})`);
          }

          if (r_stat === ConfigStatus.PENDING || isEcho) continue;

          if (r_rcpt === recipient && r_evt === eventId) {
            this.lastStatus = r_stat;
            if (r_stat === ConfigStatus.SUCCESS) {
              return new Uint8Array(view.buffer, view.byteOffset + 4 + offset, r_len);
            }
            console.warn(`[HID] Protocol error: ${this.statusToMessage(r_stat)} (code ${r_stat})`);
            return null;
          } else {
            console.warn(`[HID] Mismatch: Expected ${recipient}/${eventId}, Got ${r_rcpt}/${r_evt}`);
          }
        } catch (e) {
          // Ignore read errors during polling
        }
      }
      console.warn('[HID] Timeout waiting for response');
      this.lastStatus = ConfigStatus.TIMEOUT;
      return null;
    });
  },

  async getBoardName() {
    const result = await this.exchangeFeatureReport(0, 0, ConfigStatus.GET_BOARD_NAME);
    if (result) {
      const textDecoder = new TextDecoder('utf-8');
      return this.cleanString(textDecoder.decode(result));
    }
    return null;
  },

  async getHWID() {
    const result = await this.exchangeFeatureReport(0, 0, ConfigStatus.GET_HWID);
    if (result) return this.toHexString(result);
    return null;
  },

  async getConfig(moduleName, optionName) {
    const availableModules = Object.keys(this.configMap);
    const mod = availableModules.find((k) => k.includes(moduleName));
    if (!mod) {
      this.lastStatus = ConfigStatus.FAULT;
      console.warn(`[HID] getConfig: module ${moduleName} not in HARDCODED_CONFIG`);
      return null;
    }

    const modInfo = this.configMap[mod];
    const optId = modInfo.options[optionName];
    if (optId === undefined) {
      this.lastStatus = ConfigStatus.FAULT;
      console.warn(`[HID] getConfig: option ${optionName} not in module ${mod}`);
      return null;
    }

    const eventId = (modInfo.id << 4) | optId;
    const result = await this.exchangeFeatureReport(0, eventId, ConfigStatus.FETCH);

    if (result) {
      const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
      if (result.byteLength === 4) return view.getUint32(0, true);
      if (result.byteLength === 1) return view.getUint8(0);
      if (result.byteLength === 2) return view.getUint16(0, true);
      this.lastStatus = ConfigStatus.FAULT;
      console.warn(`[HID] getConfig: unsupported payload length ${result.byteLength}`);
    }
    return null;
  },

  async setConfig(moduleName, optionName, value) {
    const availableModules = Object.keys(this.configMap);
    const mod = availableModules.find((k) => k.includes(moduleName));
    if (!mod) {
      this.lastStatus = ConfigStatus.FAULT;
      throw new Error(`Module ${moduleName} not found`);
    }

    const modInfo = this.configMap[mod];
    const optId = modInfo.options[optionName];
    if (optId === undefined) {
      this.lastStatus = ConfigStatus.FAULT;
      throw new Error(`Option ${optionName} not found`);
    }

    const eventId = (modInfo.id << 4) | optId;
    const data = new ArrayBuffer(4);
    new DataView(data).setUint32(0, value, true);

    const resp = await this.exchangeFeatureReport(0, eventId, ConfigStatus.SET, data);
    return !!resp;
  },

  async readMaxModId() {
    const result = await this.exchangeFeatureReport(0, 0, ConfigStatus.GET_MAX_MOD_ID, null, { verbose: false });
    if (!result || result.byteLength < 1) return null;
    return result[0];
  },

  async _fetchOptionDescr(modId) {
    const eventId = buildEventId(modId, OPT_MODULE_DESCR);
    const result = await this.exchangeFeatureReport(0, eventId, ConfigStatus.FETCH, null, { verbose: false });
    if (!result) return null;
    return new TextDecoder('utf-8', { fatal: false }).decode(result).replace(/\0/g, '');
  },

  // Walk the rotating MODULE_DESCR cursor for one module. Returns
  // { id, name, options: { name: id } } or null on failure.
  // Mirrors NrfHidDevice._discover_module_config (NCS hid_configurator).
  async discoverModule(modId) {
    const fetched = [];
    let endIdx = -1;
    // Hard cap = 16 options + module name + EoT sentinel; one extra round trip for safety.
    for (let i = 0; i < 18; i++) {
      const opt = await this._fetchOptionDescr(modId);
      if (opt == null) return null;
      if (fetched.includes(opt)) break;
      if (opt[0] === END_OF_TRANSFER_CHAR) endIdx = fetched.length;
      fetched.push(opt);
    }
    if (endIdx < 0) return null;
    // Rotate so EoT comes first, drop it.
    const rotated = fetched.slice(endIdx).concat(fetched.slice(0, endIdx)).slice(1);
    if (rotated.length < 1) return null;
    const name = rotated[0];
    const options = {};
    rotated.slice(1).forEach((n, i) => { options[n] = i + 1; });

    let finalName = name;
    if (OPT_NAME_MODULE_VARIANT in options) {
      const variantEventId = buildEventId(modId, options[OPT_NAME_MODULE_VARIANT]);
      const variantResult = await this.exchangeFeatureReport(0, variantEventId, ConfigStatus.FETCH, null, { verbose: false });
      if (variantResult) {
        const variant = new TextDecoder('utf-8', { fatal: false }).decode(variantResult).replace(/\0/g, '');
        finalName = `${name}/${variant}`;
      }
    }
    return { id: modId, name: finalName, options };
  },

  async discoverDeviceConfig() {
    const maxId = await this.readMaxModId();
    if (maxId == null) return null;
    const config = {};
    for (let i = 0; i <= maxId; i++) {
      const mod = await this.discoverModule(i);
      if (mod == null) {
        console.warn(`[HID] discoverModule(${i}) failed`);
        return null;
      }
      config[mod.name] = { id: mod.id, options: mod.options };
    }
    return config;
  },

  // Find the dfu module in configMap, tolerating the variant suffix
  // ("dfu/B0", "dfu/MCUBOOT", ...). Returns { name, id, options } or null —
  // shape matches what DFUService callers (fwinfo, dfuTransfer) expect.
  findDfuModule() {
    const key = Object.keys(this.configMap).find((k) => k === 'dfu' || k.startsWith('dfu/'));
    if (!key) return null;
    const mod = this.configMap[key];
    return { name: key, id: mod.id, options: mod.options };
  },

  startPairing() {
    return this._enqueue(async () => {
      if (!this.device || !this.device.opened) throw new Error('Device not connected');
      const buffer = new Uint8Array(REPORT_USER_CONFIG_SIZE);
      buffer[0] = 1;
      buffer[1] = 0;
      buffer[2] = ConfigStatus.SET;
      buffer[3] = 0;

      console.log(`[HID] Sending Pairing Request: ID=${REPORT_ID}`);
      try {
        await this.device.sendFeatureReport(REPORT_ID, buffer);
        console.log('[HID] Pairing Request Sent');
        return true;
      } catch (e) {
        console.error('[HID] Pairing Request Error:', e);
        throw e;
      }
    });
  },
};

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.WebHIDService = WebHIDService;
  window.ConfigStatus = ConfigStatus;
}
