import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import {
    deleteSessionSecret,
    evacuateLegacySecretToSession,
    getSessionSecret,
    isSecureStoreAvailable,
    setSessionSecret,
} from './secure-secret-store';
import { backgroundSafeFetch } from './background-safe-fetch';

const DROPBOX_SECURESTORE_TOKENS_KEY = 'mindwtr_dropbox_tokens';
const DROPBOX_ASYNC_TOKENS_KEY = '@mindwtr_dropbox_tokens';
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

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

const readRawTokenPayload = async (): Promise<string | null> => {
    if (await isSecureStoreAvailable()) {
        const secureValue = await SecureStore.getItemAsync(DROPBOX_SECURESTORE_TOKENS_KEY);
        if (secureValue) {
            await AsyncStorage.removeItem(DROPBOX_ASYNC_TOKENS_KEY);
            return secureValue;
        }

        const legacyValue = await AsyncStorage.getItem(DROPBOX_ASYNC_TOKENS_KEY);
        if (legacyValue !== null) {
            await SecureStore.setItemAsync(DROPBOX_SECURESTORE_TOKENS_KEY, legacyValue, {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            });
            await AsyncStorage.removeItem(DROPBOX_ASYNC_TOKENS_KEY);
        }
        return legacyValue;
    }

    const sessionValue = getSessionSecret(DROPBOX_SECURESTORE_TOKENS_KEY);
    if (sessionValue !== null) return sessionValue;

    const legacyValue = await AsyncStorage.getItem(DROPBOX_ASYNC_TOKENS_KEY);
    if (legacyValue !== null) {
        await evacuateLegacySecretToSession(
            DROPBOX_SECURESTORE_TOKENS_KEY,
            legacyValue,
            () => AsyncStorage.removeItem(DROPBOX_ASYNC_TOKENS_KEY),
        );
    }
    return legacyValue;
};

const writeRawTokenPayload = async (value: string): Promise<void> => {
    if (await isSecureStoreAvailable()) {
        await SecureStore.setItemAsync(DROPBOX_SECURESTORE_TOKENS_KEY, value, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        await AsyncStorage.removeItem(DROPBOX_ASYNC_TOKENS_KEY);
        deleteSessionSecret(DROPBOX_SECURESTORE_TOKENS_KEY);
        return;
    }

    await AsyncStorage.removeItem(DROPBOX_ASYNC_TOKENS_KEY);
    setSessionSecret(DROPBOX_SECURESTORE_TOKENS_KEY, value);
};

const clearRawTokenPayload = async (): Promise<void> => {
    if (await isSecureStoreAvailable()) {
        await SecureStore.deleteItemAsync(DROPBOX_SECURESTORE_TOKENS_KEY);
    }
    await AsyncStorage.removeItem(DROPBOX_ASYNC_TOKENS_KEY);
    deleteSessionSecret(DROPBOX_SECURESTORE_TOKENS_KEY);
};

const requireDropboxClientId = (clientId: string): string => {
    const trimmed = clientId.trim();
    if (!trimmed) {
        throw new Error('Dropbox app key is not configured');
    }
    return trimmed;
};

export const isDropboxClientConfigured = (clientId: string): boolean => clientId.trim().length > 0;

export async function getStoredDropboxTokens(): Promise<DropboxAuthTokens | null> {
    const raw = await readRawTokenPayload();
    if (!raw) return null;
    try {
        return sanitizeTokens(JSON.parse(raw));
    } catch {
        return null;
    }
}

export async function saveDropboxTokens(tokens: DropboxAuthTokens): Promise<void> {
    const sanitized = sanitizeTokens(tokens);
    if (!sanitized) {
        throw new Error('Invalid Dropbox token payload');
    }
    await writeRawTokenPayload(JSON.stringify(sanitized));
}

export async function clearDropboxTokens(): Promise<void> {
    await clearRawTokenPayload();
}

export async function isDropboxConnected(): Promise<boolean> {
    const tokens = await getStoredDropboxTokens();
    return Boolean(tokens?.refreshToken && tokens.accessToken);
}

const requestDropboxAccessToken = async (
    clientId: string,
    refreshToken: string,
    fetcher: typeof fetch = backgroundSafeFetch
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
        expiresAt: Date.now() + expiresIn * 1000,
    };
};

export async function refreshDropboxAccessToken(
    clientId: string,
    refreshToken: string,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<DropboxAuthTokens> {
    const tokens = await requestDropboxAccessToken(clientId, refreshToken, fetcher);
    await saveDropboxTokens(tokens);
    return tokens;
}

const requireDropboxTokens = (tokens: DropboxAuthTokens): DropboxAuthTokens => {
    const sanitized = sanitizeTokens(tokens);
    if (!sanitized) {
        throw new Error('Dropbox is not connected');
    }
    return sanitized;
};

/** Resolve an access token from an explicit credential bundle without touching storage. */
export async function getValidDropboxAccessTokenForTokens(
    clientId: string,
    tokens: DropboxAuthTokens,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<DropboxAccessTokenResolution> {
    requireDropboxClientId(clientId);
    const resolvedTokens = requireDropboxTokens(tokens);
    if (Date.now() < resolvedTokens.expiresAt - ACCESS_TOKEN_REFRESH_SKEW_MS) {
        return { accessToken: resolvedTokens.accessToken, tokens: resolvedTokens };
    }

    const refreshed = await requestDropboxAccessToken(clientId, resolvedTokens.refreshToken, fetcher);
    return { accessToken: refreshed.accessToken, tokens: refreshed };
}

/** Force-refresh an explicit credential bundle without promoting it to storage. */
export async function forceRefreshDropboxAccessTokenForTokens(
    clientId: string,
    tokens: DropboxAuthTokens,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<DropboxAccessTokenResolution> {
    requireDropboxClientId(clientId);
    const resolvedTokens = requireDropboxTokens(tokens);
    const refreshed = await requestDropboxAccessToken(clientId, resolvedTokens.refreshToken, fetcher);
    return { accessToken: refreshed.accessToken, tokens: refreshed };
}

export async function getValidDropboxAccessToken(
    clientId: string,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<string> {
    requireDropboxClientId(clientId);
    const stored = await getStoredDropboxTokens();
    if (!stored) {
        throw new Error('Dropbox is not connected');
    }

    if (Date.now() < stored.expiresAt - ACCESS_TOKEN_REFRESH_SKEW_MS) {
        return stored.accessToken;
    }

    const refreshed = await refreshDropboxAccessToken(clientId, stored.refreshToken, fetcher);
    return refreshed.accessToken;
}

export async function forceRefreshDropboxAccessToken(
    clientId: string,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<string> {
    requireDropboxClientId(clientId);
    const stored = await getStoredDropboxTokens();
    if (!stored) {
        throw new Error('Dropbox is not connected');
    }
    const refreshed = await refreshDropboxAccessToken(clientId, stored.refreshToken, fetcher);
    return refreshed.accessToken;
}

/** Revoke an explicit token bundle without reading or clearing durable credentials. */
export async function revokeDropboxTokens(
    clientId: string,
    tokens: DropboxAuthTokens,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<void> {
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
        // Disconnect must still remove the local candidate when revoke is offline.
    }
}

export async function disconnectDropbox(clientId: string, fetcher: typeof fetch = fetch): Promise<void> {
    requireDropboxClientId(clientId);
    const stored = await getStoredDropboxTokens();
    if (!stored) {
        await clearDropboxTokens();
        return;
    }

    try {
        await revokeDropboxTokens(clientId, stored, fetcher);
    } finally {
        await clearDropboxTokens();
    }
}
