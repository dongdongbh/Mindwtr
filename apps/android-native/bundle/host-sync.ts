import { createNativeIosDropbox, type NativeIosDropboxCapability } from './host-ios-dropbox';
import { createNativeFileSync, prepareNativeFileSync, type NativeFileSyncCall, type NativeFileSyncSelection, type NativeFileSyncLease, type NativeFileSyncPort } from './host-file-sync';
import { DOMParser } from '@xmldom/xmldom';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createNativeAttachments, nativeFileChannels, type NativeAttachmentBindings } from './host-attachments';
import {
    MOBILE_BACKGROUND_SYNC_DEADLINE_MS,
    NativeAttachmentCleanupUnconfirmedError,
    SETTINGS_SYNC_BADGE_COLORS,
    CLOUD_PROVIDER_KEY,
    SYNC_BACKEND_KEY,
    SyncCryptoAuthError,
    SyncEncryptionArtifactCapacityError,
    SyncEncryptionTransitionIncompleteError,
    buildDiagnosticsErrorEntry,
    buildDiagnosticsLogEntry,
    classifySyncFailure,
    coerceSupportedBackend,
    createAutoSyncController,
    createMobileFileSync,
    createMobileFileSyncLeases,
    createMobileBackgroundSyncRunner,
    createMobileSyncService,
    createMobileSyncTriggers,
    createSecureSyncConfigStore,
    createSyncEncryptionService,
    createSyncEncryptionStateStore,
    createSyncSecretVault,
    createWebdavCapabilityProofStore,
    einkSafeColor,
    flushPendingSave,
    generateUUID,
    getInMemorySyncChangeFingerprint,
    getMobileAutoSyncCadence,
    getMobileWebDavRequestOptions,
    getSyncConflictCount,
    isLikelyOfflineSyncError,
    loadWebDavSyncConfig,
    nameNotifyListener,
    normalizeExternalCalendarColor,
    normalizeCloudProvider,
    readSyncLocationScope,
    resolveBackend,
    resolveSyncBadgeState,
    runManualPullSync,
    sanitizeLogMessage,
    setSha256HexProvider,
    shouldScheduleMobileBackgroundSync,
    themeDescriptor,
    useTaskStore,
    FileSyncRetainedGenerationError,
    FileSyncUnverifiedReadError,
    SyncFileLockBusyError,
    SyncFileLockIdentityLostError,
    SyncFileLockUnavailableError,
    type AppData,
    type SqliteAdapter,
    type MobileFileSyncFullHost,
    type MobileFileSyncLease,
    type MobileFileSyncSafPort,
    type AutoSyncController,
    type DiagnosticsLogEntry,
    type MobileBackgroundSyncTrigger,
    type MobileSyncNetworkState,
    type MobileSyncCloudKitPort,
    type MobileSyncTriggers,
    type NativeSyncSettingsHost,
    type SyncBadgeState,
    type SyncCryptoPrimitives,
    type SyncSecretStoragePort,
    type SyncSecretAccessibility,
} from '@mindwtr/core';


export type HostKeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    multiGet(keys: readonly string[]): Promise<[string, string | null][]>;
    multiSet(pairs: readonly (readonly [string, string])[]): Promise<void>;
};

export type NativeSyncBindings = {
    dropbox?: NativeIosDropboxCapability;
    keyValue: HostKeyValue;
    cloudKit?: Omit<MobileSyncCloudKitPort, 'syncAttachments'> & NonNullable<NativeSyncSettingsHost['cloudKit']> & {
        assets: NonNullable<NativeAttachmentBindings['cloudKit']>;
    };
    fileSync?: { canonicalPath: string; port: NativeFileSyncPort };
    performFileSync?: NativeSyncSettingsHost['performSync'];
    pickSyncFolder?: NativeSyncSettingsHost['pickSyncFolder'];
    secrets: { getSecret(key: string): Promise<string | null>; setSecret(key: string, value: string, accessibility?: SyncSecretAccessibility): Promise<void>; deleteSecret(key: string): Promise<void> };

    localData: () => Pick<SqliteAdapter, 'getData' | 'saveData' | 'readTokenOf' | 'prepareSaveRows'>;

    networkState: () => MobileSyncNetworkState;

    appendLog: (entry: DiagnosticsLogEntry, force?: boolean) => Promise<string | null>;

    translate: (key: string) => string;

    emit: (event: Record<string, unknown>) => void;

    trace: (line: string) => void;

    scheduleBackgroundSync: (on: boolean) => void;

    isFossBuild: boolean;

    retireLocalAttachment?: NativeAttachmentBindings['retireLocalAttachment'];

    listRecoverySnapshots?: () => Promise<string[]>;
};


type HostCryptoCall = (request: Record<string, unknown>) => Promise<Uint8Array>;

const unavailableCipher = (): never => {
    throw new Error('Sync encryption is not available on this build yet');
};


export const createHostSyncCrypto = (call: HostCryptoCall | undefined): SyncCryptoPrimitives => {
    if (!call) {
        return { argon2id: async () => unavailableCipher(), aesGcmSeal: async () => unavailableCipher(), aesGcmOpen: async () => unavailableCipher(), randomBytes: () => unavailableCipher() };
    }
    return {
        argon2id: (pass, salt, params, dkLen) => call({ op: 'argon2id', pass, salt, m: params.mKib, t: params.t, p: params.p, dkLen }),
        aesGcmSeal: (key, nonce, plaintext, aad) => call({ op: 'aesGcmSeal', key, nonce, data: plaintext, aad }),
        aesGcmOpen: async (key, nonce, ctAndTag, aad) => {
            try {
                return await call({ op: 'aesGcmOpen', key, nonce, data: ctAndTag, aad });
            } catch (error) {
                if ((error as { code?: unknown } | null)?.code === 'auth') throw new SyncCryptoAuthError();
                throw error;
            }
        },
        randomBytes: (n) => {
            const bytes = new Uint8Array(n);
            globalThis.crypto.getRandomValues(bytes);
            return bytes;
        },
    };
};


const EXTERNAL_CALENDARS_KEY = 'mindwtr-external-calendars';

type ExternalCalendar = NonNullable<AppData['settings']['externalCalendars']>[number];


export const createDeadlineFetch = (send: typeof fetch) => {
    let deadline: number | null = null;
    return {
        setDeadline: (at: number | null) => { deadline = at; },
        fetch: ((input, init) => (deadline !== null && Date.now() >= deadline
            ? Promise.reject(Object.assign(new Error('The background sync deadline passed'), { name: 'AbortError' }))
            : send(input, init))) as typeof fetch,
    };
};

const unavailable = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available on this build yet`);
};


export type HostDocumentCall = (request: Record<string, unknown>, bytes?: Uint8Array) => Promise<{ value: unknown; bytes: Uint8Array | null }>;

export type HostSyncLockCall = (request: Record<string, unknown>) => Promise<unknown>;

const refusePath = (): never => {
    throw new Error('File Sync paths (file://) are not available on this host: pick a folder in Settings › Sync');
};


export const createHostSafPort = (call: HostDocumentCall): MobileFileSyncSafPort => ({
    listChildren: async (uri) => (await call({ op: 'listChildren', uri })).value as Awaited<ReturnType<MobileFileSyncSafPort['listChildren']>>,
    stat: async (uri) => (await call({ op: 'stat', uri })).value as Awaited<ReturnType<MobileFileSyncSafPort['stat']>>,
    readBytes: async (uri) => {
        const read = await call({ op: 'read', uri });
        return { bytes: read.bytes ?? new Uint8Array(0), lengthVerified: (read.value as { lengthVerified?: unknown } | null)?.lengthVerified === true };
    },
    writeBytes: async (uri, bytes) => { await call({ op: 'write', uri }, bytes); },
    writeText: async (uri, text) => { await call({ op: 'write', uri }, new TextEncoder().encode(text)); },
    createFile: async (uri, name, mimeType) => (await call({ op: 'createFile', uri, name, mimeType })).value as string,
    delete: async (uri) => { await call({ op: 'delete', uri }); },
    makeDirectory: async (uri, name) => (await call({ op: 'makeDirectory', uri, name })).value as string,
    rename: async (uri, name) => (await call({ op: 'rename', uri, name })).value as { uri: string; name: string },
});


export const isNativeIosSelfHostedProvider = (value: string | null | undefined): boolean => {
    const provider = value?.trim() || null;
    return (provider === null || provider === 'selfhosted') && normalizeCloudProvider(provider) === 'selfhosted';
};

export const createNativeSync = (bindings: NativeSyncBindings, fileEncryptionState?: ReturnType<typeof createSyncEncryptionStateStore>) => {
    const platform = (globalThis as typeof globalThis & { __mindwtrHostPlatform?: unknown }).__mindwtrHostPlatform === 'ios' ? 'ios' : 'android';
    const cloudKitBinding = platform === 'ios' ? bindings.cloudKit : undefined;
    if (platform === 'ios' && typeof bindings.retireLocalAttachment !== 'function') {
        throw new Error('Foreground sync requires owned attachment cleanup on this iOS build');
    }
    const channels = nativeFileChannels();
    if (platform === 'ios' && !channels) {
        throw new Error('Foreground sync requires native attachment files on this iOS build');
    }


    if (!channels) setSha256HexProvider((bytes) => bytesToHex(sha256(bytes)));
    const { keyValue } = bindings;
    const storage = {
        getItem: (key: string) => keyValue.get(key),
        setItem: (key: string, value: string) => keyValue.set(key, value),
        removeItem: (key: string) => keyValue.remove(key),
    };


    const logLine = (level: 'info' | 'warn', message: string, context?: { scope?: string; extra?: Record<string, unknown>; force?: boolean }) =>
        bindings.appendLog(buildDiagnosticsLogEntry(level, message, context), context?.force).catch(() => null);
    const logError = (error: unknown, context: { scope: string; url?: string; extra?: Record<string, unknown> }) =>
        bindings.appendLog(buildDiagnosticsErrorEntry(error, context)).catch(() => null);


    const secretStorage: SyncSecretStoragePort = {
        isAvailable: async () => true,
        getItem: (key) => bindings.secrets.getSecret(key),
        setItem: (key, value, accessibility) => platform === 'ios'
            ? bindings.secrets.setSecret(key, value, accessibility)
            : bindings.secrets.setSecret(key, value),
        deleteItem: (key) => bindings.secrets.deleteSecret(key),
    };
    const vault = createSyncSecretVault(secretStorage);
    const secureConfig = createSecureSyncConfigStore({ storage, secrets: secretStorage, vault });
    const dropbox = platform === 'ios' && !bindings.isFossBuild && bindings.dropbox
        ? createNativeIosDropbox(bindings.dropbox, { storage, secrets: secretStorage, vault, fetch: (input, init) => fetch(input, init) }) : null;
    const encryptionState = fileEncryptionState ?? createSyncEncryptionStateStore({
        storage,
        secureConfig,
        readActiveScope: () => readSyncLocationScope(storage),
        log: { info: (message, context) => logLine('info', message, context), warn: (message, context) => logLine('warn', message, context) },
    });
    const capabilityProof = createWebdavCapabilityProofStore(storage);

    const crypto = createHostSyncCrypto((globalThis as { __mindwtrCryptoCall?: HostCryptoCall }).__mindwtrCryptoCall);


    const documentCall = (globalThis as { __mindwtrDocumentCall?: HostDocumentCall }).__mindwtrDocumentCall;
    const syncLockCall = (globalThis as { __mindwtrSyncLockCall?: HostSyncLockCall }).__mindwtrSyncLockCall;

    (globalThis as { __mindwtrLockReleasedLate?: (released: boolean) => void }).__mindwtrLockReleasedLate = (released) => {
        void logLine(released ? 'info' : 'warn', 'Native Android File Sync lease released after a cancelled acquire', {
            scope: 'sync', extra: { releaseCheck: 'v1.3.8/native-file-sync-late-release', outcome: released ? 'released' : 'failed' },
        });
    };
    const safPort = documentCall ? createHostSafPort(documentCall) : null;
    const fileSyncHost: MobileFileSyncFullHost = {
        os: () => platform,
        saf: safPort,
        path: {
            exists: () => false,
            info: refusePath,
            list: refusePath,
            readBytes: refusePath,
            readText: refusePath,
            writeBytes: refusePath,
            createExclusive: refusePath,
            writeCreated: refusePath,
            delete: refusePath,
            rename: refusePath,
        },
        bookmarks: { supported: () => false, readText: async () => null },
        log: {
            info: (message, context) => { void logLine('info', message, context); },
            warn: (message, context) => { void logLine('warn', message, context); },
            error: (error, context) => { void logError(error, { scope: context?.scope ?? 'sync', extra: context?.extra }); },
        },
        encryption: {
            localState: encryptionState.syncEncryptionLocalState,
            flush: () => encryptionState.flushSyncEncryptionLocalState(),
            logEvent: (event, extra) => encryptionState.logSyncEncryptionEvent(event, extra),
        },
        crypto,
    };
    const fileSync = createMobileFileSync(fileSyncHost);
    const leases = createMobileFileSyncLeases({
        platform: () => platform,
        nativeModule: () => (syncLockCall ? {

            acquireAsync: async (uri: string) => (uri.startsWith('content://') ? await syncLockCall({ op: 'acquire', uri }) as string : refusePath()),
            revalidateAsync: async (token: string) => { await syncLockCall({ op: 'revalidate', token }); },
            releaseAsync: async (token: string) => { await syncLockCall({ op: 'release', token }); },
        } : null),
    });


    const transitions = createSyncEncryptionService<MobileFileSyncLease>({
        maxEncryptedArtifactBytes: platform === 'ios' ? 8 * 1024 * 1024 : undefined,
        storage,
        state: encryptionState,
        crypto,
        fetch: (input, init) => fetch(input, init),
        parseWebdavXml: (source) => {
            const errors: string[] = [];
            const document = new DOMParser({
                errorHandler: (level, message) => errors.push(`${level}: ${String(message)}`),
            }).parseFromString(source, 'application/xml') as unknown as Document;
            return { document, errors };
        },
        loadWebDavConfig: () => loadWebDavSyncConfig(storage, (key) => secureConfig.getSecureConfigValue(key)),
        webDavRequestOptions: (allowInsecureHttp) => getMobileWebDavRequestOptions(allowInsecureHttp),
        getDropboxClientId: async () => { dropbox?.assertCurrent(); return dropbox?.configuration.clientId ?? ''; },
        runDropboxAuthorized: dropbox ? dropbox.runAuthorized : unavailable('Dropbox'),

        ...(safPort ? {
            fileSync: {
                acquireLease: (syncPath: string) => leases.acquire(syncPath),
                openRemotePort: (syncPath: string) => fileSync.createFileSyncEncryptionRemotePort(syncPath),
                revalidateLease: (lease: MobileFileSyncLease) => leases.revalidate(lease),
                releaseLease: (lease: MobileFileSyncLease) => leases.release(lease),
                isLeaseIdentityLostError: (error: unknown) => error instanceof SyncFileLockIdentityLostError,
            },
        } : {}),
    });


    let fileCycle: { outcome: string | null; provider: string; retained: number } | null = null;
    const takeFileCycle = () => {
        const ended = fileCycle;
        fileCycle = null;
        return ended;
    };
    const noteFileSync = async <T>(uri: string, run: () => Promise<T>, starts = false): Promise<T> => {
        const provider = /^content:\/\/([^/]+)/.exec(uri)?.[1] ?? 'none';
        if (starts) fileCycle = { outcome: null, provider, retained: 0 };
        else fileCycle ??= { outcome: null, provider, retained: 0 };
        try {
            return await run();
        } catch (error) {
            if (fileCycle && !fileCycle.outcome) {
                if (error instanceof FileSyncRetainedGenerationError) fileCycle.retained = error.retained;
                fileCycle.outcome = error instanceof SyncFileLockBusyError ? 'lock-busy'
                    : error instanceof SyncFileLockUnavailableError ? 'lock-unavailable'
                    : error instanceof FileSyncRetainedGenerationError ? 'retained-refused'
                    : error instanceof FileSyncUnverifiedReadError ? 'unverified-read'
                    : String(error).includes('SAF_DOCUMENT_INCOMPLETE') ? 'incomplete-read'
                    : 'failed';
            }
            throw error;
        }
    };

    const networkListeners = new Set<(state: MobileSyncNetworkState) => void>();


    const attachments = channels ? createNativeAttachments({
        ...(cloudKitBinding ? { cloudKit: cloudKitBinding.assets } : {}),
        storage,
        ...(dropbox ? { dropboxAuth: dropbox.auth, getDropboxClientId: async () => { dropbox.assertCurrent(); return dropbox.configuration.clientId; }, maxDropboxBufferedUploadBytes: 8 * 1024 * 1024 } : {}),
        getSecureConfigValue: (key) => secureConfig.getSecureConfigValue(key),
        log: {
            info: (message, context) => logLine('info', message, context),
            warn: (message, context) => logLine('warn', message, context),
            sanitize: (message) => sanitizeLogMessage(message),
        },
        crypto,
        retireLocalAttachment: bindings.retireLocalAttachment,
        ...(bindings.fileSync ? { fileSync: bindings.fileSync.port.attachments } : {}),
        saf: safPort,
        maxWebdavBufferedUploadBytes: platform === 'ios' ? 8 * 1024 * 1024 : undefined,
        maxCloudBufferedUploadBytes: platform === 'ios' ? 8 * 1024 * 1024 : undefined,
        encryption: {
            logSyncEncryptionEvent: (event, extra, options) => encryptionState.logSyncEncryptionEvent(event, extra, options),
            getSyncEncryptionMaterial: () => encryptionState.getSyncEncryptionMaterial(),
        },
    }, channels) : null;
    const cloudKit = cloudKitBinding && attachments?.syncCloudKitAttachments
        ? { ...cloudKitBinding, syncAttachments: attachments.syncCloudKitAttachments } : undefined;

    const syncFetch = createDeadlineFetch((input, init) => fetch(input, init));
    const service = createMobileSyncService<MobileFileSyncLease | NativeFileSyncLease>({
        ...(cloudKit ? { cloudKit } : {}),
        allowQueuedFollowUp: platform !== 'ios',
        storage,
        getSecureConfigValue: (key) => secureConfig.getSecureConfigValue(key),
        platform: { os: () => platform, isFossBuild: bindings.isFossBuild, dropboxAppKey: () => dropbox?.configuration.clientId ?? '' },
        network: {
            getState: async () => bindings.networkState(),
            subscribe: (listener) => {
                networkListeners.add(listener);
                return { remove: () => { networkListeners.delete(listener); } };
            },
        },
        localData: {
            getData: (options) => bindings.localData().getData(options),
            saveData: (data, options) => bindings.localData().saveData(data, options),
            readTokenOf: (data) => bindings.localData().readTokenOf(data),
            prepareSave: (data) => bindings.localData().prepareSaveRows(data),
        },


        ...(platform === 'android' ? { sliceYield: () => new Promise<void>((resolve) => { setTimeout(resolve, 0); }) } : {}),
        log: {
            info: (message, context) => logLine('info', message, context),
            warn: (message, context) => logLine('warn', message, context),
            syncError: (error, context) => logError(error, { scope: 'sync', url: context.url, extra: { backend: context.backend, step: context.step } }),
            sanitize: (message) => sanitizeLogMessage(message),
        },

        externalCalendars: {
            load: async () => {
                let parsed: ExternalCalendar[] = [];
                try {
                    const raw = await keyValue.get(EXTERNAL_CALENDARS_KEY);
                    parsed = raw ? JSON.parse(raw) as ExternalCalendar[] : [];
                } catch {
                    parsed = [];
                }
                return (Array.isArray(parsed) ? parsed : [])
                    .filter((c) => c && typeof c.url === 'string')
                    .map((c) => ({
                        id: c.id || generateUUID(),
                        name: (c.name || 'Calendar').trim() || 'Calendar',
                        url: c.url.trim(),
                        enabled: c.enabled !== false,
                        color: normalizeExternalCalendarColor(c.color),
                        ...(Array.isArray(c.areaIds) ? { areaIds: c.areaIds } : {}),
                    }))
                    .filter((c) => c.url.length > 0);
            },
            save: async (calendars) => {
                const sanitized = calendars
                    .map((c) => ({
                        id: c.id || generateUUID(),
                        name: (c.name || 'Calendar').trim() || 'Calendar',
                        url: (c.url || '').trim(),
                        enabled: c.enabled !== false,
                        color: normalizeExternalCalendarColor(c.color),
                        ...(Array.isArray(c.areaIds) ? { areaIds: c.areaIds } : {}),
                    }))
                    .filter((c) => c.url.length > 0);
                await keyValue.set(EXTERNAL_CALENDARS_KEY, JSON.stringify(sanitized));
            },
        },
        fetch: syncFetch.fetch,
        crypto,
        encryption: {
            flushSyncEncryptionLocalState: () => encryptionState.flushSyncEncryptionLocalState(),
            getSyncEncryptionStatus: () => encryptionState.getSyncEncryptionStatus(),
            getSyncEncryptionMaterial: () => encryptionState.getSyncEncryptionMaterial(),
            isSyncEncryptionBlocked: (scope) => encryptionState.isSyncEncryptionBlocked(scope),
            isSyncEncryptionPostureUnestablished: (scope, completed) => encryptionState.isSyncEncryptionPostureUnestablished(scope, completed),
            loadSyncEncryptionLocalState: () => encryptionState.loadSyncEncryptionLocalState(),
            logSyncEncryptionEvent: (event, extra, options) => encryptionState.logSyncEncryptionEvent(event, extra, options),
            syncEncryptionLocalState: encryptionState.syncEncryptionLocalState,

            probeLocationCiphertext: (target) => transitions.probeSyncLocationCiphertext(target),
        },
        ensureWebdavCapabilityProof: (config, probe, options) => capabilityProof.ensureWebdavCapabilityProof(config, probe, options),
        dropboxAuth: dropbox?.auth ?? {
            isConnected: async () => false,
            getValidAccessToken: unavailable('Dropbox'),
            forceRefreshAccessToken: unavailable('Dropbox'),
            getValidAccessTokenForTokens: unavailable('Dropbox'),
            forceRefreshAccessTokenForTokens: unavailable('Dropbox'),
        },
        fileSync: bindings.fileSync?.port ?? (safPort ? {
            readVersioned: (path, options) => noteFileSync(path, () => fileSync.readSyncFileVersioned(path, options)),
            write: (path, data, options) => noteFileSync(path, () => fileSync.writeSyncFile(path, data, options)),
            resolveUri: (uri, options) => fileSync.resolveSyncFileUri(uri, options),
            isBookmarksAvailable: () => false,
            resolveBookmark: async () => null,
            acquireLease: (path) => noteFileSync(path, () => leases.acquire(path), true),
            revalidateLease: (lease) => noteFileSync('', () => leases.revalidate(lease as MobileFileSyncLease)),
            releaseLease: (lease) => leases.release(lease as MobileFileSyncLease),
        } : {
            readVersioned: unavailable('File sync'),
            write: unavailable('File sync'),
            resolveUri: unavailable('File sync'),
            isBookmarksAvailable: () => false,
            resolveBookmark: async () => null,
            acquireLease: unavailable('File sync'),
            revalidateLease: unavailable('File sync'),
            releaseLease: async () => undefined,
        }),
        attachments: attachments ? { ...attachments.syncPort,
            ...(bindings.fileSync ? { runCleanup: async ({ appData }: { appData: AppData }) => ({ appData, shouldInvalidateFastSyncState: false }) } : {}),
        } : {
            syncWebdav: async () => null,
            syncCloud: async () => null,
            syncDropbox: async () => null,
            syncFile: async () => null,
            cleanupTempFiles: async () => undefined,
            hasCompletedPresenceReconciliation: async () => false,
            hasPendingWork: async () => false,
            runCleanup: async ({ appData }) => ({ appData, shouldInvalidateFastSyncState: false }),
        },
    });


    let configured = false;
    let cycles = 0;


    let contentRevision = 0;
    const storeReferences = (): unknown[] => {
        const store = useTaskStore.getState();
        return [store._allTasks, store._allProjects, store._allSections, store._allAreas, store._allPeople, store.settings,
            store.lastDataChangeAt];
    };
    let lastEvent = '';
    let fatalCleanupError: NativeAttachmentCleanupUnconfirmedError | null = null;

    let localChangePending = false;
    const badge = (): SyncBadgeState => {
        const settings = useTaskStore.getState().settings;
        return resolveSyncBadgeState({
            configured,
            activityState: service.getMobileSyncActivityState(),
            pendingRemoteWriteAt: settings.pendingRemoteWriteAt,
            lastSyncStatus: settings.lastSyncStatus,
            lastSyncAt: settings.lastSyncAt,
            localChangePending,
        });
    };
    const state = () => {
        const current = badge();


        return { type: 'sync', badge: current, color: current === 'hidden' ? null : einkSafeColor(SETTINGS_SYNC_BADGE_COLORS[current], themeDescriptor(useTaskStore.getState().settings.theme)?.statusPreset), cycles,
            contentRevision, active: service.getMobileSyncActivityState() === 'syncing' };
    };
    const emitState = () => {
        if (fatalCleanupError) return;
        const event = state();
        const text = JSON.stringify(event);
        if (text === lastEvent) return;
        lastEvent = text;
        bindings.trace(`Native Android sync state badge=${event.badge} cycles=${event.cycles}`);
        bindings.emit(event);
    };

    const refreshConfigured = async () => {
        if (fatalCleanupError) return;
        try {
            const nextConfigured = (await service.getMobileSyncConfigurationStatus()).configured;
            if (fatalCleanupError) return;
            configured = nextConfigured;
        } catch (error) {
            if (fatalCleanupError || error instanceof NativeAttachmentCleanupUnconfirmedError) return;
            configured = false;
        }
        emitState();
    };

    let iosAutomaticController: AutoSyncController | null = null;
    let iosAutomaticBackend: 'webdav' | 'cloud' | 'cloudkit' = 'webdav';
    type AutomaticFrame = { result: Awaited<ReturnType<NativeSyncSettingsHost['performSync']>> | null };
    let iosAutomaticFrame: AutomaticFrame | null = null;
    let iosUploadedChangeAt = useTaskStore.getState().lastDataChangeAt;
    const hasPendingLocalChange = () => useTaskStore.getState().lastDataChangeAt !== iosUploadedChangeAt;

    const assertSelfHostedSyncAdmission = async () => {
        if (platform !== 'ios') return;
        if (fatalCleanupError) throw fatalCleanupError;
        try {
            const status = await encryptionState.getSyncEncryptionStatus();
            const incomplete = await encryptionState.getIncompleteSyncEncryptionTransition();
            if ((status.incompleteTransition ?? null) !== incomplete) throw new Error('Sync encryption transition state is inconsistent');
            if (incomplete) throw new SyncEncryptionTransitionIncompleteError(incomplete);
        } catch (error) {
            try {
                await logLine('warn', 'Native iOS self-hosted encryption admission refused', { scope: 'native-ios', force: true,
                    extra: { releaseCheck: 'v1.3.5/ios-selfhosted-encryption-guard', operation: 'admission', outcome: 'refused' } });
            } catch {                                                         }
            throw error;
        }
    };
    const readIosForegroundBackend = async (override?: Parameters<NativeSyncSettingsHost['performSync']>[1]['configOverride']) => {
        const backend = override?.backend ?? ((await keyValue.get(SYNC_BACKEND_KEY))?.trim() || 'off');
        if (backend === 'cloudkit' && cloudKit?.isAvailable()) return backend;
        if (backend === 'file' && bindings.fileSync && override?.backend === 'file'
            && override.syncPath === bindings.fileSync.canonicalPath) {
            await assertSelfHostedSyncAdmission();
            const status = await encryptionState.getSyncEncryptionStatus();
            if (status.state !== 'off' || status.partlyEncrypted || await encryptionState.getSyncEncryptionMaterial()) {
                throw new Error('Native iOS File Sync requires plaintext encryption state');
            }
            return backend;
        }
        if (backend !== 'off' && backend !== 'webdav' && backend !== 'cloud') throw new Error('This sync provider is not available in native iOS yet');
        if (backend === 'cloud') {
            const provider = override?.cloudProvider ?? await keyValue.get(CLOUD_PROVIDER_KEY);
            if (provider?.trim() === 'dropbox' && dropbox) {
                dropbox.assertCurrent();
                const status = await encryptionState.getSyncEncryptionStatus(), incomplete = await encryptionState.getIncompleteSyncEncryptionTransition();
                if ((status.incompleteTransition ?? null) !== incomplete) throw new Error('Dropbox encryption transition state is inconsistent');
                if (incomplete) throw new SyncEncryptionTransitionIncompleteError(incomplete);
            } else {
                if (!isNativeIosSelfHostedProvider(provider)) throw new Error('This sync provider is not available in native iOS yet');
                await assertSelfHostedSyncAdmission();
            }
        }
        return backend;
    };


    const performSync: NativeSyncSettingsHost['performSync'] = async (syncPathOverride, options) => {
        if (fatalCleanupError) throw fatalCleanupError;
        if (platform === 'ios' && bindings.performFileSync
            && (options.configOverride?.backend ?? await keyValue.get(SYNC_BACKEND_KEY)) === 'file') {
            return bindings.performFileSync(syncPathOverride, options);
        }
        const iosBackend = platform === 'ios' ? await readIosForegroundBackend(options.configOverride) : null;

        const earlier = fileCycle;
        const contentBefore = storeReferences();
        let succeeded = false;
        let requeued = false;
        try {
            const before = platform === 'ios' && options.manual && !options.activationProbe
                ? useTaskStore.getState().settings : null;
            const answer = await service.performMobileSync(syncPathOverride, options);
            if (fatalCleanupError) throw fatalCleanupError;
            if (before) {
                const after = useTaskStore.getState().settings;
                if ((after.lastSyncStatus === 'success' || after.lastSyncStatus === 'conflict')
                    && (after.lastSyncStatus !== before.lastSyncStatus || after.lastSyncAt !== before.lastSyncAt)) {
                    iosAutomaticController?.notifyExternalSyncSuccess();
                }
            }
            succeeded = answer.success;
            requeued = answer.skipped === 'requeued';
            if (platform === 'ios' && answer.success && (!answer.skipped || answer.skipped === 'unchanged') && !options.activationProbe) {
                iosUploadedChangeAt = useTaskStore.getState().lastDataChangeAt;
            }
            if (dropbox && iosBackend === 'cloud' && answer.success && !answer.skipped
                && (options.configOverride?.cloudProvider ?? await keyValue.get(CLOUD_PROVIDER_KEY)) === 'dropbox') try {
                await logLine('info', 'Native iOS Dropbox shared cycle completed', { scope: 'native-ios', force: true,
                    extra: { releaseCheck: 'v1.3.9/ios-dropbox', operation: options.activationProbe ? 'verify' : 'sync', outcome: 'completed' } });
            } catch { }
            if (iosBackend === 'cloudkit' && answer.success && !answer.skipped) try {
                await logLine('info', 'Native iOS CloudKit foreground cycle completed', { scope: 'native-ios', force: true,
                    extra: { releaseCheck: 'v1.3.9/ios-cloudkit-foreground', operation: 'foreground', outcome: 'completed' } });
            } catch { }
            return answer;
        } catch (error) {
            if (error instanceof NativeAttachmentCleanupUnconfirmedError) fatalCleanupError = error;
            throw error;
        } finally {
            const ended = !requeued && fileCycle !== earlier ? takeFileCycle() : null;
            if (ended) {
                const encrypted = (await encryptionState.getSyncEncryptionStatus().catch(() => null))?.state === 'enabled';
                await logLine('info', 'Native Android File Sync cycle', { scope: 'sync', extra: {
                    releaseCheck: 'v1.3.8/native-file-sync', outcome: ended.outcome ?? (succeeded ? 'synced' : 'failed'),
                    provider: ended.provider, encrypted: encrypted ? 'yes' : 'no', retained: ended.retained,
                } });
            }
            if (!fatalCleanupError) {
                const contentAfter = storeReferences();
                if (contentAfter.some((reference, index) => reference !== contentBefore[index])) contentRevision += 1;
                cycles += 1;
                if (platform === 'ios') await refreshConfigured();
                else void refreshConfigured();
            }
        }
    };

    const automaticController = () => iosAutomaticController ??= createAutoSyncController({
        allowDeferredWork: false,
        periodicSyncIntervalMs: null,
        getCadence: () => getMobileAutoSyncCadence(iosAutomaticBackend),
        adaptivePacing: { durationMultiplier: 9, maxIntervalMs: 5 * 60_000 },
        isRuntimeActive: () => !fatalCleanupError && iosAutomaticFrame !== null,
        isIgnorableFailure: (error) => !error || isLikelyOfflineSyncError(error),
        reportError: (_label, error) => {
            if (error instanceof NativeAttachmentCleanupUnconfirmedError) fatalCleanupError = error;
            throw error;
        },
        flushPendingSave: async () => {
            if (fatalCleanupError) throw fatalCleanupError;
            await flushPendingSave();
            if (fatalCleanupError) throw fatalCleanupError;
        },
        performSync: async () => {
            if (fatalCleanupError) throw fatalCleanupError;
            const frame = iosAutomaticFrame;
            if (!frame) throw new Error('Automatic sync requires a foreground owner');
            const answer = await performSync(undefined, { manual: false });
            if (fatalCleanupError) throw fatalCleanupError;
            if (iosAutomaticFrame !== frame) throw new Error('Automatic sync requires its original foreground owner');
            frame.result = answer;
            return answer;
        },
    });
    const performStoredManualSync = async () => {
        if (platform !== 'ios') throw new Error('Stored manual sync is unavailable on this host');
        if (iosAutomaticFrame) throw new Error('An automatic foreground sync is already in progress');
        const answer = await performSync(undefined, { manual: true });
        return { success: answer.success === true, skipped: Boolean(answer.skipped) };
    };
    const performStoredAutomaticSync = async (reason: 'startup' | 'resume' | 'leave') => {
        if (fatalCleanupError) throw fatalCleanupError;
        if (platform !== 'ios' || !['startup', 'resume', 'leave'].includes(reason)) {
            throw new Error('Stored automatic sync is unavailable on this host');
        }
        if (iosAutomaticFrame) throw new Error('An automatic foreground sync is already in progress');
        const frame: AutomaticFrame = { result: null };
        iosAutomaticFrame = frame;
        try {
            const backend = await readIosForegroundBackend();
            if (fatalCleanupError) throw fatalCleanupError;
            if (backend === 'cloud' && (await keyValue.get(CLOUD_PROVIDER_KEY))?.trim() === 'dropbox')
                throw new Error('Automatic Dropbox sync is unavailable on this iOS build');
            if (backend !== 'webdav' && backend !== 'cloud' && backend !== 'cloudkit') throw new Error('Stored automatic sync requires a remote provider');
            iosAutomaticBackend = backend;
            const controller = automaticController();
            if (reason === 'resume' && Date.now() - controller.getLastAutoSyncAt()
                <= getMobileAutoSyncCadence(backend).foregroundMinIntervalMs) return { success: true, skipped: true };
            await controller.requestAutoSync(0, reason === 'leave' ? 'app-state-background' : reason);
            if (fatalCleanupError) throw fatalCleanupError;
            return frame.result ? { success: frame.result.success === true, skipped: Boolean(frame.result.skipped) }
                : { success: true, skipped: true };
        } catch (error) {
            if (error instanceof NativeAttachmentCleanupUnconfirmedError) fatalCleanupError = error;
            throw fatalCleanupError ?? error;
        } finally { iosAutomaticFrame = null; }
    };


    const syncChangeObservation = () => ({ pending: hasPendingLocalChange() });

    const backgroundSyncWanted = async () => {
        const { backend, configured } = await service.getMobileSyncConfigurationStatus();
        return shouldScheduleMobileBackgroundSync({ schedulerAvailable: true, configured, backend });
    };
    const reconcileBackgroundSync = async () => {
        if (fatalCleanupError) throw fatalCleanupError;
        if (platform === 'ios') return;
        void refreshConfigured();
        const on = await backgroundSyncWanted();
        if (fatalCleanupError) throw fatalCleanupError;

        bindings.scheduleBackgroundSync(on);
        bindings.trace(`Native Android background sync schedule=${on ? 'on' : 'off'}`);
    };
    const appStateListeners = new Set<(state: string) => void>();

    let imported = 0;

    let shortDeadlineMs: number | null = null;
    const runner = createMobileBackgroundSyncRunner({
        storage,
        log: { info: (message, context) => logLine('info', message, context), warn: (message, context) => logLine('warn', message, context) },
        sync: {
            getConfigurationStatus: () => service.getMobileSyncConfigurationStatus(),
            performSync: () => performSync(undefined, {}),

            abort: () => service.abortMobileSync('deadline'),
            setRequestDeadline: syncFetch.setDeadline,
        },
        flushPendingSave: () => flushPendingSave(),

        drainPendingCaptures: async () => {
            const count = imported;
            imported = 0;
            return count;
        },

        quiesceStorage: () => flushPendingSave(),
        timersPaused: () => false,
        deadlineMs: () => shortDeadlineMs ?? MOBILE_BACKGROUND_SYNC_DEADLINE_MS,
        onAppStateChange: (listener) => {
            appStateListeners.add(listener);
            return { remove: () => { appStateListeners.delete(listener); } };
        },
    });


    const logSelectedEncryptionCompleted = async (operation: 'enable' | 'change' | 'disable' | 'abandon' | 'recheck'): Promise<void> => {
        if (platform !== 'ios' || (settingsHost.encryption.mode !== 'saved-webdav-enable-unlock'
            && settingsHost.encryption.mode !== 'saved-webdav' && settingsHost.encryption.mode !== 'saved-webdav-or-local')) return;
        try {
            await logLine('info', 'Native iOS selected encryption service completed', { scope: 'native-ios', force: true,
                extra: { releaseCheck: 'v1.3.5/ios-encryption-selected', operation, outcome: 'confirmed' } });
        } catch {                                                                              }
    };
    const settingsHost: NativeSyncSettingsHost = {
        platform: { os: platform, cloudKitAvailable: cloudKit?.isAvailable() === true, isFossBuild: bindings.isFossBuild, dropboxAppKey: dropbox?.configuration.clientId ?? '' },
        ...(dropbox ? { dropbox: dropbox.settings,
            beforeDropboxPromotion: async () => dropbox.assertCurrent(), beforeActivation: async () => dropbox.assertCurrent() } : {}),
        ...(cloudKit ? { cloudKit: { getAccountStatus: () => cloudKit.getAccountStatus() } } : {}),
        storage: {
            multiGet: (keys) => keyValue.multiGet(keys),
            setItem: (key, value) => keyValue.set(key, value),
            multiSet: (entries) => keyValue.multiSet(entries),
            removeItem: (key) => keyValue.remove(key),
        },
        secrets: {
            get: (key) => secureConfig.getSecureConfigValue(key),
            set: (key, value) => secureConfig.setSecureConfigValue(key, value),
            delete: (key) => secureConfig.deleteSecureConfigValue(key),
        },
        performSync,


        answersMissingFilesQuestion: platform === 'android',
        defersMissingFilesQuestion: platform === 'ios',


        ...(bindings.pickSyncFolder ? { pickSyncFolder: bindings.pickSyncFolder } : documentCall ? {
            pickSyncFolder: async () => {
                const pick = (await documentCall({ op: 'takePick' })).value as { treeUri?: string } | null;
                if (!pick) return null;
                try {
                    if (!pick.treeUri) throw new Error('Android did not keep access to the selected folder');
                    const picked = await fileSync.prepareSafSyncFolder(pick.treeUri);
                    return picked.__fileUri ? { uri: picked.__fileUri } : null;
                } catch (error) {
                    void logError(error, { scope: 'sync', extra: { operation: 'import', message: 'Failed to import data from folder' } });
                    throw error;
                }
            },
        } : {}),
        ...(bindings.listRecoverySnapshots ? { listRecoverySnapshots: bindings.listRecoverySnapshots } : {}),
        clearSyncConfigCache: () => service.clearMobileSyncConfigCache(),
        reconcileBackgroundSync,
        rememberWebdavCapabilityProof: (config) => capabilityProof.rememberWebdavCapabilityProof(config),
        encryption: {
            getStatus: () => encryptionState.getSyncEncryptionStatus(),
            getIncompleteTransition: () => encryptionState.getIncompleteSyncEncryptionTransition(),
            transitions: {
                enable: async (passphrase, options) => {
                    try {
                        await transitions.enableSyncEncryption(passphrase, options);
                        await logSelectedEncryptionCompleted('enable');
                    } catch (error) {
                        if (platform === 'ios' && error instanceof SyncEncryptionArtifactCapacityError) {
                            try {
                                await logLine('warn', 'Native iOS encryption enable capacity refused', { scope: 'native-ios', force: true,
                                    extra: { releaseCheck: 'v1.3.5/ios-encryption-enable-capacity', operation: 'enable', outcome: 'refused' } });
                            } catch {                                                        }
                        }
                        throw error;
                    }
                },
                change: async (current, next, options) => {
                    await transitions.changeSyncEncryptionPassphrase(current, next, options);
                    await logSelectedEncryptionCompleted('change');
                },
                disable: async (options) => {
                    await transitions.disableSyncEncryption(options);
                    await logSelectedEncryptionCompleted('disable');
                },
                provide: async (passphrase) => {
                    const outcome = await transitions.provideSyncEncryptionPassphrase(passphrase);
                    if (platform === 'ios' && (settingsHost.encryption.unlockOnly
                        || settingsHost.encryption.mode === 'saved-webdav-enable-unlock'
                        || settingsHost.encryption.mode === 'saved-webdav'
                        || settingsHost.encryption.mode === 'saved-webdav-or-local') && outcome === 'ok') {
                        await logLine('info', 'Native iOS encrypted unlock service completed', { scope: 'native-ios', force: true,
                            extra: { releaseCheck: 'v1.3.5/ios-encryption-unlock', operation: 'unlock', outcome: 'confirmed' } });
                    }
                    return outcome;
                },
                decline: () => transitions.declineSyncEncryptionPassphrase(),
                abandon: async () => {
                    const outcome = await transitions.abandonSyncEncryptionTransition();
                    await logSelectedEncryptionCompleted('abandon');
                    return outcome;
                },
                recheck: async () => {
                    const outcome = await transitions.recheckPartlyEncryptedLocation();
                    await logSelectedEncryptionCompleted('recheck');
                    return outcome;
                },
                randomBytes: (length) => crypto.randomBytes(length),
            },
            isBackendPending: () => transitions.isSyncEncryptionBackendPending(),
        },
        log: {
            info: (message, context) => logLine('info', message, context),
            error: (error) => { void logError(error, { scope: 'settings' }); },
        },
    };


    let triggers: MobileSyncTriggers | null = null;
    let online: boolean | null = null;


    const showSyncIssue = (classification: string) => {
        const t = bindings.translate;
        const key = ({
            auth: 'settings.syncFailureAuth',
            permission: 'settings.syncFailurePermission',
            rateLimited: 'settings.syncFailureRateLimited',
            misconfigured: 'settings.syncFailureMisconfigured',
            conflict: 'settings.syncFailureConflict',
            encryptionState: 'settings.syncEncryptionStateUnavailable',
            encryption: 'settings.syncFailureEncryption',
            fileLockUnavailable: 'settings.syncFileLockUnavailable',
        } as Record<string, string>)[classification] ?? 'settings.syncFailureGeneric';
        bindings.emit({ type: 'toast', title: t('settings.syncBadgeWarning'), message: t(key), tone: 'warning', durationMs: 5200, action: t('common.open'), open: 'sync' });
    };


    const pullSync = async () => {
        const outcome = await runManualPullSync({
            getConfigurationStatus: () => service.getMobileSyncConfigurationStatus(),
            getActivityState: () => service.getMobileSyncActivityState(),
            performSync: () => performSync(undefined, { manual: true }),
            isLikelyOfflineSyncError,
            getSyncConflictCount,
            t: bindings.translate,
        });
        await logLine('info', 'Native Android pull to sync', { scope: 'sync', force: true, extra: {
            releaseCheck: 'v1.3.8/native-pull-sync', outcome: outcome.indicator, toast: outcome.toast ? 'yes' : 'no',
        } });
        return outcome;
    };

    return {
        dropboxBinding: dropbox,
        settingsHost,
        pullSync,
        assertSelfHostedSyncAdmission,
        performStoredAutomaticSync,
        performStoredManualSync,
        syncChangeObservation,
        attachmentsHost: attachments?.contractHost ?? null,
        prepareAttachmentAvailableDetailed: attachments?.prepareAttachmentAvailableDetailed ?? null,

        state,

        selectedBackend: () => service.getMobileSelectedSyncBackend(),

        waitForSyncIdle: () => service.waitForMobileSyncIdle(),


        start(appState: string) {
            if (platform === 'ios') throw new Error('Automatic sync is not available on this iOS build');
            if (triggers) return state();
            triggers = createMobileSyncTriggers({
                initialAppState: appState,
                performSync: () => {
                    bindings.trace('Native Android sync automatic cycle');
                    return performSync(undefined, {});
                },
                abortSync: () => service.abortMobileSync(),
                flushPendingSave: () => flushPendingSave(),
                reconcileBackgroundSync: () => { void reconcileBackgroundSync().catch((error) => logError(error, { scope: 'sync' })); },
                readStoredBackend: () => keyValue.get(SYNC_BACKEND_KEY),
                resolveSupportedBackend: (raw) => coerceSupportedBackend(resolveBackend(raw), false),
                getSyncChangeFingerprint: () => getInMemorySyncChangeFingerprint(),
                isLikelyOfflineSyncError: (error) => isLikelyOfflineSyncError(error),
                classifySyncFailure: (error) => classifySyncFailure(error),
                reportError: (error) => { void logError(error, { scope: 'app' }); },
                logWarn: (message, context) => logLine('warn', message, context),
                logInfo: (message, context) => logLine('info', message, context),
                onLocalChangePendingChange: (pending) => {
                    localChangePending = pending;
                    emitState();
                },
                showSyncIssue,
            });
            const active = triggers;
            active.start();
            useTaskStore.subscribe(nameNotifyListener('auto-sync-trigger', (current, previous) => {
                active.handleStoreChange(current, previous);
                const settings = current.settings;
                const before = previous.settings;
                if (settings?.lastSyncAt !== before?.lastSyncAt || settings?.lastSyncStatus !== before?.lastSyncStatus
                    || settings?.pendingRemoteWriteAt !== before?.pendingRemoteWriteAt) void refreshConfigured();
            }));
            service.subscribeMobileSyncActivityState(() => emitState());
            active.requestSync(0);
            void refreshConfigured();
            return state();
        },

        appState(next: string) {
            triggers?.handleAppStateChange(next);
            for (const listener of Array.from(appStateListeners)) listener(next);
            return state();
        },


        async backgroundSync(trigger: MobileBackgroundSyncTrigger, stored: number, deadlineMs = 0) {
            if (platform === 'ios') throw new Error('Background sync is not available on this iOS build');
            imported += stored;
            shortDeadlineMs = deadlineMs > 0 && deadlineMs < MOBILE_BACKGROUND_SYNC_DEADLINE_MS ? deadlineMs : null;
            if (trigger === 'capture') await runner.runCapture();
            else await runner.run('scheduled');
            return { schedule: await backgroundSyncWanted() };
        },


        network(next: MobileSyncNetworkState) {
            for (const listener of Array.from(networkListeners)) {
                try { listener(next); } catch (error) { void logError(error, { scope: 'sync' }); }
            }
            const now = next.isConnected !== false && next.isInternetReachable !== false;
            if (online === false && now) triggers?.requestSync();
            online = now;
            return state();
        },
    };
};

export type NativeSync = ReturnType<typeof createNativeSync>;

export const createIosFileSync = (bindings: NativeSyncBindings, selection: NativeFileSyncSelection, call: NativeFileSyncCall) => {
    const storage = { getItem: (name: string) => bindings.keyValue.get(name), setItem: (name: string, value: string) => bindings.keyValue.set(name, value), removeItem: (name: string) => bindings.keyValue.remove(name) };
    const secrets: SyncSecretStoragePort = { isAvailable: async () => true, getItem: bindings.secrets.getSecret,
        setItem: bindings.secrets.setSecret, deleteItem: bindings.secrets.deleteSecret };
    const secureConfig = createSecureSyncConfigStore({ storage, secrets, vault: createSyncSecretVault(secrets) });
    const log = {
        info: (message: string, context?: { scope?: string; extra?: Record<string, unknown> }) => { void bindings.appendLog(buildDiagnosticsLogEntry('info', message, context)).catch(() => null); },
        warn: (message: string, context?: { scope?: string; extra?: Record<string, unknown> }) => { void bindings.appendLog(buildDiagnosticsLogEntry('warn', message, context)).catch(() => null); },
        error: (error: unknown, context?: { scope?: string; extra?: Record<string, unknown> }) => { void bindings.appendLog(buildDiagnosticsErrorEntry(error, { ...context, scope: context?.scope ?? 'sync' })).catch(() => null); },
    };
    const state = createSyncEncryptionStateStore({ storage, secureConfig, readActiveScope: () => readSyncLocationScope(storage), log });
    const port = createNativeFileSync(selection, call, { log,
        crypto: createHostSyncCrypto((globalThis as { __mindwtrCryptoCall?: HostCryptoCall }).__mindwtrCryptoCall),
        encryption: { localState: state.syncEncryptionLocalState, flush: () => state.flushSyncEncryptionLocalState(),
            logEvent: (event, extra) => state.logSyncEncryptionEvent(event, extra) },
    });
    return createNativeSync({ ...bindings, fileSync: { canonicalPath: selection.canonicalPath, port } }, state);
};

export const createIosDirectoryFileSync = (bindings: NativeSyncBindings, call: NativeFileSyncCall,
    control: (requestJSON: string) => unknown) => {
    type Prepared = { selection: NativeFileSyncSelection; bookmark: string; expectedPath: string | null };
    let prepared: Prepared | null = null;
    let active: string | null = null;
    const command = (request: Record<string, unknown>): Record<string, unknown> => {
        const raw = control(JSON.stringify(request));
        if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 2 * 1024 * 1024) throw new Error('Directory File Sync authority is unavailable');
        const value = JSON.parse(raw) as Record<string, unknown>;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Directory File Sync authority is unavailable');
        return value;
    };
    const finish = (admit: boolean) => {
        if (!active) return;
        const turn = active;
        const result = command({ phase: 'finish', turn, admit });
        if (Object.keys(result).length !== 1 || result.closed !== true) throw new Error('Directory File Sync close was not confirmed');
        active = null;
    };
    const prepare = async (picked: boolean, probe: boolean, candidate?: { path?: string | null; bookmark?: string | null }): Promise<Prepared> => {
        if (active) throw new Error('Directory File Sync owner is already active');
        const result = command({ phase: 'begin', picked, probe, path: candidate?.path ?? null, bookmark: candidate?.bookmark ?? null });
        if (Object.keys(result).length !== 3 || typeof result.turn !== 'string' || !result.turn
            || typeof result.bookmark !== 'string' || !result.bookmark || result.expectedPath !== null && typeof result.expectedPath !== 'string') throw new Error('Directory File Sync authority is unavailable');
        active = result.turn;
        try {
            const selection = await prepareNativeFileSync(result.turn, call, {
                info: (message, context) => { void bindings.appendLog(buildDiagnosticsLogEntry('info', message, context)).catch(() => null); },
                warn: () => {}, error: () => {},
            });
            if (result.expectedPath !== null && result.expectedPath !== selection.canonicalPath) throw new Error('Saved directory changed');
            return { selection, bookmark: result.bookmark, expectedPath: result.expectedPath };
        } catch (error) { finish(false); throw error; }
    };
    const performFileSync: NativeSyncSettingsHost['performSync'] = async (_override, options) => {
        const probe = options.activationProbe === true;
        const candidate = options.configOverride;
        const selected = prepared ?? await prepare(false, probe, { path: candidate?.syncPath, bookmark: candidate?.syncPathBookmark });
        prepared = null;
        try {
            if (candidate && (candidate.syncPath !== selected.selection.canonicalPath || candidate.syncPathBookmark !== selected.bookmark)) throw new Error('Directory selection changed');
            const fresh = createIosFileSync({ ...bindings, performFileSync: undefined, pickSyncFolder: undefined,
                emit: () => {}, trace: () => {}, scheduleBackgroundSync: () => {},
                retireLocalAttachment: async () => { throw new NativeAttachmentCleanupUnconfirmedError(); },
            }, selected.selection, call);
            const result = await fresh.settingsHost.performSync(undefined, { ...options,
                configOverride: { backend: 'file', syncPath: selected.selection.canonicalPath, syncPathBookmark: null },
            });
            if (probe && !result.success && result.activationMissingAttachments?.length) {
                finish(false);
                return result;
            }
            if (!result.success || result.skipped || result.fileSyncLockDeferred || result.remoteFenceDeferred) throw new Error('Directory File Sync cycle did not complete');
            finish(true);
            return result;
        } catch (error) { finish(false); throw error; }
    };
    return { performFileSync, pickSyncFolder: async () => {
        prepared = await prepare(true, true);
        return { uri: prepared.selection.canonicalPath, bookmark: prepared.bookmark };
    }, close: () => { prepared = null; finish(false); } };
};
