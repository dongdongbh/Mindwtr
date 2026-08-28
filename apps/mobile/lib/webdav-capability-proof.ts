import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeWebdavUrl, type WebdavSyncCompatibility } from '@mindwtr/core';

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
  probe: () => Promise<WebdavSyncCompatibility | void>,
): Promise<WebdavSyncCompatibility> => {
  if (await hasWebdavCapabilityProof(config)) return 'strong-etag';
  const compatibility = await probe() ?? 'strong-etag';
  // Do not pin a legacy result; ordinary sync should notice when a provider
  // later starts serving strong ETags.
  if (compatibility === 'strong-etag') await rememberWebdavCapabilityProof(config);
  return compatibility;
};
