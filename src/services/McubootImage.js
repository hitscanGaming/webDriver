// MCUboot image header parser. Validates the magic and pulls out the version
// + image size that the firmware-update flow needs to display and to negotiate
// with the device's `dfu/start` op. Also exposes the IEEE 802.3 CRC-32 the
// nrf_desktop config-channel DFU module uses as the image checksum.

const MAGIC_V1 = 0x96f3b83d;
const HEADER_SIZE = 32;

export class McubootImageParseError extends Error {}

// CRC-32 with Python `zlib.crc32(data, value)` semantics: `seed` is the
// running CRC value in post-XOR form. Internally we XOR with 0xFFFFFFFF to
// get the register state, process bytes, then XOR back at the end.
//
// Upstream nrf_desktop host script (C:\ncs\v3.0.2\nrf\scripts\hid_configurator/
// modules/dfu.py:file_crc) seeds the running value with **1**, not 0, so the
// resulting checksum is NOT a standard IEEE 802.3 CRC-32. We default seed to 1
// to match the upstream wire convention — the firmware uses img_csum as a
// resume cookie, but if upstream Python and our JS ever upload the same
// image they need to compute identical values for resume to work.
function crc32(bytes, seed = 1) {
    let crc = (seed ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < bytes.length; i++) {
        crc = (crc ^ bytes[i]) >>> 0;
        for (let b = 0; b < 8; b++) {
            crc = ((crc >>> 1) ^ (0xEDB88320 & -(crc & 1))) >>> 0;
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

export const McubootImage = {
    MAGIC_V1,

    // Parse a signed firmware image. If the file has an MCUboot v1 magic,
    // returns the parsed header fields. Otherwise (e.g. a B0-signed image
    // from `signed_by_b0_*.bin`) returns a raw blob — version is null, but
    // the upload still has totalSize + checksum + bytes which is everything
    // the firmware-side `dfu/start` + `dfu/data` ops need. Success in that
    // case is detected by comparing pre/post device fwinfo.
    parse(arrayBuffer) {
        const u8 = new Uint8Array(arrayBuffer);
        if (u8.length < HEADER_SIZE) {
            throw new McubootImageParseError('File too small to be a signed firmware image');
        }
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const magic = dv.getUint32(0, true);
        const totalSize = u8.length;
        const checksum = crc32(u8);

        if (magic !== MAGIC_V1) {
            // Likely a B0-signed image (Hitscan default). No parseable
            // version on the host; rely on device-side fwinfo for verify.
            return { magic, format: 'b0-or-raw', version: null, totalSize, checksum, bytes: u8 };
        }
        // image_header layout (little-endian):
        //   u32 magic; u32 load_addr; u16 hdr_size; u16 protect_tlv_size;
        //   u32 img_size; u32 flags;
        //   { u8 major; u8 minor; u16 revision; u32 build_num; } version;
        //   u32 _pad1;
        return {
            magic,
            format: 'mcuboot',
            loadAddr: dv.getUint32(4, true),
            hdrSize: dv.getUint16(8, true),
            protectTlvSize: dv.getUint16(10, true),
            imgSize: dv.getUint32(12, true),
            flags: dv.getUint32(16, true),
            version: {
                major: dv.getUint8(20),
                minor: dv.getUint8(21),
                revision: dv.getUint16(22, true),
                build: dv.getUint32(24, true),
            },
            totalSize,
            checksum,
            bytes: u8,
        };
    },

    formatVersion(v) {
        return `${v.major}.${v.minor}.${v.revision}+${v.build}`;
    },

    // Compare two parsed-version objects. Returns -1 / 0 / +1.
    compareVersion(a, b) {
        if (a.major !== b.major) return a.major < b.major ? -1 : 1;
        if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
        if (a.revision !== b.revision) return a.revision < b.revision ? -1 : 1;
        if (a.build !== b.build) return a.build < b.build ? -1 : 1;
        return 0;
    },
};
