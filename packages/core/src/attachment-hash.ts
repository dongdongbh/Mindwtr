const toHex = (bytes: Uint8Array): string => {
    let out = '';
    for (const byte of bytes) {
        out += byte.toString(16).padStart(2, '0');
    }
    return out;
};

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;


export const isSha256Hex = (value: unknown): value is string =>
    typeof value === 'string' && SHA256_HEX_PATTERN.test(value);

export type Sha256HexProvider = (bytes: Uint8Array) => Promise<string> | string;

let sha256HexProvider: Sha256HexProvider | null = null;


export const setSha256HexProvider = (provider: Sha256HexProvider | null): void => {
    sha256HexProvider = provider;
};

export async function computeSha256Hex(data: ArrayBuffer | Uint8Array): Promise<string | null> {
    const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
    if (sha256HexProvider) {
        const hex = await sha256HexProvider(bytes);
        return isSha256Hex(hex) ? hex.toLowerCase() : null;
    }
    const subtle = typeof crypto === 'object' && crypto?.subtle ? crypto.subtle : null;
    if (!subtle) return null;
    const hash = await subtle.digest('SHA-256', bytes.buffer);
    return toHex(new Uint8Array(hash));
}
