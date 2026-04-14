import {
    useState,
    useMemo,
    useEffect,
    useLayoutEffect,
    useRef,
    useCallback,
    type RefObject,
} from 'react';
import type {
    StoreActionResult,
    Task,
    TaskPriority,
    TaskStatus,
    TimeEstimate,
} from '@mindwtr/core';

import { reportError } from '../../../lib/report-error';
import type { NextGroupBy } from './next-grouping';

type ShowToast = (
    message: string,
    tone?: 'success' | 'error' | 'info',
    durationMs?: number,
    action?: { label: string; onClick: () => void }
) => void;

type TaskListScope = {
    kind: 'taskList';
    selectNext: () => void;
    selectPrev: () => void;
    selectFirst: () => void;
    selectLast: () => void;
    editSelected: () => void;
    toggleDoneSelected: () => void;
    deleteSelected: () => void;
    focusAddInput: () => void;
};

type UseListSelectionOptions = {
    activeNextGroupBy: NextGroupBy;
    addInputRef: RefObject<HTMLInputElement | null>;
    batchDeleteTasks: (taskIds: string[]) => Promise<unknown> | unknown;
    batchMoveTasks: (taskIds: string[], newStatus: TaskStatus) => Promise<unknown> | unknown;
    batchUpdateTasks: (
        updates: Array<{ id: string; updates: Partial<Task> }>
    ) => Promise<unknown> | unknown;
    deleteTask: (taskId: string) => Promise<unknown> | unknown;
    filteredTasks: Task[];
    highlightTaskId: string | null;
    isProcessing: boolean;
    moveTask: (taskId: string, status: TaskStatus) => Promise<unknown> | unknown;
    prioritiesEnabled: boolean;
    registerTaskListScope: (scope: TaskListScope | null) => void;
    restoreTask: (taskId: string) => Promise<StoreActionResult>;
    scrollToVirtualIndex: (index: number, align: 'auto' | 'center') => void;
    selectedPriorities: TaskPriority[];
    selectedTimeEstimates: TimeEstimate[];
    selectedTokens: string[];
    selectedWaitingPerson: string;
    setHighlightTask: (taskId: string | null) => void;
    shouldVirtualize: boolean;
    showToast: ShowToast;
    showViewFilterInput: boolean;
    statusFilter: TaskStatus | 'all';
    t: (key: string) => string;
    tasksById: Map<string, Task>;
    timeEstimatesEnabled: boolean;
    translateWithFallback: (key: string, fallback: string) => string;
    undoNotificationsEnabled: boolean;
    viewFilterInputRef: RefObject<HTMLInputElement | null>;
};

type UseListSelectionResult = {
    confirmBatchDelete: () => void;
    confirmSingleDelete: () => void;
    contextPromptMode: 'add' | 'remove';
    contextPromptOpen: boolean;
    exitSelectionMode: () => void;
    handleBatchAddContext: () => void;
    handleBatchAddTag: () => void;
    handleBatchAssignArea: (areaId: string | null) => Promise<void>;
    handleBatchDelete: () => Promise<void>;
    handleBatchMove: (newStatus: TaskStatus) => Promise<void>;
    handleBatchRemoveContext: () => void;
    handleConfirmContextPrompt: (value: string) => Promise<void>;
    handleConfirmTagPrompt: (value: string) => Promise<void>;
    handleSelectIndex: (index: number) => void;
    isBatchDeleting: boolean;
    multiSelectedIds: Set<string>;
    pendingBatchDeleteIds: string[];
    pendingDeleteTask: Task | null;
    selectedIdsArray: string[];
    selectedIndex: number;
    selectionMode: boolean;
    setContextPromptOpen: (open: boolean) => void;
    setPendingBatchDeleteIds: (taskIds: string[]) => void;
    setPendingDeleteTask: (task: Task | null) => void;
    setTagPromptOpen: (open: boolean) => void;
    tagPromptOpen: boolean;
    toggleMultiSelect: (taskId: string) => void;
    toggleSelectionMode: () => void;
};

export async function restoreDeletedTasksWithFeedback(
    taskIds: string[],
    restoreTask: (taskId: string) => Promise<StoreActionResult>,
    showToast: ShowToast,
): Promise<void> {
    const results = await Promise.allSettled(taskIds.map((taskId) => restoreTask(taskId)));
    const failedRestore = results.find(
        (result): result is PromiseRejectedResult | PromiseFulfilledResult<StoreActionResult> =>
            result.status === 'rejected' || !result.value.success,
    );

    if (!failedRestore) return;

    const message = failedRestore.status === 'rejected'
        ? (failedRestore.reason instanceof Error ? failedRestore.reason.message : 'Failed to restore deleted tasks')
        : (failedRestore.value.error || 'Failed to restore deleted tasks');
    const error = failedRestore.status === 'rejected'
        ? failedRestore.reason
        : new Error(message);

    reportError('Failed to restore deleted tasks', error);
    showToast(message, 'error');
}

export function useListSelection({
    activeNextGroupBy,
    addInputRef,
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    deleteTask,
    filteredTasks,
    highlightTaskId,
    isProcessing,
    moveTask,
    prioritiesEnabled,
    registerTaskListScope,
    restoreTask,
    scrollToVirtualIndex,
    selectedPriorities,
    selectedTimeEstimates,
    selectedTokens,
    selectedWaitingPerson,
    setHighlightTask,
    shouldVirtualize,
    showToast,
    showViewFilterInput,
    statusFilter,
    t,
    tasksById,
    timeEstimatesEnabled,
    translateWithFallback,
    undoNotificationsEnabled,
    viewFilterInputRef,
}: UseListSelectionOptions): UseListSelectionResult {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const [tagPromptOpen, setTagPromptOpen] = useState(false);
    const [tagPromptIds, setTagPromptIds] = useState<string[]>([]);
    const [contextPromptOpen, setContextPromptOpen] = useState(false);
    const [contextPromptMode, setContextPromptMode] = useState<'add' | 'remove'>('add');
    const [contextPromptIds, setContextPromptIds] = useState<string[]>([]);
    const [selectionScrollVersion, setSelectionScrollVersion] = useState(0);
    const [isBatchDeleting, setIsBatchDeleting] = useState(false);
    const [pendingDeleteTask, setPendingDeleteTask] = useState<Task | null>(null);
    const [pendingBatchDeleteIds, setPendingBatchDeleteIds] = useState<string[]>([]);
    const lastFilterKeyRef = useRef('');
    const pendingSelectionScrollRef = useRef(false);

    const exitSelectionMode = useCallback(() => {
        setSelectionMode(false);
        setMultiSelectedIds(new Set());
    }, []);

    const requestSelectionScroll = useCallback(() => {
        pendingSelectionScrollRef.current = true;
        setSelectionScrollVersion((current) => current + 1);
    }, []);

    const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);

    useEffect(() => {
        const filterKey = [
            statusFilter,
            prioritiesEnabled ? '1' : '0',
            timeEstimatesEnabled ? '1' : '0',
            selectedTokens.join('|'),
            selectedPriorities.join('|'),
            selectedTimeEstimates.join('|'),
            selectedWaitingPerson,
            activeNextGroupBy,
        ].join('::');

        if (lastFilterKeyRef.current !== filterKey) {
            lastFilterKeyRef.current = filterKey;
            requestSelectionScroll();
            setSelectedIndex(0);
            exitSelectionMode();
            return;
        }

        if (filteredTasks.length === 0) {
            if (selectedIndex !== 0) {
                setSelectedIndex(0);
            }
            return;
        }

        if (selectedIndex >= filteredTasks.length) {
            requestSelectionScroll();
            setSelectedIndex(filteredTasks.length - 1);
        }
    }, [
        activeNextGroupBy,
        exitSelectionMode,
        filteredTasks,
        prioritiesEnabled,
        requestSelectionScroll,
        selectedIndex,
        selectedPriorities,
        selectedTimeEstimates,
        selectedTokens,
        selectedWaitingPerson,
        statusFilter,
        timeEstimatesEnabled,
    ]);

    useLayoutEffect(() => {
        if (!pendingSelectionScrollRef.current) return;
        pendingSelectionScrollRef.current = false;
        const task = filteredTasks[selectedIndex];
        if (!task) return;

        if (shouldVirtualize) {
            scrollToVirtualIndex(selectedIndex, 'auto');
            return;
        }

        const element = document.querySelector(`[data-task-id="${task.id}"]`) as HTMLElement | null;
        if (element && typeof (element as { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }).scrollIntoView === 'function') {
            element.scrollIntoView({ block: 'nearest' });
        }
    }, [filteredTasks, scrollToVirtualIndex, selectedIndex, selectionScrollVersion, shouldVirtualize]);

    useEffect(() => {
        if (!highlightTaskId) return;
        const index = filteredTasks.findIndex((task) => task.id === highlightTaskId);
        if (index < 0) return;

        setSelectedIndex(index);
        if (shouldVirtualize) {
            scrollToVirtualIndex(index, 'center');
        }

        const element = document.querySelector(`[data-task-id="${highlightTaskId}"]`) as HTMLElement | null;
        if (element && typeof (element as { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }).scrollIntoView === 'function') {
            element.scrollIntoView({ block: 'center' });
        }

        const timer = window.setTimeout(() => setHighlightTask(null), 4000);
        return () => window.clearTimeout(timer);
    }, [filteredTasks, highlightTaskId, scrollToVirtualIndex, setHighlightTask, shouldVirtualize]);

    const selectNext = useCallback(() => {
        if (filteredTasks.length === 0) return;
        requestSelectionScroll();
        setSelectedIndex((index) => Math.min(index + 1, filteredTasks.length - 1));
    }, [filteredTasks.length, requestSelectionScroll]);

    const selectPrev = useCallback(() => {
        requestSelectionScroll();
        setSelectedIndex((index) => Math.max(index - 1, 0));
    }, [requestSelectionScroll]);

    const selectFirst = useCallback(() => {
        requestSelectionScroll();
        setSelectedIndex(0);
    }, [requestSelectionScroll]);

    const selectLast = useCallback(() => {
        if (filteredTasks.length > 0) {
            requestSelectionScroll();
            setSelectedIndex(filteredTasks.length - 1);
        }
    }, [filteredTasks.length, requestSelectionScroll]);

    const editSelected = useCallback(() => {
        const task = filteredTasks[selectedIndex];
        if (!task) return;
        const editTrigger = document.querySelector(
            `[data-task-id="${task.id}"] [data-task-edit-trigger]`,
        ) as HTMLElement | null;
        editTrigger?.focus();
        editTrigger?.click();
    }, [filteredTasks, selectedIndex]);

    const toggleDoneSelected = useCallback(() => {
        const task = filteredTasks[selectedIndex];
        if (!task) return;
        const nextStatus: TaskStatus = task.status === 'done' ? 'inbox' : 'done';
        void Promise.resolve(moveTask(task.id, nextStatus))
            .then(() => {
                if (!undoNotificationsEnabled || nextStatus !== 'done') return;
                showToast(
                    `${task.title} marked Done`,
                    'info',
                    5000,
                    {
                        label: t('common.undo') || 'Undo',
                        onClick: () => {
                            void Promise.resolve(moveTask(task.id, task.status));
                        },
                    },
                );
            })
            .catch((error) => reportError('Failed to update task status', error));
    }, [filteredTasks, moveTask, selectedIndex, showToast, t, undoNotificationsEnabled]);

    const runSingleDelete = useCallback(async (task: Task) => {
        await Promise.resolve(deleteTask(task.id));
        if (!undoNotificationsEnabled) return;
        showToast(
            t('list.taskDeleted') || 'Task deleted',
            'info',
            5000,
            {
                label: t('common.undo') || 'Undo',
                onClick: () => {
                    void restoreTask(task.id);
                },
            },
        );
    }, [deleteTask, restoreTask, showToast, t, undoNotificationsEnabled]);

    const deleteSelected = useCallback(() => {
        const task = filteredTasks[selectedIndex];
        if (!task) return;
        setPendingDeleteTask(task);
    }, [filteredTasks, selectedIndex]);

    useEffect(() => {
        if (isProcessing) {
            registerTaskListScope(null);
            return;
        }

        registerTaskListScope({
            kind: 'taskList',
            selectNext,
            selectPrev,
            selectFirst,
            selectLast,
            editSelected,
            toggleDoneSelected,
            deleteSelected,
            focusAddInput: () => {
                if (showViewFilterInput) {
                    viewFilterInputRef.current?.focus();
                    return;
                }
                addInputRef.current?.focus();
            },
        });

        return () => registerTaskListScope(null);
    }, [
        addInputRef,
        deleteSelected,
        editSelected,
        isProcessing,
        registerTaskListScope,
        selectFirst,
        selectLast,
        selectNext,
        selectPrev,
        showViewFilterInput,
        toggleDoneSelected,
        viewFilterInputRef,
    ]);

    const toggleMultiSelect = useCallback((taskId: string) => {
        setMultiSelectedIds((previous) => {
            const next = new Set(previous);
            if (next.has(taskId)) next.delete(taskId);
            else next.add(taskId);
            return next;
        });
    }, []);

    const handleSelectIndex = useCallback((index: number) => {
        if (!selectionMode) setSelectedIndex(index);
    }, [selectionMode]);

    const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
        if (selectedIdsArray.length === 0) return;
        try {
            await Promise.resolve(batchMoveTasks(selectedIdsArray, newStatus));
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch move tasks', error);
            showToast(translateWithFallback('bulk.moveFailed', 'Failed to update selected tasks'), 'error');
        }
    }, [batchMoveTasks, exitSelectionMode, selectedIdsArray, showToast, translateWithFallback]);

    const handleBatchDelete = useCallback(async () => {
        if (selectedIdsArray.length === 0) return;
        setPendingBatchDeleteIds(selectedIdsArray);
    }, [selectedIdsArray]);

    const confirmBatchDelete = useCallback(async () => {
        const taskIds = [...pendingBatchDeleteIds];
        if (taskIds.length === 0) return;

        setIsBatchDeleting(true);
        try {
            await Promise.resolve(batchDeleteTasks(taskIds));
            exitSelectionMode();
            if (undoNotificationsEnabled) {
                const deletedMessage = taskIds.length === 1
                    ? (t('list.taskDeleted') || 'Task deleted')
                    : (t('list.tasksDeleted') || '{{count}} tasks deleted').replace('{{count}}', String(taskIds.length));
                showToast(
                    deletedMessage,
                    'info',
                    5000,
                    {
                        label: t('common.undo') || 'Undo',
                        onClick: () => {
                            void restoreDeletedTasksWithFeedback(taskIds, restoreTask, showToast);
                        },
                    },
                );
            }
        } catch (error) {
            reportError('Failed to batch delete tasks', error);
            showToast(translateWithFallback('bulk.deleteFailed', 'Failed to delete selected tasks'), 'error');
        } finally {
            setIsBatchDeleting(false);
            setPendingBatchDeleteIds([]);
        }
    }, [
        batchDeleteTasks,
        exitSelectionMode,
        pendingBatchDeleteIds,
        restoreTask,
        showToast,
        t,
        translateWithFallback,
        undoNotificationsEnabled,
    ]);

    const handleBatchAssignArea = useCallback(async (areaId: string | null) => {
        if (selectedIdsArray.length === 0) return;
        try {
            await Promise.resolve(batchUpdateTasks(selectedIdsArray.map((id) => ({
                id,
                updates: { areaId: areaId ?? undefined },
            }))));
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch assign area', error);
            showToast(translateWithFallback('bulk.moveFailed', 'Failed to update selected tasks'), 'error');
        }
    }, [batchUpdateTasks, exitSelectionMode, selectedIdsArray, showToast, translateWithFallback]);

    const handleBatchAddTag = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setTagPromptIds(selectedIdsArray);
        setTagPromptOpen(true);
    }, [selectedIdsArray]);

    const handleBatchAddContext = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setContextPromptIds(selectedIdsArray);
        setContextPromptMode('add');
        setContextPromptOpen(true);
    }, [selectedIdsArray]);

    const handleBatchRemoveContext = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setContextPromptIds(selectedIdsArray);
        setContextPromptMode('remove');
        setContextPromptOpen(true);
    }, [selectedIdsArray]);

    const handleConfirmTagPrompt = useCallback(async (value: string) => {
        const input = value.trim();
        if (!input) return;
        const tag = input.startsWith('#') ? input : `#${input}`;
        await Promise.resolve(batchUpdateTasks(tagPromptIds.map((id) => {
            const task = tasksById.get(id);
            const existingTags = task?.tags || [];
            const nextTags = Array.from(new Set([...existingTags, tag]));
            return { id, updates: { tags: nextTags } };
        })));
        setTagPromptOpen(false);
        setTagPromptIds([]);
        exitSelectionMode();
    }, [batchUpdateTasks, exitSelectionMode, tagPromptIds, tasksById]);

    const handleConfirmContextPrompt = useCallback(async (value: string) => {
        const input = value.trim();
        if (!input) return;
        const context = input.startsWith('@') ? input : `@${input}`;
        await Promise.resolve(batchUpdateTasks(contextPromptIds.map((id) => {
            const task = tasksById.get(id);
            const existing = task?.contexts || [];
            const nextContexts = contextPromptMode === 'add'
                ? Array.from(new Set([...existing, context]))
                : existing.filter((token) => token !== context);
            return { id, updates: { contexts: nextContexts } };
        })));
        setContextPromptOpen(false);
        setContextPromptIds([]);
        exitSelectionMode();
    }, [batchUpdateTasks, contextPromptIds, contextPromptMode, exitSelectionMode, tasksById]);

    const confirmSingleDelete = useCallback(() => {
        const task = pendingDeleteTask;
        setPendingDeleteTask(null);
        if (!task) return;
        void runSingleDelete(task).catch((error) => reportError('Failed to delete task', error));
    }, [pendingDeleteTask, runSingleDelete]);

    const toggleSelectionMode = useCallback(() => {
        if (selectionMode) {
            exitSelectionMode();
            return;
        }
        setSelectionMode(true);
    }, [exitSelectionMode, selectionMode]);

    return {
        confirmBatchDelete,
        confirmSingleDelete,
        contextPromptMode,
        contextPromptOpen,
        exitSelectionMode,
        handleBatchAddContext,
        handleBatchAddTag,
        handleBatchAssignArea,
        handleBatchDelete,
        handleBatchMove,
        handleBatchRemoveContext,
        handleConfirmContextPrompt,
        handleConfirmTagPrompt,
        handleSelectIndex,
        isBatchDeleting,
        multiSelectedIds,
        pendingBatchDeleteIds,
        pendingDeleteTask,
        selectedIdsArray,
        selectedIndex,
        selectionMode,
        setContextPromptOpen,
        setPendingBatchDeleteIds,
        setPendingDeleteTask,
        setTagPromptOpen,
        tagPromptOpen,
        toggleMultiSelect,
        toggleSelectionMode,
    };
}
