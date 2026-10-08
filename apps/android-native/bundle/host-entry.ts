import {
    DEFAULT_GLOBAL_SEARCH_FILTERS,
    NativeReceiptSqliteAdapter,
    PENDING_CAPTURES_DIRECTORY,
    PENDING_CAPTURE_LAST_APPLIED_STORAGE_KEY,
    NATIVE_HOST_CONTRACT_VERSION,
    NativeAttachmentCleanupUnconfirmedError,
    CLOUD_PROVIDER_KEY,
    SYNC_BACKEND_KEY,
    generateUUID,
    NATIVE_REMINDER_STATE_STORAGE_KEY,
    REMINDER_ALARM_MAP_STORAGE_KEY,
    REMINDER_NOTIFICATION_CHANNEL_NAME,
    STATUS_COLORS_BY_THEME,
    type SqliteAdapter,
    TASK_PRIORITY_COLORS,
    consoleLogger,
    createDiagnosticsLog,
    buildImmediateNotificationDetails,
    buildNativeBackupDocumentResult,
    buildNativeBackupSnapshotRestoreConfirmation,
    commitNativeBackupDocument,
    inspectNativeBackupDocument,
    prepareNativeBackupDocument,
    readNativeBackupDocumentOutcome,
    validateNativeAttachmentDraftBegin,
    validateNativeAttachmentDraftLineage,
    prepareNativeAttachmentDraftAdd,
    validateNativeAttachmentDraftBeginV2,
    validateNativeAttachmentDraftLineageV2,
    prepareNativeAttachmentDraftAddV2,
    validateNativeAttachmentDraftBeginV3, validateNativeAttachmentDraftBeginV4, validateNativeAttachmentDraftBeginV5,
    validateNativeAttachmentDraftLineageV3, validateNativeAttachmentDraftLineageV4, validateNativeAttachmentDraftLineageV5,
    prepareNativeAttachmentDraftAddV3, prepareNativeAttachmentDraftAddV4,
    prepareNativeAttachmentDraftRemoveV3, prepareNativeAttachmentDraftRemoveV4,
    prepareNativeAttachmentDraftAvailability,
    readNativeAttachmentDraftRemoveFrozen,
    completeNativeAttachmentDraftAdd, completeNativeAttachmentDraftAddV4,
    prepareNativeAttachmentDraftDiscardCandidates,
    prepareNativeAttachmentDraftDiscardCandidatesV3, prepareNativeAttachmentDraftDiscardCandidatesV4, prepareNativeAttachmentDraftDiscardCandidatesV5,
    prepareNativeAttachmentCleanupWitness,
    isNativeAttachmentCleanupWitnessEligible,
    isAttachmentFileInUse,
    planAttachmentOpen,
    getAttachmentResolutionMessage,
    taskRevisionOf,
    formatI18nTemplate,
    canSaveTaskListTag,
    createNativeHostContract,
    diagnosticsEntryFromLogPayload,
    getGeneralSettingsDeviceWrites,
    getPersistenceStatus,
    compareAppVersions,
    fetchAppStoreInfo,
    UPDATE_BADGE_AVAILABLE_KEY,
    UPDATE_BADGE_LAST_CHECK_KEY,
    UPDATE_BADGE_LATEST_KEY,
    shouldCheckForAppUpdate,
    getStorageAdapter,
    isSupportedLanguage,
    isDiagnosticsLoggingEnabled,
    isSandboxMode,
    isWorkspaceTransitionActive,
    legacyImportMismatch,
    assertNativeLegacyBackupSafe,
    loadNativeRequestReceipts,
    logInfo,
    logWarn,
    planLegacyJsonImport,
    pruneNativeRequestReceipts,
    setNativeReplayTokens,
    setLogger,
    setStorageAdapter,
    splitSqlStatements,
    sqliteHasAnyData,
    themeDescriptor,
    resolveThemeStatusPreset,
    type AppTheme,
    type DiagnosticsLogFile,
    type FocusTaskSectionKey,
    type SqliteClient,
    useTaskStore,
    flushPendingSave,
    formatListItemCount,
    getBulkMoveStatusOptions,
    type TaskStatus,
    type Task,
    type Project,
    webdavDeleteFile,
    webdavGetFile,
    webdavGetJson,
    webdavGetSyncDocument,
    webdavHeadFile,
    cloudHeadJson,
    webdavMakeDirectory,
    webdavPutFile,
    webdavPutJson,
} from '@mindwtr/core';
import { createNativeAI } from './host-ai';
import { createNativeLocalAttachmentsForHost, nativeFileChannels, prepareNativeTaskAttachmentAvailabilityPreflight,
    prepareNativeTaskAttachmentAvailability, prepareNativeProjectFileAvailability, nativeProjectFileAvailabilityInitialURL,
    createNativeReadOnlySelfHostedAttachments, assertNativeSelfHostedAttachmentEncryptionAdmission } from './host-attachments';
import { PROJECT_SQLITE_COLUMNS } from '../../../packages/core/src/project-sync-schema';
import { createPreparedProjectAvailabilityMethods, createProjectAvailabilityMethods } from '../../../packages/core/src/native-host-contract-project-availability';
import { SYNC_ENCRYPTION_STATE_KEY } from '../../../packages/core/src/sync-storage-keys';
import { createNativeReminders } from './host-reminders';
import { createNativeSync, createHostSyncCrypto, isNativeIosSelfHostedProvider, type NativeSync, type NativeSyncBindings } from './host-sync';
import { createWidgetPublisher, type WidgetInputs } from './host-widgets';

type NativeBridge = {
    sqlRun(sql: string, params: string): string | null;
    sqlAll(sql: string, params: string): string;
    sqlExec(sql: string): string | null;
    nowMs(): number;
    randomBytes(length: number): string;
    log(line: string): void;
    rnStateCommit(change: string): string | null;
    /** RN's diagnostics log file (files/logs/mindwtr.log): one operation of core's DiagnosticsLogFile, as text. */
    logFile(operation: string, text: string): string;
    fileList(path: string): string;
    fileRead(path: string): string;
    fileDelete(path: string): string | null;
    /** RN's AsyncStorage (RnKeyValue.kt): reads answer JSON; a write is on disk when it returns. */
    kvGet(key: string): string;
    kvSet(key: string, value: string): string | null;
    kvRemove(key: string): string | null;
    kvMultiGet(keysJson: string): string;
    kvMultiSet(pairsJson: string): string | null;
    kvMultiRemove(keysJson: string): string | null;
    /** An event for Kotlin (CoreHost's event listener): sync's badge and cycle count, an automatic sync's warning. */
    hostEvent(json: string): string | null;
    /** Android only: opens an android.os.Trace section named `name`, or closes the open one for "". */
    trace?(name: string): void;
    /** Reminder alarms (Reminders.kt): core's plan applied in core's order; the notification permission; RN's alarms cancelled once. */
    alarmApply?(planJson: string): string | null;
    notificationsAllowed?(): boolean | string;
    rnAlarmCleanup?(): number | string;
    reminderReceiverCounts?(): string;
    reminderLedger?(): string;
    /** RN's widget module on Android (HostWidgets.kt): the publication's device inputs as JSON, and the payload to write and draw. */
    widgetInputs?(): string;
    widgetPublish?(payload: string): string | null;
    widgetAppState?(): string;
    /** Android only (BackgroundSync.kt): the background sync job kept scheduled (true) or cancelled (false), as core decides. */
    bgSyncSchedule?(on: boolean): string | null;
};

declare const globalThis: Record<string, unknown> & { MindwtrHost?: unknown; fetch: typeof fetch };
const native = (): NativeBridge => {
    const bridge = globalThis.__mindwtrNative as NativeBridge | undefined;
    if (!bridge) throw new Error('Native bridge unavailable');
    return bridge;
};

// Kotlin returns a storage exception as a marked string (see CoreHost.guarded):
// a Java exception thrown across the QuickJS JNI boundary aborts the process.
const NATIVE_ERROR = '!MindwtrNativeError:';
const checked = <T,>(value: T): T => {
    if (typeof value === 'string' && value.startsWith(NATIVE_ERROR)) throw new Error(value.slice(NATIVE_ERROR.length));
    return value;
};

/**
 * Boot steps as trace sections for startup profiling (Perfetto): each call closes the step before it and opens `name`
 * ("" only closes). A host without the trace call (iOS) ignores it. A boot that throws leaves its step open; that host is
 * closed anyway.
 */
let tracedStep = false;
const traceStep = (name: string) => {
    const bridge = native();
    if (!bridge.trace) return;
    if (tracedStep) bridge.trace('');
    tracedStep = name !== '';
    if (tracedStep) bridge.trace(name);
};

const sqlite: SqliteClient = {
    run: async (sql, params) => { checked(native().sqlRun(sql, JSON.stringify(params ?? []))); },
    all: async <T,>(sql: string, params?: unknown[]): Promise<T[]> =>
        JSON.parse(checked(native().sqlAll(sql, JSON.stringify(params ?? [])))) as T[],
    get: async <T,>(sql: string, params?: unknown[]): Promise<T | undefined> =>
        (JSON.parse(checked(native().sqlAll(sql, JSON.stringify(params ?? [])))) as T[])[0],
    exec: async (sql) => {
        for (const statement of splitSqlStatements(sql)) checked(native().sqlExec(statement));
    },
};

/**
 * RN's AsyncStorage, in place (RKStorage, RnKeyValue.kt): RN's device keys under RN's names, as AsyncStorage's calls take and
 * answer them. A write has reached the disk when its promise resolves.
 */
const keyValue = {
    get: async (key: string): Promise<string | null> => (JSON.parse(checked(native().kvGet(key))) as [string | null])[0],
    set: async (key: string, value: string): Promise<void> => { checked(native().kvSet(key, value)); },
    remove: async (key: string): Promise<void> => { checked(native().kvRemove(key)); },
    multiGet: async (keys: readonly string[]): Promise<[string, string | null][]> =>
        JSON.parse(checked(native().kvMultiGet(JSON.stringify(keys)))) as [string, string | null][],
    multiSet: async (pairs: readonly (readonly [string, string])[]): Promise<void> => { checked(native().kvMultiSet(JSON.stringify(pairs))); },
    multiRemove: async (keys: readonly string[]): Promise<void> => { checked(native().kvMultiRemove(JSON.stringify(keys))); },
};

/**
 * RN's diagnostics log on Kotlin's file bridge: core decides every write (diagnostics-log.ts: the Debug logging switch or a
 * forced line, the JSON line, the size cap, one write at a time); Kotlin appends each line in one write, so a kill keeps it.
 */
const logFile = (operation: string, text = ''): string => checked(native().logFile(operation, text));
const nativeLogFile: DiagnosticsLogFile = {
    path: async () => logFile('path') || null,
    ensure: async () => logFile('ensure') || null,
    exists: async () => logFile('exists') === '1',
    read: async () => logFile('read'),
    write: async (text) => { logFile('write', text); },
    delete: async () => logFile('delete') === '1',
    append: async (line) => { logFile('append', line); return true; },
    size: async () => Number(logFile('size')),
    moveAside: async () => { logFile('moveAside'); },
    ...(globalThis.__mindwtrHostPlatform === 'ios' ? {
        isAbsent: async () => logFile('isAbsent') === '1',
    } : {}),
};
const diagnosticsLog = createDiagnosticsLog({
    isEnabled: () => isDiagnosticsLoggingEnabled(useTaskStore.getState().settings),
    files: [nativeLogFile],
});
// Core's logger, as RN's _layout.tsx bridges it: logcat (the console), then the log file with RN's line.
setLogger((payload) => {
    consoleLogger(payload);
    try {
        void diagnosticsLog.append(diagnosticsEntryFromLogPayload(payload), { force: payload.force });
    } catch { /* a diagnostic line must never fail its caller */ }
});

// The pending-captures queue under the app's files folder (Kotlin's HostFiles), and the record of the last queued command
// applied to each task in RN's RKStorage (Kotlin's RnKeyValue), durable before kvSet returns: core's ingestPendingCaptures ports.
const QUEUE = `files/${PENDING_CAPTURES_DIRECTORY}`;
const pendingCaptureQueue = {
    list: async () => JSON.parse(checked(native().fileList(QUEUE))) as string[] | null,
    read: async (name: string) => checked(native().fileRead(`${QUEUE}/${name}`)),
    delete: async (name: string) => { checked(native().fileDelete(`${QUEUE}/${name}`)); },
};
const lastAppliedRecord = {
    read: async () => (JSON.parse(checked(native().kvGet(PENDING_CAPTURE_LAST_APPLIED_STORAGE_KEY))) as [string | null])[0],
    write: async (value: string) => { checked(native().kvSet(PENDING_CAPTURE_LAST_APPLIED_STORAGE_KEY, value)); },
};

type LoadedData = Awaited<ReturnType<SqliteAdapter['getData']>>;
const ENTITY_TABLES = ['tasks', 'projects', 'sections', 'areas', 'people'] as const;
type EntityTable = typeof ENTITY_TABLES[number];
// Core's receipt adapter: a write's request receipt commits in the same transaction as its data.
class ValidatedSqliteAdapter extends NativeReceiptSqliteAdapter {
    latestData: LoadedData | null = null;

    override async getData(options?: { rawTasks?: true }): Promise<LoadedData> {
        const data = await super.getData(options);
        await this.validate((table) => data[table].length, data.settings);
        if (!options?.rawTasks) this.latestData = data;
        return data;
    }

    /**
     * After activation and its flush: the database holds exactly the store's rows, by id, per entity table, and its settings
     * row and saved filters map whole. Core reads row versions instead of whole rows and refreshes the deletion baseline from
     * them (the rowids of rows activation's save created) under the epoch its last full read accepted; after another
     * connection's commit, a full validated read instead.
     */
    async verifyActivation(store: Record<EntityTable, readonly { id: string }[]>): Promise<void> {
        const light = await this.readRowBaseline();
        let ids: Record<EntityTable, readonly string[]>;
        if (light) {
            ids = light.ids;
            await this.validate((table) => light.ids[table].length, light.settings);
        } else {
            const data = await this.getData();
            ids = Object.fromEntries(ENTITY_TABLES.map((table) => [table, data[table].map((row) => row.id)])) as Record<EntityTable, string[]>;
        }
        for (const table of ENTITY_TABLES) {
            const stored = new Set(ids[table]);
            const seen = new Set<string>();
            for (const { id } of store[table]) {
                if (!stored.has(id) || seen.has(id)) throw new Error(`Incomplete ${table} activation`);
                seen.add(id);
            }
            if (store[table].length !== ids[table].length) throw new Error(`Incomplete ${table} activation`);
        }
        try {
            const ios = globalThis.__mindwtrHostPlatform === 'ios';
            logInfo(ios ? 'Native iOS activation check' : 'Native Android activation check', {
                scope: ios ? 'native-ios' : 'native-android', category: 'storage',
                context: { releaseCheck: 'v1.3.4/native-startup-activation-check', outcome: light ? 'row-versions' : 'full-read' },
            });
        } catch { /* a diagnostic line never fails the boot */ }
    }

    /**
     * A read against the database: each entity table's rows against the rows the read mapped ([loaded]), the settings row
     * against the settings core mapped from it, and the saved filters' rows against the mapped list.
     */
    private async validate(loaded: (table: EntityTable) => number, settingsLoaded: LoadedData['settings']): Promise<void> {
        for (const table of ENTITY_TABLES) {
            const rows = await sqlite.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
            if (loaded(table) !== rows?.n) throw new Error(`Incomplete ${table} load`);
        }
        const settingsCount = await sqlite.get<{ n: number }>('SELECT COUNT(*) AS n FROM settings WHERE id = 1');
        const settings = await sqlite.get<{ data: string }>('SELECT data FROM settings WHERE id = 1');
        if (![0, 1].includes(settingsCount?.n ?? -1) || (settingsCount?.n === 1) !== Boolean(settings)) {
            throw new Error('Incomplete settings load');
        }
        if (settings) {
            const parsed = JSON.parse(settings.data) as Record<string, unknown>;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings load');
            for (const [key, value] of Object.entries(parsed)) {
                if (key !== 'savedFilters' && JSON.stringify(settingsLoaded[key as keyof typeof settingsLoaded]) !== JSON.stringify(value)) {
                    throw new Error('Incomplete settings load');
                }
            }
        }
        const savedFilters = await sqlite.get<{ n: number }>('SELECT COUNT(*) AS n FROM saved_filters');
        if (!Number.isSafeInteger(savedFilters?.n) || savedFilters!.n < 0
            || (savedFilters!.n > 0 && settingsLoaded.savedFilters?.length !== savedFilters!.n)) {
            throw new Error('Incomplete saved filters load');
        }
    }
}

type Pending = { done: boolean; value?: unknown; error?: string; controller: AbortController };
const pending = new Map<number, Pending>();
let nextId = 1;
/** Runs [work] as one host operation; [work]'s signal fires if the operation outlives its deadline (MindwtrHost.cancel). */
const submit = (work: (signal: AbortSignal) => Promise<unknown>): string => {
    const id = nextId++;
    const slot: Pending = { done: false, controller: new AbortController() };
    pending.set(id, slot);
    void work(slot.controller.signal).then(
        (value) => { slot.value = value; },
        (error) => { slot.error = error instanceof Error ? error.message : String(error); },
    ).finally(() => { slot.done = true; });
    return String(id);
};

/**
 * Automatic Sync belongs to the Android host. iOS foreground Sync is explicitly
 * bound on demand; device storage alone never activates Sync, AI or attachment ownership.
 */
/** The Android build's flavor (D8, CoreHost's BuildConfig.FOSS; absent elsewhere): as RN's FOSS_BUILD, it hides Dropbox and defaults speech to Whisper. */
const isFossBuild = globalThis.__mindwtrFossBuild === true;
const nativeSyncBindings: NativeSyncBindings = {
    keyValue,
    secrets: {
        getSecret: (key) => (globalThis.__mindwtrSyncSecrets as HostSecrets).getSecret(key),
        setSecret: (key, value, accessibility) => (globalThis.__mindwtrSyncSecrets as HostSecrets).setSecret(key, value, accessibility),
        deleteSecret: (key) => (globalThis.__mindwtrSyncSecrets as HostSecrets).deleteSecret(key),
    },
    localData: () => {
        if (!bootAdapter) throw new Error('Native storage is not loaded yet');
        return bootAdapter;
    },
    networkState: () => networkState,
    appendLog: async (entry, force) => {
        try { native().log(`${entry.level}: [${entry.scope}] ${entry.message}${entry.context ? ` ${JSON.stringify(entry.context)}` : ''}`); } catch { /* logcat is best effort */ }
        return diagnosticsLog.append(entry, { force });
    },
    translate: (key) => {
        const result = contract.getStrings({ keys: [key] });
        return result.ok ? result.value.strings[key] ?? key : key;
    },
    emit: (event) => { checked(native().hostEvent(JSON.stringify(event))); },
    trace: (line) => { try { native().log(line); } catch { /* logcat is best effort */ } },
    scheduleBackgroundSync: (on) => { const bridge = native(); if (bridge.bgSyncSchedule) checked(bridge.bgSyncSchedule(on)); },
    isFossBuild,
};
// kvMultiGet, not kvGet: the gates' stand-in bridge has kvGet and kvSet for the queue's record, and no sync.
// iOS device storage is not permission to replace its local attachment owner or start Sync/AI.
const nativeSync: NativeSync | null = globalThis.__mindwtrHostPlatform !== 'ios'
    && typeof (globalThis.__mindwtrNative as { kvMultiGet?: unknown } | undefined)?.kvMultiGet === 'function'
    ? createNativeSync(nativeSyncBindings)
    : null;
let iosManualSync: NativeSync | null = null;
let iosCleanupCallback: ((requestJSON: string) => unknown) | null = null;
let iosProjectAttachmentDownload = false;
let iosRelocatedProjectAvailability = false;
let iosCachedProjectAvailability = false;
let iosSelfHostedProjectAttachments: ReturnType<typeof createNativeReadOnlySelfHostedAttachments> | null = null;
let iosTaskAttachmentPreparation = false;
let iosProjectFilePreparation = false;
let iosForegroundFailure: NativeAttachmentCleanupUnconfirmedError | null = null;
/** The device's network state as Kotlin last reported it (HostNetwork.kt); unknown until then, which never reads as offline. */
let networkState: { isConnected: boolean | null; isInternetReachable: boolean | null } = { isConnected: null, isInternetReachable: null };
const requireSync = (): NativeSync => {
    if (!nativeSync) throw new Error('Sync is not available on this host');
    return nativeSync;
};

/** The language Kotlin last passed to setLanguage (RN's `mindwtr-language`), which the widgets' language falls back on as RN's does. */
let storedLanguage: string | null = null;
/** The home-screen widgets (host-widgets.ts), on a host with RN's widget module (Android); none on iOS or the gates' bridge. */
const widgets = typeof (globalThis.__mindwtrNative as { widgetPublish?: unknown } | undefined)?.widgetPublish === 'function'
    ? createWidgetPublisher({
        ready: () => bootAdapter !== null,
        inputs: () => JSON.parse(checked(native().widgetInputs!())) as WidgetInputs,
        publish: (payload) => { checked(native().widgetPublish!(payload)); },
        storedLanguage: () => storedLanguage,
        active: () => checked(native().widgetAppState!()) === 'active',
    })
    : null;

/** Settings › AI and the AI actions (host-ai.ts), on the same host: RN's AsyncStorage and SecureStore hold what RN's do. */
const nativeAI = nativeSync ? createNativeAI(keyValue, () => globalThis.__mindwtrSecrets as HostSecrets, isFossBuild) : null;

const localAttachments = nativeSync ? null : createNativeLocalAttachmentsForHost();
const attachmentsHost = nativeSync?.attachmentsHost ?? localAttachments?.contractHost;
const contract = createNativeHostContract({ get syncSettings() { return nativeSync?.settingsHost ?? iosManualSync?.settingsHost; }, ...(nativeAI ? { ai: nativeAI } : {}),
    get attachments() {
        const selected = iosProjectAttachmentDownload ? iosSelfHostedProjectAttachments?.contractHost ?? iosManualSync?.attachmentsHost : attachmentsHost;
        if (!iosRelocatedProjectAvailability || !selected) return selected ?? undefined;
        return { ...selected, ensureAttachmentAvailableDetailed: async (attachment: import('../../../packages/core/src/types').Attachment) => {
            const result = await (iosSelfHostedProjectAttachments ?? iosManualSync)?.prepareAttachmentAvailableDetailed?.(attachment);
            if (result?.status === 'available') return { status: 'available' as const, attachment: result.attachment };
            return { status: result?.status === 'generation-conflict' ? 'generation-conflict' as const : 'unavailable' as const };
        } };
    } });

const projectAvailabilityDeps = (projectId: string): Parameters<typeof createPreparedProjectAvailabilityMethods>[0] => ({
    readiness: () => {
        const ready = contract.getProjectAttachmentEditOptions({ projectId });
        return ready.ok ? { ok: true, value: null } : ready;
    },
    revision: () => {
        const options = contract.getProjectAttachmentEditOptions({ projectId });
        return options.ok ? options.value.revision : '';
    },
    save: async () => {
        try { await flushPendingSave(); requireSaved(); return { ok: true, value: null }; }
        catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Selected Project availability could not be confirmed' } }; }
    },
});
const preparedProjectAvailability = (projectId: string, backend: string = 'cloud') => {
    if (backend !== 'cloud' && backend !== 'webdav') throw new Error('NOT_READY: Project download is unavailable');
    return createPreparedProjectAvailabilityMethods({
    ...projectAvailabilityDeps(projectId), translate: (key) => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key,
}, backend === 'webdav' ? 'webdav' : 'strict');
};

/**
 * Reminder alarms (host-reminders.ts), on a host with the alarm bridges (Android). The iOS host and the gates' stand-in bridge have
 * none, so they plan no alarms, as before.
 */
const reminders = typeof (globalThis.__mindwtrNative as { alarmApply?: unknown } | undefined)?.alarmApply === 'function'
    ? createNativeReminders({
        plan: (input) => contract.planReminderAlarms(input),
        planSnooze: (input) => contract.planReminderSnooze(input),
        readStored: async () => ({ alarms: await keyValue.get(REMINDER_ALARM_MAP_STORAGE_KEY), state: await keyValue.get(NATIVE_REMINDER_STATE_STORAGE_KEY) }),
        permissionGranted: () => checked(native().notificationsAllowed!()) === true,
        apply: (planJson) => { checked(native().alarmApply!(planJson)); },
        cleanupRn: () => Number(checked(native().rnAlarmCleanup!())),
        receiverCounts: () => JSON.parse(String(checked(native().reminderReceiverCounts!()))) as { dropped: number; notQueued: number },
        ledger: () => JSON.parse(String(checked(native().reminderLedger!()))) as { fired: number[]; shown: number[] },
    })
    : null;
const requireReminders = () => {
    if (!reminders) throw new Error('Reminder alarms are not available on this host');
    return reminders;
};
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if ('error' in result) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const editorJson = (json: string): unknown => {
    try { if (json.length <= 2_000_000) return JSON.parse(json); }
    catch { /* Never expose a parser's excerpt of a credential-bearing URL. */ }
    throw new Error('Invalid bounded editor request');
};
// Typed bridge assertions only select each contract method's request type.
// Its readRequest/readPrepared parser still validates the untrusted JSON value.
const completionJson = (json: string, limit: number): unknown => {
    try { if (json.length <= limit) return JSON.parse(json); }
    catch { /* Do not expose a parser excerpt of task text or a link. */ }
    throw new Error('Invalid bounded completion request');
};
const taskAttachmentInput = (json: string, fields: string[], optional: string[] = []): Record<string, unknown> => {
    const input = editorJson(json);
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((field) => !fields.includes(field) && !optional.includes(field))
        || fields.some((field) => !(field in input)))
        throw new Error('Invalid task attachment request');
    const owner = (input as Record<string, unknown>).owner;
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
        || Object.keys(owner).length !== 3 || (owner as Record<string, unknown>).kind !== 'task'
        || typeof (owner as Record<string, unknown>).taskId !== 'string'
        || !Array.isArray((owner as Record<string, unknown>).attachments))
        throw new Error('A task attachment owner is required');
    const editing = (input as Record<string, unknown>).editing;
    if (editing !== undefined && editing !== null && (typeof editing !== 'object' || Array.isArray(editing)
        || Object.keys(editing).length !== 3
        || ['attachmentId', 'title', 'uri'].some((field) => typeof (editing as Record<string, unknown>)[field] !== 'string')))
        throw new Error('Invalid task link edit');
    return input as Record<string, unknown>;
};
const projectAttachmentInput = (json: string, withAttachmentId = false): { projectId: string; attachmentId?: string } => {
    const input = json.length <= 2_000 ? editorJson(json) : null;
    const fields = withAttachmentId ? ['projectId', 'attachmentId'] : ['projectId'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length
        || fields.some((field) => {
            const id = (input as Record<string, unknown>)[field];
            return typeof id !== 'string' || !id || id.length > 500;
        })) throw new Error('Invalid project attachment request');
    return input as { projectId: string; attachmentId?: string };
};
type MenuCommand = 'activateProject' | 'somedayMove' | 'somedayUndo' | 'somedayTask' | 'somedaySection' | 'taskListSort' | 'archiveAction' | 'contextsAction' | 'trashAction' | 'reviewAction' | 'reviewTask' | 'calendarAction' | 'calendarCreate' | 'boardAction' | 'boardCreate'
    | 'bulkAction' | 'focusGroup' | 'focusSave' | 'focusCriterion' | 'focusDelete' | 'focusReorder' | 'bulkCreate' | 'mindSweepAdd' | 'savedSearchDelete'
    | 'generalSetting' | 'gtdSetting' | 'manageEditor' | 'manageDelete' | 'somedayRename' | 'somedayReorder' | 'somedayDelete' | 'dataSetting'
    | 'syncPreference' | 'setAISetting' | SyncScreenCommand | AIScreenCommand | AttachmentCommand | ProjectDetailCommand;
/** Settings › Sync's screen commands: never journaled (core's NATIVE_UNJOURNALED_COMMANDS), sent by CoreHost.syncCommand. */
type SyncScreenCommand = 'openSyncSettings' | 'closeSyncSettings' | 'selectSyncBackend' | 'saveSyncBackend' | 'syncNow' | 'testSyncConnection'
    | 'pickSyncFolder' | 'connectDropbox' | 'disconnectDropbox' | 'runSyncEncryptionAction';
/**
 * Settings › AI's screen writes, sent by AISettings.kt itself: its open (journaled; target-state), and a key or a base URL (never
 * journaled: core's NATIVE_UNJOURNALED_COMMANDS, a key or a URL that may hold a password).
 */
type AIScreenCommand = 'openAISettings' | 'setAIKey' | 'setAIEndpoint';
/** Attachments' writes, sent by Attachments.kt (the editor's draft list, a project's list written at once). */
type AttachmentCommand = 'attachmentAddFile' | 'attachmentLinks' | 'attachmentRemove';
/** Project details' edit, sent by ProjectDetails.kt (journaled ahead): core's runProjectEdit. */
type ProjectDetailCommand = 'projectEdit';
type Command = 'create' | 'complete' | 'update' | 'saveTaskDraft' | 'resetChecklist' | 'taskFocus' | 'projectFocus' | 'createProject' | 'areaFilter'
    | 'saveSearch' | 'inboxCommit' | 'inboxSkip' | 'quickCapture' | 'quickCaptureLines' | 'quickCapturePicker' | 'captureModal' | 'captureModalLines' | 'ingest' | 'reminderDone' | 'reminderSnooze' | MenuCommand;
const taskResult = <T>(operation: Command, result: Parameters<typeof unwrap<T>>[0]): T => {
    const ios = globalThis.__mindwtrHostPlatform === 'ios';
    const meta = {
        scope: ios ? 'native-ios' : 'native-android',
        category: 'storage' as const,
        context: { releaseCheck: ios ? 'v1.3.3/native-ios-dev-task-command' : 'v1.3.3/native-android-dev-task-command', operation, outcome: result.ok ? 'saved' : 'failed' },
    };
    try {
        const message = ios ? 'Native iOS task command' : 'Native Android task command';
        if (result.ok) logInfo(message, meta);
        else logWarn(message, meta);
    } catch { /* a diagnostic sink must not change a durable acknowledgment */ }
    return unwrap(result);
};

type LegacyState = { jsonAhead: boolean; reconciled: boolean; backupVersion: string | null; backupPresent: boolean };

/**
 * The React Native app's AsyncStorage backup, imported as RN's next launch would
 * (core's planLegacyJsonImport). Runs after the validated load. RN's own state
 * (the json-ahead marker, the reconcile flag) changes only after the validated
 * re-read holds every imported row and the settings exactly.
 *
 * If that RN state change fails, the boot fails closed: no activation, so no
 * native edit can exist while the marker is still set. Core's merge can let a
 * tombstone beat a newer live row, so re-importing a stale backup over native
 * edits could discard them. The next boot plans again, finds the import already
 * saved, writes nothing to SQLite, and retries only the RN state change.
 */
const importLegacyJson = async (adapter: ValidatedSqliteAdapter, state: LegacyState, backup: string): Promise<void> => {
    const loaded = adapter.latestData;
    if (!loaded) throw new Error('Native storage load was not validated');
    const plan = planLegacyJsonImport({
        jsonAhead: state.jsonAhead,
        reconciled: state.reconciled,
        backupVersion: state.backupVersion,
        backupJson: state.backupPresent ? backup : null,
    }, loaded, await sqliteHasAnyData(sqlite));
    if (plan.merged && legacyImportMismatch(plan.merged, loaded)) {
        await adapter.saveData(plan.merged);
        const mismatch = legacyImportMismatch(plan.merged, await adapter.getData());
        if (mismatch) throw new Error(`Legacy import not confirmed: ${mismatch}`);
    }
    let rnState = 'unchanged';
    let rnFailure = '';
    if (plan.clearJsonAhead || plan.setReconciled) {
        try {
            checked(native().rnStateCommit(JSON.stringify({ clearJsonAhead: plan.clearJsonAhead, setReconciled: plan.setReconciled })));
            rnState = 'updated';
        } catch (error) {
            rnState = 'failed';
            rnFailure = error instanceof Error ? error.message : String(error);
        }
    }
    if (plan.outcome !== 'none') logLegacyImport(plan, rnState);
    if (rnState === 'failed') throw new Error(`Cannot update the previous app version's saved state: ${rnFailure}`);
};

const logLegacyImport = (plan: ReturnType<typeof planLegacyJsonImport>, rnState: string): void => {
    const ios = globalThis.__mindwtrHostPlatform === 'ios';
    const extra: Record<string, string> = {
        releaseCheck: ios ? 'v1.3.3/native-ios-legacy-json-import' : 'v1.3.3/native-android-legacy-json-import', outcome: plan.outcome, path: plan.path ?? '', rnState,
    };
    if (plan.reason) extra.reason = plan.reason;
    for (const [name, count] of Object.entries(plan.counts ?? {})) extra[name] = String(count);
    const meta = { scope: ios ? 'native-ios' : 'native-android', category: 'storage' as const, context: extra };
    try {
        const message = ios ? 'Native iOS legacy JSON import' : 'Native Android legacy JSON import';
        if (rnState === 'failed') logWarn(message, meta);
        else logInfo(message, meta);
    } catch { /* a diagnostic sink must not fail the boot */ }
};

// After a failed save the store holds changes that are not on disk. Reads
// wait for the exact retry, so no screen treats those changes as stored.
const requireSaved = () => {
    const failure = useTaskStore.getState().persistenceFailure;
    if (failure) throw new Error('SAVE_FAILED: Previous changes could not be saved; retry before continuing');
};

/** host-polyfills.js's secret calls (SecretStore.kt). */
type HostSecrets = {
    getSecret(key: string): Promise<string | null>;
    setSecret(key: string, value: string, accessibility?: 'after-first-unlock' | 'when-unlocked'): Promise<void>;
    deleteSecret(key: string): Promise<void>;
};

/**
 * Debug builds only (CoreHost.netCheck): check-net-device.mjs's server at http://127.0.0.1:<port> (adb reverse). Core's
 * WebDAV calls (PUT, GET, HEAD, bytes both ways, MKCOL answered 409 then PROPFIND, a refused and a followed redirect,
 * DELETE, five damaged bodies), an abort, core's timeout, AbortSignal.timeout, and a secret round trip, each step's outcome
 * in the answer.
 * It touches no task data.
 */
const runNetCheck = async (port: string) => {
    if (!/^\d{4,5}$/.test(port)) throw new Error('INVALID_INPUT: net check port');
    const base = `http://127.0.0.1:${port}`;
    const steps: Record<string, { ok: boolean; value?: unknown; name?: string; error?: string; ms: number }> = {};
    const step = async (name: string, work: () => Promise<unknown>) => {
        const started = Date.now();
        try {
            steps[name] = { ok: true, value: await work(), ms: Date.now() - started };
        } catch (error) {
            steps[name] = {
                ok: false,
                name: error instanceof Error ? error.name : typeof error,
                error: error instanceof Error ? error.message : String(error),
                ms: Date.now() - started,
            };
        }
    };
    const doc = { check: 'net', text: 'Grüße ✓ 😀' };
    await step('put', async () => (await webdavPutJson(`${base}/dav/data.json`, doc)).etag);
    await step('get', () => webdavGetJson(`${base}/dav/data.json`));
    await step('head', async () => (await webdavHeadFile(`${base}/dav/data.json`)).contentLength);
    await step('putBytes', () => webdavPutFile(`${base}/dav/bytes.bin`, Uint8Array.from({ length: 256 }, (_, i) => i), 'application/octet-stream'));
    await step('getBytes', async () => new Uint8Array(await webdavGetFile(`${base}/dav/bytes.bin`)).every((value, i) => value === i));
    await step('mkcol', () => webdavMakeDirectory(`${base}/dav/folder`));
    await step('redirectPut', () => webdavPutJson(`${base}/dav/redirect.json`, doc));
    await step('redirectGet', () => webdavGetJson(`${base}/dav/moved.json`));
    await step('delete', () => webdavDeleteFile(`${base}/dav/data.json`));
    // A HEAD answered with `Content-Encoding: gzip` has no body to decode (cloud's HEAD lets OkHttp ask for gzip).
    await step('headGzipDav', async () => (await webdavHeadFile(`${base}/gz/data.json`)).etag);
    await step('headGzipCloud', async () => (await cloudHeadJson(`${base}/gz/data.json`)).etag);
    // Truncation: a body cut short, reset mid-chunk, over the size limit (declared or streamed), or a broken gzip stream.
    // Core's sync document read must throw: an empty or partial body would read as a missing remote, which sync writes over.
    // A body that is not UTF-8 must throw too, not read as other text (E2 alone once read as a space, so an empty body).
    for (const cut of ['half', 'reset', 'oversize', 'stream', 'gzip', 'utf8']) await step(`cut-${cut}`, () => webdavGetSyncDocument(`${base}/cut/${cut}.json`));
    await step('abort', () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 500);
        return webdavGetJson(`${base}/slow/abort`, { signal: controller.signal });
    });
    // An abort after the headers arrived, while the body is still coming: the host must still cancel the request.
    await step('abortBody', () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 500);
        return webdavGetJson(`${base}/slow/body`, { signal: controller.signal });
    });
    await step('timeout', () => webdavGetJson(`${base}/slow/timeout`, { timeoutMs: 1500 }));
    await step('signalTimeout', () => fetch(`${base}/slow/signal`, { signal: AbortSignal.timeout(1000) }));
    const secrets = globalThis.__mindwtrSecrets as HostSecrets;
    const key = 'mindwtr_native_net_check';
    await step('secretSet', () => secrets.setSecret(key, doc.text));
    await step('secretGet', () => secrets.getSecret(key));
    // The server reads the app's SecureStore file (adb run-as) while the secret is saved, then answers.
    await step('secretStored', async () => (await fetch(`${base}/secret-stored`)).json());
    await step('secretDelete', () => secrets.deleteSecret(key));
    await step('secretGone', () => secrets.getSecret(key));
    return steps;
};

/**
 * Debug builds only (CoreHost.netCheck): an operation that outlives its deadline. A GET the server never answers, sent
 * without the operation's signal so only the host's cancel stops it; then a write, which the host must refuse while the
 * operation drains. In `stuck` mode it also waits on a timer longer than the drain, so the host must stop instead.
 * The outcome is logged here: the host reports only that the operation timed out.
 */
const runNetDeadline = async (port: string, mode: string, signal: AbortSignal) => {
    if (!/^\d{4,5}$/.test(port) || !['drain', 'stuck'].includes(mode)) throw new Error('INVALID_INPUT: net deadline');
    const base = `http://127.0.0.1:${port}`;
    const events: string[] = [];
    signal.addEventListener('abort', () => events.push('signal'));
    try {
        await fetch(`${base}/slow/deadline-${mode}`);
        events.push('answered');
    } catch (error) {
        events.push(`fetch:${(error as Error).name}`);
    }
    if (mode === 'stuck') await new Promise((done) => setTimeout(done, 15_000));
    try {
        await fetch(`${base}/dav/after-${mode}.json`, { method: 'PUT', body: '{}' });
        events.push('written');
    } catch (error) {
        events.push(`write:${(error as Error).name}`);
    }
    native().log(`Native Android net deadline ${mode} events=${JSON.stringify(events)}`);
    return events;
};

/**
 * Debug builds only (`debug.mindwtr.native.intl_check=1`: CoreHost sets `__mindwtrIntlCheck` before this bundle runs): the
 * host's Intl (host-polyfills.js over IcuDateTimeFormat.kt) on core's option sets (calendar-view-model.ts,
 * recurrence-constants.ts, date.ts, widget-payload.ts, ics.ts, ticktick-import.ts, then defaults, hour cycles and styles),
 * in four locales and the device's own (no locale). One log line per case (logcat keeps about 4 KB a line) for
 * check-intl-device.mjs, which compares each with Node's Intl. check-boot-gates.mjs runs the same option sets. Touches no data.
 */
const INTL_CHECK_OPTIONS = [{ year: 'numeric', month: 'long' }, { month: 'short', day: 'numeric' }, { weekday: 'short', month: 'long', day: 'numeric' },
    { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }, { weekday: 'short', month: 'short', day: 'numeric' },
    { weekday: 'long', month: 'long', day: 'numeric' }, { weekday: 'long' }, { weekday: 'short' }, { weekday: 'narrow' },
    { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' },
    { timeZone: 'asia/tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }, undefined, {}, { hour: 'numeric', minute: '2-digit' },
    { hour: 'numeric', hour12: true }, { hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }, { dateStyle: 'medium', timeStyle: 'short' },
    { dateStyle: 'full' }, { timeStyle: 'long', timeZone: 'UTC' }, { era: 'short', year: 'numeric', timeZoneName: 'short' }];
const runIntlCheck = () => {
    const times = [Date.UTC(2026, 8, 6, 8, 5, 9), Date.UTC(2026, 0, 1, 0, 30, 0)];
    const cases: { locale?: string; options?: Intl.DateTimeFormatOptions; time: number }[] = [];
    for (const locale of ['en-US', 'de-DE', 'zh-CN', 'ja-JP', undefined]) {
        for (const options of INTL_CHECK_OPTIONS as (Intl.DateTimeFormatOptions | undefined)[]) {
            for (const time of times) cases.push({ locale, options, time });
        }
    }
    const attempt = (work: () => unknown) => {
        try { return work(); } catch (error) { return { error: error instanceof Error ? error.name : String(error) }; }
    };
    cases.forEach(({ locale, options, time }, index) => {
        const date = new Date(time);
        const made = attempt(() => new Intl.DateTimeFormat(locale, options));
        const dtf = made instanceof Intl.DateTimeFormat ? made : null;
        const result = {
            locale, options, time,
            resolved: dtf ? dtf.resolvedOptions() : made,
            format: dtf ? attempt(() => dtf.format(date)) : made,
            parts: dtf ? attempt(() => dtf.formatToParts(date)) : made,
            toLocaleString: attempt(() => date.toLocaleString(locale, options)),
            toLocaleDateString: attempt(() => date.toLocaleDateString(locale, options)),
            toLocaleTimeString: attempt(() => date.toLocaleTimeString(locale, options)),
        };
        native().log(`Native Android intl check ${index + 1}/${cases.length} ${JSON.stringify(result)}`);
    });
};

type Reply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
/**
 * A tap on one of this app's notifications (CoreNotifications.kt sends the notification's data): RN's payload as its notification
 * event reads it (notification-service-local.ts), routed by core's routeNotificationOpen, then opened as RN's open handler pushes
 * each route (use-root-layout-notification-open-handler.ts), in the entry point's shape. A task's or project's tap plans the alarms
 * again shortly after, as RN's event does.
 */
const isNotificationTap = (input: unknown): input is { kind: 'notification'; data?: unknown } => (input as { kind?: unknown } | null)?.kind === 'notification';
const notificationEntry = (input: { data?: unknown }): Reply => {
    const data = (input?.data && typeof input.data === 'object' ? input.data : {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const payload = {
        notificationId: text(data.alarmKey) ?? text(data.id), actionIdentifier: 'open', taskId: text(data.taskId), projectId: text(data.projectId),
        context: text(data.context), kind: text(data.kind),
    };
    if (payload.taskId || payload.projectId) reminders?.event();
    const result = contract.routeNotificationOpen(payload);
    if (!result.ok) return result;
    const route = result.value;
    const entry = { version: NATIVE_HOST_CONTRACT_VERSION, route: null as string | null, taskId: null as string | null, projectId: null as string | null,
        search: null, capture: null, captureModal: null, notice: null, contextToken: null as string | null };
    if (route.type === 'review') entry.route = '/review-tab';
    else if (route.type === 'task') Object.assign(entry, { route: '/focus', taskId: route.taskId });
    else if (route.type === 'project') Object.assign(entry, { route: '/projects-screen', projectId: route.projectId });
    else if (route.type === 'contexts') Object.assign(entry, { route: '/contexts', contextToken: route.token });
    else if (route.type === 'daily-review') entry.route = '/daily-review';
    else if (route.type === 'weekly-review') entry.route = '/weekly-review';
    return { ok: true, value: entry };
};
/** What an entry point opened, by kind only: never its URL, route text, or shared text. */
const logEntryPoint = (input: { kind?: unknown }, result: Reply): Reply => {
    const entry = result.ok ? result.value as { route: string | null; taskId: string | null; projectId: string | null; search: unknown; capture: unknown; captureModal: unknown; notice: unknown } : null;
    const outcome = !entry ? 'refused' : entry.captureModal ? 'captureModal' : entry.capture ? 'capture' : entry.notice ? 'notice' : entry.taskId ? 'task' : entry.projectId ? 'project'
        : entry.search ? 'search' : entry.route ? 'screen' : 'nothing';
    const kind = ['link', 'share', 'createNote', 'notification'].includes(input?.kind as string) ? input.kind as string : 'other';
    try {
        logInfo('Native Android entry point', { scope: 'native-android', context: { releaseCheck: 'v1.3.3/native-android-entry-point', kind, outcome } });
    } catch { /* a diagnostic sink must not change what the entry opens */ }
    return result;
};
/**
 * The Menu tab's reads (native-host-contract-menu-views.ts; History's tabs, Archive, Contexts and Trash from the list views
 * block; the Review screen and the Weekly and Daily Review from native-host-contract-review-views.ts; the Calendar and the
 * Board from native-host-contract-calendar.ts and native-host-contract-board.ts; Settings from native-host-contract-settings.ts):
 * each passes Kotlin's input to the contract method unchanged. The composer's open and edit write nothing, so they are reads.
 */
const MENU_READS: Record<string, (input: never) => Reply> = {
    more: () => contract.getMoreMenu(),
    projects: (input) => contract.getFilteredProjects(input),
    projectDetailView: (input) => contract.getProjectDetailView(input),
    projectTaskOrderView: (input) => contract.getProjectTaskOrderView(input),
    projectDetailFilterView: (input) => contract.getProjectDetailFilterView(input),
    projectDetailFilterOptions: (input) => contract.getProjectDetailFilterOptions(input),
    waiting: (input) => contract.getWaitingView(input),
    someday: (input) => contract.getSomedayView(input),
    reference: (input) => contract.getReferenceView(input),
    done: (input) => contract.getDoneView(input),
    collection: (input) => contract.getMenuViewCollection(input),
    moveDialog: (input) => contract.getSomedayMoveDialog(input),
    history: (input) => contract.getHistoryView(input),
    archive: (input) => contract.getArchiveView(input),
    contexts: (input) => contract.getContextsView(input),
    trash: (input) => contract.getTrashView(input),
    review: (input) => contract.getReviewOverview(input),
    reviewOverview: (input) => contract.getReviewOverview(input),
    weekly: (input) => contract.getWeeklyReview(input),
    weeklyReview: (input) => contract.getWeeklyReview(input),
    weeklyList: (input) => contract.getWeeklyReviewList(input),
    weeklyReviewList: (input) => contract.getWeeklyReviewList(input),
    daily: (input) => contract.getDailyReview(input),
    dailyReview: (input) => contract.getDailyReview(input),
    calendar: (input) => contract.getCalendarView(input),
    calendarSheet: (input) => contract.getCalendarItemSheet(input),
    calendarItem: (input) => contract.getCalendarItemSheet(input),
    calendarComposer: (input) => contract.openCalendarComposer(input),
    calendarEdit: (input) => contract.editCalendarComposer(input),
    calendarPreferences: () => contract.getCalendarPreferences(),
    board: (input) => contract.getBoardView(input),
    boardList: (input) => contract.getBoardList(input),
    // The Inbox tab and its filter sheet's tokens, Archive's tokens, a list's selection mode, and Focus's sheet lists.
    inbox: (input) => contract.getInboxView(input),
    inboxTokens: (input) => contract.getInboxFilterTokens(input),
    archiveTokens: (input) => contract.getArchiveFilterTokens(input),
    bulk: (input) => contract.getBulkActions(input),
    focus: (input) => contract.getFocus(input),
    focusSection: (input) => contract.getFocusSectionWindow(input),
    focusList: (input) => contract.getFocusControlsList(input),
    focusControls: (input) => contract.getFocusControlsList(input),
    // Settings (native-host-contract-settings.ts): the menu, General, GTD, Manage and its lists, and Manage's Someday sections.
    settingsMenu: (input) => contract.getSettingsMenu(input),
    generalSettings: (input) => contract.getGeneralSettings(input),
    gtdSettings: (input) => contract.getGtdSettings(input),
    manageSettings: (input) => contract.getManageSettings(input),
    manageList: (input) => contract.getManageSettingsList(input),
    manageCheck: (input) => contract.checkManageEditor(input),
    managePersonEditCheck: (input) => contract.checkPersonEdit(input),
    manageTaxonomyCheck: (input) => contract.checkTaxonomyName(input),
    managePersonCreateCheck: (input) => {
        const value = input as unknown as Record<string, unknown>;
        return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1
            && Object.prototype.hasOwnProperty.call(value, 'name') && typeof value.name === 'string' && value.name.length <= 500
            ? contract.checkManageEditor({ target: { type: 'newPerson' }, name: value.name })
            : { ok: false, error: { code: 'INVALID_INPUT', message: 'A bounded Person name is required' } };
    },
    somedaySections: (input) => contract.getSomedaySections(input),
    dataSettings: () => contract.getDataSettings(),
    dataBackup: () => contract.getDataBackup(),
    dataCsvExport: () => contract.getDataBackup('csv'),
    dataTaskNotesExport: () => contract.getDataBackup('tasknotes'),
    // Settings › Sync's view (native-host-contract-settings-sync.ts) for the form's typed URL and token.
    syncSettings: (input) => contract.getSyncSettings(input),
    // Mind Sweep and a saved search's screen.
    mindSweep: (input) => contract.getMindSweep(input),
    savedSearch: (input) => contract.getSavedSearchView(input),
    // A link, text share or assistant note (native-host-contract-entry-points.ts), and the capture popup's Import .txt.
    entryPoint: (input) => logEntryPoint(input, isNotificationTap(input) ? notificationEntry(input) : contract.resolveNativeEntryPoint(input)),
    captureImport: (input) => contract.planQuickCaptureImport(input),
    // The capture screen an entry opens (native-host-contract-capture-modal.ts): its open, its edits and its Cancel write nothing.
    captureModalOpen: (input) => contract.openCaptureModal(input),
    captureModalView: (input) => contract.getCaptureModalView(input),
    captureModalEdit: (input) => contract.editCaptureModal(input),
    captureModalDiscard: (input) => contract.discardCaptureModal(input),
    // Settings › AI's view for this visit and its close, and the editor's AI parts (native-host-contract-ai.ts): none writes.
    aiSettings: () => contract.getAISettings(),
    aiSettingsClose: () => contract.closeAISettings(),
    taskEditorAI: (input) => contract.getTaskEditorAI(input),
    // The editor's and the project screen's attachment rows, the link sheet's line check, and a task download's answer applied
    // to the editor's draft list.
    attachmentList: (input) => contract.getAttachmentList(input),
    attachmentLinkCheck: (input) => contract.getAttachmentLinkCheck(input),
    attachmentUpdate: (input) => {
        const applied = contract.applyAttachmentUpdate(input);
        return applied.ok ? { ok: true, value: { attachments: applied.value } } : applied;
    },
    // Project details (ProjectDetails.kt): the values its panel and pickers show (a project's options; none writes), and core's
    // blocks for the notes as typed.
    projectStatusOptions: (input) => contract.getProjectStatusOptions(input),
    projectFlowOptions: (input) => contract.getProjectFlowOptions(input),
    projectNotesOptions: (input) => contract.getProjectNotesEditOptions(input),
    projectAreaOptions: (input) => contract.getProjectAreaOptions(input),
    projectTagsOptions: (input) => contract.getProjectTagsEditOptions(input),
    projectDateOptions: (input) => contract.getProjectDateOptions(input),
    projectSectionOrderOptions: (input) => contract.getProjectSectionOrderOptions(input),
    projectNotesPreview: (input) => contract.getProjectNotesPreview(input),
};
/**
 * The attachments' long calls (native-host-contract-attachments.ts): Download and Open wait on the network (a synced file's bytes),
 * so CoreHost.attachmentRequest waits for them without holding the engine; the draft settlement after Save or Discard deletes only
 * the editor's own copies. None is a store command a journal replays: a project download writes its availability fields, as React
 * Native's does, identity-guarded and run again by the next Download or sync.
 */
const draftOnly = (input: never, command: () => Promise<Reply>): Promise<Reply> => ((input as { owner?: { kind?: unknown } } | null)?.owner?.kind === 'task'
    ? command()
    : Promise.resolve({ ok: false, error: { code: 'INVALID_INPUT', message: 'Only a task draft attachment command runs here' } }));
const ATTACHMENT_REQUESTS: Record<string, (input: never) => Promise<Reply>> = {
    // A task draft's Add file and Add photo, link Save and Remove: they answer the draft's next list and write nothing, so they are
    // never journaled (a replay would copy a file no draft owns). A project's go through MENU_COMMANDS, journaled.
    draftAddFile: (input) => draftOnly(input, () => contract.addAttachmentFile(input)),
    draftLinks: (input) => draftOnly(input, () => contract.submitAttachmentLinks(input)),
    draftRemove: (input) => draftOnly(input, () => contract.removeAttachment(input)),
    downloadAttachment: (input) => contract.downloadAttachment(input),
    openAttachment: (input) => contract.openAttachment(input),
    settleTaskDraftAttachments: (input) => contract.settleTaskDraftAttachments(input),
};
const LOCAL_ATTACHMENT_REQUESTS = new Set(['draftAddFile', 'draftRemove', 'openAttachment', 'settleTaskDraftAttachments']);
/**
 * The AI's requests (native-host-contract-ai.ts): each waits on the provider (up to RN's 5 min request timeout), so
 * CoreHost.aiRequest waits for it without holding the engine. None writes: an answer is a dialog whose buttons apply through the
 * screen's own edits and commands. The operation's signal goes down to the provider call: MindwtrHost.abort stops it.
 */
const AI_REQUESTS: Record<string, (input: never, signal: AbortSignal) => Promise<Reply>> = {
    loadAIModels: (input, signal) => contract.loadAIModels(input, { signal }),
    requestTaskEditorCopilot: (input, signal) => contract.requestTaskEditorCopilot(input, { signal }),
    requestAICopilot: (input, signal) => contract.requestAICopilot(input, { signal }),
    requestTaskEditorClarify: (input, signal) => contract.requestTaskEditorClarify(input, { signal }),
    requestTaskEditorBreakdown: (input, signal) => contract.requestTaskEditorBreakdown(input, { signal }),
    requestInboxClarify: (input, signal) => contract.requestInboxClarify(input, { signal }),
    requestWeeklyReviewAnalysis: (_input, signal) => contract.requestWeeklyReviewAnalysis({ signal }),
};
/** The Menu tab's commands, by their diagnostic operation: each passes Kotlin's input (its request or capture UUID included) unchanged. */
const MENU_COMMANDS: Record<MenuCommand, (input: never) => Reply | Promise<Reply>> = {
    activateProject: (input) => contract.activateProject(input),
    somedayMove: (input) => contract.moveSomedayTasksToSection(input),
    somedayUndo: (input) => contract.undoSomedaySectionMove(input),
    somedayTask: (input) => contract.addSomedaySectionTask(input),
    somedaySection: (input) => contract.createSomedaySection(input),
    taskListSort: (input) => contract.setTaskListSort(input),
    archiveAction: (input) => contract.runArchiveAction(input),
    contextsAction: (input) => contract.runContextsAction(input),
    trashAction: (input) => contract.runTrashAction(input),
    reviewAction: (input) => contract.runReviewAction(input),
    // The Weekly Review's project Add task: runReviewAction too, logged apart because its request is kept on disk.
    reviewTask: (input) => contract.runReviewAction(input),
    // The Calendar's and the Board's actions; a create (a composer save, a Duplicate) is logged apart because its request is kept on disk.
    calendarAction: (input) => contract.runCalendarAction(input),
    calendarCreate: (input) => contract.runCalendarAction(input),
    boardAction: (input) => contract.runBoardAction(input),
    boardCreate: (input) => contract.runBoardAction(input),
    // A list's bulk bar (its delete's Undo too), and Focus's View options grouping, saved filters and Today's Focus order.
    bulkAction: (input) => contract.runBulkAction(input),
    focusGroup: (input) => contract.setFocusGroupBy(input),
    focusSave: (input) => contract.saveFocusFilter(input),
    focusCriterion: (input) => contract.removeFocusFilterCriterion(input),
    focusDelete: (input) => contract.deleteFocusFilter(input),
    focusReorder: (input) => contract.reorderFocus(input),
    // Bulk organize's new project or area, Mind Sweep's Add, and a saved search's Delete.
    bulkCreate: (input) => contract.createBulkOrganizeDestination(input),
    mindSweepAdd: (input) => contract.addMindSweepItem(input),
    savedSearchDelete: (input) => contract.deleteSavedSearch(input),
    // Settings: General's and GTD's controls, Manage's editor Save and Delete, and Manage's Someday section rename, reorder and delete.
    generalSetting: (input) => contract.setGeneralSetting(input),
    gtdSetting: (input) => contract.setGtdSetting(input),
    manageEditor: (input) => contract.saveManageEditor(input),
    manageDelete: (input) => contract.deleteManageItem(input),
    somedayRename: (input) => contract.renameSomedaySection(input),
    somedayReorder: (input) => contract.reorderSomedaySections(input),
    somedayDelete: (input) => contract.deleteSomedaySection(input),
    // Settings › Data's Debug logging switch.
    dataSetting: (input) => contract.setDataSetting(input),
    // Settings › Sync: a sync option (journaled), and the screen's commands (never journaled: CoreHost.syncCommand).
    syncPreference: (input) => contract.setSyncPreference(input),
    openSyncSettings: () => contract.openSyncSettings(),
    closeSyncSettings: () => contract.closeSyncSettings(),
    selectSyncBackend: (input) => contract.selectSyncBackend(input),
    saveSyncBackend: (input) => contract.saveSyncBackend(input),
    syncNow: (input) => contract.syncNow(input),
    testSyncConnection: (input) => contract.testSyncConnection(input),
    pickSyncFolder: (input) => contract.pickSyncFolder(input),
    connectDropbox: (input) => contract.connectDropbox(input),
    disconnectDropbox: (input) => contract.disconnectDropbox(input),
    runSyncEncryptionAction: (input) => contract.runSyncEncryptionAction(input),
    // Settings › AI: a control's change (journaled, target-state), the screen's open (journaled), a key and a base URL (never journaled).
    setAISetting: (input) => contract.setAISetting(input),
    openAISettings: (input) => contract.openAISettings(input),
    setAIKey: (input) => contract.setAIKey(input),
    setAIEndpoint: (input) => contract.setAIEndpoint(input),
    // Attachments (native-host-contract-attachments.ts): Add file and Add photo, the link sheet's Save, and Remove. A project's
    // are written at once through receipts; a task's answer the editor's next draft list and write nothing.
    attachmentAddFile: (input) => contract.addAttachmentFile(input),
    attachmentLinks: (input) => contract.submitAttachmentLinks(input),
    attachmentRemove: (input) => contract.removeAttachment(input),
    // Project details (ProjectDetails.kt): the user's edit, journaled ahead of its send; core reads, prepares and commits it.
    projectEdit: (input) => contract.runProjectEdit(input),
};

let bootAdapter: ValidatedSqliteAdapter | null = null;
/** A current, settled Settings-only read for device-key reconciliation; null never authorizes a mirror. */
const savedSettingsIfSettled = async (settingsReference: unknown): Promise<Record<string, unknown> | null> => {
    const before = getPersistenceStatus();
    if (!bootAdapter || before.failed || before.queued || before.inFlight || before.immediate || before.retrying) return null;
    const row = await sqlite.get<{ data: string }>('SELECT data FROM settings WHERE id = 1');
    let saved: unknown = {};
    if (row) {
        try { saved = JSON.parse(row.data); }
        catch { throw new Error('Invalid settings load'); }
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid settings load');
    const after = getPersistenceStatus();
    return useTaskStore.getState().settings === settingsReference && after.generation === before.generation
        && !after.failed && !after.queued && !after.inFlight && !after.immediate && !after.retrying
        ? saved as Record<string, unknown> : null;
};
const activateAndVerify = async (adapter: ValidatedSqliteAdapter, recoveryLoad = false) => {
    traceStep('js:activate');
    unwrap(await contract.activate(recoveryLoad ? { writeSafetyReady: true, recoveryLoad: true } : { writeSafetyReady: true }));
    traceStep('js:flushPendingSave');
    await flushPendingSave();
    traceStep('js:verifyActivation');
    const loaded = useTaskStore.getState();
    await adapter.verifyActivation({
        tasks: loaded._allTasks, projects: loaded._allProjects, sections: loaded._allSections, areas: loaded._allAreas, people: loaded._allPeople,
    });
    traceStep('js:inboxWindow');
    const inbox = unwrap(contract.getInboxWindow({ offset: 0, limit: 50 }));
    traceStep('');
    return inbox;
};
const boot = (legacyState: string, legacyBackup: string, recoveryLoad = false, journaled = false): string => submit(async () => {
    // A host that journals every write replays it after process death, so each write must carry its replay tokens.
    setNativeReplayTokens(journaled ? 'required' : 'optional');
    const adapter = new ValidatedSqliteAdapter(sqlite, { rejectConcurrentWrites: true });
    // Schema setup may write only after the native host's validated checkpoint.
    setStorageAdapter(adapter);
    // Before the journal's replay (Kotlin, after boot): a landed request answers from its receipt. A host without
    // a journal keeps its receipts in memory, as before.
    traceStep('js:receipts');
    if (journaled) await loadNativeRequestReceipts(sqlite);
    else await loadNativeRequestReceipts(sqlite, { durableCommands: ['appLock', 'taskCompletion', 'taskCompletionUndo', 'archivedTaskRestore', 'archivedTasksRestore', 'doneTasksMove', 'doneTasksAddTag', 'doneTasksRemoveTag', 'archivedTasksDelete', 'archivedTasksDeleteUndo', 'doneTasksDelete', 'doneTasksDeleteUndo', 'referenceTasksDelete', 'referenceTasksDeleteUndo', 'referenceTasksMove', 'referenceTasksAddTag', 'referenceTasksRemoveTag', 'preparedProjectLifecycle', 'preparedTaskDelete', 'preparedProjectDelete', 'preparedTaskDeleteUndo', 'doneTaskStatus', 'referenceTaskNext', 'referenceTaskStatus', 'referenceTaskCompletion', 'referenceTaskCompletionUndo', 'referenceTaskBackdate', 'referenceTaskDestination', 'referenceProjectNextAction', 'doneTaskCompletedAt', 'archiveTaskCompletedAt', 'data', 'backupDocument'] });
    // The legacy import plans from a validated full read. Any other boot needs only the schema here: the activation's own read
    // is validated before anything saves.
    traceStep('js:schema');
    if (legacyState) await adapter.getData(); else await adapter.ensureSchema();
    traceStep('');
    if (legacyState) await importLegacyJson(adapter, JSON.parse(legacyState) as LegacyState, legacyBackup);
    const result = await activateAndVerify(adapter, recoveryLoad);
    bootAdapter = adapter;
    return result;
});

// Reference and Done use the RN list's single tag-input and count policy.
const taskListBulkTagInput = (tag: string, changedCount: number): string => submit(async () => {
    requireSaved();
    if (typeof tag !== 'string' || tag.length > 2_000 || !Number.isInteger(changedCount) || changedCount < 0 || changedCount > 10_000) {
        throw new Error('INVALID_INPUT: List tag input must be bounded text and a count from 0 to 10000');
    }
    const t = (key: string): string => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key;
    return { canSave: canSaveTaskListTag(tag), notice: changedCount === 0 ? null
        : { title: t('common.done'), message: formatListItemCount(changedCount, 'task', t) } };
});

// New work uses contract readiness; recovery uses the validated boot adapter so an
// acknowledged save whose reload failed can still prove/reload its durable receipt.
const backupAdapter = (newWork = false) => {
    if (!bootAdapter || isSandboxMode() || isWorkspaceTransitionActive()) {
        throw new Error('NOT_READY: Backup requires validated storage in a stable personal workspace');
    }
    if (newWork) { requireSaved(); unwrap(contract.getDataSettings()); }
    return bootAdapter;
};
const backupJson = (json: string): unknown => {
    try { return JSON.parse(json) as unknown; }
    catch { throw new Error('INVALID_INPUT: Invalid backup document input'); }
};
const backupTranslate = (key: string, values?: Record<string, number | string>): string => {
    const template = unwrap(contract.getStrings({ keys: [key] })).strings[key];
    if (typeof template !== 'string') throw new Error('INVALID_INPUT: Backup translation is unavailable');
    return values ? formatI18nTemplate(template, values) : template;
};

// Only the native owner supplies these frozen checkpoints and preparations,
// after reading its private evidence. They never enter the raw attachment API.
const attachmentDraftJson = (json: string): unknown => {
    try {
        if (typeof json === 'string' && json.length <= 8 * 1024 * 1024
            && new TextEncoder().encode(json).byteLength <= 8 * 1024 * 1024) return JSON.parse(json);
    } catch { /* A parser excerpt could expose draft content or a picked path. */ }
    throw new Error('INVALID_INPUT');
};
const attachmentCleanupJson = (json: string, maxBytes: number): unknown => {
    try {
        if (typeof json === 'string' && json.length <= maxBytes
            && new TextEncoder().encode(json).byteLength <= maxBytes) return JSON.parse(json);
    } catch { /* Never expose raw durable rows or parser excerpts. */ }
    throw new Error('INVALID_INPUT');
};
const attachmentDiscardInvalid = (): Error => new Error('INVALID_INPUT: Invalid attachment Discard handoff');
const attachmentDiscardNotReady = (): Error => new Error('NOT_READY: Attachment Discard requires settled native storage');
const attachmentDiscardInput = (json: string, availability: boolean): { requestId: string; targetURI: string } => {
    try {
        if (typeof json !== 'string' || json.length > 64 * 1024
            || new TextEncoder().encode(json).byteLength > 64 * 1024) throw attachmentDiscardInvalid();
        const value = JSON.parse(json) as Record<string, unknown> | null;
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
            || value.version !== (availability ? 2 : 1) || typeof value.requestId !== 'string'
            || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.requestId)
            || typeof value.targetURI !== 'string' || !value.targetURI
            || value.targetURI.length > 16 * 1024 || new TextEncoder().encode(value.targetURI).byteLength > 16 * 1024) {
            throw attachmentDiscardInvalid();
        }
        return { requestId: value.requestId, targetURI: value.targetURI };
    } catch { throw attachmentDiscardInvalid(); }
};
const settledAttachmentDiscardState = () => {
    try {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments || nativeSync !== null
            || isSandboxMode() || isWorkspaceTransitionActive() || !bootAdapter || getStorageAdapter() !== bootAdapter
            || [...pending.values()].some((slot) => !slot.done) || !contract.getDataSettings().ok) {
            throw attachmentDiscardNotReady();
        }
        const status = getPersistenceStatus(), state = useTaskStore.getState();
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments || nativeSync !== null
            || isSandboxMode() || isWorkspaceTransitionActive() || !bootAdapter || getStorageAdapter() !== bootAdapter
            || [...pending.values()].some((slot) => !slot.done) || state.persistenceFailure || state.isLoading || state.editLockCount !== 0
            || status.queued || status.inFlight || status.immediate || status.retrying || status.failed) throw attachmentDiscardNotReady();
        return { state, status };
    } catch { throw attachmentDiscardNotReady(); }
};
// Reference-only: the fixed iOS spellings can keep bytes, never grant file IO.
const nativeAttachmentFileInUse = (uri: string, owners: readonly (Task | Project)[]): boolean => {
    if (isAttachmentFileInUse(uri, owners)) return true;
    const counterpart = uri.startsWith('file:///private/var/') ? 'file:///var/' + uri.slice('file:///private/var/'.length)
        : uri.startsWith('file:///var/') ? 'file:///private/var/' + uri.slice('file:///var/'.length) : null;
    return counterpart !== null && isAttachmentFileInUse(counterpart, owners);
};
/** Native-held callbacks complete their action before JSC's return-time microtask drain. */
const retireAttachmentDiscard = (json: string, keepCallback: () => string, retireCallback: () => string, availability = false): string => {
    if (typeof keepCallback !== 'function' || typeof retireCallback !== 'function') throw attachmentDiscardInvalid();
    const input = attachmentDiscardInput(json, availability), before = settledAttachmentDiscardState();
    const tasks = before.state._allTasks, projects = before.state._allProjects, generation = before.status.generation;
    let inUse: boolean;
    try { inUse = nativeAttachmentFileInUse(input.targetURI, [...tasks, ...projects]); }
    catch { throw attachmentDiscardNotReady(); }
    const after = settledAttachmentDiscardState();
    if (after.state._allTasks !== tasks || after.state._allProjects !== projects
        || after.status.generation !== generation) throw attachmentDiscardNotReady();
    let result: unknown;
    try { result = inUse ? keepCallback() : retireCallback(); }
    catch { throw attachmentDiscardNotReady(); }
    // Never retry/fall back to the other callback after a refused/failed branch.
    try {
        if (typeof result !== 'string' || result.length > 1024 || new TextEncoder().encode(result).byteLength > 1024) {
            throw attachmentDiscardInvalid();
        }
        const value = JSON.parse(result) as Record<string, unknown> | null;
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
            || !(inUse ? value.outcome === 'referenced' : value.outcome === 'removed' || value.outcome === 'absent'
                || availability && (value.outcome === 'notOwned' || value.outcome === 'referenced'))) {
            throw attachmentDiscardInvalid();
        }
        return result;
    } catch { throw attachmentDiscardInvalid(); }
};
const attachmentSaveInvalid = (): Error => new Error('INVALID_INPUT: Invalid attachment Save handoff');
const attachmentSaveNotReady = (): Error => new Error('NOT_READY: Attachment Save requires settled native storage');
const settledAttachmentSaveState = () => {
    try { return settledAttachmentDiscardState(); }
    catch { throw attachmentSaveNotReady(); }
};
type AttachmentFileEditSaveEnvelope = Parameters<typeof contract.validatePreparedOwnedEditorFileEditTaskDraftSave>[0]
    | Parameters<typeof contract.validatePreparedOwnedEditorCompleteTaskDraftSave>[0];
const validateAttachmentFileEditSave = (input: AttachmentFileEditSaveEnvelope) => {
    if ((input?.request?.version === 2 || input?.request?.version === 3 || input?.request?.version === 4) && input.prepared?.version === input.request.version) {
        return contract.validatePreparedOwnedEditorCompleteTaskDraftSave(input as Parameters<typeof contract.validatePreparedOwnedEditorCompleteTaskDraftSave>[0]);
    }
    if (input?.request?.version === 1 && input.prepared?.version === 1) {
        return contract.validatePreparedOwnedEditorFileEditTaskDraftSave(input as Parameters<typeof contract.validatePreparedOwnedEditorFileEditTaskDraftSave>[0]);
    }
    throw new Error('INVALID_INPUT');
};
type AttachmentSavePlan = Readonly<{
    envelopeJSON: string;
    taskID: string;
    afterRevision: ReturnType<typeof taskRevisionOf>;
    completeRemoveOnly: boolean;
    availability: boolean;
    settlementPlan: ReadonlyArray<Readonly<(ReturnType<typeof contract.validatePreparedOwnedEditorFileEditTaskDraftSave>
        & { ok: true })['value']['settlementPlan'][number]>>;
}>;
// One detached historical plan only; current storage and references are never retained.
let attachmentSavePlan: AttachmentSavePlan | null = null;
/** Private same-turn Save settlement fence; callbacks carry native-held proofs. */
const retireAttachmentFileEditSave = (json: string, referencedCallback: () => string,
    taskChangedCallback: () => string, retireCallback: () => string): string => {
    if ([referencedCallback, taskChangedCallback, retireCallback].some((callback) => typeof callback !== 'function')) {
        throw attachmentSaveInvalid();
    }
    let plan: AttachmentSavePlan;
    let index: number;
    let currentURI: string | null = null;
    try {
        const input = attachmentDraftJson(json) as Record<string, unknown> | null;
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || (input.version !== 1 && input.version !== 2)
            || Object.keys(input).length !== (input.version === 2 ? 4 : 3)
            || typeof input.envelopeJSON !== 'string' || input.envelopeJSON.length > 8 * 1024 * 1024
            || new TextEncoder().encode(input.envelopeJSON).byteLength > 8 * 1024 * 1024
            || !Number.isSafeInteger(input.candidateIndex) || (input.candidateIndex as number) < 0) throw attachmentSaveInvalid();
        if (input.version === 2) {
            if (typeof input.currentURI !== 'string' || !input.currentURI.startsWith('file:///')
                || input.currentURI.length > 16 * 1024 || new TextEncoder().encode(input.currentURI).byteLength > 16 * 1024
                || /[?#\\\u0000-\u0020]/.test(input.currentURI) || /%(?:2f|5c)/i.test(input.currentURI)) throw attachmentSaveInvalid();
            const path = decodeURIComponent(input.currentURI.slice('file:///'.length));
            if (/[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) throw attachmentSaveInvalid();
            currentURI = input.currentURI;
        }
        index = input.candidateIndex as number;
        if (attachmentSavePlan?.envelopeJSON === input.envelopeJSON) plan = attachmentSavePlan;
        else {
            const envelope = attachmentDraftJson(input.envelopeJSON) as AttachmentFileEditSaveEnvelope;
            const checked = validateAttachmentFileEditSave(envelope);
            if (!checked.ok || index >= checked.value.settlementPlan.length) throw attachmentSaveInvalid();
            const complete = (envelope.request.version === 2 || envelope.request.version === 3 || envelope.request.version === 4)
                ? envelope as Parameters<typeof contract.validatePreparedOwnedEditorCompleteTaskDraftSave>[0] : null;
            const legacy = envelope as Parameters<typeof contract.validatePreparedOwnedEditorFileEditTaskDraftSave>[0];
            const afterTask = complete ? complete.prepared.decision.kind === 'changed'
                ? complete.prepared.decision.prepared.effect.tasks.find((row) => row.after.id === complete.request.saveRequest.id)?.after
                : complete.prepared.decision.prepared.witness.source
                : legacy.prepared.decision.kind === 'changed' ? legacy.prepared.decision.prepared.effect.task.after : legacy.prepared.decision.effect.task.after;
            if (!afterTask) throw attachmentSaveInvalid();
            plan = Object.freeze({ envelopeJSON: input.envelopeJSON, taskID: envelope.request.saveRequest.id,
                afterRevision: taskRevisionOf(afterTask), availability: complete?.request.version === 4,
                completeRemoveOnly: complete !== null && complete.request.ownedDraft.priorOperations.length > 0
                    && complete.request.ownedDraft.priorOperations.every((entry) => entry.kind === 'remove'),
                settlementPlan: Object.freeze(checked.value.settlementPlan.map((value) => Object.freeze({ ...value,
                    attachment: Object.freeze({ ...value.attachment }) }))) });
            attachmentSavePlan = plan;
        }
        if (index >= plan.settlementPlan.length || currentURI !== null && (!plan.completeRemoveOnly
            || plan.settlementPlan[index].reason === 'uncommitted-draft')) throw attachmentSaveInvalid();
    } catch { throw attachmentSaveInvalid(); }
    const selected = plan.settlementPlan[index];
    // Out-of-order and failed last calls safely revalidate on a later retry.
    if (index === plan.settlementPlan.length - 1) attachmentSavePlan = null;
    const before = settledAttachmentSaveState();
    const tasks = before.state._allTasks, projects = before.state._allProjects, taskMap = before.state._tasksById;
    const generation = before.status.generation;
    let referenced: boolean, moved: boolean;
    try {
        const owners = [...tasks, ...projects];
        referenced = nativeAttachmentFileInUse(selected.attachment.uri, owners)
            || currentURI !== null && nativeAttachmentFileInUse(currentURI, owners);
        const currentTask = taskMap.get(plan.taskID);
        moved = selected.reason !== 'uncommitted-draft'
            && (!currentTask || taskRevisionOf(currentTask) !== plan.afterRevision);
    } catch { throw attachmentSaveNotReady(); }
    const after = settledAttachmentSaveState();
    if (after.state._allTasks !== tasks || after.state._allProjects !== projects || after.state._tasksById !== taskMap
        || after.status.generation !== generation) throw attachmentSaveNotReady();
    let result: unknown;
    try { result = referenced ? referencedCallback() : moved ? taskChangedCallback() : retireCallback(); }
    catch { throw attachmentSaveNotReady(); }
    // No fallback or second callback, including malformed/failed acknowledgment.
    try {
        if (typeof result !== 'string' || result.length > 1024 || new TextEncoder().encode(result).byteLength > 1024) throw attachmentSaveInvalid();
        const value = JSON.parse(result) as Record<string, unknown> | null;
        const outcomes = referenced ? ['referenced'] : moved ? ['taskChanged']
            : selected.reason === 'uncommitted-draft' ? ['removed', 'absent']
                : ['removed', 'absent', 'generationChanged', 'unsafeEntry', 'noOwnedGeneration', 'unmanaged'];
        if (plan.availability && !referenced && !moved) outcomes.push('notOwned', 'referenced');
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
            || typeof value.outcome !== 'string' || !outcomes.includes(value.outcome)) throw attachmentSaveInvalid();
        return result;
    } catch { throw attachmentSaveInvalid(); }
};
// Pure validation remains available before boot; applying an owned Save also
// requires the current iOS file capability and stable personal workspace.
const requireOwnedAttachmentSave = (): void => {
    if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments
        || isSandboxMode() || isWorkspaceTransitionActive()) {
        throw new Error('NOT_READY: Attachment draft capability is unavailable');
    }
};
const attachmentDraftDependencies = {
    assertEditable(taskID: string): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments
            || isSandboxMode() || isWorkspaceTransitionActive()) {
            throw new Error('NOT_READY: Attachment draft capability is unavailable');
        }
        requireSaved();
        const result = contract.getTaskView({ id: taskID });
        if (!result.ok || result.value.readOnly) throw new Error('INVALID_INPUT: Task draft attachments cannot be edited');
    },
    t(key: string): string { return unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key; },
};

globalThis.MindwtrHost = {
    /** Private fixed canonical plaintext retirement receipt; no secret inputs. */
    nativeLegacySecretRetirementDelivered(): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            logInfo('Native iOS legacy secret retirement delivered', {
                scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-legacy-secret-retirement', operation: 'legacy-secret-retirement', outcome: 'delivered' },
            });
        } catch { /* A fixed diagnostic never changes the storage result. */ }
    },
    /** Private fixed storage receipt; never carries a setting name or value. */
    nativeDeviceStorageDelivered(): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            logInfo('Native iOS device storage result delivered', {
                scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-device-storage', operation: 'device-storage', outcome: 'delivered' },
            });
        } catch { /* A fixed diagnostic never changes the storage result. */ }
    },
    /** Private fixed primitive receipt; never carries input or derived bytes. */
    nativeCryptoDelivered(): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            logInfo('Native iOS crypto result delivered', {
                scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-sync-crypto', operation: 'sync-crypto', outcome: 'delivered' },
            });
        } catch { /* A fixed diagnostic never changes the primitive result. */ }
    },
    /** Private fixed receipt; never carries a credential or account. */
    nativeSecretDelivered(): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            logInfo('Native iOS secure storage operation delivered', {
                scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-secure-storage', operation: 'secure-storage', outcome: 'delivered' },
            });
        } catch { /* A fixed diagnostic never changes the transport result. */ }
    },
    /** Private fixed transport receipt; no request data or domain authority. */
    nativeHTTPDelivered(): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            logInfo('Native iOS HTTP response delivered', {
                scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-http-transport', operation: 'http-transport', outcome: 'delivered' },
            });
        } catch { /* A fixed diagnostic never changes the transport result. */ }
    },
    /** Read-only upgrade preflight, before the native host opens SQLite. */
    legacyCheck(legacyState: string, legacyBackup: string): string {
        return submit(async () => {
            const state = JSON.parse(legacyState) as LegacyState;
            assertNativeLegacyBackupSafe({ jsonAhead: state.jsonAhead, backupJson: state.backupPresent ? legacyBackup : null });
            return null;
        });
    },
    poll(idText: string): string | null {
        const id = Number(idText);
        const slot = pending.get(id);
        if (!slot?.done) return null;
        pending.delete(id);
        return JSON.stringify(slot.error === undefined
            ? { ok: true, value: slot.value }
            : { ok: false, error: slot.error });
    },
    /**
     * `legacyState` is "" for the dev database; else LegacyRnStoreGuard's reading of RN's AsyncStorage.
     * `writeJournal` is "journaled" from a host that journals every write (Kotlin's WriteJournal); iOS sends nothing.
     */
    boot(legacyState: string, legacyBackup: string, writeJournal = ''): string {
        return boot(legacyState, legacyBackup, false, writeJournal === 'journaled');
    },
    /** Private iOS journal recovery: no dynamic load maintenance before exact replay. */
    bootRecovery(legacyState: string, legacyBackup: string): string {
        return boot(legacyState, legacyBackup, true);
    },
    /** The native host calls this after durable journal cleanup, before exposing the UI. */
    resumeActivation(): string {
        return submit(async () => {
            if (!bootAdapter) throw new Error('Native recovery adapter unavailable');
            return activateAndVerify(bootAdapter);
        });
    },
    window(offset: number, limit: number, revision: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getInboxWindow({ offset, limit, revision: revision || undefined }));
        });
    },
    /** The RN Inbox screen model: core owns the toolbar, scope, empty state and rows. */
    inboxView(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getInboxView(JSON.parse(json)));
        });
    },
    /**
     * `controls` is the control state Kotlin keeps and `controlEdit` a control's edit, as JSON; "" leaves either out, so a read
     * that sends neither keeps the flat Focus it always had.
     */
    focus(limit: number, controls = '', controlEdit = ''): string {
        return submit(async () => {
            requireSaved();
            const focus = unwrap(contract.getFocus({ limit, ...(controls ? { controls: JSON.parse(controls) } : {}), ...(controlEdit ? { controlEdit: JSON.parse(controlEdit) } : {}) }));
            // The Focus screen's filter and sort, handed to the widget's Focus list as RN's Focus screen hands it (setFocusWidgetFilter).
            widgets?.focusFilter(focus.controls?.widgetFilter);
            return focus;
        });
    },
    /** Core checks `key` and refuses a stale `revision`; Kotlin then reads Focus again from offset 0. `controls` as for focus. */
    focusWindow(key: string, offset: number, limit: number, revision: string, controls = ''): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getFocusSectionWindow({ key: key as FocusTaskSectionKey, offset, limit, revision, ...(controls ? { controls: JSON.parse(controls) } : {}) }));
        });
    },
    /** The task's View tab; core formats its fields, Markdown and checklist windows. */
    taskView(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskView(editorJson(json) as Parameters<typeof contract.getTaskView>[0]));
        });
    },
    taskViewReferenceTarget(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskViewReferenceTarget(editorJson(json) as Parameters<typeof contract.getTaskViewReferenceTarget>[0]));
        });
    },
    taskAttachmentList(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getAttachmentList(taskAttachmentInput(json, ['owner']) as Parameters<typeof contract.getAttachmentList>[0]));
        });
    },
    taskAttachmentOpen(json: string): string {
        return submit(async () => {
            requireSaved();
            const input = taskAttachmentInput(json, ['owner', 'attachmentId']);
            return unwrap(await contract.openAttachment({
                ...input, urlOnly: true,
            } as Parameters<typeof contract.openAttachment>[0]));
        });
    },
    projectAttachmentList(json: string): string {
        return submit(async () => {
            requireSaved();
            const { projectId } = projectAttachmentInput(json);
            return unwrap(contract.getAttachmentList({ owner: { kind: 'project', projectId } }));
        });
    },
    projectAttachmentOpen(json: string): string {
        return submit(async () => {
            requireSaved();
            const { projectId, attachmentId } = projectAttachmentInput(json, true);
            return unwrap(await contract.openAttachment({ owner: { kind: 'project', projectId }, attachmentId: attachmentId!, urlOnly: true }));
        });
    },
    /** Pure classification of original settled metadata; Swift alone resolves and proves the current URI. */
    taskLocalFileOpenPlan(json: string, available: boolean): string {
        return submit(async () => {
            requireSaved();
            if (globalThis.__mindwtrHostPlatform !== 'ios' || typeof available !== 'boolean') throw new Error('INVALID_INPUT');
            const input = taskAttachmentInput(json, ['owner', 'attachmentId']);
            const owner = input.owner as { taskId: string; attachments: NonNullable<Task['attachments']> };
            if (!owner.taskId || owner.taskId.length > 500 || typeof input.attachmentId !== 'string'
                || !input.attachmentId || input.attachmentId.length > 500) throw new Error('INVALID_INPUT');
            const view = unwrap(contract.getTaskView({ id: owner.taskId }));
            const task = useTaskStore.getState()._tasksById.get(owner.taskId);
            const matches = owner.attachments.filter((item) => item?.id === input.attachmentId);
            const saved = (task?.attachments ?? []).filter((item) => item.id === input.attachmentId);
            const selected = matches[0], durable = saved[0];
            // SQLite hydration owns optional undefined fields which JSON omits.
            // Compare that wire shape; null, false and every defined value remain exact.
            const storedFields = durable ? Object.entries(durable).filter(([, value]) => value !== undefined) : [];
            if (view.id !== owner.taskId || !task || task.deletedAt || task.purgedAt
                || matches.length !== 1 || saved.length !== 1 || selected.kind !== 'file' || selected.deletedAt || !selected.uri
                || Object.keys(selected).length !== storedFields.length
                || storedFields.some(([field, value]) => !Object.prototype.hasOwnProperty.call(selected, field)
                    || (selected as unknown as Record<string, unknown>)[field] !== value)) throw new Error('INVALID_INPUT');
            const t = (key: string): string => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key;
            return available
                ? { status: 'available', message: null, update: null, open: planAttachmentOpen(selected, { audio: true, t }) }
                : { status: 'unavailable', message: getAttachmentResolutionMessage({ status: 'unavailable' }, t), update: null, open: null };
        });
    },
    /** Read-only classification after Swift observes the current managed file. */
    projectLocalFileOpenPlan(json: string, available: boolean): string {
        return submit(async () => {
            requireSaved();
            if (globalThis.__mindwtrHostPlatform !== 'ios' || typeof available !== 'boolean') throw new Error('INVALID_INPUT');
            const { projectId, attachmentId } = projectAttachmentInput(json, true);
            const { project } = unwrap(contract.getProjectAttachmentEditOptions({ projectId }));
            const matches = (project.attachments ?? []).filter((item) => item.id === attachmentId);
            const selected = matches[0];
            if (matches.length !== 1 || selected.kind !== 'file' || selected.deletedAt || !selected.uri) throw new Error('INVALID_INPUT');
            const t = (key: string): string => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key;
            return available
                ? { status: 'available', message: null, update: null, open: planAttachmentOpen(selected, { audio: false, t }) }
                : { status: 'unavailable', message: getAttachmentResolutionMessage({ status: 'unavailable' }, t), update: null, open: null };
        });
    },
    taskAttachmentLinks(json: string): string {
        return submit(async () => {
            requireSaved();
            const input = taskAttachmentInput(json, ['owner', 'requestId', 'text'], ['editing']);
            return unwrap(await contract.submitAttachmentLinks({
                ...input, urlOnly: true,
            } as Parameters<typeof contract.submitAttachmentLinks>[0]));
        });
    },
    taskAttachmentRemove(json: string): string {
        return submit(async () => {
            requireSaved();
            const input = taskAttachmentInput(json, ['owner', 'requestId', 'attachmentId']);
            return unwrap(await contract.removeAttachment({
                ...input, urlOnly: true,
            } as Parameters<typeof contract.removeAttachment>[0]));
        });
    },
    editorModel(id: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskEditorModel({ id }));
        });
    },
    taskShare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskShare(JSON.parse(json)));
        });
    },
    taskEditorDraftDirection(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskEditorDraftDirection(JSON.parse(json)));
        });
    },
    /** Strict read of an editor snapshot's touched opening bases, including unresolved raw-only inputs. */
    taskEditorResumeCheck(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(await contract.checkTaskEditorResume(editorJson(json) as Parameters<typeof contract.checkTaskEditorResume>[0]));
        });
    },
    destinationPicker(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskDraftDestinationPicker(JSON.parse(json)));
        });
    },
    /** The checklist and live attachment titles of core's getTask, which the editor shows read-only. */
    editorContent(id: string): string {
        return submit(async () => {
            requireSaved();
            const task = unwrap(contract.getTask({ id }));
            return {
                checklist: (task.checklist ?? []).map(({ title, isCompleted }) => ({ title, isCompleted: isCompleted === true })),
                attachments: (task.attachments ?? []).filter((attachment) => !attachment.deletedAt).map((attachment) => attachment.title),
            };
        });
    },
    /** `json` is `{ id, draft, checklist, edit? }`, passed to core's editTaskChecklist unchanged: one checklist edit on the draft. Nothing is written. */
    editChecklist(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.editTaskChecklist(JSON.parse(json)));
        });
    },
    /** `json` is `{ id, requestId }`: RN's Reset checklist, written at once. A repeat of the request after a failed save only finishes it. */
    resetChecklist(json: string): string {
        return submit(async () => taskResult('resetChecklist', await contract.resetTaskChecklist(JSON.parse(json))));
    },
    /** `json` is `{ id, draft, edit? }`, passed to core's editTaskDraft unchanged: the model for the edited draft. */
    editDraft(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.editTaskDraft(JSON.parse(json)));
        });
    },
    /** Core's suggestions for the whole text of a context, tag, or person input. */
    editorSuggestions(id: string, field: string, query: string, limit: number): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskEditorSuggestions({ id, field: field as 'contexts' | 'tags' | 'assignedTo', query, limit }));
        });
    },
    /** Core's setLanguage. "" is no stored language. Labels are not stored data, so no failed save blocks them. */
    language(stored: string, system: string): string {
        storedLanguage = stored || null;
        return submit(async () => unwrap(await contract.setLanguage({ storedLanguage: stored || null, systemLocale: system || null })));
    },
    /**
     * Publishes the home-screen widgets now when what they show changed: after a CoreWork job and when the app comes to the
     * front (host-widgets.ts). `{ published }`.
     */
    widgetsRefresh(): string {
        return submit(async () => ({ published: widgets?.publish() ?? false }));
    },
    /** Opt-in iOS read: a settled synced language wins; the legacy device-key route above is unchanged. */
    languageSaved(stored: string, system: string): string {
        return submit(async () => {
            if (!bootAdapter) throw new Error('Native storage has not been loaded and validated');
            if (typeof stored !== 'string' || stored.length > 500 || typeof system !== 'string' || system.length > 500)
                throw new Error('INVALID_INPUT: Language hints must be bounded strings');
            const state = useTaskStore.getState();
            const generation = getPersistenceStatus().generation;
            const saved = await savedSettingsIfSettled(state.settings);
            const raw = saved?.language;
            const synced = typeof raw === 'string' && isSupportedLanguage(raw) ? raw : null;
            const winner = synced ?? (stored || null);
            const resolved = unwrap(await contract.setLanguage({ storedLanguage: winner, systemLocale: system || null }));
            const after = getPersistenceStatus();
            const deviceWrites = synced !== null && synced === state.settings?.language
                && useTaskStore.getState().settings === state.settings && after.generation === generation
                && !after.failed && !after.queued && !after.inFlight && !after.immediate && !after.retrying
                ? getGeneralSettingsDeviceWrites({ type: 'language', value: synced }) : [];
            return { language: resolved.language, deviceWrites };
        });
    },
    /** `keysJson` is a JSON array of core i18n keys. */
    strings(keysJson: string): string {
        return submit(async () => unwrap(contract.getStrings({ keys: JSON.parse(keysJson) as string[] })));
    },
    /**
     * The React Native app's theme, resolved as its theme-context.tsx does: the synced
     * `settings.theme` wins, then RN's device-local `@mindwtr_theme` ([stored], "" for none),
     * then the system. Core classifies the mode and owns the status and priority hues;
     * Kotlin holds only the mobile palettes. Cosmetic, so no failed save blocks it.
     */
    theme(stored: string): string {
        return submit(async () => {
            const state = useTaskStore.getState();
            const synced = state.settings?.theme;
            const mode = typeof synced === 'string' && synced ? synced : (stored || 'system');
            const descriptor = themeDescriptor(mode);
            const preset = descriptor?.statusPreset ?? null;
            const lightPreset = resolveThemeStatusPreset(mode as AppTheme, 'light');
            const darkPreset = resolveThemeStatusPreset(mode as AppTheme, 'dark');
            // A failed or in-flight save can leave the store showing an optimistic theme.
            // Only the canonical saved Settings row may authorize local mirrors.
            let deviceWrites: ReturnType<typeof getGeneralSettingsDeviceWrites> = [];
            const generation = getPersistenceStatus().generation;
            const saved = await savedSettingsIfSettled(state.settings);
            const raw = saved?.theme;
            const after = getPersistenceStatus();
            if (raw === synced && typeof raw === 'string' && (raw === 'system' || themeDescriptor(raw))
                && useTaskStore.getState().settings === state.settings && after.generation === generation
                && !after.failed && !after.queued && !after.inFlight && !after.immediate && !after.retrying) {
                deviceWrites = getGeneralSettingsDeviceWrites({ type: 'theme', value: raw as AppTheme });
            }
            return {
                mode,
                deviceWrites,
                preset: preset ?? 'default',
                presets: {
                    light: lightPreset ?? 'default',
                    dark: darkPreset ?? 'default',
                },
                material: mode === 'material3-light' || mode === 'material3-dark',
                scheme: descriptor?.scheme === 'system' ? null : descriptor?.scheme ?? null,
                // Core's status palettes ({ bg, text, border } per status): RN's badges, glyphs, and Done swipe.
                status: {
                    light: STATUS_COLORS_BY_THEME[lightPreset ?? 'light'],
                    dark: STATUS_COLORS_BY_THEME[darkPreset ?? 'dark'],
                },
                priority: TASK_PRIORITY_COLORS,
            };
        });
    },
    /**
     * RN's app lock gate: core's General row for it, whose `value` is `settings.security.mobileAppLockEnabled` (per device).
     * The gate guards the screens and shows no stored data, so no failed save blocks it: a lock turned on whose save is owed
     * still locks.
     */
    appLock(): string {
        return submit(async () => unwrap(contract.getGeneralSettings({})).privacy.appLock);
    },
    projects(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjects());
        });
    },
    /** Native Projects quick-add choices, including the current Area filter default. */
    projectCreateOptions(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectCreateOptions());
        });
    },
    projectCreateRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.projectCreateRetryOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation; the host journals the exact envelope before commit. */
    projectCreatePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectCreate(JSON.parse(json)));
        });
    },
    /** Pure validation also runs during cold recovery before SQLite is opened. */
    projectCreateValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectCreate(JSON.parse(json))));
    },
    projectCreateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectCreate(JSON.parse(json))));
    },
    projectSectionOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectSectionOptions(JSON.parse(json)));
        });
    },
    projectSectionCreateRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectSectionCreateOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectSectionCreatePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectSectionCreate(JSON.parse(json)));
        });
    },
    projectSectionCreateValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectSectionCreate(JSON.parse(json))));
    },
    projectSectionCreateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectSectionCreate(JSON.parse(json))));
    },
    projectSectionRenameOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectSectionRenameOptions(JSON.parse(json)));
        });
    },
    projectSectionRenameRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectSectionRenameOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectSectionRenamePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectSectionRename(JSON.parse(json)));
        });
    },
    projectSectionRenameValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectSectionRename(JSON.parse(json))));
    },
    projectSectionRenameCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectSectionRename(JSON.parse(json))));
    },
    projectSectionDeleteOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectSectionDeleteOptions(JSON.parse(json)));
        });
    },
    projectSectionDeleteRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectSectionDeleteOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectSectionDeletePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectSectionDelete(JSON.parse(json)));
        });
    },
    projectSectionDeleteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectSectionDelete(JSON.parse(json))));
    },
    projectSectionDeleteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectSectionDelete(JSON.parse(json))));
    },
    projectSectionOrderOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectSectionOrderOptions(JSON.parse(json)));
        });
    },
    projectSectionOrderRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectSectionOrderOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectSectionOrderPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectSectionOrder(JSON.parse(json)));
        });
    },
    projectSectionOrderValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectSectionOrder(JSON.parse(json))));
    },
    projectSectionOrderCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectSectionOrder(JSON.parse(json))));
    },
    areaCreateOptions(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getAreaCreateOptions());
        });
    },
    areaCreateResolve(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.resolveAreaCreateName(JSON.parse(json)));
        });
    },
    areaCreateRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeAreaCreateOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    areaCreatePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(await contract.prepareAreaCreate(JSON.parse(json)));
        });
    },
    areaCreateValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedAreaCreate(JSON.parse(json))));
    },
    areaCreateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedAreaCreate(JSON.parse(json))));
    },
    /** Settings Manage uses the same prepared Area policy with its own journal method. */
    manageAreaCreateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedAreaCreate(JSON.parse(json))));
    },
    managePersonCreateResolve(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.resolvePersonCreateName(JSON.parse(json)));
        });
    },
    managePersonCreateRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probePersonCreateOutcome(JSON.parse(json)));
        });
    },
    /** Private prepared Person methods; Swift owns the durable journal. */
    managePersonCreatePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.preparePersonCreate(JSON.parse(json)));
        });
    },
    managePersonCreateValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedPersonCreate(JSON.parse(json))));
    },
    managePersonCreateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedPersonCreate(JSON.parse(json))));
    },
    managePersonEditOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getPersonEditOptions(JSON.parse(json))); });
    },
    managePersonEditRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probePersonEditOutcome(JSON.parse(json))); });
    },
    managePersonEditPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.preparePersonEdit(JSON.parse(json))); });
    },
    managePersonEditValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedPersonEdit(JSON.parse(json))));
    },
    managePersonEditCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedPersonEdit(JSON.parse(json))));
    },
    manageTaxonomyOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getTaxonomyOptions(JSON.parse(json))); });
    },
    manageTaxonomyRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeTaxonomyOutcome(JSON.parse(json))); });
    },
    manageTaxonomyPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareTaxonomy(JSON.parse(json))); });
    },
    manageTaxonomyValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaxonomy(JSON.parse(json))));
    },
    manageTaxonomyCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTaxonomy(JSON.parse(json))));
    },
    generalPreferenceOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGeneralPreferenceOptions(JSON.parse(json))); });
    },
    generalPreferenceRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeGeneralPreferenceOutcome(JSON.parse(json))); });
    },
    generalPreferencePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareGeneralPreference(JSON.parse(json))); });
    },
    generalPreferenceValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedGeneralPreference(JSON.parse(json))));
    },
    generalPreferenceCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedGeneralPreference(JSON.parse(json))));
    },
    gtdWorkflowOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdWorkflowOptions(JSON.parse(json))); });
    },
    gtdArchiveOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdArchiveOptions(JSON.parse(json))); });
    },
    gtdReviewOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdReviewOptions(JSON.parse(json))); });
    },
    gtdInboxOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdInboxOptions(JSON.parse(json))); });
    },
    gtdTaskEditorOpenOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdTaskEditorOpenOptions(JSON.parse(json))); });
    },
    gtdTaskEditorFieldOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdTaskEditorFieldOptions(JSON.parse(json))); });
    },
    gtdTaskEditorPresetOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdTaskEditorPresetOptions(JSON.parse(json))); });
    },
    taskOpenTab(json: string): string {
        return submit(async () => unwrap(contract.getTaskOpenTab(JSON.parse(json))));
    },
    gtdCaptureParseOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdCaptureParseOptions(JSON.parse(json))); });
    },
    gtdCaptureAreaOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdCaptureAreaOptions(JSON.parse(json))); });
    },
    gtdWorkflowDraft(json: string): string {
        return submit(async () => unwrap(contract.normalizeGtdWorkflowDraft(JSON.parse(json))));
    },
    gtdWorkflowRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeGtdWorkflowOutcome(JSON.parse(json))); });
    },
    gtdWorkflowPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareGtdWorkflow(JSON.parse(json))); });
    },
    gtdWorkflowValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedGtdWorkflow(JSON.parse(json))));
    },
    gtdWorkflowCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedGtdWorkflow(JSON.parse(json))));
    },
    appLockOptions(json: string): string {
        return submit(async () => unwrap(await contract.getAppLockOptions(JSON.parse(json))));
    },
    appLockRetryOutcome(json: string): string {
        return submit(async () => unwrap(contract.probeAppLockOutcome(JSON.parse(json))));
    },
    appLockPrepare(json: string): string {
        return submit(async () => unwrap(await contract.prepareAppLock(JSON.parse(json))));
    },
    appLockValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedAppLock(JSON.parse(json))));
    },
    appLockCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedAppLock(JSON.parse(json))));
    },
    managePersonDeleteOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getPersonDeleteOptions(JSON.parse(json)));
        });
    },
    managePersonDeleteRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probePersonDeleteOutcome(JSON.parse(json)));
        });
    },
    /** Private prepared Person deletion; Swift owns the durable journal. */
    managePersonDeletePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.preparePersonDelete(JSON.parse(json)));
        });
    },
    managePersonDeleteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedPersonDelete(JSON.parse(json))));
    },
    managePersonDeleteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedPersonDelete(JSON.parse(json))));
    },
    areaColorOptions(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getAreaColorOptions());
        });
    },
    areaColorRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeAreaColorOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    areaColorPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareAreaColor(JSON.parse(json)));
        });
    },
    areaColorValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedAreaColor(JSON.parse(json))));
    },
    areaColorCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedAreaColor(JSON.parse(json))));
    },
    areaRenameRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeAreaRenameOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    areaRenamePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(await contract.prepareAreaRename(JSON.parse(json)));
        });
    },
    areaRenameValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedAreaRename(JSON.parse(json))));
    },
    areaRenameCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedAreaRename(JSON.parse(json))));
    },
    manageAreaEditRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeAreaRenameOutcome(JSON.parse(json)));
        });
    },
    manageAreaEditCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedAreaRename(JSON.parse(json))));
    },
    areaOrderOptions(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getAreaOrderOptions());
        });
    },
    areaOrderRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeAreaOrderOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    areaOrderPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareAreaOrder(JSON.parse(json)));
        });
    },
    areaOrderValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedAreaOrder(JSON.parse(json))));
    },
    areaOrderCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedAreaOrder(JSON.parse(json))));
    },
    areaDeleteOptions(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getAreaDeleteOptions());
        });
    },
    areaDeleteRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeAreaDeleteOutcome(JSON.parse(json)));
        });
    },
    manageAreaDeleteRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeAreaDeleteOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    areaDeletePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(await contract.prepareAreaDelete(JSON.parse(json)));
        });
    },
    areaDeleteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedAreaDelete(JSON.parse(json))));
    },
    areaDeleteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedAreaDelete(JSON.parse(json))));
    },
    manageAreaDeleteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedAreaDelete(JSON.parse(json))));
    },
    taskListSortOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getTaskListSortOptions(JSON.parse(json))); });
    },
    taskListSortValidate(json: string): string {
        return submit(async () => unwrap(contract.validateTaskListSortWrite(JSON.parse(json))));
    },
    taskListSortWrite(json: string): string {
        return submit(async () => unwrap(await contract.setTaskListSortChecked(JSON.parse(json))));
    },
    taskListSortRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeTaskListSortOutcome(JSON.parse(json))); });
    },
    somedaySectionCreateOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getSomedaySectionCreateOptions(JSON.parse(json))); });
    },
    somedaySectionCreateValidate(json: string): string {
        return submit(async () => unwrap(contract.validateSomedaySectionCreateWrite(JSON.parse(json))));
    },
    somedaySectionCreateWrite(json: string): string {
        return submit(async () => unwrap(await contract.createSomedaySectionChecked(JSON.parse(json))));
    },
    somedaySectionCreateRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeSomedaySectionCreateOutcome(JSON.parse(json))); });
    },
    somedaySectionRenameOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getSomedaySectionRenameOptions(JSON.parse(json))); });
    },
    somedaySectionRenameValidate(json: string): string {
        return submit(async () => unwrap(contract.validateSomedaySectionRenameWrite(JSON.parse(json))));
    },
    somedaySectionRenameWrite(json: string): string {
        return submit(async () => unwrap(await contract.renameSomedaySectionChecked(JSON.parse(json))));
    },
    somedaySectionRenameRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeSomedaySectionRenameOutcome(JSON.parse(json))); });
    },
    unassignedAreaColorOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getUnassignedAreaColorOptions(JSON.parse(json))); });
    },
    unassignedAreaColorValidate(json: string): string {
        return submit(async () => unwrap(contract.validateUnassignedAreaColorWrite(JSON.parse(json))));
    },
    unassignedAreaColorWrite(json: string): string {
        return submit(async () => unwrap(await contract.setUnassignedAreaColorChecked(JSON.parse(json))));
    },
    unassignedAreaColorRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeUnassignedAreaColorOutcome(JSON.parse(json))); });
    },
    somedaySectionDeleteOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getSomedaySectionDeleteOptions(JSON.parse(json))); });
    },
    somedaySectionDeleteValidate(json: string): string {
        return submit(async () => unwrap(contract.validateSomedaySectionDeleteWrite(JSON.parse(json))));
    },
    somedaySectionDeleteWrite(json: string): string {
        return submit(async () => unwrap(await contract.deleteSomedaySectionChecked(JSON.parse(json))));
    },
    somedaySectionDeleteRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeSomedaySectionDeleteOutcome(JSON.parse(json))); });
    },
    somedaySectionOrderOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getSomedaySectionOrderOptions(JSON.parse(json))); });
    },
    somedaySectionOrderValidate(json: string): string {
        return submit(async () => unwrap(contract.validateSomedaySectionOrderWrite(JSON.parse(json))));
    },
    somedaySectionOrderWrite(json: string): string {
        return submit(async () => unwrap(await contract.orderSomedaySectionChecked(JSON.parse(json))));
    },
    somedaySectionOrderRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeSomedaySectionOrderOutcome(JSON.parse(json))); });
    },
    somedaySectionTaskOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getSomedaySectionTaskOptions(JSON.parse(json))); });
    },
    somedaySectionTaskPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareSomedaySectionTask(JSON.parse(json))); });
    },
    somedaySectionTaskValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedSomedaySectionTask(JSON.parse(json))));
    },
    somedaySectionTaskCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedSomedaySectionTask(JSON.parse(json))));
    },
    somedaySectionTaskRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeSomedaySectionTaskOutcome(JSON.parse(json))); });
    },
    somedaySectionMoveOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getSomedaySectionMoveOptions(JSON.parse(json))); });
    },
    somedaySectionMovePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareSomedaySectionMove(JSON.parse(json))); });
    },
    somedaySectionMoveValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedSomedaySectionMove(JSON.parse(json))));
    },
    somedaySectionMoveCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedSomedaySectionMove(JSON.parse(json))));
    },
    somedaySectionMoveRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeSomedaySectionMoveOutcome(JSON.parse(json))); });
    },
    somedaySectionMoveUndoPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareSomedaySectionMoveUndo(JSON.parse(json))); });
    },
    somedaySectionMoveUndoValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedSomedaySectionMoveUndo(JSON.parse(json))));
    },
    somedaySectionMoveUndoCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedSomedaySectionMoveUndo(JSON.parse(json))));
    },
    somedaySectionMoveUndoRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeSomedaySectionMoveUndoOutcome(JSON.parse(json))); });
    },
    focusGroupOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getFocusGroupOptions(JSON.parse(json))); });
    },
    focusGroupValidate(json: string): string {
        return submit(async () => unwrap(contract.validateFocusGroupWrite(JSON.parse(json))));
    },
    /** Exact scalar intent; the iOS host journals before dispatch. */
    focusGroupWrite(json: string): string {
        return submit(async () => unwrap(await contract.setFocusGroupChecked(JSON.parse(json))));
    },
    focusGroupRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeFocusGroupOutcome(JSON.parse(json))); });
    },
    projectFocusOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectFocusOptions(JSON.parse(json)));
        });
    },
    projectFocusRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectFocusOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectFocusPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectFocus(JSON.parse(json)));
        });
    },
    projectFocusValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectFocus(JSON.parse(json))));
    },
    projectFocusCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectFocus(JSON.parse(json))));
    },
    taskFocusOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskFocusOptions(JSON.parse(json)));
        });
    },
    taskFocusWrite(_json: string): string {
        return submit(async () => { throw new Error('INVALID_INPUT: Task Focus writes require a durable host journal'); });
    },
    taskFocusRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeTaskFocusOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    taskFocusPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareTaskFocus(JSON.parse(json)));
        });
    },
    taskFocusValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskFocus(JSON.parse(json))));
    },
    taskFocusCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTaskFocus(JSON.parse(json))));
    },
    projectRenameOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectRenameOptions(JSON.parse(json)));
        });
    },
    projectRenameRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectRenameOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectRenamePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectRename(JSON.parse(json)));
        });
    },
    projectRenameValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectRename(JSON.parse(json))));
    },
    projectRenameCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectRename(JSON.parse(json))));
    },
    projectFlowOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectFlowOptions(JSON.parse(json)));
        });
    },
    projectFlowRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectFlowOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectFlowPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectFlow(JSON.parse(json)));
        });
    },
    projectFlowValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectFlow(JSON.parse(json))));
    },
    projectFlowCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectFlow(JSON.parse(json))));
    },
    projectTaskSortOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectTaskSortOptions(JSON.parse(json)));
        });
    },
    projectTaskSortWrite(_json: string): string {
        return submit(async () => { throw new Error('INVALID_INPUT: Project task sort writes require a durable host journal'); });
    },
    projectTaskSortRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectTaskSortOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectTaskSortPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectTaskSort(JSON.parse(json)));
        });
    },
    projectTaskSortValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectTaskSort(JSON.parse(json))));
    },
    projectTaskSortCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectTaskSort(JSON.parse(json))));
    },
    focusSavedFilterOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getFocusSavedFilterOptions(JSON.parse(json)));
        });
    },
    focusSavedFilterWrite(_json: string): string {
        return submit(async () => { throw new Error('INVALID_INPUT: Focus saved filter writes require a durable host journal'); });
    },
    focusSavedFilterRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeFocusSavedFilterOutcome(JSON.parse(json)));
        });
    },
    focusSavedFilterPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareFocusSavedFilter(JSON.parse(json)));
        });
    },
    focusSavedFilterValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedFocusSavedFilter(JSON.parse(json))));
    },
    focusSavedFilterCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedFocusSavedFilter(JSON.parse(json))));
    },
    savedSearchOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getSavedSearchWriteOptions(JSON.parse(json)));
        });
    },
    savedSearchWrite(_json: string): string {
        return submit(async () => { throw new Error('INVALID_INPUT: Saved search writes require a durable host journal'); });
    },
    savedSearchRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeSavedSearchWriteOutcome(JSON.parse(json)));
        });
    },
    savedSearchPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareSavedSearchWrite(JSON.parse(json)));
        });
    },
    savedSearchValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedSavedSearchWrite(JSON.parse(json))));
    },
    savedSearchCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedSavedSearchWrite(JSON.parse(json))));
    },
    focusOrderOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getFocusOrderOptions(JSON.parse(json)));
        });
    },
    focusOrderWrite(_json: string): string {
        return submit(async () => { throw new Error('INVALID_INPUT: Focus order writes require a durable host journal'); });
    },
    focusOrderRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeFocusOrderOutcome(JSON.parse(json)));
        });
    },
    focusOrderPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareFocusOrder(JSON.parse(json)));
        });
    },
    focusOrderValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedFocusOrder(JSON.parse(json))));
    },
    focusOrderCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedFocusOrder(JSON.parse(json))));
    },
    projectTaskOrderWrite(_json: string): string {
        return submit(async () => { throw new Error('INVALID_INPUT: Project task order writes require a durable host journal'); });
    },
    projectTaskOrderRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectTaskOrderOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectTaskOrderPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectTaskOrder(JSON.parse(json)));
        });
    },
    projectTaskOrderValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectTaskOrder(JSON.parse(json))));
    },
    projectTaskOrderCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectTaskOrder(JSON.parse(json))));
    },
    projectNotesEditOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectNotesEditOptions(JSON.parse(json)));
        });
    },
    projectNotesDraftDirection(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectNotesDraftDirection(JSON.parse(json)));
        });
    },
    projectNotesWriteRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectNotesWriteOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectNotesWritePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectNotesWrite(JSON.parse(json)));
        });
    },
    projectNotesWriteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectNotesWrite(JSON.parse(json))));
    },
    projectNotesWriteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectNotesWrite(JSON.parse(json))));
    },
    projectTagsEditOptions(id: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectTagsEditOptions({ projectId: id }));
        });
    },
    projectTagsWriteRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectTagsWriteOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectTagsWritePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectTagsWrite(JSON.parse(json)));
        });
    },
    projectTagsWriteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectTagsWrite(JSON.parse(json))));
    },
    projectTagsWriteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectTagsWrite(JSON.parse(json))));
    },
    /** Settled durable raw authority; target derivation remains shared policy. */
    projectAttachmentAvailabilityPreflight(json: string, encryptionStateJSON?: unknown): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments || nativeSync || !bootAdapter
                || iosCleanupCallback || iosTaskAttachmentPreparation || iosProjectFilePreparation || isSandboxMode() || isWorkspaceTransitionActive()) {
                throw new Error('NOT_READY: Project availability is unavailable');
            }
            requireSaved();
            if (encryptionStateJSON !== undefined) await assertNativeSelfHostedAttachmentEncryptionAdmission(encryptionStateJSON);
            return unwrap(await contract.getProjectAttachmentAvailabilityPreflight(JSON.parse(json)));
        });
    },
    /** Native-owned present-generation proof; canonical target policy stays shared. */
    projectAttachmentCachedAvailabilityPreflight(json: string, encryptionStateJSON: unknown): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments || nativeSync || !bootAdapter
                || iosCleanupCallback || iosTaskAttachmentPreparation || iosProjectFilePreparation || iosCachedProjectAvailability
                || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error('NOT_READY: Cached Project availability is unavailable');
            requireSaved();
            const webdav = await keyValue.get(SYNC_BACKEND_KEY) === 'webdav';
            if (!webdav && (await keyValue.get(SYNC_BACKEND_KEY) !== 'cloud' || !isNativeIosSelfHostedProvider(await keyValue.get(CLOUD_PROVIDER_KEY)))) {
                throw new Error('NOT_READY: Cached Project availability is unavailable');
            }
            await assertNativeSelfHostedAttachmentEncryptionAdmission(encryptionStateJSON);
            const input = editorJson(json) as Parameters<ReturnType<typeof createProjectAvailabilityMethods>['getProjectAttachmentAvailabilityPreflight']>[0];
            return unwrap(await createProjectAvailabilityMethods({ ...projectAvailabilityDeps(input.projectId), host: () => null }, webdav ? 'cached-webdav' : 'cached')
                .getProjectAttachmentAvailabilityPreflight(input));
        });
    },
    projectAttachmentCachedAvailability(json: string, exactTargetURI: string, proofJSON?: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments || nativeSync || !bootAdapter
                || iosCleanupCallback || iosTaskAttachmentPreparation || iosProjectFilePreparation || iosCachedProjectAvailability
                || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error('NOT_READY: Cached Project availability is unavailable');
            requireSaved();
            const webdav = await keyValue.get(SYNC_BACKEND_KEY) === 'webdav';
            if (!webdav && (await keyValue.get(SYNC_BACKEND_KEY) !== 'cloud' || !isNativeIosSelfHostedProvider(await keyValue.get(CLOUD_PROVIDER_KEY)))) {
                throw new Error('NOT_READY: Cached Project availability is unavailable');
            }
            await assertNativeSelfHostedAttachmentEncryptionAdmission(await keyValue.get(SYNC_ENCRYPTION_STATE_KEY));
            const channels = nativeFileChannels();
            if (!channels) throw new Error('NOT_READY: Cached Project availability is unavailable');
            const preparedHost = createNativeReadOnlySelfHostedAttachments({
                getConfigValue: (name) => keyValue.get(name), getLegacyValue: (name) => keyValue.get(name),
                getSecret: (account) => (globalThis.__mindwtrSyncSecrets as HostSecrets).getSecret(account),
                crypto: createHostSyncCrypto((globalThis as { __mindwtrCryptoCall?: Parameters<typeof createHostSyncCrypto>[0] }).__mindwtrCryptoCall),
            }, channels, webdav);
            const readonlyHost = { ...preparedHost.contractHost,
                ensureAttachmentAvailableDetailed: async (attachment: import('../../../packages/core/src/types').Attachment) => {
                    let selected = attachment;
                    if (webdav && attachment.fileHash === undefined) {
                        const proof = typeof proofJSON === 'string' ? editorJson(proofJSON) as { sha256?: unknown; size?: unknown } : null;
                        if (!proof || Object.keys(proof).sort().join(',') !== 'sha256,size'
                            || typeof proof.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(proof.sha256)
                            || typeof proof.size !== 'number' || !Number.isSafeInteger(proof.size) || proof.size < 0 || proof.size > 8_388_608
                            || attachment.size !== undefined && attachment.size !== proof.size
                            || attachment.uri !== exactTargetURI) throw new Error('NOT_READY: Cached Project availability is unavailable');
                        selected = { ...attachment, fileHash: proof.sha256 };
                    }
                    const result = await preparedHost.prepareAttachmentAvailableDetailed(selected);
                    if (result.status === 'available') {
                        const resolved = { ...result.attachment };
                        if (attachment.fileHash === undefined) delete resolved.fileHash;
                        return { status: 'available' as const, attachment: resolved };
                    }
                    return { status: result.status === 'generation-conflict' ? 'generation-conflict' as const : 'unavailable' as const };
                },
            };
            const input = editorJson(json) as Parameters<ReturnType<typeof createProjectAvailabilityMethods>['downloadRelocatedProjectAttachment']>[0];
            iosCachedProjectAvailability = true;
            try { return await createProjectAvailabilityMethods({ ...projectAvailabilityDeps(input.projectId), host: () => readonlyHost }, webdav ? 'cached-webdav' : 'cached')
                .downloadRelocatedProjectAttachment(input, exactTargetURI); }
            finally { iosCachedProjectAvailability = false; }
        });
    },
    projectAttachmentEditOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectAttachmentEditOptions(projectAttachmentInput(json)));
        });
    },
    projectAttachmentWriteRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectAttachmentWriteOutcome(editorJson(json) as Parameters<typeof contract.probeProjectAttachmentWriteOutcome>[0]));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectAttachmentWritePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectAttachmentWrite(editorJson(json) as Parameters<typeof contract.prepareProjectAttachmentWrite>[0]));
        });
    },
    projectAttachmentWriteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectAttachmentWrite(editorJson(json) as Parameters<typeof contract.validatePreparedProjectAttachmentWrite>[0])));
    },
    projectAttachmentWriteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectAttachmentWrite(editorJson(json) as Parameters<typeof contract.commitPreparedProjectAttachmentWrite>[0])));
    },
    projectFileRemoveWriteRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectFileRemoveWriteOutcome(editorJson(json) as Parameters<typeof contract.probeProjectFileRemoveWriteOutcome>[0]));
        });
    },
    projectFileRemoveWritePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectFileRemoveWrite(editorJson(json) as Parameters<typeof contract.prepareProjectFileRemoveWrite>[0]));
        });
    },
    projectFileRemoveWriteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectFileRemoveWrite(editorJson(json) as Parameters<typeof contract.validatePreparedProjectFileRemoveWrite>[0])));
    },
    projectFileRemoveWriteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectFileRemoveWrite(editorJson(json) as Parameters<typeof contract.commitPreparedProjectFileRemoveWrite>[0])));
    },
    // Private native publisher calls; these are not ordinary CoreHost query mutations.
    projectFileAvailabilityPreflight(json: string, encryptionStateJSON: unknown, cloudURL: string, backend: string = 'cloud'): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || !localAttachments || nativeSync
                || iosTaskAttachmentPreparation || iosProjectFilePreparation || iosCleanupCallback
                || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error('NOT_READY: Project download is unavailable');
            requireSaved(); await assertNativeSelfHostedAttachmentEncryptionAdmission(encryptionStateJSON);
            const input = editorJson(json) as { projectId?: unknown };
            const id = typeof input.projectId === 'string' ? input.projectId : '';
            const preflight = unwrap(await preparedProjectAvailability(id, backend).getProjectFileAvailabilityPreflight(input));
            return { preflight, columns: PROJECT_SQLITE_COLUMNS,
                initialURL: nativeProjectFileAvailabilityInitialURL(preflight.attachmentJSON, cloudURL, backend === 'webdav') };
        });
    },
    projectFileAvailabilityEncryptionAdmission(encryptionStateJSON: unknown): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Project download is unavailable');
            await assertNativeSelfHostedAttachmentEncryptionAdmission(encryptionStateJSON); return null;
        });
    },
    projectFileAvailabilityWritePrepare(json: string, backend: string = 'cloud'): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || isSandboxMode() || isWorkspaceTransitionActive()) {
                throw new Error('NOT_READY: Project download is unavailable');
            }
            requireSaved(); const input = editorJson(json) as { projectId?: unknown };
            const methods = preparedProjectAvailability(typeof input.projectId === 'string' ? input.projectId : '', backend);
            return 'unrecoverableAt' in input ? unwrap(await methods.prepareProjectFileUnrecoverable(input))
                : unwrap(await methods.prepareProjectFileAvailability(input));
        });
    },
    projectFileAvailabilityWriteValidate(json: string, backend: string = 'cloud'): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Project download is unavailable');
            return unwrap(preparedProjectAvailability('', backend).validatePreparedProjectFileAvailability(editorJson(json)));
        });
    },
    projectFileAvailabilityWriteCommit(json: string, backend: string = 'cloud'): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || isSandboxMode() || isWorkspaceTransitionActive()) {
                throw new Error('NOT_READY: Project download is unavailable');
            }
            const input = editorJson(json) as { request?: { projectId?: unknown } };
            return unwrap(await preparedProjectAvailability(typeof input.request?.projectId === 'string' ? input.request.projectId : '', backend).commitPreparedProjectFileAvailability(input));
        });
    },
    projectFileAddWritePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(await contract.prepareProjectFileAddWrite(editorJson(json) as Parameters<typeof contract.prepareProjectFileAddWrite>[0]));
        });
    },
    projectFileAddWriteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectFileAddWrite(editorJson(json) as Parameters<typeof contract.validatePreparedProjectFileAddWrite>[0])));
    },
    projectFileAddWriteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectFileAddWrite(editorJson(json) as Parameters<typeof contract.commitPreparedProjectFileAddWrite>[0])));
    },
    projectStatusOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectStatusOptions(JSON.parse(json)));
        });
    },
    projectStatusRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectStatusOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectStatusPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectStatus(JSON.parse(json)));
        });
    },
    projectStatusValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectStatus(JSON.parse(json))));
    },
    projectStatusCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectStatus(JSON.parse(json))));
    },
    projectDateOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectDateOptions(JSON.parse(json)));
        });
    },
    projectDateRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectDateOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectDatePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectDate(JSON.parse(json)));
        });
    },
    projectDateValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectDate(JSON.parse(json))));
    },
    projectDateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectDate(JSON.parse(json))));
    },
    projectAreaOptions(id: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectAreaOptions({ projectId: id }));
        });
    },
    projectAreaRetryOutcome(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.probeProjectAreaOutcome(JSON.parse(json)));
        });
    },
    /** Private iOS preparation and commit; Swift owns the durable journal. */
    projectAreaPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectArea(JSON.parse(json)));
        });
    },
    projectAreaValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectArea(JSON.parse(json))));
    },
    projectAreaCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectArea(JSON.parse(json))));
    },
    /** Core refuses a stale `revision`; Kotlin then reads the project again from offset 0. */
    projectDetail(id: string, offset: number, limit: number, revision: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectDetail({ projectId: id, offset, limit, revision: revision || undefined }));
        });
    },
    projectNotes(id: string, offset: number, limit: number, revision: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectNotes({ projectId: id, offset, limit, revision: revision || undefined }));
        });
    },
    projectNotesReferenceTarget(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectNotesReferenceTarget(JSON.parse(json)));
        });
    },
    /** `json` is `{ id, base, patch }`, passed to core unchanged: the status menu and the Restore and Next swipes. */
    update(json: string): string {
        return submit(async () => taskResult('update', await contract.updateTask(JSON.parse(json))));
    },
    /** `json` is the editor's `{ id, base, patch, checklist? }` (draft fields and the edited checklist), passed to core's saveTaskDraft unchanged. */
    saveDraft(json: string): string {
        return submit(async () => taskResult('saveTaskDraft', await contract.saveTaskDraft(JSON.parse(json))));
    },
    /** One static Calendar preference intent; exact before/desired values survive journal replay. */
    calendarPreference(json: string): string {
        return submit(async () => unwrap(await contract.setCalendarPreference(JSON.parse(json))));
    },
    /** Read-only RN Calendar composer transport. */
    calendarComposerOpen(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.openCalendarComposer(JSON.parse(json))); });
    },
    calendarComposerEdit(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.editCalendarComposer(JSON.parse(json))); });
    },
    calendarDeletePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareCalendarDelete(JSON.parse(json))); });
    },
    calendarDeleteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedCalendarDelete(JSON.parse(json))));
    },
    calendarDeleteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedCalendarDelete(JSON.parse(json))));
    },
    calendarUnschedulePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareCalendarUnschedule(JSON.parse(json))); });
    },
    calendarUnscheduleValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedCalendarUnschedule(JSON.parse(json))));
    },
    calendarUnscheduleCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedCalendarUnschedule(JSON.parse(json))));
    },
    /** Private pure preparation, persisted by the iOS host before any task write. */
    calendarComposerPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareCalendarComposerSave(JSON.parse(json))); });
    },
    /** Private immutable authority check; safe before boot and terminal cleanup. */
    calendarComposerValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedCalendarComposerSave(JSON.parse(json))));
    },
    calendarComposerCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedCalendarComposerSave(JSON.parse(json))));
    },
    /** New Calendar task/project is one frozen, atomic publication. */
    calendarComposerCreatePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareCalendarComposerCreate(JSON.parse(json))); });
    },
    calendarComposerCreateValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedCalendarComposerCreate(JSON.parse(json))));
    },
    calendarComposerCreateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedCalendarComposerCreate(JSON.parse(json))));
    },
    /** Private native Board preparation: no store writes before the host journals it. */
    boardPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareBoardAction(JSON.parse(json)));
        });
    },
    /** Private immutable journal check; safe before boot and during terminal cleanup. */
    boardValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedBoardAction(JSON.parse(json))));
    },
    /** Only the exact frozen Trash/Duplicate envelope is replayable. */
    boardCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedBoardAction(JSON.parse(json))));
    },
    prepareTaskPromotion(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareTaskPromotion(editorJson(json) as Parameters<typeof contract.prepareTaskPromotion>[0])); });
    },
    validatePreparedTaskPromotion(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskPromotion(editorJson(json) as Parameters<typeof contract.validatePreparedTaskPromotion>[0])));
    },
    taskPromoteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTaskPromotion(editorJson(json) as Parameters<typeof contract.commitPreparedTaskPromotion>[0])));
    },
    taskDeletePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareTaskDelete(editorJson(json) as Parameters<typeof contract.prepareTaskDelete>[0])); });
    },
    taskDeleteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskDelete(editorJson(json) as Parameters<typeof contract.validatePreparedTaskDelete>[0])));
    },
    taskDeleteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTaskDelete(editorJson(json) as Parameters<typeof contract.commitPreparedTaskDelete>[0])));
    },
    taskDeleteOutcome(json: string): string {
        return submit(async () => unwrap(contract.taskDeleteOutcome(editorJson(json) as Parameters<typeof contract.taskDeleteOutcome>[0])));
    },
    taskDeleteUndoPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareTaskDeleteUndo(editorJson(json) as Parameters<typeof contract.prepareTaskDeleteUndo>[0])); });
    },
    taskDeleteUndoValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskDeleteUndo(editorJson(json) as Parameters<typeof contract.validatePreparedTaskDeleteUndo>[0])));
    },
    taskDeleteUndoCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTaskDeleteUndo(editorJson(json) as Parameters<typeof contract.commitPreparedTaskDeleteUndo>[0])));
    },
    taskDeleteUndoOutcome(json: string): string {
        return submit(async () => unwrap(contract.taskDeleteUndoOutcome(editorJson(json) as Parameters<typeof contract.taskDeleteUndoOutcome>[0])));
    },
    doneTaskStatusOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getDoneTaskStatusOptions(completionJson(json, 4_096) as Parameters<typeof contract.getDoneTaskStatusOptions>[0])); });
    },
    referenceProjectNextActionOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getReferenceProjectNextActionOptions(completionJson(json, 2_100_000) as Parameters<typeof contract.getReferenceProjectNextActionOptions>[0])); });
    },
    referenceProjectNextActionInput(text: string): string {
        return submit(async () => {
            if (typeof text !== 'string' || text.length > 100_000) throw new Error('INVALID_INPUT: Next action text is too large');
            return unwrap(contract.referenceProjectNextActionInput(text));
        });
    },
    referenceProjectNextActionPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareReferenceProjectNextAction(completionJson(json, 2_100_000) as Parameters<typeof contract.prepareReferenceProjectNextAction>[0])); });
    },
    referenceProjectNextActionValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedReferenceProjectNextAction(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedReferenceProjectNextAction>[0])));
    },
    referenceProjectNextActionCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedReferenceProjectNextAction(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedReferenceProjectNextAction>[0])));
    },
    referenceProjectNextActionOutcome(json: string): string {
        return submit(async () => unwrap(contract.referenceProjectNextActionOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.referenceProjectNextActionOutcome>[0])));
    },
    referenceTaskDestinationOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getReferenceTaskDestinationOptions(completionJson(json, 4_096) as Parameters<typeof contract.getReferenceTaskDestinationOptions>[0])); });
    },
    referenceTaskDestinationPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareReferenceTaskDestination(completionJson(json, 4_096) as Parameters<typeof contract.prepareReferenceTaskDestination>[0])); });
    },
    referenceTaskDestinationValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedReferenceTaskDestination(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedReferenceTaskDestination>[0])));
    },
    referenceTaskDestinationCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedReferenceTaskDestination(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedReferenceTaskDestination>[0])));
    },
    referenceTaskDestinationOutcome(json: string): string {
        return submit(async () => unwrap(contract.referenceTaskDestinationOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.referenceTaskDestinationOutcome>[0])));
    },
    referenceTaskBackdateOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getReferenceTaskBackdateOptions(completionJson(json, 4_096) as Parameters<typeof contract.getReferenceTaskBackdateOptions>[0])); });
    },
    referenceTaskBackdatePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareReferenceTaskBackdate(completionJson(json, 4_096) as Parameters<typeof contract.prepareReferenceTaskBackdate>[0])); });
    },
    referenceTaskBackdateValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedReferenceTaskBackdate(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedReferenceTaskBackdate>[0])));
    },
    referenceTaskBackdateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedReferenceTaskBackdate(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedReferenceTaskBackdate>[0])));
    },
    referenceTaskBackdateOutcome(json: string): string {
        return submit(async () => unwrap(contract.referenceTaskBackdateOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.referenceTaskBackdateOutcome>[0])));
    },
    doneTaskStatusPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareDoneTaskStatus(completionJson(json, 4_096) as Parameters<typeof contract.prepareDoneTaskStatus>[0])); });
    },
    doneTaskStatusValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedDoneTaskStatus(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedDoneTaskStatus>[0])));
    },
    doneTaskStatusCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedDoneTaskStatus(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedDoneTaskStatus>[0])));
    },
    doneTaskStatusOutcome(json: string): string {
        return submit(async () => unwrap(contract.doneTaskStatusOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.doneTaskStatusOutcome>[0])));
    },
    doneTaskCompletedAtOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getDoneTaskCompletedAtOptions(completionJson(json, 4_096) as Parameters<typeof contract.getDoneTaskCompletedAtOptions>[0])); });
    },
    doneTaskCompletedAtPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareDoneTaskCompletedAt(completionJson(json, 4_096) as Parameters<typeof contract.prepareDoneTaskCompletedAt>[0])); });
    },
    doneTaskCompletedAtValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedDoneTaskCompletedAt(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedDoneTaskCompletedAt>[0])));
    },
    doneTaskCompletedAtCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedDoneTaskCompletedAt(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedDoneTaskCompletedAt>[0])));
    },
    doneTaskCompletedAtOutcome(json: string): string {
        return submit(async () => unwrap(contract.doneTaskCompletedAtOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.doneTaskCompletedAtOutcome>[0])));
    },
    archiveTaskCompletedAtOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getArchiveTaskCompletedAtOptions(completionJson(json, 4_096) as Parameters<typeof contract.getArchiveTaskCompletedAtOptions>[0])); });
    },
    archiveTaskCompletedAtPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareArchiveTaskCompletedAt(completionJson(json, 4_096) as Parameters<typeof contract.prepareArchiveTaskCompletedAt>[0])); });
    },
    archiveTaskCompletedAtValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedArchiveTaskCompletedAt(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedArchiveTaskCompletedAt>[0])));
    },
    archiveTaskCompletedAtCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedArchiveTaskCompletedAt(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedArchiveTaskCompletedAt>[0])));
    },
    archiveTaskCompletedAtOutcome(json: string): string {
        return submit(async () => unwrap(contract.archiveTaskCompletedAtOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.archiveTaskCompletedAtOutcome>[0])));
    },
    taskCompletionPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareTaskCompletion(completionJson(json, 4_096) as Parameters<typeof contract.prepareTaskCompletion>[0])); });
    },
    taskCompletionValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskCompletion(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedTaskCompletion>[0])));
    },
    taskCompletionCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTaskCompletion(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedTaskCompletion>[0])));
    },
    taskCompletionOutcome(json: string): string {
        return submit(async () => unwrap(contract.taskCompletionOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.taskCompletionOutcome>[0])));
    },
    taskCompletionUndoPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareTaskCompletionUndo(completionJson(json, 4_500_000) as Parameters<typeof contract.prepareTaskCompletionUndo>[0])); });
    },
    taskCompletionUndoValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskCompletionUndo(completionJson(json, 4_500_000) as Parameters<typeof contract.validatePreparedTaskCompletionUndo>[0])));
    },
    taskCompletionUndoCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTaskCompletionUndo(completionJson(json, 4_500_000) as Parameters<typeof contract.commitPreparedTaskCompletionUndo>[0])));
    },
    taskCompletionUndoOutcome(json: string): string {
        return submit(async () => unwrap(contract.taskCompletionUndoOutcome(completionJson(json, 4_500_000) as Parameters<typeof contract.taskCompletionUndoOutcome>[0])));
    },
    trashTaskRestorePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareTrashTaskRestore(editorJson(json) as Parameters<typeof contract.prepareTrashTaskRestore>[0])); });
    },
    trashTaskRestoreValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTrashTaskRestore(editorJson(json) as Parameters<typeof contract.validatePreparedTrashTaskRestore>[0])));
    },
    trashTaskRestoreCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTrashTaskRestore(editorJson(json) as Parameters<typeof contract.commitPreparedTrashTaskRestore>[0])));
    },
    archivedTasksDeletePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareArchivedTasksDelete(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareArchivedTasksDelete>[0])); });
    },
    archivedTasksDeleteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedArchivedTasksDelete(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedArchivedTasksDelete>[0])));
    },
    archivedTasksDeleteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedArchivedTasksDelete(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedArchivedTasksDelete>[0])));
    },
    archivedTasksDeleteOutcome(json: string): string {
        return submit(async () => unwrap(contract.archivedTasksDeleteOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.archivedTasksDeleteOutcome>[0])));
    },
    archivedTasksDeleteUndoPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareArchivedTasksDeleteUndo(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareArchivedTasksDeleteUndo>[0])); });
    },
    archivedTasksDeleteUndoValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedArchivedTasksDeleteUndo(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedArchivedTasksDeleteUndo>[0])));
    },
    archivedTasksDeleteUndoCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedArchivedTasksDeleteUndo(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedArchivedTasksDeleteUndo>[0])));
    },
    archivedTasksDeleteUndoOutcome(json: string): string {
        return submit(async () => unwrap(contract.archivedTasksDeleteUndoOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.archivedTasksDeleteUndoOutcome>[0])));
    },
    referenceTasksMoveNotice(json: string): string {
        return submit(async () => {
            requireSaved();
            const result = completionJson(json, 2_000) as { count?: unknown; status?: unknown };
            if (!result || typeof result !== 'object' || Array.isArray(result)
                || Object.keys(result).sort().join(',') !== 'count,status'
                || typeof result.count !== 'number' || !Number.isInteger(result.count)
                || result.count < 1 || result.count > 10_000
                || !getBulkMoveStatusOptions('reference').includes(result.status as TaskStatus)) {
                throw new Error('INVALID_INPUT: Reference move notice requires a bounded result');
            }
            const t = (key: string): string => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key;
            return { message: formatListItemCount(result.count, 'task', t) };
        });
    },
    referenceTasksMovePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareReferenceTasksMove(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareReferenceTasksMove>[0])); });
    },
    referenceTasksMoveValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedReferenceTasksMove(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedReferenceTasksMove>[0])));
    },
    referenceTasksMoveCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedReferenceTasksMove(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedReferenceTasksMove>[0])));
    },
    referenceTasksMoveOutcome(json: string): string {
        return submit(async () => unwrap(await contract.referenceTasksMoveOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.referenceTasksMoveOutcome>[0])));
    },
    referenceTasksAddTagPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareReferenceTasksAddTag(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareReferenceTasksAddTag>[0])); });
    },
    referenceTasksAddTagValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedReferenceTasksAddTag(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedReferenceTasksAddTag>[0])));
    },
    referenceTasksAddTagCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedReferenceTasksAddTag(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedReferenceTasksAddTag>[0])));
    },
    referenceTasksAddTagOutcome(json: string): string {
        return submit(async () => unwrap(await contract.referenceTasksAddTagOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.referenceTasksAddTagOutcome>[0])));
    },
    referenceTasksRemoveTagPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareReferenceTasksRemoveTag(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareReferenceTasksRemoveTag>[0])); });
    },
    referenceTasksRemoveTagValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedReferenceTasksRemoveTag(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedReferenceTasksRemoveTag>[0])));
    },
    referenceTasksRemoveTagCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedReferenceTasksRemoveTag(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedReferenceTasksRemoveTag>[0])));
    },
    referenceTasksRemoveTagOutcome(json: string): string {
        return submit(async () => unwrap(await contract.referenceTasksRemoveTagOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.referenceTasksRemoveTagOutcome>[0])));
    },
    archivedTasksRestorePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareArchivedTasksRestore(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareArchivedTasksRestore>[0])); });
    },
    archivedTasksRestoreValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedArchivedTasksRestore(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedArchivedTasksRestore>[0])));
    },
    archivedTasksRestoreCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedArchivedTasksRestore(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedArchivedTasksRestore>[0])));
    },
    archivedTasksRestoreOutcome(json: string): string {
        return submit(async () => unwrap(contract.archivedTasksRestoreOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.archivedTasksRestoreOutcome>[0])));
    },
    archivedTaskRestorePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareArchivedTaskRestore(editorJson(json) as Parameters<typeof contract.prepareArchivedTaskRestore>[0])); });
    },
    archivedTaskRestoreValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedArchivedTaskRestore(editorJson(json) as Parameters<typeof contract.validatePreparedArchivedTaskRestore>[0])));
    },
    archivedTaskRestoreCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedArchivedTaskRestore(editorJson(json) as Parameters<typeof contract.commitPreparedArchivedTaskRestore>[0])));
    },
    archivedTaskRestoreOutcome(json: string): string {
        return submit(async () => unwrap(contract.archivedTaskRestoreOutcome(editorJson(json) as Parameters<typeof contract.archivedTaskRestoreOutcome>[0])));
    },
    trashProjectRestorePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareTrashProjectRestore(editorJson(json) as Parameters<typeof contract.prepareTrashProjectRestore>[0])); });
    },
    trashProjectRestoreValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTrashProjectRestore(editorJson(json) as Parameters<typeof contract.validatePreparedTrashProjectRestore>[0])));
    },
    trashProjectRestoreCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTrashProjectRestore(editorJson(json) as Parameters<typeof contract.commitPreparedTrashProjectRestore>[0])));
    },
    projectDeletePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareProjectDelete(editorJson(json) as Parameters<typeof contract.prepareProjectDelete>[0])); });
    },
    projectDeleteValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectDelete(editorJson(json) as Parameters<typeof contract.validatePreparedProjectDelete>[0])));
    },
    projectDeleteCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectDelete(editorJson(json) as Parameters<typeof contract.commitPreparedProjectDelete>[0])));
    },
    projectDeleteOutcome(json: string): string {
        return submit(async () => unwrap(contract.projectDeleteOutcome(editorJson(json) as Parameters<typeof contract.projectDeleteOutcome>[0])));
    },
    projectDeleteUndoPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareProjectDeleteUndo(editorJson(json) as Parameters<typeof contract.prepareProjectDeleteUndo>[0])); });
    },
    projectDeleteUndoValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectDeleteUndo(editorJson(json) as Parameters<typeof contract.validatePreparedProjectDeleteUndo>[0])));
    },
    projectDeleteUndoCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectDeleteUndo(editorJson(json) as Parameters<typeof contract.commitPreparedProjectDeleteUndo>[0])));
    },
    projectDuplicatePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareProjectDuplicate(editorJson(json) as Parameters<typeof contract.prepareProjectDuplicate>[0])); });
    },
    projectDuplicateValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectDuplicate(editorJson(json) as Parameters<typeof contract.validatePreparedProjectDuplicate>[0])));
    },
    projectDuplicateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectDuplicate(editorJson(json) as Parameters<typeof contract.commitPreparedProjectDuplicate>[0])));
    },
    projectLifecyclePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareProjectLifecycle(editorJson(json) as Parameters<typeof contract.prepareProjectLifecycle>[0])); });
    },
    projectLifecycleValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedProjectLifecycle(editorJson(json) as Parameters<typeof contract.validatePreparedProjectLifecycle>[0])));
    },
    projectLifecycleCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedProjectLifecycle(editorJson(json) as Parameters<typeof contract.commitPreparedProjectLifecycle>[0])));
    },
    projectLifecycleOutcome(json: string): string {
        return submit(async () => unwrap(contract.projectLifecycleOutcome(editorJson(json) as Parameters<typeof contract.projectLifecycleOutcome>[0])));
    },
    /** Private native editor preparation freezes the raw Task effect before journaling. */
    draftPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(await contract.prepareTaskDraftSaveV2(editorJson(json) as Parameters<typeof contract.prepareTaskDraftSaveV2>[0]));
        });
    },
    /** Review row actions prepare the ordinary durable Task Draft V2 journal. */
    reviewTaskPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(await contract.prepareReviewTaskWrite(editorJson(json) as Parameters<typeof contract.prepareReviewTaskWrite>[0]));
        });
    },
    /** Pure check for both legacy v1 and exact v2 Task Editor journals. */
    draftValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskDraftSave(editorJson(json) as Parameters<typeof contract.validatePreparedTaskDraftSave>[0])));
    },
    /** Commit only the exact prepared editor envelope; recovery never prepares again. */
    draftCommit(json: string): string {
        return submit(async () => taskResult('saveTaskDraft', await contract.commitPreparedTaskDraftSave(editorJson(json) as Parameters<typeof contract.commitPreparedTaskDraftSave>[0])));
    },
    /** Pure checklist edit and field model; only the host's prepared save writes. */
    checklistEdit(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.editTaskChecklist(JSON.parse(json))); });
    },
    checklistSavePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareTaskChecklistSave(editorJson(json) as Parameters<typeof contract.prepareTaskChecklistSave>[0])); });
    },
    checklistResetPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareTaskChecklistReset(JSON.parse(json))); });
    },
    checklistPreparedValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskChecklistWrite(editorJson(json) as Parameters<typeof contract.validatePreparedTaskChecklistWrite>[0])));
    },
    checklistPreparedCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTaskChecklistWrite(editorJson(json) as Parameters<typeof contract.commitPreparedTaskChecklistWrite>[0])));
    },
    taskCancellationUndoPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            if (globalThis.__mindwtrHostPlatform === 'ios') {
                const input = attachmentDraftJson(json) as Parameters<typeof contract.prepareOwnedEditorCompleteTaskCancellationUndo>[0];
                if ((input?.cancel?.request?.version === 2 || input?.cancel?.request?.version === 3 || input?.cancel?.request?.version === 4)) return unwrap(await contract.prepareOwnedEditorCompleteTaskCancellationUndo(input));
            }
            return unwrap(await contract.prepareTaskCancellationUndo(editorJson(json) as Parameters<typeof contract.prepareTaskCancellationUndo>[0]));
        });
    },
    taskCancellationUndoValidate(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform === 'ios') {
                const input = attachmentDraftJson(json) as Parameters<typeof contract.validatePreparedOwnedEditorCompleteTaskCancellationUndo>[0];
                if (input?.prepared?.version === 2 && input.prepared.kind === 'undo') return unwrap(contract.validatePreparedOwnedEditorCompleteTaskCancellationUndo(input));
            }
            return unwrap(contract.validatePreparedTaskCancellationUndo(editorJson(json) as Parameters<typeof contract.validatePreparedTaskCancellationUndo>[0]));
        });
    },
    taskCancellationUndoCommit(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform === 'ios') {
                const input = attachmentDraftJson(json) as Parameters<typeof contract.commitPreparedOwnedEditorCompleteTaskCancellationUndo>[0];
                if (input?.prepared?.version === 2 && input.prepared.kind === 'undo') return unwrap(await contract.commitPreparedOwnedEditorCompleteTaskCancellationUndo(input));
            }
            return unwrap(await contract.commitPreparedTaskCancellationUndo(editorJson(json) as Parameters<typeof contract.commitPreparedTaskCancellationUndo>[0]));
        });
    },
    /** The capture popup (RN's quick capture sheet): an empty draft with the starting options. */
    captureOpen(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.openQuickCapture());
        });
    },
    /** `json` is `{ text, options, picker? }`, passed to core unchanged. */
    captureView(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getQuickCaptureView(JSON.parse(json)));
        });
    },
    /** `json` is `{ text, options, edit, picker? }`: one control's edit. Nothing is written. */
    captureEdit(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.editQuickCapture(JSON.parse(json)));
        });
    },
    /** `json` is `{ text, options, captureId, openAfterSave }`. Reusing captureId retries: the draft is written at most once. */
    captureSubmit(json: string): string {
        return submit(async () => taskResult('quickCapture', await contract.submitQuickCapture(JSON.parse(json))));
    },
    /** Read-only final creation rows; native journals this result before commit. */
    capturePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareQuickCapture(JSON.parse(json)));
        });
    },
    /** The exact prepared journal; retries never reparse text or current defaults. */
    captureCommit(json: string): string {
        return submit(async () => taskResult('quickCapture', await contract.commitPreparedQuickCapture(JSON.parse(json))));
    },
    /** Mind Sweep guide and its literal one-task Inbox add. The iOS host journals preparation before commit. */
    mindSweepGuide(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getMindSweepGuide(JSON.parse(json))); });
    },
    mindSweepPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareMindSweepAdd(JSON.parse(json))); });
    },
    mindSweepValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedMindSweepAdd(JSON.parse(json))));
    },
    mindSweepCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedMindSweepAdd(JSON.parse(json))));
    },
    /** The recovery snapshot before a several-lines capture; `{ snapshot: null }` in sandbox mode. */
    captureSnapshot(): string {
        return submit(async () => ({ snapshot: unwrap(await contract.createQuickCaptureSnapshot()) }));
    },
    /** `json` is `{ text, options, captureIds, snapshotFileName }`: one task per line, in one write. */
    captureLines(json: string): string {
        return submit(async () => taskResult('quickCaptureLines', await contract.submitQuickCaptureLines(JSON.parse(json))));
    },
    /** `json` is `{ picker, query, text, options, requestId }`: the project or area picker's search, chosen or created. */
    capturePicker(json: string): string {
        return submit(async () => taskResult('quickCapturePicker', await contract.submitQuickCapturePickerQuery(JSON.parse(json))));
    },
    /** `json` is `{ params, draft, captureId, openAfterSave }`: the capture screen's Save. Reusing captureId retries: written at most once. */
    captureModalSubmit(json: string): string {
        return submit(async () => taskResult('captureModal', await contract.submitCaptureModal(JSON.parse(json))));
    },
    /** `json` is `{ params, draft, captureIds }`: the capture screen's Create tasks, one task per line in one write. */
    captureModalLines(json: string): string {
        return submit(async () => taskResult('captureModalLines', await contract.submitCaptureModalLines(JSON.parse(json))));
    },
    // A revision left out ("", as iOS sends none) is no revision: core requires one only from a journaling host.
    complete(id: string, taskRevision = ''): string {
        return submit(async () => taskResult('complete', await contract.completeTask({ id, taskRevision: taskRevision || undefined })));
    },
    /** A target state, so an exact retry re-sends the same target. A `{ blocked }` reply wrote nothing. */
    taskFocus(id: string, focused: boolean, taskRevision = ''): string {
        return submit(async () => taskResult('taskFocus', await contract.setTaskFocus({ id, focused, taskRevision: taskRevision || undefined })));
    },
    projectFocus(id: string, focused: boolean, projectRevision = ''): string {
        return submit(async () => taskResult('projectFocus', await contract.setProjectFocus({ id, focused, projectRevision: projectRevision || undefined })));
    },
    /** `areaId` "" is no area. Core names the new project by `requestId`, so a replay finds it. */
    createProject(title: string, areaId: string, requestId: string): string {
        return submit(async () => taskResult('createProject', await contract.createProject({ title, areaId: areaId || null, requestId })));
    },
    areaFilter(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getAreaFilter());
        });
    },
    /** `json` is one of getAreaFilter's `next` selections, passed to core unchanged. */
    setAreaFilter(json: string): string {
        return submit(async () => taskResult('areaFilter', await contract.setAreaFilter(JSON.parse(json))));
    },
    /**
     * `json` is `{ query, filters, limit }`, passed to core's searchTasks unchanged; the reply echoes the trimmed query.
     * `filters: null` (the screen before any filter change) is core's DEFAULT_GLOBAL_SEARCH_FILTERS.
     */
    search(json: string): string {
        return submit(async () => {
            requireSaved();
            const input = JSON.parse(json);
            return unwrap(await contract.searchTasks({ ...input, filters: input.filters ?? DEFAULT_GLOBAL_SEARCH_FILTERS }));
        });
    },
    /** `json` is `{ query, name, requestId }`. Core saves one search per query, so a retry never adds a second. */
    saveSearch(json: string): string {
        return submit(async () => taskResult('saveSearch', await contract.saveSearch(JSON.parse(json))));
    },
    /** Core's startInboxProcessing in RN's per-device mode ('guided' or 'quick'). */
    inboxStart(mode: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.startInboxProcessing({ mode: mode as 'guided' | 'quick' }));
        });
    },
    /** `json` is `{ sessionId, taskId, step, edit?, mode? }`: one control's edit, passed to core unchanged. */
    inboxStep(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getInboxProcessingStep(JSON.parse(json)));
        });
    },
    /** `json` is `{ sessionId, taskId, step, decision, requestId }`. Core answers a repeated request without writing again. */
    inboxCommit(json: string): string {
        return submit(async () => taskResult('inboxCommit', await contract.commitInboxProcessingStep(JSON.parse(json))));
    },
    /** `json` is `{ sessionId, taskId, requestId }`, the header's Skip. */
    inboxSkip(json: string): string {
        return submit(async () => taskResult('inboxSkip', await contract.skipInboxProcessingTask(JSON.parse(json))));
    },
    /** iOS journals the exact prepared envelope before calling the private commit. */
    inboxCommitPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.inboxCommitPrepare(JSON.parse(json)));
        });
    },
    inboxSkipPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.inboxSkipPrepare(JSON.parse(json)));
        });
    },
    inboxPreparedValidate(json: string): string {
        return submit(async () => unwrap(contract.inboxPreparedValidate(JSON.parse(json))));
    },
    inboxPreparedCommit(json: string): string {
        return submit(async () => unwrap(await contract.inboxPreparedCommit(JSON.parse(json))));
    },
    inboxAfterCommit(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.inboxAfterCommit(JSON.parse(json)));
        });
    },
    /** Closes the session; it writes nothing. Core answers null; Kotlin reads an object. */
    inboxEnd(sessionId: string): string {
        return submit(async () => {
            unwrap(contract.endInboxProcessing({ sessionId }));
            return {};
        });
    },
    backupDocumentInspect(text: string, metadataJSON: string, format = 'json'): string {
        return submit(async () => {
            backupAdapter(true);
            const pending = getPersistenceStatus();
            if (pending.queued || pending.inFlight || pending.immediate || pending.retrying || pending.failed) {
                throw new Error('NOT_READY: Backup inspection is unavailable while saving is pending');
            }
            if (format !== 'json' && format !== 'json-restore' && format !== 'csv' && format !== 'todoist' && format !== 'ticktick' && format !== 'dgt' && format !== 'omnifocus') throw new Error('INVALID_INPUT: Invalid backup document input');
            return inspectNativeBackupDocument(text, backupJson(metadataJSON) as Parameters<typeof inspectNativeBackupDocument>[1], backupTranslate, format);
        });
    },
    backupDocumentPrepare(inputJSON: string): string {
        return submit(async () => prepareNativeBackupDocument(backupAdapter(true), backupJson(inputJSON) as Parameters<typeof prepareNativeBackupDocument>[1]));
    },
    backupDocumentCommit(referenceJSON: string, planJSON: string, snapshotName: string): string {
        return submit(async () => commitNativeBackupDocument(backupAdapter(), backupJson(referenceJSON) as Parameters<typeof commitNativeBackupDocument>[1], planJSON, snapshotName));
    },
    backupDocumentOutcome(referenceJSON: string, planJSON: string, snapshotName: string): string {
        return submit(async () => readNativeBackupDocumentOutcome(backupAdapter(), backupJson(referenceJSON) as Parameters<typeof readNativeBackupDocumentOutcome>[1], planJSON, snapshotName));
    },
    backupDocumentResultModel(replyJSON: string): string {
        return submit(async () => buildNativeBackupDocumentResult(backupJson(replyJSON) as Parameters<typeof buildNativeBackupDocumentResult>[0], backupTranslate));
    },
    backupSnapshotRestoreModel(snapshotName: string): string {
        return submit(async () => buildNativeBackupSnapshotRestoreConfirmation(snapshotName, backupTranslate));
    },
    /** Called by iOS only after the immutable JSON file has been written and closed. */
    backupExportPrepared(format: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform === 'ios' && (format === 'json' || format === 'csv' || format === 'tasknotes')) {
                try {
                    logInfo('Native iOS backup file prepared', {
                        scope: 'native-ios', force: true,
                        context: { releaseCheck: 'v1.3.5/ios-backup-export', outcome: 'prepared', format },
                    });
                } catch { /* Optional diagnostics cannot prevent sharing a completed file. */ }
            }
            return {};
        });
    },
    /** Settings › Data's Share log: the log file's path, made when missing (null when it cannot be made). Nothing is sent. */
    logShare(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform === 'ios') {
                try {
                    logInfo('Native iOS diagnostics share requested', {
                        scope: 'native-ios', force: true,
                        context: { releaseCheck: 'v1.3.4/ios-diagnostics', operation: 'share' },
                    });
                } catch { /* diagnostics must not stop sharing */ }
            }
            return { path: await diagnosticsLog.serialize(() => diagnosticsLog.ensurePath()) };
        });
    },
    /** Settings › Data's Clear log: deletes the log file. */
    logClear(): string {
        return submit(async () => {
            await diagnosticsLog.clear();
            return {};
        });
    },
    /** Checked Clear: no appended success line may recreate the target after absence is proven. */
    logClearChecked(): string {
        return submit(() => diagnosticsLog.clearChecked());
    },
    /** `name` is one of MENU_READS; `json` is that method's input. A read waits for an owed save, as every read does. */
    archiveTaskSelection(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getArchiveTaskSelection(completionJson(json, 2_000_000) as Parameters<typeof contract.getArchiveTaskSelection>[0])); });
    },
    doneBulkTagInput(tag: string, changedCount: number): string {
        return taskListBulkTagInput(tag, changedCount);
    },
    referenceBulkTagInput(tag: string, changedCount: number): string {
        return taskListBulkTagInput(tag, changedCount);
    },
    menuRead(name: string, json: string): string {
        return submit(async () => {
            // The More sheet is navigation: it opens while a retry is owed (an empty sheet looked broken on the phone,
            // 09-26); each destination's own read still waits for the retry and shows its banner.
            if (name !== 'more') requireSaved();
            const read = MENU_READS[name];
            if (!read) throw new Error(`INVALID_INPUT: no menu read ${name}`);
            return unwrap(read(JSON.parse(json) as never));
        });
    },
    /**
     * Sync (host-sync.ts), after the boot's validated load and journal replay: the network state first, then the automatic
     * triggers start and the app's first sync is asked for. `appState` is RN's AppState ('active' or 'background').
     * Each answers the badge and the finished-cycle count.
     */
    syncStart(appState: string): string {
        return submit(async () => requireSync().start(appState));
    },
    /** RN's AppState change: resume and leave run core's triggers. */
    syncAppState(appState: string): string {
        return submit(async () => requireSync().appState(appState));
    },
    /** `json` is the device's network state (`{ isConnected, isInternetReachable }`, as expo-network reads it). */
    syncNetwork(json: string): string {
        return submit(async () => {
            const next = JSON.parse(json) as { isConnected?: unknown; isInternetReachable?: unknown };
            networkState = {
                isConnected: typeof next.isConnected === 'boolean' ? next.isConnected : null,
                isInternetReachable: typeof next.isInternetReachable === 'boolean' ? next.isInternetReachable : null,
            };
            return requireSync().network(networkState);
        });
    },
    /** The badge and the finished-cycle count now. */
    syncState(): string {
        return submit(async () => requireSync().state());
    },
    /**
     * CoreWork's background run (core's runner; host-sync.ts backgroundSync), after the start order drained the queue: `trigger`
     * is 'scheduled' or 'capture', `stored` what the drains stored, `deadlineMs` a debug build's shorter deadline (0: core's). A
     * long call (CoreHost.callLong): it settles with the run.
     */
    backgroundSync(trigger: string, stored: number, deadlineMs: number): string {
        return submit(async () => {
            if (trigger !== 'scheduled' && trigger !== 'capture') throw new Error(`INVALID_INPUT: no background sync trigger ${trigger}`);
            const count = (value: number) => (Number.isInteger(value) && value > 0 ? value : 0);
            return requireSync().backgroundSync(trigger, count(stored), count(deadlineMs));
        });
    },
    /**
     * The pending-captures queue drained into the store (core's ingestPendingCaptures): at every boot after the journal's replay,
     * and for CoreWork's ingest job. A journaled write; its replay drains again.
     */
    ingest(requestId: string): string {
        return submit(async () => taskResult('ingest', await contract.ingestPendingCaptures({ requestId, queue: pendingCaptureQueue, lastApplied: lastAppliedRecord })));
    },
    /**
     * An automation trigger (`json`: the receiver's `{ action, context }`): core's notification as the details RN's alarm
     * library posts it with (its channel's name added), or null. None in sandbox mode, as RN's sendMobileImmediateNotification.
     * It writes nothing, and a failed save does not block it.
     */
    contextAutomation(json: string): string {
        return submit(async () => {
            const { notification } = unwrap(contract.runContextAutomation(JSON.parse(json)));
            if (!notification || isSandboxMode()) return { notification: null };
            return { notification: { ...buildImmediateNotificationDetails(notification.title, notification.message, notification.data), channelName: REMINDER_NOTIFICATION_CHANNEL_NAME } };
        });
    },
    /**
     * Reminder alarms (host-reminders.ts), after the boot's validated load, journal replay and queue drain: RN's alarms cancelled
     * once, the first plan applied, core's timers armed. `ask`: RN would ask for the notification permission now.
     */
    remindersStart(): string {
        return submit(async () => requireReminders().start());
    },
    /**
     * One plan applied now: `mode` "rebuild" remakes every alarm (a reboot dropped them, exact alarms were just allowed), "fired" makes
     * the daily or weekly alarm `key` that fired again at its next time, else "cycle".
     */
    remindersCycle(mode: string, key: string): string {
        return submit(async () => (mode === 'fired' && key ? requireReminders().fired(key) : requireReminders().cycle(mode === 'rebuild')));
    },
    /** A reminder's Done (core's completeReminderTask): a journaled write under the request UUID its notification was posted with. */
    reminderDone(requestId: string, taskId: string): string {
        return submit(async () => taskResult('reminderDone', await contract.completeReminderTask({ requestId, taskId })));
    },
    /**
     * A reminder's Snooze (core's snoozeReminder, `json`: `{ requestId, requestedAt, details }`): a journaled write whose alarm the
     * engine makes once (host-reminders.ts); its reply is that alarm, the same one on every retry of the request.
     */
    reminderSnooze(json: string): string {
        return submit(async () => {
            const result = await contract.snoozeReminder(JSON.parse(json));
            if (result.ok) await requireReminders().snooze(result.value);
            return taskResult('reminderSnooze', result);
        });
    },
    /** A line of Kotlin's runner (CoreWork, the queue drain) through core's logger, its fields in `context`. */
    logLinkHandoff(outcome: string, surface: string): string {
        return submit(async () => {
            if (!['opened', 'failed'].includes(outcome) || !['markdown', 'attachment'].includes(surface)) return {};
            const meta = { scope: 'links', force: true, context: { releaseCheck: 'v1.3.4/upnote-links', outcome, surface, scheme: 'upnote' } };
            if (outcome === 'failed') logWarn('Native UpNote handoff failed', meta);
            else logInfo('Native UpNote handoff accepted', meta);
            return {};
        });
    },
    logLine(message: string, contextJson: string): string {
        return submit(async () => {
            try {
                logInfo(message, { scope: 'native-android', context: JSON.parse(contextJson) as Record<string, unknown> });
            } catch { /* a diagnostic line must never fail its caller */ }
            return {};
        });
    },
    /** After the journal's boot replay: drops request receipts older than 30 days. */
    pruneReceipts(): string {
        return submit(async () => ({ pruned: await pruneNativeRequestReceipts(sqlite) }));
    },
    /** `name` is one of AI_REQUESTS; `json` is that request's input. It writes nothing. */
    aiRequest(name: string, json: string): string {
        return submit(async (signal) => {
            requireSaved();
            const request = AI_REQUESTS[name];
            if (!request) throw new Error(`INVALID_INPUT: no AI request ${name}`);
            const answer = await request(JSON.parse(json) as never, signal);
            if (signal.aborted) throw new Error('The AI request was cancelled');
            return unwrap(answer);
        });
    },
    attachmentDraftBegin(json: string): string {
        return submit(async () => validateNativeAttachmentDraftBegin(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentDraftValidateLineage(json: string): string {
        return submit(async () => validateNativeAttachmentDraftLineage(attachmentDraftJson(json)));
    },
    attachmentDraftPrepare(json: string): string {
        return submit(async () => prepareNativeAttachmentDraftAdd(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentDraftBeginV2(json: string): string {
        return submit(async () => validateNativeAttachmentDraftBeginV2(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentDraftValidateLineageV2(json: string): string {
        return submit(async () => validateNativeAttachmentDraftLineageV2(attachmentDraftJson(json)));
    },
    attachmentDraftPrepareV2(json: string): string {
        return submit(async () => prepareNativeAttachmentDraftAddV2(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentDraftBeginV3(json: string): string {
        return submit(async () => {
            const result = validateNativeAttachmentDraftBeginV3(attachmentDraftJson(json), attachmentDraftDependencies);
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS link-compatible attachment lineage validated',
                    context: { releaseCheck: 'v1.3.5/ios-attachment-link-lineage', outcome: 'validated' } }, { force: true });
            } catch { /* Diagnostics do not change validation or grant native ownership. */ }
            return result;
        });
    },
    attachmentDraftBeginV4(json: string): string {
        return submit(async () => {
            const result = validateNativeAttachmentDraftBeginV4(attachmentDraftJson(json), attachmentDraftDependencies);
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS link-compatible attachment lineage validated',
                    context: { releaseCheck: 'v1.3.5/ios-attachment-link-lineage', outcome: 'validated' } }, { force: true });
            } catch { /* Diagnostics do not change validation or grant native ownership. */ }
            return result;
        });
    },
    attachmentDraftBeginV5(json: string): string {
        return submit(async () => validateNativeAttachmentDraftBeginV5(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentDraftAvailabilityPreflight(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || isSandboxMode() || isWorkspaceTransitionActive()) {
                throw new Error('NOT_READY: Task attachment preparation is unavailable');
            }
            requireSaved();
            return prepareNativeTaskAttachmentAvailabilityPreflight(json);
        });
    },
    attachmentDraftPrepareAvailability(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return prepareNativeAttachmentDraftAvailability(attachmentDraftJson(json));
        });
    },
    iosTaskDraftPrepareAvailability(json: string, prepareSource: unknown): string {
        return submit(async (signal) => {
            const unavailable = () => new Error('NOT_READY: Task attachment preparation is unavailable');
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || !localAttachments || nativeSync
                || iosTaskAttachmentPreparation || iosProjectFilePreparation || iosCleanupCallback || iosForegroundFailure
                || typeof prepareSource !== 'function' || !globalThis.__mindwtrSyncSecrets
                || isSandboxMode() || isWorkspaceTransitionActive()) throw unavailable();
            requireSaved();
            const channels = nativeFileChannels();
            if (!channels) throw unavailable();
            let callback: ((metadataJSON: string, plaintextBase64: string) => string) | null = prepareSource as typeof callback;
            iosTaskAttachmentPreparation = true;
            try {
                return await prepareNativeTaskAttachmentAvailability(json, {
                    getLegacyValue: (name) => keyValue.get(name),
                    getSecret: (account) => (globalThis.__mindwtrSyncSecrets as HostSecrets).getSecret(account),
                    crypto: createHostSyncCrypto((globalThis as { __mindwtrCryptoCall?: Parameters<typeof createHostSyncCrypto>[0] }).__mindwtrCryptoCall),
                    prepareSource: (metadata, bytes) => {
                        if (!callback || signal.aborted) throw unavailable();
                        return callback(metadata, bytes);
                    },
                }, channels, signal);
            } finally { callback = null; iosTaskAttachmentPreparation = false; }
        });
    },
    iosProjectFilePrepareAvailability(json: string, prepareSource: unknown): string {
        return submit(async (signal) => {
            const unavailable = () => new Error('NOT_READY: Project download is unavailable');
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || !localAttachments || nativeSync
                || iosTaskAttachmentPreparation || iosProjectFilePreparation || iosCleanupCallback || iosForegroundFailure
                || typeof prepareSource !== 'function' || !globalThis.__mindwtrSyncSecrets
                || isSandboxMode() || isWorkspaceTransitionActive()) throw unavailable();
            requireSaved(); const channels = nativeFileChannels(); if (!channels) throw unavailable();
            let callback: ((metadataJSON: string, plaintextBase64: string) => string) | null = prepareSource as typeof callback;
            iosProjectFilePreparation = true;
            try {
                const result = await prepareNativeProjectFileAvailability(json, {
                    getLegacyValue: (name) => keyValue.get(name),
                    getSecret: (account) => (globalThis.__mindwtrSyncSecrets as HostSecrets).getSecret(account),
                    crypto: createHostSyncCrypto((globalThis as { __mindwtrCryptoCall?: Parameters<typeof createHostSyncCrypto>[0] }).__mindwtrCryptoCall),
                    prepareSource: (metadata, bytes) => {
                        if (!callback || signal.aborted) throw unavailable(); return callback(metadata, bytes);
                    },
                }, channels, signal);
                if (result.status === 'unavailable' || result.status === 'generation-conflict') {
                    const t = (key: string) => unwrap(contract.getStrings({ keys: [key] })).strings[key];
                    return { ...result, result: { status: result.status, message: getAttachmentResolutionMessage(result, t), update: null } };
                }
                return result;
            } finally { callback = null; iosProjectFilePreparation = false; }
        });
    },
    attachmentDraftValidateLineageV5(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return validateNativeAttachmentDraftLineageV5(attachmentDraftJson(json));
        });
    },
    attachmentDraftDiscardCandidatesV5(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return prepareNativeAttachmentDraftDiscardCandidatesV5(attachmentDraftJson(json));
        });
    },
    attachmentDraftValidateLineageV4(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return validateNativeAttachmentDraftLineageV4(attachmentDraftJson(json));
        });
    },
    attachmentDraftPrepareV4(json: string): string {
        return submit(async () => prepareNativeAttachmentDraftAddV4(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentDraftRemovePrepareV4(json: string): string {
        return submit(async () => prepareNativeAttachmentDraftRemoveV4(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentDraftDiscardCandidatesV4(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return prepareNativeAttachmentDraftDiscardCandidatesV4(attachmentDraftJson(json));
        });
    },
    attachmentDraftResultV4(json: string): string {
        return submit(async () => completeNativeAttachmentDraftAddV4(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentDraftValidateLineageV3(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return validateNativeAttachmentDraftLineageV3(attachmentDraftJson(json));
        });
    },
    /** Private read-only opening check; native retains the exact editor and sidecar owner. */
    attachmentDraftResumeCheckV3(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            requireSaved();
            return unwrap(await contract.checkOwnedTaskEditorResume(attachmentDraftJson(json)));
        });
    },
    attachmentDraftPrepareV3(json: string): string {
        return submit(async () => prepareNativeAttachmentDraftAddV3(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentDraftRemovePrepareV3(json: string): string {
        return submit(async () => prepareNativeAttachmentDraftRemoveV3(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentDraftValidateRemove(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return readNativeAttachmentDraftRemoveFrozen(attachmentDraftJson(json));
        });
    },
    attachmentDraftDiscardCandidates(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return prepareNativeAttachmentDraftDiscardCandidates(attachmentDraftJson(json));
        });
    },
    attachmentDraftDiscardCandidatesV3(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return prepareNativeAttachmentDraftDiscardCandidatesV3(attachmentDraftJson(json));
        });
    },
    /** Pure pre-hydration cleanup policy; only native callbacks carry physical authority. */
    attachmentCleanupPrepare(projectionJSON: string, candidateJSON: string): string {
        if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT');
        return JSON.stringify(prepareNativeAttachmentCleanupWitness(
            attachmentCleanupJson(projectionJSON, 16 * 1024 * 1024), attachmentCleanupJson(candidateJSON, 32 * 1024),
        ));
    },
    attachmentCleanupRetire(projectionJSON: string, witnessJSON: string,
        retainedCallback: () => string, retireCallback: () => string): string {
        if (globalThis.__mindwtrHostPlatform !== 'ios'
            || typeof retainedCallback !== 'function' || typeof retireCallback !== 'function') throw new Error('INVALID_INPUT');
        const eligible = isNativeAttachmentCleanupWitnessEligible(
            attachmentCleanupJson(projectionJSON, 16 * 1024 * 1024), attachmentCleanupJson(witnessJSON, 128 * 1024),
        );
        const result: unknown = eligible ? retireCallback() : retainedCallback();
        if (typeof result !== 'string' || result.length > 1024 || new TextEncoder().encode(result).byteLength > 1024) {
            throw new Error('INVALID_INPUT');
        }
        return result;
    },
    /** Private, synchronous final handoff; native passes ephemeral proof-bound callbacks. */
    attachmentDraftDiscardRetire(json: string, keepCallback: () => string, retireCallback: () => string): string {
        return retireAttachmentDiscard(json, keepCallback, retireCallback);
    },
    attachmentDraftDiscardRetireV5(json: string, keepCallback: () => string, retireCallback: () => string): string {
        return retireAttachmentDiscard(json, keepCallback, retireCallback, true);
    },
    attachmentDraftResult(json: string): string {
        return submit(async () => completeNativeAttachmentDraftAdd(attachmentDraftJson(json), attachmentDraftDependencies));
    },
    attachmentOwnedSavePrepare(json: string): string {
        return submit(async () => {
            requireOwnedAttachmentSave();
            requireSaved();
            return unwrap(await contract.prepareOwnedEditorFileAddTaskDraftSave(attachmentDraftJson(json) as Parameters<typeof contract.prepareOwnedEditorFileAddTaskDraftSave>[0]));
        });
    },
    attachmentOwnedSaveValidate(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return unwrap(contract.validatePreparedOwnedEditorFileAddTaskDraftSave(attachmentDraftJson(json) as Parameters<typeof contract.validatePreparedOwnedEditorFileAddTaskDraftSave>[0]));
        });
    },
    attachmentOwnedSaveCommit(json: string): string {
        return submit(async () => {
            requireOwnedAttachmentSave();
            return unwrap(await contract.commitPreparedOwnedEditorFileAddTaskDraftSave(attachmentDraftJson(json) as Parameters<typeof contract.commitPreparedOwnedEditorFileAddTaskDraftSave>[0]));
        });
    },
    attachmentFileEditSavePrepare(json: string): string {
        return submit(async () => {
            requireOwnedAttachmentSave();
            requireSaved();
            const input = attachmentDraftJson(json) as Parameters<typeof contract.prepareOwnedEditorFileEditTaskDraftSave>[0]
                | Parameters<typeof contract.prepareOwnedEditorCompleteTaskDraftSave>[0];
            if (input?.version === 2 || input?.version === 3 || input?.version === 4) return unwrap(await contract.prepareOwnedEditorCompleteTaskDraftSave(input));
            if (input?.version === 1) return unwrap(await contract.prepareOwnedEditorFileEditTaskDraftSave(input));
            throw new Error('INVALID_INPUT');
        });
    },
    attachmentFileEditSaveValidate(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Attachment draft capability is unavailable');
            return unwrap<Extract<ReturnType<typeof validateAttachmentFileEditSave>, { ok: true }>['value']>(
                validateAttachmentFileEditSave(attachmentDraftJson(json) as AttachmentFileEditSaveEnvelope));
        });
    },
    attachmentFileEditSaveCommit(json: string): string {
        return submit(async () => {
            requireOwnedAttachmentSave();
            const input = attachmentDraftJson(json) as AttachmentFileEditSaveEnvelope;
            if ((input?.request?.version === 2 || input?.request?.version === 3 || input?.request?.version === 4) && input.prepared?.version === input.request.version) return unwrap(await contract.commitPreparedOwnedEditorCompleteTaskDraftSave(input as Parameters<typeof contract.commitPreparedOwnedEditorCompleteTaskDraftSave>[0]));
            if (input?.request?.version === 1 && input.prepared?.version === 1) return unwrap(await contract.commitPreparedOwnedEditorFileEditTaskDraftSave(input as Parameters<typeof contract.commitPreparedOwnedEditorFileEditTaskDraftSave>[0]));
            throw new Error('INVALID_INPUT');
        });
    },
    /** Private synchronous Save handoff; no native retirement authority is supplied by JSON. */
    attachmentFileEditSaveRetire(json: string, referencedCallback: () => string, taskChangedCallback: () => string,
        retireCallback: () => string): string {
        return retireAttachmentFileEditSave(json, referencedCallback, taskChangedCallback, retireCallback);
    },
    /** Called only after the native private record and exact checkpoint are durable. */
    attachmentDraftAcknowledged(operation: string, outcome: string): string {
        return submit(async () => {
            const finishedDiscard = operation === 'discard-finish' && outcome === 'confirmed';
            const unstartedDiscard = operation === 'discard-unstarted' && outcome === 'confirmed';
            const removedDraft = operation === 'remove' && ['confirmed', 'replayed'].includes(outcome);
            const mixedSave = operation === 'mixed-save' && ['domainSaved', 'settled'].includes(outcome);
            const mixedDiscard = operation === 'discard-mixed' && outcome === 'confirmed';
            const mixedAdd = operation === 'add-mixed' && ['confirmed', 'replayed'].includes(outcome);
            const providerAdd = operation === 'provider-add' && outcome === 'confirmed';
            const photoAdd = operation === 'photo-add' && outcome === 'confirmed';
            const audioPlayback = operation === 'audio-playback' && outcome === 'started';
            const completeSave = operation === 'complete-save' && ['domainSaved', 'settled'].includes(outcome);
            const completeUndo = operation === 'complete-cancel-undo' && outcome === 'confirmed';
            const ownedResume = operation === 'owned-resume' && outcome === 'validated';
            const availabilityConsumer = operation === 'availability-resume' && outcome === 'validated'
                || operation === 'availability-save' && ['domainSaved', 'settled'].includes(outcome)
                || operation === 'availability-discard' && outcome === 'settled'
                || operation === 'availability-checkpoint' && outcome === 'confirmed';
            const webdavProjectDownload = operation === 'webdav-project-download' && ['saved', 'unrecoverable', 'noop', 'abandoned', 'refused', 'cleanup-pending', 'decrypted'].includes(outcome);
            const projectDownload = webdavProjectDownload || operation === 'selfhosted-project-download' && ['saved', 'abandoned', 'refused', 'cleanup-pending', 'decrypted'].includes(outcome);
            const webdavTaskAvailability = operation === 'webdav-task-availability' && ['confirmed', 'source-retired'].includes(outcome);
            const taskDownloadMaterial = operation === 'task-download-material' && outcome === 'decrypted';
            const selfHostedAvailability = webdavTaskAvailability || ['selfhosted-task-availability', 'selfhosted-project-availability'].includes(operation) && outcome === 'confirmed';
            const preexistingReplay = operation === 'preexisting-journal-replay' && outcome === 'confirmed';
            const containerRecovery = operation === 'container-relocation' && outcome === 'confirmed';
            const fileOpen = operation === 'file-open' && outcome === 'prepared';
            const projectFileOpen = operation === 'project-file-open' && outcome === 'prepared';
            const relocatedOpen = ['relocated-task-file-open', 'relocated-project-file-open'].includes(operation) && outcome === 'prepared';
            const relocatedAvailability = operation === 'relocated-task-availability' && outcome === 'confirmed';
            const relocatedProjectAvailability = operation === 'relocated-project-availability' && outcome === 'confirmed';
            const cachedProjectAvailability = operation === 'cached-project-availability' && outcome === 'confirmed';
            const projectFileRemove = operation === 'project-file-remove' && outcome === 'saved';
            const projectFileAdd = operation === 'project-file-add' && ['saved', 'abandoned'].includes(outcome);
            const projectFileHash = operation === 'project-file-hash' && outcome === 'saved';
            const taskFileHash = operation === 'task-file-hash' && outcome === 'saved';
            const ownedCleanup = operation === 'cleanup-owned-retirement' && ['removed', 'absent', 'retained'].includes(outcome);
            const editorAcknowledged = ['editor-add', 'editor-remove', 'editor-save', 'editor-discard', 'editor-recover'].includes(operation) && outcome === 'confirmed';
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments && !finishedDiscard && !unstartedDiscard && !removedDraft && !mixedSave && !mixedDiscard && !mixedAdd && !providerAdd && !photoAdd && !audioPlayback && !completeSave && !completeUndo && !ownedResume && !editorAcknowledged && !preexistingReplay && !containerRecovery && !fileOpen && !projectFileOpen && !relocatedOpen && !relocatedAvailability && !relocatedProjectAvailability && !cachedProjectAvailability && !projectFileRemove && !projectFileAdd && !projectFileHash && !taskFileHash && !ownedCleanup && !availabilityConsumer && !selfHostedAvailability && !projectDownload && !taskDownloadMaterial
                || !(['add', 'checkpoint', 'save'].includes(operation) && ['confirmed', 'replayed'].includes(outcome)
                    || operation === 'discard' && outcome === 'retained'
                    || operation === 'discard-capacity' && outcome === 'confirmed' || finishedDiscard || unstartedDiscard || removedDraft || mixedSave || mixedDiscard || mixedAdd || providerAdd || photoAdd || audioPlayback || completeSave || completeUndo || ownedResume || editorAcknowledged || preexistingReplay || containerRecovery || fileOpen || projectFileOpen || relocatedOpen || relocatedAvailability || relocatedProjectAvailability || cachedProjectAvailability || projectFileRemove || projectFileAdd || projectFileHash || taskFileHash || ownedCleanup || availabilityConsumer || selfHostedAvailability || projectDownload || taskDownloadMaterial)) return {};
            try {
                if (completeSave && outcome === 'domainSaved') await diagnosticsLog.append({
                    ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS owned raw row Save acknowledged',
                    context: { releaseCheck: 'v1.3.5/ios-owned-raw-row-save', operation, outcome },
                }, { force: true });
            } catch { /* Keep the existing acknowledgment independent of this extra marker. */ }
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS attachment draft acknowledged',
                    context: { ...(editorAcknowledged ? { releaseCheck: 'v1.3.5/ios-editor-owned-attachments' }
                        : webdavProjectDownload ? { releaseCheck: 'v1.3.5/ios-webdav-project-download' }
                        : projectDownload ? { releaseCheck: 'v1.3.5/ios-selfhosted-project-download' }
                        : taskDownloadMaterial ? { releaseCheck: 'v1.3.5/ios-task-download-material' }
                        : webdavTaskAvailability ? { releaseCheck: 'v1.3.5/ios-webdav-task-availability' }
                        : selfHostedAvailability ? { releaseCheck: 'v1.3.5/ios-selfhosted-file-availability' }
                        : availabilityConsumer ? { releaseCheck: 'v1.3.5/ios-task-availability-consumers' }
                        : ownedCleanup ? { releaseCheck: 'v1.3.5/ios-cleanup-owned-retirement' }
                        : fileOpen ? { releaseCheck: 'v1.3.5/ios-local-file-open' }
                        : projectFileOpen ? { releaseCheck: 'v1.3.5/ios-project-local-file-open' }
                        : relocatedOpen ? { releaseCheck: 'v1.3.5/ios-relocated-file-open', surface: operation === 'relocated-task-file-open' ? 'task' : 'project' }
                        : relocatedAvailability ? { releaseCheck: 'v1.3.5/ios-relocated-task-availability' }
                        : relocatedProjectAvailability ? { releaseCheck: 'v1.3.5/ios-relocated-project-availability' }
                        : cachedProjectAvailability ? { releaseCheck: 'v1.3.5/ios-cached-project-availability' }
                        : projectFileRemove ? { releaseCheck: 'v1.3.5/ios-project-file-remove' }
                        : projectFileAdd ? { releaseCheck: 'v1.3.5/ios-project-file-add' }
                        : projectFileHash ? { releaseCheck: 'v1.3.5/ios-project-file-hash' }
                        : taskFileHash ? { releaseCheck: 'v1.3.5/ios-task-file-hash' }
                        : containerRecovery ? { releaseCheck: 'v1.3.5/ios-attachment-container-recovery' }
                        : preexistingReplay ? { releaseCheck: 'v1.3.5/ios-preexisting-attachment-journal-replay' }
                        : ownedResume ? { releaseCheck: 'v1.3.5/ios-owned-editor-resume' }
                        : completeSave || completeUndo ? { releaseCheck: 'v1.3.5/ios-attachment-complete-save' }
                        : audioPlayback ? { releaseCheck: 'v1.3.5/ios-task-audio-playback' }
                        : photoAdd ? { releaseCheck: 'v1.3.5/ios-task-photo-add' }
                        : providerAdd ? { releaseCheck: 'v1.3.5/ios-attachment-provider-add' }
                        : mixedAdd ? { releaseCheck: 'v1.3.5/ios-attachment-mixed-add' }
                        : mixedDiscard ? { releaseCheck: 'v1.3.5/ios-attachment-mixed-discard' }
                        : mixedSave ? { releaseCheck: 'v1.3.5/ios-attachment-mixed-save' }
                        : removedDraft ? { releaseCheck: 'v1.3.5/ios-attachment-draft-remove' }
                        : operation === 'save' ? { releaseCheck: 'v1.3.5/ios-attachment-owned-save' }
                        : finishedDiscard ? { releaseCheck: 'v1.3.5/ios-owned-discard-finish' }
                            : unstartedDiscard ? { releaseCheck: 'v1.3.5/ios-unstarted-add-discard' }
                                : operation === 'discard-capacity' ? { releaseCheck: 'v1.3.5/ios-owned-discard-capacity' }
                                    : { releaseCheck: 'v1.3.4/ios-attachment-draft-owned' }), operation: editorAcknowledged ? operation.slice('editor-'.length) : operation, outcome } }, { force: true });
            } catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            return {};
        });
    },
    /** `name` is one of ATTACHMENT_REQUESTS; `json` is that call's input. It writes no journaled command. */
    attachmentRequest(name: string, json: string): string {
        return submit(async () => {
            requireSaved();
            if (localAttachments && !LOCAL_ATTACHMENT_REQUESTS.has(name)) {
                throw new Error('INVALID_INPUT: Only task local attachment operations run here');
            }
            const request = ATTACHMENT_REQUESTS[name];
            if (!request) throw new Error(`INVALID_INPUT: no attachment request ${name}`);
            const input = JSON.parse(json) as never;
            if (localAttachments && (!LOCAL_ATTACHMENT_REQUESTS.has(name)
                || (name !== 'settleTaskDraftAttachments' && (input as { owner?: { kind?: unknown } } | null)?.owner?.kind !== 'task'))) {
                throw new Error('INVALID_INPUT: Only task local attachment operations run here');
            }
            if (localAttachments && (name === 'draftAddFile' || name === 'draftRemove')) {
                const owner = (input as { owner: { taskId: string } }).owner;
                const view = unwrap(contract.getTaskView({ id: owner.taskId }));
                if (view.readOnly) throw new Error('INVALID_INPUT: Task draft attachments cannot be edited');
            }
            const answer = unwrap(await request(input));
            if (localAttachments && LOCAL_ATTACHMENT_REQUESTS.has(name)
                && (answer as { kind?: string })?.kind !== 'refused' && (answer as { kind?: string })?.kind !== 'blocked'
                && (name !== 'openAttachment' || (answer as { status?: string })?.status === 'available')) {
                try {
                    await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios', message: 'Native iOS local attachment operation completed',
                        context: { releaseCheck: 'v1.3.4/ios-local-attachment-host', operation: name, outcome: 'completed' } }, { force: true });
                } catch { /* an acknowledged local operation cannot fail on its diagnostic */ }
            }
            return answer;
        });
    },
    /**
     * Operation `idText` is no longer wanted (CoreHost.cancel: an AI request whose input changed, whose screen closed, or whose
     * caller stopped waiting): its signal fires, so its provider call stops. Unlike cancel, no other host call is refused.
     */
    abort(idText: string): null {
        pending.get(Number(idText))?.controller.abort(Object.assign(new Error('The AI request was cancelled'), { name: 'AbortError' }));
        return null;
    },
    /** Debug builds only: runNetCheck against check-net-device.mjs's server on `port`. */
    netCheck(port: string): string {
        return submit(async () => runNetCheck(port));
    },
    /** Debug builds only: runNetDeadline, which CoreHost runs past a short deadline. */
    netDeadline(port: string, mode: string): string {
        return submit(async (signal) => runNetDeadline(port, mode, signal));
    },
    /**
     * CoreHost's deadline for operation `idText` passed: every open fetch rejects and new host calls are refused (until
     * CoreHost resumes them), and the operation's signal fires, so it can drain before the host reports the failure.
     */
    cancel(idText: string): null {
        (globalThis.__cancelHostCalls as (message: string) => void)('The host operation timed out');
        pending.get(Number(idText))?.controller.abort(Object.assign(new Error('The host operation timed out'), { name: 'AbortError' }));
        return null;
    },
    iosAboutUpdateState(): string {
        return submit(async (signal) => {
            const adapter = bootAdapter;
            const assertReady = () => {
                if (signal.aborted) throw new Error('CANCELLED: About update state read was cancelled');
                if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
                    || getStorageAdapter() !== adapter || isSandboxMode() || isWorkspaceTransitionActive()) {
                    throw new Error('NOT_READY: About update state is unavailable');
                }
                requireSaved();
                if (!contract.getDataSettings().ok) throw new Error('NOT_READY: About update state is unavailable');
            };
            assertReady();
            const values = await keyValue.multiGet([UPDATE_BADGE_AVAILABLE_KEY, UPDATE_BADGE_LAST_CHECK_KEY, UPDATE_BADGE_LATEST_KEY]);
            assertReady();
            return { updateAvailable: values[0][1] === 'true', shouldCheck: shouldCheckForAppUpdate(values[1][1]) };
        });
    },
    /** The native storage owner calls this only after an acknowledged fixed update-state mutation. */
    iosAboutUpdateStateAcknowledged(outcome: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !['check-saved', 'badge-saved'].includes(outcome)) return {};
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS About update state saved',
                    context: { releaseCheck: 'v1.3.5/ios-about-update-state', outcome },
                }, { force: true });
            } catch { /* Diagnostics cannot change an acknowledged storage result. */ }
            return {};
        });
    },
    /** Read-only About lookup; the native invocation still owns HTTP admission. */
    iosAboutAppStoreInfo(bundleIdentifier: string, currentVersion: string): string {
        return submit(async (signal) => {
            const unavailable = () => new Error('NOT_READY: App Store lookup is unavailable');
            const cancelled = () => new Error('CANCELLED: App Store lookup was cancelled');
            const adapter = bootAdapter;
            const assertReady = () => {
                if (signal.aborted) throw cancelled();
                if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
                    || getStorageAdapter() !== adapter || isSandboxMode() || isWorkspaceTransitionActive()) throw unavailable();
                requireSaved();
                if (!contract.getDataSettings().ok) throw unavailable();
            };
            assertReady();
            if (typeof bundleIdentifier !== 'string' || bundleIdentifier.length > 255
                || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleIdentifier)) {
                throw new Error('INVALID_INPUT: Invalid App Store bundle identifier');
            }
            if (typeof currentVersion !== 'string' || currentVersion.length > 200 || !currentVersion.trim()
                || [...currentVersion].some((character) => {
                    const code = character.charCodeAt(0);
                    return code < 32 || code >= 127 && code <= 159;
                })) {
                throw new Error('INVALID_INPUT: Invalid installed app version');
            }
            try {
                const info = await fetchAppStoreInfo(bundleIdentifier, async (input, init) => {
                    assertReady();
                    const response = await globalThis.fetch(input, { ...init, signal });
                    assertReady();
                    return response;
                });
                assertReady();
                const result = { ...info, updateAvailable: compareAppVersions(info.version, currentVersion) > 0 };
                try {
                    await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                        message: 'Native iOS App Store information fetched',
                        context: { releaseCheck: 'v1.3.5/ios-about-app-store', outcome: 'fetched' },
                    }, { force: true });
                } catch { /* Diagnostics cannot change the lookup result. */ }
                assertReady();
                return result;
            } catch {
                assertReady();
                throw new Error('LOOKUP_FAILED: App Store lookup could not be completed');
            }
        });
    },
    /** Only CoreHost.foregroundSync supplies this invocation-scoped physical cleanup callback. */
    iosForegroundSync(name: string, json: string, cleanup: unknown, currentTargetURI?: unknown): string {
        return submit(async () => {
            if (iosForegroundFailure) throw iosForegroundFailure;
            const unavailable = () => new Error('NOT_READY: Foreground sync is unavailable');
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments || nativeSync || !bootAdapter
                || iosCleanupCallback || iosTaskAttachmentPreparation || iosProjectFilePreparation || typeof cleanup !== 'function' || isSandboxMode() || isWorkspaceTransitionActive()
                || typeof native().kvMultiGet !== 'function' || !globalThis.__mindwtrSyncSecrets) throw unavailable();
            const commands = ['syncSettings', 'openSyncSettings', 'closeSyncSettings', 'selectSyncBackend',
                'saveSyncBackend', 'syncNow', 'testSyncConnection', 'syncStored', 'syncResume', 'projectAttachmentDownload', 'runSyncEncryptionAction'];
            if (currentTargetURI !== undefined && (name !== 'projectAttachmentDownload' || typeof currentTargetURI !== 'string'
                || !currentTargetURI.startsWith('file:///') || currentTargetURI.length > 16_384 || !currentTargetURI.includes('/'))) {
                throw new Error('INVALID_INPUT: Invalid selected Project availability target');
            }
            if (!commands.includes(name) || typeof json !== 'string' || new TextEncoder().encode(json).byteLength > 128 * 1024) {
                throw new Error('INVALID_INPUT: Invalid foreground sync request');
            }
            let input: Record<string, unknown>;
            try { input = JSON.parse(json) as Record<string, unknown>; }
            catch { throw new Error('INVALID_INPUT: Invalid foreground sync request'); }
            if (!input || typeof input !== 'object' || Array.isArray(input)
                || ['syncStored', 'syncResume'].includes(name) && Object.keys(input).length !== 0) throw new Error('INVALID_INPUT: Invalid foreground sync request');
            if (name === 'projectAttachmentDownload' && (Object.keys(input).length !== 3
                || ['projectId', 'attachmentId', 'revision'].some((field) => {
                    const value = input[field];
                    return typeof value !== 'string' || !value || value.length > (field === 'revision' ? 200 : 500);
                }))) throw new Error('INVALID_INPUT: Invalid Project attachment download request');
            if (name === 'runSyncEncryptionAction') {
                const action = input.action;
                const invalid = () => new Error('INVALID_INPUT: Invalid selected encryption request');
                if (!action || typeof action !== 'object' || Array.isArray(action)
                    || typeof input.revision !== 'string' || !input.revision || input.revision.length > 100) throw invalid();
                const target = action as Record<string, unknown>;
                const needsRequest = target.type === 'submit' || target.type === 'decline' || target.type === 'recheck';
                if (Object.keys(input).length !== (needsRequest ? 3 : 2)
                    || needsRequest && (typeof input.requestId !== 'string' || !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(input.requestId))
                    || !needsRequest && input.requestId !== undefined) throw invalid();
                const valid = target.type === 'open' || target.type === 'submit'
                    ? Object.keys(target).length === 2 && ['unlock', 'enable', 'change', 'disable', 'abandon'].includes(target.flow as string)
                    : target.type === 'typed' ? Object.keys(target).length === 3 && ['current', 'next', 'confirm'].includes(target.field as string)
                        && typeof target.value === 'string' && target.value.length <= 1000
                        : ['cancel', 'decline', 'retry', 'recheck'].includes(target.type as string) && Object.keys(target).length === 1;
                if (!valid) throw invalid();
            }
            const refused = { ok: false as const, error: { code: 'ACTION_FAILED' as const,
                message: 'This sync provider is not available in native iOS yet; the stored configuration is unchanged' } };
            if (name === 'selectSyncBackend' && !['off', 'webdav', 'selfhosted'].includes(input.option as string)) return refused;
            if (['saveSyncBackend', 'syncNow', 'testSyncConnection'].includes(name)) {
                const webdav = input.webdav;
                const selfHosted = input.selfHosted;
                const fields = webdav !== undefined ? webdav : selfHosted;
                const self = selfHosted !== undefined;
                if ((webdav !== undefined) === self || !fields || typeof fields !== 'object' || Array.isArray(fields)) {
                    throw new Error('INVALID_INPUT: Exactly one foreground sync form is required');
                }
                const form = fields as Record<string, unknown>;
                const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
                if (Object.keys(form).some((field) => !(self ? ['url', 'token', 'allowInsecureHttp'] : ['url', 'username', 'password', 'allowInsecureHttp']).includes(field))
                    || !text(form.url, 2000) || typeof form.allowInsecureHttp !== 'boolean'
                    || (self ? form.token !== null && !text(form.token, 2000)
                        : !text(form.username, 500) || form.password !== null && !text(form.password, 2000))) {
                    throw new Error('INVALID_INPUT: Invalid foreground sync form fields');
                }
            }
            requireSaved();
            const persistence = getPersistenceStatus();
            if (persistence.failed || persistence.queued || persistence.inFlight || persistence.immediate || persistence.retrying) throw unavailable();
            iosCleanupCallback = cleanup as (requestJSON: string) => unknown;
            try {
                const stored = (await keyValue.get(SYNC_BACKEND_KEY))?.trim();
                const selfHosted = stored === 'cloud' && isNativeIosSelfHostedProvider(await keyValue.get(CLOUD_PROVIDER_KEY));
                if (stored && stored !== 'off' && stored !== 'webdav' && !selfHosted) return refused;
                if (['syncStored', 'syncResume'].includes(name) && stored !== 'webdav' && !selfHosted) return { ok: true as const, value: { success: true, skipped: true } };
                if (name === 'projectAttachmentDownload' && stored !== 'webdav' && !selfHosted) return refused;
                // Only native-owned relocated repair is admitted for cloud Projects.
                if (name === 'projectAttachmentDownload' && selfHosted && typeof currentTargetURI !== 'string') return refused;
                if (name === 'runSyncEncryptionAction' && selfHosted) return refused;
                let downloadResult: Awaited<ReturnType<typeof contract.downloadAttachment>> | null = null;
                if (name === 'projectAttachmentDownload') {
                    const options = contract.getProjectAttachmentEditOptions({ projectId: input.projectId as string });
                    if (!options.ok) downloadResult = options;
                    else {
                        const matches = (options.value.project.attachments ?? []).filter((item) => item.id === input.attachmentId);
                        if (options.value.revision !== input.revision || matches.length !== 1
                            || matches[0].kind !== 'file' || matches[0].deletedAt) downloadResult = {
                            ok: false, error: { code: 'STALE_REVISION', message: 'Project attachment changed; read the list again' },
                        };
                    }
                }
                if (!downloadResult) iosManualSync ??= createNativeSync({ ...nativeSyncBindings, emit: () => {}, trace: () => {}, scheduleBackgroundSync: () => {},
                    retireLocalAttachment: async (attachmentID, targetURI, keep) => {
                        if (keep()) return false;
                        const requestID = generateUUID();
                        try {
                            if (!iosCleanupCallback) throw new NativeAttachmentCleanupUnconfirmedError();
                            const reply = iosCleanupCallback(JSON.stringify({ version: 1, requestID, attachmentID, targetURI }));
                            if (typeof reply !== 'string' || new TextEncoder().encode(reply).byteLength > 1024) throw new Error();
                            const result = JSON.parse(reply) as Record<string, unknown>;
                            if (!result || typeof result !== 'object' || Array.isArray(result)
                                || Object.keys(result).length !== 3 || result.version !== 1 || result.requestID !== requestID
                                || !['removed', 'absent', 'retained'].includes(result.outcome as string)) throw new Error();
                            return result.outcome !== 'retained';
                        } catch { throw new NativeAttachmentCleanupUnconfirmedError(); }
                    },
                });
                if (iosManualSync) iosManualSync.settingsHost.encryption.mode = 'saved-webdav-or-local';
                if (name === 'selectSyncBackend' && input.option === 'selfhosted'
                    || ['saveSyncBackend', 'syncNow', 'testSyncConnection'].includes(name) && input.selfHosted !== undefined
                    || ['syncStored', 'syncResume', 'projectAttachmentDownload'].includes(name) && selfHosted) {
                    try { await iosManualSync!.assertSelfHostedSyncAdmission(); }
                    catch (error) {
                        if (error instanceof NativeAttachmentCleanupUnconfirmedError) throw error;
                        return { ok: false as const, error: { code: 'ACTION_FAILED' as const,
                            message: error instanceof Error ? error.message : 'Self-hosted encryption admission is unavailable' } };
                    }
                }
                if (name === 'projectAttachmentDownload') {
                    if (!downloadResult) {
                        // The original contract remains local-only outside this owned call.
                        if (selfHosted) {
                            const channels = nativeFileChannels();
                            if (!channels) throw unavailable();
                            iosSelfHostedProjectAttachments = createNativeReadOnlySelfHostedAttachments({
                                getConfigValue: (name) => keyValue.get(name), getLegacyValue: (name) => keyValue.get(name),
                                getSecret: (account) => (globalThis.__mindwtrSyncSecrets as HostSecrets).getSecret(account),
                                crypto: createHostSyncCrypto((globalThis as { __mindwtrCryptoCall?: Parameters<typeof createHostSyncCrypto>[0] }).__mindwtrCryptoCall),
                            }, channels);
                        }
                        iosProjectAttachmentDownload = true;
                        try {
                            if (typeof currentTargetURI === 'string') {
                                iosRelocatedProjectAvailability = true;
                                downloadResult = await contract.downloadRelocatedProjectAttachment({ projectId: input.projectId as string,
                                    attachmentId: input.attachmentId as string, revision: input.revision as string,
                                    managedDirectoryURI: currentTargetURI.slice(0, currentTargetURI.lastIndexOf('/') + 1) }, currentTargetURI);
                            } else downloadResult = await contract.downloadAttachment({
                                owner: { kind: 'project', projectId: input.projectId as string }, attachmentId: input.attachmentId as string,
                            });
                        } finally { iosProjectAttachmentDownload = false; iosRelocatedProjectAvailability = false; iosSelfHostedProjectAttachments = null; }
                    }
                    await flushPendingSave();
                    requireSaved();
                    const after = getPersistenceStatus();
                    if (after.failed || after.queued || after.inFlight || after.immediate || after.retrying) throw unavailable();
                }
                let storedResult: { success: boolean; skipped: boolean } | null = null;
                if (name === 'syncStored' || name === 'syncResume') {
                    const answer = await iosManualSync!.performStoredAutomaticSync(name === 'syncStored' ? 'startup' : 'resume');
                    await flushPendingSave();
                    requireSaved();
                    const after = getPersistenceStatus();
                    if (after.failed || after.queued || after.inFlight || after.immediate || after.retrying) throw unavailable();
                    storedResult = { success: answer.success === true, skipped: Boolean(answer.skipped) };
                }
                const result = downloadResult ?? (storedResult ? { ok: true as const, value: storedResult }
                    : name === 'syncSettings' ? contract.getSyncSettings(input)
                    : await MENU_COMMANDS[name as SyncScreenCommand](input as never));
                // Offer only the providers admitted by this entry; all labels and field policy remain core's.
                if (result.ok && result.value && typeof result.value === 'object' && 'backend' in result.value) {
                    // The command union includes non-view replies; only the two view commands reach this branch.
                    if (name === 'syncSettings' || name === 'openSyncSettings') {
                        const model = result.value as import('../../../packages/core/src/native-host-contract-settings-sync').NativeSyncSettings;
                        model.backend.options = model.backend.options.filter(({ option }) => option === 'off' || option === 'webdav' || option === 'selfhosted');
                    }
                }
                if (currentTargetURI === undefined && (name !== 'projectAttachmentDownload' || result.ok && result.value && typeof result.value === 'object'
                    && 'status' in result.value && result.value.status === 'available')) try {
                    const diagnostic = name === 'projectAttachmentDownload' ? { message: 'Native iOS Project file availability settled', releaseCheck: 'v1.3.5/ios-project-file-download' }
                        : name === 'syncStored' ? { message: 'Native iOS stored Sync command settled', releaseCheck: 'v1.3.5/ios-stored-sync' }
                        : name === 'syncResume' ? { message: 'Native iOS resume Sync command settled', releaseCheck: 'v1.3.5/ios-resume-sync' }
                        : { message: 'Native iOS foreground Sync command settled', releaseCheck: 'v1.3.5/ios-foreground-sync-owned' };
                    await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                        message: diagnostic.message,
                        context: { releaseCheck: diagnostic.releaseCheck, operation: name, outcome: name === 'projectAttachmentDownload' ? 'available' : 'settled' },
                    }, { force: true });
                } catch { /* A diagnostic cannot change the settled command result. */ }
                return result;
            } catch (error) {
                if (error instanceof NativeAttachmentCleanupUnconfirmedError) iosForegroundFailure = error;
                throw error;
            } finally { iosCleanupCallback = null; }
        });
    },
    /** `name` is one of MENU_COMMANDS; `json` is that command's input. Its request or capture UUID makes a retry exact. */
    menuCommand(name: string, json: string): string {
        return submit(async () => {
            const command = MENU_COMMANDS[name as MenuCommand];
            if (!command) throw new Error(`INVALID_INPUT: no menu command ${name}`);
            return taskResult(name as MenuCommand, await command(JSON.parse(json) as never));
        });
    },
};

if (globalThis.__mindwtrIntlCheck === true) {
    try { runIntlCheck(); } catch (error) { native().log(`Native Android intl check failed: ${error instanceof Error ? error.message : String(error)}`); }
}
// Closes the bundle's init section, opened at the end of host-polyfills.js.
native().trace?.('');
