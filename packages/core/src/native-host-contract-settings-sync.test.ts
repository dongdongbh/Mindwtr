import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { NATIVE_UNJOURNALED_COMMANDS } from './native-request-receipts';
import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';
import { en } from './i18n/locales/en';
import {
    createSyncSettingsMethods,
    NATIVE_SYNC_SETTINGS_UNJOURNALED_COMMANDS,
    SYNC_ENCRYPTION_PASSPHRASE_MAX_LENGTH,
    type NativeSyncEncryptionAction,
    type NativeSyncSettings,
    type NativeSyncSettingsHost,
    type NativeSyncWebDavFields,
} from './native-host-contract-settings-sync';
import { flushPendingSave, getPersistenceStatus, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { SyncEncryptionCleanupDeferredError } from './sync-encryption-service';
import {
    CLOUD_PROVIDER_KEY,
    CLOUD_TOKEN_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_KEY,
    WEBDAV_PASSWORD_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from './sync-storage-keys';
import type { SyncEncryptionState } from './sync-encryption';
import type { AppSettings, Project, Task } from './types';
import { generateUUID } from './uuid';

/**
 * The frozen React Native Settings › Sync screen (sync-settings-parity.fixtures.json,
 * captured by apps/mobile/components/settings/sync-settings-screen.parity.test.tsx),
 * replayed through the native host contract. The replay plays the native screen: it
 * keeps the screen's own state (the form drafts, the encryption fields, which cards
 * are open), reads the view, sends each control's command, and lays the view out in
 * the order React Native draws it. The device answers from the scenario's queues
 * exactly as the React Native harness's stubs do.
 */

const device = vi.hoisted(() => ({
    queues: {} as Record<string, unknown[]>,
    held: [] as (() => void)[],
    holdStarted: null as null | (() => void),
    calls: [] as unknown[][],
    /** What the host's error log received. */
    logged: [] as string[],
    encryption: { state: 'off' as string, unavailable: false, pending: false, incomplete: null as string | null, partly: false },
}));

/** The next answer for `name`, or `fallback` when the scenario queued none. */
const next = (name: string, fallback: unknown) => {
    const queue = device.queues[name];
    return queue && queue.length > 0 ? queue.shift() : fallback;
};

const hold = () => new Promise<void>((resolve) => {
    device.held.push(resolve);
    device.holdStarted?.();
});

/** The React Native harness's `answer`: a string answers itself, `{ error }` rejects, `{ value }` answers, 'hold' waits. */
const answer = async (name: string, fallback: unknown): Promise<any> => {
    const entry = next(name, fallback);
    if (entry === 'hold') {
        await hold();
        return answer(name, fallback);
    }
    if (entry && typeof entry === 'object' && 'encryption' in entry) device.encryption.state = String((entry as { encryption: string }).encryption);
    if (entry && typeof entry === 'object' && 'error' in entry) throw new Error(String((entry as { error: string }).error));
    if (entry && typeof entry === 'object' && 'value' in entry) return (entry as { value: unknown }).value;
    return entry;
};

vi.mock('./webdav', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./webdav')>()),
    probeWebdavSyncCompatibility: async (url: string, options: Record<string, unknown>, policy?: { requireStrongEtag?: boolean }) => {
        device.calls.push(['probeWebdav', url, {
            username: options.username, password: options.password, timeoutMs: options.timeoutMs,
            requireStrongEtag: policy?.requireStrongEtag ?? null,
        }]);
        return answer('probe', 'strong-etag');
    },
}));
vi.mock('./cloud', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./cloud')>()),
    cloudGetJson: async (url: string, options: Record<string, unknown>) => {
        device.calls.push(['cloudGetJson', url, { token: options.token, timeoutMs: options.timeoutMs }]);
        return answer('cloudGet', {});
    },
}));

type Device = {
    language?: string;
    os?: 'android' | 'ios';
    foss?: boolean;
    dropboxAppKey?: string;
    cloudKitStatus?: string;
    storage?: Record<string, string>;
    secrets?: Record<string, string>;
    dropboxConnected?: boolean;
    unlockOnly?: boolean;
    encryption?: { state?: SyncEncryptionState; unavailable?: boolean; pending?: boolean; incomplete?: string | null; partly?: boolean };
    queues?: Record<string, unknown[]>;
};
type Scenario = { name: string; settings: string; data?: 'none' | 'titles'; device: Device; actions: [string, ...unknown[]][] };
type Fixture = {
    now: string;
    timeZone: string;
    deviceLocale: string;
    tasks: Task[];
    projects: Project[];
    settings: Record<string, AppSettings>;
    scenarios: Scenario[];
    observations: Record<string, Record<string, unknown>[]>;
};
type Host = ReturnType<typeof createNativeHostContract>;

const fixture: Fixture = JSON.parse(readFileSync(new URL('./sync-settings-parity.fixtures.json', import.meta.url), 'utf8'));

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const normalize = (entry: unknown): unknown => JSON.parse(JSON.stringify(entry, (_key, item) => (item === undefined ? '<undefined>' : item)));

// ---------------------------------------------------------------------------
// The store: the fixture's data, with settings writes recorded as the harness records them.

const writes: unknown[][] = [];
let realUpdateSettings: ((...args: unknown[]) => Promise<unknown>) | null = null;

async function seed(settings: AppSettings, titled: boolean) {
    await flushPendingSave();
    resetForTests();
    realUpdateSettings ??= useTaskStore.getState().updateSettings as never;
    const real = realUpdateSettings!;
    let data = JSON.parse(JSON.stringify({
        tasks: titled ? fixture.tasks : [], projects: titled ? fixture.projects : [], sections: [], areas: [], people: [], settings,
    }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (nextData) => {
            data = JSON.parse(JSON.stringify(nextData));
        },
    });
    useTaskStore.setState({
        updateSettings: real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    useTaskStore.setState({
        updateSettings: async (...args: unknown[]) => {
            writes.push(['updateSettings', ...(normalize(args) as unknown[])]);
            return real(...args);
        },
    } as never);
    writes.length = 0;
}

// ---------------------------------------------------------------------------
// The device: RN's key-value store and secret store, and the stubs the harness has.

type DeviceState = {
    os: 'android' | 'ios';
    foss: boolean;
    dropboxAppKey: string;
    cloudKitStatus: string;
    storage: Map<string, string>;
    secrets: Map<string, string>;
    dropboxTokens: Record<string, unknown> | null;
    log: unknown[][];
    /** Keys whose writes fail, as a full or broken store does. */
    failKeys: Set<string>;
};

function createDevice(input: Device): { state: DeviceState; host: NativeSyncSettingsHost; apply: (patch: Device) => void } {
    const state: DeviceState = {
        os: 'android', foss: false, dropboxAppKey: '', cloudKitStatus: 'available',
        storage: new Map(Object.entries(input.storage ?? {})),
        secrets: new Map(Object.entries(input.secrets ?? {})),
        dropboxTokens: input.dropboxConnected
            ? { accessToken: 'stored-access', refreshToken: 'stored-refresh', expiresAt: 4_102_444_800_000 }
            : null,
        log: [],
        failKeys: new Set(),
    };
    device.encryption = { state: 'off', unavailable: false, pending: false, incomplete: null, partly: false };
    const apply = (patch: Device) => {
        if (patch.os !== undefined) state.os = patch.os;
        if (patch.foss !== undefined) state.foss = patch.foss;
        if (patch.dropboxAppKey !== undefined) state.dropboxAppKey = patch.dropboxAppKey;
        if (patch.cloudKitStatus !== undefined) state.cloudKitStatus = patch.cloudKitStatus;
        if (patch.encryption) Object.assign(device.encryption, patch.encryption);
    };
    apply(input);
    device.queues = JSON.parse(JSON.stringify(input.queues ?? {}));
    device.held.length = 0;
    device.calls.length = 0;
    device.logged.length = 0;
    const calls = device.calls;
    /** A transition: 'ok' moves the state to `after`, `{ cleanup }` commits it and defers the cleanup. */
    const transition = async (name: string, after: string, onProgress?: (progress: { phase: 'attachments' | 'documents'; completed: number; total: number }) => void): Promise<void> => {
        const entry = next(name, 'ok');
        if (entry === 'hold') {
            onProgress?.({ phase: 'attachments', completed: 2, total: 5 });
            await hold();
            return transition(name, after, onProgress);
        }
        if (entry && typeof entry === 'object' && 'cleanup' in entry) {
            device.encryption.state = after;
            const kind = (entry as { cleanup: string }).cleanup === 'file-lock' ? 'file-lock' : 'remote-fence';
            throw new SyncEncryptionCleanupDeferredError(undefined, new Error('cleanup'), 0, kind);
        }
        if (entry && typeof entry === 'object' && 'error' in entry) throw new Error(String((entry as { error: string }).error));
        device.encryption.state = after;
    };
    const host: NativeSyncSettingsHost = {
        platform: {
            get os() { return state.os; },
            get isFossBuild() { return state.foss; },
            get dropboxAppKey() { return state.dropboxAppKey; },
            get cloudKitAvailable() { return state.os === 'ios'; },
        },
        storage: {
            multiGet: async (keys) => keys.map((key) => [key, state.storage.get(key) ?? null] as const),
            setItem: async (key, entry) => {
                if (state.failKeys.has(key)) throw new Error('The device store refused the write');
                state.log.push(['setItem', key, entry]);
                state.storage.set(key, entry);
            },
            multiSet: async (entries) => {
                state.log.push(['multiSet', entries]);
                for (const [key, entry] of entries) state.storage.set(key, entry);
            },
            removeItem: async (key) => {
                state.log.push(['removeItem', key]);
                state.storage.delete(key);
            },
        },
        secrets: {
            get: async (key) => state.secrets.get(key) ?? null,
            set: async (key, entry) => {
                state.log.push(['setSecret', key, entry]);
                state.secrets.set(key, entry);
            },
            delete: async (key) => {
                state.log.push(['deleteSecret', key]);
                state.secrets.delete(key);
            },
        },
        performSync: async (syncPath, options) => {
            calls.push(['performMobileSync', syncPath ?? null, options]);
            return answer('sync', { value: { success: true } });
        },
        clearSyncConfigCache: () => { calls.push(['clearSyncConfigCache']); },
        reconcileBackgroundSync: async () => {
            calls.push(['syncBackgroundRegistration']);
            return { action: 'unchanged' };
        },
        rememberWebdavCapabilityProof: async (config) => { calls.push(['rememberWebdavCapabilityProof', config]); },
        encryption: {
            unlockOnly: input.unlockOnly,
            getStatus: async () => {
                if (device.encryption.unavailable) throw new Error('Sync encryption state is unavailable');
                return {
                    state: device.encryption.state as SyncEncryptionState, incompleteTransition: device.encryption.incomplete as never,
                    ...(device.encryption.partly ? { partlyEncrypted: true } : {}),
                };
            },
            getIncompleteTransition: async () => device.encryption.incomplete as never,
            isBackendPending: async () => device.encryption.pending,
            transitions: {
                enable: async (passphrase, options) => {
                    calls.push(['enableSyncEncryption', passphrase]);
                    return transition('enable', 'enabled', options.onProgress);
                },
                change: async (current, nextPassphrase, options) => {
                    calls.push(['changeSyncEncryptionPassphrase', current, nextPassphrase]);
                    return transition('change', 'enabled', options.onProgress);
                },
                disable: async (options) => {
                    calls.push(['disableSyncEncryption']);
                    return transition('disable', 'off', options.onProgress);
                },
                provide: async (passphrase) => {
                    calls.push(['provideSyncEncryptionPassphrase', passphrase]);
                    const outcome = await answer('provide', 'ok');
                    if (outcome === 'ok') device.encryption.state = 'enabled';
                    if (outcome === 'no-encrypted-remote') device.encryption.state = 'off';
                    return outcome;
                },
                decline: async () => { calls.push(['declineSyncEncryptionPassphrase']); },
                recheck: async () => {
                    calls.push(['recheckPartlyEncryptedLocation']);
                    const found = await answer('recheck', 'mixed');
                    if (found !== 'mixed') device.encryption.partly = false;
                    return found;
                },
                abandon: async () => {
                    calls.push(['abandonSyncEncryptionTransition']);
                    const abandoned = device.encryption.incomplete;
                    device.encryption.incomplete = null;
                    device.encryption.state = 'off';
                    return abandoned;
                },
                randomBytes: (length) => new Uint8Array(length).fill(7),
            },
        },
        log: {
            info: (message, context) => { calls.push(['logInfo', message, context.extra]); },
            error: (error) => { device.logged.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error)); },
        },
        addBreadcrumb: (message) => { calls.push(['breadcrumb', message]); },
        pickSyncFolder: async () => {
            calls.push(['pickSyncFolder']);
            return answer('pick', null);
        },
        dropbox: {
            authorize: async (clientId) => {
                calls.push(['authorizeDropbox', clientId]);
                return answer('authorize', { value: { accessToken: 'staged-access', refreshToken: 'staged-refresh', expiresAt: 4_102_444_800_000 } });
            },
            redirectUri: () => 'mindwtr://redirect',
            isConnected: async () => state.dropboxTokens !== null,
            getStoredTokens: async () => state.dropboxTokens as never,
            saveTokens: async (tokens) => {
                calls.push(['saveDropboxTokens', tokens]);
                state.dropboxTokens = { ...tokens };
            },
            clearTokens: async () => {
                calls.push(['clearDropboxTokens']);
                state.dropboxTokens = null;
            },
            disconnect: async (clientId) => {
                calls.push(['disconnectDropbox', clientId]);
                state.dropboxTokens = null;
            },
            revokeTokens: async (clientId, tokens) => { calls.push(['revokeDropboxTokens', clientId, tokens]); },
            getValidAccessToken: async (clientId) => {
                calls.push(['getValidDropboxAccessToken', clientId]);
                return 'stored-access';
            },
            forceRefreshAccessToken: async (clientId) => {
                calls.push(['forceRefreshDropboxAccessToken', clientId]);
                return 'refreshed-access';
            },
            getValidAccessTokenForTokens: async (clientId, tokens) => {
                calls.push(['getValidDropboxAccessTokenForTokens', clientId, tokens]);
                return { accessToken: String(tokens.accessToken), tokens };
            },
            forceRefreshAccessTokenForTokens: async (clientId, tokens) => {
                calls.push(['forceRefreshDropboxAccessTokenForTokens', clientId, tokens]);
                return { accessToken: 'refreshed-access', tokens: { ...tokens, accessToken: 'refreshed-access' } };
            },
            testAccess: async (token) => {
                calls.push(['testDropboxAccess', token]);
                return answer('dropboxTest', undefined);
            },
        },
        listRecoverySnapshots: async () => [],
    };
    // React Native offers iCloud only on iOS; the host binds CloudKit there.
    Object.defineProperty(host, 'cloudKit', {
        enumerable: true,
        get: () => (state.os === 'ios' ? {
            getAccountStatus: async () => {
                calls.push(['getCloudKitAccountStatus']);
                return state.cloudKitStatus;
            },
        } : undefined),
    });
    return { state, host, apply };
}

async function openHost(host: NativeSyncSettingsHost, language = 'en'): Promise<Host> {
    const contract = createNativeHostContract({ syncSettings: host });
    value(await contract.setLanguage({ storedLanguage: language, systemLocale: fixture.deviceLocale }));
    expect(await contract.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
    return contract;
}

// ---------------------------------------------------------------------------
// The native screen.

type Control = { label: string; tinted: boolean; disabled: boolean; busy: boolean; press: () => Promise<unknown> | void };
type Input = { label: string | null; placeholder: string | null; shown: string; secure: boolean; type: (text: string) => Promise<unknown> | void };
type Text = string | [string, string];
type Drawn = { texts: Text[]; controls: Control[]; switches: { value: boolean; flip: () => Promise<unknown> | void }[]; inputs: Input[]; links: unknown[][] };

const dots = (text: string) => '•'.repeat(text.length);

function syncDriver(contract: Host, scenario: Scenario, dev: ReturnType<typeof createDevice>) {
    const log = { toasts: [] as unknown[][], device: 0, writes: 0, calls: 0 };
    let view!: NativeSyncSettings;
    // Screen state.
    let open = { preferences: false, history: false, snapshots: false };
    let forms: { kind: string | null; url: string; username: string; password: string | null; token: string | null; insecure: boolean } = {
        kind: null, url: '', username: '', password: null, token: null, insecure: false,
    };
    let fields: Record<string, string> = { current: '', next: '', confirm: '' };
    const pending = new Set<Promise<unknown>>();

    const took = (result: NativeHostResult<{ toasts?: { title: string; message: string; tone: string; durationMs: number | null }[] }>) => {
        if (result.ok) for (const toast of result.value.toasts ?? []) log.toasts.push([toast.title, toast.message, toast.tone, toast.durationMs]);
        return result;
    };

    const draft = () => (forms.kind === 'webdav' ? { url: forms.url } : forms.kind === 'selfhosted' ? { url: forms.url, token: forms.token } : {});

    /** Re-reads the view and applies React Native's effects on the screen state. */
    const refresh = () => {
        const before = view;
        view = value(contract.getSyncSettings({ draft: draft() }));
        const panel = view.panel;
        const prior = before?.panel;
        if (!panel || (panel.kind !== 'webdav' && panel.kind !== 'selfhosted')) {
            forms = { kind: panel?.kind ?? null, url: '', username: '', password: null, token: null, insecure: false };
        } else if (forms.kind !== panel.kind || !prior || prior.kind !== panel.kind) {
            // A form mounts with the stored values.
            forms = {
                kind: panel.kind,
                url: panel.url.value,
                username: panel.kind === 'webdav' ? panel.username.value : '',
                password: null,
                token: null,
                insecure: panel.allowInsecureHttp.value,
            };
        } else {
            // A form takes a stored value again whenever it changes.
            if (panel.url.value !== prior.url.value) forms.url = panel.url.value;
            if (panel.allowInsecureHttp.value !== prior.allowInsecureHttp.value) forms.insecure = panel.allowInsecureHttp.value;
            if (panel.kind === 'webdav' && prior.kind === 'webdav') {
                if (panel.username.value !== prior.username.value) forms.username = panel.username.value;
                if (panel.password.mask !== prior.password.mask) forms.password = null;
            }
            if (panel.kind === 'selfhosted' && prior.kind === 'selfhosted' && panel.token.mask !== prior.token.mask) forms.token = null;
        }
        view = value(contract.getSyncSettings({ draft: draft() }));
        // The card's fields read its own passphrases: a closed flow empties them.
        const shownFields = new Set((view.encryption?.rows ?? []).flatMap((row) => (row.kind === 'field' ? [row.field] : [])));
        for (const name of Object.keys(fields)) if (!shownFields.has(name as never)) fields[name] = '';
    };

    const webdavFields = (): NativeSyncWebDavFields => ({ url: forms.url, username: forms.username, password: forms.password, allowInsecureHttp: forms.insecure });
    const selfHostedFields = () => ({ url: forms.url, token: forms.token, allowInsecureHttp: forms.insecure });
    const formFields = () => (forms.kind === 'webdav' ? { webdav: webdavFields() } : forms.kind === 'selfhosted' ? { selfHosted: selfHostedFields() } : {});

    /** Sends a command; a held device answer leaves it running, as a tap does on React Native. */
    const send = async (command: () => Promise<NativeHostResult<any>>) => {
        let holdStarted!: () => void;
        const held = new Promise<void>((resolve) => { holdStarted = resolve; });
        device.holdStarted = holdStarted;
        const running = command().then(took);
        pending.add(running);
        void running.finally(() => pending.delete(running));
        await Promise.race([running, held]);
        device.holdStarted = null;
        // Let a held command's reads settle as React Native's renders would.
        for (let index = 0; index < 30; index += 1) await Promise.resolve();
    };

    const encryptionAction = (action: NativeSyncEncryptionAction) => send(async () => {
        const needsRequest = action.type === 'submit' || action.type === 'decline';
        const result = await contract.runSyncEncryptionAction({ ...(needsRequest ? { requestId: generateUUID() } : {}), action });
        if (result.ok && result.value.passphrase) {
            fields.next = result.value.passphrase;
            fields.confirm = result.value.passphrase;
        }
        return result;
    });

    const lastSync = (drawn: Drawn, card: NonNullable<NativeSyncSettings['panel']>['lastSync']) => {
        drawn.texts.push(card.title, card.status, ...card.lines);
        if (card.error) drawn.texts.push(['danger', card.error]);
        if (card.history) {
            const label = open.history ? card.history.open : card.history.closed;
            drawn.texts.push(label);
            drawn.controls.push({ label, tinted: false, disabled: false, busy: false, press: () => { open.history = !open.history; } });
            if (open.history) drawn.texts.push(...card.history.entries);
        }
    };

    const control = (drawn: Drawn, entry: { label: string; description: string | null; enabled: boolean; tinted: boolean; busy: boolean }, press: () => Promise<unknown> | void) => {
        drawn.texts.push(entry.label, ...(entry.description ? [entry.description] : []));
        drawn.controls.push({
            label: [entry.label, ...(entry.description ? [entry.description] : [])].join('|'),
            tinted: entry.tinted, disabled: !entry.enabled, busy: entry.busy, press,
        });
    };

    const layout = (): Drawn => {
        const drawn: Drawn = { texts: [], controls: [], switches: [], inputs: [], links: [] };
        const { texts, controls, switches, inputs } = drawn;
        texts.push(view.title, view.backend.title, view.backend.current, view.backend.hint);
        for (const option of view.backend.options) {
            texts.push(option.label);
            controls.push({
                label: option.label, tinted: option.selected, disabled: false, busy: false,
                press: () => send(() => contract.selectSyncBackend({ requestId: generateUUID(), option: option.option })),
            });
        }
        if (view.backend.group) texts.push(view.backend.group.title, view.backend.group.description);
        texts.push(view.guide.title);
        controls.push({ label: `${view.guide.title}. ${view.guide.description}`, tinted: true, disabled: false, busy: false, press: () => undefined });
        drawn.links.push(['sync-guide-link', view.guide.title, view.guide.url]);
        if (view.off) texts.push(view.off.title, view.off.description);
        const panel = view.panel;
        const revision = () => (forms.kind === 'webdav' || forms.kind === 'selfhosted' ? { revision: view.configRevision } : {});
        const syncNow = () => send(() => contract.syncNow({ requestId: generateUUID(), ...revision(), ...formFields() }));
        const test = () => send(() => contract.testSyncConnection(formFields()));
        const save = () => send(() => contract.saveSyncBackend({ requestId: generateUUID(), revision: view.configRevision, ...formFields() } as never));
        const insecureSwitch = (current: boolean) => switches.push({ value: current, flip: () => { forms.insecure = !forms.insecure; } });
        if (panel?.kind === 'file') {
            texts.push(panel.help.title, panel.help.text, panel.help.tip, panel.title, panel.folder.label, panel.folder.value);
            control(drawn, panel.folder.select, () => send(() => contract.pickSyncFolder({ requestId: generateUUID() })));
            control(drawn, panel.syncNow, syncNow);
            lastSync(drawn, panel.lastSync);
        } else if (panel?.kind === 'webdav') {
            texts.push(panel.title, panel.url.label);
            inputs.push({ label: null, placeholder: panel.url.placeholder, shown: forms.url, secure: false, type: (text) => { forms.url = text; } });
            texts.push(panel.url.hint);
            if (panel.url.invalid) texts.push(['danger', panel.url.invalid]);
            texts.push(panel.allowInsecureHttp.label, panel.allowInsecureHttp.hint);
            insecureSwitch(forms.insecure);
            texts.push(panel.username.label);
            inputs.push({ label: null, placeholder: panel.username.placeholder, shown: forms.username, secure: false, type: (text) => { forms.username = text; } });
            texts.push(panel.password.label);
            inputs.push({
                label: null, placeholder: panel.password.placeholder, shown: forms.password === null ? panel.password.mask : dots(forms.password), secure: true,
                type: (text) => { forms.password = text; },
            });
            control(drawn, panel.save, save);
            control(drawn, panel.syncNow, syncNow);
            control(drawn, panel.test, test);
            lastSync(drawn, panel.lastSync);
        } else if (panel?.kind === 'selfhosted') {
            texts.push(panel.url.label);
            inputs.push({ label: null, placeholder: panel.url.placeholder, shown: forms.url, secure: false, type: (text) => { forms.url = text; } });
            texts.push(...panel.url.hints);
            if (panel.url.invalid) texts.push(['danger', panel.url.invalid]);
            texts.push(panel.allowInsecureHttp.label, panel.allowInsecureHttp.hint);
            insecureSwitch(forms.insecure);
            texts.push(panel.token.label);
            inputs.push({
                label: null, placeholder: panel.token.placeholder, shown: forms.token === null ? panel.token.mask : dots(forms.token), secure: true,
                type: (text) => { forms.token = text; },
            });
            texts.push(panel.token.hint);
            if (panel.token.invalid) texts.push(['danger', panel.token.invalid]);
            control(drawn, panel.save, save);
            control(drawn, panel.syncNow, syncNow);
            control(drawn, panel.test, test);
            lastSync(drawn, panel.lastSync);
        } else if (panel?.kind === 'dropbox') {
            texts.push(panel.title, panel.description, panel.redirect);
            if (panel.notConfigured) texts.push(['danger', panel.notConfigured]);
            texts.push(panel.status);
            control(drawn, panel.connect, () => send(() => (panel.connected
                ? contract.disconnectDropbox({ requestId: generateUUID() })
                : contract.connectDropbox({ requestId: generateUUID() }))));
            control(drawn, panel.test, test);
            control(drawn, panel.syncNow, syncNow);
            lastSync(drawn, panel.lastSync);
        } else if (panel?.kind === 'cloudkit') {
            texts.push(panel.help.title, panel.help.text, panel.help.status);
            control(drawn, panel.syncNow, syncNow);
            lastSync(drawn, panel.lastSync);
        }
        const card = view.encryption;
        if (card) {
            texts.push(card.title);
            if (card.guide) {
                texts.push(card.guide.title);
                controls.push({ label: `${card.guide.title}. ${card.guide.description}`, tinted: true, disabled: false, busy: false, press: () => undefined });
                drawn.links.push(['sync-encryption-guide-link', card.guide.title, card.guide.url]);
            }
            for (const row of card.rows) {
                if (row.kind === 'text') {
                    texts.push(row.tone === 'warning' || row.tone === 'danger' ? [row.tone, row.text] : row.text);
                } else if (row.kind === 'field') {
                    texts.push(row.label);
                    const name = row.field;
                    inputs.push({
                        label: row.label, placeholder: null, shown: row.secure ? dots(fields[name]) : fields[name], secure: row.secure,
                        type: (text) => {
                            fields[name] = text;
                            return send(() => contract.runSyncEncryptionAction({ action: { type: 'typed', field: name, value: text } }));
                        },
                    });
                } else if (row.kind === 'reveal') {
                    texts.push(row.label);
                    controls.push({ label: row.label, tinted: true, disabled: false, busy: false, press: () => encryptionAction(row.action) });
                } else {
                    texts.push(row.label);
                    controls.push({ label: row.label, tinted: row.enabled, disabled: !row.enabled, busy: row.busy, press: () => encryptionAction(row.action) });
                }
            }
        }
        const chevron = (isOpen: boolean) => (isOpen ? view.disclosure.open : view.disclosure.closed);
        texts.push(view.preferences.title, view.preferences.description, chevron(open.preferences));
        controls.push({
            label: [view.preferences.title, view.preferences.description, chevron(open.preferences)].join('|'),
            tinted: false, disabled: false, busy: false, press: () => { open.preferences = !open.preferences; },
        });
        if (open.preferences) {
            for (const row of view.preferences.rows) {
                texts.push(row.label, ...(row.hint ? [row.hint] : []));
                switches.push({ value: row.value, flip: () => send(() => contract.setSyncPreference({ requestId: generateUUID(), key: row.key, value: !row.value })) });
            }
        }
        const snapshots = view.recoverySnapshots;
        texts.push(snapshots.title, snapshots.description, chevron(open.snapshots));
        controls.push({
            label: [snapshots.title, snapshots.description, chevron(open.snapshots)].join('|'),
            tinted: false, disabled: false, busy: false, press: () => { open.snapshots = !open.snapshots; },
        });
        if (open.snapshots) {
            if (snapshots.snapshots.length === 0) texts.push(snapshots.empty);
            else texts.push(...snapshots.snapshots);
        }
        return drawn;
    };

    const observe = () => {
        refresh();
        const drawn = layout();
        const out = normalize({
            texts: drawn.texts,
            controls: drawn.controls.map((entry) => [entry.label, entry.tinted, entry.disabled, entry.busy]),
            switches: drawn.switches.map((entry) => [entry.value, false]),
            inputs: drawn.inputs.map((entry) => [entry.label, entry.placeholder, entry.secure ? dots(entry.shown) : entry.shown, entry.secure]),
            links: drawn.links,
            writes: writes.slice(log.writes),
            device: dev.state.log.slice(log.device),
            toasts: log.toasts.splice(0),
            calls: device.calls.slice(log.calls),
        });
        log.writes = writes.length;
        log.device = dev.state.log.length;
        log.calls = device.calls.length;
        return out;
    };

    const labelText = (label: string, t: (key: string) => string) => (label.startsWith('k:') ? t(label.slice(2)) : label);
    const matches = (entry: Control, label: string) => (
        entry.label === label || entry.label.split('|')[0] === label || entry.label.startsWith(`${label}. `) || entry.label.startsWith(`${label} (`)
    );

    const perform = async (action: [string, ...unknown[]], t: (key: string) => string) => {
        const drawn = layout();
        const [kind, target, extra] = action;
        switch (kind) {
            case 'press': {
                const label = labelText(target as string, t);
                const entry = drawn.controls.find((item) => matches(item, label));
                if (!entry) throw new Error(`No control ${label}`);
                if (entry.disabled) return;
                await entry.press();
                return;
            }
            case 'switch':
                await drawn.switches[target as number].flip();
                return;
            case 'type':
                await drawn.inputs[target as number].type(extra as string);
                return;
            case 'release':
                device.held.shift()?.();
                for (let index = 0; index < 30; index += 1) await Promise.resolve();
                await Promise.race([Promise.allSettled(Array.from(pending)), new Promise((resolve) => setTimeout(resolve, 0))]);
                return;
            case 'device':
                dev.apply(target as Device);
                return;
            default:
                throw new Error(`Unknown action ${String(kind)}`);
        }
    };

    return {
        open: async () => {
            const opened = value(await contract.openSyncSettings());
            for (const toast of opened.toasts) log.toasts.push([toast.title, toast.message, toast.tone, toast.durationMs]);
        },
        observe,
        perform,
        finish: async () => {
            while (device.held.length > 0) device.held.shift()?.();
            await Promise.allSettled(Array.from(pending));
            contract.closeSyncSettings();
        },
    };
}

async function replay(scenario: Scenario, strings: Record<string, Record<string, string>>) {
    await seed(fixture.settings[scenario.settings], scenario.data === 'titles');
    const dev = createDevice(scenario.device);
    const language = scenario.device.language ?? 'en';
    const contract = await openHost(dev.host, language);
    const t = (key: string) => strings[language]?.[key] || strings.en?.[key] || key;
    const driver = syncDriver(contract, scenario, dev);
    await driver.open();
    const observations = [driver.observe()];
    for (const action of scenario.actions) {
        await driver.perform(action, t);
        await flushPendingSave();
        observations.push(driver.observe());
    }
    await driver.finish();
    return observations;
}

describe('native host contract: Settings › Sync', () => {
    const strings: Record<string, Record<string, string>> = {};
    const originalTz = process.env.TZ;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        strings.en = await loadTranslations('en');
        strings.de = await loadTranslations('de');
    });
    afterAll(() => {
        vi.useRealTimers();
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))(
        'replays the frozen React Native scenario through the contract: %s',
        async (name, scenario) => {
            const observations = await replay(scenario, strings);
            expect(observations).toEqual(fixture.observations[name]);
        },
    );
});

// ---------------------------------------------------------------------------
// Replays after a restart. A restart is a new host over the same store and the same
// device (RN's key-value store and secret store keep what the first run stored),
// with Settings › Sync opened again; the request replays with its first UUID.

// Shared by the tests below: a screen over a seeded store and a device, and a restart.
const WEBDAV_STORED = {
    storage: { [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com/mindwtr', [WEBDAV_USERNAME_KEY]: 'alice' },
    secrets: { [WEBDAV_PASSWORD_KEY]: 'hunter22' },
};
const start = async (input: Device, settings: AppSettings = {}) => {
    await seed(settings, false);
    const dev = createDevice(input);
    const contract = await openHost(dev.host);
    value(await contract.openSyncSettings());
    return { dev, contract };
};
const restart = async (dev: ReturnType<typeof createDevice>) => {
    await flushPendingSave();
    const contract = await openHost(dev.host);
    value(await contract.openSyncSettings());
    return contract;
};
const mark = (dev: ReturnType<typeof createDevice>) => ({ device: dev.state.log.length, writes: writes.length, calls: device.calls.length });
const since = (dev: ReturnType<typeof createDevice>, at: ReturnType<typeof mark>) => ({
    device: dev.state.log.slice(at.device),
    writes: writes.slice(at.writes),
    calls: device.calls.slice(at.calls).filter((call) => call[0] !== 'clearSyncConfigCache' && call[0] !== 'syncBackgroundRegistration'),
});
const storedConfig = (dev: ReturnType<typeof createDevice>) => ({ storage: Object.fromEntries(dev.state.storage), secrets: Object.fromEntries(dev.state.secrets) });
const webdavFields = { url: 'https://dav.example.com/mindwtr', username: 'alice', password: null, allowInsecureHttp: false };

describe('native Settings › Sync unlock-only admission', () => {
    const locked = { ...WEBDAV_STORED, unlockOnly: true, encryption: { state: 'remote-encrypted-no-key' as const } };
    const view = (contract: Host) => value(contract.getSyncSettings());
    const rows = (contract: Host) => view(contract).encryption!.rows;
    const act = (contract: Host, action: unknown, revision: unknown = view(contract).configRevision, requestId?: string) =>
        contract.runSyncEncryptionAction({ action, revision, ...(requestId ? { requestId } : {}) } as never);

    it('offers only secure unlock controls, and cancel wipes the current field', async () => {
        const { dev, contract } = await start(locked);
        expect(rows(contract).filter((row) => row.kind !== 'text')).toEqual([
            expect.objectContaining({ kind: 'action', action: { type: 'open', flow: 'unlock' } }),
        ]);
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        const controls = rows(contract).filter((row) => row.kind !== 'text');
        expect(controls.map((row) => row.kind === 'action' ? row.action : row.kind)).toEqual([
            'field', { type: 'submit', flow: 'unlock' }, { type: 'decline' }, { type: 'cancel' },
        ]);
        expect(controls[0]).toMatchObject({ field: 'current', secure: true, maxLength: 1000 });
        value(await act(contract, { type: 'typed', field: 'current', value: 'synthetic phrase' }));
        value(await act(contract, { type: 'cancel' }));
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        expect(rows(contract).find((row) => row.kind === 'action' && row.action.type === 'submit')).toMatchObject({ enabled: false });
        expect(since(dev, { device: 0, writes: 0, calls: 0 }).calls.some((call) => call[0] === 'provideSyncEncryptionPassphrase')).toBe(false);
        expect(JSON.stringify(storedConfig(dev))).not.toContain('synthetic phrase');
    });

    it.each([false, true])('accepts reordered encryption action properties (unlockOnly=%s)', async (unlockOnly) => {
        const { dev, contract } = await start({ ...locked, unlockOnly });
        const command = (action: unknown, requestId?: string) => unlockOnly
            ? act(contract, action, undefined, requestId)
            : contract.runSyncEncryptionAction({ action, ...(requestId ? { requestId } : {}) } as never);
        const before = rows(contract), at = mark(dev);
        for (const flow of ['enable', 'change', 'disable', 'abandon']) {
            for (const type of ['open', 'submit']) {
                expect(await command({ flow, type }, type === 'submit' ? generateUUID() : undefined))
                    .toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            }
        }
        for (const action of [{ flow: 'unsupported', type: 'open' }, { flow: 'unlock', type: 'open', extra: true }]) {
            expect(await command(action)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(rows(contract)).toEqual(before);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        value(await command(JSON.parse('{"flow":"unlock","type":"open"}')));
        value(await command({ value: 'reordered phrase', field: 'current', type: 'typed' }));
        value(await command(JSON.parse('{"flow":"unlock","type":"submit"}'), generateUUID()));
        expect(device.calls.filter((call) => call[0] === 'provideSyncEncryptionPassphrase'))
            .toEqual([['provideSyncEncryptionPassphrase', 'reordered phrase']]);
        expect(device.encryption.state).toBe('enabled');
        expect(JSON.stringify(storedConfig(dev))).not.toContain('reordered phrase');
    });

    it('filters full-card actions in every state and refuses programmatic bypasses', async () => {
        for (const encryption of [
            { state: 'off' as const }, { state: 'enabled' as const }, { state: 'remote-plaintext' as const },
            { state: 'off' as const, partly: true }, { state: 'remote-encrypted-no-key' as const, incomplete: 'enable' },
        ]) {
            const { dev, contract } = await start({ ...locked, encryption });
            expect(rows(contract).every((row) => row.kind === 'text')).toBe(true);
            const at = mark(dev);
            for (const action of [
                { type: 'open', flow: 'enable' }, { type: 'open', flow: 'change' }, { type: 'open', flow: 'disable' },
                { type: 'open', flow: 'abandon' }, { type: 'generate' }, { type: 'reveal' }, { type: 'recheck' },
                { type: 'open', flow: 'unlock' }, { type: 'typed', field: 'next', value: 'unsupported' },
                { type: 'submit', flow: 'unlock' }, { type: 'decline' },
            ]) {
                const request = ['submit', 'decline'].includes(action.type) ? generateUUID() : undefined;
                expect(await act(contract, action, undefined, request)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            }
            expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        }
    });

    it('rejects unsupported fields and reveal without changing a valid unlock flow', async () => {
        const { dev, contract } = await start(locked);
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        const before = rows(contract), at = mark(dev);
        for (const action of [{ type: 'reveal' }, { type: 'generate' }, { type: 'typed', field: 'confirm', value: 'hidden' }]) {
            expect(await act(contract, action)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        }
        expect(rows(contract)).toEqual(before);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
    });

    it('requires a bounded nonempty revision before any field or transition mutation', async () => {
        const { dev, contract } = await start(locked);
        const before = rows(contract), at = mark(dev);
        for (const revision of [undefined, null, 1, '', 'x'.repeat(101)]) {
            const input = { action: { type: 'open', flow: 'unlock' }, ...(revision === undefined ? {} : { revision }) };
            expect(await contract.runSyncEncryptionAction(input as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(rows(contract)).toEqual(before);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        value(await act(contract, { type: 'typed', field: 'current', value: 'retained phrase' }));
        for (const action of [{ type: 'typed', field: 'current', value: 'changed phrase' }, { type: 'submit', flow: 'unlock' }, { type: 'decline' }]) {
            expect(await act(contract, action, 'stale', ['submit', 'decline'].includes(action.type) ? generateUUID() : undefined))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        expect(since(dev, at).calls).toEqual([]);
        value(await act(contract, { type: 'submit', flow: 'unlock' }, undefined, generateUUID()));
        expect(device.calls.filter((call) => call[0] === 'provideSyncEncryptionPassphrase')).toEqual([['provideSyncEncryptionPassphrase', 'retained phrase']]);
    });

    it('binds the revision to actual persisted configuration, not just the displayed token', async () => {
        const { dev, contract } = await start(locked);
        const revision = view(contract).configRevision;
        const before = rows(contract), at = mark(dev);
        dev.state.storage.set(WEBDAV_URL_KEY, 'https://dav.example.com/other');
        expect(await act(contract, { type: 'open', flow: 'unlock' }, revision)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(rows(contract)).toEqual(before);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
    });

    it('refuses a saved non-WebDAV backend and a staged WebDAV selection', async () => {
        const file = await start({ ...locked, storage: { [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: '/sync' } });
        expect(rows(file.contract).every((row) => row.kind === 'text')).toBe(true);
        const fileAt = mark(file.dev);
        expect(await act(file.contract, { type: 'open', flow: 'unlock' })).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(since(file.dev, fileAt)).toEqual({ device: [], writes: [], calls: [] });
        const staged = await start({ ...locked, storage: { [SYNC_BACKEND_KEY]: 'off' } });
        value(await staged.contract.selectSyncBackend({ requestId: generateUUID(), option: 'webdav' }));
        expect(rows(staged.contract).every((row) => row.kind === 'text')).toBe(true);
        const stagedAt = mark(staged.dev);
        expect(await act(staged.contract, { type: 'open', flow: 'unlock' })).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(since(staged.dev, stagedAt)).toEqual({ device: [], writes: [], calls: [] });
        expect(staged.dev.state.storage.get(SYNC_BACKEND_KEY)).toBe('off');
    });

    it('keeps a wrong passphrase inline and retryable, then preserves finished-flow refusal', async () => {
        const { dev, contract } = await start({ ...locked, queues: { provide: ['wrong-passphrase', 'ok'] } });
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        value(await act(contract, { type: 'typed', field: 'current', value: 'wrong phrase' }));
        value(await act(contract, { type: 'submit', flow: 'unlock' }, undefined, generateUUID()));
        expect(rows(contract)).toContainEqual(expect.objectContaining({ kind: 'text', tone: 'danger', text: en['settings.syncEncryptionErrorWrongPassphrase'] }));
        expect(rows(contract)).toContainEqual(expect.objectContaining({ kind: 'field', field: 'current', secure: true }));
        value(await act(contract, { type: 'typed', field: 'current', value: 'right phrase' }));
        const request = { requestId: generateUUID(), revision: view(contract).configRevision, action: { type: 'submit' as const, flow: 'unlock' as const } };
        value(await contract.runSyncEncryptionAction(request));
        expect(device.encryption.state).toBe('enabled');
        expect(rows(contract).every((row) => row.kind === 'text')).toBe(true);
        const at = mark(dev);
        expect((await contract.runSyncEncryptionAction(request)).ok).toBe(false);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
    });

    it('keeps Not now paused, wipes the field, and refuses its finished-flow replay', async () => {
        const { dev, contract } = await start(locked);
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        value(await act(contract, { type: 'typed', field: 'current', value: 'private draft' }));
        const request = { requestId: generateUUID(), revision: view(contract).configRevision, action: { type: 'decline' as const } };
        value(await contract.runSyncEncryptionAction(request));
        expect(device.encryption.state).toBe('remote-encrypted-no-key');
        expect(device.calls.filter((call) => call[0] === 'declineSyncEncryptionPassphrase')).toHaveLength(1);
        expect((await contract.runSyncEncryptionAction(request)).ok).toBe(false);
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        expect(rows(contract).find((row) => row.kind === 'action' && row.action.type === 'submit')).toMatchObject({ enabled: false });
        expect(JSON.stringify(storedConfig(dev))).not.toContain('private draft');
    });

    it('permits unavailable-state retry without inventing Off or an unlock field', async () => {
        const { dev, contract } = await start({ ...locked, encryption: { ...locked.encryption, unavailable: true } });
        expect(rows(contract).filter((row) => row.kind !== 'text')).toEqual([
            expect.objectContaining({ kind: 'action', action: { type: 'retry' } }),
        ]);
        expect((await act(contract, { type: 'open', flow: 'unlock' })).ok).toBe(false);
        dev.apply({ encryption: { unavailable: false } });
        value(await act(contract, { type: 'retry' }));
        expect(rows(contract)).toContainEqual(expect.objectContaining({ kind: 'action', action: { type: 'open', flow: 'unlock' } }));
    });

    it('refuses a late typed mutation after its CAS visit closed and reopened', async () => {
        const { dev, contract } = await start(locked);
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        const revision = view(contract).configRevision;
        const read = dev.host.storage.multiGet;
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((resolve) => { entered = resolve; });
        const held = new Promise<void>((resolve) => { release = resolve; });
        let once = true;
        dev.host.storage.multiGet = async (keys) => {
            if (once && keys.length > 1) { once = false; entered(); await held; }
            return read(keys);
        };
        const delayed = act(contract, { type: 'typed', field: 'current', value: 'late phrase' }, revision);
        await reached;
        value(contract.closeSyncSettings());
        value(await contract.openSyncSettings());
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        const before = rows(contract), at = mark(dev);
        release();
        expect(await delayed).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(rows(contract)).toEqual(before);
        expect(rows(contract).find((row) => row.kind === 'action' && row.action.type === 'submit')).toMatchObject({ enabled: false });
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
    });

    it('does not submit a changed field under the UUID identity captured before CAS', async () => {
        const { dev, contract } = await start(locked);
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        value(await act(contract, { type: 'typed', field: 'current', value: 'original phrase' }));
        const revision = view(contract).configRevision;
        const read = dev.host.storage.multiGet;
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((resolve) => { entered = resolve; });
        const held = new Promise<void>((resolve) => { release = resolve; });
        let once = true;
        dev.host.storage.multiGet = async (keys) => {
            if (once && keys.length > 1) { once = false; entered(); await held; }
            return read(keys);
        };
        const delayed = act(contract, { type: 'submit', flow: 'unlock' }, revision, generateUUID());
        await reached;
        value(await act(contract, { type: 'typed', field: 'current', value: 'changed phrase' }, revision));
        const before = rows(contract), at = mark(dev);
        release();
        expect(await delayed).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(rows(contract)).toEqual(before);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        expect(device.calls.filter((call) => call[0] === 'provideSyncEncryptionPassphrase')).toEqual([]);
        value(await act(contract, { type: 'submit', flow: 'unlock' }, revision, generateUUID()));
        expect(device.calls.filter((call) => call[0] === 'provideSyncEncryptionPassphrase')).toEqual([['provideSyncEncryptionPassphrase', 'changed phrase']]);
    });

    it('joins exact concurrent submit requests and binds UUID collisions to revision and fields', async () => {
        const { dev, contract } = await start({ ...locked, queues: { provide: ['hold', 'wrong-passphrase', 'wrong-passphrase'] } });
        value(await act(contract, { type: 'open', flow: 'unlock' }));
        value(await act(contract, { type: 'typed', field: 'current', value: 'first phrase' }));
        const request = { requestId: generateUUID(), revision: view(contract).configRevision, action: { type: 'submit' as const, flow: 'unlock' as const } };
        let started!: () => void;
        const reached = new Promise<void>((resolve) => { started = resolve; });
        device.holdStarted = started;
        const first = contract.runSyncEncryptionAction(request), joined = contract.runSyncEncryptionAction(request);
        await reached;
        expect(device.calls.filter((call) => call[0] === 'provideSyncEncryptionPassphrase')).toHaveLength(1);
        device.held.splice(0).forEach((release) => release());
        expect(await joined).toEqual(await first);
        device.holdStarted = null;
        value(await act(contract, { type: 'typed', field: 'current', value: 'second phrase' }));
        expect(await contract.runSyncEncryptionAction(request)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        // Restoring the original field still cannot reuse the UUID with a different revision.
        value(await act(contract, { type: 'typed', field: 'current', value: 'first phrase' }));
        expect(await contract.runSyncEncryptionAction({ ...request, revision: 'different-revision' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(device.calls.filter((call) => call[0] === 'provideSyncEncryptionPassphrase')).toHaveLength(1);
    });
});

describe('native Settings › Sync Off durable acknowledgement', () => {
    const methodsWithSave = async (host: NativeSyncSettingsHost, save: () => Promise<NativeHostResult<null>>) => {
        const methods = createSyncSettingsMethods({
            readiness: () => ({ ok: true, value: null }), save,
            t: () => (key) => en[key as keyof typeof en] ?? key,
            language: () => 'en', systemLocale: () => 'en-US', dataRevision: () => 'fixture',
            requestIdPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            host: () => host,
        });
        value(await methods.openSyncSettings());
        return methods;
    };

    it('joins the Off UUID and waits for the queued status write before acknowledging it', async () => {
        const { dev, contract } = await start({ ...WEBDAV_STORED, os: 'ios' }, { lastSyncStatus: 'error', lastSyncError: 'synthetic prior failure' });
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const saving = new Promise<void>((resolve) => { entered = resolve; });
        let saves = 0;
        let persistedSettings: AppSettings | undefined;
        const adapter = getStorageAdapter();
        const saveData = adapter.saveData;
        adapter.saveData = async (data) => {
            saves += 1;
            entered();
            await held;
            await saveData(data);
            persistedSettings = data.settings;
        };
        const input = { requestId: generateUUID(), option: 'off' as const };
        let acknowledged = false;
        const first = contract.selectSyncBackend(input).then((result) => { acknowledged = true; return result; });
        const joined = contract.selectSyncBackend(input);
        try {
            expect(await Promise.race([first.then(() => 'receipt'), saving.then(() => 'flush')])).toBe('flush');
            expect(acknowledged).toBe(false);
            expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBe('off');
            expect(getPersistenceStatus().inFlight).toBe(true);
            expect(device.calls.filter((call) => call[0] === 'logInfo')).toEqual([]);
            release();
            const result = await first;
            expect(result).toEqual({ ok: true, value: { toasts: [] } });
            expect(await joined).toBe(result);
            expect(persistedSettings).toMatchObject({ lastSyncStatus: 'idle' });
            expect(persistedSettings?.lastSyncError).toBeUndefined();
            expect(getPersistenceStatus()).toMatchObject({ queued: 0, inFlight: false, immediate: 0, retrying: false, failed: false });
            expect(saves).toBe(1);
            expect(device.calls.filter((call) => call[0] === 'logInfo')).toEqual([
                ['logInfo', 'Native Sync Off durably acknowledged', {
                    releaseCheck: 'v1.3.5/native-sync-off-durable', operation: 'off', outcome: 'confirmed',
                }],
            ]);
            const at = mark(dev);
            expect(await contract.selectSyncBackend(input)).toEqual(result);
            expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        } finally {
            release();
            await Promise.all([first, joined]);
            await flushPendingSave();
        }
    });

    it('drains the queued status reset before returning a known KV failure', async () => {
        const { dev, contract } = await start({ ...WEBDAV_STORED, os: 'ios' }, { lastSyncStatus: 'error' });
        dev.state.failKeys.add(SYNC_BACKEND_KEY);
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const saving = new Promise<void>((resolve) => { entered = resolve; });
        let persistedSettings: AppSettings | undefined;
        const adapter = getStorageAdapter();
        const saveData = adapter.saveData;
        adapter.saveData = async (data) => {
            entered();
            await held;
            await saveData(data);
            persistedSettings = data.settings;
        };
        const input = { requestId: generateUUID(), option: 'off' as const };
        const command = contract.selectSyncBackend(input);
        try {
            expect(await Promise.race([command.then(() => 'failure'), saving.then(() => 'flush')])).toBe('flush');
            expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBe('webdav');
            release();
            expect(await command).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'The device store refused the write' } });
            expect(persistedSettings?.lastSyncStatus).toBe('idle');
            expect(getPersistenceStatus()).toMatchObject({ queued: 0, inFlight: false, failed: false });
            expect(value(contract.getSyncSettings()).panel?.kind).toBe('webdav');
            expect(device.calls.filter((call) => call[0] === 'logInfo')).toEqual([]);
        } finally {
            release();
            await command;
            await flushPendingSave();
        }
    });
    it('does not cache a failed flush, and drains it on exact already-Off retry', async () => {
        const { dev } = await start({ ...WEBDAV_STORED, os: 'ios' }, { lastSyncStatus: 'error' });
        let saves = 0;
        const methods = await methodsWithSave(dev.host, async () => {
            saves += 1;
            if (saves === 1) return { ok: false, error: { code: 'SAVE_FAILED', message: 'synthetic flush refusal' } };
            await flushPendingSave();
            return { ok: true, value: null };
        });
        const input = { requestId: generateUUID(), option: 'off' as const };
        try {
            expect(await methods.selectSyncBackend(input)).toEqual({ ok: false, error: { code: 'SAVE_FAILED', message: 'synthetic flush refusal' } });
            expect(getPersistenceStatus().queued).toBeGreaterThan(0);
            expect(device.calls.filter((call) => call[0] === 'logInfo')).toEqual([]);
            expect(await methods.selectSyncBackend(input)).toEqual({ ok: true, value: { toasts: [] } });
            expect(saves).toBe(2);
            expect(getPersistenceStatus()).toMatchObject({ queued: 0, inFlight: false, failed: false });
            const at = mark(dev);
            expect(await methods.selectSyncBackend(input)).toEqual({ ok: true, value: { toasts: [] } });
            expect(saves).toBe(2);
            expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
            expect(dev.state.log.filter((entry) => entry[0] === 'setItem' && entry[1] === SYNC_BACKEND_KEY)).toHaveLength(1);
        } finally {
            await flushPendingSave();
        }
    });

    it('redacts failed Off flush messages on both fresh and already-Off UUID retries', async () => {
        const { dev } = await start({ ...WEBDAV_STORED, os: 'ios' });
        const secret = WEBDAV_STORED.secrets[WEBDAV_PASSWORD_KEY];
        let saves = 0;
        const methods = await methodsWithSave(dev.host, async () => {
            saves += 1;
            return { ok: false, error: { code: 'SAVE_FAILED', message: `synthetic flush refusal ${secret}` } };
        });
        const input = { requestId: generateUUID(), option: 'off' as const };
        try {
            for (const phase of ['fresh Off', 'already-Off retry']) {
                const result = await methods.selectSyncBackend(input);
                expect(result, phase).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
                if (result.ok) throw new Error('Expected the synthetic flush refusal');
                expect(result.error.message, phase).toContain('synthetic flush refusal');
                expect(result.error.message, phase).not.toContain(secret);
                expect(JSON.stringify(result), phase).not.toContain(secret);
            }
            expect(saves).toBe(2);
            expect(device.calls.filter((call) => call[0] === 'logInfo')).toEqual([]);
        } finally {
            await flushPendingSave();
        }
    });

    it('forces and awaits the iOS Off diagnostic append before acknowledging success', async () => {
        const { dev, contract } = await start({ ...WEBDAV_STORED, os: 'ios' });
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const appending = new Promise<void>((resolve) => { entered = resolve; });
        const info = vi.spyOn(dev.host.log, 'info').mockImplementation(() => { entered(); return held; });
        let acknowledged = false;
        const command = contract.selectSyncBackend({ requestId: generateUUID(), option: 'off' }).then((result) => {
            acknowledged = true;
            return result;
        });
        try {
            await appending;
            // A full event-loop turn lets an unawaited action incorrectly finish.
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(acknowledged).toBe(false);
            expect(getPersistenceStatus()).toMatchObject({ queued: 0, inFlight: false, failed: false });
            expect(info).toHaveBeenCalledExactlyOnceWith('Native Sync Off durably acknowledged', {
                scope: 'native-sync', force: true,
                extra: { releaseCheck: 'v1.3.5/native-sync-off-durable', operation: 'off', outcome: 'confirmed' },
            });
            release();
            expect(await command).toEqual({ ok: true, value: { toasts: [] } });
        } finally {
            release();
            await command;
        }
    });

    it.each(['throws', 'rejects'] as const)('keeps a confirmed Off acknowledgement when its diagnostic sink %s', async (failure) => {
        const { dev, contract } = await start({ ...WEBDAV_STORED, os: 'ios' });
        const info = vi.spyOn(dev.host.log, 'info').mockImplementation(() => {
            const error = new Error('synthetic log refusal');
            if (failure === 'rejects') return Promise.reject(error);
            throw error;
        });
        expect(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'off' })).toEqual({ ok: true, value: { toasts: [] } });
        expect(info).toHaveBeenCalledOnce();
        expect(getPersistenceStatus()).toMatchObject({ queued: 0, inFlight: false, failed: false });
        expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBe('off');
    });

    it.each(['save', 'retry'] as const)('preserves the exact fatal object at the Off %s barrier with no post-fatal work', async (boundary) => {
        const { dev } = await start({ ...WEBDAV_STORED, os: 'ios' }, { lastSyncStatus: 'error' });
        const fatal = new NativeAttachmentCleanupUnconfirmedError();
        const read = vi.spyOn(dev.host.storage, 'multiGet');
        let at!: ReturnType<typeof mark>;
        let reads = 0;
        let saves = 0;
        const methods = await methodsWithSave(dev.host, async () => {
            saves += 1;
            at = mark(dev);
            reads = read.mock.calls.length;
            throw fatal;
        });
        const retryPersistence = useTaskStore.getState().retryPersistence;
        if (boundary === 'retry') {
            useTaskStore.setState({ persistenceFailure: { message: 'synthetic retry needed' }, retryPersistence: async () => {
                at = mark(dev);
                reads = read.mock.calls.length;
                throw fatal;
            } } as never);
        }
        try {
            await expect(methods.selectSyncBackend({ requestId: generateUUID(), option: 'off' })).rejects.toBe(fatal);
            expect(saves).toBe(boundary === 'save' ? 1 : 0);
            expect(read.mock.calls.length).toBe(reads);
            expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
            expect(device.calls.filter((call) => call[0] === 'logInfo')).toEqual([]);
            expect(getPersistenceStatus().queued).toBeGreaterThan(0);
        } finally {
            // Test teardown only; the fatal action itself never drains or retries.
            useTaskStore.setState({ persistenceFailure: null, retryPersistence });
            await flushPendingSave();
        }
    });
});

describe('native Settings › Sync fatal cleanup boundary', () => {
    it.each(['verification', 'first sync', 'sync now'] as const)('keeps the exact fatal object and does no post-fatal settings work during WebDAV %s', async (phase) => {
        const { dev, contract } = await start(phase === 'sync now' ? { ...WEBDAV_STORED, os: 'ios' } : { os: 'ios' });
        if (phase !== 'sync now') value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'webdav' }));
        const ports = [
            vi.spyOn(dev.host.storage, 'multiGet'), vi.spyOn(dev.host.storage, 'setItem'),
            vi.spyOn(dev.host.storage, 'multiSet'), vi.spyOn(dev.host.storage, 'removeItem'),
            vi.spyOn(dev.host.secrets, 'get'), vi.spyOn(dev.host.secrets, 'set'), vi.spyOn(dev.host.secrets, 'delete'),
            vi.spyOn(dev.host.log, 'info'), vi.spyOn(dev.host.log, 'error'),
            vi.spyOn(dev.host, 'clearSyncConfigCache'), vi.spyOn(dev.host, 'reconcileBackgroundSync'),
            vi.spyOn(dev.host, 'rememberWebdavCapabilityProof'), vi.spyOn(dev.host, 'addBreadcrumb'),
            vi.spyOn(dev.host.encryption, 'getStatus'), vi.spyOn(dev.host.encryption, 'getIncompleteTransition'),
        ];
        const fatal = new NativeAttachmentCleanupUnconfirmedError();
        let calls = 0;
        let at!: { counts: number[]; config: ReturnType<typeof storedConfig>; device: number; writes: number; calls: number; logged: number };
        dev.host.performSync = async () => {
            if (phase === 'first sync' && calls++ === 0) return { success: true };
            at = { counts: ports.map((port) => port.mock.calls.length), config: storedConfig(dev), device: dev.state.log.length,
                writes: writes.length, calls: device.calls.length, logged: device.logged.length };
            throw fatal;
        };
        const input = { requestId: generateUUID(), revision: value(contract.getSyncSettings()).configRevision,
            webdav: { ...webdavFields, password: phase === 'sync now' ? null : 'hunter22' } };
        const result = phase === 'sync now' ? contract.syncNow(input) : contract.saveSyncBackend(input);
        await expect(result).rejects.toBe(fatal);
        expect(ports.map((port) => port.mock.calls.length)).toEqual(at.counts);
        expect(storedConfig(dev)).toEqual(at.config);
        expect(dev.state.log.slice(at.device)).toEqual([]);
        expect(writes.slice(at.writes)).toEqual([]);
        expect(device.calls.slice(at.calls)).toEqual([]);
        expect(device.logged.slice(at.logged)).toEqual([]);
        expect(value(contract.getSyncSettings()).busy.syncing).toBe(true);
        expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBe(phase === 'verification' ? undefined : 'webdav');
        expect(dev.state.secrets.get(WEBDAV_PASSWORD_KEY)).toBe(phase === 'verification' ? undefined : 'hunter22');
        // A fatal action did not produce a completed success receipt for its UUID.
        const retry = await (phase === 'sync now' ? contract.syncNow(input) : contract.saveSyncBackend(input)).catch((error: unknown) => error);
        if (phase === 'verification') expect(retry).toBe(fatal);
        else expect(retry).toMatchObject({ ok: false, error: { code: phase === 'first sync' ? 'STALE_REVISION' : 'ACTION_FAILED' } });
    });

    it('keeps ordinary same-name errors on the existing toast and settled-screen path', async () => {
        const { dev, contract } = await start({ ...WEBDAV_STORED, os: 'ios' });
        dev.host.performSync = async () => {
            throw Object.assign(new Error('ordinary sync failure'), { name: 'NativeAttachmentCleanupUnconfirmedError' });
        };
        const result = value(await contract.syncNow({ requestId: generateUUID(), revision: value(contract.getSyncSettings()).configRevision, webdav: webdavFields }));
        expect(result.toasts).toHaveLength(1);
        expect(result.toasts[0]).toMatchObject({ tone: 'error', message: 'Review Settings → Sync and try again.\nordinary sync failure' });
        expect(value(contract.getSyncSettings()).busy.syncing).toBe(false);
    });
});

describe('native host contract: Settings › Sync commands replayed after a restart', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = 'UTC';
    });
    afterAll(() => {
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });


    it('selectSyncBackend, Off: a replay finds Off stored and reset, writes nothing and keeps a later change', async () => {
        const { dev, contract } = await start(WEBDAV_STORED);
        const input = { requestId: generateUUID(), option: 'off' as const };
        value(await contract.selectSyncBackend(input));
        expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBe('off');
        await useTaskStore.getState().updateSettings({ syncPreferences: { ai: true } });
        const restarted = await restart(dev);
        const at = mark(dev);
        expect(await restarted.selectSyncBackend(input)).toEqual({ ok: true, value: { toasts: [] } });
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        expect(useTaskStore.getState().settings.syncPreferences).toEqual({ ai: true });
    });

    it('selectSyncBackend, a complete target: a replay finds the backend proven and activates nothing', async () => {
        const { dev, contract } = await start({ ...WEBDAV_STORED, storage: { ...WEBDAV_STORED.storage, [SYNC_BACKEND_KEY]: 'off' } });
        const input = { requestId: generateUUID(), option: 'webdav' as const };
        value(await contract.selectSyncBackend(input));
        expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBe('webdav');
        const stored = storedConfig(dev);
        const restarted = await restart(dev);
        const at = mark(dev);
        expect(await restarted.selectSyncBackend(input)).toEqual({ ok: true, value: { toasts: [] } });
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [['breadcrumb', 'settings:syncBackend:webdav']] });
        expect(storedConfig(dev)).toEqual(stored);
    });

    it('saveSyncBackend: a replay finds the configuration it stored and answers STALE_REVISION, writing nothing and keeping a later change', async () => {
        const { dev, contract } = await start({});
        value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'webdav' }));
        const input = { requestId: generateUUID(), revision: value(contract.getSyncSettings()).configRevision, webdav: { ...webdavFields, password: 'hunter22' } };
        const first = value(await contract.saveSyncBackend(input));
        expect(first.toasts.map((toast) => toast.tone)).toEqual(['success']);
        const stored = storedConfig(dev);
        expect(stored.storage[SYNC_BACKEND_KEY]).toBe('webdav');
        await useTaskStore.getState().updateSettings({ syncPreferences: { language: true } });
        const restarted = await restart(dev);
        const at = mark(dev);
        expect(await restarted.saveSyncBackend(input)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(storedConfig(dev)).toEqual(stored);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        expect(useTaskStore.getState().settings.syncPreferences).toEqual({ language: true });
    });

    it('syncNow: a replay syncs once more and leaves the proven folder as it was', async () => {
        const path = 'content://tree/primary%3ASync/document/primary%3ASync%2Fdata.json';
        const { dev, contract } = await start({ storage: { [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: path } });
        const input = { requestId: generateUUID() };
        value(await contract.syncNow(input));
        const stored = storedConfig(dev);
        const restarted = await restart(dev);
        const at = mark(dev);
        value(await restarted.syncNow(input));
        expect(storedConfig(dev)).toEqual(stored);
        expect(since(dev, at).writes).toEqual([]);
        // The folder is proven and unchanged: one normal sync, no activation probe.
        expect(since(dev, at).calls.filter((call) => call[0] === 'performMobileSync')).toEqual([
            ['performMobileSync', null, { manual: true, ignorePendingRemoteWriteBackoff: false }],
        ]);
    });

    it('testSyncConnection: a replay stores nothing but the same capability proof', async () => {
        const { dev, contract } = await start(WEBDAV_STORED);
        value(await contract.testSyncConnection({ webdav: webdavFields }));
        const restarted = await restart(dev);
        const at = mark(dev);
        const replayed = value(await restarted.testSyncConnection({ webdav: webdavFields }));
        expect(replayed.toasts.map((toast) => toast.tone)).toEqual(['success']);
        expect(since(dev, at).device).toEqual([]);
        expect(since(dev, at).writes).toEqual([]);
    });

    it('pickSyncFolder: a replay asks the picker again; a cancel writes nothing, the same folder stores the same values', async () => {
        const uri = 'content://tree/primary%3ASync/document/primary%3ASync%2Fdata.json';
        const { dev, contract } = await start({ queues: { pick: [{ value: { uri } }] } });
        value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'file' }));
        const input = { requestId: generateUUID() };
        value(await contract.pickSyncFolder(input));
        const stored = storedConfig(dev);
        expect(stored.storage[SYNC_BACKEND_KEY]).toBe('file');
        let restarted = await restart(dev);
        let at = mark(dev);
        value(await restarted.pickSyncFolder(input));
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [['pickSyncFolder']] });
        device.queues.pick = [{ value: { uri } }];
        restarted = await restart(dev);
        at = mark(dev);
        value(await restarted.pickSyncFolder(input));
        expect(storedConfig(dev)).toEqual(stored);
        expect(since(dev, at).writes).toEqual([]);
    });

    it('connectDropbox: a replay finds the account connected and proven, and signs in to nothing', async () => {
        const { dev, contract } = await start({ dropboxAppKey: 'app-key' });
        value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'dropbox' }));
        const input = { requestId: generateUUID() };
        value(await contract.connectDropbox(input));
        expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBe('cloud');
        const restarted = await restart(dev);
        const at = mark(dev);
        expect(await restarted.connectDropbox(input)).toEqual({ ok: true, value: { toasts: [] } });
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
    });

    it('disconnectDropbox: a replay finds Dropbox gone and disconnects nothing', async () => {
        const { dev, contract } = await start({
            dropboxAppKey: 'app-key', dropboxConnected: true,
            storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' },
        });
        const input = { requestId: generateUUID() };
        value(await contract.disconnectDropbox(input));
        expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBe('off');
        const restarted = await restart(dev);
        const at = mark(dev);
        const replayed = await restarted.disconnectDropbox(input);
        expect(replayed.ok).toBe(false);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        expect(dev.state.dropboxTokens).toBeNull();
    });

    it('setSyncPreference: a replay finds the option set, writes nothing and keeps a later change to another option', async () => {
        const { dev, contract } = await start({});
        const input = { requestId: generateUUID(), key: 'appearance' as const, value: true };
        expect(value(await contract.setSyncPreference(input))).toEqual({ changed: true });
        await useTaskStore.getState().updateSettings({
            syncPreferences: { ...useTaskStore.getState().settings.syncPreferences, language: true },
        });
        const restarted = await restart(dev);
        const at = mark(dev);
        expect(await restarted.setSyncPreference(input)).toEqual({ ok: true, value: { changed: false } });
        expect(since(dev, at).writes).toEqual([]);
        expect(useTaskStore.getState().settings.syncPreferences).toEqual({ appearance: true, language: true });
    });

    it('runSyncEncryptionAction, submit: a replay finds no flow open and runs no transition', async () => {
        const { dev, contract } = await start(WEBDAV_STORED);
        const act = (action: unknown, requestId?: string) => contract.runSyncEncryptionAction({ ...(requestId ? { requestId } : {}), action } as never);
        value(await act({ type: 'open', flow: 'enable' }));
        value(await act({ type: 'typed', field: 'next', value: 'correct horse' }));
        value(await act({ type: 'typed', field: 'confirm', value: 'correct horse' }));
        const input = { requestId: generateUUID(), action: { type: 'submit' as const, flow: 'enable' as const } };
        value(await contract.runSyncEncryptionAction(input));
        expect(device.encryption.state).toBe('enabled');
        const restarted = await restart(dev);
        const at = mark(dev);
        const replayed = await restarted.runSyncEncryptionAction(input);
        expect(replayed.ok).toBe(false);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
    });

    it('runSyncEncryptionAction: "Abandon setup" is offered while a change is unfinished, warns, and runs only on its submit', async () => {
        const { contract } = await start({ ...WEBDAV_STORED, encryption: { state: 'off', incomplete: 'enable' } });
        const t = (key: string) => en[key as keyof typeof en];
        const rows = async () => value(contract.getSyncSettings({ draft: {} } as never)).encryption!.rows;
        const abandon = (await rows()).find((row) => row.kind === 'action' && row.label === t('settings.syncEncryptionAbandon'));
        expect(abandon).toMatchObject({ action: { type: 'open', flow: 'abandon' }, enabled: true });
        expect((await rows()).some((row) => row.kind === 'text' && row.text === t('settings.syncEncryptionErrorTransitionIncomplete'))).toBe(true);
        // Also in an open flow, right where a retry just failed.
        value(await contract.runSyncEncryptionAction({ action: { type: 'open', flow: 'enable' } }));
        expect((await rows()).some((row) => row.kind === 'action' && row.label === t('settings.syncEncryptionAbandon'))).toBe(true);
        value(await contract.runSyncEncryptionAction({ action: { type: 'cancel' } }));
        value(await contract.runSyncEncryptionAction({ action: { type: 'open', flow: 'abandon' } }));
        const open = await rows();
        expect(open.some((row) => row.kind === 'text' && row.tone === 'warning' && row.text === t('settings.syncEncryptionAbandonWarning'))).toBe(true);
        expect(open.some((row) => row.kind === 'action' && row.label === t('settings.syncEncryptionEnable'))).toBe(false);
        expect(device.calls.some((call) => call[0] === 'abandonSyncEncryptionTransition')).toBe(false);
        value(await contract.runSyncEncryptionAction({ requestId: generateUUID(), action: { type: 'submit', flow: 'abandon' } }));
        expect(device.calls.filter((call) => call[0] === 'abandonSyncEncryptionTransition')).toHaveLength(1);
        const after = await rows();
        expect(after.some((row) => row.kind === 'action' && row.label === t('settings.syncEncryptionAbandon'))).toBe(false);
        expect(after.some((row) => row.kind === 'text' && row.tone === 'danger')).toBe(false);
        expect(after.some((row) => row.kind === 'action' && row.label === t('settings.syncEncryptionEnable'))).toBe(true);
    });

    it('runSyncEncryptionAction: a partly encrypted location offers only "Check this location again", which clears it once whole', async () => {
        const { contract } = await start({ ...WEBDAV_STORED, encryption: { state: 'off', partly: true }, queues: { recheck: ['mixed', 'plaintext'] } });
        const t = (key: string) => en[key as keyof typeof en];
        const rows = () => value(contract.getSyncSettings({ draft: {} } as never)).encryption!.rows;
        expect(rows().some((row) => row.kind === 'text' && row.tone === 'danger' && row.text === t('settings.syncEncryptionPartlyEncrypted'))).toBe(true);
        expect(rows().some((row) => row.kind === 'action' && row.label === t('settings.syncEncryptionEnable'))).toBe(false);
        const recheck = rows().find((row) => row.kind === 'action' && row.label === t('settings.syncEncryptionRecheck'));
        expect(recheck).toMatchObject({ action: { type: 'recheck' }, enabled: true });
        value(await contract.runSyncEncryptionAction({ action: { type: 'recheck' } }));
        expect(rows().some((row) => row.kind === 'text' && row.text === t('settings.syncEncryptionPartlyEncrypted'))).toBe(true);
        value(await contract.runSyncEncryptionAction({ action: { type: 'recheck' } }));
        expect(rows().some((row) => row.kind === 'text' && row.text === t('settings.syncEncryptionPartlyEncrypted'))).toBe(false);
        expect(rows().some((row) => row.kind === 'action' && row.label === t('settings.syncEncryptionEnable'))).toBe(true);
        expect(device.calls.filter((call) => call[0] === 'recheckPartlyEncryptedLocation')).toHaveLength(2);
    });

    it('runSyncEncryptionAction: a passphrase field states core\'s limit, and a longer text is refused in words', async () => {
        const { contract } = await start(WEBDAV_STORED);
        value(await contract.runSyncEncryptionAction({ action: { type: 'open', flow: 'enable' } }));
        const view = value(contract.getSyncSettings({ draft: {} } as never));
        const fields = view.encryption!.rows.filter((row) => row.kind === 'field');
        expect(fields.map((row) => row.kind === 'field' && [row.field, row.maxLength, row.tooLong])).toEqual([
            ['next', SYNC_ENCRYPTION_PASSPHRASE_MAX_LENGTH, en['settings.syncEncryptionPassphraseTooLong']],
            ['confirm', SYNC_ENCRYPTION_PASSPHRASE_MAX_LENGTH, en['settings.syncEncryptionPassphraseTooLong']],
        ]);
        expect(SYNC_ENCRYPTION_PASSPHRASE_MAX_LENGTH).toBe(1000);
        value(await contract.runSyncEncryptionAction({ action: { type: 'typed', field: 'next', value: 'x'.repeat(1000) } }));
        const refused = await contract.runSyncEncryptionAction({ action: { type: 'typed', field: 'next', value: 'x'.repeat(1001) } });
        expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: en['settings.syncEncryptionPassphraseTooLong'] } });
    });

    it('runSyncEncryptionAction, decline: a replay finds no unlock flow and declines nothing', async () => {
        const { dev, contract } = await start({ ...WEBDAV_STORED, encryption: { state: 'remote-encrypted-no-key' } });
        value(await contract.runSyncEncryptionAction({ action: { type: 'open', flow: 'unlock' } }));
        const input = { requestId: generateUUID(), action: { type: 'decline' as const } };
        value(await contract.runSyncEncryptionAction(input));
        expect(device.calls.some((call) => call[0] === 'declineSyncEncryptionPassphrase')).toBe(true);
        const restarted = await restart(dev);
        const at = mark(dev);
        expect((await restarted.runSyncEncryptionAction(input)).ok).toBe(false);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
    });

    it('openSyncSettings: a second open finds the stored backend already coerced and writes nothing', async () => {
        const { dev } = await start({
            foss: true, dropboxAppKey: 'app-key',
            storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' },
        });
        expect(dev.state.log).toEqual([
            ['setItem', SYNC_BACKEND_KEY, 'off'],
            ['setItem', CLOUD_PROVIDER_KEY, 'selfhosted'],
        ]);
        const at = mark(dev);
        await restart(dev);
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
    });

    it('openSyncSettings without the Dropbox port: a stored Dropbox backend survives the open and a restart untouched', async () => {
        const { dev } = await start({ dropboxAppKey: 'app-key', storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' } });
        delete (dev.host as { dropbox?: unknown }).dropbox;
        const at = mark(dev);
        const restarted = await restart(dev);
        expect(value(restarted.getSyncSettings()).panel).toMatchObject({ kind: 'dropbox' });
        const again = await restart(dev);
        expect(value(again.getSyncSettings()).backend.current).toBe('Dropbox');
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        expect(storedConfig(dev).storage).toEqual({ [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' });
    });

    it('a secret-bearing command keeps no payload: a retry joins the running request, and a finished one answers its first reply without running again', async () => {
        const { dev, contract } = await start({});
        value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'webdav' }));
        const input = { requestId: generateUUID(), revision: value(contract.getSyncSettings()).configRevision, webdav: { ...webdavFields, password: 'hunter22' } };
        const at = mark(dev);
        const [first, joined] = await Promise.all([contract.saveSyncBackend(input), contract.saveSyncBackend(input)]);
        expect(value(first).toasts.map((toast) => toast.tone)).toEqual(['success']);
        expect(joined).toBe(first);
        expect(since(dev, at).calls.filter((call) => call[0] === 'performMobileSync')).toHaveLength(2);
        const later = mark(dev);
        expect(await contract.saveSyncBackend(input)).toEqual(first);
        expect(since(dev, later)).toEqual({ device: [], writes: [], calls: [] });
    });

    it('closeSyncSettings: drops a staged backend; commands answer until the screen opens again', async () => {
        const { dev, contract } = await start({});
        value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'webdav' }));
        expect(value(contract.getSyncSettings()).panel?.kind).toBe('webdav');
        expect(contract.closeSyncSettings()).toEqual({ ok: true, value: null });
        expect(contract.getSyncSettings()).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect((await contract.syncNow({ requestId: generateUUID() })).ok).toBe(false);
        expect(value(contract.closeSyncSettings())).toBeNull();
        value(await contract.openSyncSettings());
        expect(value(contract.getSyncSettings()).panel).toBeNull();
        expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBeUndefined();
    });
});

describe('native host contract: Settings › Sync keeps secrets out of its views', () => {
    it('never shows a password, a token or a passphrase; masks are RN\'s dots', async () => {
        await seed({}, false);
        const dev = createDevice({ ...{ storage: { [WEBDAV_URL_KEY]: 'https://dav.example.com' } }, secrets: { [WEBDAV_PASSWORD_KEY]: 's3cret-pass', [CLOUD_TOKEN_KEY]: 'tok-abcdefghijklmnopqrstuvwxyz' } });
        const contract = await openHost(dev.host);
        const views: unknown[] = [value(await contract.openSyncSettings())];
        value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'webdav' }));
        views.push(value(contract.getSyncSettings()));
        const webdav = value(contract.getSyncSettings()).panel;
        expect(webdav?.kind === 'webdav' && webdav.password.mask).toBe('•'.repeat('s3cret-pass'.length));
        value(await contract.runSyncEncryptionAction({ action: { type: 'open', flow: 'enable' } }));
        value(await contract.runSyncEncryptionAction({ action: { type: 'typed', field: 'next', value: 'my passphrase words' } }));
        value(await contract.runSyncEncryptionAction({ action: { type: 'reveal' } }));
        views.push(value(contract.getSyncSettings()));
        value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'selfhosted' }));
        views.push(value(contract.getSyncSettings({ draft: { url: 'https://cloud.example.com', token: 'typed-token-abcdefghijklmnop' } })));
        const shown = JSON.stringify(views);
        for (const secret of ['s3cret-pass', 'tok-abcdefghijklmnopqrstuvwxyz', 'my passphrase words', 'typed-token-abcdefghijklmnop']) {
            expect(shown).not.toContain(secret);
        }
        contract.closeSyncSettings();
    });

    it('answers ACTION_FAILED for a host without sync, and for encryption actions until the host has the transitions', async () => {
        await seed({}, false);
        const bare = createNativeHostContract();
        value(await bare.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
        value(await bare.activate({ writeSafetyReady: true }));
        expect(await bare.openSyncSettings()).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });

        const dev = createDevice({ storage: { [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com' } });
        delete (dev.host.encryption as { transitions?: unknown }).transitions;
        const contract = await openHost(dev.host);
        const view = value(await contract.openSyncSettings());
        expect(view.encryption?.rows.map((row) => row.kind === 'action' && row.label)).toContain('Enable encryption');
        value(await contract.runSyncEncryptionAction({ action: { type: 'open', flow: 'enable' } }));
        expect(await contract.runSyncEncryptionAction({ action: { type: 'generate' } })).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        contract.closeSyncSettings();
    });

    it('never turns a stored Dropbox backend off because the host has not bound Dropbox yet', async () => {
        await seed({}, false);
        const dev = createDevice({ dropboxAppKey: 'app-key', storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' } });
        delete (dev.host as { dropbox?: unknown }).dropbox;
        const contract = await openHost(dev.host);
        const view = value(await contract.openSyncSettings());
        expect(dev.state.log).toEqual([]);
        expect(view.backend.options.find((option) => option.selected)?.option).toBe('dropbox');
        expect(view.panel).toMatchObject({ kind: 'dropbox', connected: false });
        expect(await contract.connectDropbox({ requestId: generateUUID() })).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(dev.state.log).toEqual([]);
        contract.closeSyncSettings();
    });

    it('refuses Connect where its control does not show, and every command while the screen opens', async () => {
        await seed({}, false);
        const dev = createDevice({});
        const contract = await openHost(dev.host);
        const opening = contract.openSyncSettings();
        expect(contract.getSyncSettings()).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'off' })).toMatchObject({ ok: false });
        value(await opening);
        // No app key: the build offers Dropbox, but choosing it shows no Dropbox panel.
        value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'dropbox' }));
        expect(value(contract.getSyncSettings()).panel).toBeNull();
        device.calls.length = 0;
        expect(await contract.connectDropbox({ requestId: generateUUID() })).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(device.calls).toEqual([]);
        contract.closeSyncSettings();
    });
});

// ---------------------------------------------------------------------------
// Correction pass (review.md findings 1-7).

describe('native host contract: Settings › Sync correction pass', () => {
    const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
    const CREDENTIAL_URL = 'https://alice:s3cret-pw@dav.example.com/mindwtr';

    it('1: turns a backend the build cannot run off when Sync opens, as React Native does, but never because a port is unbound', async () => {
        const coerced = { [SYNC_BACKEND_KEY]: 'off', [CLOUD_PROVIDER_KEY]: 'selfhosted' };
        let { dev } = await start({ foss: true, dropboxAppKey: 'app-key', storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' } });
        expect(storedConfig(dev).storage).toEqual(coerced);
        ({ dev } = await start({ storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' } }));
        expect(storedConfig(dev).storage).toEqual(coerced);
        ({ dev } = await start({ storage: { [SYNC_BACKEND_KEY]: 'cloudkit', [CLOUD_PROVIDER_KEY]: 'cloudkit' } }));
        expect(storedConfig(dev).storage).toEqual(coerced);
        // The build supports Dropbox; only the host's Dropbox port is missing.
        dev = createDevice({ dropboxAppKey: 'app-key', storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' } });
        delete (dev.host as { dropbox?: unknown }).dropbox;
        value(await (await openHost(dev.host)).openSyncSettings());
        expect(dev.state.log).toEqual([]);
    });

    it('2: answers SAVE_FAILED when Off cannot be stored, keeps showing the stored backend, and the exact retry stores Off', async () => {
        const { dev, contract } = await start(WEBDAV_STORED);
        dev.state.failKeys.add(SYNC_BACKEND_KEY);
        const input = { requestId: generateUUID(), option: 'off' as const };
        expect(await contract.selectSyncBackend(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBe('webdav');
        expect(value(contract.getSyncSettings()).backend.options.find((option) => option.selected)?.option).toBe('webdav');
        dev.state.failKeys.clear();
        value(await contract.selectSyncBackend(input));
        expect(dev.state.storage.get(SYNC_BACKEND_KEY)).toBe('off');
        expect(value(contract.getSyncSettings()).off).not.toBeNull();
    });

    it('3: refuses a save made on a stored configuration that changed since (STALE_REVISION), so a replay never restores an older server', async () => {
        const { dev, contract } = await start({});
        value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'webdav' }));
        const older = { requestId: generateUUID(), revision: value(contract.getSyncSettings()).configRevision, webdav: { ...webdavFields, url: 'https://a.example.com', password: 'pw-a' } };
        value(await contract.saveSyncBackend(older));
        const newer = { requestId: generateUUID(), revision: value(contract.getSyncSettings()).configRevision, webdav: { ...webdavFields, url: 'https://b.example.com', password: 'pw-b' } };
        expect(newer.revision).not.toBe(older.revision);
        value(await contract.saveSyncBackend(newer));
        const restarted = await restart(dev);
        const at = mark(dev);
        expect(await restarted.saveSyncBackend(older)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(await restarted.syncNow({ requestId: generateUUID(), revision: older.revision, webdav: older.webdav })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        expect(dev.state.storage.get(WEBDAV_URL_KEY)).toBe('https://b.example.com');
    });

    it('4: shows a URL\'s credentials only in the URL field: never in the status, the history or a toast', async () => {
        const failure = `PUT ${CREDENTIAL_URL}/data.json failed`;
        const { contract } = await start({
            storage: { [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: CREDENTIAL_URL, [WEBDAV_USERNAME_KEY]: 'alice' },
            secrets: { [WEBDAV_PASSWORD_KEY]: 'hunter22' },
            queues: { probe: [{ error: `GET ${CREDENTIAL_URL}/data.json returned 500` }] },
        }, {
            lastSyncStatus: 'error', lastSyncError: failure,
            lastSyncHistory: [{ at: '2026-09-24T10:00:00.000Z', status: 'error', conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0, error: failure, details: failure }],
        });
        const tested = value(await contract.testSyncConnection({ webdav: { ...webdavFields, url: CREDENTIAL_URL } }));
        const view = value(contract.getSyncSettings());
        expect(view.panel?.kind === 'webdav' && view.panel.url.value).toBe(CREDENTIAL_URL);
        const elsewhere = { ...view, panel: { ...view.panel, url: undefined } };
        expect(JSON.stringify([elsewhere, tested])).not.toContain('s3cret-pw');
        expect(view.panel?.lastSync.error).toBe('PUT https://dav.example.com/mindwtr/data.json failed');
    });

    it('5: never echoes the password or token in a failure toast', async () => {
        const { contract } = await start({
            storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'selfhosted', [CLOUD_URL_KEY]: 'https://cloud.example.com' },
            secrets: { [CLOUD_TOKEN_KEY]: TOKEN },
            queues: {
                cloudGet: [{ error: `401 for Bearer ${TOKEN}` }],
                sync: [{ value: { success: false, error: `server echoed ${TOKEN} and token=${TOKEN}` } }],
            },
        });
        const fields = { url: 'https://cloud.example.com', token: null, allowInsecureHttp: false };
        const tested = value(await contract.testSyncConnection({ selfHosted: fields }));
        const synced = value(await contract.syncNow({ requestId: generateUUID(), revision: value(contract.getSyncSettings()).configRevision, selfHosted: fields }));
        expect(tested.toasts).toHaveLength(1);
        expect(synced.toasts).toHaveLength(1);
        expect(JSON.stringify([tested, synced])).not.toContain(TOKEN);
    });

    it('6: refuses a submit that reuses a request UUID with other passphrases (INVALID_INPUT), and never runs it', async () => {
        const { contract } = await start({ ...WEBDAV_STORED, queues: { enable: [{ error: 'MWENC1: could not write' }] } });
        const act = (action: unknown, requestId?: string) => contract.runSyncEncryptionAction({ ...(requestId ? { requestId } : {}), action } as never);
        value(await act({ type: 'open', flow: 'enable' }));
        value(await act({ type: 'typed', field: 'next', value: 'first phrase' }));
        value(await act({ type: 'typed', field: 'confirm', value: 'first phrase' }));
        const requestId = generateUUID();
        value(await act({ type: 'submit', flow: 'enable' }, requestId));
        expect(device.calls.filter((call) => call[0] === 'enableSyncEncryption')).toHaveLength(1);
        value(await act({ type: 'typed', field: 'next', value: 'second phrase' }));
        value(await act({ type: 'typed', field: 'confirm', value: 'second phrase' }));
        expect(await act({ type: 'submit', flow: 'enable' }, requestId)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(device.calls.filter((call) => call[0] === 'enableSyncEncryption')).toHaveLength(1);
        value(await act({ type: 'submit', flow: 'enable' }, generateUUID()));
        expect(device.calls.filter((call) => call[0] === 'enableSyncEncryption')).toHaveLength(2);
    });

    it('7: answers a cancelled open, and leaves the toasts queued, when the screen closed or opened again while it read', async () => {
        await seed({}, false);
        const dev = createDevice({ foss: true, storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' } });
        const contract = await openHost(dev.host);
        const closed = contract.openSyncSettings();
        contract.closeSyncSettings();
        expect(await closed).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        const replaced = contract.openSyncSettings();
        const current = contract.openSyncSettings();
        expect(await replaced).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(value(await current).backend.current).toBe('Off');
        contract.closeSyncSettings();
    });
});

// ---------------------------------------------------------------------------
// Correction pass (verification of e43ac25eb, review.md).

describe('native host contract: Settings › Sync verification pass', () => {
    const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
    const CREDENTIAL_URL = 'https://alice:s3cret-pw@dav.example.com/mindwtr';

    it('2: keeps URL credentials and configured secrets out of a SAVE_FAILED message and the error log', async () => {
        const { dev, contract } = await start({
            storage: { [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: CREDENTIAL_URL, [WEBDAV_USERNAME_KEY]: 'alice', [CLOUD_URL_KEY]: 'https://cloud.example.com' },
            secrets: { [WEBDAV_PASSWORD_KEY]: 'hunter22', [CLOUD_TOKEN_KEY]: TOKEN },
        });
        dev.state.failKeys.add(SYNC_BACKEND_KEY);
        const setItem = dev.host.storage.setItem;
        dev.host.storage.setItem = async (key, entry) => {
            if (key === SYNC_BACKEND_KEY) throw new Error(`EACCES writing ${CREDENTIAL_URL} with hunter22 and ${TOKEN}`);
            return setItem(key, entry);
        };
        const refused = await contract.selectSyncBackend({ requestId: generateUUID(), option: 'off' });
        expect(refused).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(device.logged.length).toBeGreaterThan(0);
        const shown = JSON.stringify([refused, device.logged]);
        for (const secret of ['s3cret-pw', 'hunter22', TOKEN]) expect(shown).not.toContain(secret);
    });

    it('4: keeps a configured token out of the last-sync error and the history', async () => {
        const failure = `server rejected ${TOKEN}`;
        const { contract } = await start({
            storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'selfhosted', [CLOUD_URL_KEY]: 'https://cloud.example.com' },
            secrets: { [CLOUD_TOKEN_KEY]: TOKEN },
        }, {
            lastSyncStatus: 'error', lastSyncError: failure,
            lastSyncHistory: [{ at: '2026-09-24T10:00:00.000Z', status: 'error', conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0, error: failure, details: failure }],
        });
        const view = value(contract.getSyncSettings());
        expect(view.panel?.lastSync.error).toBe('server rejected [redacted]');
        expect(JSON.stringify(view)).not.toContain(TOKEN);
    });

    it('3: redacts a short configured password as a whole word, never inside a longer one', async () => {
        const { contract } = await start({
            storage: { [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com', [WEBDAV_USERNAME_KEY]: 'alice' },
            secrets: { [WEBDAV_PASSWORD_KEY]: 'abc' },
            queues: { probe: [{ error: 'login abc refused (abcdef is fine)' }] },
        });
        const tested = value(await contract.testSyncConnection({ webdav: { ...webdavFields, url: 'https://dav.example.com' } }));
        expect(tested.toasts.map((toast) => toast.message)).toEqual(['login [redacted] refused (abcdef is fine)']);
    });

    it('5: tells two passphrases apart even where a 32-bit fingerprint collides', async () => {
        const { contract } = await start({ ...WEBDAV_STORED, queues: { enable: [{ error: 'MWENC1: could not write' }] } });
        const act = (action: unknown, requestId?: string) => contract.runSyncEncryptionAction({ ...(requestId ? { requestId } : {}), action } as never);
        const phrase = async (text: string) => {
            value(await act({ type: 'typed', field: 'next', value: text }));
            value(await act({ type: 'typed', field: 'confirm', value: text }));
        };
        value(await act({ type: 'open', flow: 'enable' }));
        await phrase('phrase-rt8llz-1npot9b');
        const requestId = generateUUID();
        value(await act({ type: 'submit', flow: 'enable' }, requestId));
        await phrase('phrase-p8nb0t-z1kpvy');
        expect(await act({ type: 'submit', flow: 'enable' }, requestId)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('6: answers a same-session replay of an older save with its first reply, and writes nothing (the newer server stays)', async () => {
        const { dev, contract } = await start({});
        value(await contract.selectSyncBackend({ requestId: generateUUID(), option: 'webdav' }));
        const older = { requestId: generateUUID(), revision: value(contract.getSyncSettings()).configRevision, webdav: { ...webdavFields, url: 'https://a.example.com', password: 'pw-a' } };
        const first = value(await contract.saveSyncBackend(older));
        value(await contract.saveSyncBackend({ requestId: generateUUID(), revision: value(contract.getSyncSettings()).configRevision, webdav: { ...webdavFields, url: 'https://b.example.com', password: 'pw-b' } }));
        const at = mark(dev);
        expect(await contract.saveSyncBackend(older)).toEqual({ ok: true, value: first });
        expect(since(dev, at)).toEqual({ device: [], writes: [], calls: [] });
        expect(dev.state.storage.get(WEBDAV_URL_KEY)).toBe('https://b.example.com');
    });
});

// ---------------------------------------------------------------------------
// Final pass: the redaction set holds every credential the transport knows.

describe('native host contract: Settings › Sync redaction set', () => {
    it('7: keeps stored and refreshed Dropbox tokens out of a failure toast', async () => {
        const { contract } = await start({
            dropboxAppKey: 'app-key', dropboxConnected: true,
            storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' },
            queues: { dropboxTest: [{ error: 'HTTP 401 unauthorized' }, { error: 'server echoed refreshed-access, stored-access and stored-refresh' }] },
        });
        const tested = value(await contract.testSyncConnection({}));
        expect(tested.toasts.map((toast) => toast.message)).toEqual(['server echoed [redacted], [redacted] and [redacted]']);
    });

    it('8: keeps an unsaved draft URL\'s password out of a Test failure toast', async () => {
        const { contract } = await start({
            storage: { [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example.com', [WEBDAV_USERNAME_KEY]: 'alice' },
            secrets: { [WEBDAV_PASSWORD_KEY]: 'hunter22' },
            queues: { probe: [{ error: 'login alice/draft-pw refused' }] },
        });
        const tested = value(await contract.testSyncConnection({ webdav: { ...webdavFields, url: 'https://alice:draft-pw@dav.example.com' } }));
        expect(tested.toasts.map((toast) => toast.message)).toEqual(['login alice/[redacted] refused']);
    });
});

// ---------------------------------------------------------------------------
// The native Android pass (S3): the Sync row opens, the screen's commands never reach the
// journal or durable receipts, and dates follow the device locale as React Native's do.

describe('native host contract: Settings › Sync on the native host (S3)', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = 'UTC';
    });
    afterAll(() => {
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it('enables the Settings menu\'s Sync row', async () => {
        const { contract } = await start({});
        const menu = value(contract.getSettingsMenu());
        expect(menu.groups.flat().find((row) => row.id === 'sync')?.enabled).toBe(true);
    });

    it('keeps every screen command out of the journal and durable receipts', () => {
        for (const name of NATIVE_SYNC_SETTINGS_UNJOURNALED_COMMANDS) expect(NATIVE_UNJOURNALED_COMMANDS.has(name)).toBe(true);
    });

    it.each(['en-US', 'de-DE', 'ja-JP', 'zh-CN', 'en-GB'])('draws the history dates as React Native\'s toLocaleString does on a %s device', async (locale) => {
        await seed({
            lastSyncStatus: 'success', lastSyncAt: '2026-09-24T14:05:09.000Z',
            lastSyncHistory: [{ at: '2026-09-24T14:05:09.000Z', status: 'success', conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 }],
        }, false);
        const dev = createDevice(WEBDAV_STORED);
        const contract = createNativeHostContract({ syncSettings: dev.host });
        value(await contract.setLanguage({ storedLanguage: 'en', systemLocale: locale }));
        expect(await contract.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
        value(await contract.openSyncSettings());
        const shown = new Date('2026-09-24T14:05:09.000Z').toLocaleString(locale);
        const card = value(contract.getSyncSettings()).panel?.lastSync;
        expect(card?.history?.entries.some((entry) => entry.includes(shown))).toBe(true);
        expect(card?.status).toContain(shown);
    });
});
