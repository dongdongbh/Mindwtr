import { normalizeWebdavUrl } from '@mindwtr/core';

export const WEBDAV_CAPABILITY_PROOF_STORAGE_KEY = 'mindwtr-webdav-capability-proof-v1';

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
        // The current run was proven. If renderer storage is unavailable, the
        // next run safely probes again instead of trusting an unrecorded result.
    }
};

export const ensureWebdavCapabilityProof = async (
    config: WebdavCapabilityProofConfig,
    probe: () => Promise<void>,
): Promise<void> => {
    if (hasWebdavCapabilityProof(config)) return;
    await probe();
    rememberWebdavCapabilityProof(config);
};
