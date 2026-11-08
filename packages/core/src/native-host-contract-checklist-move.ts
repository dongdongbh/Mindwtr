import { tFallback } from './i18n';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import { resolveQuickCaptureDefaultAreaId } from './quick-capture-model';
import { useTaskStore } from './store';
import { canMoveTaskToChecklist, checklistItemIdForMovedTask, getChecklistMoveTargets, isChecklistMoveTarget } from './task-checklist-move';

type Translate = (key: string) => string;

export type NativeChecklistMoveTargets = {
    eligible: boolean;
    title: string;
    searchLabel: string;
    cancelLabel: string;
    noMatches: string | null;
    rows: Array<{ id: string; title: string; progress: string | null }>;
};

type MoveRequest = { requestId: string; sourceId: string; targetId: string };

const id = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 500;

export function createChecklistMoveMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => Translate;
    requestIdPattern: RegExp;
}) {
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
    const movable = (sourceId: string): boolean => {
        const state = useTaskStore.getState();
        const source = state._tasksById.get(sourceId);
        return Boolean(source) && canMoveTaskToChecklist(source!, resolveQuickCaptureDefaultAreaId(state.settings, state.areas));
    };
    const undoable = ({ sourceId, targetId }: MoveRequest): boolean => {
        const state = useTaskStore.getState();
        const source = state._tasksById.get(sourceId);
        const itemId = checklistItemIdForMovedTask(sourceId);
        return Boolean(source?.deletedAt && !source.purgedAt)
            || Boolean(state._tasksById.get(targetId)?.checklist?.some((item) => item.id === itemId));
    };
    const readRequest = (input: unknown): MoveRequest | null => (
        isObjectRecord(input) && typeof input.requestId === 'string' && deps.requestIdPattern.test(input.requestId) && id(input.sourceId) && id(input.targetId)
            ? { requestId: input.requestId, sourceId: input.sourceId, targetId: input.targetId } : null
    );

    return {
        getChecklistMoveTargets(input: { sourceId: string; query: string; eligibleOnly?: boolean }): NativeHostResult<NativeChecklistMoveTargets> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !id(input.sourceId) || typeof input.query !== 'string') return fail('INVALID_INPUT', 'A source task and a search text are required');
            const t = deps.t();
            const listed = input.eligibleOnly === true ? [] : getChecklistMoveTargets(useTaskStore.getState().tasks, input.sourceId, input.query);
            const rows = listed.map((task) => ({
                id: task.id,
                title: task.title,
                progress: task.checklist?.length ? `${task.checklist.filter((item) => item.isCompleted).length}/${task.checklist.length}` : null,
            }));
            return { ok: true, value: {
                eligible: movable(input.sourceId),
                title: tFallback(t, 'task.addToChecklist', 'Add to checklist…'),
                searchLabel: tFallback(t, 'common.search', 'Search'),
                cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
                noMatches: rows.length === 0 && input.eligibleOnly !== true ? tFallback(t, 'common.noMatches', 'No matches') : null,
                rows,
            } };
        },

        async moveTaskToChecklist(input: MoveRequest): Promise<NativeHostResult<{ id: string; toast: { message: string; undoLabel: string } }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A request UUID, a source task and a target task are required');
            const { requestId, ...rest } = request;
            return receipts.run<{ id: string; toast: { message: string; undoLabel: string } }>(requestId, JSON.stringify(['taskChecklistMove', rest]), async () => {
                const t = deps.t();
                const result = { id: request.targetId, toast: { message: tFallback(t, 'task.addedToChecklist', 'Added to checklist'), undoLabel: tFallback(t, 'common.undo', 'Undo') } };
                const target = useTaskStore.getState()._tasksById.get(request.targetId);
                if (!movable(request.sourceId) || !target || !isChecklistMoveTarget(target, request.sourceId)) {
                    return fail('STALE_REVISION', 'Task not found');
                }
                const written = await runStoreWrite(() => useTaskStore.getState().moveTaskToChecklist(request.sourceId, request.targetId));
                return settleWrite(written, result);
            });
        },

        async undoMoveTaskToChecklist(input: MoveRequest): Promise<NativeHostResult<{ id: string }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A request UUID, a source task and a target task are required');
            const { requestId, ...rest } = request;
            return receipts.run<{ id: string }>(requestId, JSON.stringify(['taskChecklistMoveUndo', rest]), async () => {
                if (!undoable(request)) return fail('STALE_REVISION', 'Task not found');
                const written = await runStoreWrite(() => useTaskStore.getState().undoMoveTaskToChecklist(request.sourceId, request.targetId));
                return settleWrite(written, { id: request.sourceId });
            });
        },
    };
}
