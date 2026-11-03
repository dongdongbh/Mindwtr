


const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
    const map = new Uint8Array(256);
    map.fill(255);
    for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
        map[BASE64_ALPHABET.charCodeAt(i)] = i;
    }
    return map;
})();

export const bytesToBase64 = (bytes: Uint8Array): string => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i] ?? 0;
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];

        const hasB1 = typeof b1 === 'number';
        const hasB2 = typeof b2 === 'number';
        const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);

        out += BASE64_ALPHABET[(triplet >> 18) & 0x3f];
        out += BASE64_ALPHABET[(triplet >> 12) & 0x3f];
        out += hasB1 ? BASE64_ALPHABET[(triplet >> 6) & 0x3f] : '=';
        out += hasB2 ? BASE64_ALPHABET[triplet & 0x3f] : '=';
    }
    return out;
};

export const base64ToBytes = (base64: string): Uint8Array => {
    const sanitized = base64.replace(/[^A-Za-z0-9+/=]/g, '');
    const padding = sanitized.endsWith('==') ? 2 : sanitized.endsWith('=') ? 1 : 0;
    const outputLength = Math.max(0, (sanitized.length * 3) / 4 - padding);
    const bytes = new Uint8Array(outputLength);
    let buffer = 0;
    let bits = 0;
    let index = 0;

    for (let i = 0; i < sanitized.length; i += 1) {
        const ch = sanitized.charCodeAt(i);
        if (sanitized[i] === '=') break;
        const value = BASE64_LOOKUP[ch];
        if (value === 255) continue;
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (index < bytes.length) {
                bytes[index] = (buffer >> bits) & 0xff;
            }
            index += 1;
        }
    }
    return bytes;
};
