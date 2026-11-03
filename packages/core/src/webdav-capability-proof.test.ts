import { describe, expect, it, vi } from 'vitest';

import {
    WEBDAV_CAPABILITY_PROOF_STORAGE_KEY,
    WEBDAV_LEGACY_PROOF_STORAGE_KEY,
    WEBDAV_LEGACY_PROOF_TTL_MS,
    createWebdavCapabilityProofStore,
    serializeWebdavCapabilityProof,
} from './webdav-capability-proof';

describe('serializeWebdavCapabilityProof', () => {
    const config = {
        url: 'https://dav.example.com/mindwtr/',
        username: 'alice',
        allowInsecureHttp: false,
    };

    it('encodes a versioned, normalized, secret-free identity', () => {
        const proof = serializeWebdavCapabilityProof({ ...config, password: 'must-not-persist' } as never);

        expect(proof).toContain('"version":1');
        expect(proof).toContain('https://dav.example.com/mindwtr/data.json');
        expect(proof).toContain('alice');
        expect(proof).not.toContain('must-not-persist');
    });

    it('trims the username and treats a missing one as empty', () => {
        expect(serializeWebdavCapabilityProof({ ...config, username: '  alice  ' }))
            .toBe(serializeWebdavCapabilityProof(config));
        expect(JSON.parse(serializeWebdavCapabilityProof({ url: config.url })).username).toBe('');
    });

    it.each([
        ['endpoint', { ...config, url: 'https://other.example.com/mindwtr/' }],
        ['username', { ...config, username: 'bob' }],
        ['insecure transport policy', { ...config, allowInsecureHttp: true }],
    ])('changes the proof when the %s changes', (_label, changedConfig) => {
        expect(serializeWebdavCapabilityProof(changedConfig)).not.toBe(serializeWebdavCapabilityProof(config));
    });
});

describe('createWebdavCapabilityProofStore', () => {
    const config = {
        url: 'https://dav.example.com/mindwtr/',
        username: 'alice',
        allowInsecureHttp: false,
    };

    const memoryStorage = () => {
        const values = new Map<string, string>();
        return {
            values,
            failReads: false,
            failWrites: false,
            async getItem(key: string) {
                if (this.failReads) throw new Error('storage unavailable');
                return values.get(key) ?? null;
            },
            async setItem(key: string, value: string) {
                if (this.failWrites) throw new Error('storage unavailable');
                values.set(key, value);
            },
            async removeItem(key: string) {
                values.delete(key);
            },
        };
    };

    it('keeps a strong-ETag proof for the same configuration and drops a stale legacy answer', async () => {
        const storage = memoryStorage();
        storage.values.set(WEBDAV_LEGACY_PROOF_STORAGE_KEY, '{"proof":"old","at":0}');
        const store = createWebdavCapabilityProofStore(storage);
        const probe = vi.fn().mockResolvedValue(undefined);

        await expect(store.ensureWebdavCapabilityProof(config, probe)).resolves.toBe('strong-etag');
        await expect(store.ensureWebdavCapabilityProof(config, probe)).resolves.toBe('strong-etag');

        expect(probe).toHaveBeenCalledTimes(1);
        expect(storage.values.get(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY)).toBe(serializeWebdavCapabilityProof(config));
        expect(storage.values.has(WEBDAV_LEGACY_PROOF_STORAGE_KEY)).toBe(false);
        await expect(store.hasWebdavCapabilityProof({ ...config, username: 'bob' })).resolves.toBe(false);
    });

    it('reuses a legacy answer for one day, and only for a caller that accepts plaintext', async () => {
        const storage = memoryStorage();
        const store = createWebdavCapabilityProofStore(storage);
        const probe = vi.fn().mockResolvedValue('legacy-plaintext');
        let now = 50_000;
        const plaintextOk = { allowLegacyPlaintext: true, now: () => now };

        await expect(store.ensureWebdavCapabilityProof(config, probe, plaintextOk)).resolves.toBe('legacy-plaintext');
        await expect(store.ensureWebdavCapabilityProof(config, probe, plaintextOk)).resolves.toBe('legacy-plaintext');
        expect(probe).toHaveBeenCalledTimes(1);


        await store.ensureWebdavCapabilityProof(config, probe, { now: () => now });
        expect(probe).toHaveBeenCalledTimes(2);
        expect(JSON.parse(storage.values.get(WEBDAV_LEGACY_PROOF_STORAGE_KEY)!).at).toBe(50_000);

        now += WEBDAV_LEGACY_PROOF_TTL_MS;
        await store.ensureWebdavCapabilityProof(config, probe, plaintextOk);
        expect(probe).toHaveBeenCalledTimes(3);


        now = 49_000;
        storage.values.set(WEBDAV_LEGACY_PROOF_STORAGE_KEY, JSON.stringify({
            proof: serializeWebdavCapabilityProof(config),
            at: 50_000,
        }));
        await store.ensureWebdavCapabilityProof(config, probe, plaintextOk);
        expect(probe).toHaveBeenCalledTimes(4);
    });

    it('treats unreadable or unwritable storage as no proof, so the next run probes again', async () => {
        const storage = memoryStorage();
        const store = createWebdavCapabilityProofStore(storage);
        const probe = vi.fn().mockResolvedValue('strong-etag');

        storage.failWrites = true;
        await expect(store.ensureWebdavCapabilityProof(config, probe)).resolves.toBe('strong-etag');
        storage.failWrites = false;
        storage.failReads = true;
        await expect(store.hasWebdavCapabilityProof(config)).resolves.toBe(false);
        storage.failReads = false;
        await expect(store.ensureWebdavCapabilityProof(config, probe)).resolves.toBe('strong-etag');

        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('records nothing when the probe fails', async () => {
        const storage = memoryStorage();
        const store = createWebdavCapabilityProofStore(storage);

        await expect(store.ensureWebdavCapabilityProof(
            config,
            vi.fn().mockRejectedValue(new Error('conditional writes unavailable')),
            { allowLegacyPlaintext: true },
        )).rejects.toThrow('conditional writes unavailable');
        expect(storage.values.size).toBe(0);
    });
});
