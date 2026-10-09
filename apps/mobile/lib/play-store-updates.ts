import { requireNativeModule, type NativeModule } from 'expo-modules-core';

export type PlayStoreUpdateInfo = {
  availability: 'available' | 'in-progress' | 'not-available' | 'unknown';
  availabilityCode: number;
  installStatus: 'pending' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'failed' | 'canceled' | 'requires-ui-intent' | 'unknown';
  installStatusCode: number;
  updateAvailable: boolean;
  availableVersionCode: number | null;
  clientVersionStalenessDays: number | null;
  updatePriority: number;
  immediateUpdateAllowed: boolean;
  flexibleUpdateAllowed: boolean;
};

interface PlayStoreUpdatesModule extends NativeModule {
  getUpdateInfoAsync(): Promise<PlayStoreUpdateInfo>;
  getInstallerPackageName(): string | null;
}

let PlayStoreUpdates: PlayStoreUpdatesModule | null = null;

try {
  PlayStoreUpdates = requireNativeModule<PlayStoreUpdatesModule>('PlayStoreUpdates');
} catch {
  PlayStoreUpdates = null;
}

export const isPlayStoreUpdatesAvailable = (): boolean => {
  return PlayStoreUpdates != null;
};

export const getPlayStoreUpdateInfoAsync = async (): Promise<PlayStoreUpdateInfo> => {
  if (!PlayStoreUpdates) {
    throw new Error('Play Store updates module unavailable');
  }
  return PlayStoreUpdates.getUpdateInfoAsync();
};

/** The package that installed the app (com.android.vending for Google Play), or null when unknown or without the module (FOSS). */
export const getInstallerPackageName = (): string | null => {
  try {
    return PlayStoreUpdates?.getInstallerPackageName() ?? null;
  } catch {
    return null;
  }
};
