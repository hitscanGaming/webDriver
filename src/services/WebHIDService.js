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
    FAULT: 99
};

const REPORT_ID = 6;
const REPORT_USER_CONFIG_SIZE = 29; // matches firmware/mouse/configuration/common/hid_report_user_config.h
const REPORT_SIZE = 1 + REPORT_USER_CONFIG_SIZE; // 1 byte report ID + payload
const VENDOR_ID = 0x1915; // Target Vendor ID

// Adaptive backoff for the response poll. The first sleep (2 ms) is short but
// non-zero so the SET_REPORT has a beat to land before we GET_REPORT — without it
// a fast firmware can return us a stale SUCCESS from the *previous* request that
// happens to share recipient/eventId. Subsequent waits climb to match the old
// 20 ms cadence so a slow firmware doesn't get hammered.
const BACKOFF_MS = [2, 4, 8, 16, 20];
const DEFAULT_TIMEOUT_MS = 1500;

export const ConnectionMode = {
    WIRED: 'wired',
    WIRELESS: 'wireless',
};

// PIDs in the 0x1915 family. priority is wired-first when both are connected.
// 0xE001 comes from CONFIG_DESKTOP_DEVICE_PID in firmware/mouse/configuration/
// hitscan_nrf52840/prj_esb*.conf; 0xF001 is the CH32V305 USB-HS bridge that
// fronts the dongle.
const KNOWN_DEVICES = {
    0xE001: { mode: ConnectionMode.WIRED, label: 'Wired Mouse', priority: 1 },
    0xF001: { mode: ConnectionMode.WIRELESS, label: 'Wireless Dongle', priority: 2 },
};

// Module IDs are link-order-dependent and were verified at runtime via
// `WebHIDService.probeModules()` against the prj_esb.conf build:
//   0: dfu
//   1: battery_meas
//   2: motion          (firmware name is just "motion"; key includes the
//                       PAW3395 suffix so callers can use module-specific
//                       names — getConfig matches via String.includes)
// ble_bond isn't registered in this build (BT disabled). For BT-enabled
// builds the ordering will differ; re-run probeModules() to verify.
const HARDCODED_CONFIG = {
    // DFU option IDs are 1-indexed on the wire (firmware decrements by 1 in
    // OPT_ID_GET, see firmware/mouse/src/events/config_event.h:75). Order
    // mirrors enum dfu_opt in firmware/mouse/src/modules/dfu.c:130.
    "dfu": {
        id: 0,
        options: {
            "start": 1,
            "data": 2,
            "sync": 3,
            "reboot": 4,
            "fwinfo": 5,
            "module_variant": 6,
            "devinfo": 7,
        }
    },
    "battery_meas": {
        id: 1,
        options: {
            "bat_level": 1
        }
    },
    "motion/paw3395": {
        id: 2,
        options: {
            "module_variant": 1,
            "cpi": 2,
            "downshift": 3,
            "rest1": 4,
            "rest2": 5,
            "cpi_stage_1": 6,
            "cpi_stage_2": 7,
            "cpi_stage_3": 8,
            "cpi_stage_4": 9,
            "cpi_stage_active": 10,
            "poll_esb": 11,
            "poll_usb": 12,
            "ripple_control": 13,
            "angle_snap": 14,
            "lod": 15,
            "motion_sync": 16
        }
    },
};

// Mirror of DFU_STATE_* in firmware/mouse/src/modules/dfu.c:29-33.
export const DfuState = {
    INACTIVE: 0x00,
    ACTIVE_CONFIG_CHANNEL: 0x01,
    STORING: 0x02,
    CLEANING: 0x03,
    ACTIVE_OTHER: 0x04,
};

export const WebHIDService = {
    device: null,
    configMap: HARDCODED_CONFIG,
    isConnecting: false,
    debug: false, // toggle from devtools: WebHIDService.debug = true
    // Set true while a firmware update is in flight. Suppresses mid-session
    // device swaps so a hot-plug doesn't yank the connection during a flash.
    // Reconnect after the DFU reboot is still allowed (we only block swaps
    // when the current device is still open).
    dfuInProgress: false,

    cleanString(str) {
        return str.replace(/\0/g, '').replace(/[^\x20-\x7E]/g, '').trim();
    },

    toHexString(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    },

    classify(productId) {
        const known = KNOWN_DEVICES[productId];
        if (known) return { ...known };
        const isWireless = (productId & 0xF000) === 0xF000;
        console.warn(`[HID] Unrecognized PID 0x${productId.toString(16)}; falling back to bitmask classification (${isWireless ? 'wireless' : 'wired'}). Add to KNOWN_DEVICES.`);
        return isWireless
            ? { mode: ConnectionMode.WIRELESS, label: 'Wireless Dongle', priority: 3 }
            : { mode: ConnectionMode.WIRED, label: 'Wired Mouse', priority: 1 };
    },

    _pickBest(devices) {
        const ranked = (devices || [])
            .filter(d => d.vendorId === VENDOR_ID)
            .map(d => ({ device: d, ...this.classify(d.productId) }))
            .sort((a, b) => a.priority - b.priority);
        return ranked[0] || null;
    },

    async _activate(picked) {
        if (!picked) return null;
        if (!picked.device.opened) await picked.device.open();
        if (this.device && this.device !== picked.device && this.device.opened) {
            try { await this.device.close(); } catch { /* ignore */ }
        }
        this.device = picked.device;
        return { device: picked.device, mode: picked.mode, label: picked.label };
    },

    async connect() {
        if (!navigator.hid) throw new Error('WebHID not supported in this browser.');

        const requested = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR_ID }] });
        if (requested.length === 0) throw new Error('No device selected');

        // Combine the just-granted device(s) with anything already paired so wired-first
        // applies even when the user picked the dongle from the chooser while a wired
        // mouse is also plugged in.
        const all = [...requested, ...(await navigator.hid.getDevices())];
        const dedup = Array.from(new Map(all.map(d => [d, d])).values());
        const picked = this._pickBest(dedup);
        if (!picked) throw new Error('No matching device');

        const result = await this._activate(picked);
        console.log(`[HID] Connected to ${this.device.productName} (PID: 0x${this.device.productId.toString(16)}, ${result.label})`);
        return result;
    },

    async checkConnection() {
        if (!navigator.hid) return null;

        // While DFU is uploading, do not switch away from the active device
        // even if a higher-priority one appears. Only short-circuit when our
        // device is still open — if it's gone (e.g. mid-reboot during DFU),
        // fall through so we can re-acquire it after re-enumeration.
        if (this.dfuInProgress && this.device && this.device.opened) {
            const known = this.classify(this.device.productId);
            return { device: this.device, mode: known.mode, label: known.label };
        }

        const picked = this._pickBest(await navigator.hid.getDevices());
        if (!picked) {
            if (this.device) {
                try { if (this.device.opened) await this.device.close(); } catch { /* ignore */ }
                this.device = null;
            }
            return null;
        }

        // If we're already on the highest-priority device, return its state.
        if (this.device === picked.device && this.device.opened) {
            return { device: this.device, mode: picked.mode, label: picked.label };
        }

        try {
            const result = await this._activate(picked);
            console.log(`[HID] Active device: ${this.device.productName} (PID: 0x${this.device.productId.toString(16)}, ${result.label})`);
            return result;
        } catch (e) {
            console.warn(`[HID] Failed to open paired device: ${e.message}`);
            return null;
        }
    },

    async disconnect() {
        if (this.device && this.device.opened) await this.device.close();
        this.device = null;
    },

    addEventListeners(onChange) {
        if (!navigator.hid) return () => {};
        const handler = () => onChange();
        navigator.hid.addEventListener('connect', handler);
        navigator.hid.addEventListener('disconnect', handler);
        return () => {
            navigator.hid.removeEventListener('connect', handler);
            navigator.hid.removeEventListener('disconnect', handler);
        };
    },

    async exchangeFeatureReport(recipient, eventId, status, data = null, options = {}) {
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

        if (this.debug) {
            console.log(`[HID] Sending: ID=${REPORT_ID} event=${eventId} Payload=${this.toHexString(buffer)}`);
        }

        try {
            await this.device.sendFeatureReport(REPORT_ID, buffer);
        } catch (e) {
            console.error("[HID] Send Error:", e);
            throw e;
        }

        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const deadline = performance.now() + timeoutMs;
        let attempt = 0;

        while (true) {
            const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
            attempt++;
            await new Promise(r => setTimeout(r, delay));

            let view = null;
            try {
                view = await this.device.receiveFeatureReport(REPORT_ID);
            } catch {
                view = null;
            }

            if (view instanceof DataView && view.byteLength >= 4) {
                const offset = (view.byteLength === REPORT_SIZE && view.getUint8(0) === REPORT_ID) ? 1 : 0;
                if (view.byteLength >= 4 + offset) {
                    const r_rcpt = view.getUint8(0 + offset);
                    const r_evt = view.getUint8(1 + offset);
                    const r_stat = view.getUint8(2 + offset);
                    const r_len = view.getUint8(3 + offset);

                    if (this.debug) {
                        console.log(`[HID] Poll ${attempt}: Rcpt=${r_rcpt}, Evt=${r_evt}, Stat=${r_stat}`);
                    }

                    if (r_stat !== ConfigStatus.PENDING) {
                        if (r_rcpt === recipient && r_evt === eventId) {
                            if (r_stat === ConfigStatus.SUCCESS) {
                                return new Uint8Array(view.buffer, view.byteOffset + 4 + offset, r_len);
                            }
                            console.warn(`[HID] Protocol Status Error: ${r_stat} (rcpt=${recipient}, evt=${eventId})`);
                            return null;
                        }
                        // Mismatch — usually a stale response from the prior request. Keep polling silently.
                    }
                }
            }

            if (performance.now() >= deadline) break;
        }

        console.warn(`[HID] Timeout (${timeoutMs}ms) waiting for response (rcpt=${recipient}, evt=${eventId})`);
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
        if (result) {
            return this.toHexString(result);
        }
        return null;
    },

    async getConfig(moduleName, optionName, options = {}) {
        const availableModules = Object.keys(this.configMap);
        const mod = availableModules.find(k => k.includes(moduleName));
        if (!mod) return null;

        const modInfo = this.configMap[mod];
        let optId = modInfo.options[optionName];
        if (optId === undefined) return null;

        // event_id byte = [MOD:3 | OPT:5] — must match firmware/mouse/src/events/config_event.h
        const eventId = (modInfo.id << 5) | optId;
        const result = await this.exchangeFeatureReport(0, eventId, ConfigStatus.FETCH, null, options);

        if (result) {
            const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
            if (result.byteLength === 4) return view.getUint32(0, true);
            if (result.byteLength === 1) return view.getUint8(0);
            if (result.byteLength === 2) return view.getUint16(0, true);
        }
        return null;
    },

    async setConfig(moduleName, optionName, value, options = {}) {
        const availableModules = Object.keys(this.configMap);
        const mod = availableModules.find(k => k.includes(moduleName));
        if (!mod) throw new Error(`Module ${moduleName} not found`);

        const modInfo = this.configMap[mod];
        const optId = modInfo.options[optionName];
        if (optId === undefined) throw new Error(`Option ${optionName} not found`);

        const eventId = (modInfo.id << 5) | optId;
        const data = new ArrayBuffer(4);
        new DataView(data).setUint32(0, value, true);

        const resp = await this.exchangeFeatureReport(0, eventId, ConfigStatus.SET, data, options);
        return !!resp;
    },

    // ---------------- DFU primitives ----------------
    // Each maps to one option of the firmware-side `dfu` module. Wire format
    // mirrors firmware/mouse/src/modules/dfu.c handlers; see firmware/mouse/
    // doc/dfu.rst for the protocol overview.

    _dfuEventId(optionName) {
        const mod = this.configMap['dfu'];
        if (!mod) throw new Error('DFU module not registered');
        const optId = mod.options[optionName];
        if (optId === undefined) throw new Error(`DFU option ${optionName} not found`);
        return (mod.id << 5) | optId;
    },

    async dfuFwInfo(options = {}) {
        const result = await this.exchangeFeatureReport(0, this._dfuEventId('fwinfo'), ConfigStatus.FETCH, null, options);
        if (!result || result.byteLength < 13) return null;
        // Wire layout matches struct.unpack('<BIBBHI', ...) in
        // C:\ncs\v3.0.2\nrf\scripts\hid_configurator/modules/dfu.py:FwInfo.__init__
        // and the corresponding firmware packing in
        // firmware/mouse/src/modules/dfu.c handle_image_info_request:
        //   u8 flash_area_id, u32 image_size,
        //   u8 ver_major, u8 ver_minor, u16 ver_revision, u32 ver_build
        const dv = new DataView(result.buffer, result.byteOffset, result.byteLength);
        return {
            flashAreaId: dv.getUint8(0),
            imageSize: dv.getUint32(1, true),
            version: {
                major: dv.getUint8(5),
                minor: dv.getUint8(6),
                revision: dv.getUint16(7, true),
                build: dv.getUint32(9, true),
            },
        };
    },

    async dfuDevInfo(options = {}) {
        const result = await this.exchangeFeatureReport(0, this._dfuEventId('devinfo'), ConfigStatus.FETCH, null, options);
        if (!result || result.byteLength < 5) return null;
        const dv = new DataView(result.buffer, result.byteOffset, result.byteLength);
        return {
            vid: dv.getUint16(0, true),
            pid: dv.getUint16(2, true),
            generation: dv.getUint8(4),
        };
    },

    async dfuVariant(options = {}) {
        const result = await this.exchangeFeatureReport(0, this._dfuEventId('module_variant'), ConfigStatus.FETCH, null, options);
        if (!result) return null;
        return this.cleanString(new TextDecoder('utf-8').decode(result));
    },

    async dfuSync(options = {}) {
        // The firmware flushes its RAM sync_buffer to flash inside the sync handler,
        // which can take a few flash-page-erase cycles. Use a longer default budget.
        const opts = { timeoutMs: 3000, ...options };
        const result = await this.exchangeFeatureReport(0, this._dfuEventId('sync'), ConfigStatus.FETCH, null, opts);
        if (!result || result.byteLength < 15) return null;
        // Layout (firmware/mouse/src/modules/dfu.c handle_dfu_sync, line 591-611):
        //   u8 state, u32 imgSize, u32 checksum, u32 offset, u16 syncBufBytes
        const dv = new DataView(result.buffer, result.byteOffset, result.byteLength);
        return {
            state: dv.getUint8(0),
            imgSize: dv.getUint32(1, true),
            checksum: dv.getUint32(5, true),
            offset: dv.getUint32(9, true),
            syncBufBytes: dv.getUint16(13, true),
        };
    },

    async dfuStart(imgSize, checksum, offset, options = {}) {
        const data = new ArrayBuffer(12);
        const dv = new DataView(data);
        dv.setUint32(0, imgSize >>> 0, true);
        dv.setUint32(4, checksum >>> 0, true);
        dv.setUint32(8, offset >>> 0, true);
        const resp = await this.exchangeFeatureReport(0, this._dfuEventId('start'), ConfigStatus.SET, data, options);
        return !!resp;
    },

    // Push one image chunk. Caller must respect the per-call payload budget
    // (REPORT_USER_CONFIG_SIZE - 4 = 25 bytes today).
    async dfuData(chunk, options = {}) {
        if (chunk.byteLength > REPORT_USER_CONFIG_SIZE - 4) {
            throw new Error(`DFU chunk too large: ${chunk.byteLength} > ${REPORT_USER_CONFIG_SIZE - 4}`);
        }
        const buf = chunk instanceof ArrayBuffer ? chunk : chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        const resp = await this.exchangeFeatureReport(0, this._dfuEventId('data'), ConfigStatus.SET, buf, options);
        return !!resp;
    },

    // Triggers the swap-and-reboot. The device drops USB before responding, so
    // the host shouldn't expect a clean SUCCESS — fire-and-forget.
    async dfuReboot(options = {}) {
        try {
            await this.exchangeFeatureReport(0, this._dfuEventId('reboot'), ConfigStatus.FETCH, null, { timeoutMs: 500, ...options });
        } catch {
            // Expected: device disconnects mid-transaction.
        }
    },

    // Diagnostic: probe modules 0..N by name. opt_id 0 returns the
    // module's name string. Run from devtools console:
    //   await WebHIDService.probeModules()
    async probeModules(maxId = 8) {
        const found = {};
        for (let mod = 0; mod < maxId; mod++) {
            const r = await this.exchangeFeatureReport(0, mod << 5, ConfigStatus.FETCH, null, { timeoutMs: 600 });
            const name = r ? this.cleanString(new TextDecoder('utf-8').decode(r)) : null;
            console.log(`[HID] module ${mod}: ${name ?? '<no response>'}`);
            if (name) found[mod] = name;
        }
        return found;
    },

    async startPairing() {
        if (!this.device || !this.device.opened) throw new Error('Device not connected');
        const buffer = new Uint8Array(REPORT_USER_CONFIG_SIZE);
        buffer[0] = 1;  // Recipient
        buffer[1] = 0;     // Event ID
        buffer[2] = ConfigStatus.SET;      // Status
        buffer[3] = 0; // Data length

        console.log(`[HID] Sending Pairing Request: ID=${REPORT_ID}`);
        try {
            await this.device.sendFeatureReport(REPORT_ID, buffer);
            console.log("[HID] Pairing Request Sent");
            return true;
        } catch (e) {
            console.error("[HID] Pairing Request Error:", e);
            throw e;
        }
    },
};

// Expose for ad-hoc poking from DevTools (`WebHIDService.probeModules()` etc).
// Harmless in prod; the symbol is already imported by App.jsx.
if (typeof window !== 'undefined') {
    window.WebHIDService = WebHIDService;
}
