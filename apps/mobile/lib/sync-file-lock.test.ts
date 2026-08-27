import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo-modules-core', () => ({
  requireNativeModule: vi.fn(() => { throw new Error('native module unavailable'); }),
}));

import {
  acquireMobileFileSyncLease,
  releaseMobileFileSyncLease,
  setSyncFileLockNativeModuleForTests,
  SYNC_FILE_LOCK_UNAVAILABLE,
} from './sync-file-lock';

afterEach(() => {
  setSyncFileLockNativeModuleForTests(undefined);
});

describe('sync-file-lock', () => {
  it('fails closed when Android native locking is unavailable', async () => {
    setSyncFileLockNativeModuleForTests(null, 'android');
    await expect(acquireMobileFileSyncLease('content://provider/tree/root/document/root/data.json'))
      .rejects.toThrow(SYNC_FILE_LOCK_UNAVAILABLE);
  });

  it('retains and releases the opaque native token for SAF and path providers', async () => {
    const nativeModule = {
      acquireAsync: vi.fn(async () => 'native-token'),
      releaseAsync: vi.fn(async () => undefined),
    };
    setSyncFileLockNativeModuleForTests(nativeModule, 'android');
    const lease = await acquireMobileFileSyncLease('content://provider/tree/root/document/root/data.json');

    expect(lease).toEqual({ token: 'native-token', native: true });
    expect(nativeModule.acquireAsync).toHaveBeenCalledWith('content://provider/tree/root/document/root/data.json');
    await releaseMobileFileSyncLease(lease);
    expect(nativeModule.releaseAsync).toHaveBeenCalledWith('native-token');
  });

  it('rejects missing native tokens instead of silently running unlocked', async () => {
    setSyncFileLockNativeModuleForTests({
      acquireAsync: vi.fn(async () => ''),
      releaseAsync: vi.fn(async () => undefined),
    }, 'android');
    await expect(acquireMobileFileSyncLease('file:///tmp/data.json'))
      .rejects.toThrow(SYNC_FILE_LOCK_UNAVAILABLE);
  });

  it('keeps the non-Android process lease exclusive and rejects stale releases', async () => {
    setSyncFileLockNativeModuleForTests(null, 'ios');
    const lease = await acquireMobileFileSyncLease('file:///tmp/data.json');
    await expect(acquireMobileFileSyncLease('file:///tmp/data.json'))
      .rejects.toThrow('SYNC_FILE_LOCK_BUSY');
    await releaseMobileFileSyncLease(lease);
    await expect(releaseMobileFileSyncLease(lease)).rejects.toThrow(SYNC_FILE_LOCK_UNAVAILABLE);
  });
});
