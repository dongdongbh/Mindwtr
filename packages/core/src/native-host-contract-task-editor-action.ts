import type { NativeHostResult } from './native-host-contract';
import { canonicalJSON } from './native-host-contract-task-to-section';
import { isNativeJsonWithinBytes, toChecklist } from './native-host-contract-task-view';
import { settleWrite, type NativeRequestReceipts } from './native-request-receipts';
import { useTaskStore } from './store';
import { isTaskCancelled } from './task-status';

/**
 * One editor "..." menu action as the user chose it, under the request UUID the native host journals before anything else
 * runs (Android's `taskEditorAction` Menu command). [taskRevision] is the saved task the editor showed. Cancel and Skip send
 * the editor's draft save (RN saves the draft with them); their bases, not the revision, find a change since.
 */
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
    | { kind: 'cancelUndo'; cancelRequestId: string });
export type NativeTaskEditorActionResult = { kind: NativeTaskEditorAction['kind']; outcome: 'saved' | 'unchanged';
    projectId?: string; sectionId?: string; reused?: boolean;
    cancellation?: { message: string; undoLabel: string; undoEnabled: boolean } };

type Json = Record<string, unknown>;
type Reply = NativeHostResult<unknown>;
type Extra = Omit<NativeTaskEditorActionResult, 'kind' | 'outcome'>;
/** A core prepared command: its prepare and commit methods on the contract, and the reply fields its result gives. */
type Step = { prepare: string; commit: string; request: Json; input?: Json; extra: (result: Json) => Extra };
type Plan = { outcome: 'unchanged'; extra?: Extra } | { refused: NativeHostResult<never> } | Step;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ATTEMPTS = 4;
const SAVE_KEYS = ['base', 'patch', 'scheduleBase', 'recurrenceBase', 'checklist', 'attachments'];
/** The commands whose core commit keeps no receipt: the whole action runs under one, so a replay answers its first reply. */
const RECEIPTED = new Set(['promote', 'cancel', 'skip', 'cancelUndo']);
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION', message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const record = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const keys = (input: Json, names: string[]) => Object.keys(input).length === names.length + 4
    && ['requestId', 'taskId', 'taskRevision', 'kind', ...names].every((name) => Object.prototype.hasOwnProperty.call(input, name));
const otherRequest = (input: Json, value: unknown) => typeof value === 'string' && UUID.test(value) && value !== input.requestId;

const valid = (input: unknown): input is NativeTaskEditorAction => {
    if (!record(input) || !isNativeJsonWithinBytes(input) || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || !text(input.taskId, 500) || !text(input.taskRevision, 2000)) return false;
    switch (input.kind) {
        case 'convertToSection': case 'delete': return keys(input, []);
        case 'promote': return keys(input, ['title']) && typeof input.title === 'string' && Boolean(input.title.trim())
            && input.title.length <= 100_000;
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

/**
 * The task editor's "..." menu writes as one journaled command (Android's `taskEditorAction`): core's own preparation and
 * prepared commit for the kind, inside one call, so the native journal holds only the user's intent and its boot replay or
 * retry redoes the whole action. A sync landing between the steps (STALE_REVISION) prepares again; a failed save keeps what
 * landed and the retry only saves it. A replay of an action that landed answers its first reply and writes nothing: Convert to
 * section and Delete by their target state (the section named by the request, the task in Trash), the others by a receipt
 * kept on disk with the data on Android. That receipt commits in its own transaction right after the write: a process death
 * between the two leaves a boot replay with no receipt, which the write's own checks refuse (Create project STALE_REVISION,
 * Cancel and Skip INVALID_INPUT) without writing twice. Convert to section has no such gap.
 */
export function createTaskEditorActionMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    receipts: NativeRequestReceipts;
    contract: () => Json;
}) {
    const call = async (name: string, input: unknown): Promise<Reply> => {
        const port = deps.contract();
        return await (port[name] as (value: unknown) => Reply | Promise<Reply>).call(port, input);
    };
    // The Deletes and Cancels this process confirmed, by request UUID: their Undo needs the confirmed envelope. RN's Undo lives
    // as long as its toast and is gone after a restart; these are gone after a restart too.
    const deletes = new Map<string, Json>();
    const cancels = new Map<string, Json>();
    // The envelope a Convert to section or Delete prepared while its save is owed: the retry commits that same envelope.
    const preparedBy = new Map<string, Step & { prepared: Json }>();
    const remember = <T,>(map: Map<string, T>, key: string, value: T) => {
        map.set(key, value);
        if (map.size > 20) map.delete(map.keys().next().value as string);
    };

    const plan = (action: NativeTaskEditorAction): Plan => {
        const state = useTaskStore.getState();
        const task = state._tasksById.get(action.taskId);
        const live = Boolean(task && !task.deletedAt && !task.purgedAt);
        const { requestId, taskId, taskRevision } = action;
        switch (action.kind) {
            case 'convertToSection': {
                // The section takes the request UUID as its id: once it exists, the conversion landed.
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
            // Only a save owed keeps the envelope: once settled, a replay is a plan that finds the work done.
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
            // A failed save still carries the answer, so the receipt's retry replies in full.
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
            // A save that failed before is finished first, so `unchanged` never hides a lost write.
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
