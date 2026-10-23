/** The native Mind Sweep reads and their durable Inbox writes. */
import { resolveDefaultNewTaskAreaId } from './area-utils';
import { logInfo } from './logger';
import { MIND_SWEEP_GROUPS, getMindSweepGroups, type MindSweepScope } from './mind-sweep';
import {
    buildMindSweepView,
    INITIAL_MIND_SWEEP_STATE,
    MIND_SWEEP_INTRO_STEP,
    MIND_SWEEP_SCOPES,
    type MindSweepState,
    type MindSweepView,
} from './mind-sweep-view-model';
import { NATIVE_HOST_CONTRACT_VERSION, NATIVE_HOST_MAX_WINDOW, type NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord, isPaging, isText, page, paramsKey } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import { useTaskStore } from './store';
import { ensureDeviceId } from './store-helpers';
import { toStableSyncJson } from './sync-helpers';
import { buildNewTask } from './task-creation';
import { taskToSqliteRow } from './task-sync-schema';
import type { AppSettings, Area, Task } from './types';

export type NativeMindSweepView = Omit<MindSweepView, 'group'> & {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    /** Covers the language, the day and minute, and the state, draft and failure sent. */
    revision: string;
    /** The scope and step as read. The host keeps its captures and sends them back in `state`. */
    state: Pick<MindSweepState, 'scope' | 'step'>;
    group: (Omit<NonNullable<MindSweepView['group']>, 'captured'> & {
        /** `items` is the requested window of this cue list's captures. */
        captured: { label: string; total: number; items: string[] } | null;
    }) | null;
};

type Translate = (key: string) => string;
type MindSweepDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => Translate;
    /** Data plus display revision: the language and the minute. */
    revision: (now: Date) => string;
};

export type NativeMindSweepRequest = { requestId: string; title: string };
export type NativeMindSweepResult = { taskId: string; title: string };
export type NativePreparedMindSweepAdd = {
    version: 1;
    request: NativeMindSweepRequest;
    task: Task;
    preparedAt: string;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    effectiveDefaultAreaId: string | null;
    result: NativeMindSweepResult;
};
export type NativeMindSweepGuide = {
    scope: MindSweepScope;
    scopes: { value: MindSweepScope; label: string }[];
    groups: { id: string; title: string; prompts: string[] }[];
    text: {
        title: string; intro: string; scopeLabel: string; start: string; close: string;
        inputPlaceholder: string; add: string; back: string; next: string; progressTemplate: string;
        groupCaptured: string; summaryTitle: string; summaryCountTemplate: string;
        summaryEmpty: string; summaryHint: string; finish: string; addFailed: string;
    };
};

const TITLE_LIMIT = 10_000;
const MAX_PREPARED_TITLE = 100_000;
const CAPTURE_LIMIT = 10_000;
const MAX_JOURNAL = 2_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATE_KEYS = new Set(['scope', 'step', 'captured']);
const GROUP_IDS = new Set(MIND_SWEEP_GROUPS.map((group) => group.id));
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const same = (left: unknown, right: unknown) => toStableSyncJson(left) === toStableSyncJson(right);
const instant = (value: unknown): value is string => typeof value === 'string' && INSTANT.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const optionalId = (value: unknown): value is string | null => value === null
    || (typeof value === 'string' && value.length > 0 && value.length <= 500 && value.trim() === value);
const request = (value: unknown): NativeMindSweepRequest | null => record(value)
    && exact(value, ['requestId', 'title']) && typeof value.requestId === 'string' && UUID.test(value.requestId)
    && typeof value.title === 'string' && value.title.length <= MAX_PREPARED_TITLE && Boolean(value.title.trim())
    ? { requestId: value.requestId, title: value.title } : null;

/** The host's screen state, completed from the first screen's; null when the screen cannot be in it. */
function readState(value: unknown): MindSweepState | null {
    if (value === undefined) return INITIAL_MIND_SWEEP_STATE;
    if (!isObjectRecord(value) || Object.keys(value).some((key) => !STATE_KEYS.has(key))) return null;
    const scope = value.scope ?? INITIAL_MIND_SWEEP_STATE.scope;
    if (!MIND_SWEEP_SCOPES.includes(scope as MindSweepState['scope'])) return null;
    const step = value.step ?? INITIAL_MIND_SWEEP_STATE.step;
    const groups = getMindSweepGroups(scope as MindSweepState['scope']);
    if (!Number.isSafeInteger(step) || (step as number) < MIND_SWEEP_INTRO_STEP || (step as number) > groups.length) return null;
    const captured = value.captured ?? {};
    if (!isObjectRecord(captured)) return null;
    let count = 0;
    for (const [groupId, items] of Object.entries(captured)) {
        if (!GROUP_IDS.has(groupId) || !Array.isArray(items) || !items.every((item) => isText(item, TITLE_LIMIT) && item.trim().length > 0)) return null;
        count += items.length;
    }
    if (count > CAPTURE_LIMIT) return null;
    return { scope: scope as MindSweepState['scope'], step: step as number, captured: captured as Record<string, string[]> };
}

/**
 * Only these factory dependencies influence an unstarred, unprojected Inbox row. The
 * reminder default is read back from the frozen row: a new row inherits it, so its
 * suppression flag records it, and the journal keeps its version-1 shape.
 */
const derive = (input: NativeMindSweepRequest, preparedAt: string, deviceId: string, defaultAreaId: string | null,
    suppressMindwtrReminders: unknown) => {
    const settings = { gtd: defaultAreaId ? { defaultAreaMode: 'fixed', defaultAreaId } : { defaultAreaMode: 'none' },
        taskReminderDefault: suppressMindwtrReminders === true ? 'skip' : 'send' } as AppSettings;
    const areas = defaultAreaId ? [{ id: defaultAreaId }] as Area[] : [];
    return buildNewTask({
        title: input.title.trim(), initialTaskProps: { status: 'inbox' }, id: input.requestId,
        now: preparedAt, deviceId,
        state: { settings, _allProjects: [], _allSections: [], _allAreas: areas },
        tasks: [], focusedCount: 0, focusTaskLimit: 1, projectOrderReserver: () => undefined,
    });
};

/** Pure journal authority, including terminal-success cleanup before SQLite opens. */
export const validatePreparedMindSweepAdd = (input: unknown): NativeHostResult<NativeMindSweepResult> => {
    try {
        if (!record(input) || !exact(input, ['request', 'prepared']) || !record(input.prepared)) {
            return fail('INVALID_INPUT', 'Malformed prepared Mind Sweep add');
        }
        const bound = request(input.request);
        const prepared = input.prepared as NativePreparedMindSweepAdd;
        if (!bound || !exact(input.prepared, ['version', 'request', 'task', 'preparedAt', 'deviceIdBefore',
            'deviceIdToInitialize', 'effectiveDefaultAreaId', 'result']) || prepared.version !== 1
            || !same(bound, prepared.request) || !instant(prepared.preparedAt)
            || !optionalId(prepared.deviceIdBefore) || !optionalId(prepared.deviceIdToInitialize)
            || !optionalId(prepared.effectiveDefaultAreaId)
            || (prepared.deviceIdBefore === null ? !prepared.deviceIdToInitialize || !UUID.test(prepared.deviceIdToInitialize)
                : prepared.deviceIdToInitialize !== null)
            || !record(prepared.task) || !record(prepared.result)
            || !exact(prepared.result, ['taskId', 'title'])
            || prepared.result.taskId !== bound.requestId || prepared.result.title !== bound.title.trim()
            || JSON.stringify(input).length > MAX_JOURNAL) return fail('INVALID_INPUT', 'Malformed prepared Mind Sweep add');
        const built = derive(bound, prepared.preparedAt, prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!,
            prepared.effectiveDefaultAreaId, prepared.task.suppressMindwtrReminders);
        if (!built.ok || !same(built.task, prepared.task)
            || !same(taskToSqliteRow(built.task), taskToSqliteRow(prepared.task))) {
            return fail('INVALID_INPUT', 'Prepared Mind Sweep task does not match the literal request');
        }
        return { ok: true, value: prepared.result };
    } catch {
        return fail('INVALID_INPUT', 'Malformed prepared Mind Sweep add');
    }
};

export function createMindSweepMethods(deps: MindSweepDeps) {
    const receipts = createNativeRequestReceipts({
        save: async () => {
            if (useTaskStore.getState().persistenceFailure) {
                try {
                    await useTaskStore.getState().retryPersistence();
                } catch (error) {
                    return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
                }
            }
            return deps.save();
        },
    });

    return {
        /** The Android Mind Sweep screen for the host's state, draft and last add. */
        getMindSweep(input: {
            state?: Partial<MindSweepState>;
            draft?: string;
            addFailed?: boolean;
            offset?: number;
            limit?: number;
            revision?: string;
        } = {}): NativeHostResult<NativeMindSweepView> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input)) return fail('INVALID_INPUT', 'A Mind Sweep read is an object');
            const state = readState(input.state);
            const draft = input.draft ?? '';
            const addFailed = input.addFailed ?? false;
            const window = { offset: input.offset ?? 0, limit: input.limit ?? NATIVE_HOST_MAX_WINDOW, revision: input.revision };
            if (!state || !isText(draft, TITLE_LIMIT) || typeof addFailed !== 'boolean' || !isPaging(window)) {
                return fail('INVALID_INPUT', 'A state the screen can be in, a draft, an add failure flag and a window of at most 100 captures are required');
            }
            const now = new Date();
            const revision = `${deps.revision(now)}:${paramsKey([state, draft, addFailed])}`;
            if (window.revision !== undefined && window.revision !== revision) {
                return fail('STALE_REVISION', 'The screen changed; read it again from offset zero');
            }
            const view = buildMindSweepView({ state, draft, addFailed, t: deps.t() });
            return { ok: true, value: {
                ...view,
                version: NATIVE_HOST_CONTRACT_VERSION,
                revision,
                state: { scope: state.scope, step: state.step },
                group: view.group && {
                    ...view.group,
                    captured: view.group.captured && {
                        label: view.group.captured.label,
                        total: view.group.captured.items.length,
                        items: page(view.group.captured.items, window),
                    },
                },
            } };
        },

        /** Android's receipt-based add; the request UUID is also the created task ID. */
        async addMindSweepItem(input: { requestId: string; title: string }): Promise<NativeHostResult<{ id: string; title: string }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.title, TITLE_LIMIT) || !input.title.trim()) {
                return fail('INVALID_INPUT', 'A request UUID and a title are required');
            }
            const title = input.title.trim();
            const requestId = input.requestId;
            return receipts.run(requestId, JSON.stringify(['mindSweepAdd', title]), async () => {
                const existing = useTaskStore.getState()._tasksById.get(requestId.toLowerCase());
                if (existing) {
                    return existing.title === title
                        ? { ok: true, value: { id: existing.id, title } }
                        : fail('INVALID_INPUT', 'Request ID already belongs to another capture');
                }
                const added = { id: requestId.toLowerCase() };
                const written = await runStoreWrite(async () => {
                    const result = await useTaskStore.getState().addTask(title, { status: 'inbox' }, { captureId: requestId });
                    if (result.success && result.id) added.id = result.id;
                    return result;
                });
                return settleWrite(written, { id: added.id, title });
            });
        },

        /** iOS's static guide; Swift owns the open screen state. */
        getMindSweepGuide(input: { scope: MindSweepScope }): NativeHostResult<NativeMindSweepGuide> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!record(input) || !exact(input, ['scope']) || !['all', 'personal', 'work'].includes(input.scope)) {
                return fail('INVALID_INPUT', 'A Mind Sweep scope is required');
            }
            const t = deps.t();
            const scopes: MindSweepScope[] = ['all', 'personal', 'work'];
            const labels = ['mindSweep.scopeAll', 'mindSweep.scopePersonal', 'mindSweep.scopeWork'];
            return { ok: true, value: {
                scope: input.scope,
                scopes: scopes.map((value, index) => ({ value, label: t(labels[index]) })),
                groups: getMindSweepGroups(input.scope).map((group) => ({ id: group.id,
                    title: t(group.titleKey), prompts: group.promptKeys.map(t) })),
                text: {
                    title: t('mindSweep.title'), intro: t('mindSweep.intro'), scopeLabel: t('mindSweep.scopeLabel'),
                    start: t('mindSweep.start'), close: t('mindSweep.close'), inputPlaceholder: t('mindSweep.inputPlaceholder'),
                    add: t('mindSweep.add'), back: t('mindSweep.back'), next: t('mindSweep.next'),
                    progressTemplate: t('mindSweep.progress'), groupCaptured: t('mindSweep.groupCaptured'),
                    summaryTitle: t('mindSweep.summaryTitle'), summaryCountTemplate: t('mindSweep.summaryCount'),
                    summaryEmpty: t('mindSweep.summaryEmpty'), summaryHint: t('mindSweep.summaryHint'),
                    finish: t('mindSweep.finish'), addFailed: t('task.addFailed'),
                },
            } };
        },

        prepareMindSweepAdd(input: NativeMindSweepRequest): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedMindSweepAdd }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const bound = request(input);
            if (!bound) return fail('INVALID_INPUT', 'A literal title and lowercase request UUID are required');
            const state = useTaskStore.getState();
            const preparedAt = new Date().toISOString();
            const deviceIdBefore = state.settings.deviceId || null;
            const device = ensureDeviceId(state.settings);
            const effectiveDefaultAreaId = resolveDefaultNewTaskAreaId(state.settings, state._allAreas) ?? null;
            const built = buildNewTask({
                title: bound.title.trim(), initialTaskProps: { status: 'inbox' }, id: bound.requestId,
                now: preparedAt, deviceId: device.deviceId, state,
                tasks: [], focusedCount: 0, focusTaskLimit: 1, projectOrderReserver: () => undefined,
            });
            if (!built.ok) return fail('INVALID_INPUT', built.error);
            const prepared: NativePreparedMindSweepAdd = {
                version: 1, request: bound, task: built.task, preparedAt, deviceIdBefore,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                effectiveDefaultAreaId,
                result: { taskId: bound.requestId, title: bound.title.trim() },
            };
            const detached = JSON.parse(JSON.stringify(prepared)) as NativePreparedMindSweepAdd;
            return validatePreparedMindSweepAdd({ request: bound, prepared: detached }).ok
                ? { ok: true, value: { kind: 'prepared', prepared: detached } }
                : fail('INVALID_INPUT', 'Mind Sweep could not produce a valid prepared journal');
        },

        validatePreparedMindSweepAdd,

        async commitPreparedMindSweepAdd(input: { request: NativeMindSweepRequest; prepared: NativePreparedMindSweepAdd }): Promise<NativeHostResult<NativeMindSweepResult>> {
            const authority = validatePreparedMindSweepAdd(input);
            if (!authority.ok) return authority;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const { prepared } = input;
            const state = useTaskStore.getState();
            const existing = state._allTasks.find((task) => task.id === prepared.task.id);
            const receipt = existing && !existing.deletedAt && !existing.purgedAt
                && same(taskToSqliteRow(existing), taskToSqliteRow(prepared.task));
            if (existing && !receipt) return fail('STALE_REVISION', 'Mind Sweep request ID is occupied by another task');
            if (!receipt && ((state.settings.deviceId || null) !== prepared.deviceIdBefore
                || (resolveDefaultNewTaskAreaId(state.settings, state._allAreas) ?? null) !== prepared.effectiveDefaultAreaId)) {
                return fail('STALE_REVISION', 'Mind Sweep creation defaults changed before publication');
            }
            const applied = await state.commitPreparedCapture({ task: prepared.task, project: null,
                deviceIdToInitialize: prepared.deviceIdToInitialize });
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Mind Sweep creation conflicts with current data');
            if (useTaskStore.getState().persistenceFailure) {
                try { await useTaskStore.getState().retryPersistence(); }
                catch { return fail('SAVE_FAILED', 'Pending Mind Sweep task is not saved'); }
            }
            const saved = await deps.save();
            if (!saved.ok) return saved;
            try { logInfo('Native iOS Mind Sweep task saved', { scope: 'native-host', category: 'storage',
                context: { releaseCheck: 'v1.3.3/native-ios-mind-sweep', outcome: receipt ? 'replayed' : 'applied' } }); }
            catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            return authority;
        },
    };
}
