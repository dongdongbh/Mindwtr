import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';
import { createSyncSecretVault } from '../../../packages/core/src/sync-secret-storage';
import { createNativeIosDropbox, readNativeIosDropboxConfiguration } from './host-ios-dropbox';

test('foreground Connect forwards its original public UUID to the strict native owner and retires it on exit', async () => {
    const source = readFileSync(join(import.meta.dir, 'host-entry.ts'), 'utf8');
    const capabilityStart = source.indexOf('let iosDropboxControl:');
    const capabilityEnd = source.indexOf('const ensureIosManualSync', capabilityStart);
    const methodStart = source.indexOf('    iosForegroundSync(name:');
    const methodEnd = source.indexOf('    gettingStartedOutcome(json: string): string {', methodStart);
    expect([capabilityStart, capabilityEnd, methodStart, methodEnd].every(value => value >= 0)).toBe(true);
    const original = '00000000-0000-4000-8000-000000009703';
    const configuration = { version: 1 as const, clientId: 'PublicTest123', redirectUri: 'mindwtr-native-dev://redirect' as const };
    let nativeCalls = 0, tokenCalls = 0;
    const secrets = { isAvailable: async () => true, getItem: async () => null,
        setItem: async () => { throw new Error('Unapproved token promotion'); }, deleteItem: async () => { throw new Error('Unapproved token delete'); } };
    const sandbox = createContext({ TextEncoder, AbortController, JSON, Error,
        readNativeIosDropboxConfiguration, __mindwtrHostPlatform: 'ios', __mindwtrSyncSecrets: {},
        __mindwtrDropboxCall: async (request: { version: number; requestId: string }) => {
            nativeCalls++;
            expect(Object.keys(request).sort()).toEqual(['requestId', 'version']);
            if (request.requestId !== original) throw new Error('Native captured Connect UUID mismatch');
            return { ...configuration, requestId: original, code: 'synthetic-code', codeVerifier: 'v'.repeat(43) };
        },
        submit: (work: (signal: AbortSignal) => Promise<unknown>) => work(new AbortController().signal),
        localAttachments: {}, nativeSync: null, bootAdapter: {}, iosForegroundFailure: null,
        iosCleanupCallback: null, iosTaskAttachmentPreparation: false, iosProjectFilePreparation: false,
        isSandboxMode: () => false, isWorkspaceTransitionActive: () => false, native: () => ({ kvMultiGet: () => '' }),
        iosCloudKitAvailable: () => false, requireSaved: () => undefined, getPersistenceStatus: () => ({}),
        keyValue: { get: async () => 'off' }, SYNC_BACKEND_KEY: 'backend', CLOUD_PROVIDER_KEY: 'provider',
        isNativeIosSelfHostedProvider: () => false, contract: {},
        iosManualSync: { settingsHost: { encryption: { mode: 'saved-webdav-or-local' } } },
        ensureIosManualSync: () => undefined, diagnosticsLog: { append: async () => undefined },
        NativeAttachmentCleanupUnconfirmedError: class extends Error {}, MENU_COMMANDS: {},
    });
    const program = source.slice(capabilityStart, capabilityEnd) + '\n' +
        'globalThis.entryCapability = iosDropboxCapability; globalThis.entry = {' + source.slice(methodStart, methodEnd) + '};';
    runInContext((await transform(program, { loader: 'ts', target: 'es2022' })).code, sandbox);
    const binding = createNativeIosDropbox(sandbox.entryCapability, { storage: {
        getItem: async () => null, setItem: async () => { throw new Error('Unapproved legacy write'); }, removeItem: async () => undefined,
    }, secrets, vault: createSyncSecretVault(secrets), fetch: async () => { tokenCalls++;
        return new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 })); } });
    expect(binding).toBeNull();
    sandbox.MENU_COMMANDS.connectDropbox = async () => {
        const owned = createNativeIosDropbox(sandbox.entryCapability, { storage: {
            getItem: async () => null, setItem: async () => { throw new Error('Unapproved legacy write'); }, removeItem: async () => undefined,
        }, secrets, vault: createSyncSecretVault(secrets), fetch: async () => { tokenCalls++;
            return new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 })); } });
        await expect(owned!.settings.authorize(configuration.clientId)).resolves.toMatchObject({ accessToken: 'synthetic-access' });
        return { ok: true, value: { connected: true } };
    };
    const control = (json: string) => { const request = JSON.parse(json);
        expect(Object.keys(request)).toEqual(['phase']);
        return JSON.stringify(request.phase === 'configuration' ? configuration : { current: true }); };
    const answer = await sandbox.entry.iosForegroundSync('connectDropbox', JSON.stringify({ requestId: original }), () => '{}', undefined, control);
    expect(answer).toEqual({ ok: true, value: { connected: true } });
    expect(nativeCalls).toBe(1); expect(tokenCalls).toBe(1);
    expect(() => sandbox.entryCapability.authorizationRequestId()).toThrow('current foreground owner');
});
