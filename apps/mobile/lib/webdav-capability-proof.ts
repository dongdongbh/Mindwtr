import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeWebdavUrl } from '@mindwtr/core';

export const WEBDAV_CAPABILITY_PROOF_STORAGE_KEY = '@mindwtr_webdav_capability_proof_v1';

export type WebdavCapabilityProofConfig = {
  url: string;
  username?: string;
  allowInsecureHttp?: boolean;
};

const serializeWebdavCapabilityProof = (config: WebdavCapabilityProofConfig): string => JSON.stringify({
  version: 1,
  endpoint: normalizeWebdavUrl(config.url.trim()),
  username: config.username?.trim() ?? '',
  allowInsecureHttp: config.allowInsecureHttp === true,
});

export const hasWebdavCapabilityProof = async (config: WebdavCapabilityProofConfig): Promise<boolean> => {
  try {
    return await AsyncStorage.getItem(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY)
      === serializeWebdavCapabilityProof(config);
  } catch {
    return false;
  }
};

export const rememberWebdavCapabilityProof = async (config: WebdavCapabilityProofConfig): Promise<void> => {
  try {
    await AsyncStorage.setItem(
      WEBDAV_CAPABILITY_PROOF_STORAGE_KEY,
      serializeWebdavCapabilityProof(config),
    );
  } catch {
    // The current run was proven. If device storage is unavailable, the next
    // run safely probes again instead of trusting an unrecorded result.
  }
};

export const ensureWebdavCapabilityProof = async (
  config: WebdavCapabilityProofConfig,
  probe: () => Promise<void>,
): Promise<void> => {
  if (await hasWebdavCapabilityProof(config)) return;
  await probe();
  await rememberWebdavCapabilityProof(config);
};
