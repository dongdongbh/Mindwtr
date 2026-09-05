import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  serializeWebdavCapabilityProof,
  type WebdavCapabilityProofConfig,
  type WebdavSyncCompatibility,
} from '@mindwtr/core';

export type { WebdavCapabilityProofConfig };

export const WEBDAV_CAPABILITY_PROOF_STORAGE_KEY = '@mindwtr_webdav_capability_proof_v1';
export const WEBDAV_LEGACY_PROOF_STORAGE_KEY = '@mindwtr_webdav_legacy_proof_v1';
// A legacy (no strong ETag) answer is re-checked daily, not per cycle: the probe is the
// cold first request of every sync and on a slow link it failed cycles whose own reads
// then succeeded (Jianguoyun, roaming, 2026-08-31). A day bounds how long a server that
// starts serving strong ETags goes unnoticed without asking the user to re-save.
export const WEBDAV_LEGACY_PROOF_TTL_MS = 24 * 60 * 60_000;

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

const hasRecentLegacyProof = async (config: WebdavCapabilityProofConfig, now: number): Promise<boolean> => {
  try {
    const raw = await AsyncStorage.getItem(WEBDAV_LEGACY_PROOF_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { proof?: unknown; at?: unknown };
    return parsed.proof === serializeWebdavCapabilityProof(config)
      && typeof parsed.at === 'number'
      && now - parsed.at >= 0
      && now - parsed.at < WEBDAV_LEGACY_PROOF_TTL_MS;
  } catch {
    return false;
  }
};

const rememberLegacyProof = async (config: WebdavCapabilityProofConfig, now: number): Promise<void> => {
  try {
    await AsyncStorage.setItem(
      WEBDAV_LEGACY_PROOF_STORAGE_KEY,
      JSON.stringify({ proof: serializeWebdavCapabilityProof(config), at: now }),
    );
  } catch {
    // Next run probes again.
  }
};

export type EnsureWebdavCapabilityProofOptions = {
  /** Only a caller that accepts plaintext without a strong ETag may reuse a cached
   *  legacy answer; with encryption on, the probe must run and reject it. */
  allowLegacyPlaintext?: boolean;
  now?: () => number;
};

export const ensureWebdavCapabilityProof = async (
  config: WebdavCapabilityProofConfig,
  probe: () => Promise<WebdavSyncCompatibility | void>,
  options: EnsureWebdavCapabilityProofOptions = {},
): Promise<WebdavSyncCompatibility> => {
  const now = options.now?.() ?? Date.now();
  if (await hasWebdavCapabilityProof(config)) return 'strong-etag';
  if (options.allowLegacyPlaintext && await hasRecentLegacyProof(config, now)) return 'legacy-plaintext';
  const compatibility = await probe() ?? 'strong-etag';
  if (compatibility === 'strong-etag') {
    await rememberWebdavCapabilityProof(config);
    await AsyncStorage.removeItem(WEBDAV_LEGACY_PROOF_STORAGE_KEY).catch(() => undefined);
  } else if (options.allowLegacyPlaintext) {
    await rememberLegacyProof(config, now);
  }
  return compatibility;
};
