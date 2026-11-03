import { normalizeWebdavUrl } from './sync-helpers';
import type { WebdavSyncCompatibility } from './webdav';

export type WebdavCapabilityProofConfig = {
    url: string;
    username?: string;
    allowInsecureHttp?: boolean;
};


export const serializeWebdavCapabilityProof = (config: WebdavCapabilityProofConfig): string => JSON.stringify({
    version: 1,
    endpoint: normalizeWebdavUrl(config.url.trim()),
    username: config.username?.trim() ?? '',
    allowInsecureHttp: config.allowInsecureHttp === true,
});

export const WEBDAV_CAPABILITY_PROOF_STORAGE_KEY = '@mindwtr_webdav_capability_proof_v1';
export const WEBDAV_LEGACY_PROOF_STORAGE_KEY = '@mindwtr_webdav_legacy_proof_v1';


export const WEBDAV_LEGACY_PROOF_TTL_MS = 24 * 60 * 60_000;


export type WebdavCapabilityProofStoragePort = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
};

export type EnsureWebdavCapabilityProofOptions = {


    allowLegacyPlaintext?: boolean;
    now?: () => number;
};

export type WebdavCapabilityProofStore = {
    hasWebdavCapabilityProof(config: WebdavCapabilityProofConfig): Promise<boolean>;
    rememberWebdavCapabilityProof(config: WebdavCapabilityProofConfig): Promise<void>;
    ensureWebdavCapabilityProof(
        config: WebdavCapabilityProofConfig,
        probe: () => Promise<WebdavSyncCompatibility | void>,
        options?: EnsureWebdavCapabilityProofOptions,
    ): Promise<WebdavSyncCompatibility>;
};


export const createWebdavCapabilityProofStore = (
    storage: WebdavCapabilityProofStoragePort,
): WebdavCapabilityProofStore => {
    const hasWebdavCapabilityProof = async (config: WebdavCapabilityProofConfig): Promise<boolean> => {
        try {
            return await storage.getItem(WEBDAV_CAPABILITY_PROOF_STORAGE_KEY)
                === serializeWebdavCapabilityProof(config);
        } catch {
            return false;
        }
    };

    const rememberWebdavCapabilityProof = async (config: WebdavCapabilityProofConfig): Promise<void> => {
        try {
            await storage.setItem(
                WEBDAV_CAPABILITY_PROOF_STORAGE_KEY,
                serializeWebdavCapabilityProof(config),
            );
        } catch {


        }
    };

    const hasRecentLegacyProof = async (config: WebdavCapabilityProofConfig, now: number): Promise<boolean> => {
        try {
            const raw = await storage.getItem(WEBDAV_LEGACY_PROOF_STORAGE_KEY);
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
            await storage.setItem(
                WEBDAV_LEGACY_PROOF_STORAGE_KEY,
                JSON.stringify({ proof: serializeWebdavCapabilityProof(config), at: now }),
            );
        } catch {

        }
    };

    const ensureWebdavCapabilityProof = async (
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
            await storage.removeItem(WEBDAV_LEGACY_PROOF_STORAGE_KEY).catch(() => undefined);
        } else if (options.allowLegacyPlaintext) {
            await rememberLegacyProof(config, now);
        }
        return compatibility;
    };

    return { hasWebdavCapabilityProof, rememberWebdavCapabilityProof, ensureWebdavCapabilityProof };
};
