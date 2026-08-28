import { afterEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  ensureWebdavCapabilityProof,
  hasWebdavCapabilityProof,
  rememberWebdavCapabilityProof,
  WEBDAV_CAPABILITY_PROOF_STORAGE_KEY,
} from './webdav-capability-proof';

vi.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
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

  it('stores a versioned device-local identity without secret values', async () => {
    await rememberWebdavCapabilityProof({ ...config, password: 'must-not-persist' } as never);

    const proof = await AsyncStorage.getItem(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY);
    expect(proof).toContain('"version":1');
    expect(proof).toContain('https://dav.example.com/mindwtr/data.json');
    expect(proof).toContain('alice');
    expect(proof).not.toContain('must-not-persist');
  });

  it.each([
    ['endpoint', { ...config, url: 'https://other.example.com/mindwtr/' }],
    ['username', { ...config, username: 'bob' }],
    ['insecure transport policy', { ...config, allowInsecureHttp: true }],
  ])('invalidates the proof when the %s changes', async (_label, changedConfig) => {
    await rememberWebdavCapabilityProof(config);

    await expect(hasWebdavCapabilityProof(changedConfig)).resolves.toBe(false);
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
});
