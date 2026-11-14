import { describe, expect, it, vi } from 'vitest';

import {
    DROPBOX_ACCESS_TOKEN_REFRESH_SKEW_MS,
    DROPBOX_ASYNC_TOKENS_KEY,
    DROPBOX_SECURESTORE_TOKENS_KEY,
    createDropboxTokenStore,
    isDropboxClientConfigured,
    type DropboxAuthTokens,
} from './dropbox-auth-tokens';
import { createSyncSecretVault, type SyncSecretAccessibility } from './sync-secret-storage';

const tokens: DropboxAuthTokens = {
    accessToken: 'dropbox-access',
    refreshToken: 'dropbox-refresh',
    expiresAt: 1_000_000,
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
});

const createStore = (options: { available?: boolean; fetch?: typeof fetch; now?: number } = {}) => {
    const plain = new Map<string, string>();
    const secure = new Map<string, { value: string; accessibility: SyncSecretAccessibility }>();
    const clock = { now: options.now ?? 0 };
    const secrets = {
        isAvailable: async () => options.available ?? true,
        getItem: async (key: string) => secure.get(key)?.value ?? null,
        setItem: async (key: string, value: string, accessibility: SyncSecretAccessibility) => {
            secure.set(key, { value, accessibility });
        },
        deleteItem: async (key: string) => {
            secure.delete(key);
        },
    };
    const storage = {
        getItem: vi.fn(async (key: string) => plain.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => {
            plain.set(key, value);
        }),
        removeItem: vi.fn(async (key: string) => {
            plain.delete(key);
        }),
    };
    const fetcher = vi.fn(options.fetch ?? (async () => jsonResponse({ access_token: 'refreshed', expires_in: 14_400 })));
    const store = createDropboxTokenStore({
        storage,
        secrets,
        vault: createSyncSecretVault(secrets),
        fetch: fetcher as unknown as typeof fetch,
        now: () => clock.now,
    });
    return { plain, secure, clock, storage, fetcher, store };
};

describe('Dropbox token storage', () => {
    it('stores the sanitized bundle in the keystore when-unlocked and reads it back', async () => {
        const { secure, plain, store } = createStore();
        plain.set(DROPBOX_ASYNC_TOKENS_KEY, 'stale');

        await store.saveDropboxTokens({ ...tokens, accessToken: '  dropbox-access  ' });

        expect(secure.get(DROPBOX_SECURESTORE_TOKENS_KEY)).toEqual({
            value: JSON.stringify(tokens),
            accessibility: 'when-unlocked',
        });
        expect(plain.has(DROPBOX_ASYNC_TOKENS_KEY)).toBe(false);
        await expect(store.getStoredDropboxTokens()).resolves.toEqual(tokens);
        await expect(store.isDropboxConnected()).resolves.toBe(true);
    });

    it('migrates a legacy plaintext bundle into the keystore on read', async () => {
        const { secure, plain, store } = createStore();
        plain.set(DROPBOX_ASYNC_TOKENS_KEY, JSON.stringify(tokens));

        await expect(store.getStoredDropboxTokens()).resolves.toEqual(tokens);

        expect(secure.get(DROPBOX_SECURESTORE_TOKENS_KEY)?.value).toBe(JSON.stringify(tokens));
        expect(plain.has(DROPBOX_ASYNC_TOKENS_KEY)).toBe(false);
    });

    it('keeps the bundle in memory only when the keystore is unsupported', async () => {
        const { secure, storage, store } = createStore({ available: false });

        await store.saveDropboxTokens(tokens);

        expect(storage.setItem).not.toHaveBeenCalled();
        expect(secure.size).toBe(0);
        await expect(store.getStoredDropboxTokens()).resolves.toEqual(tokens);
        await store.clearDropboxTokens();
        await expect(store.getStoredDropboxTokens()).resolves.toBeNull();
    });

    it('rejects an invalid bundle and reads a corrupt one as not connected', async () => {
        const { secure, store } = createStore();

        await expect(store.saveDropboxTokens({ ...tokens, refreshToken: ' ' })).rejects.toThrow('Invalid Dropbox token payload');
        secure.set(DROPBOX_SECURESTORE_TOKENS_KEY, { value: '{not json', accessibility: 'when-unlocked' });
        await expect(store.getStoredDropboxTokens()).resolves.toBeNull();
        await expect(store.isDropboxConnected()).resolves.toBe(false);
    });
});

describe('Dropbox access token refresh', () => {
    it('returns the stored token until one minute before expiry, then refreshes and stores', async () => {
        const { store, fetcher, clock } = createStore();
        await store.saveDropboxTokens(tokens);

        clock.now = tokens.expiresAt - DROPBOX_ACCESS_TOKEN_REFRESH_SKEW_MS - 1;
        await expect(store.getValidDropboxAccessToken('app-key')).resolves.toBe('dropbox-access');
        expect(fetcher).not.toHaveBeenCalled();

        clock.now = tokens.expiresAt - DROPBOX_ACCESS_TOKEN_REFRESH_SKEW_MS;
        await expect(store.getValidDropboxAccessToken('app-key')).resolves.toBe('refreshed');
        expect(fetcher).toHaveBeenCalledTimes(1);
        const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.dropboxapi.com/oauth2/token');
        expect(String(init.body)).toBe('grant_type=refresh_token&refresh_token=dropbox-refresh&client_id=app-key');
        await expect(store.getStoredDropboxTokens()).resolves.toEqual({
            accessToken: 'refreshed',
            refreshToken: 'dropbox-refresh',
            expiresAt: clock.now + 14_400 * 1000,
        });
    });

    it('refreshes an explicit bundle without touching storage', async () => {
        const { store, storage } = createStore({ now: 5 });

        const resolution = await store.forceRefreshDropboxAccessTokenForTokens('app-key', tokens);

        expect(resolution).toEqual({
            accessToken: 'refreshed',
            tokens: { accessToken: 'refreshed', refreshToken: 'dropbox-refresh', expiresAt: 5 + 14_400 * 1000 },
        });
        expect(storage.setItem).not.toHaveBeenCalled();
        await expect(store.getStoredDropboxTokens()).resolves.toBeNull();
    });

    it('reports the provider error and rejects an invalid refresh response', async () => {
        const failing = createStore({ fetch: async () => jsonResponse({ error_summary: 'invalid_grant/' }, 400) });
        await expect(failing.store.forceRefreshDropboxAccessTokenForTokens('app-key', tokens))
            .rejects.toThrow('Dropbox token refresh failed: invalid_grant/');

        const invalid = createStore({ fetch: async () => jsonResponse({ access_token: 'x', expires_in: 0 }) });
        await expect(invalid.store.forceRefreshDropboxAccessTokenForTokens('app-key', tokens))
            .rejects.toThrow('Dropbox token refresh returned an invalid response');
    });

    it('needs a client id and stored tokens', async () => {
        const { store } = createStore();
        expect(isDropboxClientConfigured('  ')).toBe(false);
        await expect(store.getValidDropboxAccessToken(' ')).rejects.toThrow('Dropbox app key is not configured');
        await expect(store.getValidDropboxAccessToken('app-key')).rejects.toThrow('Dropbox is not connected');
    });

    it('disconnect clears stored tokens even when the revoke request fails', async () => {
        const { store, fetcher } = createStore({
            fetch: async () => {
                throw new Error('offline');
            },
        });
        await store.saveDropboxTokens(tokens);

        await store.disconnectDropbox('app-key');

        expect(fetcher).toHaveBeenCalledWith('https://api.dropboxapi.com/2/auth/token/revoke', expect.objectContaining({
            headers: { Authorization: 'Bearer dropbox-access' },
        }));
        await expect(store.getStoredDropboxTokens()).resolves.toBeNull();
    });

    it('disconnect with an expired access token refreshes once and revokes the grant, then clears the tokens', async () => {
        const calls: Array<{ url: string; authorization?: string }> = [];
        const { store } = createStore({
            fetch: (async (url: string, init?: RequestInit) => {
                const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
                calls.push({ url, authorization });
                if (url.endsWith('/oauth2/token')) return jsonResponse({ access_token: 'fresh-access', expires_in: 14_400 });
                return authorization === 'Bearer fresh-access' ? new Response('null') : jsonResponse({ error_summary: 'expired_access_token/' }, 401);
            }) as unknown as typeof fetch,
        });
        await store.saveDropboxTokens(tokens);

        await store.disconnectDropbox('app-key');

        expect(calls).toEqual([
            { url: 'https://api.dropboxapi.com/2/auth/token/revoke', authorization: 'Bearer dropbox-access' },
            { url: 'https://api.dropboxapi.com/oauth2/token', authorization: undefined },
            { url: 'https://api.dropboxapi.com/2/auth/token/revoke', authorization: 'Bearer fresh-access' },
        ]);
        await expect(store.getStoredDropboxTokens()).resolves.toBeNull();
    });

    it('disconnect still clears the tokens when the refresh token is already revoked', async () => {
        const { store, fetcher } = createStore({
            fetch: (async (url: string) => (url.endsWith('/oauth2/token')
                ? jsonResponse({ error: 'invalid_grant', error_description: 'refresh token is invalid or revoked' }, 400)
                : jsonResponse({ error_summary: 'expired_access_token/' }, 401))) as unknown as typeof fetch,
        });
        await store.saveDropboxTokens(tokens);

        await store.disconnectDropbox('app-key');

        expect(fetcher).toHaveBeenCalledTimes(2);
        await expect(store.getStoredDropboxTokens()).resolves.toBeNull();
    });
});
