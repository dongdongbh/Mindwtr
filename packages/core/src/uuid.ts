// Cross-platform UUID generator
// Works in Node.js, browsers, and React Native

export function generateUUID(): string {
    // Try to use crypto.randomUUID if available (modern browsers and Node 19+)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }

    // Use crypto.getRandomValues when available for a stronger fallback.
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        // Set version and variant bits.
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;

        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    // Fallback: Generate UUID v4 manually
    // Based on RFC 4122
    const hex = '0123456789abcdef';
    let uuid = '';

    for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) {
            uuid += '-';
        } else if (i === 14) {
            uuid += '4'; // Version 4
        } else if (i === 19) {
            uuid += hex[(Math.random() * 4 | 8)]; // Variant bits
        } else {
            uuid += hex[Math.random() * 16 | 0];
        }
    }

    return uuid;
}

// Alias for compatibility
export const v4 = generateUUID;
