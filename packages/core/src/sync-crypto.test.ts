import { describe, expect, it } from 'vitest';
import {
    SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
    SyncCryptoAuthError,
    SyncCryptoUnsupportedError,
    decryptSyncArtifact,
    defaultSyncCryptoPrimitives,
    deriveSyncKeyMaterial,
    encryptSyncArtifact,
    inspectSyncArtifact,
    type SyncCryptoKdfParams,
    type SyncCryptoPrimitives,
} from './sync-crypto';
import vectors from './__fixtures__/sync-crypto/vectors.json';

// Cheap params for tests that don't care about the real KDF cost — the pinned production default
// (SYNC_CRYPTO_DEFAULT_KDF_PARAMS) is exercised by the 'small-json-default-params' fixture vector.
const LIGHT: SyncCryptoKdfParams = { mKib: 64, t: 1, p: 1 };

function b64ToBytes(b64: string): Uint8Array {
    return new Uint8Array(Buffer.from(b64, 'base64'));
}

describe('sync-crypto MWENC1 format', () => {
    it('round-trips a fresh encrypt/decrypt with the injected default primitives', async () => {
        const salt = defaultSyncCryptoPrimitives.randomBytes(16);
        const material = await deriveSyncKeyMaterial('a fresh passphrase', salt, LIGHT);
        const plaintext = new TextEncoder().encode('round trip payload');
        const encrypted = await encryptSyncArtifact(plaintext, material);
        expect(encrypted.byteLength).toBe(plaintext.byteLength + 70);
        const decrypted = await decryptSyncArtifact(encrypted, material.key);
        expect(decrypted).toEqual(plaintext);

        const inspected = inspectSyncArtifact(encrypted);
        expect(inspected.kind).toBe('encrypted');
        if (inspected.kind === 'encrypted') {
            expect(inspected.params).toEqual(LIGHT);
            expect(inspected.formatVersion).toBe(1);
            expect(inspected.kdfId).toBe(1);
            expect(inspected.cipherId).toBe(1);
        }
    });

    it('uses the pinned writer-default KDF params', () => {
        expect(SYNC_CRYPTO_DEFAULT_KDF_PARAMS).toEqual({ mKib: 19456, t: 2, p: 1 });
    });

    describe('interop fixture vectors (shared with the Rust implementation)', () => {
        for (const vector of vectors) {
            it(`decrypts fixture "${vector.name}"`, async () => {
                const salt = b64ToBytes(vector.saltB64);
                const material = await deriveSyncKeyMaterial(vector.passphrase, salt, vector.params);
                const encrypted = b64ToBytes(vector.encryptedB64);
                const decrypted = await decryptSyncArtifact(encrypted, material.key);
                expect(decrypted).toEqual(b64ToBytes(vector.plaintextB64));
            });
        }
    });

    it('ignores trailing garbage bytes appended by non-truncating sync providers', async () => {
        const vector = vectors.find((v) => v.name === 'small-json-default-params')!;
        const salt = b64ToBytes(vector.saltB64);
        const material = await deriveSyncKeyMaterial(vector.passphrase, salt, vector.params);
        const encrypted = b64ToBytes(vector.encryptedB64);

        const padded = new Uint8Array(encrypted.length + 5);
        padded.set(encrypted, 0);
        padded.set([0x20, 0x20, 0x00, 0x00, 0x20], encrypted.length);

        const decrypted = await decryptSyncArtifact(padded, material.key);
        expect(decrypted).toEqual(b64ToBytes(vector.plaintextB64));
    });

    it('rejects the wrong key with SyncCryptoAuthError', async () => {
        const vector = vectors.find((v) => v.name === 'small-json-default-params')!;
        const salt = b64ToBytes(vector.saltB64);
        const wrongMaterial = await deriveSyncKeyMaterial('not the right passphrase', salt, vector.params);
        const encrypted = b64ToBytes(vector.encryptedB64);
        await expect(decryptSyncArtifact(encrypted, wrongMaterial.key)).rejects.toThrow(SyncCryptoAuthError);
    });

    it('rejects a tampered header byte via AAD binding, even with the correct key', async () => {
        const vector = vectors.find((v) => v.name === 'small-json-default-params')!;
        const salt = b64ToBytes(vector.saltB64);
        const material = await deriveSyncKeyMaterial(vector.passphrase, salt, vector.params);
        const encrypted = b64ToBytes(vector.encryptedB64);

        const tampered = new Uint8Array(encrypted);
        tampered[20] ^= 0xff; // inside the KDF salt field, part of the 54-byte AAD

        await expect(decryptSyncArtifact(tampered, material.key)).rejects.toThrow(SyncCryptoAuthError);
    });

    it('reports a truncated file as unsupported, not a silent partial decrypt', async () => {
        const vector = vectors.find((v) => v.name === 'small-json-default-params')!;
        const encrypted = b64ToBytes(vector.encryptedB64);
        const truncated = encrypted.slice(0, encrypted.length - 4);

        const salt = b64ToBytes(vector.saltB64);
        const material = await deriveSyncKeyMaterial(vector.passphrase, salt, vector.params);
        await expect(decryptSyncArtifact(truncated, material.key)).rejects.toThrow(SyncCryptoUnsupportedError);

        const inspected = inspectSyncArtifact(truncated);
        expect(inspected.kind).toBe('unsupported');
    });

    it('reports a header shorter than 54 bytes as unsupported', () => {
        const tiny = new Uint8Array([...new TextEncoder().encode('MWENC1'), 0x01, 0x01]);
        expect(inspectSyncArtifact(tiny)).toEqual({ kind: 'unsupported', reason: expect.any(String) });
    });

    it('classifies plaintext JSON (no magic) as plaintext, not an error', () => {
        const plainJson = new TextEncoder().encode(JSON.stringify({ tasks: [] }));
        expect(inspectSyncArtifact(plainJson)).toEqual({ kind: 'plaintext' });
        expect(inspectSyncArtifact(new Uint8Array(0))).toEqual({ kind: 'plaintext' });
    });

    it('rejects an unknown format_version, kdf_id, or cipher_id as unsupported', async () => {
        const vector = vectors.find((v) => v.name === 'small-json-default-params')!;
        const encrypted = b64ToBytes(vector.encryptedB64);
        const salt = b64ToBytes(vector.saltB64);
        const material = await deriveSyncKeyMaterial(vector.passphrase, salt, vector.params);

        const badVersion = new Uint8Array(encrypted);
        badVersion[6] = 0x02;
        expect(inspectSyncArtifact(badVersion).kind).toBe('unsupported');
        await expect(decryptSyncArtifact(badVersion, material.key)).rejects.toThrow(SyncCryptoUnsupportedError);

        const badKdf = new Uint8Array(encrypted);
        badKdf[7] = 0x02;
        expect(inspectSyncArtifact(badKdf).kind).toBe('unsupported');
        await expect(decryptSyncArtifact(badKdf, material.key)).rejects.toThrow(SyncCryptoUnsupportedError);

        const badCipher = new Uint8Array(encrypted);
        badCipher[17] = 0x02;
        expect(inspectSyncArtifact(badCipher).kind).toBe('unsupported');
        await expect(decryptSyncArtifact(badCipher, material.key)).rejects.toThrow(SyncCryptoUnsupportedError);
    });

    it('derives the same key from NFC-composed and decomposed forms of the same passphrase', async () => {
        const salt = new Uint8Array(16).fill(7);
        const composedPassphrase = 'caf\u00e9'; // single precomposed e-acute codepoint
        const decomposedPassphrase = 'cafe\u0301'; // plain e + combining acute accent (U+0301)
        expect(composedPassphrase).not.toBe(decomposedPassphrase); // sanity: the raw strings really do differ
        const composed = await deriveSyncKeyMaterial(composedPassphrase, salt, LIGHT);
        const decomposed = await deriveSyncKeyMaterial(decomposedPassphrase, salt, LIGHT);
        expect(decomposed.key).toEqual(composed.key);
    });

    it('proves the NFC fixture actually exercises normalization (the stored passphrase is decomposed)', () => {
        const vector = vectors.find((v) => v.name === 'nfc-normalization-cafe')!;
        expect(vector.passphrase).toBe('cafe\u0301');
        expect(vector.passphrase.normalize('NFC')).toBe('caf\u00e9');
    });

    it('rejects a wrong-length key with SyncCryptoUnsupportedError, not a raw WebCrypto error', async () => {
        const vector = vectors.find((v) => v.name === 'small-json-default-params')!;
        const encrypted = b64ToBytes(vector.encryptedB64);
        const shortKey = new Uint8Array(20);
        await expect(decryptSyncArtifact(encrypted, shortKey)).rejects.toThrow(SyncCryptoUnsupportedError);

        const salt = b64ToBytes(vector.saltB64);
        const material = await deriveSyncKeyMaterial(vector.passphrase, salt, vector.params);
        const shortMaterial = { ...material, key: shortKey };
        await expect(encryptSyncArtifact(b64ToBytes(vector.plaintextB64), shortMaterial)).rejects.toThrow(
            SyncCryptoUnsupportedError,
        );
    });

    it('wraps out-of-range Argon2id params as SyncCryptoUnsupportedError, not a raw Error', async () => {
        const salt = new Uint8Array(16).fill(1);
        // m below 8*p is out of Argon2's valid range (RFC 9106) -- @noble/hashes throws a plain Error.
        await expect(deriveSyncKeyMaterial('x', salt, { mKib: 4, t: 1, p: 1 })).rejects.toThrow(
            SyncCryptoUnsupportedError,
        );
    });

    it('rejects KDF params that do not fit the header fields on the write path', async () => {
        const salt = new Uint8Array(16).fill(2);
        const material = await deriveSyncKeyMaterial('x', salt, LIGHT);
        const plaintext = new TextEncoder().encode('x');

        // p=256 would wrap to 0 mod 256 when written into the header's single p byte, producing a
        // file whose recorded params can never reproduce the key they were derived with.
        await expect(
            encryptSyncArtifact(plaintext, { ...material, params: { mKib: 64, t: 1, p: 256 } }),
        ).rejects.toThrow(SyncCryptoUnsupportedError);

        await expect(
            encryptSyncArtifact(plaintext, { ...material, params: { mKib: -1, t: 1, p: 1 } }),
        ).rejects.toThrow(SyncCryptoUnsupportedError);
    });

    it('draws a fresh nonce from randomBytes exactly once per encrypt, never reused', async () => {
        const salt = new Uint8Array(16).fill(3);
        const material = await deriveSyncKeyMaterial('nonce pin test', salt, LIGHT);
        const plaintext = new TextEncoder().encode('same plaintext both times');

        let randomBytesCalls = 0;
        const countingPrims: SyncCryptoPrimitives = {
            ...defaultSyncCryptoPrimitives,
            randomBytes(n) {
                randomBytesCalls += 1;
                return defaultSyncCryptoPrimitives.randomBytes(n);
            },
        };

        const first = await encryptSyncArtifact(plaintext, material, countingPrims);
        const second = await encryptSyncArtifact(plaintext, material, countingPrims);

        expect(randomBytesCalls).toBe(2); // exactly once per encrypt call, never hoisted or reused
        expect(first.slice(34, 46)).not.toEqual(second.slice(34, 46)); // nonces differ
        expect(first).not.toEqual(second); // GCM nonce reuse would otherwise be silent
    });

    describe('KDF cost ceiling on the read path', () => {
        // A minimal, otherwise-valid 54-byte header with no ciphertext -- enough to exercise
        // parseHeader's cost-ceiling check without needing a real fixture.
        function hostileHeader(overrides: Partial<SyncCryptoKdfParams>): Uint8Array {
            const header = new Uint8Array(54);
            header.set(new TextEncoder().encode('MWENC1'), 0);
            header[6] = 0x01; // format_version
            header[7] = 0x01; // kdf_id
            header[17] = 0x01; // cipher_id
            const view = new DataView(header.buffer);
            view.setUint32(8, overrides.mKib ?? 64, true);
            view.setUint32(12, overrides.t ?? 1, true);
            header[16] = overrides.p ?? 1;
            return header;
        }

        it('accepts a header at the ceiling', () => {
            const atCeiling = hostileHeader({ mKib: 262144, t: 16, p: 8 });
            expect(inspectSyncArtifact(atCeiling).kind).toBe('encrypted');
        });

        it('rejects m_kib over the ceiling', () => {
            const hostile = hostileHeader({ mKib: 262145 });
            expect(inspectSyncArtifact(hostile)).toEqual({ kind: 'unsupported', reason: expect.any(String) });
        });

        it('rejects t over the ceiling', () => {
            const hostile = hostileHeader({ t: 17 });
            expect(inspectSyncArtifact(hostile).kind).toBe('unsupported');
        });

        it('rejects p over the ceiling', () => {
            const hostile = hostileHeader({ p: 9 });
            expect(inspectSyncArtifact(hostile).kind).toBe('unsupported');
        });

        it('also rejects an over-ceiling header via decryptSyncArtifact, not just inspect', async () => {
            const hostile = hostileHeader({ mKib: 999_999_999 });
            const key = new Uint8Array(32);
            await expect(decryptSyncArtifact(hostile, key)).rejects.toThrow(SyncCryptoUnsupportedError);
        });
    });
});
