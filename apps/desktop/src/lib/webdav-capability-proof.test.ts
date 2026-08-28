import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ensureWebdavCapabilityProof,
    hasWebdavCapabilityProof,
    rememberWebdavCapabilityProof,
    WEBDAV_CAPABILITY_PROOF_STORAGE_KEY,
} from './webdav-capability-proof';

afterEach(() => {
    localStorage.clear();
});

describe('desktop WebDAV capability proof', () => {
    const config = {
        url: 'https://dav.example.com/mindwtr/',
        username: 'alice',
        allowInsecureHttp: false,
    };

    it('stores a versioned device-local identity without secret values', () => {
        rememberWebdavCapabilityProof({ ...config, password: 'must-not-persist' } as never);

        const proof = localStorage.getItem(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY);
        expect(proof).toContain('"version":1');
        expect(proof).toContain('https://dav.example.com/mindwtr/data.json');
        expect(proof).toContain('alice');
        expect(proof).not.toContain('must-not-persist');
    });

    it.each([
        ['endpoint', { ...config, url: 'https://other.example.com/mindwtr/' }],
        ['username', { ...config, username: 'bob' }],
        ['insecure transport policy', { ...config, allowInsecureHttp: true }],
    ])('invalidates the proof when the %s changes', (_label, changedConfig) => {
        rememberWebdavCapabilityProof(config);

        expect(hasWebdavCapabilityProof(changedConfig)).toBe(false);
    });

    it('probes once for an unchanged configuration and records success', async () => {
        const probe = vi.fn().mockResolvedValue(undefined);

        await ensureWebdavCapabilityProof(config, probe);
        await ensureWebdavCapabilityProof(config, probe);

        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('does not record a failed proof', async () => {
        const probe = vi.fn().mockRejectedValue(new Error('conditional writes unavailable'));

        await expect(ensureWebdavCapabilityProof(config, probe)).rejects.toThrow(
            'conditional writes unavailable',
        );
        expect(hasWebdavCapabilityProof(config)).toBe(false);
    });

    it('does not cache legacy plaintext compatibility and detects a later strong capability', async () => {
        const probe = vi.fn()
            .mockResolvedValueOnce('legacy-plaintext')
            .mockResolvedValueOnce('strong-etag');

        await expect(ensureWebdavCapabilityProof(config, probe)).resolves.toBe('legacy-plaintext');
        expect(hasWebdavCapabilityProof(config)).toBe(false);
        await expect(ensureWebdavCapabilityProof(config, probe)).resolves.toBe('strong-etag');
        expect(hasWebdavCapabilityProof(config)).toBe(true);
        expect(probe).toHaveBeenCalledTimes(2);
    });
});
