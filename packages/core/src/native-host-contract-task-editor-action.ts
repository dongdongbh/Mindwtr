import { prepareChecklistProjectConversion, type ChecklistProjectConversion } from './checklist-project-conversion';
import type { NativeHostResult } from './native-host-contract';
import { canonicalJSON } from './native-host-contract-task-to-section';
import { isNativeJsonWithinBytes, toChecklist } from './native-host-contract-task-view';
import { requestRowId, settleWrite, taskRevisionOf, type NativeRequestReceipts } from './native-request-receipts';
import { useTaskStore } from './store';
import { isTaskCancelled } from './task-status';


export type NativeTaskEditorSave = {
    base: Record<string, unknown>; patch: Record<string, unknown>; scheduleBase: Record<string, unknown>;
    recurrenceBase?: Record<string, unknown>; checklist?: { base: unknown[]; value: unknown[] };
    attachments?: { base: unknown[]; value: unknown[] };
};
export type NativeTaskEditorAction = { requestId: string; taskId: string; taskRevision: string } & (
    | { kind: 'convertToSection' }
    | { kind: 'promote'; title: string }
    | { kind: 'delete' }
    | { kind: 'deleteUndo'; deleteRequestId: string }
    | { kind: 'cancel' | 'skip'; save: NativeTaskEditorSave }
    | { kind: 'cancelUndo'; cancelRequestId: string }
    | { kind: 'expandChecklist'; title: string }
    | { kind: 'expandChecklistUndo'; expandRequestId: string });
export type NativeTaskEditorActionResult = { kind: NativeTaskEditorAction['kind']; outcome: 'saved' | 'unchanged';
    projectId?: string; sectionId?: string; reused?: boolean;
    cancellation?: { message: string; undoLabel: string; undoEnabled: boolean } };

type Json = Record<string, unknown>;
type Reply = NativeHostResult<unknown>;
type Extra = Omit<NativeTaskEditorActionResult, 'kind' | 'outcome'>;

type Port = string | ((input: Json) => Reply | Promise<Reply>);
type Step = { prepare: Port; commit: Port; request: Json; input?: Json; extra: (result: Json) => Extra };
type Plan = { outcome: 'unchanged'; extra?: Extra } | { refused: NativeHostResult<never> } | Step;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ATTEMPTS = 4;
const SAVE_KEYS = ['base', 'patch', 'scheduleBase', 'recurrenceBase', 'checklist', 'attachments'];

const RECEIPTED = new Set(['promote', 'cancel', 'skip', 'cancelUndo']);
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'TASK_NOT_FOUND' | 'SAVE_FAILED', message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const record = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const keys = (input: Json, names: string[]) => Object.keys(input).length === names.length + 4
    && ['requestId', 'taskId', 'taskRevision', 'kind', ...names].every((name) => Object.prototype.hasOwnProperty.call(input, name));
const otherRequest = (input: Json, value: unknown) => typeof value === 'string' && UUID.test(value) && value !== input.requestId;

const expandedProjectId = (requestId: string) => requestRowId(requestId, 'checklist-project');
const expandedTaskId = (requestId: string, taskId: string, index: number) => requestRowId(requestId, `checklist-project:${taskId}:${index}`);

const valid = (input: unknown): input is NativeTaskEditorAction => {
    if (!record(input) || !isNativeJsonWithinBytes(input) || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || !text(input.taskId, 500) || !text(input.taskRevision, 2000)) return false;
    switch (input.kind) {
        case 'convertToSection': case 'delete': return keys(input, []);
        case 'promote': case 'expandChecklist': return keys(input, ['title']) && typeof input.title === 'string'
            && Boolean(input.title.trim()) && input.title.length <= 100_000;
        case 'expandChecklistUndo': return keys(input, ['expandRequestId']) && otherRequest(input, input.expandRequestId);
        case 'deleteUndo': return keys(input, ['deleteRequestId']) && otherRequest(input, input.deleteRequestId);
        case 'cancelUndo': return keys(input, ['cancelRequestId']) && otherRequest(input, input.cancelRequestId);
        case 'cancel': case 'skip': {
            const save = input.save;
            return keys(input, ['save']) && record(save) && Object.keys(save).every((name) => SAVE_KEYS.includes(name))
                && record(save.base) && record(save.patch) && record(save.scheduleBase);
        }
        default: return false;
    }
};


export function createTaskEditorActionMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    receipts: NativeRequestReceipts;
    contract: () => Json;
    t: () => (key: string) => string;
}) {
    const call = async (name: Port, input: unknown): Promise<Reply> => {
        if (typeof name === 'function') return await name(input as Json);
        const port = deps.contract();
        return await (port[name] as (value: unknown) => Reply | Promise<Reply>).call(port, input);
    };


    const deletes = new Map<string, Json>();
    const cancels = new Map<string, Json>();
    const expansions = new Map<string, ChecklistProjectConversion>();

    const preparedBy = new Map<string, Step & { prepared: Json }>();
    const remember = <T,>(map: Map<string, T>, key: string, value: T) => {
        map.set(key, value);
        if (map.size > 20) map.delete(map.keys().next().value as string);
    };


    const expandRefusal = (key: string): NativeHostResult<never> => fail(key === 'task.expandChecklistConflict' ? 'STALE_REVISION'
        : key === 'task.expandChecklistSaveFailed' ? 'SAVE_FAILED' : 'INVALID_INPUT', deps.t()(key));

    const expandWrite = (undo: boolean) => async ({ prepared }: Json): Promise<Reply> => {
        const command = prepared as ChecklistProjectConversion;
        const store = useTaskStore.getState();
        const written = await (undo ? store.undoChecklistToProject(command) : store.convertChecklistToProject(command));
        if (!written.success) return expandRefusal(written.error ?? 'task.expandChecklistConflict');
        const saved = await deps.save();
        return saved.ok ? { ok: true, value: {} }
            : saved.error.code === 'SAVE_FAILED' ? expandRefusal('task.expandChecklistSaveFailed') : saved;
    };

    const prepareExpansion = (action: { requestId: string; taskId: string; taskRevision: string; title: string }): Reply => {
        const state = useTaskStore.getState();
        const source = state._tasksById.get(action.taskId);
        if (!source || source.deletedAt || source.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
        if (taskRevisionOf(source) !== action.taskRevision) return fail('STALE_REVISION', 'Task changed since it was opened');
        const ids = { project: expandedProjectId(action.requestId),
            tasks: (source.checklist ?? []).map((_, index) => expandedTaskId(action.requestId, action.taskId, index)) };
        const prepared = prepareChecklistProjectConversion(state, source, action.title, ids);
        return prepared.success ? { ok: true, value: { kind: 'prepared', prepared: prepared.command } } : expandRefusal(prepared.error);
    };

    const plan = (action: NativeTaskEditorAction): Plan => {
        const state = useTaskStore.getState();
        const task = state._tasksById.get(action.taskId);
        const live = Boolean(task && !task.deletedAt && !task.purgedAt);
        const { requestId, taskId, taskRevision } = action;
        switch (action.kind) {
            case 'convertToSection': {

                const made = state._sectionsById.get(requestId);
                if (made && (live || made.projectId !== task?.projectId)) {
                    return { refused: fail('INVALID_INPUT', 'Request ID already belongs to another action') };
                }
                if (made) return { outcome: 'unchanged', extra: { projectId: made.projectId, sectionId: made.id } };
                return { prepare: 'prepareTaskToSection', commit: 'commitPreparedTaskToSection', request: { requestId, taskId, taskRevision },
                    extra: (result) => ({ projectId: result.projectId as string, sectionId: result.sectionId as string }) };
            }
            case 'promote':
                return { prepare: 'prepareTaskPromotion', commit: 'commitPreparedTaskPromotion',
                    request: { requestId, taskId, taskRevision, title: action.title },
                    extra: (result) => ({ projectId: result.id as string, reused: result.reused as boolean }) };
            case 'delete':
                if (!live) return { outcome: 'unchanged' };
                return { prepare: 'prepareTaskDelete', commit: 'commitPreparedTaskDelete', request: { requestId, taskId, taskRevision },
                    extra: () => ({}) };
            case 'deleteUndo': {
                if (live) return { outcome: 'unchanged' };
                const deletion = deletes.get(action.deleteRequestId);
                if (!deletion || (deletion.request as Json).taskId !== taskId) return { refused: fail('STALE_REVISION', 'The Delete can no longer be undone') };
                const request = { requestId, deleteRequestId: action.deleteRequestId };
                return { prepare: 'prepareTaskDeleteUndo', commit: 'commitPreparedTaskDeleteUndo', request,
                    input: { request, delete: deletion }, extra: () => ({}) };
            }
            case 'cancel': case 'skip': {
                const { checklist, ...save } = action.save;
                const stored = toChecklist(task?.checklist);
                const request = { ...save, id: taskId, requestId, checklist: checklist ?? { base: stored, value: stored }, intent: action.kind };
                return { prepare: 'prepareTaskChecklistSave', commit: 'commitPreparedTaskChecklistWrite', request,
                    extra: (result) => {
                        const cancellation = result.cancellation as Json | undefined;
                        return cancellation ? { cancellation: { message: cancellation.message as string,
                            undoLabel: cancellation.undoLabel as string, undoEnabled: cancellation.undoEnabled as boolean } } : {};
                    } };
            }
            case 'cancelUndo': {
                if (live && !isTaskCancelled(task!)) return { outcome: 'unchanged' };
                const cancel = cancels.get(action.cancelRequestId);
                if (!cancel || (cancel.request as Json).id !== taskId) return { refused: fail('STALE_REVISION', 'The cancellation can no longer be undone') };
                const request = { requestId, cancelRequestId: action.cancelRequestId };
                return { prepare: 'prepareTaskCancellationUndo', commit: 'commitPreparedTaskCancellationUndo', request,
                    input: { request, cancel }, extra: () => ({}) };
            }
            case 'expandChecklist': case 'expandChecklistUndo': {
                const expandRequestId = action.kind === 'expandChecklist' ? requestId : action.expandRequestId;
                const projectId = expandedProjectId(expandRequestId);
                const made = state._projectsById.get(projectId);

                const ours = Boolean(made) && state._tasksById.has(expandedTaskId(expandRequestId, taskId, 0));
                if (action.kind === 'expandChecklist') {

                    if (made && (!ours || made.title !== action.title.trim())) return { refused: fail('INVALID_INPUT', 'Request ID already belongs to another action') };
                    if (made) return !made.deletedAt && !live ? { outcome: 'unchanged', extra: { projectId } }
                        : { refused: fail('STALE_REVISION', 'Task changed since it was opened') };
                    const request = { requestId, taskId, taskRevision, title: action.title };
                    return { prepare: () => prepareExpansion(request), commit: expandWrite(false), request, extra: () => ({ projectId }) };
                }


                if (ours && made!.deletedAt && live && state._tasksById.get(expandedTaskId(expandRequestId, taskId, 0))?.deletedAt) return { outcome: 'unchanged' };
                const command = expansions.get(expandRequestId);
                if (!command || command.source.id !== taskId) return { refused: fail('STALE_REVISION', 'The project can no longer be undone') };
                return { prepare: () => ({ ok: true, value: { kind: 'prepared', prepared: command } }), commit: expandWrite(true),
                    request: { requestId, expandRequestId }, extra: () => ({}) };
            }
        }
    };

    const run = async (action: NativeTaskEditorAction): Promise<NativeHostResult<NativeTaskEditorActionResult>
        | { ok: false; error: { code: 'SAVE_FAILED'; message: string }; value: NativeTaskEditorActionResult }> => {
        const answer = (outcome: 'saved' | 'unchanged', extra: Extra = {}): NativeTaskEditorActionResult => ({ kind: action.kind, outcome, ...extra });
        const commit = async (entry: Step & { prepared: Json }) => {
            const committed = await call(entry.commit, { request: entry.request, prepared: entry.prepared });
            const landed = committed.ok || committed.error.code === 'SAVE_FAILED';
            if (landed && action.kind === 'delete') remember(deletes, action.requestId, { request: entry.request, prepared: entry.prepared });
            if (landed && action.kind === 'cancel') remember(cancels, action.requestId, { request: entry.request, prepared: entry.prepared });
            if (landed && action.kind === 'expandChecklist') remember(expansions, action.requestId, entry.prepared as ChecklistProjectConversion);

            if (!RECEIPTED.has(action.kind) && landed && !committed.ok) remember(preparedBy, action.requestId, entry);
            else preparedBy.delete(action.requestId);
            if (committed.ok) return { ok: true as const, value: answer('saved', entry.extra(committed.value as Json)) };
            return committed.error.code === 'SAVE_FAILED'
                ? { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: committed.error.message },
                    value: answer('saved', entry.extra(entry.prepared.result as Json)) }
                : committed as NativeHostResult<never>;
        };
        const retried = preparedBy.get(action.requestId);
        if (retried) return commit(retried);
        let stale = 'Task changed; the action could not be applied';
        for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
            const step = plan(action);
            if ('refused' in step) return step.refused;

            if ('outcome' in step) return settleWrite(await deps.save(), answer('unchanged', step.extra));
            const prepared = await call(step.prepare, step.input ?? step.request) as NativeHostResult<Json>;
            if (!prepared.ok) {
                if (prepared.error.code !== 'STALE_REVISION') return prepared;
                stale = prepared.error.message;
                continue;
            }
            if (prepared.value.kind !== 'prepared') return settleWrite(await deps.save(), answer('unchanged'));
            const committed = await commit({ ...step, prepared: prepared.value.prepared as Json });
            if (committed.ok || committed.error.code !== 'STALE_REVISION') return committed;
            stale = committed.error.message;
        }
        return fail('STALE_REVISION', stale);
    };

    return {
        async runTaskEditorAction(input: NativeTaskEditorAction): Promise<NativeHostResult<NativeTaskEditorActionResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!valid(input)) return fail('INVALID_INPUT', 'A bounded task editor action is required');

            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return { ok: false, error: { code: 'SAVE_FAILED', message: error instanceof Error ? error.message : String(error) } }; }
            if (!RECEIPTED.has(input.kind)) {
                const result = await run(input);
                return result.ok ? result : { ok: false, error: result.error };
            }
            return deps.receipts.run(input.requestId, canonicalJSON(['taskEditorAction', input]), () => run(input));
        },
    };
}
