/**
 * Native Sync: core's mobile sync service and Settings › Sync's device, bound to this
 * host's ports as React Native's lib/sync-service.ts, the root layout's sync effects and the Sync screen bind them. Every rule
 * is core's (mobile-sync-service.ts, mobile-sync-triggers.ts, native-host-contract-settings-sync.ts); this file only binds:
 *
 * - RN's device keys in RN's AsyncStorage (RKStorage, in place) and RN's secret store (expo-secure-store's format);
 * - the fetch bridge, the device's network state, the app log;
 * - the local snapshot (the boot's validated SQLite adapter).
 *
 * - the attachment passes and the editor's attachment IO (host-attachments.ts), on the host's app-private files.
 *
 * - sync encryption: core's cipher on the host's crypto calls (HostCrypto.kt: Argon2id and AES-GCM off the engine thread),
 *   and core's encryption transitions (sync-encryption-service.ts) as RN's lib/sync-encryption-service.ts binds them, with
 *   RN's WebDAV XML parser (@xmldom/xmldom).
 *
 * - the background job (S4a): core's background runner (mobile-background-sync.ts: its deadline, failure cooldown, capture
 *   run and quiesce), which CoreWork's jobs call after the app's start order; core decides whether the job is scheduled.
 *
 * Not on this host yet, and refused the way core refuses an unbound port: Dropbox (S4) and File Sync's folder (S5). The fence
 * owner stays `mindwtr-mobile` and the device keys keep RN's names, so an upgraded RN user's configuration and deviceId carry over.
 * iOS construction is explicit and foreground-only; host-entry's activation gate remains closed. A future entry must admit
 * supported stored providers before opening settings or executing requests. This factory does not alter those stored choices.
 */
import { DOMParser } from '@xmldom/xmldom';
import { createNativeAttachments, nativeFileChannels, type NativeAttachmentBindings } from './host-attachments';
import {
    MOBILE_BACKGROUND_SYNC_DEADLINE_MS,
    NativeAttachmentCleanupUnconfirmedError,
    SETTINGS_SYNC_BADGE_COLORS,
    SYNC_BACKEND_KEY,
    SyncCryptoAuthError,
    SyncEncryptionArtifactCapacityError,
    buildDiagnosticsErrorEntry,
    buildDiagnosticsLogEntry,
    classifySyncFailure,
    coerceSupportedBackend,
    createAutoSyncController,
    createMobileBackgroundSyncRunner,
    createMobileSyncService,
    createMobileSyncTriggers,
    createSecureSyncConfigStore,
    createSyncEncryptionService,
    createSyncEncryptionStateStore,
    createSyncSecretVault,
    createWebdavCapabilityProofStore,
    flushPendingSave,
    generateUUID,
    getInMemorySyncChangeFingerprint,
    getMobileAutoSyncCadence,
    getMobileWebDavRequestOptions,
    isLikelyOfflineSyncError,
    loadWebDavSyncConfig,
    nameNotifyListener,
    normalizeExternalCalendarColor,
    readSyncLocationScope,
    resolveBackend,
    resolveSyncBadgeState,
    sanitizeLogMessage,
    shouldScheduleMobileBackgroundSync,
    useTaskStore,
    type AppData,
    type AutoSyncController,
    type DiagnosticsLogEntry,
    type MobileBackgroundSyncTrigger,
    type MobileSyncNetworkState,
    type MobileSyncTriggers,
    type NativeSyncSettingsHost,
    type SyncBadgeState,
    type SyncCryptoPrimitives,
    type SyncSecretStoragePort,
    type SyncSecretAccessibility,
} from '@mindwtr/core';

/** host-entry.ts's AsyncStorage over RnKeyValue.kt. */
export type HostKeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    multiGet(keys: readonly string[]): Promise<[string, string | null][]>;
    multiSet(pairs: readonly (readonly [string, string])[]): Promise<void>;
};

export type NativeSyncBindings = {
    keyValue: HostKeyValue;
    /** host-polyfills.js's secret calls (SecretStore.kt, expo-secure-store's format). */
    secrets: { getSecret(key: string): Promise<string | null>; setSecret(key: string, value: string, accessibility?: SyncSecretAccessibility): Promise<void>; deleteSecret(key: string): Promise<void> };
    /** The boot's validated SQLite adapter: the local snapshot a cycle reads and saves. */
    localData: () => { getData(): Promise<AppData>; saveData(data: AppData): Promise<void> };
    /** The device's network state now (HostNetwork.kt), as expo-network reads it. */
    networkState: () => MobileSyncNetworkState;
    /** RN's diagnostics log line (app-log.ts appendLogLine): the file's path once written. */
    appendLog: (entry: DiagnosticsLogEntry, force?: boolean) => Promise<string | null>;
    /** Core's words in the language core chose. */
    translate: (key: string) => string;
    /** An event for Kotlin (CoreHost's hostEvent): never a secret, a URL or task text. */
    emit: (event: Record<string, unknown>) => void;
    /** A logcat line (the device checks read the badge's changes there). */
    trace: (line: string) => void;
    /** Core's answer whether the background job runs (BackgroundSync.kt schedules it, or cancels it). */
    scheduleBackgroundSync: (on: boolean) => void;
    /** The build's flavor (BuildConfig.FOSS): a FOSS build hides Dropbox, as RN's FOSS_BUILD does. */
    isFossBuild: boolean;
    /** Selected durable cleanup ownership, required by the explicit iOS foreground factory. */
    retireLocalAttachment?: NativeAttachmentBindings['retireLocalAttachment'];
};

/** host-polyfills.js's sync crypto call (HostCrypto.kt); absent where the host has no crypto (the gates' stand-in). */
type HostCryptoCall = (request: Record<string, unknown>) => Promise<Uint8Array>;

const unavailableCipher = (): never => {
    throw new Error('Sync encryption is not available on this build yet');
};

/**
 * Core's SyncCryptoPrimitives on the host's crypto calls, as RN's sync-crypto-native.ts gives them: Argon2id and AES-GCM off the
 * engine thread, a tag or AAD mismatch as core's own SyncCryptoAuthError (core tells it apart with instanceof), and random bytes
 * from the host's SecureRandom. Without the calls, every primitive refuses: a device whose state says `enabled` then fails
 * closed and never writes plaintext beside ciphertext.
 */
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

/** RN's key for the device's calendar feeds (lib/external-calendar.ts EXTERNAL_CALENDARS_KEY). */
const EXTERNAL_CALENDARS_KEY = 'mindwtr-external-calendars';

type ExternalCalendar = NonNullable<AppData['settings']['externalCalendars']>[number];

/**
 * RN's background-safe fetch deadline (setMobileSyncRequestDeadline): while the background run's deadline is set, no sync request
 * starts past it. A request in flight at the deadline is aborted by the runner's own deadline (its abort), whose timer this host
 * runs in the background too (CoreHost's idle pump), unlike RN's paused JS timers.
 */
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

export const createNativeSync = (bindings: NativeSyncBindings) => {
    const platform = globalThis.__mindwtrHostPlatform === 'ios' ? 'ios' : 'android';
    if (platform === 'ios' && typeof bindings.retireLocalAttachment !== 'function') {
        throw new Error('Foreground sync requires owned attachment cleanup on this iOS build');
    }
    const channels = nativeFileChannels();
    if (platform === 'ios' && !channels) {
        throw new Error('Foreground sync requires native attachment files on this iOS build');
    }
    const { keyValue } = bindings;
    const storage = {
        getItem: (key: string) => keyValue.get(key),
        setItem: (key: string, value: string) => keyValue.set(key, value),
        removeItem: (key: string) => keyValue.remove(key),
    };

    // RN's app-log.ts lines: logInfo, logWarn, logError, logSyncError.
    const logLine = (level: 'info' | 'warn', message: string, context?: { scope?: string; extra?: Record<string, unknown>; force?: boolean }) =>
        bindings.appendLog(buildDiagnosticsLogEntry(level, message, context), context?.force).catch(() => null);
    const logError = (error: unknown, context: { scope: string; url?: string; extra?: Record<string, unknown> }) =>
        bindings.appendLog(buildDiagnosticsErrorEntry(error, context)).catch(() => null);

    // RN's secure-secret-store.ts: expo-secure-store as core's keystore port (Android keeps one accessibility class).
    const secretStorage: SyncSecretStoragePort = {
        isAvailable: async () => true,
        getItem: (key) => bindings.secrets.getSecret(key),
        setItem: (key, value, accessibility) => platform === 'ios'
            ? bindings.secrets.setSecret(key, value, accessibility)
            : bindings.secrets.setSecret(key, value),
        deleteItem: (key) => bindings.secrets.deleteSecret(key),
    };
    const secureConfig = createSecureSyncConfigStore({ storage, secrets: secretStorage, vault: createSyncSecretVault(secretStorage) });
    const encryptionState = createSyncEncryptionStateStore({
        storage,
        secureConfig,
        readActiveScope: () => readSyncLocationScope(storage),
        log: { info: (message, context) => logLine('info', message, context), warn: (message, context) => logLine('warn', message, context) },
    });
    const capabilityProof = createWebdavCapabilityProofStore(storage);

    const crypto = createHostSyncCrypto((globalThis as { __mindwtrCryptoCall?: HostCryptoCall }).__mindwtrCryptoCall);

    // Core's encryption transitions (enable, change, disable, unlock), as RN's lib/sync-encryption-service.ts binds them. They
    // run on core's serialized sync queue, so a transition and a cycle never interleave. Dropbox and File Sync come later.
    const transitions = createSyncEncryptionService<never>({
        maxEncryptedArtifactBytes: platform === 'ios' ? 8 * 1024 * 1024 : undefined,
        storage: { getItem: (key) => keyValue.get(key) },
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
        getDropboxClientId: async () => '',
        runDropboxAuthorized: unavailable('Dropbox'),
    });

    const networkListeners = new Set<(state: MobileSyncNetworkState) => void>();

    // Attachments (host-attachments.ts) on the host's files, with sync's own stores, keystore, log and encryption state.
    const attachments = channels ? createNativeAttachments({
        storage,
        getSecureConfigValue: (key) => secureConfig.getSecureConfigValue(key),
        log: {
            info: (message, context) => logLine('info', message, context),
            warn: (message, context) => logLine('warn', message, context),
            sanitize: (message) => sanitizeLogMessage(message),
        },
        crypto,
        retireLocalAttachment: bindings.retireLocalAttachment,
        maxWebdavBufferedUploadBytes: platform === 'ios' ? 8 * 1024 * 1024 : undefined,
        encryption: {
            logSyncEncryptionEvent: (event, extra, options) => encryptionState.logSyncEncryptionEvent(event, extra, options),
            getSyncEncryptionMaterial: () => encryptionState.getSyncEncryptionMaterial(),
        },
    }, channels) : null;

    const syncFetch = createDeadlineFetch((input, init) => fetch(input, init));
    const service = createMobileSyncService<never>({
        // iOS cleanup authority lasts for one admitted foreground invocation.
        allowQueuedFollowUp: platform !== 'ios',
        storage,
        getSecureConfigValue: (key) => secureConfig.getSecureConfigValue(key),
        platform: { os: () => platform, isFossBuild: bindings.isFossBuild, dropboxAppKey: () => '' },
        network: {
            getState: async () => bindings.networkState(),
            subscribe: (listener) => {
                networkListeners.add(listener);
                return { remove: () => { networkListeners.delete(listener); } };
            },
        },
        localData: { getData: () => bindings.localData().getData(), saveData: (data) => bindings.localData().saveData(data) },
        log: {
            info: (message, context) => logLine('info', message, context),
            warn: (message, context) => logLine('warn', message, context),
            syncError: (error, context) => logError(error, { scope: 'sync', url: context.url, extra: { backend: context.backend, step: context.step } }),
            sanitize: (message) => sanitizeLogMessage(message),
        },
        // RN's lib/external-calendar.ts getExternalCalendars and saveExternalCalendars, on its key.
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
            // A WebDAV attachment pass with no key first asks whether the location holds ciphertext (core's rule).
            probeLocationCiphertext: (target) => transitions.probeSyncLocationCiphertext(target),
        },
        ensureWebdavCapabilityProof: (config, probe, options) => capabilityProof.ensureWebdavCapabilityProof(config, probe, options),
        dropboxAuth: {
            isConnected: async () => false,
            getValidAccessToken: unavailable('Dropbox'),
            forceRefreshAccessToken: unavailable('Dropbox'),
            getValidAccessTokenForTokens: unavailable('Dropbox'),
            forceRefreshAccessTokenForTokens: unavailable('Dropbox'),
        },
        fileSync: {
            readVersioned: unavailable('File sync'),
            write: unavailable('File sync'),
            resolveUri: unavailable('File sync'),
            isBookmarksAvailable: () => false,
            resolveBookmark: async () => null,
            acquireLease: unavailable('File sync'),
            revalidateLease: unavailable('File sync'),
            releaseLease: async () => undefined,
        },
        // Core's attachment passes on the host's files; a host without app files (the gates' stand-in) syncs metadata only.
        attachments: attachments?.syncPort ?? {
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

    // ---- What Kotlin draws: the Menu tab's dot and the Settings row's badge, and when a cycle ended ----

    let configured = false;
    let cycles = 0;
    let lastEvent = '';
    let fatalCleanupError: NativeAttachmentCleanupUnconfirmedError | null = null;
    const badge = (): SyncBadgeState => {
        const settings = useTaskStore.getState().settings;
        return resolveSyncBadgeState({
            configured,
            activityState: service.getMobileSyncActivityState(),
            pendingRemoteWriteAt: settings.pendingRemoteWriteAt,
            lastSyncStatus: settings.lastSyncStatus,
            lastSyncAt: settings.lastSyncAt,
        });
    };
    const state = () => {
        const current = badge();
        return { type: 'sync', badge: current, color: current === 'hidden' ? null : SETTINGS_SYNC_BADGE_COLORS[current], cycles };
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
    /** RN's useMobileSyncBadge reads the configuration again on every screen change and sync status change. */
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
    type AutomaticFrame = { result: Awaited<ReturnType<NativeSyncSettingsHost['performSync']>> | null };
    let iosAutomaticFrame: AutomaticFrame | null = null;

    /** Every cycle, automatic or from the Sync screen, goes through here, so Kotlin reads its lists again once one ends. */
    const performSync: NativeSyncSettingsHost['performSync'] = async (syncPathOverride, options) => {
        if (fatalCleanupError) throw fatalCleanupError;
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
            return answer;
        } catch (error) {
            if (error instanceof NativeAttachmentCleanupUnconfirmedError) fatalCleanupError = error;
            throw error;
        } finally {
            if (!fatalCleanupError) {
                cycles += 1;
                if (platform === 'ios') await refreshConfigured();
                else void refreshConfigured();
            }
        }
    };

    const automaticController = () => iosAutomaticController ??= createAutoSyncController({
        allowDeferredWork: false,
        periodicSyncIntervalMs: null,
        getCadence: () => getMobileAutoSyncCadence('webdav'),
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
    const performStoredAutomaticSync = async (reason: 'startup' | 'resume') => {
        if (fatalCleanupError) throw fatalCleanupError;
        if (platform !== 'ios' || (reason !== 'startup' && reason !== 'resume')) {
            throw new Error('Stored automatic sync is unavailable on this host');
        }
        if (iosAutomaticFrame) throw new Error('An automatic foreground sync is already in progress');
        const frame: AutomaticFrame = { result: null };
        iosAutomaticFrame = frame;
        try {
            const backend = (await keyValue.get(SYNC_BACKEND_KEY))?.trim();
            if (fatalCleanupError) throw fatalCleanupError;
            if (backend !== 'webdav') throw new Error('Stored automatic sync requires WebDAV');
            const controller = automaticController();
            if (reason === 'resume' && Date.now() - controller.getLastAutoSyncAt()
                <= getMobileAutoSyncCadence(backend).foregroundMinIntervalMs) return { success: true, skipped: true };
            await controller.requestAutoSync(0, reason);
            if (fatalCleanupError) throw fatalCleanupError;
            return frame.result ? { success: frame.result.success === true, skipped: Boolean(frame.result.skipped) }
                : { success: true, skipped: true };
        } catch (error) {
            if (error instanceof NativeAttachmentCleanupUnconfirmedError) fatalCleanupError = error;
            throw fatalCleanupError ?? error;
        } finally { iosAutomaticFrame = null; }
    };

    // ---- The background job (CoreWork's sync and capture jobs; RN's lib/background-sync-task.ts) ----

    /**
     * RN's syncMobileBackgroundSyncRegistration: core's decision (a configured WebDAV or cloud backend) handed to Kotlin, which
     * keeps a scheduled or running job (KEEP) or cancels it. Called where RN reconciles: the triggers' start, resume and leave,
     * and a Sync screen change.
     */
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
        // Kotlin answers once WorkManager stored it (bounded); a refusal throws to the caller, and the next reconcile tries again.
        bindings.scheduleBackgroundSync(on);
        bindings.trace(`Native Android background sync schedule=${on ? 'on' : 'off'}`);
    };
    const appStateListeners = new Set<(state: string) => void>();
    /** What Kotlin's start order stored from the capture queue since the last run took it (core's drain port). */
    let imported = 0;
    /** A debug build's shorter run deadline (CoreWork's `bgsync_deadline_ms`, for the device check); null: core's 4 minutes. */
    let shortDeadlineMs: number | null = null;
    const runner = createMobileBackgroundSyncRunner({
        storage,
        log: { info: (message, context) => logLine('info', message, context), warn: (message, context) => logLine('warn', message, context) },
        sync: {
            getConfigurationStatus: () => service.getMobileSyncConfigurationStatus(),
            performSync: () => performSync(undefined, {}),
            // The run's own abort: the cycle ends with no follow-up (a lifecycle abort would queue one that outlives the job).
            abort: () => service.abortMobileSync('deadline'),
            setRequestDeadline: syncFetch.setDeadline,
        },
        flushPendingSave: () => flushPendingSave(),
        // The queue was drained before the job (ProcessCoreHost.recovered, the app's start order); this reports what it stored.
        drainPendingCaptures: async () => {
            const count = imported;
            imported = 0;
            return count;
        },
        // Native writes are synchronous FULL commits: a debounced store save is the only deferred write.
        quiesceStorage: () => flushPendingSave(),
        timersPaused: () => false,
        deadlineMs: () => shortDeadlineMs ?? MOBILE_BACKGROUND_SYNC_DEADLINE_MS,
        onAppStateChange: (listener) => {
            appStateListeners.add(listener);
            return { remove: () => { appStateListeners.delete(listener); } };
        },
    });

    // ---- Settings › Sync's device (native-host-contract-settings-sync.ts) ----

    const settingsHost: NativeSyncSettingsHost = {
        platform: { os: platform, cloudKitAvailable: false, isFossBuild: bindings.isFossBuild, dropboxAppKey: '' },
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
                    } catch (error) {
                        if (platform === 'ios' && error instanceof SyncEncryptionArtifactCapacityError) {
                            try {
                                await logLine('warn', 'Native iOS encryption enable capacity refused', { scope: 'native-ios', force: true,
                                    extra: { releaseCheck: 'v1.3.5/ios-encryption-enable-capacity', operation: 'enable', outcome: 'refused' } });
                            } catch { /* Diagnostics cannot replace the capacity refusal. */ }
                        }
                        throw error;
                    }
                },
                change: (current, next, options) => transitions.changeSyncEncryptionPassphrase(current, next, options),
                disable: (options) => transitions.disableSyncEncryption(options),
                provide: async (passphrase) => {
                    const outcome = await transitions.provideSyncEncryptionPassphrase(passphrase);
                    if (platform === 'ios' && settingsHost.encryption.unlockOnly && outcome === 'ok') {
                        await logLine('info', 'Native iOS encrypted unlock service completed', { scope: 'native-ios', force: true,
                            extra: { releaseCheck: 'v1.3.5/ios-encryption-unlock', operation: 'unlock', outcome: 'confirmed' } });
                    }
                    return outcome;
                },
                decline: () => transitions.declineSyncEncryptionPassphrase(),
                abandon: () => transitions.abandonSyncEncryptionTransition(),
                recheck: () => transitions.recheckPartlyEncryptedLocation(),
                randomBytes: (length) => crypto.randomBytes(length),
            },
            isBackendPending: () => transitions.isSyncEncryptionBackendPending(),
        },
        log: {
            info: (message, context) => logLine('info', message, context),
            error: (error) => { void logError(error, { scope: 'settings' }); },
        },
    };

    // ---- Automatic sync: core's triggers, as RN's use-root-layout-sync-effects.ts binds them ----

    let triggers: MobileSyncTriggers | null = null;
    let online: boolean | null = null;

    /** RN's showSyncIssue: one warning toast for an automatic failure, with Open for Settings › Sync. */
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

    return {
        settingsHost,
        performStoredAutomaticSync,
        /** The editor's and the project screen's attachment IO (core's NativeAttachmentsHost); null without app files. */
        attachmentsHost: attachments?.contractHost ?? null,
        prepareAttachmentAvailableDetailed: attachments?.prepareAttachmentAvailableDetailed ?? null,
        /** The badge and cycle count now. */
        state,
        /**
         * After the boot's validated load and journal replay: the triggers start, and the app's first sync is asked for
         * (RN's startup requestSync(0)). [appState] is 'active' or 'background'.
         */
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
        /** RN's AppState change ('active', 'background'). */
        appState(next: string) {
            triggers?.handleAppStateChange(next);
            for (const listener of Array.from(appStateListeners)) listener(next);
            return state();
        },
        /**
         * One background run (core's runner), after Kotlin's start order drained the queue: `trigger` 'scheduled' (the periodic
         * job) or 'capture' (a capture stored while the app was closed, #1257), `stored` what those drains stored (0 while the app
         * shows: the foreground triggers send it). It resolves once the run settled (synced, failed and recorded, skipped, or
         * abandoned at core's deadline; `deadlineMs` shortens it, debug builds only, 0 for core's). `schedule`: whether the job
         * should run again.
         */
        async backgroundSync(trigger: MobileBackgroundSyncTrigger, stored: number, deadlineMs = 0) {
            if (platform === 'ios') throw new Error('Background sync is not available on this iOS build');
            imported += stored;
            shortDeadlineMs = deadlineMs > 0 && deadlineMs < MOBILE_BACKGROUND_SYNC_DEADLINE_MS ? deadlineMs : null;
            if (trigger === 'capture') await runner.runCapture();
            else await runner.run('scheduled');
            return { schedule: await backgroundSyncWanted() };
        },
        /**
         * The device's network changed (expo-network's listener): a running cycle stops when it went offline. Coming back
         * online asks for an automatic sync through core's pacing (RN catches up in its background job, which comes with S4).
         */
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
