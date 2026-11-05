


import type { SyncSecretStoragePort, SyncSecretVault } from './sync-secret-storage';
import type { SyncKeyValueStoragePort } from './sync-storage-keys';

export const DROPBOX_SECURESTORE_TOKENS_KEY = 'mindwtr_dropbox_tokens';
export const DROPBOX_ASYNC_TOKENS_KEY = '@mindwtr_dropbox_tokens';
export const DROPBOX_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

export interface DropboxAuthTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

export interface DropboxAccessTokenResolution {
    accessToken: string;
    tokens: DropboxAuthTokens;
}

const sanitizeTokens = (value: unknown): DropboxAuthTokens | null => {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const accessToken = typeof record.accessToken === 'string' ? record.accessToken.trim() : '';
    const refreshToken = typeof record.refreshToken === 'string' ? record.refreshToken.trim() : '';
    const expiresAtRaw = record.expiresAt;
    const expiresAt = typeof expiresAtRaw === 'number' ? expiresAtRaw : Number(expiresAtRaw);
    if (!accessToken || !refreshToken || !Number.isFinite(expiresAt)) return null;
    return { accessToken, refreshToken, expiresAt };
};

const requireDropboxClientId = (clientId: string): string => {
    const trimmed = clientId.trim();
    if (!trimmed) {
        throw new Error('Dropbox app key is not configured');
    }
    return trimmed;
};

export const isDropboxClientConfigured = (clientId: string): boolean => clientId.trim().length > 0;

const requireDropboxTokens = (tokens: DropboxAuthTokens): DropboxAuthTokens => {
    const sanitized = sanitizeTokens(tokens);
    if (!sanitized) {
        throw new Error('Dropbox is not connected');
    }
    return sanitized;
};

export type DropboxTokenStore = {
    getStoredDropboxTokens(beforeMutation?: () => void): Promise<DropboxAuthTokens | null>;
    saveDropboxTokens(tokens: DropboxAuthTokens, beforeMutation?: () => void): Promise<void>;
    clearDropboxTokens(beforeMutation?: () => void): Promise<void>;
    isDropboxConnected(beforeMutation?: () => void): Promise<boolean>;
    refreshDropboxAccessToken(clientId: string, refreshToken: string, fetcher?: typeof fetch): Promise<DropboxAuthTokens>;

    getValidDropboxAccessTokenForTokens(
        clientId: string,
        tokens: DropboxAuthTokens,
        fetcher?: typeof fetch,
    ): Promise<DropboxAccessTokenResolution>;

    forceRefreshDropboxAccessTokenForTokens(
        clientId: string,
        tokens: DropboxAuthTokens,
        fetcher?: typeof fetch,
    ): Promise<DropboxAccessTokenResolution>;
    getValidDropboxAccessToken(clientId: string, fetcher?: typeof fetch): Promise<string>;
    forceRefreshDropboxAccessToken(clientId: string, fetcher?: typeof fetch): Promise<string>;

    revokeDropboxTokens(clientId: string, tokens: DropboxAuthTokens, fetcher?: typeof fetch): Promise<void>;
    disconnectDropbox(clientId: string, fetcher?: typeof fetch, beforeMutation?: () => void): Promise<void>;
};

export type DropboxTokenStoreDeps = {
    storage: SyncKeyValueStoragePort;
    secrets: SyncSecretStoragePort;
    vault: SyncSecretVault;

    fetch: typeof fetch;
    now?: () => number;
};

export const createDropboxTokenStore = ({
    storage,
    secrets,
    vault,
    fetch: defaultFetcher,
    now = () => Date.now(),
}: DropboxTokenStoreDeps): DropboxTokenStore => {
    const readRawTokenPayload = async (beforeMutation?: () => void): Promise<string | null> => {
        if (await vault.isSecureStoreAvailable()) {
            const secureValue = await secrets.getItem(DROPBOX_SECURESTORE_TOKENS_KEY);
            if (secureValue) {
                beforeMutation?.();
                await storage.removeItem(DROPBOX_ASYNC_TOKENS_KEY);
                return secureValue;
            }

            const legacyValue = await storage.getItem(DROPBOX_ASYNC_TOKENS_KEY);
            if (legacyValue !== null) {
                beforeMutation?.();
                await secrets.setItem(DROPBOX_SECURESTORE_TOKENS_KEY, legacyValue, 'when-unlocked');
                beforeMutation?.();
                await storage.removeItem(DROPBOX_ASYNC_TOKENS_KEY);
            }
            return legacyValue;
        }

        const sessionValue = vault.getSessionSecret(DROPBOX_SECURESTORE_TOKENS_KEY);
        if (sessionValue !== null) return sessionValue;

        const legacyValue = await storage.getItem(DROPBOX_ASYNC_TOKENS_KEY);
        if (legacyValue !== null) {
            beforeMutation?.();
            await vault.evacuateLegacySecretToSession(
                DROPBOX_SECURESTORE_TOKENS_KEY,
                legacyValue,
                () => { beforeMutation?.(); return storage.removeItem(DROPBOX_ASYNC_TOKENS_KEY); },
            );
        }
        return legacyValue;
    };

    const writeRawTokenPayload = async (value: string, beforeMutation?: () => void): Promise<void> => {
        if (await vault.isSecureStoreAvailable()) {
            beforeMutation?.();
            await secrets.setItem(DROPBOX_SECURESTORE_TOKENS_KEY, value, 'when-unlocked');
            beforeMutation?.();
            await storage.removeItem(DROPBOX_ASYNC_TOKENS_KEY);
            beforeMutation?.();
            vault.deleteSessionSecret(DROPBOX_SECURESTORE_TOKENS_KEY);
            return;
        }

        beforeMutation?.();
        await storage.removeItem(DROPBOX_ASYNC_TOKENS_KEY);
        beforeMutation?.();
        vault.setSessionSecret(DROPBOX_SECURESTORE_TOKENS_KEY, value);
    };

    const clearRawTokenPayload = async (beforeMutation?: () => void): Promise<void> => {
        if (await vault.isSecureStoreAvailable()) {
            beforeMutation?.();
            await secrets.deleteItem(DROPBOX_SECURESTORE_TOKENS_KEY);
        }
        beforeMutation?.();
        await storage.removeItem(DROPBOX_ASYNC_TOKENS_KEY);
        beforeMutation?.();
        vault.deleteSessionSecret(DROPBOX_SECURESTORE_TOKENS_KEY);
    };

    const getStoredDropboxTokens = async (beforeMutation?: () => void): Promise<DropboxAuthTokens | null> => {
        const raw = await readRawTokenPayload(beforeMutation);
        if (!raw) return null;
        try {
            return sanitizeTokens(JSON.parse(raw));
        } catch {
            return null;
        }
    };

    const saveDropboxTokens = async (tokens: DropboxAuthTokens, beforeMutation?: () => void): Promise<void> => {
        const sanitized = sanitizeTokens(tokens);
        if (!sanitized) {
            throw new Error('Invalid Dropbox token payload');
        }
        await writeRawTokenPayload(JSON.stringify(sanitized), beforeMutation);
    };

    const clearDropboxTokens = async (beforeMutation?: () => void): Promise<void> => {
        await clearRawTokenPayload(beforeMutation);
    };

    const requestDropboxAccessToken = async (
        clientId: string,
        refreshToken: string,
        fetcher: typeof fetch = defaultFetcher,
    ): Promise<DropboxAuthTokens> => {
        const resolvedClientId = requireDropboxClientId(clientId);
        const resolvedRefreshToken = refreshToken.trim();
        if (!resolvedRefreshToken) {
            throw new Error('Dropbox refresh token is missing');
        }

        const response = await fetcher('https://api.dropboxapi.com/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: resolvedRefreshToken,
                client_id: resolvedClientId,
            }).toString(),
        });

        const payload = await response.json().catch(() => null) as {
            access_token?: unknown;
            expires_in?: unknown;
            error_description?: unknown;
            error_summary?: unknown;
        } | null;
        if (!response.ok) {
            const message = payload && typeof payload === 'object'
                ? (typeof payload.error_description === 'string'
                    ? payload.error_description
                    : typeof payload.error_summary === 'string'
                        ? payload.error_summary
                        : null)
                : `HTTP ${response.status}`;
            throw new Error(`Dropbox token refresh failed: ${message || `HTTP ${response.status}`}`);
        }

        const accessToken = typeof payload?.access_token === 'string' ? payload.access_token.trim() : '';
        const expiresInRaw = payload?.expires_in;
        const expiresIn = typeof expiresInRaw === 'number' ? expiresInRaw : Number(expiresInRaw);
        if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
            throw new Error('Dropbox token refresh returned an invalid response');
        }

        return {
            accessToken,
            refreshToken: resolvedRefreshToken,
            expiresAt: now() + expiresIn * 1000,
        };
    };

    const refreshDropboxAccessToken = async (
        clientId: string,
        refreshToken: string,
        fetcher: typeof fetch = defaultFetcher,
    ): Promise<DropboxAuthTokens> => {
        const tokens = await requestDropboxAccessToken(clientId, refreshToken, fetcher);
        await saveDropboxTokens(tokens);
        return tokens;
    };

    const revokeDropboxTokens = async (
        clientId: string,
        tokens: DropboxAuthTokens,
        fetcher: typeof fetch = defaultFetcher,
    ): Promise<void> => {
        requireDropboxClientId(clientId);
        const resolvedTokens = requireDropboxTokens(tokens);
        try {
            await fetcher('https://api.dropboxapi.com/2/auth/token/revoke', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${resolvedTokens.accessToken}`,
                },
            });
        } catch {

        }
    };

    return {
        getStoredDropboxTokens,
        saveDropboxTokens,
        clearDropboxTokens,
        isDropboxConnected: async (beforeMutation) => {
            const tokens = await getStoredDropboxTokens(beforeMutation);
            return Boolean(tokens?.refreshToken && tokens.accessToken);
        },
        refreshDropboxAccessToken,
        getValidDropboxAccessTokenForTokens: async (clientId, tokens, fetcher = defaultFetcher) => {
            requireDropboxClientId(clientId);
            const resolvedTokens = requireDropboxTokens(tokens);
            if (now() < resolvedTokens.expiresAt - DROPBOX_ACCESS_TOKEN_REFRESH_SKEW_MS) {
                return { accessToken: resolvedTokens.accessToken, tokens: resolvedTokens };
            }

            const refreshed = await requestDropboxAccessToken(clientId, resolvedTokens.refreshToken, fetcher);
            return { accessToken: refreshed.accessToken, tokens: refreshed };
        },
        forceRefreshDropboxAccessTokenForTokens: async (clientId, tokens, fetcher = defaultFetcher) => {
            requireDropboxClientId(clientId);
            const resolvedTokens = requireDropboxTokens(tokens);
            const refreshed = await requestDropboxAccessToken(clientId, resolvedTokens.refreshToken, fetcher);
            return { accessToken: refreshed.accessToken, tokens: refreshed };
        },
        getValidDropboxAccessToken: async (clientId, fetcher = defaultFetcher) => {
            requireDropboxClientId(clientId);
            const stored = await getStoredDropboxTokens();
            if (!stored) {
                throw new Error('Dropbox is not connected');
            }

            if (now() < stored.expiresAt - DROPBOX_ACCESS_TOKEN_REFRESH_SKEW_MS) {
                return stored.accessToken;
            }

            const refreshed = await refreshDropboxAccessToken(clientId, stored.refreshToken, fetcher);
            return refreshed.accessToken;
        },
        forceRefreshDropboxAccessToken: async (clientId, fetcher = defaultFetcher) => {
            requireDropboxClientId(clientId);
            const stored = await getStoredDropboxTokens();
            if (!stored) {
                throw new Error('Dropbox is not connected');
            }
            const refreshed = await refreshDropboxAccessToken(clientId, stored.refreshToken, fetcher);
            return refreshed.accessToken;
        },
        revokeDropboxTokens,
        disconnectDropbox: async (clientId, fetcher = defaultFetcher, beforeMutation) => {
            requireDropboxClientId(clientId);
            const stored = await getStoredDropboxTokens(beforeMutation);
            if (!stored) {
                await clearDropboxTokens(beforeMutation);
                return;
            }

            try {
                await revokeDropboxTokens(clientId, stored, fetcher);
            } finally {
                await clearDropboxTokens(beforeMutation);
            }
        },
    };
};
