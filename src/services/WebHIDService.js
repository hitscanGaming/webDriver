// WebHID Service (Nordic HID Protocol Implementation)

const REPORT_ID = 6;
// Matches firmware/mouse/configuration/common/hid_report_user_config.h. The
// "common" header is shared by mouse and dongle builds, so both targets and
// the CH32V305 SPI bridge are all framed at 29 bytes end-to-end.
const REPORT_USER_CONFIG_SIZE = 29;
const REPORT_SIZE = 1 + REPORT_USER_CONFIG_SIZE;
export const VENDOR_ID = 0x1915;

// SPI recipient byte values, mirrored from firmware/mouse/src/modules/spi_protocol.h.
// 0x00: route over ESB to the mouse (existing mouse-DFU and live-config path).
// 0x01: dongle's pairing trigger (see startPairing() below).
// 0x02: dispatch as a local cfg_event on the dongle (dongle-DFU path).
export const RECIPIENT_MOUSE = 0;
export const RECIPIENT_PAIRING = 1;
export const RECIPIENT_DONGLE_LOCAL = 2;

const OPT_MODULE_DESCR = 0;
const END_OF_TRANSFER_CHAR = '\n';
const OPT_NAME_MODULE_VARIANT = 'module_variant';
// A HID transfer issued against a handle whose USB device has gone away never
// settles -- Chrome neither resolves nor rejects it. One such call wedges the
// serialized exchange queue for the lifetime of the page, which is why a wired
// factory reset could only be recovered by reloading. Bound every transfer.
const HID_OP_TIMEOUT_MS = 1500;

const withHidTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

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
// (battery_meas < buttons_cfg < dfu < motion < polling < power_cfg) on every build
// config — LTO and CMake order no longer matter. Regenerate via `.\scripts\hid_dump_ids.ps1
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
  buttons_cfg: {
    id: 1,
    options: {
      module_variant: 1,
      debounce_ms: 2,
      keymap_btn_1: 3,
      keymap_btn_2: 4,
      keymap_btn_3: 5,
      keymap_btn_4: 6,
      keymap_btn_5: 7,
      keymap_btn_6: 8,
    },
  },
  dfu: {
    id: 2,
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
    id: 3,
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
      ripple_control: 11,
      angle_snap: 12,
      lod: 13,
      motion_sync: 14,
    },
  },
  polling: {
    id: 4,
    options: {
      module_variant: 1,
      poll_esb: 2,
      poll_usb: 3,
    },
  },
  power_cfg: {
    id: 5,
    options: {
      module_variant: 1,
      sleep_time: 2,
    },
  },
  profile: {
    id: 6,
    options: {
      module_variant: 1,
      active_slot: 2,
      factory_reset_active: 3,
    },
  },
};

// Dongle-local config-channel modules (recipient=0x02), hardcoded for the same
// reason as HARDCODED_CONFIG above: the dongle's `config_channel_modules`
// section is SORTed alphabetically by ld, so IDs are deterministic
// (dfu < profile => dfu=0, profile=1). Runtime rotating-MODULE_DESCR discovery
// over the CH32V305 SPI bridge races on the bridge's response staging and
// scrambles the reconstructed names (see issue #107), so we skip it: the DFU
// flow only needs the module id, and every option id here matches the firmware
// wire order (dfu.c opt_descr[]) — the same values DFUService/FirmwareView
// already use as `?? N` fallbacks. Regenerate via `.\scripts\hid_dump_ids.ps1`
// if a config-channel module is added to the dongle build (a module sorting
// before "dfu" would shift dfu off id 0).
const HARDCODED_DONGLE_CONFIG = {
  dfu: {
    id: 0,
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
  profile: {
    id: 1,
    options: {
      factory_reset_active: 1,
      active_slot: 2,
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
  // configMap tracks modules reachable at recipient=0 (mouse over ESB, or
  // a direct-wired mouse). dongleConfigMap is populated lazily by
  // discoverDongleConfig() the first time the user targets the dongle for DFU.
  configMap: HARDCODED_CONFIG,
  dongleConfigMap: null,
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

  // USB re-enumerates before the firmware's config channel starts answering,
  // so a sync fired straight off the HID connect event gets no response on any
  // option -- each one burns its full poll timeout and resolves null, and the
  // caller then keeps its previous values. Probe with a cheap FETCH
  // (battery_meas/bat_level, event id 1) using a short per-attempt timeout
  // until the device replies.
  // Drop the current handle without awaiting close(): on a device that has
  // gone away, close() can hang exactly like a transfer. The next
  // checkConnection() re-acquires from navigator.hid.getDevices().
  forgetDevice() {
    const stale = this.device;
    this.device = null;
    if (stale && stale.opened) {
      stale.close().catch(() => {});
    }
  },

  async waitUntilResponsive(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.device && this.device.opened) {
        try {
          const r = await this.exchangeFeatureReport(0, 1, ConfigStatus.FETCH, null, {
            maxRetries: 10,
            verbose: false,
          });
          if (r) return true;
        } catch {
          /* device mid-reboot; keep probing */
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.warn('[HID] waitUntilResponsive: device did not answer in time.');
    return false;
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
    const ours = devices.filter((d) => d.vendorId === VENDOR_ID);
    // With both the cable and the dongle attached, the mouse is physically in
    // wired mode -- usb_state suspends the radio -- so the wired handle is the
    // one reflecting live behaviour. Plain find() returned whichever the
    // browser happened to list first, which was usually the dongle.
    const pairedDevice =
      ours.find((d) => (d.productId & 0xf000) !== 0xf000) ?? ours[0];

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
        await withHidTimeout(
          this.device.sendFeatureReport(REPORT_ID, buffer),
          HID_OP_TIMEOUT_MS,
          'sendFeatureReport'
        );
      } catch (e) {
        console.error('[HID] Send Error:', e);
        this.lastStatus = ConfigStatus.DISCONNECTED;
        throw e;
      }

      for (let i = 0; i < maxRetries; i++) {
        await sleep(pollIntervalMs);

        try {
          const view = await withHidTimeout(
            this.device.receiveFeatureReport(REPORT_ID),
            HID_OP_TIMEOUT_MS,
            'receiveFeatureReport'
          );

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
          // A timeout means the device is gone rather than merely slow to
          // answer; retrying burns the whole budget (200 x 1.5 s) against a
          // dead handle. Give up now so the caller can re-acquire.
          if (e && /timed out/.test(e.message)) {
            console.warn(`[HID] ${e.message} -- abandoning exchange.`);
            this.lastStatus = ConfigStatus.DISCONNECTED;
            return null;
          }
          // Ignore transient read errors during polling
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

  async _fetchOptionDescr(modId, recipient = RECIPIENT_MOUSE) {
    const eventId = buildEventId(modId, OPT_MODULE_DESCR);
    const result = await this.exchangeFeatureReport(recipient, eventId, ConfigStatus.FETCH, null, { verbose: false });
    if (!result) return null;
    return new TextDecoder('utf-8', { fatal: false }).decode(result).replace(/\0/g, '');
  },

  // Walk the rotating MODULE_DESCR cursor for one module. Returns
  // { id, name, options: { name: id } } or null on failure.
  // Mirrors NrfHidDevice._discover_module_config (NCS hid_configurator).
  async discoverModule(modId, recipient = RECIPIENT_MOUSE) {
    const fetched = [];
    let endIdx = -1;
    // Hard cap = 16 options + module name + EoT sentinel; one extra round trip for safety.
    for (let i = 0; i < 18; i++) {
      const opt = await this._fetchOptionDescr(modId, recipient);
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
      const variantResult = await this.exchangeFeatureReport(recipient, variantEventId, ConfigStatus.FETCH, null, { verbose: false });
      if (variantResult) {
        const variant = new TextDecoder('utf-8', { fatal: false }).decode(variantResult).replace(/\0/g, '');
        finalName = `${name}/${variant}`;
      }
    }
    return { id: modId, name: finalName, options };
  },

  async discoverDeviceConfig(recipient = RECIPIENT_MOUSE) {
    // readMaxModId hard-codes recipient=0; for dongle discovery we query
    // GET_MAX_MOD_ID directly with the chosen recipient so we hit the
    // dongle's own info module instead of the mouse's.
    const maxResult = await this.exchangeFeatureReport(recipient, 0, ConfigStatus.GET_MAX_MOD_ID, null, { verbose: false });
    if (!maxResult || maxResult.byteLength < 1) return null;
    const maxId = maxResult[0];
    const config = {};
    for (let i = 0; i <= maxId; i++) {
      const mod = await this.discoverModule(i, recipient);
      if (mod == null) {
        console.warn(`[HID] discoverModule(${i}, recipient=${recipient}) failed`);
        return null;
      }
      config[mod.name] = { id: mod.id, options: mod.options };
    }
    return config;
  },

  // Resolve the dongle-local config map. Uses HARDCODED_DONGLE_CONFIG rather
  // than the rotating-MODULE_DESCR discovery: that multi-fetch races on the
  // CH32V305 response staging and scrambles reconstructed module names (#107),
  // and it only ever rediscovers constants (dfu=0) that the DFU flow already
  // knows. We still do ONE reliable GET_MAX_MOD_ID round trip as a liveness
  // check — it confirms the dongle answers on recipient 0x02 (i.e. a DFU-
  // capable build is flashed) before we claim modules are available. Cached
  // after first success. Returns the same shape as configMap, or null if the
  // dongle does not respond.
  async discoverDongleConfig() {
    if (this.dongleConfigMap) return this.dongleConfigMap;
    try {
      const maxResult = await this.exchangeFeatureReport(
        RECIPIENT_DONGLE_LOCAL, 0, ConfigStatus.GET_MAX_MOD_ID, null, { verbose: false });
      if (!maxResult || maxResult.byteLength < 1) {
        console.warn('[HID] Dongle did not respond to GET_MAX_MOD_ID');
        return null;
      }
      const maxId = maxResult[0];
      const expectedMaxId = Object.keys(HARDCODED_DONGLE_CONFIG).length - 1;
      if (maxId !== expectedMaxId) {
        // Non-fatal: the build's module set differs from the hardcoded table.
        // Proceed with the table but flag it — dfu is still id 0 unless a
        // module sorting before "dfu" was added (see #107 note above).
        console.warn(
          `[HID] Dongle max module id=${maxId}, expected ${expectedMaxId}; ` +
          'HARDCODED_DONGLE_CONFIG may be stale — regenerate via hid_dump_ids.');
      }
      this.dongleConfigMap = HARDCODED_DONGLE_CONFIG;
      console.log(`[HID] Dongle modules (hardcoded): ${Object.keys(HARDCODED_DONGLE_CONFIG).join(', ')}`);
      return this.dongleConfigMap;
    } catch (e) {
      console.warn(`[HID] Dongle liveness check error: ${e.message}`);
    }
    return null;
  },

  // Find the dfu module in the right configMap, tolerating the variant
  // suffix ("dfu/B0", "dfu/MCUBOOT"). target = 'mouse' | 'dongle'.
  // For 'dongle' the caller must have already awaited discoverDongleConfig().
  // Returns { name, id, options, recipient } or null.
  findDfuModule(target = 'mouse') {
    const map = target === 'dongle' ? this.dongleConfigMap : this.configMap;
    if (!map) return null;
    const key = Object.keys(map).find((k) => k === 'dfu' || k.startsWith('dfu/'));
    if (!key) return null;
    const mod = map[key];
    return {
      name: key,
      id: mod.id,
      options: mod.options,
      recipient: target === 'dongle' ? RECIPIENT_DONGLE_LOCAL : RECIPIENT_MOUSE,
    };
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
