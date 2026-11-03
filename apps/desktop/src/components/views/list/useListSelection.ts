import {
    useState,
    useMemo,
    useEffect,
    useLayoutEffect,
    useRef,
    useCallback,
    type RefObject,
} from 'react';
import { collectBulkTaskTokens } from '@mindwtr/core';
import type {
    BulkOrganizeTaskUpdateInput,
    Task,
    TaskStatus,
    TaskMoveDestination,
    RangeSelectionOptions,
} from '@mindwtr/core';

import type { TaskListScope } from '../../../contexts/keybinding-context';
import { focusTaskRowWhenMounted, useRegisteredTaskListScope } from './task-list-scope';
import { useTaskSelection } from './useTaskSelection';

type ShowToast = (
    message: string,
    tone?: 'success' | 'error' | 'info',
    durationMs?: number,
    action?: { label: string; onClick: () => void }
) => void;

type UseListSelectionOptions = {
    addInputRef: RefObject<HTMLInputElement | null>;
    batchDeleteTasks: (taskIds: string[]) => Promise<unknown> | unknown;
    batchMoveTasks: (taskIds: string[], newStatus: TaskStatus) => Promise<unknown> | unknown;
    batchUpdateTasks: (
        updates: Array<{ id: string; updates: Partial<Task> }>
    ) => Promise<unknown> | unknown;
    filteredTasks: Task[];
    selectableTaskIds?: string[];
    highlightTaskId: string | null;
    isProcessing: boolean;
    registerTaskListScope: (scope: TaskListScope | null) => void;
    restoreTask: (taskId: string) => Promise<unknown> | unknown;
    scrollToVirtualIndex: (index: number, align: 'auto' | 'center') => void;
    selectionResetKey: string;
    setHighlightTask: (taskId: string | null) => void;
    shouldVirtualize: boolean;
    showToast: ShowToast;
    t: (key: string) => string;
    tasksById: Map<string, Task>;
    undoNotificationsEnabled: boolean;
};

type UseListSelectionResult = {
    contextPromptMode: 'add' | 'remove';
    contextPromptOpen: boolean;
    exitSelectionMode: () => void;
    handleBatchAddContext: () => void;
    handleBatchAddTag: () => void;
    handleBatchMoveToDestination: (destination: TaskMoveDestination) => Promise<void>;
    handleBatchDelete: () => Promise<void>;
    handleBatchMove: (newStatus: TaskStatus) => Promise<void>;
    handleBatchRemoveContext: () => void;
    handleBatchRemoveTag: () => void;
    handleConfirmContextPrompt: (value: string) => Promise<void>;
    handleConfirmRemoveTags: (values: string[]) => Promise<void>;
    handleConfirmTagPrompt: (value: string) => Promise<void>;
    handleSelectIndex: (index: number) => void;
    exportSelectedTasks: () => Promise<boolean>;
    isBatchDeleting: boolean;
    isBulkOrganizing: boolean;
    isExporting: boolean;
    organizeSelectedTasks: (
        input: BulkOrganizeTaskUpdateInput,
        options?: { afterSuccess?: () => void },
    ) => Promise<boolean>;
    allVisibleTasksSelected: boolean;
    clearTaskSelection: () => void;
    multiSelectedIds: Set<string>;
    removableTagOptions: string[];
    removeTagPickerOpen: boolean;
    selectedIdsArray: string[];
    selectedIndex: number;
    selectAllVisibleTasks: () => void;
    selectionMode: boolean;
    setContextPromptOpen: (open: boolean) => void;
    setRemoveTagPickerOpen: (open: boolean) => void;
    setTagPromptOpen: (open: boolean) => void;
    tagPromptOpen: boolean;
    toggleMultiSelect: (taskId: string, options?: RangeSelectionOptions) => void;
    toggleSelectionMode: () => void;
};

export function useListSelection({
    addInputRef,
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    filteredTasks,
    selectableTaskIds,
    highlightTaskId,
    isProcessing,
    registerTaskListScope,
    restoreTask,
    scrollToVirtualIndex,
    selectionResetKey,
    setHighlightTask,
    shouldVirtualize,
    showToast,
    t,
    tasksById,
    undoNotificationsEnabled,
}: UseListSelectionOptions): UseListSelectionResult {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [tagPromptOpen, setTagPromptOpen] = useState(false);
    const [contextPromptOpen, setContextPromptOpen] = useState(false);
    const [contextPromptMode, setContextPromptMode] = useState<'add' | 'remove'>('add');
    const [removeTagPickerOpen, setRemoveTagPickerOpen] = useState(false);
    const [selectionScrollVersion, setSelectionScrollVersion] = useState(0);
    const lastFilterKeyRef = useRef('');
    const pendingSelectionScrollRef = useRef(false);


    const pendingSelectionFocusRef = useRef(false);

    const focusedHighlightIdRef = useRef<string | null>(null);
    const highlightFocusControllerRef = useRef<AbortController | null>(null);

    const requestSelectionScroll = useCallback(() => {
        pendingSelectionScrollRef.current = true;
        setSelectionScrollVersion((current) => current + 1);
    }, []);

    const filteredTaskIds = useMemo(() => filteredTasks.map((task) => task.id), [filteredTasks]);
    const selectionTaskIds = selectableTaskIds ?? filteredTaskIds;
    const {
        activeAction,
        allVisibleTasksSelected,
        moveSelectedTasksToDestination,
        clearTaskSelection,
        deleteSelectedTasks,
        exitSelectionMode,
        exportSelectedTasks,
        isExporting,
        multiSelectedIds,
        moveSelectedTasks,
        organizeSelectedTasks,
        selectedIdsArray,
        selectionMode,
        selectAllVisibleTasks,
        toggleMultiSelect,
        toggleSelectionMode,
        updateSelectedTaskTokens,
    } = useTaskSelection(selectionTaskIds, {
        batchDeleteTasks,
        batchMoveTasks,
        batchUpdateTasks,
        restoreTask,
        showToast,
        t,
        tasksById,
        undoNotificationsEnabled,
    });

    useEffect(() => {
        if (lastFilterKeyRef.current !== selectionResetKey) {
            lastFilterKeyRef.current = selectionResetKey;
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
        exitSelectionMode,
        filteredTasks,
        requestSelectionScroll,
        selectionResetKey,
        selectedIndex,
    ]);

    useLayoutEffect(() => {
        if (isProcessing) {
            pendingSelectionScrollRef.current = false;
            return;
        }
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
    }, [filteredTasks, isProcessing, scrollToVirtualIndex, selectedIndex, selectionScrollVersion, shouldVirtualize]);


    useLayoutEffect(() => {
        if (isProcessing) {
            pendingSelectionFocusRef.current = false;
            return;
        }
        if (!pendingSelectionFocusRef.current) return;
        pendingSelectionFocusRef.current = false;
        if (typeof document === 'undefined') return;

        const active = document.activeElement;
        const activeToggle = active && typeof active.closest === 'function'
            ? (active.closest('[data-task-view-toggle]') as HTMLElement | null)
            : null;
        if (!activeToggle) return;

        const task = filteredTasks[selectedIndex];
        if (!task) return;

        const focusTarget = (): boolean => {
            const toggle = document.querySelector(
                `[data-task-id="${task.id}"] [data-task-view-toggle]`,
            ) as HTMLElement | null;
            if (!toggle || typeof toggle.focus !== 'function') return false;
            if (toggle === activeToggle) return true;
            toggle.focus({ preventScroll: true });
            return true;
        };

        if (focusTarget()) return;


        if (typeof requestAnimationFrame !== 'function') {
            if (typeof activeToggle.blur === 'function') activeToggle.blur();
            return;
        }
        const frame = requestAnimationFrame(() => {
            if (focusTarget()) return;
            if (typeof activeToggle.blur === 'function') activeToggle.blur();
        });
        return () => cancelAnimationFrame(frame);
    }, [filteredTasks, isProcessing, selectedIndex, selectionScrollVersion]);

    useEffect(() => {
        if (isProcessing) {
            highlightFocusControllerRef.current?.abort();
            highlightFocusControllerRef.current = null;
            if (highlightTaskId) setHighlightTask(null);
            return;
        }
        if (!highlightTaskId) {
            highlightFocusControllerRef.current?.abort();
            highlightFocusControllerRef.current = null;
            focusedHighlightIdRef.current = null;
            return;
        }
        if (focusedHighlightIdRef.current !== highlightTaskId) {
            highlightFocusControllerRef.current?.abort();
            highlightFocusControllerRef.current = null;
        }
        const index = filteredTasks.findIndex((task) => task.id === highlightTaskId);
        if (index < 0) return;

        setSelectedIndex(index);


        if (focusedHighlightIdRef.current !== highlightTaskId) {
            focusedHighlightIdRef.current = highlightTaskId;
            highlightFocusControllerRef.current = new AbortController();
            focusTaskRowWhenMounted(highlightTaskId, highlightFocusControllerRef.current.signal);
        }
        if (shouldVirtualize) {
            scrollToVirtualIndex(index, 'center');
        } else {
            let retryTimer: number | null = null;
            let cancelled = false;
            let attempts = 0;
            const scrollHighlightedTask = () => {
                if (cancelled) return;
                const element = document.querySelector(`[data-task-id="${highlightTaskId}"]`) as HTMLElement | null;
                if (element && typeof (element as { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }).scrollIntoView === 'function') {
                    element.scrollIntoView({ block: 'center' });
                    return;
                }
                if (attempts >= 8) return;
                attempts += 1;
                retryTimer = window.setTimeout(scrollHighlightedTask, 50);
            };
            scrollHighlightedTask();
            const timer = window.setTimeout(() => setHighlightTask(null), 4000);
            return () => {
                cancelled = true;
                if (retryTimer !== null) window.clearTimeout(retryTimer);
                window.clearTimeout(timer);
            };
        }

        const timer = window.setTimeout(() => setHighlightTask(null), 4000);
        return () => window.clearTimeout(timer);
    }, [filteredTasks, highlightTaskId, isProcessing, scrollToVirtualIndex, setHighlightTask, shouldVirtualize]);

    useEffect(() => () => highlightFocusControllerRef.current?.abort(), []);


    const revealSelected = useCallback(() => {
        requestSelectionScroll();
        pendingSelectionFocusRef.current = true;
    }, [requestSelectionScroll]);


    const focusSelected = useCallback((): boolean => {
        if (filteredTasks.length === 0) return false;
        const index = selectedIndex >= 0 && selectedIndex < filteredTasks.length
            ? selectedIndex
            : 0;
        if (index !== selectedIndex) setSelectedIndex(index);
        requestSelectionScroll();
        const task = filteredTasks[index];
        const toggle = document.querySelector(
            `[data-task-id="${task.id}"] [data-task-view-toggle]`,
        ) as HTMLElement | null;
        if (toggle && typeof toggle.focus === 'function') toggle.focus();
        return true;
    }, [filteredTasks, requestSelectionScroll, selectedIndex]);


    const toggleSelectTask = useCallback((task: Task) => {
        toggleMultiSelect(task.id);
    }, [toggleMultiSelect]);

    useRegisteredTaskListScope(registerTaskListScope, {
        addInputRef,
        enabled: !isProcessing,
        focusSelected,
        getSelectedIndex: () => selectedIndex,
        getSelectedIds: () => multiSelectedIds,
        getHighlightedTaskId: () => !selectionMode ? filteredTasks[selectedIndex]?.id : undefined,
        getTasks: () => filteredTasks,
        revealSelected,
        setSelectedIndex,
        t,
        toggleSelect: toggleSelectTask,
    });

    const handleSelectIndex = useCallback((index: number) => {
        if (!selectionMode) setSelectedIndex(index);
    }, [selectionMode]);

    const handleBatchMove = useCallback(async (newStatus: TaskStatus) => {
        await moveSelectedTasks(newStatus);
    }, [moveSelectedTasks]);

    const handleBatchDelete = useCallback(async () => {
        await deleteSelectedTasks();
    }, [deleteSelectedTasks]);

    const handleBatchMoveToDestination = useCallback(async (destination: TaskMoveDestination) => {
        await moveSelectedTasksToDestination(destination);
    }, [moveSelectedTasksToDestination]);

    const handleBatchAddTag = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setTagPromptOpen(true);
    }, [selectedIdsArray]);

    const handleBatchAddContext = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setContextPromptMode('add');
        setContextPromptOpen(true);
    }, [selectedIdsArray]);

    const handleBatchRemoveContext = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setContextPromptMode('remove');
        setContextPromptOpen(true);
    }, [selectedIdsArray]);


    const removableTagOptions = useMemo(
        () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'tags'),
        [selectedIdsArray, tasksById],
    );

    const handleBatchRemoveTag = useCallback(() => {
        if (selectedIdsArray.length === 0) return;
        setRemoveTagPickerOpen(true);
    }, [selectedIdsArray]);

    const handleConfirmRemoveTags = useCallback(async (values: string[]) => {
        if (values.length === 0) return;
        await updateSelectedTaskTokens('tags', values, 'remove', {
            afterNoop: () => setRemoveTagPickerOpen(false),
            afterSuccess: () => setRemoveTagPickerOpen(false),
        });
    }, [updateSelectedTaskTokens]);

    const handleConfirmTagPrompt = useCallback(async (value: string) => {
        const input = value.trim();
        if (!input) return;
        const tag = input.startsWith('#') ? input : `#${input}`;
        await updateSelectedTaskTokens('tags', tag, 'add', {
            afterNoop: () => setTagPromptOpen(false),
            afterSuccess: () => {
                setTagPromptOpen(false);
            },
        });
    }, [updateSelectedTaskTokens]);

    const handleConfirmContextPrompt = useCallback(async (value: string) => {
        const input = value.trim();
        if (!input) return;
        const context = input.startsWith('@') ? input : `@${input}`;
        await updateSelectedTaskTokens('contexts', context, contextPromptMode, {
            afterNoop: () => setContextPromptOpen(false),
            afterSuccess: () => {
                setContextPromptOpen(false);
            },
        });
    }, [contextPromptMode, updateSelectedTaskTokens]);

    return {
        contextPromptMode,
        contextPromptOpen,
        exitSelectionMode,
        handleBatchAddContext,
        handleBatchAddTag,
        handleBatchMoveToDestination,
        handleBatchDelete,
        handleBatchMove,
        handleBatchRemoveContext,
        handleBatchRemoveTag,
        handleConfirmContextPrompt,
        handleConfirmRemoveTags,
        handleConfirmTagPrompt,
        handleSelectIndex,
        exportSelectedTasks,
        isBatchDeleting: activeAction === 'delete',
        isBulkOrganizing: activeAction === 'organize',
        isExporting,
        allVisibleTasksSelected,
        clearTaskSelection,
        multiSelectedIds,
        organizeSelectedTasks,
        removableTagOptions,
        removeTagPickerOpen,
        selectedIdsArray,
        selectedIndex,
        selectAllVisibleTasks,
        selectionMode,
        setContextPromptOpen,
        setRemoveTagPickerOpen,
        setTagPromptOpen,
        tagPromptOpen,
        toggleMultiSelect,
        toggleSelectionMode,
    };
}
