import { tFallback } from './i18n';
import { createMarkdownLinkLookup, resolveMarkdownInline, type MarkdownInline } from './markdown-blocks';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite, taskRevisionOf } from './native-request-receipts';
import { useTaskStore } from './store';
import { applyRowChecklistEdit } from './task-row-checklist';
import type { ChecklistItem, Task } from './types';

type Translate = (key: string) => string;

export type NativeTaskRowChecklist = {
    taskId: string;
    taskRevision: string;
    readOnly: boolean;
    progressLabel: string;
    addLabel: string;
    markdownLabels: { deletedTask: string; deletedProject: string };
    items: Array<{ id: string; title: string; completed: boolean; inline: MarkdownInline[] }>;
};

export type NativeTaskRowChecklistEdit = {
    requestId: string;
    taskId: string;
    completed: Record<string, boolean>;
    added: Array<{ id: string; title: string }>;
};

const id = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 500;

const readCompleted = (value: unknown): Record<string, boolean> | null => {
    if (!isObjectRecord(value)) return null;
    const entries = Object.entries(value);
    return entries.length <= 1000 && entries.every(([key, done]) => id(key) && typeof done === 'boolean') ? Object.fromEntries(entries) as Record<string, boolean> : null;
};

const readAdded = (value: unknown): ChecklistItem[] | null => {
    if (!Array.isArray(value) || value.length > 200) return null;
    const items: ChecklistItem[] = [];
    for (const entry of value) {
        if (!isObjectRecord(entry) || !id(entry.id) || typeof entry.title !== 'string') return null;
        const title = entry.title.trim();
        if (!title || title.length > 2000) return null;
        items.push({ id: entry.id, title, isCompleted: false });
    }
    return items;
};

export function createTaskRowChecklistMethods(deps: {
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
    const liveTask = (taskId: string): Task | null => {
        const task = useTaskStore.getState()._tasksById.get(taskId);
        return task && !task.deletedAt ? task : null;
    };
    const readOnly = (task: Task): boolean => {
        if (!task.projectId) return false;
        const project = useTaskStore.getState()._projectsById.get(task.projectId);
        return Boolean(project?.deletedAt || project?.status === 'archived');
    };

    return {
        getTaskRowChecklist(input: { taskId: string }): NativeHostResult<{ checklist: NativeTaskRowChecklist }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !id(input.taskId)) return fail('INVALID_INPUT', 'A task is required');
            const task = liveTask(input.taskId);
            if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
            const t = deps.t();
            const state = useTaskStore.getState();
            const lookup = createMarkdownLinkLookup(state._allTasks, state._allProjects);
            return { ok: true, value: { checklist: {
                taskId: task.id,
                taskRevision: taskRevisionOf(task),
                readOnly: readOnly(task),
                progressLabel: tFallback(t, 'checklist.progress', 'Checklist progress'),
                addLabel: tFallback(t, 'taskEdit.addItem', 'Add Item'),
                markdownLabels: {
                    deletedTask: tFallback(t, 'markdown.referenceDeletedTask', 'deleted task'),
                    deletedProject: tFallback(t, 'markdown.referenceDeletedProject', 'deleted project'),
                },
                items: (task.checklist ?? []).map((item) => ({
                    id: item.id, title: item.title, completed: item.isCompleted === true, inline: resolveMarkdownInline(item.title, lookup),
                })),
            } } };
        },

        async editTaskRowChecklist(input: NativeTaskRowChecklistEdit): Promise<NativeHostResult<{ id: string; status: Task['status'] }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const completed = isObjectRecord(input) ? readCompleted(input.completed) : null;
            const added = isObjectRecord(input) ? readAdded(input.added) : null;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !id(input.taskId) || !completed || !added) {
                return fail('INVALID_INPUT', 'A request UUID, a task, its ticks and its new items are required');
            }
            const { requestId, ...rest } = input;
            return receipts.run<{ id: string; status: Task['status'] }>(requestId, JSON.stringify(['taskRowChecklistEdit', rest]), async () => {
                const task = liveTask(input.taskId);
                if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
                if (readOnly(task)) return fail('ACTION_FAILED', 'The task\'s project is archived');
                const edit = applyRowChecklistEdit(task, completed, added);
                const written = await runStoreWrite(() => useTaskStore.getState().updateTask(task.id, edit));
                return settleWrite(written, { id: task.id, status: useTaskStore.getState()._tasksById.get(task.id)?.status ?? edit.status ?? task.status });
            });
        },
    };
}
