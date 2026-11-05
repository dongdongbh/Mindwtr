import {
    serializeWebdavCapabilityProof,
    type WebdavCapabilityProofConfig,
    type WebdavSyncCompatibility,
} from '@mindwtr/core';

export type { WebdavCapabilityProofConfig };

export const WEBDAV_CAPABILITY_PROOF_STORAGE_KEY = 'mindwtr-webdav-capability-proof-v1';
export const WEBDAV_LEGACY_PROOF_STORAGE_KEY = 'mindwtr-webdav-legacy-proof-v1';


export const WEBDAV_LEGACY_PROOF_TTL_MS = 24 * 60 * 60_000;

export const hasWebdavCapabilityProof = (config: WebdavCapabilityProofConfig): boolean => {
    try {
        return localStorage.getItem(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY)
            === serializeWebdavCapabilityProof(config);
    } catch {
        return false;
    }
};

export const rememberWebdavCapabilityProof = (config: WebdavCapabilityProofConfig): void => {
    try {
        localStorage.setItem(
            WEBDAV_CAPABILITY_PROOF_STORAGE_KEY,
            serializeWebdavCapabilityProof(config),
        );
    } catch {


    }
};

const hasRecentLegacyProof = (config: WebdavCapabilityProofConfig, now: number): boolean => {
    try {
        const raw = localStorage.getItem(WEBDAV_LEGACY_PROOF_STORAGE_KEY);
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

const rememberLegacyProof = (config: WebdavCapabilityProofConfig, now: number): void => {
    try {
        localStorage.setItem(
            WEBDAV_LEGACY_PROOF_STORAGE_KEY,
            JSON.stringify({ proof: serializeWebdavCapabilityProof(config), at: now }),
        );
    } catch {

    }
};

export type EnsureWebdavCapabilityProofOptions = {


    allowLegacyPlaintext?: boolean;
    now?: () => number;
};

export const ensureWebdavCapabilityProof = async (
    config: WebdavCapabilityProofConfig,
    probe: () => Promise<WebdavSyncCompatibility | void>,
    options: EnsureWebdavCapabilityProofOptions = {},
): Promise<WebdavSyncCompatibility> => {
    const now = options.now?.() ?? Date.now();
    if (hasWebdavCapabilityProof(config)) return 'strong-etag';
    if (options.allowLegacyPlaintext && hasRecentLegacyProof(config, now)) return 'legacy-plaintext';
    const compatibility = await probe() ?? 'strong-etag';
    if (compatibility === 'strong-etag') {
        rememberWebdavCapabilityProof(config);
        try { localStorage.removeItem(WEBDAV_LEGACY_PROOF_STORAGE_KEY); } catch {                             }
    } else if (options.allowLegacyPlaintext) {
        rememberLegacyProof(config, now);
    }
    return compatibility;
};
