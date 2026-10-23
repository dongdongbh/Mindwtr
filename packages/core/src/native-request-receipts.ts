import type { NativeHostResult } from './native-host-contract';
import { SqliteAdapter, type SqliteAdapterOptions, type SqliteClient } from './sqlite-adapter';
import { getPersistenceStatus, getSaveSnapshotGeneration, getStorageAdapter, trackSaveSnapshotGenerations, useTaskStore } from './store';
import type { StoreActionResult } from './store-types';
import { isSelectableProjectForTaskAssignment } from './project-utils';
import type { AppData, Project, Task } from './types';
import { deterministicHash128, generateDeterministicUUID } from './uuid';
import { taskEditValuesEqual } from './json-value-equality';
import { strToU8 } from 'fflate';
import { logInfo } from './logger';
import { TASK_SQLITE_COLUMNS } from './task-sync-schema';
import { stripSensitiveSettings } from './store-helpers';
import { runStoreCommand } from './store-write-gate';
import { decodeNativePomodoroSession, nativePomodoroReceiptPayload, NATIVE_POMODORO_SCHEMA4_TASK_COLUMNS, validatePreparedNativePomodoroTransition,
    type NativePomodoroSessionRead, type NativePomodoroResult, type PreparedNativePomodoroTransition } from './native-pomodoro-session';

/**
 * Exact-retry bookkeeping for native host writes, shared by every contract write
 * that takes a `requestId`. One request runs its write at most once:
 *
 * - The first call for a request ID reserves it before anything is awaited; a
 *   concurrent call with the same ID and payload waits for that same run.
 * - A later call with the same ID and payload does not write again. It only
 *   finishes the save if the first call's save failed, then returns the first
 *   call's result.
 * - A call with the same ID and another payload is refused (INVALID_INPUT).
 * - A write whose save has not succeeded is never forgotten, so its retry can
 *   always finish it. Only saved requests are evicted to stay under `limit`;
 *   while the bound holds only unsaved requests, new requests are refused
 *   (ACTION_FAILED) until a retry saves them.
 *
 * - A write that landed in memory while its save failed returns SAVE_FAILED
 *   (with settleWrite). It keeps its receipt as an owed save: a retry only
 *   saves, and never runs the write again. A write returns SAVE_FAILED only
 *   when its change landed (runStoreWrite decides).
 *
 * Any other failure means the write did not land: it leaves no receipt, so the
 * same request can run again.
 *
 * The native host keeps receipts on disk too (loadNativeRequestReceipts,
 * NativeReceiptSqliteAdapter): a write's receipt commits in the same SQLite
 * transaction as its data (or, when a save inside the write committed the data
 * first, in a receipt-only commit right after it), and the reply waits for that
 * commit. So the journal's replay after process death answers a landed request
 * from its first reply and runs nothing. One request ID belongs to one action
 * across all the contract's modules. Without that table (other
 * hosts, tests), or for a write whose data a save committed before its receipt
 * existed, a replay runs the write again, so every write must also be safe to run
 * again after a later change:
 *
 * - target-state: a replay of a request that already landed writes nothing;
 * - compare-and-set: a write to existing rows carries the revision the view showed
 *   for each (revisionOf) and refuses rows changed since (refuseStale), so a
 *   replay never undoes a later change;
 * - a create names its row by the request UUID (a second row by requestRowId), so
 *   a replay finds the row it made.
 */
export type NativeRequestReceipts = {
    /** Check ownership without reserving an ID, writing, or saving. */
    checkIdentity(requestId: unknown, payload: string): NativeHostResult<null>;
    /** Read a settled reply without reserving an ID, retrying a save or invoking a writer. */
    saved<T>(requestId: unknown, payload: string): NativeHostResult<T> | null;
    run<T>(requestId: unknown, payload: string, write: () => Promise<NativeHostResult<T> | NativeUnsavedWrite<T>>): Promise<NativeHostResult<T>>;
};

/** A write whose change landed while the store could not save it; `value` answers the request once a retry saves. */
export type NativeUnsavedWrite<T> = { ok: false; error: { code: 'SAVE_FAILED'; message: string }; value: T };

/** Private native owner proof: this execution attempted no domain mutation. */
export class NativePomodoroTransitionRefusal extends Error {
    constructor(readonly code: 'staleBaseline' | 'notReady', message: string) { super(message); }
}

type StoreCall = () => Promise<StoreActionResult | void | (StoreActionResult | void | undefined)[]>;
const storeData = () => {
    const state = useTaskStore.getState();
    return [state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings];
};

/**
 * Runs a contract write's store call (one, or several together) and says whether it
 * landed. A refusal that left the store's data as it was did not land
 * (ACTION_FAILED). A refusal after the data changed, while the store could not save
 * it, landed (SAVE_FAILED): the request owes only a save.
 */
export async function runStoreWrite(call: StoreCall): Promise<NativeHostResult<null>> {
    const before = storeData();
    let message = 'The action failed';
    try {
        const outcome = await call();
        const refused = (Array.isArray(outcome) ? outcome : [outcome]).find((result) => result && result.success === false);
        if (!refused) return { ok: true, value: null };
        message = refused.error ?? message;
    } catch (error) {
        message = error instanceof Error ? error.message : String(error);
    }
    const failure = useTaskStore.getState().persistenceFailure;
    const landed = storeData().some((data, index) => data !== before[index]);
    if (landed && failure) return { ok: false, error: { code: 'SAVE_FAILED', message: failure.message } };
    return { ok: false, error: { code: 'ACTION_FAILED', message } };
}

/** A write's answer: `value` once it landed, carried by SAVE_FAILED when only its save failed. */
export function settleWrite<T>(written: NativeHostResult<null>, value: T): NativeHostResult<T> | NativeUnsavedWrite<T> {
    if (written.ok) return { ok: true, value };
    if (written.error.code === 'SAVE_FAILED') return { ok: false, error: { code: 'SAVE_FAILED', message: written.error.message }, value };
    return written;
}

/** A synced row: a task, project, area or person. */
type Revisioned = { rev?: number; revBy?: string; updatedAt: string };

/**
 * A row's revision for a compare-and-set write: it changes with every write to the row,
 * here or synced from another device. A command made on one revision refuses a row
 * that changed since, so a replay after a restart never undoes a later change.
 */
export const revisionOf = (row: Revisioned): string => `${row.rev ?? 0}:${row.revBy ?? ''}:${row.updatedAt}`;
export const taskRevisionOf = (task: Task): string => revisionOf(task);

/** Each target row's revision as the view showed it, by ID. */
export type NativeRevisions = Record<string, string>;

/**
 * Whether a write must carry its replay tokens: the revisions the view showed and, for
 * saveTaskDraft, a request UUID. A host that journals its writes and replays them after
 * process death (the native Android host, which says so at boot) sets 'required': a write
 * without them is refused (INVALID_INPUT). Any other host ('optional', the default) may
 * leave them out and keeps the rules from before its writes were journaled: a missing
 * revision skips that row's compare-and-set, and a draft save without a request UUID keeps
 * its process-local retry. A token it sends is checked as in 'required'.
 */
export type NativeReplayTokens = 'required' | 'optional';
let replayTokens: NativeReplayTokens = 'optional';
/** One mode per JS host: createNativeHostContract sets it, and a journaling host's boot sets 'required'. */
export const setNativeReplayTokens = (mode: NativeReplayTokens) => { replayTokens = mode; };
export const replayTokensRequired = (): boolean => replayTokens === 'required';

/** A revision as a command carries it: the non-empty text a view gave (or none, while tokens are optional). */
export const isRevision = (value: unknown): value is string => (value === undefined
    ? !replayTokensRequired()
    : typeof value === 'string' && value.length > 0 && value.length <= 200);

/** Whether `value` holds a revision for each of `ids`, and for nothing else (or is left out, while tokens are optional). */
export const isRevisions = (value: unknown, ids: readonly string[]): value is NativeRevisions => (value === undefined
    ? !replayTokensRequired()
    : typeof value === 'object' && value !== null && !Array.isArray(value)
        && Object.keys(value).length === ids.length && ids.every((id) => isRevision((value as Record<string, unknown>)[id])));

/**
 * Compare-and-set for a write about to change these rows: STALE_REVISION when one is
 * gone or no longer at the revision the view showed. Call it inside the receipts'
 * write (a same-host retry of a landed write still answers from its receipt), after
 * the target-state check (a replay whose target already holds writes nothing), for
 * the rows the write changes.
 */
export function refuseStale(
    rows: readonly (Revisioned | undefined)[],
    revisions: readonly (string | undefined)[],
    message = 'It changed since the view showed it; read the view again',
): NativeHostResult<never> | null {
    // While tokens are optional, a row sent without its revision is not compared.
    return rows.some((row, index) => (revisions[index] !== undefined || replayTokensRequired()) && (!row || revisionOf(row) !== revisions[index]))
        ? { ok: false, error: { code: 'STALE_REVISION', message } }
        : null;
}

/** refuseStale for tasks by ID, against `revisions` (a view's `taskRevisions`). */
export function refuseStaleTasks(ids: readonly string[], revisions: NativeRevisions | undefined): NativeHostResult<never> | null {
    const { _tasksById } = useTaskStore.getState();
    return refuseStale(ids.map((id) => _tasksById.get(id)), ids.map((id) => revisions?.[id]), 'A task changed since the view showed it; read the view again');
}

/** refuseStale for projects by ID, in Trash too. */
export function refuseStaleProjects(ids: readonly string[], revisions: NativeRevisions | undefined): NativeHostResult<never> | null {
    const byId = new Map(useTaskStore.getState()._allProjects.map((project) => [project.id, project]));
    return refuseStale(ids.map((id) => byId.get(id)), ids.map((id) => revisions?.[id]), 'A project changed since the view showed it; read the view again');
}

/** These tasks' revisions now, by ID: what an Undo carries after its write. */
export const taskRevisionsOf = (ids: readonly string[]): NativeRevisions => {
    const { _tasksById } = useTaskStore.getState();
    return Object.fromEntries(ids.flatMap((id) => {
        const task = _tasksById.get(id);
        return task ? [[id, taskRevisionOf(task)]] : [];
    }));
};

/**
 * A revision for many rows at once (a Select all, a context's carriers): their count and
 * a 128-bit hash of their `id@revision` entries. Deterministic, so a token a view gave
 * before a restart still matches after it while those rows are unchanged.
 */
export const revisionsToken = (entries: readonly string[]): string => `${entries.length}:${hash128Hex(JSON.stringify(entries))}`;

const hash128Hex = (text: string): string => deterministicHash128(text).map((part) => part.toString(16).padStart(8, '0')).join('');

/**
 * The ID of a row a request creates beside its main row (a capture's new project),
 * derived from the request UUID and the row's `role`: a retry finds that row by it.
 */
export const requestRowId = (requestId: string, role: string): string => generateDeterministicUUID(`${requestId.toLowerCase()}:${role}`);

/**
 * The addProject a request hands to a core flow that may make a project. The project takes
 * `idOf(title)` (requestRowId, or the request UUID for a main row), and that ID is looked up
 * first: a retry after a failed later write takes the project the first try made, renamed
 * since or not, and never makes a second one. One deleted or archived since sets `stale` and
 * writes nothing; the request then answers STALE_REVISION.
 */
export const requestProjects = (idOf: (title: string) => string) => {
    const made = { stale: false };
    const addProject = async (title: string, color: string, props?: Partial<Project>): Promise<Project | null> => {
        const id = idOf(title);
        const state = useTaskStore.getState();
        const project = state._allProjects.find((entry) => entry.id === id);
        if (!project) return state.addProject(title, color, { ...props, id });
        if (isSelectableProjectForTaskAssignment(project)) return project;
        made.stale = true;
        return null;
    };
    return { addProject, made };
};

/**
 * The projects a request's names are matched against: the project the request made (`id`), when
 * it exists, under `title` (the name the request gives it), in place of every other project of
 * that name. The request's own project wins over one made or renamed since. Null when that
 * project is deleted or archived: the request answers STALE_REVISION.
 */
export const withRequestProject = (projects: readonly Project[], id: string, title: string): Project[] | null => {
    const own = useTaskStore.getState()._allProjects.find((project) => project.id === id);
    if (!own) return [...projects];
    if (!isSelectableProjectForTaskAssignment(own)) return null;
    const key = title.trim().toLowerCase();
    return [{ ...own, title }, ...projects.filter((project) => project.id !== id && project.title.trim().toLowerCase() !== key)];
};

/**
 * Commands the native journal never keeps, such as one that carries a secret: a receipt payload's
 * command name (its first element), whose receipts stay in memory and never reach the disk, or a
 * contract command that keeps no request payload at all.
 * calendarFeedAdd: a new calendar subscription, whose URL may carry a password
 * (native-host-contract-settings-calendar.ts addCalendarFeed).
 * setAIKey carries an AI key and setAIEndpoint a URL that may hold a password (NATIVE_AI_UNJOURNALED_COMMANDS).
 * Settings › Sync's screen commands (NATIVE_SYNC_SETTINGS_UNJOURNALED_COMMANDS in native-host-contract-settings-sync.ts,
 * the same names).
 */
export const NATIVE_UNJOURNALED_COMMANDS: ReadonlySet<string> = new Set<string>(['calendarFeedAdd', 'setAIKey', 'setAIEndpoint', 'openSyncSettings', 'closeSyncSettings', 'selectSyncBackend', 'saveSyncBackend', 'syncNow', 'testSyncConnection', 'pickSyncFolder', 'connectDropbox', 'disconnectDropbox', 'runSyncEncryptionAction']);

const commandOf = (payload: string): string => /^\["([^"\\]{1,64})"/.exec(payload)?.[1] ?? '';
/** Bounded non-sensitive domain tuples are exact; established commands keep their compact hash. */
const fingerprintOf = (payload: string): string => {
    if (commandOf(payload) === 'pomodoroTransition') {
        try {
            const tuple: unknown = JSON.parse(payload);
            if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[0] !== 'pomodoroTransition'
                || nativePomodoroReceiptPayload(tuple[1] as PreparedNativePomodoroTransition) !== payload) throw new Error();
            return payload;
        } catch { throw new Error('Invalid Pomodoro receipt payload'); }
    }
    return ['appLock', 'backupDocument'].includes(commandOf(payload)) ? payload : `${commandOf(payload)}:${hash128Hex(payload)}`;
};
const fingerprintCommand = (value: string): string => value.startsWith('[')
    ? commandOf(value) : value.split(':', 1)[0] ?? '';
const validAppLockStoredReceipt = (row: { request_id: string; method: string; reply: string; saved_at: string },
    reply: unknown): boolean => {
    if (!REQUEST_ID_PATTERN.test(row.request_id) || row.request_id !== row.request_id.toLowerCase()
        || row.method.length > 8192 || row.saved_at.length > 40
        || !Number.isFinite(Date.parse(row.saved_at))
        || new Date(row.saved_at).toISOString() !== row.saved_at) return false;
    let tuple: unknown;
    try { tuple = JSON.parse(row.method); } catch { return false; }
    if (!Array.isArray(tuple) || tuple.length !== 5 || tuple[0] !== 'appLock'
        || typeof tuple[1] !== 'boolean' || typeof tuple[2] !== 'boolean'
        || typeof tuple[3] !== 'boolean' || !tuple[2] && tuple[3]
        || (tuple[3] ? typeof tuple[4] !== 'boolean' : tuple[4] !== null)
        || JSON.stringify(tuple) !== row.method) return false;
    return !!reply && typeof reply === 'object' && !Array.isArray(reply)
        && Object.keys(reply).length === 2
        && Object.prototype.hasOwnProperty.call(reply, 'changed')
        && Object.prototype.hasOwnProperty.call(reply, 'value')
        && (reply as { changed?: unknown }).changed === true
        && (reply as { value?: unknown }).value === tuple[1];
};

export const MAX_NATIVE_DOCUMENT_RECEIPT_REPLY_BYTES = 64 * 1024;
export type NativeDocumentReceiptInput = {
    requestId: string;
    /** Canonical JSON: ['backupDocument', 'merge' | 'restore' | 'replace' | 'csv' | 'todoist' | 'ticktick' | 'dgt' | 'omnifocus', staged UUID, SHA256]. */
    payload: string;
    expectedCurrent: AppData;
    data: AppData;
    /** Non-null JSON, at most 64 KiB UTF-8. The caller validates its domain shape. */
    reply: unknown;
    /**
     * The library's SQLite bytes (pages) this write may leave, its receipt included: checked after the receipt insert and
     * before COMMIT, so a refusal ([UNDO_LIMIT_EXCEEDED]) rolls back the data and the receipt together.
     */
    maxLibraryBytes?: number;
    /**
     * The library's SQLite bytes this write may leave while its Undo still fits (large-library pass b): past them the write still
     * commits, and its stored reply gains `undo: false`, so a replay answers the same.
     */
    undoLibraryBytes?: number;
    /**
     * The caller hands both documents over (core's native backup commit, which parsed them itself and keeps no reference): no
     * detaching copy is made, and the baseline goes once the stale check has read it.
     */
    owned?: true;
};
export const UNDO_LIMIT_EXCEEDED = 'Document library exceeds the undo limit';
export type NativeDocumentReceiptResult = { reply: unknown; replayed: boolean };

const isCanonicalRequestId = (value: unknown): value is string => typeof value === 'string'
    && REQUEST_ID_PATTERN.test(value) && value === value.toLowerCase();
const isDocumentPayload = (payload: unknown): payload is string => {
    if (typeof payload !== 'string' || payload.length > 256) return false;
    let tuple: unknown;
    try { tuple = JSON.parse(payload); } catch { return false; }
    return Array.isArray(tuple) && tuple.length === 4 && tuple[0] === 'backupDocument'
        && (tuple[1] === 'merge' || tuple[1] === 'restore' || tuple[1] === 'replace' || tuple[1] === 'csv' || tuple[1] === 'todoist' || tuple[1] === 'ticktick' || tuple[1] === 'dgt' || tuple[1] === 'omnifocus') && isCanonicalRequestId(tuple[2])
        && typeof tuple[3] === 'string' && /^[a-f0-9]{64}$/u.test(tuple[3])
        && JSON.stringify(tuple) === payload;
};
const documentReplyJson = (reply: unknown): string => {
    let json: string | undefined;
    try { json = JSON.stringify(reply); } catch { /* Refuse unserializable input without exposing it. */ }
    if (!json || json === 'null' || json.length > MAX_NATIVE_DOCUMENT_RECEIPT_REPLY_BYTES
        || strToU8(json).length > MAX_NATIVE_DOCUMENT_RECEIPT_REPLY_BYTES) {
        throw new Error('Invalid document receipt reply');
    }
    return json;
};
type DocumentReceiptRow = { request_id: string; method: string; reply: string; saved_at: string };
const validDocumentReceiptRow = (row: DocumentReceiptRow): boolean => {
    if (!isCanonicalRequestId(row.request_id) || !isDocumentPayload(row.method)
        || typeof row.reply !== 'string' || row.reply.length > MAX_NATIVE_DOCUMENT_RECEIPT_REPLY_BYTES
        || strToU8(row.reply).length > MAX_NATIVE_DOCUMENT_RECEIPT_REPLY_BYTES
        || typeof row.saved_at !== 'string' || row.saved_at.length > 40
        || !Number.isFinite(Date.parse(row.saved_at)) || new Date(row.saved_at).toISOString() !== row.saved_at) return false;
    try { return documentReplyJson(JSON.parse(row.reply)) === row.reply; } catch { return false; }
};
const hasPendingDocumentStoreWork = (): boolean => {
    const status = getPersistenceStatus();
    return Boolean(status.queued || status.inFlight || status.immediate || status.retrying || status.failed);
};

const POMODORO_TABLE = `CREATE TABLE IF NOT EXISTS native_pomodoro_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state_json TEXT NOT NULL
)`;
const pomodoroReceiptPlan = (row: DocumentReceiptRow): PreparedNativePomodoroTransition => {
    try {
        const tuple: unknown = JSON.parse(row.method);
        if (!Array.isArray(tuple) || tuple.length !== 2 || tuple[0] !== 'pomodoroTransition') throw new Error();
        const plan = validatePreparedNativePomodoroTransition(tuple[1]);
        if (row.request_id !== plan.request.requestId || row.method !== nativePomodoroReceiptPayload(plan)
            || row.reply !== JSON.stringify(plan.result) || typeof row.saved_at !== 'string'
            || row.saved_at.length > 40 || !Number.isFinite(Date.parse(row.saved_at))
            || new Date(row.saved_at).toISOString() !== row.saved_at) throw new Error();
        return plan;
    } catch { throw new Error('Invalid saved Pomodoro receipt'); }
};

// Durable receipts: the native host only (loadNativeRequestReceipts turns them on).
type StoredReceipt = { fingerprint: string; reply: unknown; savedAt: string };
type PendingReceipt = { fingerprint: string; reply: unknown; generation: number };
let durableReceipts: Map<string, StoredReceipt> | null = null;
/** null selects Android's existing all-command mode; a set scopes iOS durable replies and writes. */
let durableCommands: Set<string> | null = null;
/** Whether boot loaded durable receipt ownership for this exact command. */
export const isNativeRequestReceiptDurable = (command: string): boolean => durableReceipts !== null
    && (durableCommands === null || durableCommands.has(command))
    && !NATIVE_UNJOURNALED_COMMANDS.has(command);
/** Every request ID a receipts instance holds, and its payload: one ID belongs to one action across the contract's modules. */
const requestPayloads = new Map<string, string>();
/** Landed, not committed yet; `generation` is the store's when it landed (every change it made is saved at or before it). */
const pendingReceipts = new Map<string, PendingReceipt>();
let receiptedWritesRunning = 0;
// The existing generation writer must refuse before its callback can mutate memory.
// Weak ownership follows the active concrete adapter and exposes no latch-clearing API.
const pomodoroStoreWriteFences = new WeakSet<SqliteAdapter>();

const RECEIPTS_TABLE = `CREATE TABLE IF NOT EXISTS native_request_receipts (
    request_id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    reply TEXT NOT NULL,
    saved_at TEXT NOT NULL
)`;
const RECEIPT_DAYS = 30;

const recordPendingReceipt = (requestId: string, payload: string, reply: unknown) => {
    pendingReceipts.set(requestId, { fingerprint: fingerprintOf(payload), reply, generation: getPersistenceStatus().generation });
};

/**
 * Native host boot, before the journal's replay: creates the receipts table (`method` is the
 * request's fingerprint, fingerprintOf: its command and a hash of its payload; `reply` its first
 * reply as JSON) and loads it. From then on every landed request's receipt is kept on disk,
 * except for NATIVE_UNJOURNALED_COMMANDS.
 */
export async function loadNativeRequestReceipts(client: SqliteClient,
    options?: { durableCommands?: readonly string[] }): Promise<number> {
    await client.run(RECEIPTS_TABLE);
    await client.run(POMODORO_TABLE);
    const rows = await client.all<{ request_id: string; method: string; reply: string; saved_at: string }>(
        'SELECT request_id, method, reply, saved_at FROM native_request_receipts',
    );
    let legacyPomodoroReceipts = 0;
    durableReceipts = new Map(rows.map((row) => {
        if (fingerprintCommand(row.method) === 'backupDocument' && !validDocumentReceiptRow(row))
            throw new Error('Invalid saved document receipt');
        if (fingerprintCommand(row.method) === 'pomodoroTransition') {
            const plan = pomodoroReceiptPlan(row);
            if (plan.target?.row?.length === NATIVE_POMODORO_SCHEMA4_TASK_COLUMNS.length) legacyPomodoroReceipts += 1;
        }
        const reply: unknown = JSON.parse(row.reply);
        if (options?.durableCommands?.includes('appLock') && fingerprintCommand(row.method) === 'appLock'
            && !validAppLockStoredReceipt(row, reply)) throw new Error('Invalid saved App lock receipt');
        return [row.request_id, { fingerprint: row.method, reply, savedAt: row.saved_at }];
    }));
    durableCommands = options?.durableCommands ? new Set(options.durableCommands) : null;
    pendingReceipts.clear();
    requestPayloads.clear();
    receiptedWritesRunning = 0;
    trackSaveSnapshotGenerations(true);
    if (legacyPomodoroReceipts > 0) {
        try {
            logInfo('Native Pomodoro legacy receipts accepted', { scope: 'storage', force: true,
                context: { releaseCheck: 'v1.3.7/native-pomodoro-legacy-receipt', count: legacyPomodoroReceipts, outcome: 'accepted' } });
        } catch { /* Diagnostics cannot change successful receipt validation. */ }
    }
    return durableReceipts.size;
}

/** After the journal's boot replay: drops receipts older than 30 days. */
export async function pruneNativeRequestReceipts(client: SqliteClient, now = new Date(), retention?: {
    readonly retainedRequestIds?: readonly string[];
    readonly retainedCommands?: readonly string[];
}): Promise<number> {
    // shortcut: default 30-day expiry, pass explicit retention when unfinished work outlives it.
    const cutoff = new Date(now.getTime() - RECEIPT_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const retainedIds = new Set(retention?.retainedRequestIds);
    const retainedCommands = new Set(retention?.retainedCommands);
    // One receipt proves the timer was established even if its singleton row is later lost.
    let latestPomodoro: [string, StoredReceipt] | undefined;
    for (const entry of durableReceipts ?? []) {
        if (fingerprintCommand(entry[1].fingerprint) === 'pomodoroTransition'
            && (!latestPomodoro || entry[1].savedAt > latestPomodoro[1].savedAt
                || (entry[1].savedAt === latestPomodoro[1].savedAt && entry[0] > latestPomodoro[0]))) latestPomodoro = entry;
    }
    const expires = (id: string, receipt: StoredReceipt): boolean => receipt.savedAt < cutoff
        && (durableCommands === null || durableCommands.has(fingerprintCommand(receipt.fingerprint)))
        && id !== latestPomodoro?.[0] && !retainedIds.has(id) && !retainedCommands.has(fingerprintCommand(receipt.fingerprint));
    if (durableCommands === null && retention === undefined && !latestPomodoro) await client.run('DELETE FROM native_request_receipts WHERE saved_at < ?', [cutoff]);
    else for (const [id, receipt] of durableReceipts ?? []) {
        if (expires(id, receipt))
            await client.run('DELETE FROM native_request_receipts WHERE request_id = ? AND saved_at < ?', [id, cutoff]);
    }
    let pruned = 0;
    for (const [id, receipt] of durableReceipts ?? []) {
        if (!expires(id, receipt)) continue;
        durableReceipts!.delete(id);
        pruned += 1;
    }
    return pruned;
}

/** A new native host (createNativeHostContract): the request IDs an earlier host held in memory are forgotten. */
export const startNativeRequestSession = () => { requestPayloads.clear(); };

/** Tests only: back to receipts in memory. */
export const resetNativeRequestReceipts = () => {
    durableReceipts = null;
    durableCommands = null;
    pendingReceipts.clear();
    requestPayloads.clear();
    receiptedWritesRunning = 0;
    trackSaveSnapshotGenerations(false);
};

type PomodoroProjectionAcknowledgment = { references: ReturnType<typeof storeData>; frozen: unknown; changedAt: number };

/**
 * The native host's SQLite adapter. A save of a queued snapshot also commits, in the same
 * transaction, every pending receipt whose changes that snapshot holds (landed at its
 * generation or before), and never one whose changes it lacks. While a receipt is pending
 * or a receipted write runs it offers no saveTask, so the store saves whole snapshots and
 * no later change reaches the disk before that receipt.
 */
export class NativeReceiptSqliteAdapter extends SqliteAdapter {
    private readonly receiptClient: SqliteClient;
    private readonly carried = new WeakMap<AppData, { ids: string[]; savedAt: string }>();
    private prerequisite: { requestId: string; fingerprint: string; originId: string; originFingerprint: string; reply: unknown } | null = null;
    private documentBusy = false;
    private ordinaryWrites = 0;
    private baselineReads = 0;
    private pomodoroBusy = false;
    private pomodoroReloadRequired = false;
    private pomodoroReloadRequest: string | null = null;
    private pomodoroUncertainRequest: string | null = null;
    private pomodoroReload: { data: AppData | null; available: boolean; acknowledged: PomodoroProjectionAcknowledgment | null;
        generation: number; fetch: ReturnType<typeof useTaskStore.getState>['fetchData'] } | null = null;
    private documentReceipt: { requestId: string; payload: string; data: AppData; replyJson: string; savedAt: string; maxLibraryBytes?: number; undoLibraryBytes?: number } | null = null;

    constructor(client: SqliteClient, options?: SqliteAdapterOptions) {
        let isDocumentWrite = () => false;
        const protect = async <T,>(work: () => Promise<T>): Promise<T> => {
            try { return await work(); }
            catch (error) {
                // The adapter's existing failure logger must not receive driver text containing
                // the private document or receipt. Ordinary generation saves retain their behavior.
                if (isDocumentWrite()) throw new Error('Document receipt storage failed');
                throw error;
            }
        };
        const receiptClient: SqliteClient = {
            run: (sql, params) => protect(() => client.run(sql, params)),
            all: <T,>(sql: string, params?: unknown[]) => protect(() => client.all<T>(sql, params)),
            get: <T,>(sql: string, params?: unknown[]) => protect(() => client.get<T>(sql, params)),
            ...(client.exec ? { exec: (sql: string) => protect(() => client.exec!(sql)) } : {}),
        };
        super(receiptClient, options);
        isDocumentWrite = () => this.documentBusy || this.pomodoroBusy;
        this.receiptClient = receiptClient;
        const saveTask = this.saveTask;
        Object.defineProperty(this, 'saveTask', {
            get: () => (pendingReceipts.size === 0 && receiptedWritesRunning === 0 ? saveTask : undefined),
        });
    }

    override async getData(options?: Parameters<SqliteAdapter['getData']>[0]): ReturnType<SqliteAdapter['getData']> {
        const reload = this.pomodoroReload;
        const privateRead = this.pomodoroBusy && reload?.available === true;
        if (this.pomodoroBusy && !privateRead) throw new Error('Pomodoro storage is busy');
        if (privateRead) reload.available = false;
        this.baselineReads += 1;
        try {
            const data = await super.getData(privateRead ? { rawTasks: true } : options);
            if (privateRead && this.pomodoroReload === reload) reload.data = data;
            return data;
        } finally { this.baselineReads -= 1; }
    }

    override async readRowBaseline(): ReturnType<SqliteAdapter['readRowBaseline']> {
        if (this.pomodoroBusy) throw new Error('Pomodoro storage is busy');
        this.baselineReads += 1;
        try { return await super.readRowBaseline(); }
        finally { this.baselineReads -= 1; }
    }

    /** Existing store acknowledgement seam, usable only for this private owned canonical read. */
    acknowledgeDataLoad(data: AppData): void {
        const reload = this.pomodoroReload;
        if (!reload || reload.acknowledged || reload.data !== data || getStorageAdapter() !== this || hasPendingDocumentStoreWork()
            || getPersistenceStatus().generation !== reload.generation || useTaskStore.getState().editLockCount > 0
            || useTaskStore.getState().fetchData !== reload.fetch) return;
        const state = useTaskStore.getState();
        if (!taskEditValuesEqual([state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings],
            [data.tasks, data.projects, data.sections ?? [], data.areas ?? [], data.people ?? [], stripSensitiveSettings(data.settings)])) return;
        const references = storeData();
        reload.acknowledged = { references, frozen: JSON.parse(JSON.stringify(references)) as unknown, changedAt: state.lastDataChangeAt };
    }

    private refusePomodoroWriteFence(): void {
        if (this.pomodoroBusy) throw new Error('Pomodoro storage is busy');
        if (this.pomodoroReloadRequired) throw new Error('Pomodoro canonical reload is required');
    }

    private async reloadPomodoroProjection(before: ReturnType<typeof storeData>, frozen: unknown, generation: number, changedAt: number): Promise<boolean> {
        if (!this.pomodoroReloadRequired) return true;
        if (getStorageAdapter() !== this || hasPendingDocumentStoreWork() || useTaskStore.getState().editLockCount > 0) return false;
        const fetch = useTaskStore.getState().fetchData;
        const relevant = () => getStorageAdapter() === this && useTaskStore.getState().fetchData === fetch && !hasPendingDocumentStoreWork()
            && getPersistenceStatus().generation === generation && useTaskStore.getState().editLockCount === 0
            && useTaskStore.getState().lastDataChangeAt === changedAt
            && storeData().every((value, index) => value === before[index]) && taskEditValuesEqual(storeData(), frozen);
        const context = { data: null as AppData | null, available: true, acknowledged: null as PomodoroProjectionAcknowledgment | null, fetch, generation };
        this.pomodoroReload = context;
        try {
            await fetch({ silent: true, recoveryLoad: true, throwOnError: true, isResultStillRelevant: relevant });
            const accepted = context.acknowledged;
            // ACK precedes fetch completion. Its exact adopted projection and fetch
            // owner must still be current before stale-snapshot writers are unfenced.
            if (!accepted || getStorageAdapter() !== this || hasPendingDocumentStoreWork()
                || getPersistenceStatus().generation !== generation || useTaskStore.getState().editLockCount > 0
                || useTaskStore.getState().fetchData !== fetch || useTaskStore.getState().lastDataChangeAt !== accepted.changedAt
                || !storeData().every((value, index) => value === accepted.references[index])
                || !taskEditValuesEqual(storeData(), accepted.frozen)) return false;
            this.pomodoroReloadRequired = false;
            this.pomodoroReloadRequest = null;
            return true;
        } catch { return false; }
        finally { this.pomodoroReload = null; }
    }

    private async readPomodoroCell(): Promise<NativePomodoroSessionRead> {
        const columns = await this.receiptClient.all<{ name: string; type: string; pk: number; notnull: number }>('PRAGMA table_info(native_pomodoro_session)');
        if (columns.length !== 2 || columns[0].name !== 'id' || columns[0].type !== 'INTEGER' || columns[0].pk !== 1
            || columns[1].name !== 'state_json' || columns[1].type !== 'TEXT' || columns[1].notnull !== 1 || columns[1].pk !== 0)
            throw new Error('Invalid Pomodoro storage schema');
        const rows = await this.receiptClient.all<{ id: number; state_json: string }>('SELECT id, state_json FROM native_pomodoro_session');
        if (rows.length === 0) {
            const established = await this.receiptClient.get<{ present: number }>(
                'SELECT 1 AS present FROM native_request_receipts WHERE method LIKE ? LIMIT 1', ['["pomodoroTransition",%']);
            if (established) {
                try { logInfo('Native Pomodoro refused missing established session', { scope: 'storage', force: true,
                    context: { releaseCheck: 'v1.3.5/ios-pomodoro-absence', outcome: 'refused' } }); } catch { /* The refusal is independent of diagnostics. */ }
                throw new Error('Established Pomodoro session is missing');
            }
            return { raw: null, state: null };
        }
        if (rows.length !== 1 || rows[0].id !== 1 || typeof rows[0].state_json !== 'string') throw new Error('Invalid Pomodoro storage row');
        return { raw: rows[0].state_json, state: decodeNativePomodoroSession(rows[0].state_json) };
    }

    async readPomodoroSession(): Promise<NativePomodoroSessionRead> {
        if (this.pomodoroBusy) throw new Error('Pomodoro storage is busy');
        try { return await this.exclusive('readPomodoroSession', () => this.readPomodoroCell()); }
        catch { throw new Error('Pomodoro session could not be read'); }
    }

    private async readPomodoroProof(plan: PreparedNativePomodoroTransition, payload: string): Promise<NativePomodoroResult | null> {
        const rows = await this.receiptClient.all<DocumentReceiptRow>(
            'SELECT request_id, method, reply, saved_at FROM native_request_receipts WHERE request_id = ?', [plan.request.requestId]);
        if (rows.length === 0) {
            if (durableReceipts?.has(plan.request.requestId) || this.pomodoroUncertainRequest === plan.request.requestId)
                throw new Error('Saved Pomodoro receipt is missing');
            return null;
        }
        if (rows.length !== 1) throw new Error('Invalid saved Pomodoro receipt');
        const saved = pomodoroReceiptPlan(rows[0]);
        if (rows[0].method !== payload || saved.request.requestId !== plan.request.requestId) throw new Error('Pomodoro receipt identity changed');
        return saved.result;
    }

    async readPomodoroTransitionOutcome(input: PreparedNativePomodoroTransition): Promise<NativePomodoroResult | null> {
        if (this.pomodoroBusy) throw new Error('Pomodoro storage is busy');
        try {
            const plan = validatePreparedNativePomodoroTransition(input);
            return await this.exclusive('readPomodoroTransitionOutcome', () => this.readPomodoroProof(plan, nativePomodoroReceiptPayload(plan)));
        } catch { throw new Error('Pomodoro outcome could not be proven'); }
    }

    async savePomodoroTransitionWithReceipt(input: PreparedNativePomodoroTransition, options?: { replayOnly?: boolean }): Promise<{
        result: NativePomodoroResult; replayed: boolean; projectionReloaded: boolean;
    }> {
        return runStoreCommand(async () => {
            if (this.pomodoroBusy || this.documentBusy || this.ordinaryWrites > 0 || this.baselineReads > 0 || this.prerequisite
                || pendingReceipts.size > 0 || receiptedWritesRunning > 0 || hasPendingDocumentStoreWork()) throw new NativePomodoroTransitionRefusal('notReady', 'Pomodoro storage is busy');
            if (!this.concurrentWritesGuarded || !isNativeRequestReceiptDurable('pomodoroTransition')) throw new NativePomodoroTransitionRefusal('notReady', 'Pomodoro storage requires guarded receipt ownership');
            const plan = validatePreparedNativePomodoroTransition(input); const payload = nativePomodoroReceiptPayload(plan);
            const requestId = plan.request.requestId; const owner = requestPayloads.get(requestId);
            if (owner !== undefined && owner !== payload) throw new Error('Pomodoro receipt identity changed');
            if (this.pomodoroReloadRequired && this.pomodoroReloadRequest !== requestId) throw new Error('Pomodoro canonical reload is required');
            if (this.pomodoroUncertainRequest && this.pomodoroUncertainRequest !== requestId) throw new Error('Earlier Pomodoro outcome is uncertain');
            const projectionBefore = storeData();
            const projectionFrozen = JSON.parse(JSON.stringify(projectionBefore)) as unknown;
            const projectionGeneration = getPersistenceStatus().generation;
            const projectionChangedAt = useTaskStore.getState().lastDataChangeAt;
            this.pomodoroBusy = true; pomodoroStoreWriteFences.add(this); requestPayloads.set(requestId, payload);
            let transaction = false; let commitAttempted = false; let taskAttempted = false; let domainAttempted = false; let proven = false; let replayed = false;
            let result = plan.result;
            let refusal: NativePomodoroTransitionRefusal | null = null;
            const stale = (message: string): never => { refusal = new NativePomodoroTransitionRefusal('staleBaseline', message); throw refusal; };
            try {
                await this.exclusive('savePomodoroTransitionWithReceipt', async () => {
                    try {
                        transaction = true;
                        await this.receiptClient.run('BEGIN IMMEDIATE');
                        this.noteWrite();
                        const saved = await this.readPomodoroProof(plan, payload);
                        if (saved) { result = saved; replayed = true; }
                        else {
                            if (options?.replayOnly === true) throw new Error('Saved Pomodoro receipt is required');
                            const session = await this.readPomodoroCell();
                            if (session.raw !== plan.sessionBefore) stale('Stale Pomodoro session baseline');
                            if (plan.target) {
                                const rows = await this.receiptClient.all<Record<string, string | number | null>>(
                                    `SELECT ${TASK_SQLITE_COLUMNS.join(', ')} FROM tasks WHERE id = ?`, [plan.target.id]);
                                const raw = rows.length === 0 ? null : TASK_SQLITE_COLUMNS.map((name) => rows[0][name]);
                                if (rows.length > 1 || !taskEditValuesEqual(raw, plan.target.row)) stale('Stale Pomodoro task baseline');
                            }
                            if (plan.taskPatch) {
                                const settings = await this.receiptClient.get<{ data: string }>('SELECT data FROM settings WHERE id = 1');
                                let device: unknown;
                                try { device = (JSON.parse(settings?.data ?? '{}') as { deviceId?: unknown }).deviceId; } catch { /* Refuse unreadable identity. */ }
                                if (device !== plan.deviceId) stale('Pomodoro device identity changed');
                                taskAttempted = true; domainAttempted = true;
                                await this.receiptClient.run('UPDATE tasks SET timeSpentMinutes=?, rev=?, revBy=?, updatedAt=? WHERE id=?',
                                    [plan.taskPatch.timeSpentMinutes, plan.taskPatch.rev, plan.taskPatch.revBy, plan.taskPatch.updatedAt, plan.target!.id]);
                            }
                            domainAttempted = true;
                            if (plan.sessionBefore === null) await this.receiptClient.run('INSERT INTO native_pomodoro_session (id,state_json) VALUES (1,?)', [plan.sessionAfter]);
                            else await this.receiptClient.run('UPDATE native_pomodoro_session SET state_json=? WHERE id=1 AND state_json=?', [plan.sessionAfter, plan.sessionBefore]);
                            if ((await this.readPomodoroCell()).raw !== plan.sessionAfter) throw new Error('Pomodoro session readback changed');
                            if (plan.taskPatch) {
                                const rows = await this.receiptClient.all<Record<string, string | number | null>>(
                                    `SELECT ${TASK_SQLITE_COLUMNS.join(', ')} FROM tasks WHERE id = ?`, [plan.target!.id]);
                                const expected = [...plan.target!.row!];
                                for (const [name, value] of Object.entries(plan.taskPatch)) expected[TASK_SQLITE_COLUMNS.indexOf(name)] = value;
                                if (rows.length !== 1 || !taskEditValuesEqual(TASK_SQLITE_COLUMNS.map((name) => rows[0][name]), expected))
                                    throw new Error('Pomodoro task readback changed');
                            }
                            await this.receiptClient.run('INSERT INTO native_request_receipts (request_id, method, reply, saved_at) VALUES (?, ?, ?, ?)',
                                [requestId, payload, JSON.stringify(plan.result), new Date().toISOString()]);
                            if (!await this.readPomodoroProof(plan, payload)) throw new Error('Pomodoro receipt readback changed');
                        }
                        commitAttempted = true; await this.receiptClient.run('COMMIT'); transaction = false; proven = true;
                        this.pomodoroUncertainRequest = null;
                        if (plan.taskPatch) {
                            this.pomodoroReloadRequired = true; this.pomodoroReloadRequest = requestId; this.invalidateWriteBaselineAfterDirectSQL();
                        }
                        durableReceipts?.set(requestId, { fingerprint: payload, reply: result, savedAt: new Date().toISOString() });
                        try { logInfo('Native Pomodoro transition confirmed', { scope: 'storage', force: true,
                            context: { releaseCheck: 'v1.3.5/ios-pomodoro-credit', outcome: 'confirmed' } }); } catch { /* SQL proof survives diagnostic failure. */ }
                    } catch (error) {
                        let rolledBack = false;
                        if (transaction) {
                            try { await this.receiptClient.run('ROLLBACK'); rolledBack = true; } catch { /* The exact receipt remains the only success authority. */ }
                        }
                        if (taskAttempted && transaction && !rolledBack) {
                            this.pomodoroReloadRequired = true; this.pomodoroReloadRequest = requestId; this.invalidateWriteBaselineAfterDirectSQL();
                        }
                        if (transaction && !rolledBack) this.pomodoroUncertainRequest = requestId;
                        // A successful rollback proves failed COMMIT did not change projection. A lost
                        // actual COMMIT reply cannot be mistaken for rollback or receiptless success.
                        if (refusal !== null && error === refusal && !domainAttempted && !commitAttempted && (!transaction || rolledBack)) throw error;
                        throw new Error('Pomodoro transition could not be proven');
                    }
                });
                const projectionReloaded = await this.reloadPomodoroProjection(projectionBefore, projectionFrozen, projectionGeneration, projectionChangedAt);
                return { result: { ...result }, replayed, projectionReloaded };
            } finally {
                this.pomodoroBusy = false;
                if (!this.pomodoroReloadRequired) pomodoroStoreWriteFences.delete(this);
                if (!proven && this.pomodoroUncertainRequest !== requestId && owner === undefined && requestPayloads.get(requestId) === payload)
                    requestPayloads.delete(requestId);
            }
        });
    }

    /** Read-only canonical authority check; does not advance any snapshot or receipt baseline. */
    async hasForeignKeyViolations(): Promise<boolean> {
        return this.exclusive('hasForeignKeyViolations', async () =>
            Boolean(await this.receiptClient.get('SELECT 1 AS present FROM pragma_foreign_key_check LIMIT 1')));
    }

    /** Current durable proof for a prerequisite receipt; never updates the session cache. */
    async readDurableReceipt(requestId: string, payload: string, options?: { committedOnly: true }): Promise<NativeHostResult<unknown | null>> {
        if (this.pomodoroBusy) return { ok: false, error: { code: 'SAVE_FAILED', message: 'Pomodoro storage is busy' } };
        if (!options?.committedOnly) return this.exclusive('readDurableReceipt', () => this.readCurrentReceipt(requestId, fingerprintOf(payload)));
        const unavailable = (): NativeHostResult<never> => ({ ok: false,
            error: { code: 'SAVE_FAILED', message: 'The committed receipt could not be proven' } });
        if (this.documentBusy || this.ordinaryWrites > 0 || this.baselineReads > 0) return unavailable();
        this.documentBusy = true;
        try {
            return await this.exclusive('readDurableReceipt', async () => {
                let opened = false;
                try {
                    // A SELECT inside a failed writer's open transaction is not durable proof.
                    await this.receiptClient.run('BEGIN DEFERRED'); opened = true;
                    const result = await this.readCurrentReceipt(requestId, fingerprintOf(payload));
                    await this.receiptClient.run('ROLLBACK'); opened = false;
                    return result;
                } finally {
                    if (opened) { try { await this.receiptClient.run('ROLLBACK'); } catch { /* Host recovery must reopen the connection. */ } }
                }
            });
        } catch { return unavailable(); }
        finally { this.documentBusy = false; }
    }

    private async readCurrentReceipt(requestId: string, fingerprint: string): Promise<NativeHostResult<unknown | null>> {
        let rows: { request_id: string; method: string; reply: string; saved_at: string }[];
        try {
            rows = await this.receiptClient.all(
                'SELECT request_id, method, reply, saved_at FROM native_request_receipts WHERE request_id = ?', [requestId],
            );
        } catch {
            return { ok: false, error: { code: 'SAVE_FAILED', message: 'The saved prerequisite receipt could not be read' } };
        }
        if (rows.length === 0) return { ok: true, value: null };
        const row = rows[0];
        const changed = (): NativeHostResult<never> => ({ ok: false,
            error: { code: 'STALE_REVISION', message: 'The saved prerequisite receipt changed' } });
        if (rows.length !== 1 || row.request_id !== requestId || row.method !== fingerprint
            || typeof row.saved_at !== 'string' || row.saved_at.length > 40
            || !Number.isFinite(Date.parse(row.saved_at)) || new Date(row.saved_at).toISOString() !== row.saved_at
            || typeof row.reply !== 'string') return changed();
        if (fingerprintCommand(fingerprint) === 'backupDocument' && !validDocumentReceiptRow(row)) return changed();
        if (fingerprintCommand(fingerprint) === 'pomodoroTransition') {
            try { pomodoroReceiptPlan(row); } catch { return changed(); }
        }
        try { return { ok: true, value: JSON.parse(row.reply) as unknown }; } catch { return changed(); }
    }

    /** Optional prerequisite for one owned command; absent for every existing caller. */
    armReceiptPrerequisite(requestId: string, payload: string, originId: string, originPayload: string, reply: unknown): void {
        this.refusePomodoroWriteFence();
        const fingerprint = fingerprintOf(payload);
        if (this.prerequisite && (this.prerequisite.requestId !== requestId || this.prerequisite.fingerprint !== fingerprint))
            throw new Error('Another request owns the receipt prerequisite');
        this.prerequisite = { requestId, fingerprint, originId, originFingerprint: fingerprintOf(originPayload),
            reply: JSON.parse(JSON.stringify(reply)) as unknown };
    }

    clearReceiptPrerequisite(requestId: string, payload: string): void {
        if (this.prerequisite?.requestId === requestId && this.prerequisite.fingerprint === fingerprintOf(payload)) this.prerequisite = null;
    }

    /**
     * Saves an owned document and its exact reply in one transaction, without store generations.
     * Requires a guarded adapter and native receipt boot. Inputs are detached before the first
     * await. The host owns the document/store barrier and must not interleave getData baseline reads.
     * SQL is always the replay authority; the session cache cannot establish a document outcome.
     */
    async saveDocumentWithReceipt(input: NativeDocumentReceiptInput): Promise<NativeDocumentReceiptResult> {
        this.refusePomodoroWriteFence();
        if (this.documentBusy || this.ordinaryWrites > 0 || this.prerequisite
            || pendingReceipts.size > 0 || receiptedWritesRunning > 0 || hasPendingDocumentStoreWork()) {
            throw new Error('Document receipt write is busy');
        }
        if (!this.concurrentWritesGuarded || durableReceipts === null) {
            throw new Error('Document receipt write requires guarded native receipt storage');
        }
        if (!input || !isCanonicalRequestId(input.requestId) || !isDocumentPayload(input.payload)) {
            throw new Error('Invalid document receipt identity');
        }
        const { requestId, payload } = input;
        const { maxLibraryBytes, undoLibraryBytes } = input;
        if (maxLibraryBytes !== undefined && !(Number.isSafeInteger(maxLibraryBytes) && maxLibraryBytes >= 0)
            || undoLibraryBytes !== undefined && !(Number.isSafeInteger(undoLibraryBytes) && undoLibraryBytes >= 0)) {
            throw new Error('Invalid document receipt input');
        }
        const owner = requestPayloads.get(requestId);
        if (owner !== undefined && owner !== payload) throw new Error('Document receipt identity belongs to another action');
        let expectedCurrent: AppData | null;
        let data: AppData;
        let replyJson: string;
        try {
            expectedCurrent = input.owned === true ? input.expectedCurrent : JSON.parse(JSON.stringify(input.expectedCurrent)) as AppData;
            data = input.owned === true ? input.data : JSON.parse(JSON.stringify(input.data)) as AppData;
            replyJson = documentReplyJson(input.reply);
            if (!expectedCurrent || !data) throw new Error('Invalid document');
        } catch {
            throw new Error('Invalid document receipt input');
        }
        this.documentBusy = true;
        requestPayloads.set(requestId, payload);
        let succeeded = false;
        // One lock hold from the receipt lookup through the commit; inside it only …Now bodies run (no re-entry).
        try { return await this.exclusive('saveDocumentWithReceipt', async () => {
            const rows = await this.receiptClient.all<DocumentReceiptRow>(
                'SELECT request_id, method, reply, saved_at FROM native_request_receipts WHERE request_id = ?', [requestId],
            );
            if (rows.length > 0) {
                if (rows.length !== 1 || !validDocumentReceiptRow(rows[0])) throw new Error('Invalid saved document receipt');
                const row = rows[0];
                if (row.request_id !== requestId || row.method !== payload) throw new Error('Document receipt identity changed');
                durableReceipts!.set(requestId, { fingerprint: payload, reply: JSON.parse(row.reply) as unknown, savedAt: row.saved_at });
                succeeded = true;
                return { reply: JSON.parse(row.reply) as unknown, replayed: true };
            }
            // Prior success cannot authorize another application after its durable proof disappears.
            if (durableReceipts!.has(requestId)) throw new Error('Saved document receipt is missing');
            let current: AppData | null = await this.getDataNow();
            // A legacy settings.ai.apiKey left in the row is not part of the baseline (native-backup-document.ts never plans it).
            const withoutKey = (document: AppData): AppData => ({ ...document, settings: stripSensitiveSettings(document.settings) });
            if (!taskEditValuesEqual(withoutKey(current), withoutKey(expectedCurrent!))) throw new Error('Stale document receipt baseline');
            // Both baselines are compared: neither is needed while the document is written.
            current = null; expectedCurrent = null;
            if (input.owned === true) (input as { expectedCurrent: AppData | null }).expectedCurrent = null;
            if (pendingReceipts.size > 0 || receiptedWritesRunning > 0 || hasPendingDocumentStoreWork()) throw new Error('Document receipt write is busy');
            const context = { requestId, payload, data, replyJson, savedAt: new Date().toISOString(), maxLibraryBytes, undoLibraryBytes };
            this.documentReceipt = context;
            try { await this.saveDataNow(data); }
            catch (error) {
                if (error instanceof Error && error.message.startsWith('SQLITE_BUSY:'))
                    throw new Error('Stale document receipt baseline');
                if (error instanceof Error && error.message === UNDO_LIMIT_EXCEEDED) throw error;
                throw new Error('Document receipt persistence failed');
            }
            replyJson = context.replyJson;
            durableReceipts!.set(requestId, { fingerprint: payload, reply: JSON.parse(replyJson) as unknown, savedAt: context.savedAt });
            succeeded = true;
            try {
                logInfo('Native backup document committed', {
                    scope: 'transfer', force: true, context: {
                        releaseCheck: 'v1.3.4/native-backup-document',
                        operation: (JSON.parse(payload) as unknown[])[1], outcome: 'committed',
                    },
                });
            } catch { /* Diagnostics cannot reverse a proven committed outcome. */ }
            return { reply: JSON.parse(replyJson) as unknown, replayed: false };
        }); } finally {
            this.documentReceipt = null;
            this.documentBusy = false;
            if (!succeeded && owner === undefined && requestPayloads.get(requestId) === payload) requestPayloads.delete(requestId);
        }
    }

    /** The library's bytes as SQLite counts them (pages × page size); inside a write transaction, its new pages too. */
    async libraryBytes(): Promise<number> {
        return this.exclusive('libraryBytes', () => this.libraryBytesNow());
    }

    private async libraryBytesNow(): Promise<number> {
        const [pages] = await this.receiptClient.all<{ page_count: number }>('PRAGMA page_count');
        const [size] = await this.receiptClient.all<{ page_size: number }>('PRAGMA page_size');
        return Number(pages?.page_count ?? 0) * Number(size?.page_size ?? 0);
    }

    protected override buildSaveFailureContext(data: AppData, step: string): Record<string, unknown> {
        if (!this.documentBusy) return super.buildSaveFailureContext(data, step);
        const count = (rows: unknown): number => Array.isArray(rows) ? rows.length : 0;
        return { step, tasks: count(data.tasks), projects: count(data.projects),
            sections: count(data.sections), areas: count(data.areas), people: count(data.people) };
    }

    protected override async beforeCommit(write: { data: AppData } | { task: Task }): Promise<void> {
        if (this.documentReceipt) {
            const context = this.documentReceipt;
            if (!('data' in write) || write.data !== context.data || pendingReceipts.size > 0
                || receiptedWritesRunning > 0 || hasPendingDocumentStoreWork())
                throw new Error('Document receipt write ownership changed');
            try {
                // Plain INSERT is deliberate: any in-transaction duplicate rolls back the document.
                await this.receiptClient.run(
                    'INSERT INTO native_request_receipts (request_id, method, reply, saved_at) VALUES (?, ?, ?, ?)',
                    [context.requestId, context.payload, context.replyJson, context.savedAt],
                );
            } catch {
                throw new Error('Document receipt insert failed');
            }
            if (context.maxLibraryBytes !== undefined && await this.libraryBytesNow() > context.maxLibraryBytes) {
                throw new Error(UNDO_LIMIT_EXCEEDED);
            }
            if (context.undoLibraryBytes !== undefined && await this.libraryBytesNow() > context.undoLibraryBytes) {
                const replyJson = JSON.stringify({ ...(JSON.parse(context.replyJson) as object), undo: false });
                try {
                    await this.receiptClient.run('UPDATE native_request_receipts SET reply = ? WHERE request_id = ?', [replyJson, context.requestId]);
                } catch {
                    throw new Error('Document receipt insert failed');
                }
                context.replyJson = replyJson;
            }
            return;
        }
        // A single task's save runs only while no receipt is pending (see saveTask above).
        if (!('data' in write)) return;
        const generation = getSaveSnapshotGeneration(write.data);
        if (generation === undefined) return;
        const savedAt = new Date().toISOString();
        const ids: string[] = [];
        for (const [id, receipt] of pendingReceipts) {
            if (receipt.generation > generation) continue;
            const prerequisite = this.prerequisite;
            if (prerequisite?.requestId === id) {
                if (prerequisite.fingerprint !== receipt.fingerprint) throw new Error('Receipt prerequisite ownership changed');
                const original = await this.readCurrentReceipt(prerequisite.originId, prerequisite.originFingerprint);
                if (!original.ok || original.value === null || !taskEditValuesEqual(original.value, prerequisite.reply))
                    throw new Error('The current durable prerequisite receipt is not proven');
            }
            await this.receiptClient.run(
                'INSERT INTO native_request_receipts (request_id, method, reply, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING',
                [id, receipt.fingerprint, JSON.stringify(receipt.reply ?? null), savedAt],
            );
            ids.push(id);
        }
        this.carried.set(write.data, { ids, savedAt });
    }

    // The public saves keep only their synchronous busy refusal and the bookkeeping after the commit here; their SQL runs in
    // the base class's locked body.
    override async saveData(data: AppData, options?: Parameters<SqliteAdapter['saveData']>[1]): Promise<void> {
        this.refusePomodoroWriteFence();
        if (this.documentBusy) throw new Error('Document receipt write is busy');
        this.ordinaryWrites += 1;
        try {
            await super.saveData(data, options);
            // Committed: those receipts are durable. After a rollback they stay pending for the next save.
            const carried = this.carried.get(data);
            this.carried.delete(data);
            for (const id of carried?.ids ?? []) {
                const receipt = pendingReceipts.get(id);
                if (!receipt) continue;
                pendingReceipts.delete(id);
                durableReceipts?.set(id, { fingerprint: receipt.fingerprint, reply: receipt.reply, savedAt: carried!.savedAt });
                if (this.prerequisite?.requestId === id && this.prerequisite.fingerprint === receipt.fingerprint) this.prerequisite = null;
            }
        } finally { this.ordinaryWrites -= 1; }
    }

    override async saveTask(task: Task): Promise<void> {
        this.refusePomodoroWriteFence();
        if (this.documentBusy) throw new Error('Document receipt write is busy');
        this.ordinaryWrites += 1;
        try { await super.saveTask(task); }
        finally { this.ordinaryWrites -= 1; }
    }

    /** Complete a receipt after its data was already proven saved, without rewriting projected memory. */
    async commitReceiptOnly(requestId: string, payload: string): Promise<boolean> {
        this.refusePomodoroWriteFence();
        if (commandOf(payload) === 'pomodoroTransition') throw new Error('Pomodoro requires its atomic receipt transaction');
        if (this.documentBusy) throw new Error('Document receipt write is busy');
        this.ordinaryWrites += 1;
        try { return await this.exclusive('commitReceiptOnly', () => this.commitReceiptOnlyNow(requestId, payload)); }
        finally { this.ordinaryWrites -= 1; }
    }

    private async commitReceiptOnlyNow(requestId: string, payload: string): Promise<boolean> {
        const pending = pendingReceipts.get(requestId);
        if (!pending || pending.fingerprint !== fingerprintOf(payload)) return false;
        const savedAt = new Date().toISOString();
        await this.receiptClient.run('BEGIN IMMEDIATE');
        this.noteWrite();
        try {
            await this.receiptClient.run(
                'INSERT INTO native_request_receipts (request_id, method, reply, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING',
                [requestId, pending.fingerprint, JSON.stringify(pending.reply ?? null), savedAt],
            );
            await this.receiptClient.run('COMMIT');
        } catch (error) {
            await this.receiptClient.run('ROLLBACK');
            throw error;
        }
        pendingReceipts.delete(requestId);
        durableReceipts?.set(requestId, { fingerprint: pending.fingerprint, reply: pending.reply, savedAt });
        return true;
    }
}

const REQUEST_ID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

type Receipt = {
    payload: string;
    /** Set while the first call runs; concurrent duplicates join it. */
    running: Promise<NativeHostResult<unknown>> | null;
    written: boolean;
    value: unknown;
    saved: boolean;
};

export function createNativeRequestReceipts(options: {
    /** Makes every write so far durable: retries a failed save, then flushes. */
    save: (requestId: string) => Promise<NativeHostResult<null>>;
    /** Scoped commands may prove their data saved and commit a receipt without resaving projected memory. */
    receiptOnly?: (requestId: string, payload: string) => Promise<boolean>;
    /** How many requests to remember; default 50. */
    limit?: number;
}): NativeRequestReceipts {
    const limit = options.limit ?? 50;
    const receipts = new Map<string, Receipt>();
    const durableFor = (payload: string) => isNativeRequestReceiptDurable(commandOf(payload));

    const checkIdentity = (requestId: unknown, payload: string): NativeHostResult<null> => {
        if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
            return { ok: false, error: { code: 'INVALID_INPUT', message: 'A request UUID is required' } };
        }
        const known = receipts.get(requestId);
        const stored = durableReceipts?.get(requestId);
        const owner = requestPayloads.get(requestId);
        const pending = pendingReceipts.get(requestId);
        if ((known && known.payload !== payload) || (stored && stored.fingerprint !== fingerprintOf(payload))
            || (owner !== undefined && owner !== payload) || (pending && pending.fingerprint !== fingerprintOf(payload))) {
            return { ok: false, error: { code: 'INVALID_INPUT', message: 'Request ID already belongs to another action' } };
        }
        return { ok: true, value: null };
    };

    // A receipt's save is a store command for the sync gate (store-write-gate.ts): no sync save and
    // store publish lands inside it. Its write already ran as store actions, which hold the same gate.
    const save = (requestId: string, receipt: Receipt): Promise<NativeHostResult<unknown>> => runStoreCommand(async () => {
        // A successful save stores the whole snapshot, so every write that landed before it
        // began is durable too. A write that lands while it runs waits for its own save.
        const covered = Array.from(receipts.values()).filter((entry) => entry.written);
        const saved = await options.save(requestId);
        if (!saved.ok) return saved;
        // With durable receipts, the reply waits for a commit that carries its receipt. A write
        // whose data a save inside it already committed (a store action that flushes by itself),
        // or that changed nothing, left no snapshot queued: a receipt-only commit follows.
        if (pendingReceipts.has(requestId)) {
            if (options.receiptOnly && durableFor(receipt.payload)) {
                try {
                    if (!await options.receiptOnly(requestId, receipt.payload))
                        return { ok: false, error: { code: 'SAVE_FAILED', message: 'The request receipt is not proven' } };
                } catch {
                    return { ok: false, error: { code: 'SAVE_FAILED', message: 'The request receipt was not saved' } };
                }
            } else {
                await useTaskStore.getState().persistSnapshot();
                const again = await options.save(requestId);
                if (!again.ok) return again;
            }
            if (pendingReceipts.has(requestId)) return { ok: false, error: { code: 'SAVE_FAILED', message: 'The request\'s receipt was not saved' } };
        }
        for (const entry of covered) entry.saved = true;
        return { ok: true, value: receipt.value };
    });

    const makeRoom = (): boolean => {
        if (receipts.size < limit) return true;
        for (const [id, entry] of receipts) {
            if (entry.saved && !entry.running) {
                receipts.delete(id);
                requestPayloads.delete(id);
                return true;
            }
        }
        return false;
    };

    return {
        checkIdentity,
        saved<T>(requestId: unknown, payload: string): NativeHostResult<T> | null {
            const identity = checkIdentity(requestId, payload);
            if (!identity.ok) return identity;
            const local = receipts.get(requestId as string);
            if (local?.saved) return { ok: true, value: local.value as T };
            const stored = durableFor(payload) ? durableReceipts?.get(requestId as string) : undefined;
            return stored ? { ok: true, value: stored.reply as T } : null;
        },
        run<T>(requestId: unknown, payload: string, write: () => Promise<NativeHostResult<T> | NativeUnsavedWrite<T>>): Promise<NativeHostResult<T>> {
            if (pomodoroStoreWriteFences.has(getStorageAdapter() as SqliteAdapter)) return Promise.resolve({ ok: false,
                error: { code: 'ACTION_FAILED', message: 'Pomodoro canonical storage is busy' } });
            if (commandOf(payload) === 'pomodoroTransition') return Promise.resolve({ ok: false,
                error: { code: 'ACTION_FAILED', message: 'Pomodoro requires its atomic receipt transaction' } });
            const identity = checkIdentity(requestId, payload);
            if (!identity.ok) return Promise.resolve(identity);
            // checkIdentity established the UUID shape without reserving it.
            const id = requestId as string;
            const known = receipts.get(id);
            if (known) {
                if (known.running) return known.running as Promise<NativeHostResult<T>>;
                if (known.saved) return Promise.resolve({ ok: true, value: known.value as T });
                const finishing = save(id, known).finally(() => { known.running = null; });
                known.running = finishing;
                return finishing as Promise<NativeHostResult<T>>;
            }
            // Landed and saved before a restart (or evicted since): its first reply, and nothing runs.
            const stored = durableFor(payload) ? durableReceipts?.get(id) : undefined;
            if (stored) {
                return Promise.resolve({ ok: true, value: stored.reply as T });
            }
            if (!makeRoom()) {
                return Promise.resolve({
                    ok: false,
                    error: { code: 'ACTION_FAILED', message: 'Earlier changes are not saved yet. Retry them first.' },
                });
            }
            const receipt: Receipt = { payload, running: null, written: false, value: undefined, saved: false };
            receipts.set(id, receipt);
            requestPayloads.set(id, payload);
            receipt.running = (async (): Promise<NativeHostResult<unknown>> => {
                let outcome: NativeHostResult<T> | NativeUnsavedWrite<T>;
                const durable = durableFor(payload);
                if (durable) receiptedWritesRunning += 1;
                try {
                    try {
                        outcome = await write();
                    } catch (error) {
                        outcome = { ok: false, error: { code: 'ACTION_FAILED', message: error instanceof Error ? error.message : String(error) } };
                    }
                    if (!outcome.ok && outcome.error.code === 'SAVE_FAILED') {
                        // It landed; only its save failed. A retry saves and never writes again.
                        receipt.written = true;
                        receipt.value = 'value' in outcome ? outcome.value : undefined;
                        if (durable) recordPendingReceipt(id, payload, receipt.value);
                        return { ok: false, error: outcome.error };
                    }
                    if (!outcome.ok) {
                        receipts.delete(id);
                        requestPayloads.delete(id);
                        return outcome;
                    }
                    receipt.written = true;
                    receipt.value = outcome.value;
                    // Pending from here: the save below commits it with the snapshot that holds this write.
                    if (durable) recordPendingReceipt(id, payload, receipt.value);
                } finally {
                    if (durable) receiptedWritesRunning -= 1;
                }
                return save(id, receipt);
            })().finally(() => { receipt.running = null; });
            return receipt.running as Promise<NativeHostResult<T>>;
        },
    };
}
