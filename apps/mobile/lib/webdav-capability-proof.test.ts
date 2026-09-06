import { afterEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { serializeWebdavCapabilityProof } from '@mindwtr/core';

import {
  ensureWebdavCapabilityProof,
  hasWebdavCapabilityProof,
  rememberWebdavCapabilityProof,
  WEBDAV_CAPABILITY_PROOF_STORAGE_KEY,
  WEBDAV_LEGACY_PROOF_STORAGE_KEY,
  WEBDAV_LEGACY_PROOF_TTL_MS,
} from './webdav-capability-proof';

vi.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        values.delete(key);
      }),
      clear: vi.fn(async () => values.clear()),
    },
  };
});

afterEach(async () => {
  await AsyncStorage.clear();
  vi.clearAllMocks();
});

describe('mobile WebDAV capability proof', () => {
  const config = {
    url: 'https://dav.example.com/mindwtr/',
    username: 'alice',
    allowInsecureHttp: false,
  };

  // Serialization itself (what fields it covers, secret exclusion, normalization) is core's
  // `serializeWebdavCapabilityProof` unit test; this only proves the wrapper actually
  // persists that value under this platform's key.
  it('stores the serialized proof under the platform storage key', async () => {
    await rememberWebdavCapabilityProof(config);

    await expect(AsyncStorage.getItem(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY))
      .resolves.toBe(serializeWebdavCapabilityProof(config));
  });

  it('invalidates the proof when the configuration changes', async () => {
    await rememberWebdavCapabilityProof(config);

    await expect(hasWebdavCapabilityProof({ ...config, username: 'bob' })).resolves.toBe(false);
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
    await expect(hasWebdavCapabilityProof(config)).resolves.toBe(false);
  });

  it('does not cache legacy plaintext compatibility and detects a later strong capability', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce('legacy-plaintext')
      .mockResolvedValueOnce('strong-etag');

    await expect(ensureWebdavCapabilityProof(config, probe)).resolves.toBe('legacy-plaintext');
    await expect(hasWebdavCapabilityProof(config)).resolves.toBe(false);
    await expect(ensureWebdavCapabilityProof(config, probe)).resolves.toBe('strong-etag');
    await expect(hasWebdavCapabilityProof(config)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('reuses a legacy answer for a day when plaintext is allowed, then probes again', async () => {
    const probe = vi.fn().mockResolvedValue('legacy-plaintext');
    let now = 1_000_000;
    const options = { allowLegacyPlaintext: true, now: () => now };

    await expect(ensureWebdavCapabilityProof(config, probe, options)).resolves.toBe('legacy-plaintext');
    await expect(ensureWebdavCapabilityProof(config, probe, options)).resolves.toBe('legacy-plaintext');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(await AsyncStorage.getItem(WEBDAV_LEGACY_PROOF_STORAGE_KEY)).not.toContain('must-not-persist');

    now += WEBDAV_LEGACY_PROOF_TTL_MS;
    await expect(ensureWebdavCapabilityProof(config, probe, options)).resolves.toBe('legacy-plaintext');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('never reuses a legacy answer when plaintext is not allowed, and a strong answer clears it', async () => {
    const probe = vi.fn().mockResolvedValue('legacy-plaintext');
    await ensureWebdavCapabilityProof(config, probe, { allowLegacyPlaintext: true });
    // Encryption turned on: the cached legacy answer must not short-circuit the probe.
    await ensureWebdavCapabilityProof(config, probe);
    expect(probe).toHaveBeenCalledTimes(2);

    // The cached legacy answer is still fresh, so only a call that must probe (plaintext
    // not allowed) sees the server's upgrade; the strong proof then replaces the legacy one.
    probe.mockResolvedValue('strong-etag');
    await expect(ensureWebdavCapabilityProof(config, probe)).resolves.toBe('strong-etag');
    expect(await AsyncStorage.getItem(WEBDAV_LEGACY_PROOF_STORAGE_KEY)).toBeNull();
    await expect(hasWebdavCapabilityProof(config)).resolves.toBe(true);
  });
});
