import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    createDropboxTokenStore,
    type DropboxAccessTokenResolution,
    type DropboxAuthTokens,
    type DropboxTokenStore,
} from '@mindwtr/core/dropbox-auth-tokens';

import { secureSecretStorage, secureSecretVault } from './secure-secret-store';
import { backgroundSafeFetch } from './background-safe-fetch';


export { isDropboxClientConfigured } from '@mindwtr/core/dropbox-auth-tokens';
export type { DropboxAccessTokenResolution, DropboxAuthTokens };

const tokenStore: DropboxTokenStore = createDropboxTokenStore({
    storage: {
        getItem: (key) => AsyncStorage.getItem(key),
        setItem: (key, value) => AsyncStorage.setItem(key, value),
        removeItem: (key) => AsyncStorage.removeItem(key),
    },
    secrets: secureSecretStorage,
    vault: secureSecretVault,
    fetch: (input, init) => backgroundSafeFetch(input, init),
});

export async function getStoredDropboxTokens(): Promise<DropboxAuthTokens | null> {
    return tokenStore.getStoredDropboxTokens();
}

export async function saveDropboxTokens(tokens: DropboxAuthTokens): Promise<void> {
    return tokenStore.saveDropboxTokens(tokens);
}

export async function clearDropboxTokens(): Promise<void> {
    return tokenStore.clearDropboxTokens();
}

export async function isDropboxConnected(): Promise<boolean> {
    return tokenStore.isDropboxConnected();
}

export async function refreshDropboxAccessToken(
    clientId: string,
    refreshToken: string,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<DropboxAuthTokens> {
    return tokenStore.refreshDropboxAccessToken(clientId, refreshToken, fetcher);
}


export async function getValidDropboxAccessTokenForTokens(
    clientId: string,
    tokens: DropboxAuthTokens,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<DropboxAccessTokenResolution> {
    return tokenStore.getValidDropboxAccessTokenForTokens(clientId, tokens, fetcher);
}


export async function forceRefreshDropboxAccessTokenForTokens(
    clientId: string,
    tokens: DropboxAuthTokens,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<DropboxAccessTokenResolution> {
    return tokenStore.forceRefreshDropboxAccessTokenForTokens(clientId, tokens, fetcher);
}

export async function getValidDropboxAccessToken(
    clientId: string,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<string> {
    return tokenStore.getValidDropboxAccessToken(clientId, fetcher);
}

export async function forceRefreshDropboxAccessToken(
    clientId: string,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<string> {
    return tokenStore.forceRefreshDropboxAccessToken(clientId, fetcher);
}


export async function revokeDropboxTokens(
    clientId: string,
    tokens: DropboxAuthTokens,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<void> {
    return tokenStore.revokeDropboxTokens(clientId, tokens, fetcher);
}

export async function disconnectDropbox(
    clientId: string,
    fetcher: typeof fetch = backgroundSafeFetch
): Promise<void> {
    return tokenStore.disconnectDropbox(clientId, fetcher);
}
