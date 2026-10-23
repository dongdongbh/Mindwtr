import type { NativeHostResult } from './native-host-contract';
import { exact, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import { useTaskStore } from './store';
import { getTaskSortByLabel, getVisibleTaskSortOptions, resolveNonDoneTaskSortBy, TASK_LIST_SORT_OPTIONS } from './task-list-sort-options';
import type { TaskSortBy } from './types';

export type NativeTaskListSortRequest = { requestId: string; sortBy: TaskSortBy; expected: { sortBy: string | null } };
export type NativeTaskListSortResult = { sortBy: TaskSortBy };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

const rawSort = (): NativeHostResult<string | null> => {
    const settings = useTaskStore.getState().settings;
    if (!Object.prototype.hasOwnProperty.call(settings, 'taskSortBy')) return { ok: true, value: null };
    return typeof settings.taskSortBy === 'string' && settings.taskSortBy.length <= 500
        ? { ok: true, value: settings.taskSortBy }
        : fail('INVALID_INPUT', 'Stored task list sort has an unsupported value');
};

/** Pure validation for a cold native journal, before storage opens. */
export function validateTaskListSortWrite(input: unknown): NativeHostResult<NativeTaskListSortResult> {
    if (!isNativeJsonWithinBytes(input, 4096) || !record(input)
        || !exact(input, ['requestId', 'sortBy', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || !TASK_LIST_SORT_OPTIONS.includes(input.sortBy as TaskSortBy)
        || !record(input.expected) || !exact(input.expected, ['sortBy'])
        || (input.expected.sortBy !== null
            && (typeof input.expected.sortBy !== 'string' || input.expected.sortBy.length > 500))) {
        return fail('INVALID_INPUT', 'A bounded checked task list sort request is required');
    }
    return { ok: true, value: { sortBy: input.sortBy as TaskSortBy } };
}

export function createTaskListSortMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    t: (key: string) => string;
}) {
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
        } catch (error) {
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });

    return {
        getTaskListSortOptions(input: Record<string, never>): NativeHostResult<{ revision: string; expected: { sortBy: string | null };
            choices: { value: TaskSortBy; label: string; selected: boolean }[] }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'Empty task list sort options input is required');
            const raw = rawSort();
            if (!raw.ok) return raw;
            const settings = useTaskStore.getState().settings;
            const selected = resolveNonDoneTaskSortBy(settings.taskSortBy, settings);
            return { ok: true, value: {
                revision: deps.revision(), expected: { sortBy: raw.value },
                choices: getVisibleTaskSortOptions(TASK_LIST_SORT_OPTIONS, settings)
                    .map((value) => ({ value, label: getTaskSortByLabel(value, deps.t), selected: value === selected })),
            } };
        },

        validateTaskListSortWrite,

        probeTaskListSortOutcome(input: NativeTaskListSortRequest): NativeHostResult<NativeTaskListSortResult> {
            const checked = validateTaskListSortWrite(input);
            if (!checked.ok) return checked;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const raw = rawSort();
            if (!raw.ok) return raw;
            return raw.value === checked.value.sortBy ? checked
                : fail('STALE_REVISION', 'Task list sort outcome is not present');
        },

        async setTaskListSortChecked(input: NativeTaskListSortRequest): Promise<NativeHostResult<NativeTaskListSortResult>> {
            const checked = validateTaskListSortWrite(input);
            if (!checked.ok) return checked;
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return receipts.run(input.requestId, JSON.stringify(input), async () => {
                const raw = rawSort();
                if (!raw.ok) return raw;
                if (raw.value === checked.value.sortBy) return checked;
                if (raw.value !== input.expected.sortBy) return fail('STALE_REVISION', 'Task list sort changed while editing');
                const settings = useTaskStore.getState().settings;
                if (!settings.deviceId) return fail('INVALID_INPUT', 'Loaded device identity is required');
                if (getVisibleTaskSortOptions([checked.value.sortBy], settings).length === 0)
                    return fail('INVALID_INPUT', 'That task list sort is not offered');
                const written = await runStoreWrite(() => useTaskStore.getState().updateSettings({ taskSortBy: checked.value.sortBy }));
                return settleWrite(written, checked.value);
            });
        },
    };
}
