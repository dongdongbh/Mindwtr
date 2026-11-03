import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeSha256Hex, isSha256Hex, setSha256HexProvider } from './attachment-hash';


const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const abcBytes = new Uint8Array([0x61, 0x62, 0x63]);

afterEach(() => {
    setSha256HexProvider(null);
    vi.unstubAllGlobals();
});

describe('isSha256Hex', () => {
    it('accepts a 64-character hex digest in either case', () => {
        expect(isSha256Hex(ABC_SHA256)).toBe(true);
        expect(isSha256Hex(ABC_SHA256.toUpperCase())).toBe(true);
    });

    it('rejects anything that is not a 64-character hex digest', () => {
        expect(isSha256Hex(undefined)).toBe(false);
        expect(isSha256Hex('')).toBe(false);
        expect(isSha256Hex(ABC_SHA256.slice(0, 63))).toBe(false);
        expect(isSha256Hex(`${ABC_SHA256}0`)).toBe(false);
        expect(isSha256Hex(`${ABC_SHA256.slice(0, 63)}z`)).toBe(false);
    });
});

describe('computeSha256Hex', () => {
    it('digests bytes with crypto.subtle when no provider is registered', async () => {
        expect(await computeSha256Hex(abcBytes)).toBe(ABC_SHA256);
    });

    it('accepts an ArrayBuffer as well as a Uint8Array', async () => {
        expect(await computeSha256Hex(abcBytes.buffer)).toBe(ABC_SHA256);
    });

    it('returns null when neither a provider nor crypto.subtle is available', async () => {
        vi.stubGlobal('crypto', {});
        expect(await computeSha256Hex(abcBytes)).toBeNull();
    });

    it('uses a registered provider instead of crypto.subtle', async () => {
        vi.stubGlobal('crypto', {});
        const provider = vi.fn(() => ABC_SHA256);
        setSha256HexProvider(provider);
        expect(await computeSha256Hex(abcBytes)).toBe(ABC_SHA256);
        expect(provider).toHaveBeenCalledTimes(1);
        expect(provider.mock.calls[0][0]).toEqual(abcBytes);
    });

    it('awaits an async provider and lowercases its digest', async () => {
        setSha256HexProvider(async () => ABC_SHA256.toUpperCase());
        expect(await computeSha256Hex(abcBytes)).toBe(ABC_SHA256);
    });

    it('returns null when a provider hands back something that is not a digest', async () => {
        setSha256HexProvider(() => 'not-a-digest');
        expect(await computeSha256Hex(abcBytes)).toBeNull();
    });
});
