


export function generateUUID(): string {

    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }


    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);

        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;

        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }


    const hex = '0123456789abcdef';
    let uuid = '';

    for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) {
            uuid += '-';
        } else if (i === 14) {
            uuid += '4';
        } else if (i === 19) {
            uuid += hex[(Math.random() * 4 | 8)];
        } else {
            uuid += hex[Math.random() * 16 | 0];
        }
    }

    return uuid;
}

export const deterministicHash128 = (value: string): [number, number, number, number] => {
    let h1 = 1779033703;
    let h2 = 3144134277;
    let h3 = 1013904242;
    let h4 = 2773480762;

    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
    }

    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);

    return [
        (h1 ^ h2 ^ h3 ^ h4) >>> 0,
        (h2 ^ h1) >>> 0,
        (h3 ^ h1) >>> 0,
        (h4 ^ h1) >>> 0,
    ];
};


export const deterministicHash128Hex = (value: string): string => (
    deterministicHash128(String(value)).map((part) => part.toString(16).padStart(8, '0')).join('')
);

export function generateDeterministicUUID(value: string): string {
    const hex = deterministicHash128(String(value)).map((part) => part.toString(16).padStart(8, '0')).join('');
    const chars = hex.slice(0, 32).split('');
    chars[12] = '5';
    chars[16] = ((Number.parseInt(chars[16] || '0', 16) & 0x3) | 0x8).toString(16);
    const normalized = chars.join('');
    return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`;
}


export const v4 = generateUUID;
