import { requireNativeModule } from 'expo-modules-core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AttachmentFileInstallerUnavailableError,
  createMobileAttachmentInstaller,
  type MobileAttachmentInstaller,
  type NativeAttachmentFileInstaller,
} from '@mindwtr/core/mobile-attachment-installer';
import { logInfo } from './app-log';


export { AttachmentFileInstallerUnavailableError };
export type {
  AttachmentFileExpectedGeneration,
  AttachmentFileHashSnapshot,
  AttachmentFileInstallResult,
  FileSyncAttachmentPublicationReservation,
  ImmutableAttachmentFilePublishResult,
} from '@mindwtr/core/mobile-attachment-installer';

let installer: MobileAttachmentInstaller | null = null;

const mobileAttachmentInstaller = (): MobileAttachmentInstaller => {
  if (installer) return installer;
  installer = createMobileAttachmentInstaller({
    loadNativeModule: () => requireNativeModule<NativeAttachmentFileInstaller>('AttachmentFileInstaller'),
    storage: {
      getItem: (key) => AsyncStorage.getItem(key),
      setItem: (key, value) => AsyncStorage.setItem(key, value),
      removeItem: (key) => AsyncStorage.removeItem(key),
    },
    log: { info: (message, context) => logInfo(message, context) },
  });
  return installer;
};

type Installer = MobileAttachmentInstaller;


export const recoverFileSyncAttachmentPublications: Installer['recoverFileSyncAttachmentPublications'] = (...args) => (
  mobileAttachmentInstaller().recoverFileSyncAttachmentPublications(...args)
);

export const reserveFileSyncAttachmentPublication: Installer['reserveFileSyncAttachmentPublication'] = (...args) => (
  mobileAttachmentInstaller().reserveFileSyncAttachmentPublication(...args)
);


export const claimFileSyncAttachmentPublication: Installer['claimFileSyncAttachmentPublication'] = (...args) => (
  mobileAttachmentInstaller().claimFileSyncAttachmentPublication(...args)
);
export const completeFileSyncAttachmentPublication: Installer['completeFileSyncAttachmentPublication'] = (...args) => (
  mobileAttachmentInstaller().completeFileSyncAttachmentPublication(...args)
);
export const abandonFileSyncAttachmentPublication: Installer['abandonFileSyncAttachmentPublication'] = (...args) => (
  mobileAttachmentInstaller().abandonFileSyncAttachmentPublication(...args)
);
export const retainFileSyncAttachmentPublicationForInvalidTarget: Installer['retainFileSyncAttachmentPublicationForInvalidTarget'] = (...args) => (
  mobileAttachmentInstaller().retainFileSyncAttachmentPublicationForInvalidTarget(...args)
);


export const clearFileSyncAttachmentPublicationRecovery: Installer['clearFileSyncAttachmentPublicationRecovery'] = (...args) => (
  mobileAttachmentInstaller().clearFileSyncAttachmentPublicationRecovery(...args)
);
export const installAttachmentFileGeneration: Installer['installAttachmentFileGeneration'] = (...args) => (
  mobileAttachmentInstaller().installAttachmentFileGeneration(...args)
);


export const hashAttachmentFileGeneration: Installer['hashAttachmentFileGeneration'] = (...args) => (
  mobileAttachmentInstaller().hashAttachmentFileGeneration(...args)
);


export const publishImmutableAttachmentFileGeneration: Installer['publishImmutableAttachmentFileGeneration'] = (...args) => (
  mobileAttachmentInstaller().publishImmutableAttachmentFileGeneration(...args)
);
