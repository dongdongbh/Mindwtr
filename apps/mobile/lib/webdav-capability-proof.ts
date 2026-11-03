import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createWebdavCapabilityProofStore,
  type EnsureWebdavCapabilityProofOptions,
  type WebdavCapabilityProofConfig,
  type WebdavCapabilityProofStore,
  type WebdavSyncCompatibility,
} from '@mindwtr/core';


export {
  WEBDAV_CAPABILITY_PROOF_STORAGE_KEY,
  WEBDAV_LEGACY_PROOF_STORAGE_KEY,
  WEBDAV_LEGACY_PROOF_TTL_MS,
} from '@mindwtr/core';
export type { EnsureWebdavCapabilityProofOptions, WebdavCapabilityProofConfig };


let store: WebdavCapabilityProofStore | null = null;
const proofStore = (): WebdavCapabilityProofStore => {
  store ??= createWebdavCapabilityProofStore({
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  });
  return store;
};

export const hasWebdavCapabilityProof = (config: WebdavCapabilityProofConfig): Promise<boolean> =>
  proofStore().hasWebdavCapabilityProof(config);

export const rememberWebdavCapabilityProof = (config: WebdavCapabilityProofConfig): Promise<void> =>
  proofStore().rememberWebdavCapabilityProof(config);

export const ensureWebdavCapabilityProof = (
  config: WebdavCapabilityProofConfig,
  probe: () => Promise<WebdavSyncCompatibility | void>,
  options: EnsureWebdavCapabilityProofOptions = {},
): Promise<WebdavSyncCompatibility> => proofStore().ensureWebdavCapabilityProof(config, probe, options);
