import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncFileLockBusyError, SyncFileLockUnavailableError } from '@mindwtr/core';

vi.mock('expo-modules-core', () => ({
  requireNativeModule: vi.fn(() => { throw new Error('native module unavailable'); }),
}));

import {
  acquireMobileFileSyncLease,
  revalidateMobileFileSyncLease,
  releaseMobileFileSyncLease,
  setSyncFileLockNativeModuleForTests,
  SyncFileLockIdentityLostError,
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
      revalidateAsync: vi.fn(async () => undefined),
      releaseAsync: vi.fn(async () => undefined),
    };
    setSyncFileLockNativeModuleForTests(nativeModule, 'android');
    const lease = await acquireMobileFileSyncLease('content://provider/tree/root/document/root/data.json');

    expect(lease).toEqual({ token: 'native-token', native: true });
    expect(nativeModule.acquireAsync).toHaveBeenCalledWith('content://provider/tree/root/document/root/data.json');
    await revalidateMobileFileSyncLease(lease);
    expect(nativeModule.revalidateAsync).toHaveBeenCalledWith('native-token');
    await releaseMobileFileSyncLease(lease);
    expect(nativeModule.releaseAsync).toHaveBeenCalledWith('native-token');
  });

  it('distinguishes release-time lock identity loss from ordinary cleanup failure', async () => {
    setSyncFileLockNativeModuleForTests({
      acquireAsync: vi.fn(async () => 'native-token'),
      revalidateAsync: vi.fn(async () => undefined),
      releaseAsync: vi.fn(async () => {
        throw new Error('SYNC_FILE_LOCK_UNAVAILABLE: .mindwtr.lock identity changed');
      }),
    }, 'android');
    const lease = await acquireMobileFileSyncLease('file:///tmp/data.json');

    await expect(releaseMobileFileSyncLease(lease))
      .rejects.toBeInstanceOf(SyncFileLockIdentityLostError);
  });

  it('rejects missing native tokens instead of silently running unlocked', async () => {
    setSyncFileLockNativeModuleForTests({
      acquireAsync: vi.fn(async () => ''),
      revalidateAsync: vi.fn(async () => undefined),
      releaseAsync: vi.fn(async () => undefined),
    }, 'android');
    await expect(acquireMobileFileSyncLease('file:///tmp/data.json'))
      .rejects.toMatchObject({
        name: 'SyncFileLockUnavailableError',
        message: expect.stringContaining('Safe File Sync locking is unavailable'),
      });
  });

  it.each([
    ['SYNC_FILE_LOCK_BUSY: another File Sync operation is active', SyncFileLockBusyError],
    ['SYNC_FILE_LOCK_UNAVAILABLE: provider cannot open the lock document', SyncFileLockUnavailableError],
  ])('normalizes the native %s sentinel before it reaches orchestration', async (message, ExpectedError) => {
    setSyncFileLockNativeModuleForTests({
      acquireAsync: vi.fn(async () => { throw new Error(message); }),
      revalidateAsync: vi.fn(async () => undefined),
      releaseAsync: vi.fn(async () => undefined),
    }, 'android');

    await expect(acquireMobileFileSyncLease('content://provider/tree/root/document/root/data.json'))
      .rejects.toBeInstanceOf(ExpectedError);
  });

  it('fails closed when iOS native stable locking is unavailable', async () => {
    setSyncFileLockNativeModuleForTests(null, 'ios');
    await expect(acquireMobileFileSyncLease('file:///tmp/data.json'))
      .rejects.toBeInstanceOf(SyncFileLockUnavailableError);
  });

  it('keeps the non-native process lease exclusive and rejects stale releases', async () => {
    setSyncFileLockNativeModuleForTests(null, 'web');
    const lease = await acquireMobileFileSyncLease('file:///tmp/data.json');
    await expect(acquireMobileFileSyncLease('file:///tmp/data.json'))
      .rejects.toBeInstanceOf(SyncFileLockBusyError);
    await releaseMobileFileSyncLease(lease);
    await expect(releaseMobileFileSyncLease(lease)).rejects.toBeInstanceOf(SyncFileLockUnavailableError);
  });
});
