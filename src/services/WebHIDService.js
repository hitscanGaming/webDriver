// WebHID Service (Nordic HID Protocol Implementation)

const REPORT_ID = 6;
const REPORT_USER_CONFIG_SIZE = 13;
const REPORT_SIZE = 1 + REPORT_USER_CONFIG_SIZE;
export const VENDOR_ID = 0x1915;

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

const HARDCODED_CONFIG = {
  battery_meas: {
    id: 0,
    options: { bat_level: 1 },
  },
  'motion/paw3395': {
    id: 1,
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
  ble_bond: {
    id: 2,
    options: { peer_erase: 1, peer_search: 2 },
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
  lastStatus: ConfigStatus.SUCCESS,

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

    return { device: this.device, isDongle };
  },

  async checkConnection() {
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

  async exchangeFeatureReport(recipient, eventId, status, data = null) {
    if (!this.device || !this.device.opened) throw new Error('Device not connected');

    const buffer = new Uint8Array(REPORT_USER_CONFIG_SIZE);
    buffer[0] = recipient;
    buffer[1] = eventId;
    buffer[2] = status;
    buffer[3] = data ? data.byteLength : 0;

    if (data) {
      if (data.byteLength > 25) throw new Error('Data too long for HID report');
      buffer.set(new Uint8Array(data), 4);
    }

    console.log(`[HID] Sending: ID=${REPORT_ID} event=${eventId} Payload=${this.toHexString(buffer)}`);

    try {
      await this.device.sendFeatureReport(REPORT_ID, buffer);
    } catch (e) {
      console.error('[HID] Send Error:', e);
      this.lastStatus = ConfigStatus.DISCONNECTED;
      throw e;
    }

    const MAX_RETRIES = 200;
    for (let i = 0; i < MAX_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, 20));

      try {
        const view = await this.device.receiveFeatureReport(REPORT_ID);

        if (view && view.buffer) {
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

        if (r_stat !== ConfigStatus.PENDING || i % 20 === 0) {
          console.log(`[HID] Poll ${i}: Rcpt=${r_rcpt}, Evt=${r_evt}, Stat=${r_stat} (Offset=${offset})`);
        }

        if (r_stat === ConfigStatus.PENDING) continue;

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

  async startPairing() {
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
  },
};

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.WebHIDService = WebHIDService;
  window.ConfigStatus = ConfigStatus;
}
