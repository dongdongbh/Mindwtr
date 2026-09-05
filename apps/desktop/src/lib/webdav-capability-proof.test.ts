import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeWebdavCapabilityProof } from '@mindwtr/core';

import {
    ensureWebdavCapabilityProof,
    hasWebdavCapabilityProof,
    rememberWebdavCapabilityProof,
    WEBDAV_CAPABILITY_PROOF_STORAGE_KEY,
    WEBDAV_LEGACY_PROOF_STORAGE_KEY,
    WEBDAV_LEGACY_PROOF_TTL_MS,
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

    // Serialization itself (what fields it covers, secret exclusion, normalization) is core's
    // `serializeWebdavCapabilityProof` unit test; this only proves the wrapper actually
    // persists that value under this platform's key.
    it('stores the serialized proof under the platform storage key', () => {
        rememberWebdavCapabilityProof(config);

        expect(localStorage.getItem(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY))
            .toBe(serializeWebdavCapabilityProof(config));
    });

    it('invalidates the proof when the configuration changes', () => {
        rememberWebdavCapabilityProof(config);

        expect(hasWebdavCapabilityProof({ ...config, username: 'bob' })).toBe(false);
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

    it('reuses a legacy answer for a day when plaintext is allowed, then probes again', async () => {
        const probe = vi.fn().mockResolvedValue('legacy-plaintext');
        let now = 1_000_000;
        const options = { allowLegacyPlaintext: true, now: () => now };

        await expect(ensureWebdavCapabilityProof(config, probe, options)).resolves.toBe('legacy-plaintext');
        await expect(ensureWebdavCapabilityProof(config, probe, options)).resolves.toBe('legacy-plaintext');
        expect(probe).toHaveBeenCalledTimes(1);

        now += WEBDAV_LEGACY_PROOF_TTL_MS;
        await expect(ensureWebdavCapabilityProof(config, probe, options)).resolves.toBe('legacy-plaintext');
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('never reuses a legacy answer when plaintext is not allowed, and a strong answer clears it', async () => {
        const probe = vi.fn().mockResolvedValue('legacy-plaintext');
        await ensureWebdavCapabilityProof(config, probe, { allowLegacyPlaintext: true });
        await ensureWebdavCapabilityProof(config, probe);
        expect(probe).toHaveBeenCalledTimes(2);

        // The cached legacy answer is still fresh, so only a call that must probe (plaintext
        // not allowed) sees the server's upgrade; the strong proof then replaces the legacy one.
        probe.mockResolvedValue('strong-etag');
        await expect(ensureWebdavCapabilityProof(config, probe)).resolves.toBe('strong-etag');
        expect(localStorage.getItem(WEBDAV_LEGACY_PROOF_STORAGE_KEY)).toBeNull();
        expect(hasWebdavCapabilityProof(config)).toBe(true);
    });
});
