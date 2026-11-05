import { createDropboxTokenStore, isDropboxUnauthorizedError, testDropboxAccess,
    type DropboxAuthTokens, type DropboxTokenStoreDeps, type SyncSettingsDropboxPort, type MobileSyncDropboxAuthPort } from '@mindwtr/core';
export type NativeIosDropboxConfiguration = { version: 1; clientId: string; redirectUri: 'mindwtr-native-dev://redirect' };
export type NativeIosDropboxGrant = NativeIosDropboxConfiguration & { requestId: string; code: string; codeVerifier: string };
export type NativeIosDropboxCapability = {
    configuration(): NativeIosDropboxConfiguration | null;
    assertCurrent(): void;
    authorizationRequestId(): string;
    authorize(request: { version: 1; requestId: string }): Promise<unknown>;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(v, field));
const bytes = (v: unknown, maximum: number) => { try { return new TextEncoder().encode(JSON.stringify(v)).length <= maximum; } catch { return false; } };
export const readNativeIosDropboxConfiguration = (v: unknown): NativeIosDropboxConfiguration | null => record(v)
    && exact(v, ['version', 'clientId', 'redirectUri']) && v.version === 1 && typeof v.clientId === 'string' && /^[A-Za-z0-9]{1,512}$/.test(v.clientId)
    && v.redirectUri === 'mindwtr-native-dev://redirect' ? v as NativeIosDropboxConfiguration : null;
const unavailable = () => new Error('Dropbox authorization is unavailable for this foreground owner');
export const createNativeIosDropbox = (capability: NativeIosDropboxCapability, deps: DropboxTokenStoreDeps) => {
    const configuration = readNativeIosDropboxConfiguration(capability.configuration());
    if (!configuration) return null;
    const current = () => { capability.assertCurrent(); const actual = readNativeIosDropboxConfiguration(capability.configuration());
        if (!actual || actual.clientId !== configuration.clientId || actual.redirectUri !== configuration.redirectUri) throw unavailable(); };
    const ownedFetch = (send: typeof fetch): typeof fetch => (async (input, init) => { current(); const response = await send(input, { ...init, redirect: 'error' }); current(); return response; }) as typeof fetch;
    const store = createDropboxTokenStore({ ...deps, fetch: ownedFetch(deps.fetch) });
    const owned = async <T>(operation: () => Promise<T>): Promise<T> => { current(); const result = await operation(); current(); return result; };
    const client = (id: string) => { current(); if (id !== configuration.clientId) throw unavailable(); };
    const resolveStored = (force: boolean, id: string, fetcher = deps.fetch) => owned(async () => {
        client(id); const before = await store.getStoredDropboxTokens(current); current(); if (!before) throw new Error('Dropbox is not connected');
        const result = await (force ? store.forceRefreshDropboxAccessTokenForTokens : store.getValidDropboxAccessTokenForTokens)(id, before, ownedFetch(fetcher));
        current(); if (result.tokens !== before && JSON.stringify(result.tokens) !== JSON.stringify(before)) await store.saveDropboxTokens(result.tokens, current);
        return result.accessToken;
    });
    const authorize = async (id: string): Promise<DropboxAuthTokens> => owned(async () => {
        client(id); const requestId = capability.authorizationRequestId();
        if (typeof requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId)) throw unavailable();
        const raw = await capability.authorize({ version: 1, requestId }); current();
        if (!record(raw) || !bytes(raw, 16_384) || !exact(raw, ['version', 'requestId', 'clientId', 'redirectUri', 'code', 'codeVerifier'])
            || raw.version !== 1 || raw.requestId !== requestId || raw.clientId !== id || raw.redirectUri !== configuration.redirectUri
            || typeof raw.code !== 'string' || !raw.code || new TextEncoder().encode(raw.code).length > 8192
            || typeof raw.codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(raw.codeVerifier)) throw unavailable();
        const response = await ownedFetch(deps.fetch)('https://api.dropboxapi.com/oauth2/token', { method: 'POST', redirect: 'error',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code',
                client_id: id, code: raw.code, redirect_uri: configuration.redirectUri, code_verifier: raw.codeVerifier }).toString() });
        const text = await response.text(); current(); if (!response.ok || new TextEncoder().encode(text).length > 65_536) throw new Error('Dropbox token exchange failed');
        let value: unknown; try { value = JSON.parse(text); } catch { throw new Error('Dropbox token exchange returned an invalid response'); }
        if (!record(value)) throw new Error('Dropbox token exchange returned an invalid response');
        const accessToken = typeof value.access_token === 'string' ? value.access_token.trim() : '', refreshToken = typeof value.refresh_token === 'string' ? value.refresh_token.trim() : '';
        const expiresIn = value.expires_in === undefined ? 4 * 60 * 60 : Number(value.expires_in), expiresAt = (deps.now?.() ?? Date.now()) + expiresIn * 1000;
        if (!accessToken || !refreshToken || new TextEncoder().encode(accessToken).length > 16_384 || new TextEncoder().encode(refreshToken).length > 16_384
            || !Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isFinite(expiresAt)) throw new Error('Dropbox token exchange returned an invalid response');
        return { accessToken, refreshToken, expiresAt };
    });
    const auth: MobileSyncDropboxAuthPort = {
        isConnected: () => owned(() => store.isDropboxConnected(current)),
        getValidAccessToken: (id, send) => resolveStored(false, id, send), forceRefreshAccessToken: (id, send) => resolveStored(true, id, send),
        getValidAccessTokenForTokens: (id, tokens, send) => owned(() => { client(id); return store.getValidDropboxAccessTokenForTokens(id, tokens, ownedFetch(send)); }),
        forceRefreshAccessTokenForTokens: (id, tokens, send) => owned(() => { client(id); return store.forceRefreshDropboxAccessTokenForTokens(id, tokens, ownedFetch(send)); }),
    };
    const runAuthorized = async <T>(id: string, operation: (token: string) => Promise<T>): Promise<T> => {
        const token = await resolveStored(false, id); try { return await owned(() => operation(token)); }
        catch (error) { if (!isDropboxUnauthorizedError(error)) throw error; const refreshed = await resolveStored(true, id); return owned(() => operation(refreshed)); }
    };
    const settings: SyncSettingsDropboxPort = {
        authorize, redirectUri: () => configuration.redirectUri, isConnected: auth.isConnected,
        getStoredTokens: () => owned(() => store.getStoredDropboxTokens(current)),
        saveTokens: store.saveDropboxTokens, clearTokens: store.clearDropboxTokens,
        disconnect: id => owned(() => { client(id); return store.disconnectDropbox(id, ownedFetch(deps.fetch), current); }),
        revokeTokens: (id, tokens) => owned(() => { client(id); return store.revokeDropboxTokens(id, tokens, ownedFetch(deps.fetch)); }),
        getValidAccessToken: id => resolveStored(false, id), forceRefreshAccessToken: id => resolveStored(true, id),
        getValidAccessTokenForTokens: (id, tokens) => auth.getValidAccessTokenForTokens(id, tokens, deps.fetch),
        forceRefreshAccessTokenForTokens: (id, tokens) => auth.forceRefreshAccessTokenForTokens(id, tokens, deps.fetch),
        testAccess: token => owned(() => testDropboxAccess(token, ownedFetch(deps.fetch))),
    };
    return { configuration, auth, settings, assertCurrent: current, runAuthorized };
};
