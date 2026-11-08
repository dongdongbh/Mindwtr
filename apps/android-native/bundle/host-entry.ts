import { exact, record, isNativeJsonWithinBytes } from '../../../packages/core/src/native-json';
import { readNativeIosDropboxConfiguration, type NativeIosDropboxCapability } from './host-ios-dropbox';
import { createNativeGmail } from './host-gmail';
import { discoverNativeAITextModels, discoverNativeVoiceModels } from '../../../packages/core/src/native-ai-model-discovery';
import { readNativeAIExtraBodyInput } from '../../../packages/core/src/native-host-contract-ai';
import { readWatchOpenAIRuntime, buildWatchOpenAITranscription, decodeWatchOpenAITranscription, buildWatchOpenAIParse, decodeWatchOpenAIParse } from './ios-watch-openai';
import { ingestIOSWatchBatch, readIOSWatchBatchOutcome, ingestIOSWatchAudio, readIOSWatchAudioOutcome, readIOSWatchAudioNeedsTranscript } from './ios-watch-ingest';
import { createNativeShareCaptureMethods } from '../../../packages/core/src/native-share-capture';
import { readIOSShareCaptureDraft } from './ios-share-capture';
import {
    DEFAULT_GLOBAL_SEARCH_FILTERS,
    getOnboardingGuideUrl,
    ONBOARDING_TOPIC_COPY,
    formatOpenAIExtraBodyParams,
    getSelectedMobileWhisperModel,
    normalizeSpeechLanguage,
    WHISPER_MODEL_BASE_URLS,
    buildNativePomodoroPanel,
    buildWatchApplicationContext,
    WATCH_FOCUS_TASK_LIMIT,
    createPomodoroState,
    sanitizePomodoroDurations,
    isTaskActionable,
    isTaskCancelled,
    readNativePomodoroPresentation,
    NativeReceiptSqliteAdapter,
    warmTaskRowEntries,
    PENDING_CAPTURES_DIRECTORY,
    PENDING_CAPTURE_LAST_APPLIED_STORAGE_KEY,
    NATIVE_HOST_CONTRACT_VERSION,
    NativeAttachmentCleanupUnconfirmedError,
    CLOUD_PROVIDER_KEY,
    SYNC_BACKEND_KEY,
    generateUUID,
    NATIVE_REMINDER_STATE_STORAGE_KEY,
    PERSISTENT_CAPTURE_STORAGE_KEY,
    REMINDER_ALARM_MAP_STORAGE_KEY,
    REMINDER_NOTIFICATION_CHANNEL_NAME,
    REMINDER_STORE_RESCHEDULE_DELAY_MS,
    shouldRescheduleReminderAlarms,
    nameNotifyListener,
    STATUS_COLORS_BY_THEME,
    type SqliteAdapter,
    getTaskPriorityColors,
    consoleLogger,
    createDiagnosticsLog,
    createFeedbackDiagnosticsBuffer,
    buildFeedbackDiagnostics,
    buildFeedbackSubmissionPayload,
    buildDiagnosticsLogEntry,
    submitFeedbackSubmission,
    FEEDBACK_CATEGORIES,
    feedbackDiagnosticEntry,
    getBreadcrumbs,
    sanitizeSavedFeedbackLog,
    buildFeedbackDiagnosticsSnapshot,
    buildImmediateNotificationDetails,
    buildShortcutsSnapshot,
    createWidgetPayloadProjection,
    createPublishedWidgetProjection,
    iosWidgetProjectionOptions,
    IOS_WIDGET_FAMILY_CACHE_ITEMS,
    getFocusWidgetFilter,
    setFocusWidgetFilter,
    type NativeFocusView,
    focusWidgetFilterKey,
    buildNativeBackupDocumentFailure,
    buildNativeBackupDocumentResult,
    buildNativeBackupSnapshotRestoreConfirmation,
    buildNativeBackupNoUndoConfirmation,
    commitNativeBackupDocument,
    holdNativeBackupUndoAttachments,
    inspectNativeBackupDocument,
    prepareNativeBackupDocument,
    readNativeBackupDocumentOutcome,
    sortRecoverySnapshotNames,
    serializeBackupData,
    validateMergedSyncData,
    type AppData,
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
    createDeviceCalendarSettingsMethods,
    createCalendarSubscriptionSettingsMethods,
    createCalendarSubscriptionAddMethods,
    buildCalendarSubscriptionSettingsModel,
    diagnosticsEntryFromLogPayload,
    getGeneralSettingsDeviceWrites,
    getPersistenceStatus,
    runSerializedSyncDocumentWriteOperation,
    setStorageTimeoutMs,
    getStorageTimeoutMs,
    getNextFutureStartRevealAt,
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
    buildLastRouteSnapshot,
    LAST_ROUTE_STORAGE_KEY,
    parseRestorableLastRoute,
    isEntityOpenUrl,
    parseEntityOpenUrl,
    resolveEntityOpenTarget,
    resolveMobileAppLockRelockDelayMinutes,
    isWorkspaceTransitionActive,
    legacyImportMismatch,
    assertNativeLegacyBackupSafe,
    countSqliteCopyRepairs,
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
    type FeedbackMetadata,
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
import { countTasksForIconBadge } from '../../../packages/core/src/task-icon-badge';
import { syncPassphraseBytes } from '../../../packages/core/src/sync-crypto';
import { createNativeAbout } from './host-about';
import { createNativeAppSearch, type AppSearchCall } from './host-app-search';
import { createNativeAI } from './host-ai';
import { createIOSTaskAI } from './host-ios-task-ai';
import { createIOSInboxAI } from './host-ios-inbox-ai';
import { createIOSReviewAI } from './host-ios-review-ai';
import { isAIKeyRequired } from '../../../packages/core/src/ai-config';
import type { NativeAIHost } from '../../../packages/core/src/native-host-contract-ai';
import { createIOSCalendarHost, type CalendarCall } from '../../ios-native/bundle/host-calendar';
import { createNativeCloudKitRecords } from '../../ios-native/bundle/host-cloudkit';
import { createNativeCloudKitAssets, type NativeCloudKitTransportCall } from '../../ios-native/bundle/host-cloudkit-assets';
import type { NativeCalendarPushLifecycle } from '../../../packages/core/src/native-host-contract-settings-calendar';
import { createCalendarFeeds, createNativeCalendar } from './host-calendar';
import { createNativeVoice, managedAttachmentsDirectory, persistIntoManagedStorage, type VoiceCaptureLine } from './host-voice';
import { createWidgetAudioPort } from './host-widget-audio';
import { createAIKeyStore } from '../../../packages/core/src/ai-config';
import { createSyncSecretVault } from '../../../packages/core/src/sync-secret-storage';
import { createNativeLocalAttachmentsForHost, nativeFileChannels, prepareNativeTaskAttachmentAvailabilityPreflight,
    prepareNativeTaskAttachmentAvailability, nativeTaskAttachmentPreparationUsesCloudKit, prepareNativeProjectFileAvailability, nativeProjectFileAvailabilityInitialURL,
    createNativeReadOnlySelfHostedAttachments, assertNativeSelfHostedAttachmentEncryptionAdmission } from './host-attachments';
import { PROJECT_SQLITE_COLUMNS } from '../../../packages/core/src/project-sync-schema';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from '../../../packages/core/src/task-sync-schema';
import { normalizeTaskForLoad } from '../../../packages/core/src/task-status';
import { hasRawReadRow, rawReadRow } from '../../../packages/core/src/sqlite-raw-snapshot';
import { taskEditValuesEqual } from '../../../packages/core/src/json-value-equality';
import { ensureDeviceId, stripSensitiveSettings } from '../../../packages/core/src/store-helpers';
import { resolveDefaultNewTaskAreaId } from '../../../packages/core/src/area-utils';
import { getTaskReminderDefault } from '../../../packages/core/src/task-reminder-policy';
import { classifyAppleReminderForImport, normalizeAppleRemindersImportSettings } from '../../../packages/core/src/apple-reminders-import-model';
import { prepareNativeAppleReminderImportItem, validatePreparedNativeAppleReminderImportItem,
    type NativeAppleReminderImportRequest } from '../../../packages/core/src/native-apple-reminders-import-item';
import { createNativeAppleReminderImportOwner } from '../../../packages/core/src/native-apple-reminders-import-owner';
import { nativePomodoroOwedTaskIds, prepareNativePomodoroTransition, validatePreparedNativePomodoroTransition,
    MAX_NATIVE_POMODORO_PLAN_BYTES, parseNativeWatchPomodoroSource, type NativePomodoroRequest } from '../../../packages/core/src/native-pomodoro-session';
import { NativePomodoroTransitionRefusal } from '../../../packages/core/src/native-request-receipts';
import { buildNativePomodoroAlarmIntent, buildNativePomodoroLegacyAlert, NATIVE_POMODORO_LATE_LIMIT_MS } from '../../../packages/core/src/native-pomodoro-alarm';
import { planNativePomodoroAlarmEffects, prepareNativePomodoroAlarmDispatch } from '../../../packages/core/src/native-pomodoro-alarm-effects';
import { buildNativeAISettingsProjection } from '../../../packages/core/src/native-ai-settings-projection';
import { createNativeAITextConfigurationMethods, nativeAITextConfigurationConsentTarget, readNativeAITextConfigurationRequestV2 } from '../../../packages/core/src/native-ai-text-configuration';
import { createNativeVoiceMethods } from '../../../packages/core/src/native-voice';
import { buildRemoteGeminiSpeechRequest, decodeRemoteGeminiSpeechResponse, type GeminiSpeechRequestConfig } from '../../../packages/core/src/speech-to-task';
import { createDateFormatter } from '../../../packages/core/src/date';
import { createNativeAIRequestTimeoutMethods } from '../../../packages/core/src/native-ai-request-timeout';
import { createNativeAIReasoningEffortMethods } from '../../../packages/core/src/native-ai-reasoning-effort';
import { createNativeAIGeminiThinkingBudgetMethods } from '../../../packages/core/src/native-ai-gemini-thinking-budget';
import { readNativeAIProviderDeviceState } from '../../../packages/core/src/native-ai-provider-device-state';
import { createPreparedProjectAvailabilityMethods, createProjectAvailabilityMethods } from '../../../packages/core/src/native-host-contract-project-availability';
import { SYNC_ENCRYPTION_STATE_KEY } from '../../../packages/core/src/sync-storage-keys';
import { createNativeReminders } from './host-reminders';
import { createIosReminderMethods, createIosReminderSnoozeMethods } from './host-ios-reminders';
import { createIosDirectoryFileSync, createIosFileSync, createNativeSync, createHostSyncCrypto, isNativeIosSelfHostedProvider, type NativeSync, type NativeSyncBindings } from './host-sync';
import { createWidgetPublisher, type WidgetInputs } from './host-widgets';

type NativeBridge = {
    cloudKitAvailable?(): boolean;
    sqlRun(sql: string, params: string): string | null;
    sqlAll(sql: string, params: string): string;
    sqlExec(sql: string): string | null;
    nowMs(): number;
    randomBytes(length: number): string;
    log(line: string): void;
    rnStateCommit(change: string): string | null;

    logFile(operation: string, text: string): string;
    fileList(path: string): string;
    fileRead(path: string): string;
    fileDelete(path: string): string | null;

    kvGet(key: string): string;
    kvSet(key: string, value: string): string | null;
    kvRemove(key: string): string | null;
    kvMultiGet(keysJson: string): string;
    kvMultiSet(pairsJson: string): string | null;
    kvMultiRemove(keysJson: string): string | null;

    calendarSettingRead?(): string;
    calendarSubscriptionRead?(): string;
    calendarSettingCAS?(expectedJson: string, nextJson: string): string | null;

    calendarPushDue?(idsJSON: string): string | null;

    hostEvent(json: string): string | null;

    trace?(name: string): void;

    alarmApply?(planJson: string): number | string | null;
    notificationsAllowed?(): boolean | string;
    rnAlarmCleanup?(): number | string;
    reminderReceiverCounts?(): string;
    reminderLedger?(): string;

    widgetInputs?(): string;
    widgetPublish?(payload: string): string | null;
    widgetAppState?(): string;

    bgSyncSchedule?(on: boolean): string | null;


    dataRead?(handle: string): string;
    dataWrite?(handle: string, chunk: string): string | null;
    dataClose?(handle: string): string;

    appSearchInfo?(): string;

    gmailFile?(op: string, name: string, to: string): string;
    gmailSql?(name: string, sql: string, paramsJson: string): string;

    debugProp?(name: string): string;

    memProbe?(label: string): string | null;
    gmailFile?(op: string, name: string, to: string): string;
    gmailSql?(name: string, sql: string, paramsJson: string): string;
};

declare const globalThis: Record<string, unknown> & { MindwtrHost?: unknown; fetch: typeof fetch };
const native = (): NativeBridge => {
    const bridge = globalThis.__mindwtrNative as NativeBridge | undefined;
    if (!bridge) throw new Error('Native bridge unavailable');
    return bridge;
};


const NATIVE_ERROR = '!MindwtrNativeError:';
const checked = <T,>(value: T): T => {
    if (typeof value === 'string' && value.startsWith(NATIVE_ERROR)) throw new Error(value.slice(NATIVE_ERROR.length));
    return value;
};


const channelRead = (handle: string): string => {
    const bridge = native();
    const parts: string[] = [];
    for (;;) {
        const reply = checked(bridge.dataRead!(handle));
        if (reply === 'E') return parts.join('');
        if (reply[0] !== 'D') throw new Error('DATA_IO');
        parts.push(reply.slice(1));
    }
};
const channelClose = (handle: string): { bytes: number; sha256: string } => JSON.parse(checked(native().dataClose!(handle))) as { bytes: number; sha256: string };

const CHANNEL_UNITS = 512 * 1024;

const channelPieces = function* (text: string): Generator<string> {
    for (let start = 0; start < text.length;) {
        let end = Math.min(text.length, start + CHANNEL_UNITS);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        yield text.slice(start, end);
        start = end;
    }
};
const channelWrite = (handle: string, text: string): void => {
    const bridge = native();
    for (const piece of channelPieces(text)) checked(bridge.dataWrite!(handle, piece));
};

const base64Pieces = function* (text: string): Generator<string> {
    for (let start = 0; start < text.length; start += 4 * 256 * 1024) yield text.slice(start, start + 4 * 256 * 1024);
};
const channelWriteBase64 = (handle: string, text: string): void => {
    const bridge = native();
    for (const piece of base64Pieces(text)) checked(bridge.dataWrite!(handle, piece));
};


const debugProp = (name: string): string => {
    const read = (globalThis.__mindwtrNative as NativeBridge | undefined)?.debugProp;
    return read ? String(checked(read(name)) ?? '') : '';
};
const debugControl = (name: string): boolean => debugProp('d1c_control') === name || debugProp('d1c_control') === 'pre-d1c' && name === 'no-storage-budget';
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

let fullReads = 0;

const channelWriteFile = async (handle: string, text: string, base64: boolean): Promise<void> => {
    const delay = Number(debugProp('channel_write_delay_ms'));
    if (!(delay > 0)) { if (base64) channelWriteBase64(handle, text); else channelWrite(handle, text); return; }
    const bridge = native();
    let first = true;
    for (const piece of base64 ? base64Pieces(text) : channelPieces(text)) {
        checked(bridge.dataWrite!(handle, piece));
        if (first) { first = false; await pause(delay); }
    }
};


let storageBudget: { baseMs: number; msPerMiB: number } | null = null;
const sizeStorageTimeout = async (adapter: { libraryBytes(): Promise<number> }): Promise<void> => {
    if (!storageBudget || debugControl('no-storage-budget')) return;
    setStorageTimeoutMs(storageBudget.baseMs + Math.ceil(await adapter.libraryBytes() / (1024 * 1024)) * storageBudget.msPerMiB);
};

const channelCode = (error: unknown): string | null =>
    error instanceof Error && /^DATA_[A-Z0-9]+$/u.test(error.message) ? error.message : null;


let tracedStep = false;
const traceStep = (name: string) => {
    const bridge = native();
    if (!bridge.trace) return;
    if (tracedStep) bridge.trace('');
    tracedStep = name !== '';
    if (tracedStep) bridge.trace(name);
};

if ((globalThis.__mindwtrNative as NativeBridge | undefined)?.trace) {
    globalThis.__mindwtrTraceSection = (name: string) => { native().trace?.(name); };
}

const sqlite: SqliteClient = {
    run: async (sql, params) => { checked(native().sqlRun(sql, JSON.stringify(params ?? []))); },
    all: async <T,>(sql: string, params?: unknown[]): Promise<T[]> => {

        if (sql.startsWith('SELECT rowid as _rowid, * FROM tasks WHERE rowid > ?') && params?.[0] === 0) {
            fullReads += 1;
            const delay = Number(debugProp('sql_read_delay_ms'));
            if (delay > 0 && fullReads > (Number(debugProp('sql_read_delay_skip')) || 0)) await pause(delay);
        }
        return JSON.parse(checked(native().sqlAll(sql, JSON.stringify(params ?? [])))) as T[];
    },
    get: async <T,>(sql: string, params?: unknown[]): Promise<T | undefined> =>
        (JSON.parse(checked(native().sqlAll(sql, JSON.stringify(params ?? [])))) as T[])[0],
    exec: async (sql) => {
        for (const statement of splitSqlStatements(sql)) checked(native().sqlExec(statement));
    },
};


const keyValue = {
    get: async (key: string): Promise<string | null> => (JSON.parse(checked(native().kvGet(key))) as [string | null])[0],
    set: async (key: string, value: string): Promise<void> => { checked(native().kvSet(key, value)); },
    remove: async (key: string): Promise<void> => { checked(native().kvRemove(key)); },
    multiGet: async (keys: readonly string[]): Promise<[string, string | null][]> =>
        JSON.parse(checked(native().kvMultiGet(JSON.stringify(keys)))) as [string, string | null][],
    multiSet: async (pairs: readonly (readonly [string, string])[]): Promise<void> => { checked(native().kvMultiSet(JSON.stringify(pairs))); },
    multiRemove: async (keys: readonly string[]): Promise<void> => { checked(native().kvMultiRemove(JSON.stringify(keys))); },
};


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
const diagnosticsFileLog = createDiagnosticsLog({
    isEnabled: () => isDiagnosticsLoggingEnabled(useTaskStore.getState().settings),
    files: [nativeLogFile],
});
const feedbackDiagnosticsBuffer = createFeedbackDiagnosticsBuffer();


const diagnosticsLog = {
    ...diagnosticsFileLog,
    append: (...args: Parameters<typeof diagnosticsFileLog.append>) => {

        try {
            const entry = feedbackDiagnosticEntry(args[0]);
            if (entry) feedbackDiagnosticsBuffer.record(entry);
        } catch {                                                                 }
        return diagnosticsFileLog.append(...args);
    },
    clear: () => { feedbackDiagnosticsBuffer.clear(); return diagnosticsFileLog.clear(); },
    clearChecked: () => { feedbackDiagnosticsBuffer.clear(); return diagnosticsFileLog.clearChecked(); },
};

setLogger((payload) => {
    consoleLogger(payload);
    try {
        void diagnosticsLog.append(diagnosticsEntryFromLogPayload(payload), { force: payload.force });
    } catch {                                                    }
});


const collectFeedbackDiagnostics = async (): Promise<string | null> => {
    const snapshot = buildFeedbackDiagnosticsSnapshot({
        debugLoggingEnabled: isDiagnosticsLoggingEnabled(useTaskStore.getState().settings), breadcrumbs: getBreadcrumbs() });

    return buildFeedbackDiagnostics([sanitizeSavedFeedbackLog(await diagnosticsLog.read()), feedbackDiagnosticsBuffer.read()], snapshot, 20_000);
};


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


class ValidatedSqliteAdapter extends NativeReceiptSqliteAdapter {
    protected override afterReadNow(loaded: (table: EntityTable) => number, settings: LoadedData['settings']): Promise<void> {
        return this.validate(loaded, settings);
    }


    async verifyActivation(store: Record<EntityTable, readonly { id: string }[]>): Promise<void> {

        const light = await this.readRowBaseline();
        let ids: Record<EntityTable, readonly string[]>;
        if (light) {
            ids = light.ids;
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
        } catch {                                              }
    }


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
        try { native().log(`${entry.level}: [${entry.scope}] ${entry.message}${entry.context ? ` ${JSON.stringify(entry.context)}` : ''}`); } catch {                             }
        return diagnosticsLog.append(entry, { force });
    },
    translate: (key) => {
        const result = contract.getStrings({ keys: [key] });
        return result.ok ? result.value.strings[key] ?? key : key;
    },
    emit: (event) => { checked(native().hostEvent(JSON.stringify(event))); },
    trace: (line) => { try { native().log(line); } catch {                             } },
    scheduleBackgroundSync: (on) => { const bridge = native(); if (bridge.bgSyncSchedule) checked(bridge.bgSyncSchedule(on)); },
    isFossBuild,

    listRecoverySnapshots: async () => sortRecoverySnapshotNames((JSON.parse(checked(native().fileList('files/snapshots'))) as string[] | null) ?? []),
};


const nativeSync: NativeSync | null = globalThis.__mindwtrHostPlatform !== 'ios'
    && typeof (globalThis.__mindwtrNative as { kvMultiGet?: unknown } | undefined)?.kvMultiGet === 'function'
    ? createNativeSync(nativeSyncBindings)
    : null;
let iosManualSync: NativeSync | null = null;
let iosCleanupCallback: ((requestJSON: string) => unknown) | null = null;
let iosDirectorySync: ReturnType<typeof createIosDirectoryFileSync> | null = null;
const iosCloudKitAvailable = () => globalThis.__mindwtrHostPlatform === 'ios'
    && native().cloudKitAvailable?.() === true && typeof globalThis.__mindwtrCloudKitCall === 'function';
let iosSelectedCloudKitSource: ((metadataJSON: string, plaintextBase64: string) => string) | null = null;
let iosCloudKitTail: Promise<unknown> = Promise.resolve();
const iosCloudKitCall: NativeCloudKitTransportCall = (request, signal) => {
    const selectedOwner = iosSelectedCloudKitSource, cleanupOwner = iosCleanupCallback;
    const result = iosCloudKitTail.then(() => {
        const selected = selectedOwner !== null && iosSelectedCloudKitSource === selectedOwner;
        const cleanup = cleanupOwner !== null && iosCleanupCallback === cleanupOwner;
        if ((!selected && !cleanup) || !iosCloudKitAvailable()
            || (selected && request.op !== 'fetchAttachmentAsset')) throw new Error('CloudKit requires an owned foreground invocation');
        if (signal?.aborted) throw signal.reason ?? new Error('CloudKit operation cancelled');
        return (globalThis.__mindwtrCloudKitCall as NativeCloudKitTransportCall)(request, signal);
    });
    iosCloudKitTail = result.catch(() => {});
    return result;
};
const iosCloudKitRecords = createNativeCloudKitRecords(iosCloudKitCall);
let iosDropboxControl: ((requestJSON: string) => unknown) | null = null;
let iosDropboxRequestId: string | null = null;
let iosDropboxSignal: AbortSignal | undefined;
const iosDropboxReply = (phase: 'configuration' | 'assertCurrent'): unknown => {
    const control = iosDropboxControl;
    if (!control || iosDropboxSignal?.aborted) throw new Error('NOT_READY: Dropbox requires its current foreground owner');
    const reply = control(JSON.stringify({ phase }));
    if (typeof reply !== 'string' || new TextEncoder().encode(reply).length > 4096 || reply.startsWith('!MindwtrNativeError:'))
        throw new Error('NOT_READY: Dropbox foreground ownership is unavailable');
    try { return JSON.parse(reply) as unknown; } catch { throw new Error('NOT_READY: Dropbox foreground ownership is invalid'); }
};
const iosDropboxCapability: NativeIosDropboxCapability = {
    configuration: () => readNativeIosDropboxConfiguration(iosDropboxControl ? iosDropboxReply('configuration') : null),
    assertCurrent: () => { const reply = iosDropboxReply('assertCurrent');
        if (!reply || typeof reply !== 'object' || Array.isArray(reply) || Object.keys(reply).length !== 1 || (reply as { current?: unknown }).current !== true)
            throw new Error('NOT_READY: Dropbox foreground owner changed'); },
    authorizationRequestId: () => { iosDropboxCapability.assertCurrent(); if (!iosDropboxRequestId) throw new Error('NOT_READY: Dropbox authorization requires its original Connect request'); return iosDropboxRequestId; },
    authorize: request => { iosDropboxCapability.assertCurrent(); if (request.requestId !== iosDropboxRequestId) throw new Error('NOT_READY: Dropbox authorization request changed'); const call = (globalThis as { __mindwtrDropboxCall?: (input: unknown, signal?: AbortSignal) => Promise<unknown> }).__mindwtrDropboxCall;
        if (!call) throw new Error('NOT_READY: Dropbox authorization is unavailable'); return call(request, iosDropboxSignal); },
};
const ensureIosManualSync = (): NativeSync => iosManualSync ??= createNativeSync({ ...nativeSyncBindings, dropbox: iosDropboxCapability,
                    ...(iosCloudKitAvailable() ? { cloudKit: {
                        ...iosCloudKitRecords, isAvailable: iosCloudKitAvailable,
                        getAccountStatus: () => iosCloudKitRecords.accountStatus(),
                        assets: createNativeCloudKitAssets(iosCloudKitCall),
                    } } : {}),
                    performFileSync: (path, options) => {
                        if (!iosDirectorySync) throw new Error('Directory File Sync requires an explicit manual action');
                        return iosDirectorySync.performFileSync(path, options);
                    },
                    pickSyncFolder: () => {
                        if (!iosDirectorySync) throw new Error('Directory selection requires an explicit manual action');
                        return iosDirectorySync.pickSyncFolder();
                    }, emit: () => {}, trace: () => {}, scheduleBackgroundSync: () => {},
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
let iosProjectAttachmentDownload = false;
let iosRelocatedProjectAvailability = false;
let iosCachedProjectAvailability = false;
let iosSelfHostedProjectAttachments: ReturnType<typeof createNativeReadOnlySelfHostedAttachments> | null = null;
let iosTaskAttachmentPreparation = false;
let iosProjectFilePreparation = false;
let iosForegroundFailure: NativeAttachmentCleanupUnconfirmedError | null = null;

let networkState: { isConnected: boolean | null; isInternetReachable: boolean | null } = { isConnected: null, isInternetReachable: null };
const requireSync = (): NativeSync => {
    if (!nativeSync) throw new Error('Sync is not available on this host');
    return nativeSync;
};


let storedLanguage: string | null = null;
let iosVoiceSystemLocale: string | null = null;
const widgets = typeof (globalThis.__mindwtrNative as { widgetPublish?: unknown } | undefined)?.widgetPublish === 'function'
    ? createWidgetPublisher({
        ready: () => bootAdapter !== null,
        inputs: () => JSON.parse(checked(native().widgetInputs!())) as WidgetInputs,
        publish: (payload) => { checked(native().widgetPublish!(payload)); },
        storedLanguage: () => storedLanguage,
        active: () => checked(native().widgetAppState!()) === 'active',
    })
    : null;

const cacheIOSFocusWidgetFilter = (focus: NativeFocusView): void => {
    if (globalThis.__mindwtrHostPlatform !== 'ios') return;
    const filter = focus.controls?.widgetFilter;
    if (filter) setFocusWidgetFilter({ criteria: filter.criteria, sortBy: filter.sortBy, sortOrder: filter.sortOrder ?? undefined });
};

const nativeAI = nativeSync ? createNativeAI(keyValue, () => globalThis.__mindwtrSecrets as HostSecrets, isFossBuild) : null;
let iosCaptureAIHost: NativeAIHost | null = null;
let iosTaskAI: ReturnType<typeof createIOSTaskAI> | null = null;
let iosInboxAI: ReturnType<typeof createIOSInboxAI> | null = null;
let iosReviewAI: ReturnType<typeof createIOSReviewAI> | null = null;
let iosConfigurationAIHost: NativeAIHost | null = null;
let iosConfigurationAIActive = false;
let iosCaptureAIQuestion: { revision: string; request: { title: string; contexts: string[]; tags: string[] };
    settings: ReturnType<typeof useTaskStore.getState>['settings']; language: string } | null = null;
const nativeAbout = nativeSync ? createNativeAbout(globalThis.__mindwtrAppInfo, keyValue, generateUUID, collectFeedbackDiagnostics) : null;


const nativeAppSearch = nativeSync && typeof native().appSearchInfo === 'function'
    ? createNativeAppSearch(native().appSearchInfo!(), globalThis.__mindwtrAppSearchCall as AppSearchCall | undefined, keyValue) : null;

const localAttachments = nativeSync ? null : createNativeLocalAttachmentsForHost();
const attachmentsHost = nativeSync?.attachmentsHost ?? localAttachments?.contractHost;
const calendarCall = (globalThis as typeof globalThis & { __mindwtrCalendarCall?: CalendarCall }).__mindwtrCalendarCall;
const calendarPushCall = (globalThis as typeof globalThis & { __mindwtrCalendarPushCall?: CalendarCall }).__mindwtrCalendarPushCall;
const calendarPushAvailable = globalThis.__mindwtrHostPlatform === 'ios' && Boolean(calendarPushCall)
    && typeof native().calendarPushDue === 'function';
let iosCalendarPushLifecycle: NativeCalendarPushLifecycle | null = null;
let iosCalendarPushOwner: (() => void) | null = null;
const iosCalendar = globalThis.__mindwtrHostPlatform === 'ios' && calendarCall ? createIOSCalendarHost({
    call: calendarCall,
    storage: { getItem: keyValue.get, setItem: keyValue.set, removeItem: keyValue.remove, multiGet: keyValue.multiGet },
    adapter: () => {
        if (!bootAdapter || getStorageAdapter() !== bootAdapter || isSandboxMode() || isWorkspaceTransitionActive()) {
            throw new Error('NOT_READY: Calendar storage is unavailable');
        }
        requireSaved();
        return bootAdapter;
    },
    fetch: (...args) => globalThis.fetch(...args),
    ...(calendarPushAvailable ? { push: {
        call: async (request: Record<string, unknown>) => {
            const assertReady = iosCalendarPushOwner;
            assertReady?.();
            const value = await calendarPushCall!(request);
            assertReady?.();
            return value;
        },
        requestPartialSync: (ids: string[]) => {
            try { checked(native().calendarPushDue!(JSON.stringify(ids))); }
            catch {                                                                  }
        },
    } } : {}),
    log: {
        info: (message, context) => logInfo(message, { scope: context?.scope, context: context?.extra }),
        warn: (message, context) => logWarn(message, { scope: context.scope, context: context.extra }),
        error: () => logWarn('Native iOS calendar provider failed', { scope: 'calendar-settings' }),
    },
}) : undefined;
if (calendarPushAvailable && iosCalendar) {
    iosCalendar.bindPushLifecycle = (lifecycle) => { iosCalendarPushLifecycle = lifecycle; };
}


const persistentCapture = nativeSync ? {
    read: () => (JSON.parse(checked(native().kvGet(PERSISTENT_CAPTURE_STORAGE_KEY))) as [string | null])[0] === 'true',
    write: (enabled: boolean) => {
        if (enabled) checked(native().kvSet(PERSISTENT_CAPTURE_STORAGE_KEY, 'true'));
        else checked(native().kvRemove(PERSISTENT_CAPTURE_STORAGE_KEY));
    },
} : null;

const nativeCalendar = nativeSync && typeof globalThis.__mindwtrCalendarCall === 'function'
    ? createNativeCalendar(keyValue, () => globalThis.__mindwtrCalendarCall as never, () => globalThis.__mindwtrFileCall as never, () => {
        if (!bootAdapter || getStorageAdapter() !== bootAdapter) throw new Error('Native storage is not loaded yet');
        return bootAdapter;
    })
    : null;
let readSyncSettingsRetirementStatus: (() => { pending: boolean; uncertain: boolean }) | null = null;
const contract = createNativeHostContract({
    ...(globalThis.__mindwtrHostPlatform === 'ios' ? {
        registerSyncSettingsRetirementStatus: (read: () => { pending: boolean; uncertain: boolean }) => { readSyncSettingsRetirementStatus = read; },
    } : {}), reminderPlatform: globalThis.__mindwtrHostPlatform === 'ios' ? 'ios' : 'android', get syncSettings() { return nativeSync?.settingsHost ?? iosManualSync?.settingsHost; }, get ai() { return nativeAI ?? iosTaskAI?.host ?? iosInboxAI?.host ?? iosReviewAI?.host ?? iosCaptureAIHost ?? iosConfigurationAIHost ?? undefined; },
    calendar: iosCalendar ?? nativeCalendar ?? undefined,
    get attachments() {
        const selected = iosProjectAttachmentDownload ? iosSelfHostedProjectAttachments?.contractHost ?? iosManualSync?.attachmentsHost : attachmentsHost;
        if (!iosRelocatedProjectAvailability || !selected) return selected ?? undefined;
        return { ...selected, ensureAttachmentAvailableDetailed: async (attachment: import('../../../packages/core/src/types').Attachment) => {
            const result = await (iosSelfHostedProjectAttachments ?? iosManualSync)?.prepareAttachmentAvailableDetailed?.(attachment);
            if (result?.status === 'available') return { status: 'available' as const, attachment: result.attachment };
            return { status: result?.status === 'generation-conflict' ? 'generation-conflict' as const : 'unavailable' as const };
        } };
    },
    projectPickerGroups: true,
    ...(nativeAbout ? { about: nativeAbout } : {}),
    ...(persistentCapture ? { persistentCapture } : {}) });

const calendarFeeds = nativeCalendar ? createCalendarFeeds({
    load: (input) => contract.loadExternalCalendarFeed(input) as never,
    changed: (slot, feed) => {
        try {

            logInfo('Native Android external calendars loaded', { scope: 'calendar', context: { releaseCheck: 'v1.3.5/native-android-calendar-feeds', slot,
                outcome: feed.status, calendarCount: String(feed.calendars?.length ?? 0), eventCount: String(feed.status === 'ready' ? feed.events.length : 0) } });
            checked(native().hostEvent(JSON.stringify({ type: 'calendarFeed', slot })));
        } catch {                                                  }
    },
}) : null;


const nativeGmail = nativeSync && typeof globalThis.__mindwtrGmailCall === 'function' && typeof native().gmailFile === 'function'
    ? createNativeGmail({
        call: globalThis.__mindwtrGmailCall as (request: { op: string; path?: string }) => Promise<unknown>,
        file: (op, name, to = '') => checked(native().gmailFile!(op, name, to)),
        sql: (name, sql, params) => checked(native().gmailSql!(name, sql, params)),
        addTasks: (items) => useTaskStore.getState().addTasks(items),
        flushPendingSave,

        requireSaved: () => requireSaved(),
        sandbox: isSandboxMode,
        logInfo,
        logWarn,
        statusChanged: (status) => { checked(native().hostEvent(JSON.stringify({ type: 'gmailStatus', status }))); },
    })
    : null;


const speechKeys = nativeAI ? (() => {
    const ai = nativeAI;
    return createAIKeyStore({
        storage: ai.storage,
        secrets: { getItem: (key) => ai.secrets.get(key), setItem: (key, value) => ai.secrets.set(key, value), deleteItem: (key) => ai.secrets.delete(key) },
        vault: createSyncSecretVault({ isAvailable: async () => true }),
    });
})() : null;
const widgetAudioPort = (() => {
    const channels = nativeAI && nativeSync ? nativeFileChannels() : null;
    if (!channels || !speechKeys) return null;
    const keys = speechKeys;
    return createWidgetAudioPort({
        documentDirectory: channels.directories.document,
        readBytes: async (uri) => await channels.files({ op: 'readBytes', uri }) as Uint8Array,
        deleteFile: (path) => { checked(native().fileDelete(path)); },
        loadKey: (provider) => keys.load(provider),
        isFossBuild,
        logWaiting: (outcome) => {
            try {
                logInfo('Native Android widget recording waits for transcription', { scope: 'capture',
                    context: { releaseCheck: 'v1.3.8/native-widget-audio-ingest', outcome } });
            } catch {                                                 }
        },
    });
})();


const nativeVoice = (() => {
    const call = (globalThis as { __mindwtrVoiceCall?: (request: Record<string, unknown>) => Promise<unknown> }).__mindwtrVoiceCall;
    const channels = nativeAI && nativeSync && call ? nativeFileChannels() : null;
    const host = attachmentsHost;
    if (!channels || !speechKeys || !call || !host) return null;
    const keys = speechKeys;
    const documents = channels.directories.document;
    const managed = managedAttachmentsDirectory(documents);
    const recordings = `${documents}voice-captures/`;
    const voiceLine = (line: VoiceCaptureLine) => {
        try {


            const failed = line.outcome === 'failed';

            const force = failed || line.outcome === 'saved' || line.outcome === 'applied' || line.outcome === 'kept';
            if (line.kind === 'capture') {
                (failed ? logWarn : logInfo)('Native Android voice capture', { scope: 'capture', force, context: { releaseCheck: 'v1.3.8/native-voice-capture',
                    outcome: line.outcome, provider: line.provider, ...('durationMs' in line && line.durationMs ? { durationMs: line.durationMs } : {}),
                    ...('errorKind' in line ? { errorKind: line.errorKind } : {}), ...('copied' in line ? { copied: line.copied } : {}) } });
            } else {
                (failed ? logWarn : logInfo)('Native Android voice transcription', { scope: 'capture', force,
                    context: { releaseCheck: 'v1.3.8/native-voice-transcribe', outcome: line.outcome, provider: line.provider,
                        ...(line.errorKind ? { errorKind: line.errorKind } : {}) } });
            }
        } catch {                                                 }
    };
    return createNativeVoice({
        recorder: {
            permission: async () => (await call({ op: 'permission' }) === 'granted' ? 'granted' : 'denied'),
            start: async (format) => await call({ op: 'start', format }) as { id: string },
            stop: async (id) => await call({ op: 'stop', id }) as { uri: string; size: number },
            cancel: async (id) => { await call({ op: 'cancel', id }); },
        },
        settings: () => useTaskStore.getState().settings,
        store: useTaskStore,
        isFossBuild,
        loadKey: (provider) => keys.load(provider),

        whisperModelReady: () => false,
        persistAttachment: (attachment) => persistIntoManagedStorage(attachment, {
            persist: (entry) => host.persistAttachmentLocally(entry),
            getInfo: async (uri) => await channels.files({ op: 'getInfo', uri }) as { exists?: boolean; isDirectory?: boolean } | null,
            managedDirectory: managed,
        }),
        submit: (input) => contract.submitQuickCaptureAudio(input),
        readBytes: async (uri) => await channels.files({ op: 'readBytes', uri }) as Uint8Array,
        deleteFile: (uri) => {

            if (uri.startsWith(managed)) void channels.files({ op: 'delete', uri }).catch(() => undefined);
            else if (uri.startsWith(recordings) && !uri.slice(recordings.length).includes('/')) checked(native().fileDelete(`files/${uri.slice(documents.length)}`));
        },
        label: () => unwrap(contract.getStrings({ keys: ['quickAdd.audioNoteTitle'] })).strings['quickAdd.audioNoteTitle'] ?? 'Audio note',
        newId: generateUUID,
        log: voiceLine,
    });
})();

const gmailLifecycle = (work: () => void) => {
    try { work(); } catch { logWarn('Native Android Gmail capture lifecycle failed', { scope: 'gmail-capture' }); }
};

const withCalendar = <T,>(input: T): T => (calendarFeeds ? calendarFeeds.calendar(input) : input);
const withReview = <T extends Record<string, unknown>>(slot: 'weeklyReview' | 'dailyReview', input: T): T => (calendarFeeds ? calendarFeeds.review(slot, input) : input);

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
    if (backend !== 'cloud' && backend !== 'webdav' && backend !== 'dropbox') throw new Error('NOT_READY: Project download is unavailable');
    return createPreparedProjectAvailabilityMethods({
    ...projectAvailabilityDeps(projectId), translate: (key) => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key,
}, backend === 'webdav' ? 'webdav' : backend === 'dropbox' ? 'dropbox' : 'strict');
};


const reminders = typeof (globalThis.__mindwtrNative as { alarmApply?: unknown } | undefined)?.alarmApply === 'function'
    ? createNativeReminders({
        plan: (input) => contract.planReminderAlarms(input),
        planSnooze: (input) => contract.planReminderSnooze(input),
        readStored: async () => ({ alarms: await keyValue.get(REMINDER_ALARM_MAP_STORAGE_KEY), state: await keyValue.get(NATIVE_REMINDER_STATE_STORAGE_KEY) }),
        permissionGranted: () => checked(native().notificationsAllowed!()) === true,
        apply: (planJson) => Number(checked(native().alarmApply!(planJson)) ?? 0),
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
    catch {                                                                    }
    throw new Error('Invalid bounded editor request');
};


const completionJson = (json: string, limit: number): unknown => {
    try { if (json.length <= limit) return JSON.parse(json); }
    catch {                                                              }
    throw new Error('Invalid bounded completion request');
};
const taskCompletionJson = (json: string, limit: number): unknown => {
    const input = completionJson(json, limit);
    if (globalThis.__mindwtrHostPlatform !== 'ios') {
        const field = (value: unknown, name: string): unknown => value !== null && typeof value === 'object'
            && !Array.isArray(value) ? Reflect.get(value, name) : undefined;
        const prepared = field(input, 'prepared');
        const requests = [input, field(input, 'request'), field(field(input, 'completion'), 'request'),
            field(field(prepared, 'completion'), 'request'),
            field(field(field(input, 'origin'), 'envelope'), 'request'),
            field(field(field(prepared, 'origin'), 'envelope'), 'request')];
        if (requests.some(request => field(request, 'source') === 'row')
            || ['rowComplete', 'rowCompleteUndo'].includes(String(field(prepared, 'kind'))))
            throw new Error('INVALID_INPUT: Row completion requires iOS');
    }
    return input;
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
type MenuCommand = 'activateProject' | 'somedayMove' | 'somedayProjectMove' | 'taskDestinationMove' | 'taskDatesSave' | 'taskSwipeFocus' | 'taskRowChecklistEdit' | 'taskChecklistMove' | 'taskChecklistMoveUndo' | 'somedayUndo' | 'somedayTask' | 'somedaySection' | 'taskListSort' | 'archiveAction' | 'contextsAction' | 'trashAction' | 'reviewAction' | 'reviewTask' | 'calendarAction' | 'calendarCreate' | 'boardAction' | 'boardCreate'
    | 'bulkAction' | 'focusGroup' | 'focusSave' | 'focusCriterion' | 'focusDelete' | 'focusReorder' | 'bulkCreate' | 'mindSweepAdd' | 'taskCompletedAt' | 'areaOrder' | 'areaColor' | 'areaRename' | 'projectNextAction' | 'savedSearchDelete' | 'savedSearchSort'
    | 'generalSetting' | 'gtdSetting' | 'manageEditor' | 'manageDelete' | 'somedayRename' | 'somedayReorder' | 'somedayDelete' | 'dataSetting'
    | 'syncPreference' | 'setAISetting' | 'notificationsSetting' | 'calendarSetting' | SyncScreenCommand | AIScreenCommand | CalendarScreenCommand | AttachmentCommand | ProjectDetailCommand | TaskEditorCommand | DataCommand | StartupPromptCommand;

type DataCommand = 'gettingStarted';

type StartupPromptCommand = 'supportPromptShown';

type SyncScreenCommand = 'openSyncSettings' | 'closeSyncSettings' | 'selectSyncBackend' | 'saveSyncBackend' | 'syncNow' | 'testSyncConnection'
    | 'pickSyncFolder' | 'connectDropbox' | 'disconnectDropbox' | 'runSyncEncryptionAction' | 'answerSyncMissingFiles';


type AIScreenCommand = 'openAISettings' | 'setAIKey' | 'setAIEndpoint';

type CalendarScreenCommand = 'calendarFeedAdd';

type AttachmentCommand = 'attachmentAddFile' | 'attachmentLinks' | 'attachmentRemove';

type ProjectDetailCommand = 'projectEdit';

type TaskEditorCommand = 'taskEditorAction';
type Command = 'create' | 'complete' | 'completeUndo' | 'update' | 'saveTaskDraft' | 'resetChecklist' | 'taskFocus' | 'projectFocus' | 'createProject' | 'areaFilter'
    | 'saveSearch' | 'inboxCommit' | 'inboxSkip' | 'inboxDecisionUndo' | 'quickCapture' | 'quickCaptureLines' | 'quickCapturePicker' | 'captureModal' | 'captureModalLines' | 'ingest' | 'reminderDone' | 'reminderSnooze' | MenuCommand;
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
    } catch {                                                                  }
    return unwrap(result);
};

type LegacyState = { jsonAhead: boolean; reconciled: boolean; backupVersion: string | null; backupPresent: boolean };


const importLegacyJson = async (adapter: ValidatedSqliteAdapter, loaded: LoadedData, state: LegacyState, backup: string): Promise<void> => {
    const plan = planLegacyJsonImport({
        jsonAhead: state.jsonAhead,
        reconciled: state.reconciled,
        backupVersion: state.backupVersion,
        backupJson: state.backupPresent ? backup : null,
    }, loaded, await adapter.withConnection(() => sqliteHasAnyData(sqlite)));

    if (plan.repairs && countSqliteCopyRepairs(plan.repairs) > 0) logLegacyCopyRepair(plan);
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


const logLegacyCopyRepair = (plan: ReturnType<typeof planLegacyJsonImport>): void => {
    const ios = globalThis.__mindwtrHostPlatform === 'ios';
    const context: Record<string, string> = { releaseCheck: 'v1.3.8/native-legacy-copy-repair', path: plan.path ?? '' };
    for (const [name, count] of Object.entries(plan.repairs ?? {})) context[name] = String(count);
    try {
        logWarn(ios ? 'Native iOS legacy JSON copy repaired' : 'Native Android legacy JSON copy repaired', {
            scope: ios ? 'native-ios' : 'native-android', category: 'storage', force: true, context,
        });
    } catch {                                                }
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
    } catch {                                                }
};


const requireSaved = () => {
    const failure = useTaskStore.getState().persistenceFailure;
    if (failure) throw new Error('SAVE_FAILED: Previous changes could not be saved; retry before continuing');
};

const iosGmail = globalThis.__mindwtrHostPlatform === 'ios' && typeof globalThis.__mindwtrGmailCall === 'function'
    && typeof native().gmailFile === 'function' && typeof native().gmailSql === 'function'
    ? createNativeGmail({
        platform: 'ios',
        call: globalThis.__mindwtrGmailCall as (request: { op: string; path?: string }) => Promise<unknown>,
        file: (op, name, to = '') => checked(native().gmailFile!(op, name, to)),
        sql: (name, sql, params) => checked(native().gmailSql!(name, sql, params)),
        addTasks: (items) => useTaskStore.getState().addTasks(items),
        flushPendingSave,
        requireSaved: () => requireSaved(),
        sandbox: isSandboxMode,
        logInfo,
        logWarn,
        statusChanged: () => {},
        setTimer: (() => 0) as unknown as typeof setTimeout,
        clearTimer: () => {},
        maxRoundsPerCycle: 1,
    })
    : null;
let iosGmailStarted = false;
const requireIosGmail = () => {
    if (!iosGmail || !bootAdapter || getStorageAdapter() !== bootAdapter || isSandboxMode() || isWorkspaceTransitionActive()) {
        throw new Error('NOT_READY: Gmail capture is unavailable');
    }
    return iosGmail;
};

const deviceCalendarStorage = {
    read: async (): Promise<[string | null, string | null]> => {
        const values: unknown = JSON.parse(checked(native().calendarSettingRead!()));
        if (!Array.isArray(values) || values.length !== 2 || values.some((value) => value !== null && typeof value !== 'string'))
            throw new Error('Native calendar setting storage is unavailable');
        return values as [string | null, string | null];
    },
    compareAndSet: async (expected: [string | null, string | null], next: [string, string]): Promise<void> => {
        checked(native().calendarSettingCAS!(JSON.stringify(expected), JSON.stringify(next)));
    },
};
const deviceCalendarSettings = createDeviceCalendarSettingsMethods({
    readiness: () => {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()
            || typeof native().calendarSettingRead !== 'function' || typeof native().calendarSettingCAS !== 'function')
            return { ok: false, error: { code: 'NOT_READY', message: 'Native calendar settings are unavailable' } };
        return contract.getDataSettings().ok ? { ok: true, value: null }
            : { ok: false, error: { code: 'NOT_READY', message: 'Native calendar settings are unavailable' } };
    },
    storage: () => deviceCalendarStorage,
});

const calendarSubscriptionStorage = {
    read: async (): Promise<string | null> => {
        const values: unknown = JSON.parse(checked(native().calendarSubscriptionRead!()));
        if (!Array.isArray(values) || values.length !== 1
            || values[0] !== null && typeof values[0] !== 'string')
            throw new Error('Native calendar subscription storage is unavailable');
        return values[0] as string | null;
    },
};
const calendarSubscriptionBindings: Parameters<typeof createCalendarSubscriptionSettingsMethods>[0] = {
    readiness: () => {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()
            || typeof native().calendarSubscriptionRead !== 'function')
            return { ok: false, error: { code: 'NOT_READY', message: 'Native calendar subscriptions are unavailable' } };
        return contract.getDataSettings().ok ? { ok: true, value: null }
            : { ok: false, error: { code: 'NOT_READY', message: 'Native calendar subscriptions are unavailable' } };
    },
    save: async () => {
        try { await flushPendingSave(); requireSaved(); return { ok: true, value: null }; }
        catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Calendar subscription setting could not be confirmed' } }; }
    },
    storage: () => calendarSubscriptionStorage,
    model: ({ settings, areas, feeds, revision }) => buildCalendarSubscriptionSettingsModel(feeds, revision, {
        t: (key) => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key,
        areas,
        theme: settings.theme ?? 'system',
    }),
};
const calendarSubscriptionSettings = createCalendarSubscriptionSettingsMethods(calendarSubscriptionBindings);
const calendarSubscriptionAdd = createCalendarSubscriptionAddMethods(calendarSubscriptionBindings);


type HostSecrets = {
    getSecret(key: string): Promise<string | null>;
    setSecret(key: string, value: string, accessibility?: 'after-first-unlock' | 'when-unlocked'): Promise<void>;
    deleteSecret(key: string): Promise<void>;
};


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

    await step('headGzipDav', async () => (await webdavHeadFile(`${base}/gz/data.json`)).etag);
    await step('headGzipCloud', async () => (await cloudHeadJson(`${base}/gz/data.json`)).etag);


    for (const cut of ['half', 'reset', 'oversize', 'stream', 'gzip', 'utf8']) await step(`cut-${cut}`, () => webdavGetSyncDocument(`${base}/cut/${cut}.json`));


    await step('bodies', async () => {
        const out: Record<string, { hex: string; text?: string }> = {};
        for (const name of ['nul', 'marker', 'astral', 'bom', 'invalid']) {
            const res = await fetch(`${base}/body/${name}`);
            const bytes = new Uint8Array(await res.clone().arrayBuffer());
            let text: string | undefined;
            try { text = await res.text(); } catch { text = undefined; }
            out[name] = { hex: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''), ...(text === undefined ? {} : { text }) };
        }
        return out;
    });
    await step('abort', () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 500);
        return webdavGetJson(`${base}/slow/abort`, { signal: controller.signal });
    });

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

    await step('secretStored', async () => (await fetch(`${base}/secret-stored`)).json());
    await step('secretDelete', () => secrets.deleteSecret(key));
    await step('secretGone', () => secrets.getSecret(key));
    return steps;
};


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


    PASSPHRASE_CHECK_CASES.forEach((passphrase, index) => {
        const bytes = attempt(() => Array.from(syncPassphraseBytes(passphrase), (byte) => byte.toString(16).padStart(2, '0')).join(''));
        native().log(`Native Android passphrase check ${index + 1}/${PASSPHRASE_CHECK_CASES.length} ${JSON.stringify({ index, bytes })}`);
    });
};


const PASSPHRASE_CHECK_CASES = ['cafe\u0301 \u00e9t\u00e9', '\u1112\u1161\u11ab\uae00', 'A\u030a \u212b \u00c5 \u212a', 'pass \ud83d\ude00 \u0130 \u1e9b\u0323', '\u00f1\u006e\u0303\ufb01'];

type Reply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };


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

const logEntryPoint = (input: { kind?: unknown }, result: Reply): Reply => {
    const entry = result.ok ? result.value as { route: string | null; taskId: string | null; projectId: string | null; search: unknown; capture: unknown; captureModal: unknown; notice: unknown; contextAutomation?: unknown } : null;
    const outcome = !entry ? 'refused' : entry.contextAutomation ? 'contextAutomation' : entry.captureModal ? 'captureModal' : entry.capture ? 'capture' : entry.notice ? 'notice' : entry.taskId ? 'task' : entry.projectId ? 'project'
        : entry.search ? 'search' : entry.route ? 'screen' : 'nothing';
    const kind = ['link', 'share', 'createNote', 'notification'].includes(input?.kind as string) ? input.kind as string : 'other';
    try {
        logInfo('Native Android entry point', { scope: 'native-android', context: { releaseCheck: 'v1.3.3/native-android-entry-point', kind, outcome } });
    } catch {                                                              }
    return result;
};


const MENU_READS: Record<string, (input: never) => Reply> = {
    more: () => contract.getMoreMenu(),
    projects: (input) => contract.getFilteredProjects(input),
    projectDetailView: (input) => contract.getProjectDetailView(input),
    projectTaskOrderView: (input) => contract.getProjectTaskOrderView(input),
    projectDetailFilterView: (input) => contract.getProjectDetailFilterView(input),
    projectDetailFilterOptions: (input) => contract.getProjectDetailFilterOptions(input),

    projectTaskSortOptions: (input) => contract.getProjectTaskSortOptions(input),


    projectAreaManager: () => contract.getProjectAreaManager(),
    areaRenameCheck: (input) => contract.checkAreaRename(input),
    waiting: (input) => contract.getWaitingView(input),
    someday: (input) => contract.getSomedayView(input),
    reference: (input) => contract.getReferenceView(input),
    done: (input) => contract.getDoneView(input),
    collection: (input) => contract.getMenuViewCollection(input),
    moveDialog: (input) => contract.getSomedayMoveDialog(input),

    taskDestination: (input) => contract.getTaskDestinationPicker(input),
    taskDates: (input) => contract.getTaskDatesSheet(input),
    taskRowChecklist: (input) => contract.getTaskRowChecklist(input),
    checklistTargets: (input) => contract.getChecklistMoveTargets(input),
    history: (input) => contract.getHistoryView(input),
    archive: (input) => contract.getArchiveView(input),
    contexts: (input) => contract.getContextsView(input),
    trash: (input) => contract.getTrashView(input),
    review: (input) => contract.getReviewOverview(input),
    reviewOverview: (input) => contract.getReviewOverview(input),
    reviewProjectCompletionOptions: (input) => contract.getReviewProjectCompletionOptions(input),
    weekly: (input) => contract.getWeeklyReview(withReview('weeklyReview', input)),
    weeklyReview: (input) => contract.getWeeklyReview(withReview('weeklyReview', input)),
    weeklyList: (input) => contract.getWeeklyReviewList(withReview('weeklyReview', input)),
    weeklyReviewList: (input) => contract.getWeeklyReviewList(withReview('weeklyReview', input)),
    daily: (input) => contract.getDailyReview(withReview('dailyReview', input)),
    dailyReview: (input) => contract.getDailyReview(withReview('dailyReview', input)),
    calendar: (input) => (calendarFeeds ? calendarFeeds.calendarView(input, (read) => contract.getCalendarView(read)) : contract.getCalendarView(input)),
    calendarSheet: (input) => contract.getCalendarItemSheet(withCalendar(input)),
    calendarItem: (input) => contract.getCalendarItemSheet(withCalendar(input)),

    calendarEvent: (input) => {
        const id = (input as { eventId?: unknown } | null)?.eventId;
        const found = calendarFeeds && typeof id === 'string' ? calendarFeeds.event(id) : null;
        if (!found) return { ok: false, error: { code: 'TASK_NOT_FOUND', message: 'The event is no longer shown' } };
        const sheet = contract.getCalendarItemSheet(found);
        return sheet.ok ? { ok: true, value: { ...sheet.value, event: found.event } } : sheet;
    },
    calendarComposer: (input) => contract.openCalendarComposer(withCalendar(input)),
    calendarEdit: (input) => contract.editCalendarComposer(withCalendar(input)),
    calendarPreferences: () => contract.getCalendarPreferences(),
    board: (input) => contract.getBoardView(input),
    boardList: (input) => contract.getBoardList(input),

    inbox: (input) => contract.getInboxView(input),
    inboxTokens: (input) => contract.getInboxFilterTokens(input),
    archiveTokens: (input) => contract.getArchiveFilterTokens(input),
    bulk: (input) => contract.getBulkActions(input),
    focus: (input) => {
        const reply = contract.getFocus(input);
        if (reply.ok) cacheIOSFocusWidgetFilter(reply.value);
        return reply;
    },
    focusSection: (input) => contract.getFocusSectionWindow(input),
    focusList: (input) => contract.getFocusControlsList(input),
    focusControls: (input) => contract.getFocusControlsList(input),

    settingsMenu: (input) => contract.getSettingsMenu(input),

    generalSettings: (input) => contract.getGeneralSettings(nativeAppSearch
        ? { ...(input as Parameters<typeof contract.getGeneralSettings>[0]), appSearch: nativeAppSearch.device() } : input),
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

    archiveRetentionReview: (input) => contract.getArchiveRetentionReview(input),

    projectNextActionPrompt: (input) => contract.getProjectNextActionPrompt(input),

    completedAtPicker: (input) => contract.getCompletedAtPicker(input),
    pickedCompletedAtLabel: (input) => contract.getPickedCompletedAtLabel(input),

    aboutInstallerSource: (input) => contract.getAboutInstallerSource(input),
    aboutSettings: (input) => contract.getAboutSettings(input),
    aboutFeedbackCheck: (input) => contract.checkAboutFeedback(input),

    notificationsSettings: () => contract.getNotificationsSettings(),
    persistentCaptureNotification: () => contract.getPersistentCaptureNotification(),

    dataBackup: () => contract.getDataBackup(),
    dataCsvExport: () => contract.getDataBackup('csv'),
    dataTaskNotesExport: () => contract.getDataBackup('tasknotes'),

    syncSettings: (input) => contract.getSyncSettings(input),

    calendarSettings: (input) => contract.getCalendarSettings(input),
    calendarSettingsClose: () => {
        const closed = contract.closeCalendarSettings();
        return closed.ok ? { ok: true, value: {} } : closed;
    },

    mindSweep: (input) => contract.getMindSweep(input),
    savedSearch: (input) => contract.getSavedSearchView(input),

    widgetList: (input) => contract.getWidgetListView(input),

    entryPoint: (input) => logEntryPoint(input, isNotificationTap(input) ? notificationEntry(input) : contract.resolveNativeEntryPoint(input)),
    captureImport: (input) => contract.planQuickCaptureImport(input),

    captureModalOpen: (input) => contract.openCaptureModal(input),
    captureModalView: (input) => contract.getCaptureModalView(input),
    captureModalEdit: (input) => contract.editCaptureModal(input),
    captureModalDiscard: (input) => contract.discardCaptureModal(input),

    aiSettings: () => contract.getAISettings(),
    aiSettingsClose: () => contract.closeAISettings(),
    taskEditorAI: (input) => contract.getTaskEditorAI(input),


    attachmentList: (input) => contract.getAttachmentList(input),
    attachmentLinkCheck: (input) => contract.getAttachmentLinkCheck(input),
    attachmentUpdate: (input) => {
        const applied = contract.applyAttachmentUpdate(input);
        return applied.ok ? { ok: true, value: { attachments: applied.value } } : applied;
    },


    projectStatusOptions: (input) => contract.getProjectStatusOptions(input),

    projectFlowOptions: (input: { projectId: string }) => contract.getProjectFlowOptions({ ...input, flowMode: true }),
    projectNotesOptions: (input) => contract.getProjectNotesEditOptions(input),
    projectAreaOptions: (input) => contract.getProjectAreaOptions(input),
    projectTagsOptions: (input) => contract.getProjectTagsEditOptions(input),
    projectDateOptions: (input) => contract.getProjectDateOptions(input),
    projectSectionOrderOptions: (input: { projectId: string }) => contract.getProjectSectionOrderOptions({ ...input, sectionFlow: true }),
    projectNotesPreview: (input) => contract.getProjectNotesPreview(input),

    projectToSectionOptions: (input) => contract.getProjectToSectionOptions(input),
    weeklyProjectCompletion: (input) => {
        const read = contract.getWeeklyReviewProjectCompletion(input);
        return read.ok ? { ok: true, value: { completion: read.value } } : read;
    },

    taskShare: (input) => contract.getTaskShare(input),


    taskChecklistProjectBlock: (input) => contract.getTaskChecklistProjectBlock(input),


    markdownToolbarActions: () => contract.getMarkdownToolbarActions(),
    markdownToolbarApply: (input) => contract.applyMarkdownToolbar(input),
};


const draftOnly = (input: never, command: () => Promise<Reply>): Promise<Reply> => ((input as { owner?: { kind?: unknown } } | null)?.owner?.kind === 'task'
    ? command()
    : Promise.resolve({ ok: false, error: { code: 'INVALID_INPUT', message: 'Only a task draft attachment command runs here' } }));
const ATTACHMENT_REQUESTS: Record<string, (input: never) => Promise<Reply>> = {


    draftAddFile: (input) => draftOnly(input, () => contract.addAttachmentFile(input)),
    draftLinks: (input) => draftOnly(input, () => contract.submitAttachmentLinks(input)),
    draftRemove: (input) => draftOnly(input, () => contract.removeAttachment(input)),
    downloadAttachment: (input) => contract.downloadAttachment(input),
    openAttachment: (input) => contract.openAttachment(input),
    settleTaskDraftAttachments: (input) => contract.settleTaskDraftAttachments(input),


    prepareSharedFiles: (input) => contract.prepareSharedFiles(input),
};
const LOCAL_ATTACHMENT_REQUESTS = new Set(['draftAddFile', 'draftRemove', 'openAttachment', 'settleTaskDraftAttachments']);


const AI_REQUESTS: Record<string, (input: never, signal: AbortSignal) => Promise<Reply>> = {
    loadAIModels: (input, signal) => contract.loadAIModels(input, { signal }),
    requestTaskEditorCopilot: (input, signal) => contract.requestTaskEditorCopilot(input, { signal }),
    requestAICopilot: (input, signal) => contract.requestAICopilot(input, { signal }),
    requestTaskEditorClarify: (input, signal) => contract.requestTaskEditorClarify(input, { signal }),
    requestTaskEditorBreakdown: (input, signal) => contract.requestTaskEditorBreakdown(input, { signal }),
    requestInboxClarify: (input, signal) => contract.requestInboxClarify(input, { signal }),
    requestWeeklyReviewAnalysis: (_input, signal) => contract.requestWeeklyReviewAnalysis({ signal }),
};


const ABOUT_REQUESTS: Record<string, (input: never) => Promise<Reply>> = {
    isAboutUpdateCheckDue: (input) => contract.isAboutUpdateCheckDue(input),
    runAboutUpdateCheck: (input) => contract.runAboutUpdateCheck(input),
    submitAboutFeedback: (input) => contract.submitAboutFeedback(input),
    sendAboutHeartbeat: () => contract.sendAboutHeartbeat(),
    attemptAboutStoreReview: (input) => contract.attemptAboutStoreReview(input),


    beginStartupPrompts: (input) => contract.beginStartupPrompts(input),
    startupPromptAction: (input) => contract.startupPromptAction(input),
};


const CALENDAR_REQUESTS: Record<string, (input: never) => Promise<Reply> | Reply> = {
    openCalendarSettings: () => contract.openCalendarSettings(),
    grantDeviceCalendarAccess: () => contract.grantDeviceCalendarAccess(),
    testCalendarFeeds: () => contract.testCalendarFeeds(),
    refreshCalendarPushTargets: () => contract.refreshCalendarPushTargets(),
    refreshCalendarFeed: (input) => {
        const slot = (input as { slot?: unknown } | null)?.slot;
        if (!calendarFeeds || (slot !== 'calendar' && slot !== 'weeklyReview' && slot !== 'dailyReview')) {
            return { ok: false, error: { code: 'INVALID_INPUT', message: 'A screen slot is required' } };
        }
        const started = calendarFeeds.refresh(slot);

        if (started.started) {
            try { checked(native().hostEvent(JSON.stringify({ type: 'calendarFeed', slot }))); } catch {                                         }
        }
        return { ok: true, value: started };
    },
};

const MENU_COMMANDS: Record<MenuCommand, (input: never) => Reply | Promise<Reply>> = {
    activateProject: (input) => contract.activateProject(input),

    supportPromptShown: (input) => contract.supportPromptShown(input),
    somedayMove: (input) => contract.moveSomedayTasksToSection(input),

    somedayProjectMove: (input) => contract.moveSomedayProjectToSection(input),

    taskDestinationMove: (input) => contract.moveTaskToDestination(input),
    taskDatesSave: (input) => contract.saveTaskDates(input),
    taskSwipeFocus: (input) => contract.setTaskSwipeFocus(input),
    taskRowChecklistEdit: (input) => contract.editTaskRowChecklist(input),
    taskChecklistMove: (input) => contract.moveTaskToChecklist(input),
    taskChecklistMoveUndo: (input) => contract.undoMoveTaskToChecklist(input),
    somedayUndo: (input) => contract.undoSomedaySectionMove(input),
    somedayTask: (input) => contract.addSomedaySectionTask(input),
    somedaySection: (input) => contract.createSomedaySection(input),
    taskListSort: (input) => contract.setTaskListSort(input),
    archiveAction: (input) => contract.runArchiveAction(input),
    contextsAction: (input) => contract.runContextsAction(input),
    trashAction: (input) => contract.runTrashAction(input),
    reviewAction: (input) => contract.runReviewAction(input),

    reviewTask: (input) => contract.runReviewAction(input),

    calendarAction: (input) => contract.runCalendarAction(withCalendar(input)),
    calendarCreate: (input) => contract.runCalendarAction(withCalendar(input)),
    boardAction: (input) => contract.runBoardAction(input),
    boardCreate: (input) => contract.runBoardAction(input),

    bulkAction: (input) => contract.runBulkAction(input),
    focusGroup: (input) => contract.setFocusGroupBy(input),
    focusSave: (input) => contract.saveFocusFilter(input),
    focusCriterion: (input) => contract.removeFocusFilterCriterion(input),
    focusDelete: (input) => contract.deleteFocusFilter(input),
    focusReorder: (input) => contract.reorderFocus(input),

    bulkCreate: (input) => contract.createBulkOrganizeDestination(input),
    mindSweepAdd: (input) => contract.addMindSweepItem(input),
    projectNextAction: (input) => contract.runProjectNextAction(input),
    taskCompletedAt: (input) => contract.setTaskCompletedAt(input),
    savedSearchDelete: (input) => contract.deleteSavedSearch(input),

    savedSearchSort: (input) => contract.setSavedSearchSort(input),

    generalSetting: (input) => contract.setGeneralSetting(input),
    gtdSetting: (input) => contract.setGtdSetting(input),
    manageEditor: (input) => contract.saveManageEditor(input),
    manageDelete: (input) => contract.deleteManageItem(input),
    somedayRename: (input) => contract.renameSomedaySection(input),
    somedayReorder: (input) => contract.reorderSomedaySections(input),
    somedayDelete: (input) => contract.deleteSomedaySection(input),

    dataSetting: (input) => contract.setDataSetting(input),
    gettingStarted: (input) => contract.seedGettingStarted(input),

    notificationsSetting: (input) => contract.setNotificationsSetting(input),

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
    answerSyncMissingFiles: (input) => contract.answerSyncMissingFiles(input),

    setAISetting: (input) => contract.setAISetting(input),
    openAISettings: (input) => contract.openAISettings(input),
    setAIKey: (input) => contract.setAIKey(input),
    setAIEndpoint: (input) => contract.setAIEndpoint(input),

    calendarSetting: (input) => contract.setCalendarSetting(input),
    calendarFeedAdd: (input) => contract.addCalendarFeed(input),


    attachmentAddFile: (input) => contract.addAttachmentFile(input),
    attachmentLinks: (input) => contract.submitAttachmentLinks(input),
    attachmentRemove: (input) => contract.removeAttachment(input),

    projectEdit: (input) => contract.runProjectEdit(input),

    areaOrder: (input) => contract.runAreaOrder(input),

    areaColor: (input) => contract.runAreaColor(input),

    areaRename: (input) => contract.runAreaRename(input),

    taskEditorAction: (input) => contract.runTaskEditorAction(input),
};

let bootAdapter: ValidatedSqliteAdapter | null = null;

let saveWarmTasks: readonly Task[] | null = null;
let saveWarmFrom = 0;

const withHostConnection = <T,>(work: () => Promise<T>): Promise<T> => (bootAdapter ? bootAdapter.withConnection(work, { write: true }) : work());

const savedSettingsIfSettled = async (settingsReference: unknown): Promise<Record<string, unknown> | null> => {
    const before = getPersistenceStatus();
    if (!bootAdapter || before.failed || before.queued || before.inFlight || before.immediate || before.retrying) return null;
    const row = await bootAdapter.withConnection(() => sqlite.get<{ data: string }>('SELECT data FROM settings WHERE id = 1'));
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
const boot = (legacyState: string, legacyBackup: string, recoveryLoad = false, journaled = false, budgetJSON = ''): string => submit(async () => {
    if (budgetJSON && !debugControl('no-storage-budget')) {
        const budget = JSON.parse(budgetJSON) as { baseMs: number; msPerMiB: number; storageTimeoutMs: number };
        storageBudget = { baseMs: budget.baseMs, msPerMiB: budget.msPerMiB };
        setStorageTimeoutMs(budget.storageTimeoutMs);
    }

    setNativeReplayTokens(journaled ? 'required' : 'optional');
    const adapter = new ValidatedSqliteAdapter(sqlite, { rejectConcurrentWrites: true });

    setStorageAdapter(adapter);


    traceStep('js:receipts');
    if (journaled) await adapter.withConnection(() => loadNativeRequestReceipts(sqlite), { write: true });
    else await adapter.withConnection(() => loadNativeRequestReceipts(sqlite, { durableCommands: [...(globalThis.__mindwtrHostPlatform === 'ios' ? ['rowTaskFocus', 'rowTaskDates', 'rowTaskDestination', 'taskChecklistMove', 'taskChecklistMoveUndo', 'rowTaskBackdate', 'projectTasksDelete', 'projectTasksDeleteUndo', 'projectOrganizeDestinationCreate', 'projectTasksOrganize', 'projectTasksRemoveTag', 'projectTasksAddTag', 'projectTasksMove', 'rowTaskCompletion', 'rowTaskCompletionUndo', 'iosRowQuickStatus', 'iosInlineChecklist', 'gettingStarted', 'voiceSettings', 'voiceCapture', 'voiceResult', 'review', 'weeklyReviewProjectTask', 'iosShareCapture', 'iosWidgetCompletion', 'iosWatchIngestItem', 'somedaySectionBulkMove', 'somedaySectionBulkMoveUndo', 'aiTextConfiguration', 'aiTextConfigurationV2', 'waitingTasksDelete', 'waitingTasksDeleteUndo', 'somedayTasksDelete', 'somedayTasksDeleteUndo', 'reviewTasksDelete', 'reviewTasksDeleteUndo', 'contextsTasksDelete', 'contextsTasksDeleteUndo'] : []), 'appLock', 'notificationSetting', 'aiRequestTimeout', 'aiReasoningEffort', 'aiGeminiThinkingBudget', 'deviceCalendarSetting', 'calendarSubscriptionSetting', 'calendarSubscriptionAdd', 'reminderComplete', 'reminderSnooze', 'taskCompletion', 'taskCompletionUndo', 'boardTaskCompletion', 'boardTaskCompletionUndo', 'boardTaskReactivate', 'boardTaskOrder', 'archivedTaskRestore', 'archivedTasksRestore', 'trashItemsRestore', 'trashItemsPurge', 'doneTasksMove', 'doneTasksAddTag', 'doneTasksRemoveTag', 'archivedTasksDelete', 'archivedTasksDeleteUndo', 'doneTasksDelete', 'doneTasksDeleteUndo', 'referenceTasksDelete', 'referenceTasksDeleteUndo', 'inboxTasksDelete', 'inboxTasksDeleteUndo', 'referenceTasksMove', 'inboxTasksMove', 'inboxTasksAddTag', 'inboxTasksRemoveTag', 'inboxTasksOrganize', 'inboxOrganizeDestinationCreate', 'inboxPreparedCommit', 'inboxUndo', 'referenceTasksAddTag', 'referenceTasksRemoveTag', 'preparedProjectLifecycle', 'preparedTaskDelete', 'preparedProjectDelete', 'preparedTaskDeleteUndo', 'doneTaskStatus', 'referenceTaskNext', 'referenceTaskStatus', 'referenceTaskCompletion', 'referenceTaskCompletionUndo', 'referenceTaskBackdate', 'referenceTaskDestination', 'referenceProjectNextAction', 'doneTaskCompletedAt', 'archiveTaskCompletedAt', 'data', 'backupDocument', 'pomodoroTransition', 'appleReminderImportItem'] }), { write: true });
    traceStep('js:schema');

    let loaded: LoadedData | null = legacyState ? await adapter.getData() : null;
    if (!legacyState) await adapter.ensureSchema();
    traceStep('');
    if (loaded) await importLegacyJson(adapter, loaded, JSON.parse(legacyState) as LegacyState, legacyBackup);
    loaded = null;
    const result = await activateAndVerify(adapter, recoveryLoad);
    bootAdapter = adapter;
    return result;
});

iosTaskAI = createIOSTaskAI({ contract, adapter: () => bootAdapter,
    isIOS: () => globalThis.__mindwtrHostPlatform === 'ios',
    otherAIActive: () => Boolean(iosCaptureAIHost || iosConfigurationAIHost || iosConfigurationAIActive || iosInboxAI?.active || iosReviewAI?.active), isFossBuild });
iosInboxAI = createIOSInboxAI({ contract, adapter: () => bootAdapter,
    isIOS: () => globalThis.__mindwtrHostPlatform === 'ios',
    otherAIActive: () => Boolean(iosCaptureAIHost || iosConfigurationAIHost || iosConfigurationAIActive || iosTaskAI?.active || iosReviewAI?.active), isFossBuild });
iosReviewAI = createIOSReviewAI({ contract, adapter: () => bootAdapter,
    isIOS: () => globalThis.__mindwtrHostPlatform === 'ios',
    otherAIActive: () => Boolean(iosCaptureAIHost || iosConfigurationAIHost || iosConfigurationAIActive || iosTaskAI?.active || iosInboxAI?.active), isFossBuild });

const taskListBulkTagInput = (tag: string, changedCount: number): string => submit(async () => {
    requireSaved();
    if (typeof tag !== 'string' || tag.length > 2_000 || !Number.isInteger(changedCount) || changedCount < 0 || changedCount > 10_000) {
        throw new Error('INVALID_INPUT: List tag input must be bounded text and a count from 0 to 10000');
    }
    const t = (key: string): string => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key;
    return { canSave: canSaveTaskListTag(tag), notice: changedCount === 0 ? null
        : { title: t('common.done'), message: formatListItemCount(changedCount, 'task', t) } };
});


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

const inspectBackup = (read: () => string, metadataJSON: string, format: string) => {
    backupAdapter(true);
    const pending = getPersistenceStatus();
    if (pending.queued || pending.inFlight || pending.immediate || pending.retrying || pending.failed) {
        throw new Error('NOT_READY: Backup inspection is unavailable while saving is pending');
    }
    if (format !== 'json' && format !== 'json-restore' && format !== 'csv' && format !== 'todoist' && format !== 'ticktick' && format !== 'dgt' && format !== 'omnifocus') throw new Error('INVALID_INPUT: Invalid backup document input');
    return inspectNativeBackupDocument(read(), backupJson(metadataJSON) as Parameters<typeof inspectNativeBackupDocument>[1], backupTranslate, format);
};

const iosWatchReadiness = () => {
    if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
        || !bootAdapter.concurrentWritesGuarded || isSandboxMode() || isWorkspaceTransitionActive())
        throw new Error('NOT_READY: Watch intake requires current personal storage');
};
const iosShareCaptureMethods = createNativeShareCaptureMethods({ contract, current: () => {
    if (globalThis.__mindwtrHostPlatform !== 'ios' || isSandboxMode() || isWorkspaceTransitionActive())
        throw new Error('ACTION_FAILED: Native share waits for its original workspace');
    requireSaved();
} });
const iosVoiceReadiness: Parameters<typeof createNativeVoiceMethods>[0]['readiness'] = () => {
    if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
        || !bootAdapter.concurrentWritesGuarded || isSandboxMode() || isWorkspaceTransitionActive())
        return { ok: false, error: { code: 'NOT_READY', message: 'Voice requires current personal storage' } };
    return { ok: true, value: null };
};
const iosVoiceMethods = createNativeVoiceMethods({
    readiness: iosVoiceReadiness,
    save: async () => {
        try { await flushPendingSave(); requireSaved(); return { ok: true, value: null }; }
        catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Voice save could not be confirmed' } }; }
    },
    t: () => backupTranslate, revision: now => `voice:${now.toISOString()}`,
    requestIdPattern: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    formatDate: () => {
        const settings = useTaskStore.getState().settings;
        return createDateFormatter({ language: settings.language || unwrap(contract.getStrings({ keys: [] })).language,
            dateFormat: settings.dateFormat, calendarSystem: settings.calendarSystem, timeFormat: settings.timeFormat,
            systemLocale: iosVoiceSystemLocale });
    },
});
const iosVoiceOwner = (owner: () => unknown, signal: AbortSignal) => {
    unwrap(iosVoiceReadiness());
    if (typeof owner !== 'function') throw new Error('INVALID_INPUT: Voice requires private owner authority');
    const adapter = bootAdapter;
    const current = () => {
        unwrap(iosVoiceReadiness());
        if (signal.aborted || bootAdapter !== adapter) throw new Error('STALE_REVISION: Voice owner is unavailable');
        let reply: unknown;
        try { reply = checked(owner()); } catch { throw new Error('STALE_REVISION: Voice owner is unavailable'); }
        if (reply !== '') throw new Error('STALE_REVISION: Voice owner is unavailable');
    };
    current(); return current;
};
const iosVoiceJSON = (json: string, limit: number): unknown => {
    if (typeof json !== 'string' || json.length > limit || new TextEncoder().encode(json).byteLength > limit)
        throw new Error('INVALID_INPUT: Voice input exceeds its bound');
    return completionJson(json, limit);
};

const aiTextConfigurationMethods = createNativeAITextConfigurationMethods({
    readiness: () => {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
            || !bootAdapter.concurrentWritesGuarded || isSandboxMode() || isWorkspaceTransitionActive())
            return { ok: false, error: { code: 'NOT_READY', message: 'AI text configuration requires current personal storage' } };
        return { ok: true, value: null };
    },
    save: async () => {
        try { await flushPendingSave(); requireSaved(); return { ok: true, value: null }; }
        catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'AI text configuration save could not be confirmed' } }; }
    },
    t: () => backupTranslate,
});
const aiTextConfigurationOwner = (owner: () => unknown, signal: AbortSignal) => {
    if (typeof owner !== 'function') throw new Error('INVALID_INPUT: AI text configuration needs private owner authority');
    return () => {
        if (signal.aborted || checked(owner()) !== '') throw new Error('STALE_REVISION: AI text configuration owner is unavailable');
    };
};
type AITextConfigurationSession = {
    id: string; provider: 'openai' | 'gemini' | 'anthropic'; version: 1 | 2; adapter: NonNullable<ReturnType<typeof getStorageAdapter>>; generation: number;
    settings: ReturnType<typeof useTaskStore.getState>['settings']; frozen: unknown;
    extraBodyAttempts: Map<string, { expected: unknown; pending: { authority: unknown[]; frozen: unknown } | null }>;
    acceptedAdvance: { generation: number; settings: ReturnType<typeof useTaskStore.getState>['settings']; frozen: unknown } | null;
};
let iosAITextConfigurationSession: AITextConfigurationSession | null = null;
type AIEndpointRetry = { session: string; requestId: string; expected: unknown; authority: unknown[]; frozen: unknown };
let iosAITextEndpointRetry: AIEndpointRetry | null = null;
const aiTextSnapshotReferences = () => {
    const state = useTaskStore.getState();
    return [state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings];
};
const currentAITextConfigurationSession = (id: string, requireSettings = true, requirePersistence = true) => {
    const session = iosAITextConfigurationSession, state = useTaskStore.getState(), status = getPersistenceStatus();
    if (globalThis.__mindwtrHostPlatform !== 'ios' || !session || session.id !== id || bootAdapter !== session.adapter
        || getStorageAdapter() !== session.adapter || status.generation !== session.generation || isSandboxMode()
        || isWorkspaceTransitionActive() || state.isLoading || state.editLockCount > 0
        || requireSettings && ((state.settings.ai?.provider ?? 'openai') !== session.provider || state.settings !== session.settings || !taskEditValuesEqual(state.settings, session.frozen))) {
        iosAITextConfigurationSession = null;
        throw new Error('STALE_REVISION: AI text configuration session changed');
    }
    if (requirePersistence) requireSaved(); return session;
};
const retainAITextConfigurationAdvance = (session: AITextConfigurationSession) => {
    const state = useTaskStore.getState();
    if (iosAITextConfigurationSession !== session || bootAdapter !== session.adapter || getStorageAdapter() !== session.adapter
        || isSandboxMode() || isWorkspaceTransitionActive() || state.isLoading || state.editLockCount > 0)
        throw new Error('STALE_REVISION: AI text configuration session changed');
    session.acceptedAdvance = { generation: getPersistenceStatus().generation, settings: state.settings,
        frozen: JSON.parse(JSON.stringify(state.settings)) };
};
const refreshAITextConfigurationSession = (id: string) => {
    const retained = iosAITextConfigurationSession, advance = retained?.id === id ? retained.acceptedAdvance : null;
    if (!retained || !advance) { currentAITextConfigurationSession(id); return; }
    const state = useTaskStore.getState();
    if (bootAdapter !== retained.adapter || getStorageAdapter() !== retained.adapter || isSandboxMode() || isWorkspaceTransitionActive()
        || state.isLoading || state.editLockCount > 0 || getPersistenceStatus().generation !== advance.generation
        || state.settings !== advance.settings || !taskEditValuesEqual(state.settings, advance.frozen)) {
        iosAITextConfigurationSession = null;
        throw new Error('STALE_REVISION: AI text configuration saved transition changed');
    }
    requireSaved();
    retained.generation = advance.generation; retained.settings = advance.settings; retained.frozen = advance.frozen;
    retained.acceptedAdvance = null;
};

const aiModelDiscoveryOwner = (owner: (json: string) => unknown) => {
    const ask = (request: object): string => {
        try {
            const raw = checked(owner(JSON.stringify(request)));
            if (typeof raw === 'string') return raw;
        } catch { }
        throw new Error('NOT_READY: AI model discovery owner is unavailable');
    };
    const readReply = (request: object): unknown => {
        try { return completionJson(ask(request), 32 * 1024); }
        catch { throw new Error('NOT_READY: AI model discovery metadata is unavailable'); }
    };
    return { ask, readReply };
};

const runAITextExtraBody = async (input: Record<string, unknown>, owner: (json: string) => unknown, signal: AbortSignal) => {
    const saving = input.op === 'save-extra-body', sessionId = input.session as string;
    const fields = saving ? ['session', 'op', 'expected', 'attempt', 'value'] : ['session', 'op', 'expected'];
    if (!taskEditValuesEqual(Object.keys(input).sort(), fields.sort())
        || saving && (typeof input.attempt !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.attempt)
            || typeof input.value !== 'string' || !readNativeAIExtraBodyInput(input.value)))
        throw new Error('INVALID_INPUT: AI extra body parameters are invalid');
    const session = iosAITextConfigurationSession;
    const admit = (phase = 'current') => {
        const state = useTaskStore.getState();
        if (signal.aborted || globalThis.__mindwtrHostPlatform !== 'ios' || !session || session.id !== sessionId
            || session.version !== 2 || session.provider !== 'openai' || iosAITextConfigurationSession !== session
            || bootAdapter !== session.adapter || getStorageAdapter() !== session.adapter
            || isSandboxMode() || isWorkspaceTransitionActive() || state.isLoading || state.editLockCount > 0
            || checked(owner(JSON.stringify({ phase }))) !== '')
            throw new Error('STALE_REVISION: AI extra body editor changed');
    };
    admit();
    if (!session) throw new Error('STALE_REVISION: AI extra body editor changed');
    const attempt = input.attempt as string, value = input.value as string;
    const retained = saving ? session.extraBodyAttempts.get(attempt) : undefined;
    if (retained && !taskEditValuesEqual(retained.expected, input.expected))
        throw new Error('STALE_REVISION: AI extra body attempt changed');
    const unavailable = async (): Promise<never> => { throw new Error('NOT_READY: AI text configuration storage is private'); };
    const host: NativeAIHost = { platform: { isFossBuild },
        storage: { getItem: unavailable, setItem: unavailable, removeItem: unavailable },
        secrets: { get: unavailable, set: unavailable, delete: unavailable }, fetch: unavailable };
    iosConfigurationAIHost = host;
    try {
        const intent = { requestId: attempt, text: value };
        if (saving) {
            const saved = contract.probeAIExtraBodyParamsOutcome(intent);
            if (saved) {
                if (!saved.ok) throw new Error('INVALID_INPUT: AI extra body attempt changed');
                if (!retained) throw new Error('STALE_REVISION: AI extra body attempt belongs to another editor');
                admit(); return unwrap(saved);
            }
        }
        const pending = retained?.pending;
        const current = () => {
            admit();
            if (currentAITextConfigurationSession(sessionId, true, !pending) !== session
                || pending && (!aiTextSnapshotReferences().every((value, index) => value === pending.authority[index])
                    || !taskEditValuesEqual(pending.authority, pending.frozen)))
                throw new Error('STALE_REVISION: AI extra body snapshot changed');
        };
        current();
        if (retained && !pending) throw new Error('STALE_REVISION: AI extra body attempt has no saved proof');
        if (!pending) {
            const options = unwrap(await aiTextConfigurationMethods.optionsV2({}, current));
            if (!taskEditValuesEqual(options.expected, input.expected))
                throw new Error('STALE_REVISION: AI text configuration changed');
        }
        if (!saving) {
            let parsed;
            try { parsed = readNativeAIExtraBodyInput(formatOpenAIExtraBodyParams(session.settings.ai?.openAIExtraBodyParams)); }
            catch { }
            if (!parsed) throw new Error('INVALID_INPUT: AI extra body parameters are unavailable');
            current(); return { value: parsed.formatted };
        }
        if (!retained && session.extraBodyAttempts.size >= 128)
            throw new Error('NOT_READY: Reopen the AI extra body editor');
        const record = retained ?? { expected: input.expected, pending: null };
        current(); admit('extra-body-save');
        session.extraBodyAttempts.set(attempt, record);
        try {
            let written = await contract.setAIExtraBodyParams(intent);
            if (pending && !written.ok && written.error.code === 'SAVE_FAILED') {
                current(); await useTaskStore.getState().persistSnapshot(); await flushPendingSave(); requireSaved();
                admit();
                if (!aiTextSnapshotReferences().every((value, index) => value === pending.authority[index])
                    || !taskEditValuesEqual(pending.authority, pending.frozen))
                    throw new Error('STALE_REVISION: AI extra body snapshot changed');
                written = await contract.setAIExtraBodyParams(intent);
            }
            if (!written.ok) {
                if (written.error.code === 'SAVE_FAILED') {
                    const authority = aiTextSnapshotReferences();
                    record.pending = { authority, frozen: JSON.parse(JSON.stringify(authority)) };
                    session.generation = getPersistenceStatus().generation; session.settings = useTaskStore.getState().settings;
                    session.frozen = JSON.parse(JSON.stringify(session.settings)); session.acceptedAdvance = null;
                }
                throw new Error('ACTION_FAILED: AI extra body save could not be confirmed');
            }
            record.pending = null;
            retainAITextConfigurationAdvance(session); refreshAITextConfigurationSession(sessionId);
            admit(); return written.value;
        } catch {
            throw new Error('ACTION_FAILED: AI extra body save could not be confirmed');
        }
    } finally { if (iosConfigurationAIHost === host) iosConfigurationAIHost = null; }
};

const runAITextConfigurationSensitive = async (json: string, owner: (json: string) => unknown, signal: AbortSignal, version: 1 | 2) => {
    if (iosConfigurationAIActive) throw new Error('NOT_READY: AI text configuration is already active');
    iosConfigurationAIActive = true;
    try {
            const input = completionJson(json, 64 * 1024);
            if (!input || typeof input !== 'object' || Array.isArray(input) || !('session' in input) || typeof input.session !== 'string'
                || !('op' in input) || !['read-endpoint', 'save-endpoint', 'save-credential', 'clear-credential', ...(version === 2 ? ['read-extra-body', 'save-extra-body'] : [])].includes(String(input.op))
                || !('expected' in input) || typeof owner !== 'function' || iosConfigurationAIHost || iosCaptureAIHost || iosTaskAI?.active || iosInboxAI?.active || iosReviewAI?.active)
                throw new Error('INVALID_INPUT: AI text configuration request is invalid');
            if (input.op === 'read-extra-body' || input.op === 'save-extra-body')
                return await runAITextExtraBody(input as Record<string, unknown>, owner, signal);
            const op = input.op, sessionId = input.session;
            const writing = op === 'save-endpoint' || op === 'save-credential';
            if (!taskEditValuesEqual(Object.keys(input).sort(), (writing ? ['session', 'op', 'expected', 'value'] : ['session', 'op', 'expected']).sort())
                || writing && (!('value' in input) || typeof input.value !== 'string'))
                throw new Error('INVALID_INPUT: AI text configuration request is invalid');
            const retry = op === 'save-endpoint' && iosAITextEndpointRetry?.session === sessionId ? iosAITextEndpointRetry : null;
            if (retry && (!taskEditValuesEqual(retry.expected, input.expected)
                || !aiTextSnapshotReferences().every((value, index) => value === retry.authority[index])
                || !taskEditValuesEqual(retry.authority, retry.frozen)))
                throw new Error('STALE_REVISION: AI text endpoint retry changed');
            const session = currentAITextConfigurationSession(sessionId, true, !retry);
            if (session.version !== version || (op === 'read-endpoint' || op === 'save-endpoint') && session.provider !== 'openai')
                throw new Error('STALE_REVISION: AI text configuration provider changed');
            const admit = (request: object) => {
                if (checked(owner(JSON.stringify(request))) !== '') throw new Error('STALE_REVISION: AI text configuration owner changed');
            };
            const current = () => {
                if (signal.aborted || currentAITextConfigurationSession(sessionId, true, !retry) !== session)
                    throw new Error('STALE_REVISION: AI text configuration owner changed');
                admit({ phase: 'current' });
            };
            if (!retry) {
                const options = version === 2 ? unwrap(await aiTextConfigurationMethods.optionsV2({}, current))
                    : unwrap(await aiTextConfigurationMethods.options({}, current));
                if (!taskEditValuesEqual(options.expected, input.expected)) throw new Error('STALE_REVISION: AI text configuration changed');
            }
            current();
            if (op === 'read-endpoint') {
                const value = session.settings.ai?.baseUrl;
                if (value !== undefined && (typeof value !== 'string' || value.length > 2000))
                    throw new Error('INVALID_INPUT: AI text endpoint is unavailable');
                return { value: value ?? '' };
            }
            const value = writing && 'value' in input && typeof input.value === 'string' ? input.value : '';
            if (op === 'save-credential' && !value.trim()) throw new Error('INVALID_INPUT: Enter a replacement credential');
            const unavailable = async (): Promise<never> => { throw new Error('NOT_READY: AI text configuration storage is private'); };
            const host: NativeAIHost = {
                platform: { isFossBuild }, storage: { getItem: unavailable, setItem: unavailable, removeItem: unavailable },
                secrets: { get: unavailable, set: unavailable, delete: unavailable }, fetch: unavailable,
                saveConfigurationKey: async (provider, replacement) => {
                    current();
                    if (provider !== session.provider) throw new Error('STALE_REVISION: AI text provider changed');
                    admit({ phase: 'credential', value: replacement });
                    current();
                },
            };
            iosConfigurationAIHost = host;
            const requestId = retry?.requestId ?? generateUUID();
            try {
                current();
                let result;
                if (op === 'save-endpoint') {
                    const intent = { requestId, field: 'assistant', value } satisfies Parameters<typeof contract.setAIEndpoint>[0];
                    let written = await contract.setAIEndpoint(intent);
                    if (retry && !written.ok && written.error.code === 'SAVE_FAILED') {
                        current();
                        await useTaskStore.getState().persistSnapshot(); await flushPendingSave(); requireSaved();
                        admit({ phase: 'current' });
                        if (!aiTextSnapshotReferences().every((value, index) => value === retry.authority[index])
                            || !taskEditValuesEqual(retry.authority, retry.frozen)) throw new Error('STALE_REVISION: AI text endpoint retry changed');
                        retainAITextConfigurationAdvance(session); refreshAITextConfigurationSession(sessionId);
                        current(); written = await contract.setAIEndpoint(intent);
                    }
                    result = unwrap(written);
                } else result = unwrap(await contract.setAIKey({ requestId, field: 'assistant', provider: session.provider, value }));
                admit({ phase: 'current' });
                retainAITextConfigurationAdvance(session); refreshAITextConfigurationSession(sessionId);
                if (op === 'save-endpoint') iosAITextEndpointRetry = null;
                return op === 'save-endpoint' && 'changed' in result ? { changed: result.changed } : { completed: true };
            } catch {
                if (op === 'save-endpoint' && getPersistenceStatus().failed) {
                    const authority = aiTextSnapshotReferences();
                    iosAITextEndpointRetry = { session: sessionId, requestId, expected: input.expected, authority,
                        frozen: JSON.parse(JSON.stringify(authority)) };
                    session.generation = getPersistenceStatus().generation;
                    session.settings = useTaskStore.getState().settings;
                    session.frozen = JSON.parse(JSON.stringify(session.settings));
                    session.acceptedAdvance = null;
                }
                throw new Error('ACTION_FAILED: AI text configuration could not be confirmed');
            } finally { if (iosConfigurationAIHost === host) iosConfigurationAIHost = null; }
    } finally { iosConfigurationAIActive = false; }
};

let iosVoiceEndpointSession: Omit<AITextConfigurationSession, 'provider' | 'version' | 'acceptedAdvance' | 'extraBodyAttempts'> | null = null;
let iosVoiceEndpointRetry: AIEndpointRetry | null = null;
const currentVoiceEndpointSession = (id: string, retry = false) => {
    unwrap(iosVoiceReadiness());
    const session = iosVoiceEndpointSession, state = useTaskStore.getState();
    if (!session || session.id !== id || session.adapter !== bootAdapter || state.isLoading || state.editLockCount > 0
        || state.settings.ai?.speechToText?.provider !== 'openai' || getPersistenceStatus().generation !== session.generation
        || state.settings !== session.settings || !taskEditValuesEqual(state.settings, session.frozen))
        throw new Error('STALE_REVISION: Voice endpoint session changed');
    if (!retry) requireSaved();
    return session;
};
const runVoiceEndpointSensitive = async (json: string, owner: (json: string) => unknown, signal: AbortSignal) => {
    if (iosConfigurationAIActive || iosConfigurationAIHost || iosCaptureAIHost || iosTaskAI?.active || iosInboxAI?.active || iosReviewAI?.active)
        throw new Error('NOT_READY: AI configuration is already active');
    iosConfigurationAIActive = true;
    try {
        const input = iosVoiceJSON(json, 32 * 1024) as Record<string, unknown>;
        if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.session !== 'string'
            || typeof owner !== 'function' || !['read-endpoint', 'save-endpoint'].includes(String(input.op))
            || !taskEditValuesEqual(Object.keys(input).sort(), (input.op === 'save-endpoint'
                ? ['expected', 'op', 'session', 'value'] : ['expected', 'op', 'session']).sort())
            || input.op === 'save-endpoint' && (typeof input.value !== 'string' || input.value.length > 2000))
            throw new Error('INVALID_INPUT: Voice endpoint request is invalid');
        const id = input.session;
        const retry = input.op === 'save-endpoint' && iosVoiceEndpointRetry?.session === id ? iosVoiceEndpointRetry : null;
        const unchangedRetry = () => !retry || taskEditValuesEqual(input.expected, retry.expected)
            && aiTextSnapshotReferences().every((value, index) => value === retry.authority[index])
            && taskEditValuesEqual(retry.authority, retry.frozen);
        if (!unchangedRetry()) throw new Error('STALE_REVISION: Voice endpoint retry changed');
        const session = currentVoiceEndpointSession(id, Boolean(retry));
        const admit = () => {
            if (signal.aborted || checked(owner(JSON.stringify({ phase: 'current' }))) !== '')
                throw new Error('STALE_REVISION: Voice endpoint owner changed');
        };
        const current = () => { currentVoiceEndpointSession(id, Boolean(retry)); admit(); };
        current();
        if (!retry && !taskEditValuesEqual(unwrap(await iosVoiceMethods.settingsOptions({}, current)).expected, input.expected))
            throw new Error('STALE_REVISION: Voice settings changed');
        if (input.op === 'read-endpoint') {
            const value = session.settings.ai?.speechToText?.baseUrl;
            if (value !== undefined && (typeof value !== 'string' || value.length > 4096))
                throw new Error('INVALID_INPUT: Voice endpoint is unavailable');
            return { value: value ?? '' };
        }
        const unavailable = async (): Promise<never> => { throw new Error('NOT_READY: Voice endpoint storage is private'); };
        const host: NativeAIHost = { platform: { isFossBuild },
            storage: { getItem: unavailable, setItem: unavailable, removeItem: unavailable },
            secrets: { get: unavailable, set: unavailable, delete: unavailable }, fetch: unavailable };
        const refresh = () => {
            unwrap(iosVoiceReadiness()); admit();
            if (iosVoiceEndpointSession !== session || bootAdapter !== session.adapter || useTaskStore.getState().editLockCount > 0
                || useTaskStore.getState().isLoading || useTaskStore.getState().settings.ai?.speechToText?.provider !== 'openai')
                throw new Error('STALE_REVISION: Voice endpoint session changed');
            session.generation = getPersistenceStatus().generation;
            session.settings = useTaskStore.getState().settings;
            session.frozen = JSON.parse(JSON.stringify(session.settings));
        };
        const requestId = retry?.requestId ?? generateUUID();
        iosConfigurationAIHost = host;
        try {
            current();
            const intent = { requestId, field: 'speech', value: input.value as string } as const;
            let written = await contract.setAIEndpoint(intent);
            if (retry && !written.ok && written.error.code === 'SAVE_FAILED') {
                current();
                await useTaskStore.getState().persistSnapshot(); await flushPendingSave(); requireSaved(); admit();
                if (!unchangedRetry()) throw new Error('STALE_REVISION: Voice endpoint retry changed');
                refresh(); current(); written = await contract.setAIEndpoint(intent);
            }
            const result = unwrap(written);
            refresh(); requireSaved(); iosVoiceEndpointRetry = null;
            return { changed: result.changed };
        } catch {
            if (getPersistenceStatus().failed) {
                const authority = aiTextSnapshotReferences();
                iosVoiceEndpointRetry = { session: id, requestId, expected: input.expected, authority,
                    frozen: JSON.parse(JSON.stringify(authority)) };
                try { refresh(); } catch { }
            }
            throw new Error('ACTION_FAILED: Voice endpoint could not be confirmed');
        } finally { if (iosConfigurationAIHost === host) iosConfigurationAIHost = null; }
    } finally { iosConfigurationAIActive = false; }
};

const aiRequestTimeoutMethods = createNativeAIRequestTimeoutMethods({
    readiness: () => {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
            || !bootAdapter.concurrentWritesGuarded || isSandboxMode() || isWorkspaceTransitionActive())
            return { ok: false, error: { code: 'NOT_READY', message: 'AI timeout requires current personal storage' } };
        return { ok: true, value: null };
    },
    save: async () => {
        try { await flushPendingSave(); requireSaved(); return { ok: true, value: null }; }
        catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'AI timeout save could not be confirmed' } }; }
    },
});
const aiRequestTimeoutOwner = (owner: () => unknown, signal: AbortSignal) => {
    if (typeof owner !== 'function') throw new Error('INVALID_INPUT: AI timeout needs private owner authority');
    return () => {
        if (signal.aborted || owner() !== '') throw new Error('STALE_REVISION: AI timeout owner is unavailable');
    };
};

const aiReasoningEffortMethods = createNativeAIReasoningEffortMethods({
    readiness: () => {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
            || !bootAdapter.concurrentWritesGuarded || isSandboxMode() || isWorkspaceTransitionActive())
            return { ok: false, error: { code: 'NOT_READY', message: 'AI reasoning effort requires current personal storage' } };
        return { ok: true, value: null };
    },
    save: async () => {
        try { await flushPendingSave(); requireSaved(); return { ok: true, value: null }; }
        catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'AI reasoning effort save could not be confirmed' } }; }
    },
});
const aiReasoningEffortOwner = (owner: () => unknown, signal: AbortSignal) => {
    if (typeof owner !== 'function') throw new Error('INVALID_INPUT: AI reasoning effort needs private owner authority');
    return () => {
        if (signal.aborted || owner() !== '') throw new Error('STALE_REVISION: AI reasoning effort owner is unavailable');
    };
};

const aiGeminiThinkingBudgetMethods = createNativeAIGeminiThinkingBudgetMethods({
    readiness: () => {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
            || !bootAdapter.concurrentWritesGuarded || isSandboxMode() || isWorkspaceTransitionActive())
            return { ok: false, error: { code: 'NOT_READY', message: 'AI Gemini thinking budget requires current personal storage' } };
        return { ok: true, value: null };
    },
    save: async () => {
        try { await flushPendingSave(); requireSaved(); return { ok: true, value: null }; }
        catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'AI Gemini thinking budget save could not be confirmed' } }; }
    },
});
const aiGeminiThinkingBudgetOwner = (owner: () => unknown, signal: AbortSignal) => {
    if (typeof owner !== 'function') throw new Error('INVALID_INPUT: AI Gemini thinking budget needs private owner authority');
    return () => {
        if (signal.aborted || owner() !== '') throw new Error('STALE_REVISION: AI Gemini thinking budget owner is unavailable');
    };
};


let pomodoroWarmAdmission: { planJSON: string; assertCurrent: () => void } | null = null;
const pomodoroJSON = (json: string, maximum = MAX_NATIVE_POMODORO_PLAN_BYTES): unknown => {
    if (typeof json !== 'string' || json.length > maximum || new TextEncoder().encode(json).byteLength > maximum)
        throw new Error('INVALID_INPUT: Invalid Pomodoro transport');
    try { return JSON.parse(json) as unknown; } catch { throw new Error('INVALID_INPUT: Invalid Pomodoro transport'); }
};
const pomodoroAdapter = () => {

    if ((globalThis.__mindwtrHostPlatform !== 'ios' && globalThis.__mindwtrHostPlatform !== 'android')
        || !bootAdapter || getStorageAdapter() !== bootAdapter
        || !bootAdapter.concurrentWritesGuarded || isSandboxMode() || isWorkspaceTransitionActive())
        throw new Error('NOT_READY: Pomodoro requires current validated personal storage');
    return bootAdapter;
};
const readSavedNativePomodoro = async () => {
    const adapter = pomodoroAdapter();
    const ready = () => {
        requireSaved(); unwrap(contract.getDataSettings());
        const status = getPersistenceStatus();
        if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying)
            throw new Error('NOT_READY: Pomodoro presentation waits for saved data');
    };
    ready();
    const before = useTaskStore.getState();
    const requireBaseline = async () => {
        if (!await adapter.readRowBaseline())
            throw new Error('STALE_REVISION: Pomodoro saved data changed; reload before reading');
    };
    await requireBaseline();
    const session = await adapter.readPomodoroSession();
    await requireBaseline();
    ready();
    const current = useTaskStore.getState();
    if (pomodoroAdapter() !== adapter || current.tasks !== before.tasks || current.settings !== before.settings)
        throw new Error('STALE_REVISION: Pomodoro presentation changed; read again');
    return { raw: session.raw, current };
};
const preparePomodoroRequest = async (requestJSON: string, watchSourceJSON?: string) => {
    pomodoroWarmAdmission = null;
    const adapter = pomodoroAdapter();
    const stale = () => new Error('STALE_REVISION: Pomodoro preparation is no longer current');
    const ready = () => {
        if (pomodoroAdapter() !== adapter) throw stale();
        requireSaved(); unwrap(contract.getDataSettings());
        const status = getPersistenceStatus();
        if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying
            || useTaskStore.getState().editLockCount > 0 || useTaskStore.getState().isLoading) throw stale();
        return status;
    };
    ready();
    if (watchSourceJSON !== undefined) {
        parseNativeWatchPomodoroSource(watchSourceJSON);
        const saved = await adapter.readWatchPomodoroPlan(watchSourceJSON);
        ready();
        if (saved) return { kind: 'prepared', planJSON: JSON.stringify(saved) };
    }
    const status = ready(), state = useTaskStore.getState();
    const references = [state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings];
    const frozen = JSON.parse(JSON.stringify(references)) as unknown;
    const assertCurrent = () => {
        if (ready().generation !== status.generation) throw stale();
        const current = useTaskStore.getState();
        const values = [current._allTasks, current._allProjects, current._allSections, current._allAreas, current._allPeople, current.settings];
        if (current.lastDataChangeAt !== state.lastDataChangeAt || !values.every((value, index) => value === references[index])
            || !taskEditValuesEqual(values, frozen)) throw stale();
    };
    assertCurrent();
    if (!await adapter.readRowBaseline()) throw stale();
    assertCurrent();
    const data = await adapter.getData({ rawTasks: true });
    assertCurrent();
    const canonical = [data.tasks, data.projects, data.sections ?? [], data.areas ?? [], data.people ?? [], stripSensitiveSettings(data.settings)];
    if (!taskEditValuesEqual(references, canonical)
        && !taskEditValuesEqual(references, [data.tasks.map((task) => normalizeTaskForLoad(task)), ...canonical.slice(1)])) throw stale();
    const session = await adapter.readPomodoroSession();
    assertCurrent();
    let request: NativePomodoroRequest;
    if (watchSourceJSON !== undefined) {
        const source = parseNativeWatchPomodoroSource(watchSourceJSON), now = new Date();
        const options = data.settings.gtd?.pomodoro;
        const wanted = source.taskId ?? session.state?.session.selectedTaskId;
        const linked = options?.linkTask === true && wanted
            ? data.tasks.find(task => task.id === wanted && !task.deletedAt && !isTaskCancelled(task) && isTaskActionable(task)) : undefined;
        request = { action: 'watch', requestId: source.id, sourceJSON: watchSourceJSON,
            observedAtMs: now.getTime(), localDayKey: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
            autoStart: { autoStartFocus: options?.autoStartFocus === true, autoStartBreaks: options?.autoStartBreaks === true },
            durations: sanitizePomodoroDurations(options?.customDurations), selectedTaskId: linked?.id ?? null };
    } else {
        const parsed = pomodoroJSON(requestJSON) as NativePomodoroRequest;
        request = parsed.action === 'adoptLegacy' ? parsed : pomodoroJSON(requestJSON, 8192) as NativePomodoroRequest;
        if (request.action === 'watch') throw new Error('INVALID_INPUT: Watch timer requires its source owner');
    }
    const legacy = request.action === 'adoptLegacy' && typeof request.legacy?.sessionRaw === 'string'
        ? JSON.parse(request.legacy.sessionRaw) as { selectedTaskId?: unknown } | null : null;
    const selected = request.action === 'adoptLegacy'
        ? typeof legacy?.selectedTaskId === 'string' ? legacy.selectedTaskId : undefined
        : session.state?.session.selectedTaskId;
    const before = (id: string) => {
        const matches = data.tasks.filter((task) => task.id === id);
        if (matches.length > 1 || (matches.length === 1 && !hasRawReadRow(matches[0]))) throw stale();
        const row = matches.length === 1 ? [...rawReadRow(matches[0], taskToSqliteRow(matches[0])).row] as (string | number | null)[] : null;
        if (row && row.length !== TASK_SQLITE_COLUMNS.length) throw stale();
        return { id, row };
    };
    const plan = prepareNativePomodoroTransition({ request, session, target: selected ? before(selected) : null,
        owed: request.action === 'adoptLegacy' ? nativePomodoroOwedTaskIds(request).map(before) : [],
        deviceId: request.action === 'initialize' ? null : typeof data.settings.deviceId === 'string' ? data.settings.deviceId : null });
    assertCurrent();
    if (!plan) return { kind: 'noop' };
    const planJSON = JSON.stringify(validatePreparedNativePomodoroTransition(plan));
    pomodoroWarmAdmission = { planJSON, assertCurrent };
    return { kind: 'prepared', planJSON };
};
let iosPomodoroAlarmTurn: { token: string; current: () => Promise<void> } | null = null;
const requirePomodoroAlarmTurn = async (token: string) => {
    const turn = iosPomodoroAlarmTurn;
    if (!turn || turn.token !== token) throw new Error('NOT_READY: Pomodoro alarm turn is unavailable');
    await turn.current();
    if (iosPomodoroAlarmTurn !== turn) throw new Error('NOT_READY: Pomodoro alarm turn changed');
};
let appleReminderWarmAdmission: { planJSON: string; assertCurrent: () => void } | null = null;
const appleReminderAdapter = () => {
    if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
        || !bootAdapter.concurrentWritesGuarded || isSandboxMode() || isWorkspaceTransitionActive())
        throw new Error('NOT_READY: Reminders import requires current personal storage');
    return bootAdapter;
};
const appleReminderJSON = (json: string): unknown => {
    if (typeof json !== 'string' || json.length > 8 * 1024 * 1024 || new TextEncoder().encode(json).byteLength > 8 * 1024 * 1024)
        throw new Error('INVALID_INPUT: Reminders import item exceeds its transport limit');
    try { return JSON.parse(json) as unknown; } catch { throw new Error('INVALID_INPUT: Invalid Reminders import item'); }
};
const appleReminderRegistry = (raw: string | null) => {
    if (raw !== null && (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 1024 * 1024))
        throw new Error('INVALID_INPUT: Reminders registry exceeds its limit');
    let value: unknown;
    try { value = raw === null ? {} : JSON.parse(raw); } catch { throw new Error('INVALID_INPUT: Reminders registry is malformed'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT: Reminders registry is malformed');
    const fields = value as Record<string, unknown>;
    if (['selectedListId', 'selectedListTitle'].some((name) => name in fields && typeof fields[name] !== 'string')
        || ['deleteImportedReminders', 'autoImportOnOpen'].some((name) => name in fields && typeof fields[name] !== 'boolean')
        || 'importedReminderIds' in fields && (!Array.isArray(fields.importedReminderIds)
            || fields.importedReminderIds.some((id) => typeof id !== 'string')))
        throw new Error('INVALID_INPUT: Reminders registry is malformed');
    return normalizeAppleRemindersImportSettings(value);
};
const appleReminderItemOwner = createNativeAppleReminderImportOwner({
    readiness: () => {
        try { appleReminderAdapter(); requireSaved(); unwrap(contract.getDataSettings()); return { ok: true, value: null }; }
        catch { return { ok: false, error: { code: 'NOT_READY', message: 'Reminders import is not ready' } }; }
    },
    save: async () => {
        try { await flushPendingSave(); requireSaved(); return { ok: true, value: null }; }
        catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Reminders import save needs recovery' } }; }
    },
});
const backupTranslate = (key: string, values?: Record<string, number | string>): string => {
    const template = unwrap(contract.getStrings({ keys: [key] })).strings[key];
    if (typeof template !== 'string') throw new Error('INVALID_INPUT: Backup translation is unavailable');
    return values ? formatI18nTemplate(template, values) : template;
};


let captureLinesWarmAdmission: { planJSON: string; assertCurrent: () => void } | null = null;
const captureLinesJson = (json: string): unknown => {
    if (typeof json !== 'string' || json.length > 8 * 1024 * 1024
        || new TextEncoder().encode(json).byteLength > 8 * 1024 * 1024) throw new Error('INVALID_INPUT: Prepared lines are too large');
    let plan: unknown;
    try { plan = JSON.parse(json); } catch { throw new Error('INVALID_INPUT: Prepared lines are malformed'); }
    return plan;
};
const requireCaptureLinesAdmission = (planJSON: string) => {
    if (!captureLinesWarmAdmission || captureLinesWarmAdmission.planJSON !== planJSON) {
        throw new Error('STALE_REVISION: Capture lines preparation is no longer current');
    }
    captureLinesWarmAdmission.assertCurrent();
};


const attachmentDraftJson = (json: string): unknown => {
    try {
        if (typeof json === 'string' && json.length <= 8 * 1024 * 1024
            && new TextEncoder().encode(json).byteLength <= 8 * 1024 * 1024) return JSON.parse(json);
    } catch {                                                                     }
    throw new Error('INVALID_INPUT');
};
const attachmentCleanupJson = (json: string, maxBytes: number): unknown => {
    try {
        if (typeof json === 'string' && json.length <= maxBytes
            && new TextEncoder().encode(json).byteLength <= maxBytes) return JSON.parse(json);
    } catch {                                                         }
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

const nativeAttachmentFileInUse = (uri: string, owners: readonly (Task | Project)[]): boolean => {
    if (isAttachmentFileInUse(uri, owners)) return true;
    const counterpart = uri.startsWith('file:///private/var/') ? 'file:///var/' + uri.slice('file:///private/var/'.length)
        : uri.startsWith('file:///var/') ? 'file:///private/var/' + uri.slice('file:///var/'.length) : null;
    return counterpart !== null && isAttachmentFileInUse(counterpart, owners);
};

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

let attachmentSavePlan: AttachmentSavePlan | null = null;

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

const iosReminderEffects = createIosReminderMethods({
    capture: () => {
        const adapter = bootAdapter, generation = getPersistenceStatus().generation;
        return () => {
            try {
                if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
                    || getStorageAdapter() !== adapter || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error();
                requireSaved();
                const status = getPersistenceStatus();
                if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying
                    || status.generation !== generation || !contract.getDataSettings().ok) throw new Error();
            } catch { throw new Error('NOT_READY: Reminder reconciliation is unavailable'); }
        };
    },
    read: () => keyValue.multiGet([REMINDER_ALARM_MAP_STORAGE_KEY, NATIVE_REMINDER_STATE_STORAGE_KEY]),
    plan: (input) => contract.planReminderAlarms(input),
    acknowledged: async (mode, scheduled, cancelled, collapsed, rearmed, zoned) => {
        await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
            message: 'Native iOS reminders reconciled',
            context: { releaseCheck: 'v1.3.5/ios-reminder-apply', outcome: 'confirmed', mode,
                scheduled: String(scheduled), cancelled: String(cancelled) },
        }, { force: true });
        if (collapsed > 0) await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
            message: 'Native iOS reminder threads collapsed',
            context: { releaseCheck: 'v1.3.5/ios-reminder-thread-collapse', count: String(collapsed) },
        }, { force: true });
        if (rearmed > 0) await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
            message: 'Native iOS missing Snoozes recovered',
            context: { releaseCheck: 'v1.3.5/ios-reminder-snooze-recovery', count: String(rearmed) },
        }, { force: true });
        if (zoned > 0) await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
            message: 'Native iOS time-zoned repeating reminders admitted',
            context: { releaseCheck: 'v1.3.7/ios-reminder-time-zone', count: String(zoned) },
        }, { force: true });
    },
    observation: {
        subscribe: (changed) => useTaskStore.subscribe(nameNotifyListener('native-ios-reminders', (state, previous) => {
            if (shouldRescheduleReminderAlarms(state, previous)) changed();
        })),
        ready: () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
                || isSandboxMode() || isWorkspaceTransitionActive()) return false;
            requireSaved();
            const status = getPersistenceStatus();
            return !status.failed && !status.queued && !status.inFlight && !status.immediate && !status.retrying
                && contract.getDataSettings().ok;
        },
        rescheduleDelayMs: REMINDER_STORE_RESCHEDULE_DELAY_MS,
    },
});
const iosSearchUnavailable = () => new Error('NOT_READY: Native iOS search is unavailable');
const iosSearchSavedState = () => {
    const adapter = bootAdapter;
    if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || getStorageAdapter() !== adapter
        || isSandboxMode() || isWorkspaceTransitionActive()) throw iosSearchUnavailable();
    requireSaved();
    const status = getPersistenceStatus();
    if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying
        || !contract.getDataSettings().ok) throw iosSearchUnavailable();
    return { adapter, generation: status.generation, state: useTaskStore.getState() };
};
const readIOSWidgetNext = (includeActions: boolean) => {
    const unavailable = () => new Error('NOT_READY: Native iOS widget Next snapshot is unavailable');
    const adapter = bootAdapter;
    const assertReady = () => {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
            || getStorageAdapter() !== adapter || isSandboxMode() || isWorkspaceTransitionActive()) throw unavailable();
        requireSaved();
        const status = getPersistenceStatus();
        if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying
            || !contract.getDataSettings().ok) throw unavailable();
        return status;
    };
    const before = assertReady(), state = useTaskStore.getState();
    const data = { tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
        areas: state._allAreas, settings: state.settings };
    const language = unwrap(contract.getStrings({ keys: [] })).language, locale = iosVoiceSystemLocale;
    const focusFilter = getFocusWidgetFilter();
    let focusFilterKey: string;
    type Item = { id: string; title: string; contextLabel: string | null; dueLabel: string | null;
        dueTone: 'overdue' | 'today' | 'normal' };
    let actions: { tokens: (string | null)[]; completeLabel: string; undoLabel: string } | null = null;
    let result: { version: 1; title: string; emptyMessage: string; totalCount: number; items: Item[] };
    try {
        focusFilterKey = focusWidgetFilterKey(focusFilter);
        const payload = createWidgetPayloadProjection(data, language,
            { listIds: ['next'], systemLocale: locale ?? undefined, focusFilter }).build(IOS_WIDGET_FAMILY_CACHE_ITEMS.medium);
        const next = payload.lists.next;
        const text = (value: unknown, limit: number, nonempty = false) =>
            typeof value === 'string' && value.length <= limit && (!nonempty || value.length > 0);
        if (!next || !text(next.title, 16_384) || !text(payload.emptyMessage, 16_384)
            || !Array.isArray(next.items) || next.items.length > IOS_WIDGET_FAMILY_CACHE_ITEMS.medium
            || !Number.isSafeInteger(next.totalCount) || next.totalCount < next.items.length) throw new Error();
        const identities = new Set<string>();
        const items = next.items.map((row): Item => {
            if (!text(row.id, 500, true) || identities.has(row.id) || !text(row.title, 16_384)
                || (row.contextLabel !== null && !text(row.contextLabel, 16_384))
                || (row.dueLabel !== null && !text(row.dueLabel, 100))
                || !['overdue', 'today', 'normal'].includes(row.dueTone)) throw new Error();
            identities.add(row.id);
            return { id: row.id, title: row.title, contextLabel: row.contextLabel,
                dueLabel: row.dueLabel, dueTone: row.dueTone };
        });
        result = { version: 1, title: next.title, emptyMessage: payload.emptyMessage, totalCount: next.totalCount, items };
        if (includeActions) {
            if (!text(payload.completeLabel, 16_384, true) || !text(payload.undoLabel, 16_384, true)) throw new Error();
            const tokens = next.items.map((row) => {
                if (row.completionToken === undefined) return null;
                if (typeof row.completionToken !== 'string'
                    || new TextEncoder().encode(row.completionToken).byteLength > 8192) throw new Error();
                const token: unknown = JSON.parse(row.completionToken);
                if (!Array.isArray(token) || token.length !== 4 || token[0] !== row.id) throw new Error();
                return row.completionToken;
            });
            actions = { tokens, completeLabel: payload.completeLabel, undoLabel: payload.undoLabel };
        }
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 1024 * 1024) throw new Error();
    } catch { throw new Error('INVALID_INPUT: Native iOS widget Next snapshot is invalid'); }
    const after = assertReady(), current = useTaskStore.getState();
    let sameFilter = false;
    try { sameFilter = focusWidgetFilterKey(getFocusWidgetFilter()) === focusFilterKey; } catch { }
    if (!sameFilter || before.generation !== after.generation || current._allTasks !== data.tasks || current._allProjects !== data.projects
        || current._allSections !== data.sections || current._allAreas !== data.areas || current.settings !== data.settings
        || unwrap(contract.getStrings({ keys: [] })).language !== language || iosVoiceSystemLocale !== locale) throw unavailable();
    try {
        logInfo('Native iOS Next widget snapshot', { scope: 'native-ios', force: true,
            context: { releaseCheck: 'v1.3.9/ios-widget-next-snapshot', count: String(result.items.length) } });
    } catch { }
    return actions ? { snapshot: JSON.stringify(result), ...actions } : result;
};


type IOSWidgetFamilySnapshot = { version: 1; payloads: Record<keyof typeof IOS_WIDGET_FAMILY_CACHE_ITEMS, string> };
const readIOSWidgetFamilies = (json: string): IOSWidgetFamilySnapshot => {
    const invalid = () => new Error('INVALID_INPUT: Native iOS widget family snapshot is invalid');
    const unavailable = () => new Error('NOT_READY: Native iOS widget family snapshot is unavailable');
    let input: unknown;
    try {
        if (typeof json !== 'string' || json.length > 128) throw invalid();
        input = JSON.parse(json);
    } catch { throw invalid(); }
    if (!record(input) || !exact(input, ['systemColorScheme'])
        || (input.systemColorScheme !== 'light' && input.systemColorScheme !== 'dark')) throw invalid();
    const systemColorScheme = input.systemColorScheme;
    const adapter = bootAdapter;
    const assertReady = () => {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
            || getStorageAdapter() !== adapter || isSandboxMode() || isWorkspaceTransitionActive()) throw unavailable();
        requireSaved();
        const status = getPersistenceStatus();
        if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying
            || !contract.getDataSettings().ok) throw unavailable();
        return status;
    };
    const before = assertReady(), state = useTaskStore.getState();
    const data = { tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
        areas: state._allAreas, settings: state.settings };
    const language = unwrap(contract.getStrings({ keys: [] })).language, locale = iosVoiceSystemLocale;
    const focusFilter = getFocusWidgetFilter();
    let filterKey: string;
    let result: IOSWidgetFamilySnapshot;
    try {
        filterKey = focusWidgetFilterKey(focusFilter);
        const projection = createPublishedWidgetProjection(createWidgetPayloadProjection(data, language,
            iosWidgetProjectionOptions({ systemColorScheme, systemLocale: locale ?? undefined, focusFilter })), language);
        result = { version: 1, payloads: {
            default: JSON.stringify(projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS.default)),
            small: JSON.stringify(projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS.small)),
            medium: JSON.stringify(projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS.medium)),
            large: JSON.stringify(projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS.large)),
            extraLarge: JSON.stringify(projection.build(IOS_WIDGET_FAMILY_CACHE_ITEMS.extraLarge)),
        } };
        if (!isNativeJsonWithinBytes({ ok: true, value: result })) throw invalid();
    } catch { throw invalid(); }
    const after = assertReady(), current = useTaskStore.getState();
    let sameFilter = false;
    try { sameFilter = focusWidgetFilterKey(getFocusWidgetFilter()) === filterKey; } catch {}
    if (!sameFilter || before.generation !== after.generation || current._allTasks !== data.tasks || current._allProjects !== data.projects
        || current._allSections !== data.sections || current._allAreas !== data.areas || current.settings !== data.settings
        || unwrap(contract.getStrings({ keys: [] })).language !== language || iosVoiceSystemLocale !== locale) throw unavailable();
    try {
        logInfo('Native iOS widget families read', { scope: 'native-ios', force: true,
            context: { releaseCheck: 'v1.3.9/ios-widget-family-read', operation: 'read', outcome: 'ready' } });
    } catch {}
    return result;
};


const readIOSWatchSnapshot = async () => {
    const unavailable = () => new Error('NOT_READY: Native iOS Watch snapshot is unavailable');
    const adapter = bootAdapter;
    const assertReady = () => {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
            || getStorageAdapter() !== adapter || !adapter.concurrentWritesGuarded
            || isSandboxMode() || isWorkspaceTransitionActive()) throw unavailable();
        requireSaved();
        const status = getPersistenceStatus();
        if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying
            || !contract.getDataSettings().ok) throw unavailable();
        return status;
    };
    const before = assertReady(), state = useTaskStore.getState();
    const data = { tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
        areas: state._allAreas, settings: state.settings };
    const language = unwrap(contract.getStrings({ keys: [] })).language, locale = iosVoiceSystemLocale;
    const focusFilter = getFocusWidgetFilter(), filterKey = focusWidgetFilterKey(focusFilter);
    const requireBaseline = async () => {
        assertReady();
        if (!adapter || !await adapter.readRowBaseline())
            throw new Error('STALE_REVISION: Watch saved data changed; reload before reading');
    };
    await requireBaseline();
    if (!adapter) throw unavailable();
    const saved = (await adapter.readPomodoroSession()).state?.session;
    const now = new Date(), options = data.settings.gtd?.pomodoro;
    const timerState = saved ? { ...saved.timerState,
        remainingSeconds: saved.timerState.isRunning
            ? Math.max(0, Math.ceil((Date.parse(saved.phaseEndsAt ?? '') - now.getTime()) / 1000))
            : saved.timerState.remainingSeconds,
    } : createPomodoroState(sanitizePomodoroDurations(options?.customDurations));
    const widget = createWidgetPayloadProjection(data, language,
        { focusFilter, systemLocale: locale ?? undefined }).build(WATCH_FOCUS_TASK_LIMIT);
    const byId = new Map(data.tasks.map((task) => [task.id, task]));
    const focus = widget.sections.flatMap((section) => section.items.map(({ id, title }) => {
        const task = byId.get(id);
        return { id, title, createdAt: task?.createdAt, description: task?.description, checklist: task?.checklist };
    }));
    const linked = options?.linkTask === true && saved?.selectedTaskId
        ? data.tasks.find((task) => task.id === saved.selectedTaskId && !task.deletedAt
            && !isTaskCancelled(task) && isTaskActionable(task)) : undefined;
    const result = buildWatchApplicationContext({ focus,
        pomodoro: { timerState, phaseEndsAt: saved?.phaseEndsAt, selectedTaskId: saved?.selectedTaskId, isHydrating: false },
        linkedTask: linked, completionAlertEnabled: options?.completionAlert !== false, now });
    await requireBaseline();
    const after = assertReady(), current = useTaskStore.getState();
    if (before.generation !== after.generation || current.lastDataChangeAt !== state.lastDataChangeAt
        || current._allTasks !== data.tasks || current._allProjects !== data.projects
        || current._allSections !== data.sections || current._allAreas !== data.areas || current.settings !== data.settings
        || focusWidgetFilterKey(getFocusWidgetFilter()) !== filterKey
        || unwrap(contract.getStrings({ keys: [] })).language !== language || iosVoiceSystemLocale !== locale) throw unavailable();
    try {
        logInfo('Native iOS Watch snapshot read', { scope: 'native-ios', force: true,
            context: { releaseCheck: 'v1.3.9/ios-watch-snapshot', operation: 'read', outcome: 'ready' } });
    } catch { }
    return result;
};

let iosSearchPrevious: { inputs: unknown[]; ready: boolean; now: number; day: string; zone: string;
    revision: number; nextAt: number | null } | null = null;
const requireReminderSignal = (signal: AbortSignal) => {
    if (signal.aborted) throw new Error('CANCELLED: Reminder reconciliation was cancelled');
};

const iosCalendarPushCapture = (signal: AbortSignal) => {
    const adapter = bootAdapter, generation = getPersistenceStatus().generation;
    const assertReady = () => {
        if (signal.aborted) throw new Error('CANCELLED: Calendar push was cancelled');
        if (!calendarPushAvailable || !iosCalendarPushLifecycle || !adapter || bootAdapter !== adapter
            || getStorageAdapter() !== adapter || isSandboxMode() || isWorkspaceTransitionActive()) {
            throw new Error('NOT_READY: Calendar push is unavailable');
        }
        requireSaved();
        const status = getPersistenceStatus();
        if (status.generation !== generation || status.failed || status.queued || status.inFlight
            || status.immediate || status.retrying || !contract.getDataSettings().ok) {
            throw new Error('NOT_READY: Calendar push requires settled storage');
        }
    };
    assertReady();
    return assertReady;
};
const iosCalendarPushOwned = async (signal: AbortSignal, work: () => Promise<unknown>) => {
    const assertReady = iosCalendarPushCapture(signal);
    if (iosCalendarPushOwner) throw new Error('NOT_READY: Calendar push is already owned');
    iosCalendarPushOwner = assertReady;
    try {
        const result = await work();
        assertReady();
        return result;
    } finally { if (iosCalendarPushOwner === assertReady) iosCalendarPushOwner = null; }
};
const iosCalendarPushInput = (json: string): Record<string, unknown> => {
    const invalid = () => new Error('INVALID_INPUT: Invalid Calendar push request');
    if (typeof json !== 'string' || json.length > 1024 * 1024
        || new TextEncoder().encode(json).byteLength > 1024 * 1024) throw invalid();
    let input: unknown;
    try { input = JSON.parse(json); } catch { throw invalid(); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
    return input as Record<string, unknown>;
};

const iosReminderSnooze = createIosReminderSnoozeMethods({
    preview: (input) => contract.previewReminderSnooze(input),
    plan: (input) => contract.planReminderSnooze(input),
});
const reminderSnoozeRequest = (json: string): unknown => {
    if (typeof json !== 'string' || json.length > 65_536 || new TextEncoder().encode(json).byteLength > 65_536) {
        throw new Error('INVALID_INPUT: A bounded reminder Snooze request is required');
    }
    try { return JSON.parse(json); }
    catch { throw new Error('INVALID_INPUT: A bounded reminder Snooze request is required'); }
};

const reminderCompletionRequest = (json: string): unknown => {
    if (typeof json !== 'string' || json.length > 4096 || new TextEncoder().encode(json).byteLength > 4096) {
        throw new Error('INVALID_INPUT: A bounded reminder completion request is required');
    }
    try { return JSON.parse(json); }
    catch { throw new Error('INVALID_INPUT: A bounded reminder completion request is required'); }
};

globalThis.MindwtrHost = {

    nativeLegacySecretRetirementDelivered(): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            logInfo('Native iOS legacy secret retirement delivered', {
                scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-legacy-secret-retirement', operation: 'legacy-secret-retirement', outcome: 'delivered' },
            });
        } catch {                                                            }
    },

    nativeDeviceStorageDelivered(): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            logInfo('Native iOS device storage result delivered', {
                scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-device-storage', operation: 'device-storage', outcome: 'delivered' },
            });
        } catch {                                                            }
    },

    nativeCryptoDelivered(): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            logInfo('Native iOS crypto result delivered', {
                scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-sync-crypto', operation: 'sync-crypto', outcome: 'delivered' },
            });
        } catch {                                                              }
    },

    nativeSecretDelivered(): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            logInfo('Native iOS secure storage operation delivered', {
                scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-secure-storage', operation: 'secure-storage', outcome: 'delivered' },
            });
        } catch {                                                              }
    },

    nativeHTTPDelivered(): void {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter
            || isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            logInfo('Native iOS HTTP response delivered', {
                scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-http-transport', operation: 'http-transport', outcome: 'delivered' },
            });
        } catch {                                                              }
    },

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


    boot(legacyState: string, legacyBackup: string, writeJournal = '', budgetJSON = ''): string {
        return boot(legacyState, legacyBackup, false, writeJournal === 'journaled', budgetJSON);
    },


    bootRecovery(legacyState: string, legacyBackup: string, writeJournal = '', budgetJSON = ''): string {
        return boot(legacyState, legacyBackup, true, writeJournal === 'journaled', budgetJSON);
    },

    resumeActivation(): string {
        return submit(async () => {
            if (!bootAdapter) throw new Error('Native recovery adapter unavailable');

            if (!debugControl('no-activation-storage')) await sizeStorageTimeout(bootAdapter);
            return activateAndVerify(bootAdapter);
        });
    },
    window(offset: number, limit: number, revision: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getInboxWindow({ offset, limit, revision: revision || undefined }));
        });
    },

    inboxView(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getInboxView(JSON.parse(json)));
        });
    },


    focus(limit: number, controls = '', controlEdit = '', folds = ''): string {
        return submit(async () => {
            requireSaved();
            const focus = unwrap(contract.getFocus({ limit, ...(controls ? { controls: JSON.parse(controls) } : {}), ...(controlEdit ? { controlEdit: JSON.parse(controlEdit) } : {}),
                ...(folds ? { collapsedGroupIds: JSON.parse(folds) } : {}) }));
            cacheIOSFocusWidgetFilter(focus);
            widgets?.focusFilter(focus.controls?.widgetFilter);
            return focus;
        });
    },

    focusWindow(key: string, offset: number, limit: number, revision: string, controls = '', folds = ''): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getFocusSectionWindow({ key: key as FocusTaskSectionKey, offset, limit, revision, ...(controls ? { controls: JSON.parse(controls) } : {}),
                ...(folds ? { collapsedGroupIds: JSON.parse(folds) } : {}) }));
        });
    },
    pomodoroTasks(json: string): string {
        return submit(async () => {
            requireSaved();
            const input = editorJson(json) as Parameters<typeof contract.getPomodoroTaskWindow>[0];
            const page = unwrap(contract.getPomodoroTaskWindow(input));
            if (globalThis.__mindwtrHostPlatform === 'ios' && input.offset === 0) {
                logInfo('Native Pomodoro task choices loaded', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-pomodoro-picker', outcome: 'confirmed' } });
                await diagnosticsLog.serialize(async () => undefined);
            }
            return page;
        });
    },

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

    editChecklist(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.editTaskChecklist(JSON.parse(json)));
        });
    },

    resetChecklist(json: string): string {
        return submit(async () => taskResult('resetChecklist', await contract.resetTaskChecklist(JSON.parse(json))));
    },

    editDraft(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.editTaskDraft(JSON.parse(json)));
        });
    },

    editorSuggestions(id: string, field: string, query: string, limit: number): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getTaskEditorSuggestions({ id, field: field as 'contexts' | 'tags' | 'assignedTo', query, limit }));
        });
    },

    language(stored: string, system: string): string {
        storedLanguage = stored || null;
        return submit(async () => {
            const resolved = unwrap(await contract.setLanguage({ storedLanguage: stored || null, systemLocale: system || null }));
            if (globalThis.__mindwtrHostPlatform === 'ios') iosVoiceSystemLocale = system || null;
            iosReminderEffects.languageResolved(resolved.language); return resolved;
        });
    },

    iosSystemDateFormat(format: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || typeof format !== 'string' || format.length > 128) {
                throw new Error('INVALID_INPUT: The system date format must be a bounded string');
            }
            const applied = unwrap(contract.setSystemDateFormat({ systemDateFormat: format || null }));
            try {
                logInfo('System date format configured', { scope: 'regional-format', force: true,
                    context: { releaseCheck: 'v1.3.9/ios-native-system-date-format', outcome: applied.systemDateFormat ? 'native' : 'locale-fallback' } });
            } catch { }
            return applied;
        });
    },


    widgetsRefresh(mode = ''): string {
        return submit(async () => ({ published: (mode === 'leave' ? widgets?.flush() : widgets?.publish()) ?? false }));
    },


    saveWarm(count: number): string {
        return submit(async () => {
            const adapter = bootAdapter;
            if (!adapter) return { done: true };
            const slice = Math.max(1, Math.min(2_000, Number(count) || 0));
            const tasks = useTaskStore.getState()._allTasks;
            if (saveWarmTasks !== tasks) { saveWarmTasks = tasks; saveWarmFrom = 0; }
            if (saveWarmFrom < tasks.length) {
                saveWarmFrom = warmTaskRowEntries(tasks, saveWarmFrom, slice);
                return { done: false };
            }
            const done = adapter.warmReadFingerprints(slice);

            if (done) saveWarmTasks = null;
            return { done };
        });
    },

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
            if (globalThis.__mindwtrHostPlatform === 'ios') iosVoiceSystemLocale = system || null;
            iosReminderEffects.languageResolved(resolved.language);
            const after = getPersistenceStatus();
            const deviceWrites = synced !== null && synced === state.settings?.language
                && useTaskStore.getState().settings === state.settings && after.generation === generation
                && !after.failed && !after.queued && !after.inFlight && !after.immediate && !after.retrying
                ? getGeneralSettingsDeviceWrites({ type: 'language', value: synced }) : [];
            return { language: resolved.language, deviceWrites };
        });
    },
    taskEditorSectionHelp(): string {
        return submit(async () => {
            const copy = unwrap(contract.getStrings({ keys: [
                'onboarding.help', 'onboarding.readGuide', 'onboarding.guideError',
                ONBOARDING_TOPIC_COPY.scheduling.title, ONBOARDING_TOPIC_COPY.scheduling.body,
                ONBOARDING_TOPIC_COPY.details.title, ONBOARDING_TOPIC_COPY.details.body,
            ] }));
            const topic = (id: 'scheduling' | 'details') => ({
                title: copy.strings[ONBOARDING_TOPIC_COPY[id].title],
                body: copy.strings[ONBOARDING_TOPIC_COPY[id].body],
                url: getOnboardingGuideUrl(id, 'mobile', copy.language),
            });
            return { help: copy.strings['onboarding.help'], readGuide: copy.strings['onboarding.readGuide'],
                guideError: copy.strings['onboarding.guideError'], scheduling: topic('scheduling'), details: topic('details') };
        });
    },
    strings(keysJson: string): string {
        return submit(async () => unwrap(contract.getStrings({ keys: JSON.parse(keysJson) as string[] })));
    },


    swipeTrays(): string {
        return submit(async () => unwrap(contract.getTaskRowSwipeTrays()));
    },
    theme(stored: string): string {
        return submit(async () => {
            const state = useTaskStore.getState();
            const synced = state.settings?.theme;
            const mode = typeof synced === 'string' && synced ? synced : (stored || 'system');
            const descriptor = themeDescriptor(mode);
            const preset = descriptor?.statusPreset ?? null;
            const lightPreset = resolveThemeStatusPreset(mode as AppTheme, 'light');
            const darkPreset = resolveThemeStatusPreset(mode as AppTheme, 'dark');


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

                status: {
                    light: STATUS_COLORS_BY_THEME[lightPreset ?? 'light'],
                    dark: STATUS_COLORS_BY_THEME[darkPreset ?? 'dark'],
                },
                priority: getTaskPriorityColors(lightPreset),
            };
        });
    },


    appLock(): string {
        return submit(async () => ({ ...unwrap(contract.getGeneralSettings({})).privacy.appLock,
            relockDelayMinutes: resolveMobileAppLockRelockDelayMinutes(useTaskStore.getState().settings?.security?.mobileAppLockRelockDelayMinutes) }));
    },
    projects(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjects());
        });
    },

    projectList(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjects({ moves: true }));
        });
    },

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

    projectCreatePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareProjectCreate(JSON.parse(json)));
        });
    },

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
    iosWidgetFamilySnapshot(json: string): string {
        const count = arguments.length;
        return submit(async () => {
            if (count !== 1) throw new Error('INVALID_INPUT: Widget family snapshot takes one appearance object');
            return readIOSWidgetFamilies(json);
        });
    },
    iosWidgetNextSnapshot(): string {
        const count = arguments.length;
        return submit(async () => {
            if (count !== 0) throw new Error('INVALID_INPUT: Widget Next snapshot takes no arguments');
            return readIOSWidgetNext(false);
        });
    },
    iosWatchSnapshot(): string {
        const count = arguments.length;
        return submit(async () => {
            if (count !== 0) throw new Error('INVALID_INPUT: Watch snapshot takes no arguments');
            return readIOSWatchSnapshot();
        });
    },
    iosWidgetNextActionSnapshot(): string {
        const count = arguments.length;
        return submit(async () => {
            if (count !== 0) throw new Error('INVALID_INPUT: Widget Next actions snapshot takes no arguments');
            return readIOSWidgetNext(true);
        });
    },
    iosSearchSnapshot(): string {
        const argumentCount = arguments.length;
        return submit(async () => {
            if (argumentCount !== 0) throw new Error('INVALID_INPUT: Search snapshot takes no arguments');
            const unavailable = () => new Error('NOT_READY: Native iOS search snapshot is unavailable');
            const adapter = bootAdapter;
            const assertReady = () => {
                if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
                    || getStorageAdapter() !== adapter || isSandboxMode() || isWorkspaceTransitionActive()) throw unavailable();
                requireSaved();
                const status = getPersistenceStatus();
                if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying
                    || !contract.getDataSettings().ok) throw unavailable();
                return status;
            };
            const before = assertReady(), state = useTaskStore.getState();
            const data = { tasks: state._allTasks, projects: state._allProjects, sections: state._allSections,
                areas: state._allAreas, settings: state.settings };
            type Item = { id: string; title: string; list: 'inbox' | 'focus' | 'next' | 'waiting' | 'someday';
                projectName?: string; dueDate?: string; startDate?: string };
            const result: { items: Item[] } = { items: [] };
            try {
                const snapshot = buildShortcutsSnapshot(data), seen = new Set<string>();
                const lists = ['inbox', 'focus', 'next', 'waiting', 'someday'] as const;
                const text = (value: unknown, limit: number, nonempty = false) =>
                    typeof value === 'string' && value.length <= limit && (!nonempty || value.length > 0);
                for (const group of [...lists.map((list) => snapshot.lists[list]), ...snapshot.projects.map((group) => group.items)]) {
                    for (const row of group) {
                        if (!text(row.id, 500, true) || !text(row.title, 16_384) || !lists.includes(row.list)
                            || ('projectName' in row && !text(row.projectName, 16_384))
                            || ('dueDate' in row && !text(row.dueDate, 100, true))
                            || ('startDate' in row && !text(row.startDate, 100, true))) throw new Error();
                        if (seen.has(row.id)) continue;
                        seen.add(row.id);
                        result.items.push({ id: row.id, title: row.title, list: row.list,
                            ...('projectName' in row ? { projectName: row.projectName } : {}),
                            ...('dueDate' in row ? { dueDate: row.dueDate } : {}),
                            ...('startDate' in row ? { startDate: row.startDate } : {}) });
                    }
                }
                if (result.items.length > 2_750 || new TextEncoder().encode(JSON.stringify(result)).byteLength > 8 * 1024 * 1024) throw new Error();
            } catch { throw new Error('INVALID_INPUT: Native iOS search snapshot is invalid'); }
            const after = assertReady(), current = useTaskStore.getState();
            if (before.generation !== after.generation || current._allTasks !== data.tasks || current._allProjects !== data.projects
                || current._allSections !== data.sections || current._allAreas !== data.areas || current.settings !== data.settings) throw unavailable();
            try {
                logInfo('Native iOS search snapshot', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-search-snapshot', count: String(result.items.length) } });
            } catch {                                                                 }
            return result;
        });
    },
    iosSearchObservation(): string {
        if (arguments.length !== 0) throw new Error('INVALID_INPUT: Search observation takes no arguments');
        if (globalThis.__mindwtrHostPlatform !== 'ios') throw iosSearchUnavailable();
        const state = useTaskStore.getState(), now = new Date(), nowMs = now.getTime();
        const inputs = [state._allTasks, state._allProjects, state._allSections, state._allAreas, state.settings,
            bootAdapter, getStorageAdapter(), focusWidgetFilterKey(getFocusWidgetFilter())];
        const day = `${now.getFullYear()}/${now.getMonth()}/${now.getDate()}`;
        let zone = '', saved: ReturnType<typeof iosSearchSavedState> | null = null;
        try {
            zone = `${now.getTimezoneOffset()}/${new Intl.DateTimeFormat().resolvedOptions().timeZone}`;
            if (!Number.isFinite(nowMs)) throw iosSearchUnavailable();
            saved = iosSearchSavedState();
        } catch {                                                           }
        let ready = saved !== null;
        const previous = iosSearchPrevious;
        const changed = !previous || inputs.some((input, index) => input !== previous.inputs[index])
            || ready !== previous.ready || nowMs < previous.now || day !== previous.day || zone !== previous.zone
            || previous.nextAt !== null && nowMs >= previous.nextAt;
        let nextAt = previous?.nextAt ?? null;
        if (changed) {
            nextAt = null;
            if (saved) try {
                const reveal = getNextFutureStartRevealAt(state._allTasks, now);
                const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
                nextAt = reveal === null ? midnight : Math.min(reveal, midnight);
                const after = iosSearchSavedState();
                if (!Number.isFinite(nextAt) || nextAt <= nowMs || after.adapter !== saved.adapter
                    || after.generation !== saved.generation || after.state._allTasks !== state._allTasks
                    || after.state._allProjects !== state._allProjects || after.state._allSections !== state._allSections
                    || after.state._allAreas !== state._allAreas || after.state.settings !== state.settings) throw iosSearchUnavailable();
            } catch { ready = false; nextAt = null; }
        }
        const revision = (previous?.revision ?? 0) + (changed ? 1 : 0);
        if (!Number.isSafeInteger(revision)) throw iosSearchUnavailable();
        iosSearchPrevious = { inputs, ready, now: nowMs, day, zone, revision, nextAt };
        return JSON.stringify({ ready, revision, nextAt });
    },
    iosGmailLifecycle(appState: string): string {
        const count = arguments.length;
        return submit(async () => {
            if (count !== 1 || (appState !== 'active' && appState !== 'background')) throw new Error('INVALID_INPUT: Gmail lifecycle takes active or background');
            const gmail = requireIosGmail();
            if (iosGmailStarted) gmail.appState(appState);
            else { iosGmailStarted = true; gmail.start(appState); }
            return null;
        });
    },
    iosGmailRequest(name: string, json: string): string {
        const count = arguments.length;
        return submit(async () => {
            if (count !== 2 || typeof name !== 'string' || typeof json !== 'string' || json.length > 4096) throw new Error('INVALID_INPUT: Gmail request takes a name and bounded JSON');
            const input: unknown = JSON.parse(json);
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_INPUT: Gmail request input must be an object');
            return requireIosGmail().request(name, input as { labelId?: string; enabled?: boolean });
        });
    },
    iosTaskIconBadgeCount(): string {
        const count = arguments.length;
        return submit(async () => {
            if (count !== 0) throw new Error('INVALID_INPUT: Task icon badge count takes no arguments');
            const { state } = iosSearchSavedState();
            return countTasksForIconBadge(state._allTasks, state._allProjects, state._allSections);
        });
    },
    iosSearchOpen(taskID: string): string {
        const argumentCount = arguments.length;
        return submit(async () => {
            if (argumentCount !== 1 || typeof taskID !== 'string' || taskID.length === 0 || taskID.length > 500
                || new TextEncoder().encode(JSON.stringify([taskID])).byteLength > 8 * 1024) {
                throw new Error('INVALID_INPUT: A bounded search task identity is required');
            }
            const before = iosSearchSavedState();
            const target = resolveEntityOpenTarget('task', taskID, before.state);
            const after = iosSearchSavedState();
            if (after.adapter !== before.adapter || after.generation !== before.generation
                || after.state._tasksById !== before.state._tasksById || after.state._allTasks !== before.state._allTasks) throw iosSearchUnavailable();
            return target && 'taskId' in target ? { type: 'task', taskId: target.taskId } : { type: 'inbox' };
        });
    },

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
    appLockDelayOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getAppLockDelayOptions(JSON.parse(json))); });
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
    gtdPomodoroOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdPomodoroOptions(JSON.parse(json))); });
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
    gtdCaptureAudioOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getGtdCaptureAudioOptions(JSON.parse(json))); });
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
    iosWidgetCompletionPrepare(json: string): string {
        return submit(async () => {
            iosSearchSavedState();
            return unwrap(contract.prepareWidgetCompletion(completionJson(json, 65_536)));
        });
    },
    iosWidgetCompletionValidate(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw iosSearchUnavailable();
            return unwrap(contract.validatePreparedWidgetCompletion(completionJson(json, 2_100_000)));
        });
    },
    iosWidgetCompletionCommit(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || isSandboxMode() || isWorkspaceTransitionActive()) throw iosSearchUnavailable();
            return unwrap(await contract.commitPreparedWidgetCompletion(completionJson(json, 2_100_000)));
        });
    },
    iosWidgetCompletionOutcome(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || isSandboxMode() || isWorkspaceTransitionActive()) throw iosSearchUnavailable();
            return unwrap(contract.widgetCompletionOutcome(completionJson(json, 65_536)));
        });
    },
    iosShareCapturePrepare(json: string): string {
        return submit(async () => iosShareCaptureMethods.prepare(JSON.parse(json)));
    },
    iosShareCaptureCommit(json: string): string {
        return submit(async () => iosShareCaptureMethods.commit(JSON.parse(json)));
    },
    iosShareCaptureOutcome(json: string): string {
        return submit(async () => iosShareCaptureMethods.outcome(JSON.parse(json)));
    },
    iosShareCaptureDraft(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: iOS share unavailable');
            requireSaved();
            return readIOSShareCaptureDraft(json);
        });
    },
    iosProductionWidgetTaskOpen(url: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || typeof url !== 'string' || url.length > 16_000) {
                throw new Error('INVALID_INPUT: Invalid production task URL');
            }
            const scheme = 'mindwtr';
            if (url.slice(0, scheme.length + 1).toLowerCase() !== `${scheme}:`
                || !isEntityOpenUrl(url) || parseEntityOpenUrl(url)?.kind !== 'task') return { type: 'none' };
            const target = unwrap(contract.resolveNativeEntryPoint({ kind: 'link', url, scheme }));
            const type = target.taskId && target.taskId.length <= 500 ? 'task' : target.route === '/inbox' ? 'inbox' : 'none';
            if (type !== 'none') {
                try {
                    logInfo('Native iOS production task URL resolved', { scope: 'native-ios', force: true,
                        context: { releaseCheck: 'v1.3.9/ios-production-task-url', outcome: type } });
                } catch {}
            }
            return type === 'task' ? { type, taskId: target.taskId } : { type };
        });
    },
    iosEntityOpen(url: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || typeof url !== 'string' || url.length > 16_000) {
                throw new Error('INVALID_INPUT: Invalid entity open URL');
            }
            const scheme = 'mindwtr-native-dev';
            if (url.slice(0, scheme.length + 1).toLowerCase() !== `${scheme}:`) return { type: 'none' };
            const normalized = `mindwtr:${url.slice(scheme.length + 1)}`;
            if (!isEntityOpenUrl(normalized) || parseEntityOpenUrl(normalized)?.kind === 'area') return { type: 'none' };
            const target = unwrap(contract.resolveNativeEntryPoint({ kind: 'link', url, scheme }));
            if (target.taskId) return target.taskId.length <= 500 ? { type: 'task', taskId: target.taskId } : { type: 'none' };
            if (target.projectId) return target.projectId.length <= 500 ? { type: 'project', projectId: target.projectId } : { type: 'none' };
            return { type: target.route === '/inbox' ? 'inbox' : 'none' };
        });
    },
    iosNotificationOpen(rawJSON: string): string {
        return submit(async () => {
            const invalid = () => new Error('INVALID_INPUT: Invalid notification open payload');
            if (globalThis.__mindwtrHostPlatform !== 'ios' || typeof rawJSON !== 'string'
                || rawJSON.length > 65_536 || new TextEncoder().encode(rawJSON).byteLength > 65_536) throw invalid();
            let payload: Record<string, unknown>;
            try { payload = JSON.parse(rawJSON.startsWith('\uFEFF') ? rawJSON.slice(1) : rawJSON); } catch { throw invalid(); }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.actionIdentifier !== 'open'
                || Object.entries(payload).some(([field, value]) => !['notificationId', 'actionIdentifier', 'taskId', 'projectId', 'context', 'kind'].includes(field)
                    || typeof value !== 'string')) throw invalid();
            return unwrap(contract.routeNotificationOpen(payload));
        });
    },
    reminderSnoozePrepare(raw: string, storedAlarms: string | null, storedState: string | null, granted: boolean): string {
        return submit(async () => iosReminderSnooze.prepare(raw, storedAlarms, storedState, granted));
    },
    reminderSnoozeValidate(raw: string, storedAlarms: string | null, storedState: string | null, stateAhead: string): string {
        return submit(async () => iosReminderSnooze.validate(raw, storedAlarms, storedState, stateAhead));
    },
    reminderSnoozeCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitReminderSnooze(reminderSnoozeRequest(json))));
    },
    reminderSnoozeProbe(json: string): string {
        return submit(async () => unwrap(contract.probeReminderSnoozeOutcome(reminderSnoozeRequest(json))));
    },
    reminderSnoozeRetry(json: string): string {
        return submit(async () => unwrap(await contract.retryReminderSnooze(reminderSnoozeRequest(json))));
    },
    reminderSnoozeAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            iosReminderEffects.published();
            try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                message: 'Native iOS reminder Snooze acknowledged',
                context: { releaseCheck: 'v1.3.5/ios-reminder-snooze', outcome: 'confirmed' },
            }, { force: true }); } catch {                                                                            }
            return null;
        });
    },
    reminderCompletionCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitReminderCompletion(reminderCompletionRequest(json))));
    },
    reminderCompletionProbe(json: string): string {
        return submit(async () => unwrap(contract.probeReminderCompletionOutcome(reminderCompletionRequest(json))));
    },
    reminderCompletionRetry(json: string): string {
        return submit(async () => unwrap(await contract.retryReminderCompletion(reminderCompletionRequest(json))));
    },
    reminderCompletionAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                message: 'Native iOS reminder completion acknowledged',
                context: { releaseCheck: 'v1.3.5/ios-reminder-complete', outcome: 'confirmed' },
            }, { force: true }); } catch {                                                                     }
            return null;
        });
    },
    deviceCalendarSettingPrepare(json: string): string {
        return submit(async () => unwrap(await deviceCalendarSettings.prepareDeviceCalendarSetting(completionJson(json, 1_048_576))));
    },
    deviceCalendarSettingValidate(json: string): string {
        return submit(async () => unwrap(deviceCalendarSettings.validatePreparedDeviceCalendarSetting(completionJson(json, 4_194_304))));
    },
    deviceCalendarSettingCommit(json: string): string {
        return submit(async () => unwrap(await deviceCalendarSettings.commitPreparedDeviceCalendarSetting(completionJson(json, 4_194_304))));
    },
    deviceCalendarSettingRetryOutcome(json: string): string {
        return submit(async () => unwrap(deviceCalendarSettings.probeDeviceCalendarSettingOutcome(completionJson(json, 1_048_576))));
    },
    deviceCalendarAccessAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS calendar access request returned',
                    context: { releaseCheck: 'v1.3.5/ios-calendar-access', outcome: 'returned' },
                }, { force: true });
            } catch {                                                                 }
            return null;
        });
    },
    deviceCalendarSettingAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS device calendar setting saved',
                    context: { releaseCheck: 'v1.3.5/ios-calendar-setting', outcome: 'saved' },
                }, { force: true });
            } catch {                                                                 }
            return null;
        });
    },
    calendarSubscriptionSettingOptions(json: string): string {
        return submit(async () => unwrap(await calendarSubscriptionSettings.getCalendarSubscriptionOptions(completionJson(json, 1_048_576))));
    },
    calendarSubscriptionSettingPrepare(json: string): string {
        return submit(async () => unwrap(await calendarSubscriptionSettings.prepareCalendarSubscriptionSetting(completionJson(json, 1_048_576))));
    },
    calendarSubscriptionSettingValidate(json: string): string {
        return submit(async () => unwrap(calendarSubscriptionSettings.validatePreparedCalendarSubscriptionSetting(completionJson(json, 4_194_304))));
    },
    calendarSubscriptionSettingCommit(json: string): string {
        return submit(async () => unwrap(await calendarSubscriptionSettings.commitPreparedCalendarSubscriptionSetting(completionJson(json, 4_194_304))));
    },
    calendarSubscriptionSettingRetryOutcome(json: string): string {
        return submit(async () => unwrap(await calendarSubscriptionSettings.probeCalendarSubscriptionSettingOutcome(completionJson(json, 1_048_576))));
    },
    calendarSubscriptionSettingAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                message: 'Native iOS calendar subscription setting saved',
                context: { releaseCheck: 'v1.3.5/ios-calendar-subscription-setting', outcome: 'saved' },
            }); } catch {                                                           }
            return null;
        });
    },
    calendarSubscriptionFileAddRequest(json: string): string {
        return submit(async () => unwrap(calendarSubscriptionAdd.createCalendarSubscriptionFileAddRequest(completionJson(json, 1_048_576))));
    },
    calendarSubscriptionAddPrepare(json: string): string {
        return submit(async () => unwrap(await calendarSubscriptionAdd.prepareCalendarSubscriptionAdd(completionJson(json, 1_048_576))));
    },
    calendarSubscriptionAddValidate(json: string): string {
        return submit(async () => unwrap(calendarSubscriptionAdd.validatePreparedCalendarSubscriptionAdd(completionJson(json, 4_194_304))));
    },
    calendarSubscriptionAddCommit(json: string): string {
        return submit(async () => unwrap(await calendarSubscriptionAdd.commitPreparedCalendarSubscriptionAdd(completionJson(json, 4_194_304))));
    },
    calendarSubscriptionAddRetryOutcome(json: string): string {
        return submit(async () => unwrap(await calendarSubscriptionAdd.probeCalendarSubscriptionAddOutcome(completionJson(json, 1_048_576))));
    },
    calendarSubscriptionAddAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                message: 'Native iOS calendar subscription added',
                context: { releaseCheck: 'v1.3.5/ios-calendar-subscription-add', outcome: 'saved' },
            }); } catch {                                                           }
            return null;
        });
    },
    notificationSettingOptions(json: string): string {
        return submit(async () => unwrap(await contract.getNotificationSettingsOptions(JSON.parse(json))));
    },
    notificationSettingRetryOutcome(json: string): string {
        return submit(async () => unwrap(contract.probeNotificationSettingOutcome(JSON.parse(json))));
    },
    notificationSettingPrepare(json: string): string {
        return submit(async () => unwrap(await contract.prepareNotificationSetting(JSON.parse(json))));
    },
    notificationSettingValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedNotificationSetting(JSON.parse(json))));
    },
    notificationSettingCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedNotificationSetting(JSON.parse(json))));
    },
    notificationSettingAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                message: 'Native iOS notification setting saved',
                context: { releaseCheck: 'v1.3.5/ios-notification-setting', outcome: 'saved' },
            }, { force: true }); } catch {                                                                     }
            return null;
        });
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
    somedaySectionBulkMoveOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getSomedaySectionBulkMoveOptions(JSON.parse(json))); });
    },
    somedaySectionBulkMovePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareSomedaySectionBulkMove(JSON.parse(json))); });
    },
    somedaySectionBulkMoveValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedSomedaySectionBulkMove(JSON.parse(json))));
    },
    somedaySectionBulkMoveCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedSomedaySectionBulkMove(JSON.parse(json))));
    },
    somedaySectionBulkMoveRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeSomedaySectionBulkMoveOutcome(JSON.parse(json))); });
    },
    somedaySectionBulkMoveUndoPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareSomedaySectionBulkMoveUndo(JSON.parse(json))); });
    },
    somedaySectionBulkMoveUndoValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedSomedaySectionBulkMoveUndo(JSON.parse(json))));
    },
    somedaySectionBulkMoveUndoCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedSomedaySectionBulkMoveUndo(JSON.parse(json))));
    },
    somedaySectionBulkMoveUndoRetryOutcome(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.probeSomedaySectionBulkMoveUndoOutcome(JSON.parse(json))); });
    },
    focusGroupOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getFocusGroupOptions(JSON.parse(json))); });
    },
    focusGroupValidate(json: string): string {
        return submit(async () => unwrap(contract.validateFocusGroupWrite(JSON.parse(json))));
    },

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
    archiveRetentionOptions(): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getArchiveRetentionOptions()); });
    },
    archiveRetentionReview(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getArchiveRetentionReview(JSON.parse(json))); });
    },
    projectSectionFlowOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getProjectSectionFlowOptions(JSON.parse(json))); });
    },
    projectFlowModeOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getProjectFlowModeOptions(JSON.parse(json)));
        });
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
    savedSearchSortOptions(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getSavedSearchSortOptions(JSON.parse(json)));
        });
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
    projectFileAvailabilityPreflight(json: string, encryptionStateJSON: unknown, cloudURL: string | null, backend: string = 'cloud'): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || !localAttachments || nativeSync
                || iosTaskAttachmentPreparation || iosProjectFilePreparation || iosCleanupCallback
                || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error('NOT_READY: Project download is unavailable');
            requireSaved(); await assertNativeSelfHostedAttachmentEncryptionAdmission(encryptionStateJSON);
            if (backend === 'dropbox' && cloudURL !== null) throw new Error('INVALID_INPUT: Dropbox has no direct availability URL');
            const input = editorJson(json) as { projectId?: unknown };
            const id = typeof input.projectId === 'string' ? input.projectId : '';
            const preflight = unwrap(await preparedProjectAvailability(id, backend).getProjectFileAvailabilityPreflight(input));
            return { preflight, columns: PROJECT_SQLITE_COLUMNS,
                initialURL: backend === 'dropbox' ? null : nativeProjectFileAvailabilityInitialURL(preflight.attachmentJSON, cloudURL!, backend === 'webdav') };
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

    update(json: string): string {
        return submit(async () => taskResult('update', await contract.updateTask(JSON.parse(json))));
    },


    saveDraft(json: string): string {
        return submit(async () => taskResult('saveTaskDraft', await contract.saveTaskDraft({ ...JSON.parse(json), mergeSyncedChanges: globalThis.__mindwtrHostPlatform !== 'ios' })));
    },

    calendarPreference(json: string): string {
        return submit(async () => unwrap(await contract.setCalendarPreference(JSON.parse(json))));
    },

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

    calendarComposerPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareCalendarComposerSave(JSON.parse(json))); });
    },

    calendarComposerValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedCalendarComposerSave(JSON.parse(json))));
    },
    calendarComposerCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedCalendarComposerSave(JSON.parse(json))));
    },

    calendarComposerCreatePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareCalendarComposerCreate(JSON.parse(json))); });
    },
    calendarComposerCreateValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedCalendarComposerCreate(JSON.parse(json))));
    },
    calendarComposerCreateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedCalendarComposerCreate(JSON.parse(json))));
    },
    calendarEventTaskPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareCalendarEventTaskCreate(JSON.parse(json))); });
    },
    calendarEventTaskValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedCalendarEventTaskCreate(JSON.parse(json))));
    },
    calendarEventTaskCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitCalendarEventTaskCreate(JSON.parse(json))));
    },
    calendarEventTaskAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                message: 'Native iOS calendar event task created',
                context: { releaseCheck: 'v1.3.5/ios-calendar-event-task', outcome: 'confirmed' },
            }); } catch {                                                           }
            return null;
        });
    },

    boardPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap<Extract<ReturnType<typeof contract.prepareBoardAction>, { ok: true }>['value']>(contract.prepareBoardAction(JSON.parse(json)));
        });
    },

    boardValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedBoardAction(JSON.parse(json))));
    },

    iosBoardMoveAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try {
                logInfo('Native iOS Board move saved', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-board-move', outcome: 'saved' } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch {                                                           }
            return null;
        });
    },

    iosBoardCompletionAcknowledged(outcome: string): string {
        return submit(async () => {
            if (outcome !== 'completed' && outcome !== 'undone') throw new Error('INVALID_INPUT: Invalid Board completion outcome');
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try {
                logInfo('Native iOS Board completion acknowledged', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-board-complete', outcome } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch {                                                           }
            return null;
        });
    },

    iosBoardReactivateAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try {
                logInfo('Native iOS Board task reactivated', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-board-reactivate', outcome: 'saved' } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch {                                                           }
            return null;
        });
    },

    iosBoardOrderAcknowledged(outcome: string, affectedCount: number): string {
        return submit(async () => {
            if (outcome !== 'saved' || !Number.isSafeInteger(affectedCount) || affectedCount < 1 || affectedCount > 100_000)
                throw new Error('INVALID_INPUT: Invalid Board order acknowledgement');
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try {
                logInfo('Native iOS Board order saved', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-board-order', outcome, affectedCount } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch {                                                             }
            return null;
        });
    },
    boardOrderOutcome(json: string): string {
        return submit(async () => unwrap(await contract.boardOrderOutcome(editorJson(json) as Parameters<typeof contract.boardOrderOutcome>[0])));
    },
    boardMoveOutcome(json: string): string {
        return submit(async () => unwrap(await contract.boardMoveOutcome(editorJson(json) as Parameters<typeof contract.boardMoveOutcome>[0])));
    },

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
    taskPromoteOptions(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); return unwrap(contract.getTaskPromotionOptions(completionJson(json, 4_096) as Parameters<typeof contract.getTaskPromotionOptions>[0])); });
    },
    taskPromoteUndoPrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); requireSaved(); return unwrap(contract.prepareTaskPromotionUndo(editorJson(json) as Parameters<typeof contract.prepareTaskPromotionUndo>[0])); });
    },
    taskPromoteUndoValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); return unwrap(contract.validatePreparedTaskPromotionUndo(editorJson(json) as Parameters<typeof contract.validatePreparedTaskPromotionUndo>[0])); });
    },
    taskPromoteUndoCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); return unwrap(await contract.commitPreparedTaskPromotionUndo(editorJson(json) as Parameters<typeof contract.commitPreparedTaskPromotionUndo>[0])); });
    },
    projectToSectionOptions(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); requireSaved(); return unwrap(contract.getProjectToSectionConversionOptions(completionJson(json, 4_096) as Parameters<typeof contract.getProjectToSectionConversionOptions>[0])); });
    },
    projectToSectionPrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); requireSaved(); return unwrap(contract.prepareProjectToSection(completionJson(json, 200_000) as Parameters<typeof contract.prepareProjectToSection>[0])); });
    },
    projectToSectionValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); return unwrap(contract.validatePreparedProjectToSection(editorJson(json) as Parameters<typeof contract.validatePreparedProjectToSection>[0])); });
    },
    projectToSectionCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); return unwrap(await contract.commitPreparedProjectToSection(editorJson(json) as Parameters<typeof contract.commitPreparedProjectToSection>[0])); });
    },
    projectToSectionUndoPrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); requireSaved(); return unwrap(contract.prepareProjectToSectionUndo(editorJson(json) as Parameters<typeof contract.prepareProjectToSectionUndo>[0])); });
    },
    projectToSectionUndoValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); return unwrap(contract.validatePreparedProjectToSectionUndo(editorJson(json) as Parameters<typeof contract.validatePreparedProjectToSectionUndo>[0])); });
    },
    projectToSectionUndoCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Conversion requires iOS'); return unwrap(await contract.commitPreparedProjectToSectionUndo(editorJson(json) as Parameters<typeof contract.commitPreparedProjectToSectionUndo>[0])); });
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
        return submit(async () => { requireSaved(); return unwrap(await contract.getReferenceProjectNextActionOptions(taskCompletionJson(json, 2_100_000) as Parameters<typeof contract.getReferenceProjectNextActionOptions>[0])); });
    },
    referenceProjectNextActionInput(text: string): string {
        return submit(async () => {
            if (typeof text !== 'string' || text.length > 100_000) throw new Error('INVALID_INPUT: Next action text is too large');
            return unwrap(contract.referenceProjectNextActionInput(text));
        });
    },
    referenceProjectNextActionPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareReferenceProjectNextAction(taskCompletionJson(json, 2_100_000) as Parameters<typeof contract.prepareReferenceProjectNextAction>[0])); });
    },
    referenceProjectNextActionValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedReferenceProjectNextAction(taskCompletionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedReferenceProjectNextAction>[0])));
    },
    referenceProjectNextActionCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedReferenceProjectNextAction(taskCompletionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedReferenceProjectNextAction>[0])));
    },
    referenceProjectNextActionOutcome(json: string): string {
        return submit(async () => unwrap(contract.referenceProjectNextActionOutcome(taskCompletionJson(json, 2_100_000) as Parameters<typeof contract.referenceProjectNextActionOutcome>[0])));
    },
    taskRowSwipeActions(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row swipe presentation requires iOS'); return unwrap(contract.getTaskRowSwipeActions(completionJson(json, 4_096) as Parameters<typeof contract.getTaskRowSwipeActions>[0])); });
    },
    rowTaskFocusPrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row Focus requires iOS'); requireSaved(); return unwrap(await contract.prepareRowTaskFocus(completionJson(json, 4_096) as Parameters<typeof contract.prepareRowTaskFocus>[0])); });
    },
    rowTaskFocusValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row Focus requires iOS'); return unwrap(contract.validatePreparedRowTaskFocus(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedRowTaskFocus>[0])); });
    },
    rowTaskFocusCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row Focus requires iOS'); return unwrap(await contract.commitPreparedRowTaskFocus(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedRowTaskFocus>[0])); });
    },
    rowTaskFocusOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row Focus requires iOS'); return unwrap(contract.rowTaskFocusOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.rowTaskFocusOutcome>[0])); });
    },
    rowTaskDatesPrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row Dates requires iOS'); requireSaved(); return unwrap(await contract.prepareRowTaskDates(completionJson(json, 2_100_000) as Parameters<typeof contract.prepareRowTaskDates>[0])); });
    },
    rowTaskDatesValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row Dates requires iOS'); return unwrap(contract.validatePreparedRowTaskDates(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedRowTaskDates>[0])); });
    },
    rowTaskDatesCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row Dates requires iOS'); return unwrap(await contract.commitPreparedRowTaskDates(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedRowTaskDates>[0])); });
    },
    rowTaskDatesOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row Dates requires iOS'); return unwrap(contract.rowTaskDatesOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.rowTaskDatesOutcome>[0])); });
    },
    rowTaskDestinationOptions(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row destination requires iOS'); requireSaved(); return unwrap(await contract.getRowTaskDestinationOptions(completionJson(json, 16_384) as Parameters<typeof contract.getRowTaskDestinationOptions>[0])); });
    },
    rowTaskDestinationPrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row destination requires iOS'); requireSaved(); return unwrap(await contract.prepareRowTaskDestination(completionJson(json, 4_096) as Parameters<typeof contract.prepareRowTaskDestination>[0])); });
    },
    rowTaskDestinationValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row destination requires iOS'); return unwrap(contract.validatePreparedRowTaskDestination(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedRowTaskDestination>[0])); });
    },
    rowTaskDestinationCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row destination requires iOS'); return unwrap(await contract.commitPreparedRowTaskDestination(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedRowTaskDestination>[0])); });
    },
    rowTaskDestinationOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row destination requires iOS'); return unwrap(contract.rowTaskDestinationOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.rowTaskDestinationOutcome>[0])); });
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
    taskChecklistMoveOptions(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Checklist move requires iOS'); requireSaved(); return unwrap(await contract.getTaskChecklistMoveOptions(completionJson(json, 16_384) as Parameters<typeof contract.getTaskChecklistMoveOptions>[0])); });
    },
    taskChecklistMovePrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Checklist move requires iOS'); requireSaved(); return unwrap(await contract.prepareTaskChecklistMove(completionJson(json, 4_096) as Parameters<typeof contract.prepareTaskChecklistMove>[0])); });
    },
    taskChecklistMoveValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Checklist move requires iOS'); return unwrap(await contract.validatePreparedTaskChecklistMove(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedTaskChecklistMove>[0])); });
    },
    taskChecklistMoveCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Checklist move requires iOS'); return unwrap(await contract.commitPreparedTaskChecklistMove(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedTaskChecklistMove>[0])); });
    },
    taskChecklistMoveOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Checklist move requires iOS'); return unwrap(await contract.taskChecklistMoveOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.taskChecklistMoveOutcome>[0])); });
    },
    taskChecklistMoveUndoPrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Checklist move requires iOS'); requireSaved(); return unwrap(await contract.prepareTaskChecklistMoveUndo(completionJson(json, 2_100_000) as Parameters<typeof contract.prepareTaskChecklistMoveUndo>[0])); });
    },
    taskChecklistMoveUndoValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Checklist move requires iOS'); return unwrap(await contract.validatePreparedTaskChecklistMoveUndo(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedTaskChecklistMoveUndo>[0])); });
    },
    taskChecklistMoveUndoCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Checklist move requires iOS'); return unwrap(await contract.commitPreparedTaskChecklistMoveUndo(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedTaskChecklistMoveUndo>[0])); });
    },
    taskChecklistMoveUndoOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Checklist move requires iOS'); return unwrap(await contract.taskChecklistMoveUndoOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.taskChecklistMoveUndoOutcome>[0])); });
    },
    rowTaskBackdateOptions(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row backdate requires iOS'); requireSaved(); return unwrap(await contract.getRowTaskBackdateOptions(completionJson(json, 4_096) as Parameters<typeof contract.getRowTaskBackdateOptions>[0])); });
    },
    rowTaskBackdatePrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row backdate requires iOS'); requireSaved(); return unwrap(await contract.prepareRowTaskBackdate(completionJson(json, 4_096) as Parameters<typeof contract.prepareRowTaskBackdate>[0])); });
    },
    rowTaskBackdateValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row backdate requires iOS'); return unwrap(await contract.validatePreparedRowTaskBackdate(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedRowTaskBackdate>[0])); });
    },
    rowTaskBackdateCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row backdate requires iOS'); return unwrap(await contract.commitPreparedRowTaskBackdate(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedRowTaskBackdate>[0])); });
    },
    rowTaskBackdateOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row backdate requires iOS'); return unwrap(await contract.rowTaskBackdateOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.rowTaskBackdateOutcome>[0])); });
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
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareTaskCompletion(taskCompletionJson(json, 4_096) as Parameters<typeof contract.prepareTaskCompletion>[0])); });
    },
    taskCompletionValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskCompletion(taskCompletionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedTaskCompletion>[0])));
    },
    taskCompletionCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTaskCompletion(taskCompletionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedTaskCompletion>[0])));
    },
    taskCompletionOutcome(json: string): string {
        return submit(async () => unwrap(contract.taskCompletionOutcome(taskCompletionJson(json, 2_100_000) as Parameters<typeof contract.taskCompletionOutcome>[0])));
    },
    taskCompletionUndoPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareTaskCompletionUndo(taskCompletionJson(json, 4_500_000) as Parameters<typeof contract.prepareTaskCompletionUndo>[0])); });
    },
    taskCompletionUndoValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskCompletionUndo(taskCompletionJson(json, 4_500_000) as Parameters<typeof contract.validatePreparedTaskCompletionUndo>[0])));
    },
    taskCompletionUndoCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTaskCompletionUndo(taskCompletionJson(json, 4_500_000) as Parameters<typeof contract.commitPreparedTaskCompletionUndo>[0])));
    },
    taskCompletionUndoOutcome(json: string): string {
        return submit(async () => unwrap(contract.taskCompletionUndoOutcome(taskCompletionJson(json, 4_500_000) as Parameters<typeof contract.taskCompletionUndoOutcome>[0])));
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
    projectTasksDeletePrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project Trash requires iOS'); requireSaved(); return unwrap(await contract.prepareProjectTasksDelete(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareProjectTasksDelete>[0])); });
    },
    projectTasksDeleteValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project Trash requires iOS'); return unwrap(await contract.validatePreparedProjectTasksDelete(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedProjectTasksDelete>[0])); });
    },
    projectTasksDeleteCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project Trash requires iOS'); return unwrap(await contract.commitPreparedProjectTasksDelete(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedProjectTasksDelete>[0])); });
    },
    projectTasksDeleteOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project Trash requires iOS'); return unwrap(await contract.projectTasksDeleteOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.projectTasksDeleteOutcome>[0])); });
    },
    projectTasksDeleteUndoPrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project Trash requires iOS'); requireSaved(); return unwrap(await contract.prepareProjectTasksDeleteUndo(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareProjectTasksDeleteUndo>[0])); });
    },
    projectTasksDeleteUndoValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project Trash requires iOS'); return unwrap(await contract.validatePreparedProjectTasksDeleteUndo(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedProjectTasksDeleteUndo>[0])); });
    },
    projectTasksDeleteUndoCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project Trash requires iOS'); return unwrap(await contract.commitPreparedProjectTasksDeleteUndo(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedProjectTasksDeleteUndo>[0])); });
    },
    projectTasksDeleteUndoOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project Trash requires iOS'); return unwrap(await contract.projectTasksDeleteUndoOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.projectTasksDeleteUndoOutcome>[0])); });
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
    inboxTasksMoveNotice(json: string): string {
        return submit(async () => {
            requireSaved();
            const result = completionJson(json, 2_000) as { count?: unknown; status?: unknown };
            if (!result || typeof result !== 'object' || Array.isArray(result)
                || Object.keys(result).sort().join(',') !== 'count,status'
                || typeof result.count !== 'number' || !Number.isInteger(result.count)
                || result.count < 1 || result.count > 10_000
                || !getBulkMoveStatusOptions('all').includes(result.status as TaskStatus)) {
                throw new Error('INVALID_INPUT: Inbox move notice requires a bounded result');
            }
            const t = (key: string): string => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key;
            return { message: formatListItemCount(result.count, 'task', t) };
        });
    },
    inboxTasksMovePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareInboxTasksMove(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareInboxTasksMove>[0])); });
    },
    inboxTasksMoveValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedInboxTasksMove(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedInboxTasksMove>[0])));
    },
    inboxTasksMoveCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedInboxTasksMove(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedInboxTasksMove>[0])));
    },
    inboxTasksMoveOutcome(json: string): string {
        return submit(async () => unwrap(await contract.inboxTasksMoveOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.inboxTasksMoveOutcome>[0])));
    },
    projectTasksMovePrepare(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk status requires iOS');
            requireSaved(); return unwrap(await contract.prepareProjectTasksMove(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareProjectTasksMove>[0]));
        });
    },
    projectTasksMoveNotice(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk status requires iOS');
            requireSaved();
            const result = completionJson(json, 2_000) as { count?: unknown; status?: unknown };
            if (!result || typeof result !== 'object' || Array.isArray(result)
                || Object.keys(result).sort().join(',') !== 'count,status'
                || typeof result.count !== 'number' || !Number.isInteger(result.count) || result.count < 1 || result.count > 10_000
                || !getBulkMoveStatusOptions('all').includes(result.status as TaskStatus))
                throw new Error('INVALID_INPUT: Project move notice requires a bounded result');
            const t = (key: string): string => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key;
            return { message: formatListItemCount(result.count, 'task', t) };
        });
    },
    projectTasksMoveValidate(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk status requires iOS');
            return unwrap(contract.validatePreparedProjectTasksMove(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedProjectTasksMove>[0]));
        });
    },
    projectTasksMoveCommit(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk status requires iOS');
            return unwrap(await contract.commitPreparedProjectTasksMove(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedProjectTasksMove>[0]));
        });
    },
    projectTasksMoveOutcome(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk status requires iOS');
            return unwrap(contract.projectTasksMoveOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.projectTasksMoveOutcome>[0]));
        });
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
    inboxTasksAddTagPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareInboxTasksAddTag(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareInboxTasksAddTag>[0])); });
    },
    inboxTasksAddTagValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedInboxTasksAddTag(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedInboxTasksAddTag>[0])));
    },
    inboxTasksAddTagCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedInboxTasksAddTag(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedInboxTasksAddTag>[0])));
    },
    inboxTasksAddTagOutcome(json: string): string {
        return submit(async () => unwrap(await contract.inboxTasksAddTagOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.inboxTasksAddTagOutcome>[0])));
    },
    projectTasksAddTagPrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk tags require iOS'); requireSaved(); return unwrap(await contract.prepareProjectTasksAddTag(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareProjectTasksAddTag>[0])); });
    },
    projectTasksAddTagValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk tags require iOS'); return unwrap(contract.validatePreparedProjectTasksAddTag(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedProjectTasksAddTag>[0])); });
    },
    projectTasksAddTagCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk tags require iOS'); return unwrap(await contract.commitPreparedProjectTasksAddTag(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedProjectTasksAddTag>[0])); });
    },
    projectTasksAddTagOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk tags require iOS'); return unwrap(await contract.projectTasksAddTagOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.projectTasksAddTagOutcome>[0])); });
    },
    inboxTasksRemoveTagPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareInboxTasksRemoveTag(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareInboxTasksRemoveTag>[0])); });
    },
    inboxTasksRemoveTagValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedInboxTasksRemoveTag(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedInboxTasksRemoveTag>[0])));
    },
    inboxTasksRemoveTagCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedInboxTasksRemoveTag(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedInboxTasksRemoveTag>[0])));
    },
    inboxTasksRemoveTagOutcome(json: string): string {
        return submit(async () => unwrap(await contract.inboxTasksRemoveTagOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.inboxTasksRemoveTagOutcome>[0])));
    },
    projectTasksRemoveTagPrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk tags require iOS'); requireSaved(); return unwrap(await contract.prepareProjectTasksRemoveTag(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareProjectTasksRemoveTag>[0])); });
    },
    projectTasksRemoveTagValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk tags require iOS'); return unwrap(contract.validatePreparedProjectTasksRemoveTag(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedProjectTasksRemoveTag>[0])); });
    },
    projectTasksRemoveTagCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk tags require iOS'); return unwrap(await contract.commitPreparedProjectTasksRemoveTag(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedProjectTasksRemoveTag>[0])); });
    },
    projectTasksRemoveTagOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk tags require iOS'); return unwrap(await contract.projectTasksRemoveTagOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.projectTasksRemoveTagOutcome>[0])); });
    },
    projectTasksOrganizePrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk Organize requires iOS'); requireSaved(); return unwrap(await contract.prepareProjectTasksOrganize(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareProjectTasksOrganize>[0])); });
    },
    projectTasksOrganizeValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk Organize requires iOS'); return unwrap(contract.validatePreparedProjectTasksOrganize(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedProjectTasksOrganize>[0])); });
    },
    projectTasksOrganizeCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk Organize requires iOS'); return unwrap(await contract.commitPreparedProjectTasksOrganize(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedProjectTasksOrganize>[0])); });
    },
    projectTasksOrganizeOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project bulk Organize requires iOS'); return unwrap(await contract.projectTasksOrganizeOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.projectTasksOrganizeOutcome>[0])); });
    },
    inboxTasksOrganizePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareInboxTasksOrganize(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareInboxTasksOrganize>[0])); });
    },
    inboxTasksOrganizeValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedInboxTasksOrganize(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedInboxTasksOrganize>[0])));
    },
    inboxTasksOrganizeCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedInboxTasksOrganize(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedInboxTasksOrganize>[0])));
    },
    inboxTasksOrganizeOutcome(json: string): string {
        return submit(async () => unwrap(await contract.inboxTasksOrganizeOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.inboxTasksOrganizeOutcome>[0])));
    },
    projectOrganizeDestinationCreatePrepare(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project destination creation requires iOS'); requireSaved(); return unwrap(await contract.prepareProjectOrganizeDestinationCreate(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareProjectOrganizeDestinationCreate>[0])); });
    },
    projectOrganizeDestinationCreateValidate(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project destination creation requires iOS'); return unwrap(contract.validatePreparedProjectOrganizeDestinationCreate(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedProjectOrganizeDestinationCreate>[0])); });
    },
    projectOrganizeDestinationCreateCommit(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project destination creation requires iOS'); return unwrap(await contract.commitPreparedProjectOrganizeDestinationCreate(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedProjectOrganizeDestinationCreate>[0])); });
    },
    projectOrganizeDestinationCreateOutcome(json: string): string {
        return submit(async () => { if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Project destination creation requires iOS'); return unwrap(await contract.projectOrganizeDestinationCreateOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.projectOrganizeDestinationCreateOutcome>[0])); });
    },
    inboxOrganizeDestinationCreatePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareInboxOrganizeDestinationCreate(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareInboxOrganizeDestinationCreate>[0])); });
    },
    inboxOrganizeDestinationCreateValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedInboxOrganizeDestinationCreate(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedInboxOrganizeDestinationCreate>[0])));
    },
    inboxOrganizeDestinationCreateCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedInboxOrganizeDestinationCreate(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedInboxOrganizeDestinationCreate>[0])));
    },
    inboxOrganizeDestinationCreateOutcome(json: string): string {
        return submit(async () => unwrap(await contract.inboxOrganizeDestinationCreateOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.inboxOrganizeDestinationCreateOutcome>[0])));
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
    trashItemsRestorePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareTrashItemsRestore(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareTrashItemsRestore>[0])); });
    },
    trashItemsRestoreValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTrashItemsRestore(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedTrashItemsRestore>[0])));
    },
    trashItemsRestoreCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTrashItemsRestore(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedTrashItemsRestore>[0])));
    },
    trashItemsRestoreOutcome(json: string): string {
        return submit(async () => unwrap(contract.trashItemsRestoreOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.trashItemsRestoreOutcome>[0])));
    },
    trashItemsPurgePrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareTrashItemsPurge(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareTrashItemsPurge>[0])); });
    },
    trashItemsPurgeValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTrashItemsPurge(completionJson(json, 2_000_000) as Parameters<typeof contract.validatePreparedTrashItemsPurge>[0])));
    },
    trashItemsPurgeCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedTrashItemsPurge(completionJson(json, 2_000_000) as Parameters<typeof contract.commitPreparedTrashItemsPurge>[0])));
    },
    trashItemsPurgeOutcome(json: string): string {
        return submit(async () => unwrap(contract.trashItemsPurgeOutcome(completionJson(json, 2_000_000) as Parameters<typeof contract.trashItemsPurgeOutcome>[0])));
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
    reviewProjectCompletionPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareReviewProjectCompletion(editorJson(json) as Parameters<typeof contract.prepareReviewProjectCompletion>[0])); });
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

    draftPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(await contract.prepareTaskDraftSaveV2(editorJson(json) as Parameters<typeof contract.prepareTaskDraftSaveV2>[0]));
        });
    },

    reviewTaskPrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(await contract.prepareReviewTaskWrite(editorJson(json) as Parameters<typeof contract.prepareReviewTaskWrite>[0]));
        });
    },

    draftValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedTaskDraftSave(editorJson(json) as Parameters<typeof contract.validatePreparedTaskDraftSave>[0])));
    },

    draftCommit(json: string): string {
        return submit(async () => taskResult('saveTaskDraft', await contract.commitPreparedTaskDraftSave(editorJson(json) as Parameters<typeof contract.commitPreparedTaskDraftSave>[0])));
    },
    rowQuickStatusOptions(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row quick status requires iOS');
            requireSaved(); return unwrap(await contract.getRowQuickStatusOptions(completionJson(json, 4_096) as Parameters<typeof contract.getRowQuickStatusOptions>[0]));
        });
    },
    rowQuickStatusPrepare(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row quick status requires iOS');
            requireSaved(); return unwrap(await contract.prepareRowQuickStatusWrite(completionJson(json, 4_096) as Parameters<typeof contract.prepareRowQuickStatusWrite>[0]));
        });
    },
    rowQuickStatusValidate(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row quick status requires iOS');
            return unwrap(contract.validatePreparedRowQuickStatusWrite(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedRowQuickStatusWrite>[0]));
        });
    },
    rowQuickStatusCommit(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row quick status requires iOS');
            return unwrap(await contract.commitPreparedRowQuickStatusWrite(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedRowQuickStatusWrite>[0]));
        });
    },
    rowQuickStatusOutcome(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Row quick status requires iOS');
            return unwrap(contract.rowQuickStatusOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.rowQuickStatusOutcome>[0]));
        });
    },
    inlineChecklistPrepare(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Inline checklist requires iOS');
            requireSaved(); return unwrap(await contract.prepareInlineChecklistWrite(completionJson(json, 2_000_000) as Parameters<typeof contract.prepareInlineChecklistWrite>[0]));
        });
    },
    inlineChecklistValidate(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Inline checklist requires iOS');
            return unwrap(contract.validatePreparedInlineChecklistWrite(completionJson(json, 2_100_000) as Parameters<typeof contract.validatePreparedInlineChecklistWrite>[0]));
        });
    },
    inlineChecklistCommit(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Inline checklist requires iOS');
            return unwrap(await contract.commitPreparedInlineChecklistWrite(completionJson(json, 2_100_000) as Parameters<typeof contract.commitPreparedInlineChecklistWrite>[0]));
        });
    },
    inlineChecklistOutcome(json: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('INVALID_INPUT: Inline checklist requires iOS');
            return unwrap(contract.inlineChecklistOutcome(completionJson(json, 2_100_000) as Parameters<typeof contract.inlineChecklistOutcome>[0]));
        });
    },
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

    captureOpen(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.openQuickCapture());
        });
    },

    captureView(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getQuickCaptureView(JSON.parse(json)));
        });
    },

    captureEdit(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.editQuickCapture(JSON.parse(json)));
        });
    },
    iosReviewAIWitness(json: string): string {
        return submit(async () => { if (!iosReviewAI) throw new Error('NOT_READY: Review AI is unavailable'); return iosReviewAI.witness(json); });
    },
    iosReviewAIRequest(json: string, owner: (json: string) => unknown): string {
        return submit(async signal => { if (!iosReviewAI) throw new Error('NOT_READY: Review AI is unavailable'); return iosReviewAI.request(json, owner, signal); });
    },
    iosReviewAIValidateApply(json: string, durableSQLJSON: string): string {
        return submit(async () => { if (!iosReviewAI) throw new Error('NOT_READY: Review AI is unavailable'); return iosReviewAI.validateApply(json, durableSQLJSON); });
    },
    iosReviewAIOutcome(json: string): string {
        return submit(async () => { if (!iosReviewAI) throw new Error('NOT_READY: Review AI is unavailable'); return iosReviewAI.outcome(json); });
    },
    iosReviewAIApply(json: string): string {
        return submit(async () => { if (!iosReviewAI) throw new Error('NOT_READY: Review AI is unavailable'); return iosReviewAI.apply(json); });
    },
    iosInboxAIWitness(json: string): string {
        return submit(async () => {
            if (!iosInboxAI) throw new Error('NOT_READY: Inbox AI is unavailable');
            return iosInboxAI.witness(json);
        });
    },
    iosInboxAIRequest(json: string, owner: (json: string) => unknown): string {
        return submit(async signal => {
            if (!iosInboxAI) throw new Error('NOT_READY: Inbox AI is unavailable');
            return iosInboxAI.request(json, owner, signal);
        });
    },
    iosInboxAIApply(json: string, owner: () => unknown): string {
        return submit(async () => {
            if (!iosInboxAI) throw new Error('NOT_READY: Inbox AI is unavailable');
            return iosInboxAI.apply(json, owner);
        });
    },
    iosTaskAIOptions(json: string): string {
        return submit(async () => {
            if (!iosTaskAI) throw new Error('NOT_READY: Task AI is unavailable');
            return iosTaskAI.options(json);
        });
    },
    iosTaskAIWitness(json: string): string {
        return submit(async () => {
            if (!iosTaskAI) throw new Error('NOT_READY: Task AI is unavailable');
            return iosTaskAI.witness(json);
        });
    },
    iosTaskAIRequest(json: string, owner: (json: string) => unknown): string {
        return submit(async signal => {
            if (!iosTaskAI) throw new Error('NOT_READY: Task AI is unavailable');
            return iosTaskAI.request(json, owner, signal);
        });
    },
    captureCopilotOptions(json: string, available: boolean): string {
        return submit(async () => {
            requireSaved();
            if (globalThis.__mindwtrHostPlatform !== 'ios' || typeof available !== 'boolean') throw new Error('NOT_READY: Capture copilot is unavailable');
            const settings = useTaskStore.getState().settings;
            const value = unwrap(contract.getCaptureCopilotOptions({ ...JSON.parse(json), aiKey: { required: isAIKeyRequired(settings), available } }));
            iosCaptureAIQuestion = value.request ? { revision: value.revision, request: value.request,
                settings, language: unwrap(contract.getStrings({ keys: [] })).language } : null;
            return value;
        });
    },
    captureCopilotEdit(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.editCaptureCopilot(JSON.parse(json))); });
    },
    iosCaptureCopilotRequest(json: string, owner: (json: string) => unknown): string {
        return submit(async (signal) => {
            const question = iosCaptureAIQuestion, adapter = bootAdapter;
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !question || !adapter || iosCaptureAIHost || iosConfigurationAIHost || iosConfigurationAIActive || iosTaskAI?.active || iosInboxAI?.active || iosReviewAI?.active || typeof owner !== 'function'
                || !taskEditValuesEqual(completionJson(json, 2_000_000), { revision: question.revision, request: question.request })) {
                throw new Error('STALE_REVISION: Capture copilot question changed');
            }
            const settings = question.settings, frozen = JSON.parse(JSON.stringify(settings));
            const provider = settings.ai?.provider ?? 'openai';
            if (!['openai', 'gemini', 'anthropic'].includes(provider)) throw new Error('NOT_READY: Capture copilot is unavailable');
            const generation = getPersistenceStatus().generation;
            const admit = (request: object) => {
                if (checked(owner(JSON.stringify(request))) !== '') throw new Error('NOT_READY: Capture copilot owner is unavailable');
            };
            const current = () => {
                const status = getPersistenceStatus(), state = useTaskStore.getState();
                if (signal.aborted || iosCaptureAIQuestion !== question || bootAdapter !== adapter || getStorageAdapter() !== adapter
                    || isSandboxMode() || isWorkspaceTransitionActive() || state.settings !== settings || !taskEditValuesEqual(state.settings, frozen)
                    || unwrap(contract.getStrings({ keys: [] })).language !== question.language || status.generation !== generation
                    || status.failed || status.queued || status.inFlight || status.immediate || status.retrying
                    || state.isLoading || state.editLockCount > 0) throw new Error('STALE_REVISION: Capture copilot owner changed');
                requireSaved(); admit({ phase: 'current' });
            };
            admit({ phase: 'begin', provider, configuration: JSON.stringify(settings.ai ?? {}), language: question.language });
            const unavailable = async (): Promise<never> => { throw new Error('NOT_READY: Capture copilot storage is read-only'); };
            const host: NativeAIHost = {
                platform: { isFossBuild },
                storage: { getItem: unavailable, setItem: unavailable, removeItem: unavailable },
                secrets: { get: unavailable, set: unavailable, delete: unavailable },
                loadRequestKey: async (selected) => {
                    current();
                    if (selected !== provider) throw new Error('STALE_REVISION: Capture copilot provider changed');
                    const raw = checked(owner(JSON.stringify({ phase: 'credential', provider: selected })));
                    if (typeof raw !== 'string') throw new Error('NOT_READY: Capture copilot credential is unavailable');
                    const loaded = completionJson(raw, 32 * 1024);
                    current();
                    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) || Object.keys(loaded).length !== 1
                        || !('value' in loaded) || (loaded.value !== null && (typeof loaded.value !== 'string' || loaded.value.length > 4000))) {
                        throw new Error('NOT_READY: Capture copilot credential is unavailable');
                    }
                    return loaded.value;
                },
                fetch: async (input, init) => {
                    current();
                    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                    admit({ phase: 'http', url });
                    const response = await globalThis.fetch(input, init);
                    current(); return response;
                },
            };
            iosCaptureAIHost = host;
            try {
                current();
                const value = unwrap(await contract.requestAICopilot({ request: question.request }, { signal }));
                current();
                return { suggestion: value.suggestion ? { ...value.suggestion, language: question.language } : null };
            } finally { if (iosCaptureAIHost === host) iosCaptureAIHost = null; }
        });
    },
    captureSubmit(json: string): string {
        return submit(async () => taskResult('quickCapture', await contract.submitQuickCapture(JSON.parse(json))));
    },

    capturePrepare(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.prepareQuickCapture(JSON.parse(json)));
        });
    },
    captureCopilotPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.prepareQuickCaptureCopilot(JSON.parse(json))); });
    },
    captureCommit(json: string): string {
        return submit(async () => taskResult('quickCapture', await contract.commitPreparedQuickCapture(JSON.parse(json))));
    },

    captureLinesPrepare(json: string): string {
        return submit(async () => {
            captureLinesWarmAdmission = null;
            const adapter = bootAdapter;
            const stale = () => new Error('STALE_REVISION: Capture lines preparation is no longer current');
            const ready = () => {
                if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
                    || getStorageAdapter() !== adapter || !adapter.concurrentWritesGuarded
                    || isSandboxMode() || isWorkspaceTransitionActive()) throw stale();
                requireSaved(); unwrap(contract.getDataSettings());
                return getPersistenceStatus();
            };
            ready();
            await flushPendingSave();
            const status = ready(), state = useTaskStore.getState();
            const assertSettled = () => {
                const currentStatus = ready();
                if (currentStatus.failed || currentStatus.queued || currentStatus.inFlight || currentStatus.immediate
                    || currentStatus.retrying || currentStatus.generation !== status.generation) throw stale();
            };
            const assertCurrent = () => {
                assertSettled();
                const current = useTaskStore.getState();
                if (current._allTasks !== state._allTasks || current._allProjects !== state._allProjects
                    || current._allSections !== state._allSections || current._allAreas !== state._allAreas
                    || current._allPeople !== state._allPeople || current.settings !== state.settings) throw stale();
            };
            assertCurrent();


            if (!await adapter!.readRowBaseline()) throw stale();
            assertCurrent();
            const data = await adapter!.getData();
            assertCurrent();
            if (!data || !['tasks', 'projects', 'sections', 'areas', 'people'].every((name) => Array.isArray(data[name as keyof AppData]))
                || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)
                || validateMergedSyncData(data).length !== 0) throw new Error('INVALID_INPUT: Saved capture recovery data is incomplete');
            const planned = unwrap(contract.prepareQuickCaptureLines(captureLinesJson(json) as Parameters<typeof contract.prepareQuickCaptureLines>[0]));
            assertCurrent();
            if (planned.kind === 'refused') return planned;
            const planJSON = JSON.stringify({ request: planned.prepared.request, prepared: planned.prepared });
            unwrap(contract.validatePreparedQuickCaptureLines(captureLinesJson(planJSON)));
            const recoveryJSON = serializeBackupData(data);
            if (new TextEncoder().encode(recoveryJSON).byteLength > 128 * 1024 * 1024) throw new Error('INVALID_INPUT: Recovery snapshot exceeds 128 MiB');
            assertCurrent();
            captureLinesWarmAdmission = { planJSON, assertCurrent };
            return { kind: 'prepared', planJSON, recoveryJSON };
        });
    },

    captureLinesValidate(planJSON: string): string {
        return submit(async () => unwrap(contract.validatePreparedQuickCaptureLines(captureLinesJson(planJSON))));
    },
    captureLinesAdmission(planJSON: string): string {
        return submit(async () => { requireCaptureLinesAdmission(planJSON); return true; });
    },

    captureLinesCommit(planJSON: string, firstAdmission = false): string {
        return submit(async () => {
            const plan = captureLinesJson(planJSON) as Parameters<typeof contract.commitPreparedQuickCaptureLines>[0];
            if (firstAdmission) requireCaptureLinesAdmission(planJSON);
            const result = unwrap(await contract.commitPreparedQuickCaptureLines(plan));
            if (captureLinesWarmAdmission?.planJSON === planJSON) captureLinesWarmAdmission = null;
            return result;
        });
    },
    appleReminderSourceRemovalAcknowledged(outcome: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !['confirmed', 'unconfirmed'].includes(outcome))
                throw new Error('INVALID_INPUT: Invalid Reminders removal outcome');
            logInfo('Native Reminders source removal finished', { scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-reminders-source-removal', outcome } });
            await diagnosticsLog.serialize(async () => undefined);
            return {};
        });
    },
    appleReminderImportRunAcknowledged(outcome: string, importedCount: number, failedCount: number): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !['completed', 'interrupted'].includes(outcome)
                || ![importedCount, failedCount].every((value) => Number.isInteger(value) && value >= 0 && value <= 10_000))
                throw new Error('INVALID_INPUT: Invalid Reminders run outcome');
            logInfo('Native Reminders import run finished', { scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-reminders-run', outcome, importedCount, failedCount } });
            await diagnosticsLog.serialize(async () => undefined);
            return {};
        });
    },
    appleReminderAccessAcknowledged(outcome: string): string {
        return submit(async () => {
            if (!['granted', 'denied', 'undetermined', 'unavailable'].includes(outcome))
                throw new Error('INVALID_INPUT: Invalid Reminders permission');
            logInfo('Native Reminders access request finished', { scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-reminders-access', outcome } });
            await diagnosticsLog.serialize(async () => undefined);
            return {};
        });
    },
    appleReminderSettingsOptions(registryRaw: string | null): string {
        return submit(async () => {
            const { importedReminderIds: _ids, ...settings } = appleReminderRegistry(registryRaw);
            return { settings, expectedRaw: registryRaw };
        });
    },
    appleReminderSettingPrepare(editJSON: string, registryRaw: string | null): string {
        return submit(async () => {
            const edit = appleReminderJSON(editJSON) as Record<string, unknown>;
            if (!edit || typeof edit !== 'object' || Array.isArray(edit))
                throw new Error('INVALID_INPUT: Invalid Reminders preference');
            const registry = appleReminderRegistry(registryRaw);
            if (edit.type === 'selectedList') {
                if (Object.keys(edit).sort().join(',') !== 'id,sourceId,title,type'
                    || typeof edit.title !== 'string'
                    || ![edit.id, edit.sourceId].every((value) => typeof value === 'string' && value.trim().length > 0))
                    throw new Error('INVALID_INPUT: Invalid Reminders list');
                registry.selectedListId = edit.id as string;
                registry.selectedListTitle = edit.title as string;
            } else {
                if (!['autoImportOnOpen', 'deleteImportedReminders'].includes(edit.type as string)
                    || Object.keys(edit).sort().join(',') !== 'type,value' || typeof edit.value !== 'boolean')
                    throw new Error('INVALID_INPUT: Invalid Reminders preference');
                registry[edit.type as 'autoImportOnOpen' | 'deleteImportedReminders'] = edit.value;
            }
            return { nextRaw: JSON.stringify(normalizeAppleRemindersImportSettings(registry)) };
        });
    },
    appleReminderSettingAcknowledged(): string {
        return submit(async () => {
            logInfo('Native Reminders preference saved', { scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-reminders-setting', outcome: 'confirmed' } });
            await diagnosticsLog.serialize(async () => undefined);
            return {};
        });
    },
    appleReminderImportOptions(registryRaw: string | null): string {
        return submit(async () => appleReminderRegistry(registryRaw));
    },

    appleReminderItemPrepare(sourceJSON: string, registryRaw: string | null): string {
        return submit(async () => {
            appleReminderWarmAdmission = null;
            const adapter = appleReminderAdapter();
            const source = appleReminderJSON(sourceJSON) as Omit<NativeAppleReminderImportRequest, 'generatedTaskId'>;
            if (!source || typeof source !== 'object' || Array.isArray(source)
                || Object.keys(source).sort().join(',') !== 'list,reminder,requestId,version'
                || source.version !== 1 || typeof source.requestId !== 'string'
                || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(source.requestId)
                || !source.list || typeof source.list.id !== 'string' || typeof source.list.sourceId !== 'string'
                || !source.reminder || typeof source.reminder !== 'object')
                throw new Error('INVALID_INPUT: Invalid native Reminders source');
            const registry = appleReminderRegistry(registryRaw);
            if (registry.selectedListId !== source.list.id) throw new Error('STALE_REVISION: The selected Reminders list changed');
            const candidate = classifyAppleReminderForImport(source.reminder, source.list.id.trim(), new Set(registry.importedReminderIds));
            if (candidate.kind !== 'candidate') return { kind: 'noop', reason: candidate.kind };
            const request: NativeAppleReminderImportRequest = { ...source, generatedTaskId: candidate.captureId ? null : generateUUID() };
            const targetId = candidate.captureId ?? request.generatedTaskId!;
            const stale = () => new Error('STALE_REVISION: Reminders import preparation changed');
            const ready = () => {
                if (appleReminderAdapter() !== adapter) throw stale();
                requireSaved(); unwrap(contract.getDataSettings());
                const status = getPersistenceStatus();
                if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying
                    || useTaskStore.getState().editLockCount > 0 || useTaskStore.getState().isLoading) throw stale();
                return status;
            };
            const status = ready(), state = useTaskStore.getState();
            const references = [state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings];
            const frozen = JSON.parse(JSON.stringify(references)) as unknown;
            const assertCurrent = () => {
                if (ready().generation !== status.generation) throw stale();
                const current = useTaskStore.getState();
                const values = [current._allTasks, current._allProjects, current._allSections, current._allAreas, current._allPeople, current.settings];
                if (current.lastDataChangeAt !== state.lastDataChangeAt || !values.every((value, index) => value === references[index])
                    || !taskEditValuesEqual(values, frozen)) throw stale();
            };
            assertCurrent(); if (!await adapter.readRowBaseline()) throw stale(); assertCurrent();
            const data = await adapter.getData({ rawTasks: true }); assertCurrent();
            const matches = data.tasks.filter((task) => task.id === targetId);
            if (matches.length > 1 || matches.length === 1 && !hasRawReadRow(matches[0])) throw stale();
            const row = matches.length ? [...rawReadRow(matches[0], taskToSqliteRow(matches[0])).row] as (string | number | null)[] : null;
            const device = row ? null : ensureDeviceId(data.settings);
            const plan = prepareNativeAppleReminderImportItem({ request, target: { id: targetId, row }, factory: row ? null : {
                preparedAt: new Date().toISOString(), deviceIdBefore: data.settings.deviceId ?? null,
                deviceIdToInitialize: device!.updated ? device!.deviceId : null,
                effectiveDefaultAreaId: resolveDefaultNewTaskAreaId(data.settings, data.areas ?? []) ?? null,
            } }, getTaskReminderDefault(data.settings));
            if (!plan) throw new Error('INVALID_INPUT: Reminders candidate could not be prepared');
            const planJSON = JSON.stringify({ request: plan.request, prepared: plan });
            validatePreparedNativeAppleReminderImportItem(appleReminderJSON(planJSON));
            const recoveryJSON = serializeBackupData(data);
            if (new TextEncoder().encode(recoveryJSON).byteLength > 128 * 1024 * 1024)
                throw new Error('INVALID_INPUT: Recovery snapshot exceeds 128 MiB');
            assertCurrent(); appleReminderWarmAdmission = { planJSON, assertCurrent };
            return { kind: 'prepared', planJSON, recoveryJSON };
        });
    },

    appleReminderRegistryPlan(planJSON: string, registryRaw: string | null): string {
        return submit(async () => {
            const plan = validatePreparedNativeAppleReminderImportItem(appleReminderJSON(planJSON));
            const registry = appleReminderRegistry(registryRaw);
            const nextRaw = JSON.stringify(normalizeAppleRemindersImportSettings({ ...registry,
                importedReminderIds: [...registry.importedReminderIds, plan.result.importKey] }));
            if (new TextEncoder().encode(nextRaw).byteLength > 1024 * 1024)
                throw new Error('INVALID_INPUT: Reminders registry exceeds its limit');
            return { nextRaw };
        });
    },
    appleReminderItemValidate(planJSON: string): string {
        return submit(async () => validatePreparedNativeAppleReminderImportItem(appleReminderJSON(planJSON)).result);
    },
    appleReminderItemAdmission(planJSON: string): string {
        return submit(async () => {
            if (appleReminderWarmAdmission?.planJSON !== planJSON) throw new Error('STALE_REVISION: Reminders import admission changed');
            appleReminderWarmAdmission.assertCurrent(); return true;
        });
    },
    appleReminderItemCommit(planJSON: string, firstAdmission: boolean): string {
        return submit(async () => {
            if (typeof firstAdmission !== 'boolean') throw new Error('INVALID_INPUT: Invalid Reminders import admission');
            appleReminderAdapter();
            if (firstAdmission) {
                if (appleReminderWarmAdmission?.planJSON !== planJSON) throw new Error('STALE_REVISION: Reminders import admission changed');
                appleReminderWarmAdmission.assertCurrent(); appleReminderWarmAdmission = null;
            }
            const result = unwrap(await appleReminderItemOwner.commit(appleReminderJSON(planJSON)));

            requireSaved();
            return result;
        });
    },
    appleReminderItemAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform === 'ios') {
                logInfo('Native Reminders item and import registry confirmed', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-reminders-item', outcome: 'confirmed' } });
                await diagnosticsLog.serialize(async () => undefined);
            }
            return {};
        });
    },
    appleReminderItemOutcome(planJSON: string): string {
        return submit(async () => { appleReminderAdapter(); return unwrap(await appleReminderItemOwner.outcome(appleReminderJSON(planJSON))); });
    },
    pomodoroPanelRead(json: string): string {
        return submit(async () => {
            const presentation = readNativePomodoroPresentation(pomodoroJSON(json, 8192));
            const { raw, current } = await readSavedNativePomodoro();
            const t = (key: string) => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key;
            const panel = buildNativePomodoroPanel({ ...presentation, raw, settings: current.settings,
                liveTasks: current.tasks, nowMs: Date.now(), t });
            if (new TextEncoder().encode(JSON.stringify(panel)).byteLength > 1_000_000)
                throw new Error('INVALID_INPUT: Pomodoro presentation exceeds the bounded native read');
            if (globalThis.__mindwtrHostPlatform === 'ios') logInfo('Native Pomodoro panel state read', { scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-pomodoro-panel', outcome: panel.kind } });
            return panel;
        });
    },
    pomodoroAlarmRead(): string {
        return submit(async () => {
            const { raw, current } = await readSavedNativePomodoro();
            const t = (key: string) => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key;
            const intent = buildNativePomodoroAlarmIntent({ raw, settings: current.settings, nowMs: Date.now(), t });
            if (new TextEncoder().encode(JSON.stringify(intent)).byteLength > 16_384)
                throw new Error('INVALID_INPUT: Pomodoro alarm exceeds the native read limit');
            logInfo('Native Pomodoro alarm intent read', { scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.5/ios-pomodoro-alarm-plan', outcome: intent.kind } });
            return intent;
        });
    },


    pomodoroAlarmPlan(granted: boolean, raw: string | null, scope: string, pendingJSON: string, deliveredJSON: string): string {

        raw ??= null;
        return submit(async () => {
            if (typeof granted !== 'boolean') throw new Error('INVALID_INPUT: Invalid Pomodoro permission');
            const settings = useTaskStore.getState().settings;

            const session = !granted || settings.gtd?.pomodoro?.completionAlert === false
                ? null : (await pomodoroAdapter().readPomodoroSession()).raw;
            const nowMs = Date.now();
            const intent = buildNativePomodoroAlarmIntent({ raw: session, settings, nowMs,
                t: (key) => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key });
            const plan = planNativePomodoroAlarmEffects({ intent, granted, raw, scope, nowMs,
                pending: pomodoroJSON(pendingJSON, 4 * 1024 * 1024), delivered: pomodoroJSON(deliveredJSON, 4 * 1024 * 1024),
                android: { deliveryLedger: true, lateLimitMs: NATIVE_POMODORO_LATE_LIMIT_MS } });


            if (!plan.schedule) return plan;
            const details = plan.schedule.details as { data?: Record<string, string> };
            return { ...plan, schedule: { ...plan.schedule, details: { ...details, channelName: REMINDER_NOTIFICATION_CHANNEL_NAME,
                data: { ...details.data, endsAtMs: String(plan.schedule.fireAtMs) } } } };
        });
    },

    pomodoroAlarmSaved(outcome: string): string {
        return submit(async () => {
            if (!['scheduled', 'retained', 'cancelled', 'uncertain', 'uninitialized', 'legacy-shown'].includes(outcome))
                throw new Error('INVALID_INPUT: Invalid Pomodoro alarm outcome');
            logInfo('Native Android Pomodoro alarm reconciliation saved', { scope: 'native-android', force: true,
                context: { releaseCheck: 'v1.3.8/native-pomodoro-alarm', outcome } });
            return {};
        });
    },


    pomodoroLegacyAlert(raw: string | null, upgradedAtMs: number): string {

        raw ??= null;
        return submit(async () => {
            pomodoroAdapter();
            if ((raw !== null && typeof raw !== 'string') || !Number.isSafeInteger(upgradedAtMs) || upgradedAtMs <= 0)
                throw new Error('INVALID_INPUT: Invalid RN Pomodoro record');
            const alert = buildNativePomodoroLegacyAlert({ raw, settings: useTaskStore.getState().settings, nowMs: Date.now(), upgradedAtMs,
                t: (key) => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key });
            return alert.kind === 'show' ? { ...alert, details: { ...alert.details, channelName: REMINDER_NOTIFICATION_CHANNEL_NAME } } : alert;
        });
    },
    pomodoroSessionRead(): string {
        return submit(async () => pomodoroAdapter().readPomodoroSession());
    },
    pomodoroTransitionPrepare(requestJSON: string): string {
        return submit(() => preparePomodoroRequest(requestJSON));
    },
    iosWatchPomodoroPrepare(sourceJSON: string): string {
        return submit(() => preparePomodoroRequest('', sourceJSON));
    },
    pomodoroTransitionValidate(planJSON: string): string {
        return submit(async () => validatePreparedNativePomodoroTransition(pomodoroJSON(planJSON)).result);
    },
    pomodoroTransitionCommit(planJSON: string, replayOnly: boolean): string {
        return submit(async () => {


            if (typeof replayOnly !== 'boolean') throw new Error('INVALID_INPUT: Invalid Pomodoro replay authority');
            const plan = validatePreparedNativePomodoroTransition(pomodoroJSON(planJSON));
            if (!replayOnly && pomodoroWarmAdmission?.planJSON === planJSON) {
                pomodoroWarmAdmission.assertCurrent();
                pomodoroWarmAdmission = null;
            }
            const adapter = pomodoroAdapter();
            try { return await adapter.savePomodoroTransitionWithReceipt(plan, { replayOnly }); }
            catch (error) {
                if (error instanceof NativePomodoroTransitionRefusal)
                    throw new Error(error.code === 'staleBaseline' ? 'STALE_REVISION: Pomodoro baseline changed before mutation'
                        : 'NOT_READY: Pomodoro storage refused before mutation');
                throw new Error('Pomodoro transition could not be proven');
            }
        });
    },
    pomodoroTransitionOutcome(planJSON: string): string {
        return submit(async () => pomodoroAdapter().readPomodoroTransitionOutcome(validatePreparedNativePomodoroTransition(pomodoroJSON(planJSON))));
    },

    mindSweepGuide(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getMindSweepGuide(JSON.parse(json))); });
    },
    weeklyReviewProjectTaskOptions(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.getWeeklyReviewProjectTaskOptions(JSON.parse(json))); });
    },
    weeklyReviewProjectTaskPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(await contract.prepareWeeklyReviewProjectTask(JSON.parse(json))); });
    },
    weeklyReviewProjectTaskValidate(json: string): string {
        return submit(async () => unwrap(contract.validatePreparedWeeklyReviewProjectTask(JSON.parse(json))));
    },
    weeklyReviewProjectTaskCommit(json: string): string {
        return submit(async () => unwrap(await contract.commitPreparedWeeklyReviewProjectTask(JSON.parse(json))));
    },
    weeklyReviewProjectTaskOutcome(json: string): string {
        return submit(async () => unwrap(contract.weeklyReviewProjectTaskOutcome(JSON.parse(json))));
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

    captureSnapshot(): string {
        return submit(async () => ({ snapshot: unwrap(await contract.createQuickCaptureSnapshot()) }));
    },


    captureSnapshotFile(handle: string): string {
        return submit(async () => {
            const snapshot = unwrap(await contract.createQuickCaptureSnapshot());
            if (!snapshot) return { snapshot: null };
            try {
                await channelWriteFile(handle, snapshot.contents, false);
                return { snapshot: { fileName: snapshot.fileName, ...channelClose(handle) } };
            } catch (error) {
                if (channelCode(error)) throw new Error('SAVE_FAILED: The recovery snapshot could not be written');
                throw error;
            }
        });
    },


    dataExportFile(format: string, handle: string, maxBytes: number): string {
        return submit(async () => runSerializedSyncDocumentWriteOperation(async () => {
            if (format !== 'json' && format !== 'csv' && format !== 'tasknotes') throw new Error('INVALID_INPUT: Unsupported export format');
            const settled = () => {
                const pending = getPersistenceStatus();
                return !(pending.queued || pending.inFlight || pending.immediate || pending.retrying || pending.failed);
            };
            if (!settled()) throw new Error('NOT_READY: Backup export is unavailable while saving is pending');
            const stamp = useTaskStore.getState().lastDataChangeAt;
            if (await backupAdapter().libraryBytes() > Number(maxBytes)) throw new Error('TOO_LARGE: The library exceeds the transfer limit');
            if (!settled() || useTaskStore.getState().lastDataChangeAt !== stamp) throw new Error('NOT_READY: The library changed while the export was checked');
            const file = unwrap(contract.getDataBackup(format));
            try {
                await channelWriteFile(handle, file.content, file.encoding === 'base64');
                return { fileName: file.fileName, bytes: channelClose(handle).bytes };
            } catch (error) {
                if (channelCode(error)) throw new Error('SAVE_FAILED: The export file could not be written');
                throw error;
            }
        }));
    },


    dataChannelRoundTrip(readHandle: string, writeHandle: string): string {
        return submit(async () => {
            const text = channelRead(readHandle);
            channelClose(readHandle);
            channelWrite(writeHandle, text);
            return channelClose(writeHandle);
        });
    },

    captureLines(json: string): string {
        return submit(async () => taskResult('quickCaptureLines', await contract.submitQuickCaptureLines(JSON.parse(json))));
    },

    capturePicker(json: string): string {
        return submit(async () => taskResult('quickCapturePicker', await contract.submitQuickCapturePickerQuery(JSON.parse(json))));
    },

    captureModalSubmit(json: string): string {
        return submit(async () => taskResult('captureModal', await contract.submitCaptureModal(JSON.parse(json))));
    },

    captureModalLines(json: string): string {
        return submit(async () => taskResult('captureModalLines', await contract.submitCaptureModalLines(JSON.parse(json))));
    },

    complete(id: string, taskRevision = ''): string {
        return submit(async () => taskResult('complete', await contract.completeTask({ id, taskRevision: taskRevision || undefined })));
    },

    completeUndo(json: string): string {
        return submit(async () => taskResult('completeUndo', await contract.undoTaskCompletion(JSON.parse(json))));
    },

    taskFocus(id: string, focused: boolean, taskRevision = ''): string {
        return submit(async () => taskResult('taskFocus', await contract.setTaskFocus({ id, focused, taskRevision: taskRevision || undefined })));
    },
    projectFocus(id: string, focused: boolean, projectRevision = ''): string {
        return submit(async () => taskResult('projectFocus', await contract.setProjectFocus({ id, focused, projectRevision: projectRevision || undefined })));
    },

    createProject(title: string, areaId: string, requestId: string): string {
        return submit(async () => taskResult('createProject', await contract.createProject({ title, areaId: areaId || null, requestId })));
    },
    areaFilter(): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getAreaFilter());
        });
    },

    setAreaFilter(json: string): string {
        return submit(async () => taskResult('areaFilter', await contract.setAreaFilter(JSON.parse(json))));
    },


    search(json: string): string {
        return submit(async () => {
            requireSaved();
            const input = JSON.parse(json);
            return unwrap(await contract.searchTasks({ ...input, filters: input.filters ?? DEFAULT_GLOBAL_SEARCH_FILTERS }));
        });
    },

    saveSearch(json: string): string {
        return submit(async () => taskResult('saveSearch', await contract.saveSearch(JSON.parse(json))));
    },


    inboxStart(mode: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.startInboxProcessing({ mode: mode as 'guided' | 'quick', mergeSyncedChanges: globalThis.__mindwtrHostPlatform !== 'ios' }));
        });
    },
    inboxStartDetailed(mode: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.startInboxProcessing({ mode: mode as 'guided' | 'quick', includeDetails: true }));
        });
    },
    inboxEditorReload(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.reloadInboxProcessingTask(editorJson(json) as Parameters<typeof contract.reloadInboxProcessingTask>[0]));
        });
    },
    inboxStep(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.getInboxProcessingStep(JSON.parse(json)));
        });
    },

    inboxCommit(json: string): string {
        return submit(async () => taskResult('inboxCommit', await contract.commitInboxProcessingStep(JSON.parse(json))));
    },

    inboxDecisionUndo(json: string): string {
        return submit(async () => taskResult('inboxDecisionUndo', await contract.undoInboxDecision(JSON.parse(json))));
    },

    inboxSkip(json: string): string {
        return submit(async () => taskResult('inboxSkip', await contract.skipInboxProcessingTask(JSON.parse(json))));
    },

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
    inboxUndoPrepare(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.inboxUndoPrepare(JSON.parse(json))); });
    },
    inboxUndoValidate(json: string): string {
        return submit(async () => unwrap(contract.inboxUndoValidate(JSON.parse(json))));
    },
    inboxUndoCommit(json: string): string {
        return submit(async () => unwrap(await contract.inboxUndoCommit(JSON.parse(json))));
    },
    inboxUndoOutcome(json: string): string {
        return submit(async () => unwrap(contract.inboxUndoOutcome(JSON.parse(json))));
    },
    inboxAfterCommit(json: string): string {
        return submit(async () => {
            requireSaved();
            return unwrap(contract.inboxAfterCommit(JSON.parse(json)));
        });
    },

    inboxEnd(sessionId: string): string {
        return submit(async () => {
            unwrap(contract.endInboxProcessing({ sessionId }));
            return {};
        });
    },
    backupDocumentInspect(text: string, metadataJSON: string, format = 'json'): string {
        return submit(async () => inspectBackup(() => text, metadataJSON, format));
    },


    backupDocumentInspectFile(handle: string, metadataJSON: string, format = 'json'): string {
        return submit(async () => inspectBackup(() => {
            try {
                const text = channelRead(handle);
                channelClose(handle);
                return text;
            } catch (error) {
                if (channelCode(error) === 'DATA_UTF8') return '';
                if (channelCode(error)) throw new Error('SAVE_FAILED: The selected file could not be read');
                throw error;
            }
        }, metadataJSON, format));
    },


    backupDocumentPrepareFile(sourceHandle: string, inputJSON: string, recoveryHandle: string, planHandle: string): string {
        return submit(async () => {
            const input = backupJson(inputJSON) as Parameters<typeof prepareNativeBackupDocument>[1];
            let text: string;
            let sourceBytes: number;
            try {
                text = channelRead(sourceHandle);
                sourceBytes = channelClose(sourceHandle).bytes;
            } catch (error) {
                if (channelCode(error) === 'DATA_UTF8') throw new Error('INVALID_INPUT: Backup file is not valid UTF-8');
                if (channelCode(error)) throw new Error('SAVE_FAILED: The selected file could not be read');
                throw error;
            }
            native().memProbe?.('prepare:read');
            if (input && typeof input === 'object' && input.admission && input.admission.sourceBytes !== sourceBytes) {
                throw new Error('INVALID_INPUT: Invalid backup document input');
            }
            const written = (write: () => void) => {
                try { write(); } catch (error) {
                    if (channelCode(error) === 'DATA_CAP') throw new Error('TOO_LARGE: The prepared backup exceeds the transfer limit');
                    if (channelCode(error)) throw new Error('SAVE_FAILED: The prepared backup could not be written');
                    throw error;
                }
            };

            const owned = { ...input, text };
            text = '';
            const result = await prepareNativeBackupDocument(backupAdapter(true), owned, {
                recovery: (recovery) => written(() => {
                    if (!recoveryHandle) throw new Error('INVALID_INPUT: Invalid backup document input');
                    channelWrite(recoveryHandle, recovery);
                }),
                plan: (part) => written(() => channelWrite(planHandle, part)),
            });
            native().memProbe?.('prepare:done');
            let plan: { bytes: number; sha256: string } | undefined;
            let recovery: { bytes: number; sha256: string } | null = null;
            written(() => {
                plan = channelClose(planHandle);
                if (result.recovery) recovery = channelClose(recoveryHandle);
            });

            return { plan: plan!, recovery, ...(result.undo === false ? { noUndo: buildNativeBackupNoUndoConfirmation(backupTranslate) } : {}) };
        });
    },
    backupDocumentPrepare(inputJSON: string): string {
        return submit(async () => prepareNativeBackupDocument(backupAdapter(true), backupJson(inputJSON) as Parameters<typeof prepareNativeBackupDocument>[1]));
    },


    backupDocumentCommit(referenceJSON: string, planJSON: string, snapshotName: string, budgetMs?: number): string {
        return submit(async () => {


            const before = getStorageTimeoutMs();
            if (typeof budgetMs === 'number' && budgetMs > 0 && !debugControl('no-commit-storage') && !debugControl('no-storage-budget')) setStorageTimeoutMs(budgetMs);
            const source = globalThis.__mindwtrHostPlatform === 'android' ? { take: () => {
                try {
                    const text = channelRead(planJSON);
                    channelClose(planJSON);
                    native().memProbe?.('commit:read');
                    return text;
                } catch (error) {
                    if (channelCode(error) === 'DATA_MISMATCH') throw new Error('INVALID_INPUT: Backup operation files do not match');
                    if (channelCode(error)) throw new Error('SAVE_FAILED: Backup plan could not be read');
                    throw error;
                }
            } } : planJSON;
            try {
                const presence = attachmentsHost?.getLocalAttachmentPresence;
                return await commitNativeBackupDocument(backupAdapter(), backupJson(referenceJSON) as Parameters<typeof commitNativeBackupDocument>[1], source, snapshotName,
                    presence ? { getLocalAttachmentPresence: (uri) => presence(uri) } : {});
            } finally {
                native().memProbe?.('commit:done');
                if (debugControl('no-activation-storage')) setStorageTimeoutMs(before);
                else if (typeof budgetMs === 'number' && budgetMs > 0) await sizeStorageTimeout(backupAdapter()).catch(() => undefined);
            }
        });
    },
    backupDocumentOutcome(referenceJSON: string, planJSON: string, snapshotName: string): string {
        return submit(async () => readNativeBackupDocumentOutcome(backupAdapter(), backupJson(referenceJSON) as Parameters<typeof readNativeBackupDocumentOutcome>[1], planJSON, snapshotName));
    },


    backupUndoHold(snapshotHandle: string, snapshotName: string): string {
        return submit(async () => {
            let text: string;
            try {
                text = channelRead(snapshotHandle);
                channelClose(snapshotHandle);
            } catch (error) {
                if (channelCode(error)) throw new Error('SAVE_FAILED: The recovery snapshot could not be read');
                throw error;
            }
            return { held: holdNativeBackupUndoAttachments(text, snapshotName) };
        });
    },


    sessionRestoreRead(): string {
        return submit(async () => ({ route: isSandboxMode() ? null : parseRestorableLastRoute(await keyValue.get(LAST_ROUTE_STORAGE_KEY), Date.now()) }));
    },

    sessionRestoreWrite(pathname: string, paramsJSON: string, ageMs = 0): string {
        return submit(async () => {
            if (isSandboxMode()) return { stored: false };
            const params = JSON.parse(paramsJSON || '{}') as Record<string, unknown>;
            const text = buildLastRouteSnapshot(pathname, params, null, Date.now() - Math.max(0, Number(ageMs) || 0));
            if (text !== null) await keyValue.set(LAST_ROUTE_STORAGE_KEY, text);
            return { stored: text !== null };
        });
    },
    backupDocumentResultModel(replyJSON: string): string {
        return submit(async () => buildNativeBackupDocumentResult(backupJson(replyJSON) as Parameters<typeof buildNativeBackupDocumentResult>[0], backupTranslate));
    },


    backupDocumentFailureModel(operation: string, error: string, limitMb: number): string {
        return submit(async () => buildNativeBackupDocumentFailure(String(operation), String(error), backupTranslate, Number(limitMb) || 0));
    },

    backupLibraryBytes(): string {
        return submit(async () => ({ bytes: await backupAdapter().libraryBytes() }));
    },

    backupSnapshotRestoreModel(snapshotName: string, mode = 'undo'): string {
        return submit(async () => {
            if (mode !== 'undo' && mode !== 'restore') throw new Error('INVALID_INPUT: Invalid backup document input');
            return buildNativeBackupSnapshotRestoreConfirmation(snapshotName, backupTranslate, mode === 'undo');
        });
    },

    backupExportPrepared(format: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform === 'ios' && (format === 'json' || format === 'csv' || format === 'tasknotes')) {
                try {
                    logInfo('Native iOS backup file prepared', {
                        scope: 'native-ios', force: true,
                        context: { releaseCheck: 'v1.3.5/ios-backup-export', outcome: 'prepared', format },
                    });
                } catch {                                                                     }
            }
            return {};
        });
    },

    logShare(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform === 'ios') {
                try {
                    logInfo('Native iOS diagnostics share requested', {
                        scope: 'native-ios', force: true,
                        context: { releaseCheck: 'v1.3.4/ios-diagnostics', operation: 'share' },
                    });
                } catch {                                         }
            }
            return { path: await diagnosticsLog.serialize(() => diagnosticsLog.ensurePath()) };
        });
    },

    logClear(): string {
        return submit(async () => {
            await diagnosticsLog.clear();
            return {};
        });
    },

    logClearChecked(): string {
        return submit(() => diagnosticsLog.clearChecked());
    },

    trashSelection(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getTrashSelection(completionJson(json, 2_000_000) as Parameters<typeof contract.getTrashSelection>[0])); });
    },
    archiveTaskSelection(json: string): string {
        return submit(async () => { requireSaved(); return unwrap(contract.getArchiveTaskSelection(completionJson(json, 2_000_000) as Parameters<typeof contract.getArchiveTaskSelection>[0])); });
    },
    doneBulkTagInput(tag: string, changedCount: number): string {
        return taskListBulkTagInput(tag, changedCount);
    },
    inboxBulkTagInput(tag: string, changedCount: number): string {
        return taskListBulkTagInput(tag, changedCount);
    },
    referenceBulkTagInput(tag: string, changedCount: number): string {
        return taskListBulkTagInput(tag, changedCount);
    },
    menuRead(name: string, json: string): string {
        return submit(async () => {


            if (name !== 'more') requireSaved();
            const read = MENU_READS[name];
            if (!read) throw new Error(`INVALID_INPUT: no menu read ${name}`);
            return unwrap(read(JSON.parse(json) as never));
        });
    },


    syncStart(appState: string): string {
        return submit(async () => {
            const state = requireSync().start(appState);

            gmailLifecycle(() => nativeGmail?.start(appState));
            void nativeCalendar?.startPush();
            return state;
        });
    },

    syncAppState(appState: string): string {
        return submit(async () => {
            gmailLifecycle(() => nativeGmail?.appState(appState));
            return requireSync().appState(appState);
        });
    },


    gmailRequest(name: string, json: string): string {
        return submit(async () => {
            if (!nativeGmail) throw new Error('Gmail capture is not available on this host');
            return nativeGmail.request(name, JSON.parse(json) as { labelId?: string; enabled?: boolean });
        });
    },


    voiceRequest(name: string, json: string): string {
        return submit(async () => {
            if (!nativeVoice) throw new Error('Voice capture is not available on this host');
            return nativeVoice.request(name, JSON.parse(json) as Record<string, unknown>);
        });
    },

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


    archiveRetention(editorOpen: boolean): string {
        return submit(async () => {
            const selectedBackend = editorOpen ? 'off' : await Promise.resolve().then(() => requireSync().selectedBackend())
                .then((backend): string | null => backend, () => null);
            return unwrap(await contract.runArchiveRetention({ editorOpen, selectedBackend }));
        });
    },

    syncState(): string {
        return submit(async () => requireSync().state());
    },


    backgroundSync(trigger: string, stored: number, deadlineMs: number): string {
        return submit(async () => {
            if (trigger !== 'scheduled' && trigger !== 'capture') throw new Error(`INVALID_INPUT: no background sync trigger ${trigger}`);
            const count = (value: number) => (Number.isInteger(value) && value > 0 ? value : 0);
            return requireSync().backgroundSync(trigger, count(stored), count(deadlineMs));
        });
    },


    pullSync(): string {
        return submit(async () => requireSync().pullSync());
    },


    iosWatchOpenAIRuntime(): string {
        const arity = arguments.length;
        return submit(async () => {
            if (arity !== 0) throw new Error('INVALID_INPUT: Watch speech runtime takes no arguments');
            iosWatchReadiness();
            const result = readWatchOpenAIRuntime(useTaskStore.getState().settings);
            iosWatchReadiness(); return result;
        });
    },
    iosWatchAudioOutcome(json: string): string {
        return submit(async () => readIOSWatchAudioOutcome(json, iosWatchReadiness));
    },
    iosWatchAudioNeedsTranscript(json: string): string {
        return submit(async () => readIOSWatchAudioNeedsTranscript(json, iosWatchReadiness));
    },
    iosWatchAudioIngest(json: string): string {
        const arity = arguments.length;
        return submit(async () => {
            if (arity !== 1) throw new Error('INVALID_INPUT: Native Watch audio requires one argument');
            requireSaved();
            return ingestIOSWatchAudio(json, { contract, current: iosWatchReadiness, lastApplied: lastAppliedRecord });
        });
    },
    iosWatchIngestOutcome(json: string): string {
        return submit(async () => readIOSWatchBatchOutcome(json, iosWatchReadiness));
    },
    iosWatchIngest(json: string): string {
        const arity = arguments.length;
        return submit(async () => {
            if (arity !== 1) throw new Error('INVALID_INPUT: Native Watch batch requires one argument');
            requireSaved();
            const result = await ingestIOSWatchBatch(json, { contract, current: iosWatchReadiness, lastApplied: lastAppliedRecord });
            logInfo('Native iOS Watch command batch saved', { scope: 'native-ios', force: true,
                context: { releaseCheck: 'v1.3.9/ios-watch-ingest', operation: 'ingest', outcome: 'saved' } });
            return result;
        });
    },
    ingest(requestId: string): string {
        return submit(async () => taskResult('ingest', await contract.ingestPendingCaptures({ requestId, queue: pendingCaptureQueue, lastApplied: lastAppliedRecord })));
    },


    ingestAudio(): string {
        return submit(async () => {
            if (!widgetAudioPort) return { ingested: 0 };
            const result = unwrap(await contract.ingestPendingAudio({ queue: pendingCaptureQueue, lastApplied: lastAppliedRecord, audio: widgetAudioPort }));
            if (result.ingested > 0) {
                try {
                    logInfo('Native Android widget recordings became tasks', { scope: 'capture', force: true,
                        context: { releaseCheck: 'v1.3.8/native-widget-audio-ingest', outcome: 'created', count: String(result.ingested) } });
                } catch {                                                 }
            }
            return result;
        });
    },


    contextAutomation(json: string): string {
        return submit(async () => {
            const { notification } = unwrap(contract.runContextAutomation(JSON.parse(json)));
            if (!notification || isSandboxMode()) return { notification: null };
            return { notification: { ...buildImmediateNotificationDetails(notification.title, notification.message, notification.data), channelName: REMINDER_NOTIFICATION_CHANNEL_NAME } };
        });
    },


    remindersStart(): string {
        return submit(async () => requireReminders().start());
    },


    appSearchStart(): string {
        return submit(async () => { void nativeAppSearch?.start(); return { started: Boolean(nativeAppSearch) }; });
    },

    appSearchApply(): string {
        return submit(async () => { await nativeAppSearch?.apply(); return { applied: Boolean(nativeAppSearch) }; });
    },

    appSearchIds(): string {
        return submit(async () => ({ ids: nativeAppSearch ? await nativeAppSearch.ids() : [] }));
    },


    remindersCycle(mode: string, key: string): string {
        return submit(async () => (mode === 'fired' && key ? requireReminders().fired(key)
            : mode === 'background' && (key === 'capture' || key === 'sync') ? requireReminders().background(key)
            : requireReminders().cycle(mode === 'rebuild')));
    },

    reminderDone(requestId: string, taskId: string): string {
        return submit(async () => taskResult('reminderDone', await contract.completeReminderTask({ requestId, taskId })));
    },


    reminderSnooze(json: string): string {
        return submit(async () => {
            const result = await contract.snoozeReminder(JSON.parse(json));
            if (result.ok) await requireReminders().snooze(result.value);
            return taskResult('reminderSnooze', result);
        });
    },
    logLinkHandoff(outcome: string, surface: string, scheme = 'upnote'): string {
        return submit(async () => {
            if (!['opened', 'failed'].includes(outcome) || !['markdown', 'attachment'].includes(surface)
                || !['upnote', 'obsidian'].includes(scheme)) return {};
            const meta = { scope: 'links', force: true, context: { outcome, surface, scheme,
                ...(scheme === 'obsidian' ? { releaseCheck: 'v1.3.9/ios-native-obsidian-link' } : {}) } };
            const noteApp = scheme === 'upnote' ? 'UpNote' : 'Obsidian';
            if (outcome === 'failed') logWarn(`Native ${noteApp} handoff failed`, meta);
            else logInfo(`Native ${noteApp} handoff accepted`, meta);
            return {};
        });
    },
    logLine(message: string, contextJson: string): string {
        return submit(async () => {
            try {
                logInfo(message, { scope: globalThis.__mindwtrHostPlatform === 'ios' ? 'native-ios' : 'native-android',
                    ...(['Native iOS capture copilot completed', 'Native iOS ordinary project next action confirmed', 'Native Whisper model store initialized', 'Native Whisper model operation failed'].includes(message) ? { force: true } : {}), context: JSON.parse(contextJson) as Record<string, unknown> });
            } catch {                                                    }
            return {};
        });
    },

    pruneReceipts(): string {
        return submit(async () => ({ pruned: await withHostConnection(() => pruneNativeRequestReceipts(sqlite)) }));
    },

    iosPruneReceipts(rawRetentionJSON: string, owedRequestId: string | null = null, owedInboxRequestIds: string[] = []): string {
        return submit(async () => {
            const invalid = () => new Error('INVALID_INPUT: Invalid reminder receipt retention');
            if (globalThis.__mindwtrHostPlatform !== 'ios' || typeof rawRetentionJSON !== 'string'
                || rawRetentionJSON.length > 8192 || new TextEncoder().encode(rawRetentionJSON).byteLength > 8192) throw invalid();
            let retained: unknown;
            try { retained = JSON.parse(rawRetentionJSON); } catch { throw invalid(); }
            if (owedRequestId !== null && (typeof owedRequestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(owedRequestId))) throw invalid();
            if (!Array.isArray(owedInboxRequestIds) || owedInboxRequestIds.length > 2
                || new Set(owedInboxRequestIds).size !== owedInboxRequestIds.length
                || owedInboxRequestIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))) throw invalid();
            if (retained !== null && (!Array.isArray(retained) || retained.length > 128
                || retained.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))
                || new Set(retained).size !== retained.length)) throw invalid();
            const pruned = await withHostConnection(() => pruneNativeRequestReceipts(sqlite, new Date(), retained === null
                ? { retainedCommands: ['reminderComplete', 'reminderSnooze', 'iosShareCapture', 'iosWidgetCompletion', 'iosWatchIngestItem'], retainedRequestIds: [...new Set([...(owedRequestId ? [owedRequestId] : []), ...owedInboxRequestIds])] }
                : { retainedCommands: ['iosShareCapture', 'iosWidgetCompletion', 'iosWatchIngestItem'], retainedRequestIds: [...new Set([...(retained as string[]), ...(owedRequestId ? [owedRequestId] : []), ...owedInboxRequestIds])] }));
            try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                message: 'Native iOS reminder receipt retention applied',
                context: { releaseCheck: 'v1.3.5/ios-reminder-receipt-retention', outcome: retained === null ? 'conservative' : 'snapshot' },
            }, { force: true }); } catch {                                                    }
            return { pruned };
        });
    },

    aboutRequest(name: string, json: string): string {
        return submit(async () => {
            const request = ABOUT_REQUESTS[name];
            if (!request) throw new Error(`INVALID_INPUT: no About request ${name}`);
            return unwrap(await request(JSON.parse(json) as never));
        });
    },

    calendarRequest(name: string, json: string): string {
        return submit(async () => {
            requireSaved();
            const request = CALENDAR_REQUESTS[name];
            if (!request) throw new Error(`INVALID_INPUT: no calendar request ${name}`);
            return unwrap(await request(JSON.parse(json) as never));
        });
    },

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
            } catch {                                                                       }
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
            } catch {                                                                       }
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
    iosTaskDraftPrepareAvailability(json: string, prepareSource: unknown, dropboxControl?: unknown): string {
        return submit(async (signal) => {
            const unavailable = () => new Error('NOT_READY: Task attachment preparation is unavailable');
            const cloudKit = nativeTaskAttachmentPreparationUsesCloudKit(json);
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || !localAttachments || nativeSync
                || iosTaskAttachmentPreparation || iosProjectFilePreparation || iosCleanupCallback || iosForegroundFailure
                || typeof prepareSource !== 'function' || (cloudKit ? !iosCloudKitAvailable() : !globalThis.__mindwtrSyncSecrets)
                || isSandboxMode() || isWorkspaceTransitionActive()) throw unavailable();
            requireSaved();
            const channels = nativeFileChannels();
            if (!channels) throw unavailable();
            let callback: ((metadataJSON: string, plaintextBase64: string) => string) | null = prepareSource as typeof callback;
            const sourceOwner = callback;
            if (dropboxControl !== undefined && typeof dropboxControl !== 'function') throw unavailable();
            iosDropboxControl = typeof dropboxControl === 'function' ? dropboxControl as (requestJSON: string) => unknown : null;
            iosDropboxSignal = signal;
            iosTaskAttachmentPreparation = true;
            if (cloudKit) iosSelectedCloudKitSource = sourceOwner;
            try {
                const dropbox = iosDropboxControl ? ensureIosManualSync().dropboxBinding : null;
                return await prepareNativeTaskAttachmentAvailability(json, {
                    ...(dropbox ? { dropbox } : {}),
                    ...(cloudKit ? { cloudKit: createNativeCloudKitAssets((request, selectedSignal) => {
                        if (!callback || iosSelectedCloudKitSource !== sourceOwner) throw unavailable();
                        return iosCloudKitCall(request, selectedSignal);
                    }) } : {}),
                    getLegacyValue: (name) => keyValue.get(name),
                    getSecret: (account) => (globalThis.__mindwtrSyncSecrets as HostSecrets).getSecret(account),
                    crypto: createHostSyncCrypto((globalThis as { __mindwtrCryptoCall?: Parameters<typeof createHostSyncCrypto>[0] }).__mindwtrCryptoCall),
                    prepareSource: (metadata, bytes) => {
                        if (!callback || signal.aborted) throw unavailable();
                        return callback(metadata, bytes);
                    },
                }, channels, signal);
            } finally {
                if (iosSelectedCloudKitSource === sourceOwner) iosSelectedCloudKitSource = null;
                callback = null; iosTaskAttachmentPreparation = false; iosDropboxControl = null; iosDropboxSignal = undefined;
            }
        });
    },
    iosProjectFilePrepareAvailability(json: string, prepareSource: unknown, dropboxControl?: unknown): string {
        return submit(async (signal) => {
            const unavailable = () => new Error('NOT_READY: Project download is unavailable');
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || !localAttachments || nativeSync
                || iosTaskAttachmentPreparation || iosProjectFilePreparation || iosCleanupCallback || iosForegroundFailure
                || typeof prepareSource !== 'function' || !globalThis.__mindwtrSyncSecrets
                || isSandboxMode() || isWorkspaceTransitionActive()) throw unavailable();
            requireSaved(); const channels = nativeFileChannels(); if (!channels) throw unavailable();
            let callback: ((metadataJSON: string, plaintextBase64: string) => string) | null = prepareSource as typeof callback;
            if (dropboxControl !== undefined && typeof dropboxControl !== 'function') throw unavailable();
            iosDropboxControl = typeof dropboxControl === 'function' ? dropboxControl as (requestJSON: string) => unknown : null;
            iosDropboxSignal = signal;
            iosProjectFilePreparation = true;
            try {
                const dropbox = iosDropboxControl ? ensureIosManualSync().dropboxBinding : null;
                const result = await prepareNativeProjectFileAvailability(json, {
                    ...(dropbox ? { dropbox } : {}),
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
            } finally { callback = null; iosProjectFilePreparation = false; iosDropboxControl = null; iosDropboxSignal = undefined; }
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

    attachmentFileEditSaveRetire(json: string, referencedCallback: () => string, taskChangedCallback: () => string,
        retireCallback: () => string): string {
        return retireAttachmentFileEditSave(json, referencedCallback, taskChangedCallback, retireCallback);
    },

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
            const cloudKitTaskAvailability = operation === 'cloudkit-task-availability' && outcome === 'confirmed';
            const dropboxAvailability = operation === 'dropbox-task-availability' && outcome === 'confirmed'
                || operation === 'dropbox-project-download' && ['confirmed', 'cleanup-pending', 'decrypted'].includes(outcome);
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
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments && !finishedDiscard && !unstartedDiscard && !removedDraft && !mixedSave && !mixedDiscard && !mixedAdd && !providerAdd && !photoAdd && !audioPlayback && !completeSave && !completeUndo && !ownedResume && !editorAcknowledged && !preexistingReplay && !containerRecovery && !fileOpen && !projectFileOpen && !relocatedOpen && !relocatedAvailability && !relocatedProjectAvailability && !cachedProjectAvailability && !projectFileRemove && !projectFileAdd && !projectFileHash && !taskFileHash && !ownedCleanup && !availabilityConsumer && !selfHostedAvailability && !projectDownload && !taskDownloadMaterial && !cloudKitTaskAvailability && !dropboxAvailability
                || !(['add', 'checkpoint', 'save'].includes(operation) && ['confirmed', 'replayed'].includes(outcome)
                    || operation === 'discard' && outcome === 'retained'
                    || operation === 'discard-capacity' && outcome === 'confirmed' || finishedDiscard || unstartedDiscard || removedDraft || mixedSave || mixedDiscard || mixedAdd || providerAdd || photoAdd || audioPlayback || completeSave || completeUndo || ownedResume || editorAcknowledged || preexistingReplay || containerRecovery || fileOpen || projectFileOpen || relocatedOpen || relocatedAvailability || relocatedProjectAvailability || cachedProjectAvailability || projectFileRemove || projectFileAdd || projectFileHash || taskFileHash || ownedCleanup || availabilityConsumer || selfHostedAvailability || projectDownload || taskDownloadMaterial || cloudKitTaskAvailability || dropboxAvailability)) return {};
            try {
                if (completeSave && outcome === 'domainSaved') await diagnosticsLog.append({
                    ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS owned raw row Save acknowledged',
                    context: { releaseCheck: 'v1.3.5/ios-owned-raw-row-save', operation, outcome },
                }, { force: true });
            } catch {                                                                          }
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS attachment draft acknowledged',
                    context: { ...(editorAcknowledged ? { releaseCheck: 'v1.3.5/ios-editor-owned-attachments' }
                        : webdavProjectDownload ? { releaseCheck: 'v1.3.5/ios-webdav-project-download' }
                        : projectDownload ? { releaseCheck: 'v1.3.5/ios-selfhosted-project-download' }
                        : taskDownloadMaterial ? { releaseCheck: 'v1.3.5/ios-task-download-material' }
                        : dropboxAvailability ? { releaseCheck: 'v1.3.9/ios-dropbox' }
                        : cloudKitTaskAvailability ? { releaseCheck: 'v1.3.9/ios-cloudkit-selected-download' }
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
            } catch {                                                               }
            return {};
        });
    },

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
                } catch {                                                                     }
            }
            return answer;
        });
    },


    abort(idText: string): null {
        pending.get(Number(idText))?.controller.abort(Object.assign(new Error('The AI request was cancelled'), { name: 'AbortError' }));
        return null;
    },

    netCheck(port: string): string {
        return submit(async () => runNetCheck(port));
    },

    netDeadline(port: string, mode: string): string {
        return submit(async (signal) => runNetDeadline(port, mode, signal));
    },


    cancel(idText: string): null {
        (globalThis.__cancelHostCalls as (message: string) => void)('The host operation timed out');
        pending.get(Number(idText))?.controller.abort(Object.assign(new Error('The host operation timed out'), { name: 'AbortError' }));
        return null;
    },

    iosReminderObserve(): string { return JSON.stringify(iosReminderEffects.observe()); },
    iosReminderObservation(): string { return JSON.stringify(iosReminderEffects.observation()); },
    iosReminderDisposeObservation(): string { return JSON.stringify(iosReminderEffects.disposeObservation()); },
    iosPomodoroAlarmBegin(token: string): string {
        return submit(async (signal) => {
            requireReminderSignal(signal);

            if (globalThis.__mindwtrHostPlatform !== 'ios' || iosPomodoroAlarmTurn
                || typeof token !== 'string' || !token || token.length > 128)
                throw new Error('NOT_READY: Pomodoro alarm turn is unavailable');
            const adapter = pomodoroAdapter(), before = useTaskStore.getState();
            const generation = getPersistenceStatus().generation;
            const ready = () => {
                requireReminderSignal(signal);
                requireSaved(); unwrap(contract.getDataSettings());
                const status = getPersistenceStatus(), state = useTaskStore.getState();
                if (pomodoroAdapter() !== adapter || state.tasks !== before.tasks || state.settings !== before.settings
                    || status.generation !== generation || status.failed || status.queued || status.inFlight
                    || status.immediate || status.retrying)
                    throw new Error('NOT_READY: Pomodoro alarm saved data changed');
            };
            const current = async () => {
                ready();
                if (!await adapter.readRowBaseline())
                    throw new Error('STALE_REVISION: Pomodoro alarm saved data changed');
                ready();
            };
            await current();
            if (iosPomodoroAlarmTurn) throw new Error('NOT_READY: Pomodoro alarm turn is unavailable');
            iosPomodoroAlarmTurn = { token, current };
            return true;
        });
    },
    iosPomodoroAlarmCurrent(token: string): string {
        return submit(async (signal) => {
            requireReminderSignal(signal); await requirePomodoroAlarmTurn(token); requireReminderSignal(signal); return true;
        });
    },
    iosPomodoroAlarmPrepare(token: string, granted: boolean, raw: string | null, scope: string,
        pendingJSON: string, deliveredJSON: string): string {
        return submit(async (signal) => {
            requireReminderSignal(signal); await requirePomodoroAlarmTurn(token);
            if (typeof granted !== 'boolean') throw new Error('INVALID_INPUT: Invalid Pomodoro permission');
            const settings = useTaskStore.getState().settings;

            const session = !granted || settings.gtd?.pomodoro?.completionAlert === false
                ? null : (await pomodoroAdapter().readPomodoroSession()).raw;
            await requirePomodoroAlarmTurn(token); requireReminderSignal(signal);
            const nowMs = Date.now();
            const intent = buildNativePomodoroAlarmIntent({ raw: session, settings, nowMs,
                t: (key) => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key });
            return planNativePomodoroAlarmEffects({ intent, granted, raw, scope, nowMs,
                pending: pomodoroJSON(pendingJSON, 4 * 1024 * 1024),
                delivered: pomodoroJSON(deliveredJSON, 4 * 1024 * 1024) });
        });
    },
    iosPomodoroAlarmDispatchPrepare(token: string, intentJSON: string, raw: string | null, scope: string): string {
        return submit(async (signal) => {
            requireReminderSignal(signal); await requirePomodoroAlarmTurn(token);
            const settings = useTaskStore.getState().settings;
            const session = settings.gtd?.pomodoro?.completionAlert === false
                ? null : (await pomodoroAdapter().readPomodoroSession()).raw;
            await requirePomodoroAlarmTurn(token); requireReminderSignal(signal);
            const intent = buildNativePomodoroAlarmIntent({ raw: session, settings, nowMs: Date.now(),
                t: (key) => unwrap(contract.getStrings({ keys: [key] })).strings[key] ?? key });
            return prepareNativePomodoroAlarmDispatch({ intent, raw, scope, attempt: pomodoroJSON(intentJSON, 16 * 1024) });
        });
    },
    iosPomodoroAlarmAcknowledged(token: string, outcome: string): string {
        return submit(async (signal) => {
            requireReminderSignal(signal); await requirePomodoroAlarmTurn(token);
            if (!['scheduled', 'retained', 'cancelled', 'uncertain', 'uninitialized'].includes(outcome))
                throw new Error('INVALID_INPUT: Invalid Pomodoro alarm outcome');
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS Pomodoro alarm reconciliation saved',
                    context: { releaseCheck: 'v1.3.5/ios-pomodoro-alarm-effects', outcome } }, { force: true });
            } catch {                                                                      }
            return {};
        });
    },
    iosPomodoroAlarmEnd(token: string): string {
        return submit(async () => { if (iosPomodoroAlarmTurn?.token === token) iosPomodoroAlarmTurn = null; return {}; });
    },
    iosReminderBegin(token: string): string {
        return submit(async (signal) => { requireReminderSignal(signal); return iosReminderEffects.begin(token); });
    },
    iosReminderCurrent(token: string): string {
        return submit(async (signal) => { requireReminderSignal(signal); return iosReminderEffects.current(token); });
    },
    iosReminderEnd(token: string): string {
        return submit(async () => iosReminderEffects.end(token));
    },
    iosReminderPrepare(token: string, granted: boolean, pendingJSON: string, deliveredJSON: string): string {
        return submit(async (signal) => {
            requireReminderSignal(signal);
            const result = await iosReminderEffects.prepare(token, granted, pendingJSON, deliveredJSON);
            requireReminderSignal(signal); return result;
        });
    },
    iosReminderAcknowledged(token: string, mode: string, scheduled: number, cancelled: number, collapsed = 0, rearmed = 0): string {
        return submit(async (signal) => {
            requireReminderSignal(signal);
            return iosReminderEffects.acknowledge(token, mode, scheduled, cancelled, collapsed, rearmed);
        });
    },

    iosReadReminderPlan(permissionGranted: boolean): string {
        return submit(async (signal) => {
            const adapter = bootAdapter, generation = getPersistenceStatus().generation;
            const assertReady = () => {
                if (signal.aborted) throw new Error('CANCELLED: Reminder plan read was cancelled');
                try {
                    if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
                        || getStorageAdapter() !== adapter || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error();
                    requireSaved();
                    const persistence = getPersistenceStatus();
                    if (persistence.failed || persistence.queued || persistence.inFlight || persistence.immediate
                        || persistence.retrying || persistence.generation !== generation) throw new Error();
                    if (!contract.getDataSettings().ok) throw new Error();
                } catch { throw new Error('NOT_READY: Reminder plan is unavailable'); }
            };
            assertReady();
            if (typeof permissionGranted !== 'boolean') throw new Error('INVALID_INPUT: Reminder permission must be a boolean');
            const names = [REMINDER_ALARM_MAP_STORAGE_KEY, NATIVE_REMINDER_STATE_STORAGE_KEY];
            let values: [string, string | null][];
            try {
                values = await keyValue.multiGet(names);
                if (!Array.isArray(values) || values.length !== names.length
                    || values.some((entry, index) => !Array.isArray(entry) || entry.length !== 2
                        || entry[0] !== names[index] || entry[1] !== null && typeof entry[1] !== 'string')) throw new Error();
            } catch { assertReady(); throw new Error('NOT_READY: Reminder plan is unavailable'); }
            assertReady();
            const result = await contract.planReminderAlarms({ storedAlarms: values[0][1], storedState: values[1][1], permissionGranted })
                .catch(() => { assertReady(); throw new Error('NOT_READY: Reminder plan is unavailable'); });
            assertReady();
            if (!result.ok) throw new Error('NOT_READY: Reminder plan is unavailable');
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS reminder plan inspected',
                    context: { releaseCheck: 'v1.3.5/ios-reminder-plan', outcome: 'planned' },
                }, { force: true });
            } catch {                                                     }
            assertReady();
            return result.value;
        });
    },
    iosFeedbackConfiguration(endpointURL: string): string {
        return submit(async (signal) => {
            if (signal.aborted) throw new Error('feedback_cancelled');
            try {
                if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || getStorageAdapter() !== bootAdapter
                    || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error();
                requireSaved();
                if (!contract.getDataSettings().ok) throw new Error();
            } catch { throw new Error('feedback_not_ready'); }
            return { configured: typeof endpointURL === 'string' && endpointURL.trim() === 'https://feedback.mindwtr.app',
                categories: FEEDBACK_CATEGORIES };
        });
    },
    iosSubmitFeedback(requestJSON: string, metadataJSON: string, endpointURL: string): string {
        return submit(async (signal) => {
            const adapter = bootAdapter;
            const assertReady = () => {
                if (signal.aborted) throw new Error('feedback_cancelled');
                try {
                    if (globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
                        || getStorageAdapter() !== adapter || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error();
                    requireSaved();
                    if (!contract.getDataSettings().ok) throw new Error();
                } catch { throw new Error('feedback_not_ready'); }
            };
            assertReady();
            if (typeof endpointURL !== 'string' || endpointURL.trim() !== 'https://feedback.mindwtr.app') {
                throw new Error('feedback_not_configured');
            }
            let request: Record<string, unknown>, metadata: FeedbackMetadata;
            try {
                if (typeof requestJSON !== 'string' || requestJSON.length > 64_000
                    || typeof metadataJSON !== 'string' || metadataJSON.length > 8_000) throw new Error();
                const raw: unknown = JSON.parse(requestJSON), meta: unknown = JSON.parse(metadataJSON);
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)
                    || !meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error();
                request = raw as Record<string, unknown>;
                if (!['category', 'message', 'includeDiagnostics'].every((name) => Object.hasOwn(request, name))
                    || Object.keys(request).some((name) => !['category', 'message', 'includeDiagnostics', 'email'].includes(name))
                    || typeof request.category !== 'string' || typeof request.message !== 'string'
                    || typeof request.includeDiagnostics !== 'boolean'
                    || Object.hasOwn(request, 'email') && typeof request.email !== 'string'
                    || Object.entries(meta).some(([name, value]) =>
                        !['appVersion', 'platform', 'os', 'installChannel', 'locale', 'build'].includes(name)
                        || typeof value !== 'string')) throw new Error();
                metadata = meta as FeedbackMetadata;
            } catch { throw new Error('feedback_invalid_request'); }
            const built = buildFeedbackSubmissionPayload({ category: request.category as typeof FEEDBACK_CATEGORIES[number],
                message: request.message as string, email: request.email as string | undefined, metadata });
            if (!built.ok) throw new Error(built.error);
            let logs: string | null = null;
            if (built.payload.category === 'bug' && request.includeDiagnostics) {
                const breadcrumbs = getBreadcrumbs();
                const snapshot = JSON.stringify(buildDiagnosticsLogEntry('info', 'Feedback diagnostics snapshot', {
                    scope: 'feedback', extra: {
                        debugLoggingEnabled: isDiagnosticsLoggingEnabled(useTaskStore.getState().settings),
                        releaseCheck: 'v1.3.5/ios-feedback', captureMode: 'recent-session-and-saved-log',
                        breadcrumbCount: breadcrumbs.length, breadcrumbs: breadcrumbs.length ? breadcrumbs.join(';') : 'none',
                    },
                }));
                const saved = await diagnosticsLog.read();
                assertReady();
                logs = buildFeedbackDiagnostics([sanitizeSavedFeedbackLog(saved), feedbackDiagnosticsBuffer.read()], snapshot);
            }
            assertReady();
            try {
                await submitFeedbackSubmission(endpointURL.trim(), {
                    category: built.payload.category, message: built.payload.message, email: built.payload.email, metadata,
                    ...(logs ? { diagnostics: { logs } } : {}),
                }, async (input, init) => {
                    assertReady();
                    const response = await globalThis.fetch(input, { ...init, signal, redirect: 'error' });
                    assertReady();
                    return response;
                });
            } catch {
                assertReady();
                throw new Error('feedback_failed');
            }
            assertReady();
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS feedback submission acknowledged',
                    context: { releaseCheck: 'v1.3.5/ios-feedback', outcome: 'sent' },
                }, { force: true });
            } catch {                                                              }
            return { status: 'sent' };
        });
    },

    iosCalendarPushStart(): string {
        return submit((signal) => iosCalendarPushOwned(signal, () => iosCalendarPushLifecycle!.start()));
    },
    iosCalendarPushStop(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !calendarPushAvailable || !iosCalendarPushLifecycle) {
                throw new Error('NOT_READY: Calendar push is unavailable');
            }
            iosCalendarPushLifecycle.stop();
            return null;
        });
    },
    iosCalendarPushRun(json: string): string {
        return submit((signal) => iosCalendarPushOwned(signal, async () => {
            const input = iosCalendarPushInput(json);
            if (Object.keys(input).join(',') !== 'ids' || input.ids !== null
                && (!Array.isArray(input.ids) || input.ids.length > 10_000
                    || input.ids.some((id) => typeof id !== 'string' || !id.trim() || id.length > 500
                        || new TextEncoder().encode(id).byteLength > 1024)
                    || new Set(input.ids).size !== input.ids.length)) {
                throw new Error('INVALID_INPUT: Invalid Calendar push run');
            }
            await iosCalendarPushLifecycle!.run(input.ids === null ? undefined : input.ids as string[]);
            return null;
        }));
    },
    iosCalendarPushSetting(json: string): string {
        return submit((signal) => iosCalendarPushOwned(signal, async () => {
            const input = iosCalendarPushInput(json), edit = input.edit;
            if (Object.keys(input).sort().join(',') !== 'edit,requestId'
                || !edit || typeof edit !== 'object' || Array.isArray(edit)
                || typeof (edit as Record<string, unknown>).type !== 'string'
                || !['push', 'pushTarget', 'pushColor', 'deleteMindwtrCalendar'].includes((edit as Record<string, unknown>).type as string)) {
                throw new Error('INVALID_INPUT: Invalid Calendar push setting');
            }
            return unwrap(await contract.setCalendarSetting(input as Parameters<typeof contract.setCalendarSetting>[0]));
        }));
    },
    iosCalendarPushDiagnostic(json: string): string {
        return submit(async () => {
            const input = iosCalendarPushInput(json);
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !calendarPushAvailable
                || Object.keys(input).sort().join(',') !== 'operation,outcome'
                || typeof input.operation !== 'string' || typeof input.outcome !== 'string'
                || !['createCalendar', 'updateCalendar', 'deleteCalendar', 'createEvent', 'updateEvent', 'deleteEvent', 'restore'].includes(input.operation)
                || !['saved', 'recovered', 'blocked', 'rejected'].includes(input.outcome)) {
                throw new Error('INVALID_INPUT: Invalid Calendar push diagnostic');
            }
            try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                message: 'Native iOS calendar push outcome',
                context: { releaseCheck: 'v1.3.5/ios-calendar-push', operation: input.operation, outcome: input.outcome },
            }, { force: true }); } catch {                                                          }
            return null;
        });
    },
    iosCalendarRead(requestJSON: string): string {
        return submit(async (signal) => {
            const adapter = bootAdapter;
            const assertReady = () => {
                if (signal.aborted) throw new Error('CANCELLED: Calendar read was cancelled');
                if (!iosCalendar || !adapter || bootAdapter !== adapter || getStorageAdapter() !== adapter
                    || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error('NOT_READY: Calendar read is unavailable');
                requireSaved();
                if (!contract.getDataSettings().ok) throw new Error('NOT_READY: Calendar read is unavailable');
            };
            assertReady();
            const input = completionJson(requestJSON, 8192) as Record<string, unknown>;
            if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.op !== 'string') {
                throw new Error('INVALID_INPUT: Invalid calendar read');
            }
            let result: Parameters<typeof unwrap>[0];
            if (['openSettings', 'getSettings', 'closeSettings'].includes(input.op)) {
                if (Object.keys(input).length !== 1) throw new Error('INVALID_INPUT: Invalid calendar read');
                result = input.op === 'openSettings' ? await contract.openCalendarSettings()
                    : input.op === 'getSettings' ? contract.getCalendarSettings() : contract.closeCalendarSettings();
            } else if (input.op === 'testSettings' && Object.keys(input).length === 1) {
                result = await contract.testCalendarFeeds({ signal, timeoutMs: 15_000 });
            } else if (input.op === 'feed' && Object.keys(input).every((name) => ['op', 'slot', 'start', 'end', 'refresh'].includes(name))
                && typeof input.slot === 'string' && ['calendar', 'weeklyReview', 'dailyReview'].includes(input.slot)
                && typeof input.start === 'string' && typeof input.end === 'string'
                && input.start.length <= 40 && input.end.length <= 40
                && (input.refresh === undefined || typeof input.refresh === 'boolean')) {
                const start = Date.parse(input.start), end = Date.parse(input.end);
                if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 366 * 86_400_000) {
                    throw new Error('INVALID_INPUT: Invalid calendar range');
                }
                result = await contract.loadExternalCalendarFeed({
                    slot: input.slot as 'calendar' | 'weeklyReview' | 'dailyReview', start: input.start, end: input.end,
                    ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
                }, signal);
            } else throw new Error('INVALID_INPUT: Invalid calendar read');
            assertReady();
            const value = unwrap(result);
            logInfo('Native iOS calendar read delivered', { scope: 'native-ios', force: input.op !== 'testSettings',
                context: { releaseCheck: 'v1.3.5/ios-calendar-read', outcome: input.op } });
            return value;
        });
    },
    iosVoiceEndpointSessionOpen(id: string): string {
        return submit(async () => {
            unwrap(iosVoiceReadiness()); requireSaved();
            const state = useTaskStore.getState();
            if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) || state.isLoading || state.editLockCount > 0
                || state.settings.ai?.speechToText?.provider !== 'openai')
                throw new Error('NOT_READY: Voice endpoint is unavailable');
            iosVoiceEndpointSession = { id, adapter: bootAdapter!, generation: getPersistenceStatus().generation,
                settings: state.settings, frozen: JSON.parse(JSON.stringify(state.settings)) };
            iosVoiceEndpointRetry = null;
            return null;
        });
    },
    iosVoiceEndpointSessionClose(id: string): string {
        return submit(async () => {
            if (iosVoiceEndpointSession?.id === id) iosVoiceEndpointSession = null;
            if (iosVoiceEndpointRetry?.session === id) iosVoiceEndpointRetry = null;
            return null;
        });
    },
    iosVoiceEndpointSensitive(json: string, owner: (json: string) => unknown): string {
        return submit(signal => runVoiceEndpointSensitive(json, owner, signal));
    },
    iosVoiceWhisperModel(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const runtime = unwrap(await iosVoiceMethods.runtimeOptions(iosVoiceJSON(json, 256), current));
            if (runtime.provider !== 'whisper') return null;
            const model = getSelectedMobileWhisperModel(runtime.model);
            if (!model) throw new Error('NOT_READY: Local speech model is unavailable');
            current();
            return { version: 1, id: model.id, fileName: model.fileName, sizeBytes: model.sizeBytes, sha256: model.sha256,
                urls: WHISPER_MODEL_BASE_URLS.map(root => `${root}/${model.fileName}`) };
        });
    },
    iosVoiceWhisperLanguage(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const input = iosVoiceJSON(json, 4096);
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
                || !('model' in input) || !('language' in input)
                || typeof input.model !== 'string' || getSelectedMobileWhisperModel(input.model)?.id !== input.model
                || typeof input.language !== 'string' || input.language.length > 200)
                throw new Error('INVALID_INPUT: Local speech language request is invalid');
            const language = normalizeSpeechLanguage(input.language);
            current(); return input.model.endsWith('.en') && language === 'auto' ? 'en' : language;
        });
    },
    iosVoiceOpenAIRuntime(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const input = iosVoiceJSON(json, 256);
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
                throw new Error('INVALID_INPUT: Voice runtime request is invalid');
            const result = readWatchOpenAIRuntime(useTaskStore.getState().settings);
            current(); return result;
        });
    },
    iosVoiceModelDiscovery(json: string, owner: (json: string) => unknown): string {
        return submit(async signal => {
            if (iosConfigurationAIActive || iosConfigurationAIHost || iosCaptureAIHost || iosTaskAI?.active || iosInboxAI?.active || iosReviewAI?.active)
                throw new Error('NOT_READY: Voice model discovery is already active');
            iosConfigurationAIActive = true;
            try {
                const input = completionJson(json, 32 * 1024);
                if (!input || typeof input !== 'object' || Array.isArray(input)
                    || !taskEditValuesEqual(Object.keys(input).sort(), ['expected', 'session'])
                    || !('session' in input) || typeof input.session !== 'string'
                    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.session)
                    || !('expected' in input) || typeof owner !== 'function')
                    throw new Error('INVALID_INPUT: Voice model discovery request is invalid');
                unwrap(iosVoiceReadiness()); requireSaved();
                const adapter = bootAdapter, settings = useTaskStore.getState().settings;
                const frozen = JSON.parse(JSON.stringify(settings)), generation = getPersistenceStatus().generation;
                const { ask, readReply } = aiModelDiscoveryOwner(owner);
                const current = () => {
                    const state = useTaskStore.getState();
                    if (signal.aborted || bootAdapter !== adapter || getStorageAdapter() !== adapter
                        || state.settings !== settings || !taskEditValuesEqual(state.settings, frozen)
                        || getPersistenceStatus().generation !== generation || state.isLoading || state.editLockCount > 0
                        || ask({ phase: 'current' }) !== '')
                        throw new Error('STALE_REVISION: Voice model discovery owner changed');
                    unwrap(iosVoiceReadiness()); requireSaved();
                };
                current();
                const options = unwrap(await iosVoiceMethods.settingsOptions({}, current));
                if (!taskEditValuesEqual(options.expected, input.expected))
                    throw new Error('STALE_REVISION: Voice model discovery settings changed');
                const provider = options.provider;
                if (provider !== 'openai' && provider !== 'gemini')
                    throw new Error('NOT_READY: Voice model discovery is unavailable for this provider');
                const metadata = readReply({ phase: 'metadata', provider });
                if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length !== 1
                    || !('consent' in metadata) || typeof metadata.consent !== 'boolean')
                    throw new Error('NOT_READY: Voice model discovery metadata is unavailable');
                current();
                const result = await discoverNativeVoiceModels({ provider, model: options.model, modelOptions: options.modelOptions,
                    baseUrl: provider === 'openai' ? settings.ai?.speechToText?.baseUrl : undefined,
                    consent: metadata.consent, aiEnabled: settings.ai?.enabled === true,
                    aiProvider: settings.ai?.provider ?? 'openai', isFossBuild,
                }, {
                    current, signal,
                    readCredential: async () => {
                        current(); const loaded = readReply({ phase: 'credential', provider }); current();
                        if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) || Object.keys(loaded).length !== 1
                            || !('value' in loaded) || loaded.value !== null && (typeof loaded.value !== 'string' || loaded.value.length > 4000))
                            throw new Error('NOT_READY: Voice model discovery credential is unavailable');
                        return loaded.value;
                    },
                    fetch: async (input, init) => {
                        current();
                        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                        if (ask({ phase: 'http', url }) !== '') throw new Error('NOT_READY: Voice model discovery request is unavailable');
                        const response = await globalThis.fetch(input, init); current(); return response;
                    },
                });
                current();
                let reply = { version: 1, provider, ...result, expected: options.expected };
                if (new TextEncoder().encode(JSON.stringify(reply)).byteLength > 64 * 1024)
                    reply = { version: 1, provider, status: 'fallback', modelOptions: options.modelOptions, expected: options.expected };
                if (new TextEncoder().encode(JSON.stringify(reply)).byteLength > 64 * 1024)
                    throw new Error('NOT_READY: Voice model discovery choices are unavailable');
                return reply;
            } finally { iosConfigurationAIActive = false; }
        });
    },
    iosVoiceSettingsOptions(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.settingsOptions(iosVoiceJSON(json, 256), current));
            current(); return result;
        });
    },
    iosVoiceRuntimeOptions(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.runtimeOptions(iosVoiceJSON(json, 256), current));
            current(); return result;
        });
    },
    iosVoiceSettingsPrepare(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.prepareSettings(iosVoiceJSON(json, 32768), current));
            current(); return result;
        });
    },
    iosVoiceSettingsValidate(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(iosVoiceMethods.validateSettings(iosVoiceJSON(json, 4194304)));
            current(); return result;
        });
    },
    iosVoiceSettingsCommit(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.commitSettings(iosVoiceJSON(json, 4194304), current));
            current(); return result;
        });
    },
    iosVoiceSettingsRetryOutcome(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(iosVoiceMethods.settingsOutcome(iosVoiceJSON(json, 32768)));
            current(); return result;
        });
    },
    iosVoiceSettingsRecover(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.recoverSettings(iosVoiceJSON(json, 4194304), current));
            current(); return result;
        });
    },
    iosVoiceCapturePrepare(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.prepareCapture(iosVoiceJSON(json, 131072), current));
            current(); return result;
        });
    },
    iosVoiceCaptureValidate(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(iosVoiceMethods.validateCapture(iosVoiceJSON(json, 4194304)));
            current(); return result;
        });
    },
    iosVoiceCaptureCommit(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.commitCapture(iosVoiceJSON(json, 4194304), current));
            current(); return result;
        });
    },
    iosVoiceCaptureRetryOutcome(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(iosVoiceMethods.captureOutcome(iosVoiceJSON(json, 131072)));
            current(); return result;
        });
    },
    iosVoiceCaptureRecover(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.recoverCapture(iosVoiceJSON(json, 4194304), current));
            current(); return result;
        });
    },
    iosVoiceResultPrepare(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.prepareResult(iosVoiceJSON(json, 262144), current));
            current(); return result;
        });
    },
    iosVoiceResultValidate(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(iosVoiceMethods.validateResult(iosVoiceJSON(json, 4194304)));
            current(); return result;
        });
    },
    iosVoiceResultCommit(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.commitResult(iosVoiceJSON(json, 4194304), current));
            current(); return result;
        });
    },
    iosVoiceResultRetryOutcome(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(iosVoiceMethods.resultOutcome(iosVoiceJSON(json, 262144)));
            current(); return result;
        });
    },
    iosVoiceResultRecover(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const result = unwrap(await iosVoiceMethods.recoverResult(iosVoiceJSON(json, 4194304), current));
            current(); return result;
        });
    },
    iosVoiceOpenAITranscriptionBuild(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            let result;
            try { result = buildWatchOpenAITranscription(iosVoiceJSON(json, 16 * 1024)); }
            catch { throw new Error('INVALID_INPUT: OpenAI speech input is invalid'); }
            current(); return result;
        });
    },
    iosVoiceOpenAITranscriptionDecode(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            let result;
            try { result = decodeWatchOpenAITranscription(iosVoiceJSON(json, 2 * 1024 * 1024)); }
            catch { throw new Error('INVALID_INPUT: OpenAI speech input is invalid'); }
            current(); return result;
        });
    },
    iosVoiceOpenAIParseBuild(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            let result;
            try { result = buildWatchOpenAIParse(iosVoiceJSON(json, 512 * 1024)); }
            catch { throw new Error('INVALID_INPUT: OpenAI speech input is invalid'); }
            current(); return result;
        });
    },
    iosVoiceOpenAIParseDecode(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            let result;
            try { result = decodeWatchOpenAIParse(iosVoiceJSON(json, 2 * 1024 * 1024)); }
            catch { throw new Error('INVALID_INPUT: OpenAI speech input is invalid'); }
            current(); return result;
        });
    },
    iosVoiceGeminiRequestBuild(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const input = iosVoiceJSON(json, 8 * 1024 * 1024) as Record<string, unknown>;
            const config = input && typeof input === 'object' && !Array.isArray(input) ? input.config : null;
            if (!input || typeof input !== 'object' || Array.isArray(input)
                || !taskEditValuesEqual(Object.keys(input).sort(), ['audioBase64', 'config', 'mimeType'])
                || !config || typeof config !== 'object' || Array.isArray(config)
                || !taskEditValuesEqual(Object.keys(config).sort(), ['fieldStrategy', 'language', 'mode', 'model', 'now', 'timeZone'])
                || typeof input.audioBase64 !== 'string' || input.mimeType !== 'audio/mp4' && input.mimeType !== 'audio/wav')
                throw new Error('INVALID_INPUT: Voice Gemini request is malformed');
            const raw = config as Record<string, unknown>;
            if (typeof raw.model !== 'string' || !raw.model.trim() || raw.model.length > 2000
                || typeof raw.language !== 'string' || raw.language.length > 200
                || raw.mode !== 'smart_parse' && raw.mode !== 'transcribe_only'
                || raw.fieldStrategy !== 'smart' && raw.fieldStrategy !== 'title_only' && raw.fieldStrategy !== 'description_only'
                || typeof raw.now !== 'string' || raw.now.length > 40 || !Number.isFinite(Date.parse(raw.now))
                || new Date(raw.now).toISOString() !== raw.now
                || raw.timeZone !== null && (typeof raw.timeZone !== 'string' || raw.timeZone.length > 200))
                throw new Error('INVALID_INPUT: Voice Gemini configuration is malformed');
            const selected: GeminiSpeechRequestConfig = { model: raw.model, language: raw.language, mode: raw.mode,
                fieldStrategy: raw.fieldStrategy, now: new Date(raw.now), ...(raw.timeZone === null ? {} : { timeZone: raw.timeZone as string }) };
            let result;
            try { result = buildRemoteGeminiSpeechRequest(selected, input.audioBase64, input.mimeType); }
            catch { throw new Error('INVALID_INPUT: Voice Gemini request is invalid'); }
            current(); return result;
        });
    },
    iosVoiceGeminiResponseDecode(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            let result;
            try { result = decodeRemoteGeminiSpeechResponse(iosVoiceJSON(json, 2 * 1024 * 1024)); }
            catch { throw new Error('INVALID_INPUT: Voice Gemini response is malformed'); }
            current(); return result;
        });
    },
    iosVoiceAcknowledged(stage: string, outcome: string, owner: () => unknown): string {
        return submit(async signal => {
            const current = iosVoiceOwner(owner, signal);
            const outcomes: Record<string, string[]> = {
                settings: ['saved', 'failed'], capture: ['saved', 'save-pending', 'refused', 'failed', 'cancelled', 'permission-denied'],
                speech: ['applied', 'discarded', 'empty', 'skipped', 'failed', 'cancelled'], credential: ['saved', 'cleared', 'failed'],
            };
            if (!Object.prototype.hasOwnProperty.call(outcomes, stage) || !outcomes[stage].includes(outcome))
                throw new Error('INVALID_INPUT: Voice acknowledgment is invalid');
            current();
            try {
                logInfo('Native iOS voice operation completed', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.9/ios-native-voice', provider: 'gemini', stage, outcome } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch { }
            current(); return null;
        });
    },
    iosAITextConfigurationSessionOpen(id: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || !/^[0-9a-f-]{36}$/.test(id))
                throw new Error('NOT_READY: AI text configuration is unavailable');
            requireSaved();
            const settings = useTaskStore.getState().settings;
            iosAITextConfigurationSession = { id, provider: 'openai', version: 1, adapter: bootAdapter, generation: getPersistenceStatus().generation,
                settings, frozen: JSON.parse(JSON.stringify(settings)), acceptedAdvance: null, extraBodyAttempts: new Map() };
            return null;
        });
    },
    iosAITextConfigurationSessionCheck(id: string): string {
        return submit(async () => { currentAITextConfigurationSession(id); return null; });
    },
    iosAITextConfigurationSessionRefresh(id: string): string {
        return submit(async () => { refreshAITextConfigurationSession(id); return null; });
    },
    iosAITextConfigurationSessionClose(id: string): string {
        return submit(async () => { if (iosAITextConfigurationSession?.id === id) iosAITextConfigurationSession = null; if (iosAITextEndpointRetry?.session === id) iosAITextEndpointRetry = null; return null; });
    },
    iosAITextConfigurationSessionOpenV2(id: string, provider: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || !/^[0-9a-f-]{36}$/.test(id)
                || (provider !== 'openai' && provider !== 'gemini' && provider !== 'anthropic')
                || (useTaskStore.getState().settings.ai?.provider ?? 'openai') !== provider)
                throw new Error('NOT_READY: AI provider configuration is unavailable');
            requireSaved();
            const settings = useTaskStore.getState().settings;
            iosAITextConfigurationSession = { id, provider, version: 2, adapter: bootAdapter, generation: getPersistenceStatus().generation,
                settings, frozen: JSON.parse(JSON.stringify(settings)), acceptedAdvance: null, extraBodyAttempts: new Map() };
            return null;
        });
    },
    iosAITextConfigurationConsentTargetV2(json: string): string {
        return submit(async () => {
            const request = readNativeAITextConfigurationRequestV2(completionJson(json, 32 * 1024));
            if (!request) throw new Error('INVALID_INPUT: AI provider request is malformed');
            return { provider: nativeAITextConfigurationConsentTarget(request) };
        });
    },
    iosAITextConfigurationOptionsV2(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiTextConfigurationMethods.optionsV2(completionJson(json, 256), aiTextConfigurationOwner(owner, signal))));
    },
    iosAITextModelDiscovery(json: string, owner: (json: string) => unknown): string {
        return submit(async signal => {
            if (iosConfigurationAIActive || iosConfigurationAIHost || iosCaptureAIHost || iosTaskAI?.active || iosInboxAI?.active || iosReviewAI?.active)
                throw new Error('NOT_READY: AI model discovery is already active');
            iosConfigurationAIActive = true;
            try {
                const input = completionJson(json, 32 * 1024);
                if (!input || typeof input !== 'object' || Array.isArray(input)
                    || !taskEditValuesEqual(Object.keys(input).sort(), ['expected', 'session'])
                    || !('session' in input) || typeof input.session !== 'string' || !('expected' in input) || typeof owner !== 'function')
                    throw new Error('INVALID_INPUT: AI model discovery request is invalid');
                const session = currentAITextConfigurationSession(input.session);
                if (session.version !== 2) throw new Error('NOT_READY: AI model discovery needs current provider setup');
                const { ask, readReply } = aiModelDiscoveryOwner(owner);
                const current = () => {
                    if (signal.aborted || iosAITextConfigurationSession !== session
                        || currentAITextConfigurationSession(session.id) !== session || ask({ phase: 'current' }) !== '')
                        throw new Error('STALE_REVISION: AI model discovery owner changed');
                };
                current();
                const options = unwrap(await aiTextConfigurationMethods.optionsV2({}, current));
                if (!taskEditValuesEqual(options.expected, input.expected))
                    throw new Error('STALE_REVISION: AI model discovery settings changed');
                const metadata = readReply({ phase: 'metadata', provider: session.provider });
                if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length !== 1
                    || !('consent' in metadata) || typeof metadata.consent !== 'boolean')
                    throw new Error('NOT_READY: AI model discovery metadata is unavailable');
                current();
                const result = await discoverNativeAITextModels({
                    provider: session.provider, enabled: options.enabled, model: options.model, copilotModel: options.copilotModel,
                    modelOptions: options.modelOptions, copilotModelOptions: options.copilotModelOptions,
                    baseUrl: session.provider === 'openai' ? session.settings.ai?.baseUrl : undefined,
                    consent: metadata.consent, isFossBuild,
                }, {
                    current, signal,
                    readCredential: async () => {
                        current();
                        const loaded = readReply({ phase: 'credential', provider: session.provider });
                        current();
                        if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) || Object.keys(loaded).length !== 1
                            || !('value' in loaded) || loaded.value !== null && (typeof loaded.value !== 'string' || loaded.value.length > 4000))
                            throw new Error('NOT_READY: AI model discovery credential is unavailable');
                        return loaded.value;
                    },
                    fetch: async (input, init) => {
                        current();
                        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                        if (ask({ phase: 'http', url }) !== '') throw new Error('NOT_READY: AI model discovery request is unavailable');
                        const response = await globalThis.fetch(input, init);
                        current(); return response;
                    },
                });
                current();
                let reply = { version: 1, provider: session.provider, ...result, expected: options.expected };
                if (new TextEncoder().encode(JSON.stringify(reply)).byteLength > 64 * 1024)
                    reply = { version: 1, provider: session.provider, status: 'fallback', modelOptions: options.modelOptions,
                        copilotModelOptions: options.copilotModelOptions, expected: options.expected };
                if (new TextEncoder().encode(JSON.stringify(reply)).byteLength > 64 * 1024)
                    throw new Error('NOT_READY: AI model discovery choices are unavailable');
                return reply;
            } finally { iosConfigurationAIActive = false; }
        });
    },
    iosAIAnthropicThinkingOptions(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiTextConfigurationMethods.anthropicThinkingOptions(completionJson(json, 256), aiTextConfigurationOwner(owner, signal))));
    },
    iosAITextConfigurationPrepareV2(json: string, owner: () => unknown, recordedFor: string | null): string {
        return submit(async signal => {
            if (recordedFor !== null && recordedFor !== 'openai' && recordedFor !== 'gemini' && recordedFor !== 'anthropic')
                throw new Error('INVALID_INPUT: AI provider consent observation is invalid');
            return unwrap(await aiTextConfigurationMethods.prepareV2(completionJson(json, 32 * 1024), aiTextConfigurationOwner(owner, signal), recordedFor));
        });
    },
    iosAITextConfigurationValidateV2(json: string): string {
        return submit(async () => unwrap(aiTextConfigurationMethods.validateV2(completionJson(json, 64 * 1024))));
    },
    iosAITextConfigurationCommitV2(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const session = iosAITextConfigurationSession, current = aiTextConfigurationOwner(owner, signal);
            const result = unwrap(await aiTextConfigurationMethods.commitV2(completionJson(json, 64 * 1024), current));
            current();
            if (session && !(result.changed && result.change.type === 'provider')) retainAITextConfigurationAdvance(session);
            return result;
        });
    },
    iosAITextConfigurationRetryOutcomeV2(json: string): string {
        return submit(async () => unwrap(aiTextConfigurationMethods.outcomeV2(completionJson(json, 32 * 1024))));
    },
    iosAITextConfigurationOptions(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiTextConfigurationMethods.options(completionJson(json, 256), aiTextConfigurationOwner(owner, signal))));
    },
    iosAITextConfigurationPrepare(json: string, owner: () => unknown, consentRecorded: boolean): string {
        return submit(async signal => {
            if (typeof consentRecorded !== 'boolean') throw new Error('INVALID_INPUT: AI consent observation is invalid');
            return unwrap(await aiTextConfigurationMethods.prepare(completionJson(json, 32 * 1024), aiTextConfigurationOwner(owner, signal), consentRecorded));
        });
    },
    iosAITextConfigurationValidate(json: string): string {
        return submit(async () => unwrap(aiTextConfigurationMethods.validate(completionJson(json, 64 * 1024))));
    },
    iosAITextConfigurationCommit(json: string, owner: () => unknown): string {
        return submit(async signal => {
            const session = iosAITextConfigurationSession, current = aiTextConfigurationOwner(owner, signal);
            const result = unwrap(await aiTextConfigurationMethods.commit(completionJson(json, 64 * 1024), current));
            current();
            if (session) retainAITextConfigurationAdvance(session);
            return result;
        });
    },
    iosAITextConfigurationRetryOutcome(json: string): string {
        return submit(async () => unwrap(aiTextConfigurationMethods.outcome(completionJson(json, 32 * 1024))));
    },
    iosAITextConfigurationSensitive(json: string, owner: (json: string) => unknown): string {
        return submit(signal => runAITextConfigurationSensitive(json, owner, signal, 1));
    },
    iosAITextConfigurationSensitiveV2(json: string, owner: (json: string) => unknown): string {
        return submit(signal => runAITextConfigurationSensitive(json, owner, signal, 2));
    },
    iosAITextConfigurationAcknowledged(outcome: string = 'settings-saved', provider: string = 'openai', kind: string = 'scalar'): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !['openai', 'gemini', 'anthropic'].includes(provider) || !['scalar', 'enabled', 'model', 'copilotModel', 'provider', 'anthropicThinking', 'thinkingBudget', 'extraBodyParams', 'credential', 'endpoint', 'consent'].includes(kind) || !['settings-saved', 'credential-saved', 'credential-cleared', 'endpoint-saved', 'consent-record-failed'].includes(outcome)) return null;
            try {
                logInfo('Native iOS AI text configuration completed', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.9/ios-ai-text-configuration', outcome, provider, kind } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch { }
            return null;
        });
    },
    iosAIRequestTimeoutOptions(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiRequestTimeoutMethods.options(completionJson(json, 256), aiRequestTimeoutOwner(owner, signal))));
    },
    iosAIRequestTimeoutPrepare(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiRequestTimeoutMethods.prepare(completionJson(json, 2048), aiRequestTimeoutOwner(owner, signal))));
    },
    iosAIRequestTimeoutValidate(json: string): string {
        return submit(async () => unwrap(aiRequestTimeoutMethods.validate(completionJson(json, 8192))));
    },
    iosAIRequestTimeoutCommit(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiRequestTimeoutMethods.commit(completionJson(json, 8192), aiRequestTimeoutOwner(owner, signal))));
    },
    iosAIRequestTimeoutRetryOutcome(json: string): string {
        return submit(async () => unwrap(aiRequestTimeoutMethods.outcome(completionJson(json, 2048))));
    },
    iosAIRequestTimeoutAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try {
                logInfo('Native iOS AI request timeout saved', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-ai-request-timeout', outcome: 'saved' } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch {                                                           }
            return null;
        });
    },
    iosAIReasoningEffortOptions(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiReasoningEffortMethods.options(completionJson(json, 256), aiReasoningEffortOwner(owner, signal))));
    },
    iosAIReasoningEffortPrepare(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiReasoningEffortMethods.prepare(completionJson(json, 2048), aiReasoningEffortOwner(owner, signal))));
    },
    iosAIReasoningEffortValidate(json: string): string {
        return submit(async () => unwrap(aiReasoningEffortMethods.validate(completionJson(json, 8192))));
    },
    iosAIReasoningEffortCommit(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiReasoningEffortMethods.commit(completionJson(json, 8192), aiReasoningEffortOwner(owner, signal))));
    },
    iosAIReasoningEffortRetryOutcome(json: string): string {
        return submit(async () => unwrap(aiReasoningEffortMethods.outcome(completionJson(json, 2048))));
    },
    iosAIReasoningEffortAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try {
                logInfo('Native iOS AI reasoning effort saved', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-ai-reasoning-effort', outcome: 'saved' } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch {                                                           }
            return null;
        });
    },
    iosAIGeminiThinkingBudgetOptions(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiGeminiThinkingBudgetMethods.options(completionJson(json, 256), aiGeminiThinkingBudgetOwner(owner, signal))));
    },
    iosAIGeminiThinkingBudgetPrepare(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiGeminiThinkingBudgetMethods.prepare(completionJson(json, 2048), aiGeminiThinkingBudgetOwner(owner, signal))));
    },
    iosAIGeminiThinkingBudgetValidate(json: string): string {
        return submit(async () => unwrap(aiGeminiThinkingBudgetMethods.validate(completionJson(json, 8192))));
    },
    iosAIGeminiThinkingBudgetCommit(json: string, owner: () => unknown): string {
        return submit(async signal => unwrap(await aiGeminiThinkingBudgetMethods.commit(completionJson(json, 8192), aiGeminiThinkingBudgetOwner(owner, signal))));
    },
    iosAIGeminiThinkingBudgetRetryOutcome(json: string): string {
        return submit(async () => unwrap(aiGeminiThinkingBudgetMethods.outcome(completionJson(json, 2048))));
    },
    iosAIGeminiThinkingBudgetAcknowledged(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
            try {
                logInfo('Native iOS AI Gemini thinking budget saved', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-ai-gemini-thinking-budget', outcome: 'saved' } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch {                                                           }
            return null;
        });
    },

    iosAISummaryCheckpointSettled(owner: () => unknown): string {
        if (typeof owner !== 'function' || owner() !== '') throw new Error('NOT_READY: AI summary checkpoint needs private fixture authority');
        const { status } = settledAttachmentDiscardState();
        return String(status.generation);
    },

    iosAISettingsProjection(json: string, owner: () => unknown): string {
        return submit(async (signal) => {
            const input = completionJson(json, 256);
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0
                || typeof owner !== 'function') throw new Error('INVALID_INPUT: AI projection needs private read authority');
            const adapter = bootAdapter;
            const ready = () => {
                if (signal.aborted || globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
                    || getStorageAdapter() !== adapter || !adapter.concurrentWritesGuarded
                    || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error('NOT_READY: AI projection is unavailable');
                if (owner() !== '') throw new Error('NOT_READY: AI projection owner is unavailable');
                requireSaved();
                if (!contract.getDataSettings().ok) throw new Error('NOT_READY: AI projection is unavailable');
                const status = getPersistenceStatus(), state = useTaskStore.getState();
                if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying
                    || state.isLoading || state.editLockCount > 0) throw new Error('NOT_READY: AI projection waits for saved data');
                return status;
            };
            const status = ready(), settings = useTaskStore.getState().settings;
            const frozen = JSON.parse(JSON.stringify(settings)) as unknown;
            const current = () => {
                if (ready().generation !== status.generation || useTaskStore.getState().settings !== settings
                    || !taskEditValuesEqual(settings, frozen)) throw new Error('STALE_REVISION: AI projection changed; read again');
            };
            const baseline = async () => {
                current();
                const saved = await adapter!.readRowBaseline();
                current();
                if (!saved || !taskEditValuesEqual(stripSensitiveSettings(saved.settings), settings))
                    throw new Error('STALE_REVISION: AI saved settings changed; reload before reading');
                return saved.settings;
            };
            const projection = buildNativeAISettingsProjection(await baseline());
            await baseline(); current();
            try {
                logInfo('Native iOS AI saved configuration projected', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-ai-settings-projection', outcome: 'read' } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch {                                                   }
            return projection;
        });
    },

    iosAIProviderDeviceState(json: string, owner: () => unknown,
        inspect: (provider: string, account: string, legacy: string) => unknown): string {
        return submit(async (signal) => {
            const input = completionJson(json, 256);
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0
                || typeof owner !== 'function' || typeof inspect !== 'function') {
                throw new Error('INVALID_INPUT: AI provider device metadata needs private read authority');
            }
            const adapter = bootAdapter;
            const ready = () => {
                if (signal.aborted || globalThis.__mindwtrHostPlatform !== 'ios' || !adapter || bootAdapter !== adapter
                    || getStorageAdapter() !== adapter || !adapter.concurrentWritesGuarded
                    || isSandboxMode() || isWorkspaceTransitionActive()) throw new Error('NOT_READY: AI provider device metadata is unavailable');
                if (owner() !== '') throw new Error('NOT_READY: AI provider device metadata owner is unavailable');
                requireSaved();
                if (!contract.getDataSettings().ok) throw new Error('NOT_READY: AI provider device metadata is unavailable');
                const status = getPersistenceStatus(), state = useTaskStore.getState();
                if (status.failed || status.queued || status.inFlight || status.immediate || status.retrying
                    || state.isLoading || state.editLockCount > 0) throw new Error('NOT_READY: AI provider device metadata waits for saved data');
                return status;
            };
            const status = ready(), settings = useTaskStore.getState().settings;
            const frozen = JSON.parse(JSON.stringify(settings)) as unknown;
            const current = () => {
                if (ready().generation !== status.generation || useTaskStore.getState().settings !== settings
                    || !taskEditValuesEqual(settings, frozen)) throw new Error('STALE_REVISION: AI provider device metadata changed; read again');
            };
            const baseline = async () => {
                current();
                const saved = await adapter!.readRowBaseline();
                current();
                if (!saved || !taskEditValuesEqual(stripSensitiveSettings(saved.settings), settings)) {
                    throw new Error('STALE_REVISION: AI saved settings changed; reload before reading');
                }
                return saved.settings;
            };
            const result = await readNativeAIProviderDeviceState(await baseline(), async (provider, account, legacy) => {
                current();
                const raw = checked(await inspect(provider, account, legacy));
                current();
                if (typeof raw !== 'string') throw new Error('INVALID_INPUT: AI provider device metadata is malformed');
                return completionJson(raw, 1024);
            });
            await baseline(); current();
            try {
                logInfo('Native iOS AI provider device metadata inspected', { scope: 'native-ios', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-ai-device-state' } });
                await diagnosticsLog.serialize(async () => undefined);
            } catch {                                                                  }
            await baseline(); current();
            return result;
        });
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

    iosAboutUpdateStateAcknowledged(outcome: string): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !['check-saved', 'badge-saved'].includes(outcome)) return {};
            try {
                await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                    message: 'Native iOS About update state saved',
                    context: { releaseCheck: 'v1.3.5/ios-about-update-state', outcome },
                }, { force: true });
            } catch {                                                                 }
            return {};
        });
    },

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
                } catch {                                                    }
                assertReady();
                return result;
            } catch {
                assertReady();
                throw new Error('LOOKUP_FAILED: App Store lookup could not be completed');
            }
        });
    },
    iosFileSyncDiagnostic(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: File Sync diagnostic is unavailable');
            try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                message: 'Native iOS File Sync app binding completed',
                context: { releaseCheck: 'v1.3.9/ios-file-sync-app-binding', operation: 'foreground', outcome: 'completed' },
            }, { force: true }); } catch { }
            return null;
        });
    },
    iosDirectoryFileSyncDiagnostic(): string {
        return submit(async () => {
            if (globalThis.__mindwtrHostPlatform !== 'ios') throw new Error('NOT_READY: Directory File Sync diagnostic is unavailable');
            try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                message: 'Native iOS manual directory File Sync completed',
                context: { releaseCheck: 'v1.3.9/ios-file-sync-directory-manual', operation: 'foreground', outcome: 'completed' },
            }, { force: true }); } catch { }
            return null;
        });
    },
    iosForegroundFileSync(turn: string, rootURI: string, canonicalPath: string): string {
        return submit(async () => {
            const channel = (globalThis as typeof globalThis & { __mindwtrFileSyncCall?: import('./host-file-sync').NativeFileSyncCall }).__mindwtrFileSyncCall;
            if (iosForegroundFailure || globalThis.__mindwtrHostPlatform !== 'ios' || nativeSync || !bootAdapter || !localAttachments
                || iosCleanupCallback || iosTaskAttachmentPreparation || iosProjectFilePreparation || isSandboxMode() || isWorkspaceTransitionActive()
                || typeof channel !== 'function' || typeof turn !== 'string' || !turn || typeof rootURI !== 'string' || typeof canonicalPath !== 'string'
                || typeof native().kvMultiGet !== 'function' || !globalThis.__mindwtrSyncSecrets) throw new Error('NOT_READY: File Sync is unavailable');
            const names = ['@mindwtr_sync_backend', '@mindwtr_sync_path', '@mindwtr_sync_path_bookmark'];
            const before = await keyValue.multiGet(names);
            const fresh = createIosFileSync({ ...nativeSyncBindings, emit: () => {}, trace: () => {}, scheduleBackgroundSync: () => {},
                retireLocalAttachment: async () => { throw new NativeAttachmentCleanupUnconfirmedError(); },
            }, { turn, rootURI, canonicalPath }, channel);
            const unchanged = async () => {
                if (JSON.stringify(await keyValue.multiGet(names)) !== JSON.stringify(before)) throw new Error('NOT_READY: File Sync configuration changed');
            };
            let result: Awaited<ReturnType<typeof fresh.settingsHost.performSync>>;
            try {
                result = await fresh.settingsHost.performSync(undefined, { manual: true, configOverride: { backend: 'file', syncPath: canonicalPath } });
            } catch (error) { await unchanged(); throw error; }
            await unchanged();
            if (!result.success || result.skipped || result.fileSyncLockDeferred) throw new Error('NOT_READY: File Sync cycle did not complete');
            return result;
        });
    },
    iosWorkspaceRetirementStatus(): string {
        if (globalThis.__mindwtrHostPlatform !== 'ios' || !bootAdapter || !readSyncSettingsRetirementStatus) {
            return JSON.stringify({ version: 1, ready: false, pending: true, uncertain: true });
        }
        const persistence = getPersistenceStatus(), settings = readSyncSettingsRetirementStatus();
        return JSON.stringify({ version: 1, ready: true,
            pending: pending.size > 0 || persistence.queued > 0 || persistence.inFlight || persistence.immediate > 0 || persistence.retrying
                || settings.pending || iosDirectorySync !== null || iosCleanupCallback !== null || iosTaskAttachmentPreparation || iosProjectFilePreparation
                || iosProjectAttachmentDownload || iosRelocatedProjectAvailability || iosCachedProjectAvailability || iosSelfHostedProjectAttachments !== null,
            uncertain: persistence.failed || settings.uncertain || iosForegroundFailure !== null,
        });
    },
    iosDirectorySyncSettings(name: string, json: string, control: unknown): string {
        return submit(async () => {
            const channel = (globalThis as typeof globalThis & { __mindwtrFileSyncCall?: import('./host-file-sync').NativeFileSyncCall }).__mindwtrFileSyncCall;
            const unavailable = () => new Error('NOT_READY: Directory File Sync is unavailable');
            if (iosForegroundFailure || globalThis.__mindwtrHostPlatform !== 'ios' || nativeSync || !bootAdapter || !localAttachments
                || iosDirectorySync || iosCleanupCallback || iosTaskAttachmentPreparation || iosProjectFilePreparation
                || isSandboxMode() || isWorkspaceTransitionActive() || typeof control !== 'function' || typeof channel !== 'function'
                || typeof json !== 'string' || new TextEncoder().encode(json).byteLength > 128 * 1024) throw unavailable();
            const input = JSON.parse(json) as Record<string, unknown>;
            if (!input || typeof input !== 'object' || Array.isArray(input)
                || !['openSyncSettings', 'syncSettings', 'closeSyncSettings', 'selectSyncBackend', 'pickSyncFolder', 'syncNow', 'syncPull'].includes(name)) throw unavailable();
            if (name === 'selectSyncBackend' && !['off', 'file'].includes(input.option as string)) throw unavailable();
            if (['pickSyncFolder', 'syncNow'].includes(name)
                && (typeof input.revision !== 'string' || !input.revision || input.revision.length > 100
                    || Object.keys(input).some((field) => !['requestId', 'revision'].includes(field)))) throw unavailable();
            if (name === 'syncPull' && Object.keys(input).length !== 0) throw unavailable();
            requireSaved();
            const persistence = getPersistenceStatus();
            if (persistence.failed || persistence.queued || persistence.inFlight || persistence.immediate || persistence.retrying) throw unavailable();
            ensureIosManualSync().settingsHost.encryption.mode = 'saved-webdav-or-local';
            const directory = createIosDirectoryFileSync(nativeSyncBindings, channel, control as (request: string) => unknown);
            iosDirectorySync = directory;
            try {
                if (name === 'syncPull') {
                    const value = await ensureIosManualSync().performStoredManualSync();
                    await flushPendingSave(); requireSaved();
                    try { await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                        message: 'Native iOS pull Sync command settled',
                        context: { releaseCheck: 'v1.3.9/ios-pull-sync', operation: name, outcome: 'settled' },
                    }, { force: true }); } catch { }
                    return { ok: true as const, value };
                }
                const result = name === 'syncSettings' ? contract.getSyncSettings(input)
                    : await MENU_COMMANDS[name as SyncScreenCommand](input as never);
                if (result.ok && (name === 'syncSettings' || name === 'openSyncSettings')) {
                    const model = result.value as import('../../../packages/core/src/native-host-contract-settings-sync').NativeSyncSettings;
                    model.backend.options = model.backend.options.filter(({ option }) => ['off', 'file', 'webdav', 'selfhosted'].includes(option));
                }
                return result;
            } finally { try { directory.close(); } finally { iosDirectorySync = null; } }
        });
    },
    iosForegroundSync(name: string, json: string, cleanup: unknown, currentTargetURI?: unknown, dropboxControl?: unknown): string {
        return submit(async (signal) => {
            if (iosForegroundFailure) throw iosForegroundFailure;
            const unavailable = () => new Error('NOT_READY: Foreground sync is unavailable');
            if (globalThis.__mindwtrHostPlatform !== 'ios' || !localAttachments || nativeSync || !bootAdapter
                || iosCleanupCallback || iosTaskAttachmentPreparation || iosProjectFilePreparation || typeof cleanup !== 'function' || isSandboxMode() || isWorkspaceTransitionActive()
                || typeof native().kvMultiGet !== 'function' || (name !== 'archiveRetention' && !globalThis.__mindwtrSyncSecrets)) throw unavailable();
            const commands = ['syncSettings', 'openSyncSettings', 'closeSyncSettings', 'selectSyncBackend',
                'saveSyncBackend', 'syncNow', 'testSyncConnection', 'syncStored', 'syncResume', 'syncPull', 'archiveRetention', 'projectAttachmentDownload', 'runSyncEncryptionAction', 'connectDropbox', 'disconnectDropbox'];
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
                || ['syncStored', 'syncResume', 'syncPull'].includes(name) && Object.keys(input).length !== 0) throw new Error('INVALID_INPUT: Invalid foreground sync request');
            if (name === 'projectAttachmentDownload' && (Object.keys(input).length !== 3
                || ['projectId', 'attachmentId', 'revision'].some((field) => {
                    const value = input[field];
                    return typeof value !== 'string' || !value || value.length > (field === 'revision' ? 200 : 500);
                }))) throw new Error('INVALID_INPUT: Invalid Project attachment download request');
            if (name === 'archiveRetention' && (Object.keys(input).length !== 1 || typeof input.editorOpen !== 'boolean')) {
                throw new Error('INVALID_INPUT: Archive retention requires the editor state');
            }
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
            if (dropboxControl !== undefined && typeof dropboxControl !== 'function') throw unavailable();
            const dropboxConfig = typeof dropboxControl === 'function' ? (() => {
                const raw = (dropboxControl as (json: string) => unknown)(JSON.stringify({ phase: 'configuration' }));
                if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 4096 || raw.startsWith('!MindwtrNativeError:')) throw unavailable();
                try { return readNativeIosDropboxConfiguration(JSON.parse(raw)); } catch { throw unavailable(); }
            })() : null;
            const refused = { ok: false as const, error: { code: 'ACTION_FAILED' as const,
                message: 'This sync provider is not available in native iOS yet; the stored configuration is unchanged' } };
            if (name === 'selectSyncBackend' && !['off', 'webdav', 'selfhosted', ...(iosCloudKitAvailable() ? ['cloudkit'] : []), ...(dropboxConfig ? ['dropbox'] : [])].includes(input.option as string)) return refused;
            const shownDropbox = dropboxConfig && ['syncNow', 'testSyncConnection'].includes(name) ? contract.getSyncSettings({}) : null;
            const dropboxPanelCall = shownDropbox?.ok === true && shownDropbox.value.panel?.kind === 'dropbox';
            if (['connectDropbox', 'disconnectDropbox'].includes(name) || dropboxPanelCall) {
                const fields = name === 'testSyncConnection' ? [] : ['requestId'];
                if (Object.keys(input).length !== fields.length || fields.length && (typeof input.requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.requestId))) throw unavailable();
                if (!dropboxConfig) throw unavailable();
            }
            const cloudKitSyncNow = !dropboxPanelCall && name === 'syncNow' && input.webdav === undefined && input.selfHosted === undefined && iosCloudKitAvailable();
            if (cloudKitSyncNow && (Object.keys(input).length !== 1 || typeof input.requestId !== 'string'
                || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.requestId))) {
                throw new Error('INVALID_INPUT: CloudKit Sync requires a request UUID');
            }
            if (['saveSyncBackend', 'syncNow', 'testSyncConnection'].includes(name) && !cloudKitSyncNow && !dropboxPanelCall) {
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
            iosDropboxControl = typeof dropboxControl === 'function' ? dropboxControl as (requestJSON: string) => unknown : null;
            iosDropboxSignal = signal;
            iosDropboxRequestId = name === 'connectDropbox' ? input.requestId as string : null;
            try {
                if (name === 'archiveRetention') {
                    let selectedBackend: string | null = null;
                    try { selectedBackend = (await keyValue.get(SYNC_BACKEND_KEY))?.trim() || 'off'; }
                    catch { }
                    return await contract.runArchiveRetention({ editorOpen: input.editorOpen as boolean, selectedBackend });
                }
                const stored = (await keyValue.get(SYNC_BACKEND_KEY))?.trim();
                const selfHosted = stored === 'cloud' && isNativeIosSelfHostedProvider(await keyValue.get(CLOUD_PROVIDER_KEY));
                const dropboxSelected = !!dropboxConfig && stored === 'cloud' && (await keyValue.get(CLOUD_PROVIDER_KEY))?.trim() === 'dropbox';
                const cloudKitSelected = stored === 'cloudkit' && iosCloudKitAvailable();
                const fileMetadata = stored === 'file' && ['openSyncSettings', 'syncSettings', 'closeSyncSettings'].includes(name);
                if (stored && stored !== 'off' && stored !== 'webdav' && !selfHosted && !cloudKitSelected && !dropboxSelected && !fileMetadata) return refused;
                if (cloudKitSyncNow && !cloudKitSelected) return refused;
                if (['syncStored', 'syncResume', 'syncPull'].includes(name) && stored !== 'webdav' && !selfHosted
                    && !(name === 'syncPull' && (cloudKitSelected || dropboxSelected))) {
                    if (name === 'syncPull') try {
                        await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                            message: 'Native iOS pull Sync command settled',
                            context: { releaseCheck: 'v1.3.9/ios-pull-sync', operation: name, outcome: 'skipped' },
                        }, { force: true });
                    } catch { }
                    return { ok: true as const, value: { success: true, skipped: true } };
                }
                if (name === 'projectAttachmentDownload' && stored !== 'webdav' && !selfHosted) return refused;

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
                if (!downloadResult) ensureIosManualSync();
                if (cloudKitSyncNow) {
                    const shown = contract.getSyncSettings({});
                    if (!shown.ok || shown.value.panel?.kind !== 'cloudkit') return refused;
                }
                if (iosManualSync) iosManualSync.settingsHost.encryption.mode = dropboxSelected ? 'saved-dropbox' : 'saved-webdav-or-local';
                if (name === 'selectSyncBackend' && input.option === 'selfhosted'
                    || ['saveSyncBackend', 'syncNow', 'testSyncConnection'].includes(name) && input.selfHosted !== undefined
                    || ['syncStored', 'syncResume', 'syncPull', 'projectAttachmentDownload'].includes(name) && selfHosted) {
                    try { await iosManualSync!.assertSelfHostedSyncAdmission(); }
                    catch (error) {
                        if (error instanceof NativeAttachmentCleanupUnconfirmedError) throw error;
                        return { ok: false as const, error: { code: 'ACTION_FAILED' as const,
                            message: error instanceof Error ? error.message : 'Self-hosted encryption admission is unavailable' } };
                    }
                }
                if (name === 'projectAttachmentDownload') {
                    if (!downloadResult) {

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
                if (name === 'syncStored' || name === 'syncResume' || name === 'syncPull') {
                    const answer = name === 'syncPull' ? await iosManualSync!.performStoredManualSync()
                        : await iosManualSync!.performStoredAutomaticSync(name === 'syncStored' ? 'startup' : 'resume');
                    await flushPendingSave();
                    requireSaved();
                    const after = getPersistenceStatus();
                    if (after.failed || after.queued || after.inFlight || after.immediate || after.retrying) throw unavailable();
                    storedResult = { success: answer.success === true, skipped: Boolean(answer.skipped) };
                }
                const result = downloadResult ?? (storedResult ? { ok: true as const, value: storedResult }
                    : name === 'syncSettings' ? contract.getSyncSettings(input)
                    : await MENU_COMMANDS[name as SyncScreenCommand](input as never));

                if (result.ok && result.value && typeof result.value === 'object' && 'backend' in result.value) {

                    if (name === 'syncSettings' || name === 'openSyncSettings') {
                        const model = result.value as import('../../../packages/core/src/native-host-contract-settings-sync').NativeSyncSettings;
                        model.backend.options = model.backend.options.filter(({ option }) => option === 'off' || option === 'file' || option === 'webdav' || option === 'selfhosted'
                            || option === 'cloudkit' && iosCloudKitAvailable() || option === 'dropbox' && !!dropboxConfig);
                    }
                }
                if (currentTargetURI === undefined && (name !== 'projectAttachmentDownload' || result.ok && result.value && typeof result.value === 'object'
                    && 'status' in result.value && result.value.status === 'available')) try {
                    const diagnostic = name === 'projectAttachmentDownload' ? { message: 'Native iOS Project file availability settled', releaseCheck: 'v1.3.5/ios-project-file-download' }
                        : name === 'syncStored' ? { message: 'Native iOS stored Sync command settled', releaseCheck: 'v1.3.5/ios-stored-sync' }
                        : name === 'syncPull' ? { message: 'Native iOS pull Sync command settled', releaseCheck: 'v1.3.9/ios-pull-sync' }
                        : name === 'syncResume' ? { message: 'Native iOS resume Sync command settled', releaseCheck: 'v1.3.5/ios-resume-sync' }
                        : { message: 'Native iOS foreground Sync command settled', releaseCheck: 'v1.3.5/ios-foreground-sync-owned' };
                    await diagnosticsLog.append({ ts: new Date().toISOString(), level: 'info', scope: 'native-ios',
                        message: diagnostic.message,
                        context: { releaseCheck: diagnostic.releaseCheck, operation: name, outcome: name === 'projectAttachmentDownload' ? 'available' : 'settled' },
                    }, { force: true });
                } catch {                                                              }
                return result;
            } catch (error) {
                if (error instanceof NativeAttachmentCleanupUnconfirmedError) iosForegroundFailure = error;
                throw error;
            } finally { iosCleanupCallback = null; iosDropboxControl = null; iosDropboxSignal = undefined; iosDropboxRequestId = null; }
        });
    },
    gettingStartedOutcome(json: string): string {
        return submit(async () => unwrap(contract.probeGettingStartedOutcome(completionJson(json, 2048) as Parameters<typeof contract.probeGettingStartedOutcome>[0])));
    },
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

native().trace?.('');
