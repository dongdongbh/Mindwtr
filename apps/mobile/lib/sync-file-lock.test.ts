import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncFileLockBusyError, SyncFileLockUnavailableError } from '@mindwtr/core';

vi.mock('expo-modules-core', () => ({
  requireNativeModule: vi.fn(() => { throw new Error('native module unavailable'); }),
}));

import {
  acquireMobileFileSyncLease,
  releaseMobileFileSyncLease,
  setSyncFileLockNativeModuleForTests,
} from './sync-file-lock';

afterEach(() => {
  setSyncFileLockNativeModuleForTests(undefined);
});

describe('sync-file-lock', () => {
  it('fails closed when Android native locking is unavailable', async () => {
    setSyncFileLockNativeModuleForTests(null, 'android');
    await expect(acquireMobileFileSyncLease('content://provider/tree/root/document/root/data.json'))
      .rejects.toBeInstanceOf(SyncFileLockUnavailableError);
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
      .rejects.toBeInstanceOf(SyncFileLockUnavailableError);
  });

  it.each([
    ['SYNC_FILE_LOCK_BUSY: another File Sync operation is active', SyncFileLockBusyError],
    ['SYNC_FILE_LOCK_UNAVAILABLE: provider cannot open the lock document', SyncFileLockUnavailableError],
  ])('normalizes the native %s sentinel before it reaches orchestration', async (message, ExpectedError) => {
    setSyncFileLockNativeModuleForTests({
      acquireAsync: vi.fn(async () => { throw new Error(message); }),
      releaseAsync: vi.fn(async () => undefined),
    }, 'android');

    await expect(acquireMobileFileSyncLease('content://provider/tree/root/document/root/data.json'))
      .rejects.toBeInstanceOf(ExpectedError);
  });

  it('keeps the non-Android process lease exclusive and rejects stale releases', async () => {
    setSyncFileLockNativeModuleForTests(null, 'ios');
    const lease = await acquireMobileFileSyncLease('file:///tmp/data.json');
    await expect(acquireMobileFileSyncLease('file:///tmp/data.json'))
      .rejects.toBeInstanceOf(SyncFileLockBusyError);
    await releaseMobileFileSyncLease(lease);
    await expect(releaseMobileFileSyncLease(lease)).rejects.toBeInstanceOf(SyncFileLockUnavailableError);
  });
});
