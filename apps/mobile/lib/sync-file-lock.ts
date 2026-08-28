import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import {
  normalizeSyncFileLockError,
  SyncFileLockBusyError,
  SyncFileLockUnavailableError,
} from '@mindwtr/core';

type SyncFileLockNativeModule = {
  acquireAsync(uri: string): Promise<string>;
  revalidateAsync(token: string): Promise<void>;
  releaseAsync(token: string): Promise<void>;
};

export type MobileFileSyncLease = {
  token: string;
  native: boolean;
};

/** Release consumed the native token but its final pathname/inode check proved
 * the compatibility lock was replaced. Callers that have just committed local
 * encryption material must compensate, unlike an ordinary close failure. */
export class SyncFileLockIdentityLostError extends SyncFileLockUnavailableError {
  constructor(cause: unknown) {
    super('Safe File Sync locking was lost because the lock identity changed.');
    this.name = 'SyncFileLockIdentityLostError';
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

const isNativeLockIdentityLoss = (error: unknown): boolean =>
  /SYNC_FILE_LOCK_UNAVAILABLE:[^\n]*(?:identity|root)[^\n]*changed/i.test(String(error ?? ''));

let testModule: SyncFileLockNativeModule | null | undefined;
let resolvedModule: SyncFileLockNativeModule | null | undefined;
let testPlatform: string | undefined;
let fallbackLeaseToken: string | null = null;
let fallbackLeaseSequence = 0;

const getModule = (): SyncFileLockNativeModule | null => {
  if (testModule !== undefined) return testModule;
  if (resolvedModule !== undefined) return resolvedModule;
  try {
    resolvedModule = requireNativeModule<SyncFileLockNativeModule>('SyncFileLock');
  } catch {
    resolvedModule = null;
  }
  return resolvedModule;
};

/**
 * Android and iOS hold an unreplaceable platform authority first, then the
 * exact persistent `.mindwtr.lock` for old-client compatibility. Cross-device
 * and non-advisory providers remain protected by document CAS and transition
 * final inventory validation rather than pretending a kernel lock is distributed.
 */
export const acquireMobileFileSyncLease = async (syncFileUri: string): Promise<MobileFileSyncLease> => {
  const platform = testPlatform ?? Platform.OS;
  if (platform === 'android' || platform === 'ios') {
    const nativeModule = getModule();
    if (!nativeModule) {
      throw new SyncFileLockUnavailableError();
    }
    let token: string;
    try {
      token = await nativeModule.acquireAsync(syncFileUri);
    } catch (error) {
      throw normalizeSyncFileLockError(error);
    }
    if (!token || typeof token !== 'string') {
      throw new SyncFileLockUnavailableError();
    }
    return { token, native: true };
  }

  if (fallbackLeaseToken) {
    throw new SyncFileLockBusyError();
  }
  fallbackLeaseSequence += 1;
  fallbackLeaseToken = `mobile-process-${fallbackLeaseSequence}`;
  return { token: fallbackLeaseToken, native: false };
};

export const revalidateMobileFileSyncLease = async (lease: MobileFileSyncLease): Promise<void> => {
  if (lease.native) {
    const nativeModule = getModule();
    if (!nativeModule) throw new SyncFileLockUnavailableError();
    try {
      await nativeModule.revalidateAsync(lease.token);
    } catch (error) {
      throw normalizeSyncFileLockError(error);
    }
    return;
  }
  if (fallbackLeaseToken !== lease.token) throw new SyncFileLockUnavailableError();
};

export const releaseMobileFileSyncLease = async (lease: MobileFileSyncLease): Promise<void> => {
  if (lease.native) {
    const nativeModule = getModule();
    if (!nativeModule) {
      throw new SyncFileLockUnavailableError();
    }
    try {
      await nativeModule.releaseAsync(lease.token);
    } catch (error) {
      if (isNativeLockIdentityLoss(error)) throw new SyncFileLockIdentityLostError(error);
      throw normalizeSyncFileLockError(error);
    }
    return;
  }
  if (fallbackLeaseToken !== lease.token) {
    throw new SyncFileLockUnavailableError();
  }
  fallbackLeaseToken = null;
};

export const setSyncFileLockNativeModuleForTests = (
  nativeModule: SyncFileLockNativeModule | null | undefined,
  platform?: string,
): void => {
  testModule = nativeModule;
  resolvedModule = undefined;
  testPlatform = platform;
  fallbackLeaseToken = null;
};
