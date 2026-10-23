import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import {
  createMobileFileSyncLeases,
  SyncFileLockIdentityLostError,
  type MobileFileSyncLease,
  type SyncFileLockNativePort,
} from '@mindwtr/core';

// The File Sync lease's rules live in core (mobile-file-sync-lease.ts); this binds them to the
// SyncFileLock Expo module (SyncFileLockCore.kt, and SyncFileLockModule.swift on iOS).

export { SyncFileLockIdentityLostError };
export type { MobileFileSyncLease };

let testModule: SyncFileLockNativePort | null | undefined;
let resolvedModule: SyncFileLockNativePort | null | undefined;
let testPlatform: string | undefined;

const getModule = (): SyncFileLockNativePort | null => {
  if (testModule !== undefined) return testModule;
  if (resolvedModule !== undefined) return resolvedModule;
  try {
    resolvedModule = requireNativeModule<SyncFileLockNativePort>('SyncFileLock');
  } catch {
    resolvedModule = null;
  }
  return resolvedModule;
};

const leases = createMobileFileSyncLeases({
  platform: () => testPlatform ?? Platform.OS,
  nativeModule: () => getModule(),
});

export const acquireMobileFileSyncLease = (syncFileUri: string): Promise<MobileFileSyncLease> => leases.acquire(syncFileUri);

export const revalidateMobileFileSyncLease = (lease: MobileFileSyncLease): Promise<void> => leases.revalidate(lease);

export const releaseMobileFileSyncLease = (lease: MobileFileSyncLease): Promise<void> => leases.release(lease);

export const setSyncFileLockNativeModuleForTests = (
  nativeModule: SyncFileLockNativePort | null | undefined,
  platform?: string,
): void => {
  testModule = nativeModule;
  resolvedModule = undefined;
  testPlatform = platform;
  leases.reset();
};
