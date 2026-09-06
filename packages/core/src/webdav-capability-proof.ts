import { normalizeWebdavUrl } from './sync-helpers';

export type WebdavCapabilityProofConfig = {
    url: string;
    username?: string;
    allowInsecureHttp?: boolean;
};

/**
 * The device-local identity a cached WebDAV capability proof is keyed on: normalized
 * endpoint, trimmed username, and the insecure-transport policy — the exact dimensions that
 * make an earlier proof (or legacy-plaintext answer) still apply to this configuration.
 *
 * Deliberately excludes the password: a caller that spreads a fuller config object (one that
 * happens to carry a `password` field) onto this shape must never have it enter the string
 * that gets written to device storage.
 */
export const serializeWebdavCapabilityProof = (config: WebdavCapabilityProofConfig): string => JSON.stringify({
    version: 1,
    endpoint: normalizeWebdavUrl(config.url.trim()),
    username: config.username?.trim() ?? '',
    allowInsecureHttp: config.allowInsecureHttp === true,
});
