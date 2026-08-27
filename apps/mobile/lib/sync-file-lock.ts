import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import {
  normalizeSyncFileLockError,
  SyncFileLockBusyError,
  SyncFileLockUnavailableError,
} from '@mindwtr/core';

type SyncFileLockNativeModule = {
  acquireAsync(uri: string): Promise<string>;
  releaseAsync(token: string): Promise<void>;
};

export type MobileFileSyncLease = {
  token: string;
  native: boolean;
};

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
 * Android holds a FileChannel lock on the exact persistent `.mindwtr.lock`
 * document shared by path and SAF providers. Other mobile platforms have no
 * second native File Sync writer today; their existing process-wide serialized
 * document queue is represented by this fail-closed token. Cross-device and
 * non-advisory providers remain protected by document CAS and transition final
 * inventory validation rather than pretending an advisory lock is distributed.
 */
export const acquireMobileFileSyncLease = async (syncFileUri: string): Promise<MobileFileSyncLease> => {
  const platform = testPlatform ?? Platform.OS;
  if (platform === 'android') {
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

export const releaseMobileFileSyncLease = async (lease: MobileFileSyncLease): Promise<void> => {
  if (lease.native) {
    const nativeModule = getModule();
    if (!nativeModule) {
      throw new SyncFileLockUnavailableError();
    }
    try {
      await nativeModule.releaseAsync(lease.token);
    } catch (error) {
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
