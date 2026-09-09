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
    handleBatchAssignArea: (areaId: string | null) => Promise<void>;
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
    // Set by keyboard navigation (selectNext/Prev/First/Last) to request that
    // DOM focus follow the selection. The follow only happens when focus was
    // already inside a task title toggle (checked at settle time), so j/k
    // navigation from the sidebar/body keeps working without focus side effects.
    const pendingSelectionFocusRef = useRef(false);
    // Last highlight id whose row was handed DOM focus (#1014).
    const focusedHighlightIdRef = useRef<string | null>(null);

    const requestSelectionScroll = useCallback(() => {
        pendingSelectionScrollRef.current = true;
        setSelectionScrollVersion((current) => current + 1);
    }, []);

    const filteredTaskIds = useMemo(() => filteredTasks.map((task) => task.id), [filteredTasks]);
    const {
        activeAction,
        allVisibleTasksSelected,
        assignAreaToSelectedTasks,
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
    } = useTaskSelection(filteredTaskIds, {
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

    // Keyboard navigation moves DOM focus to the newly selected task's title
    // toggle so no stale input-looking ring lingers on the previously focused
    // row (#860). We only follow focus when the active element is (or is inside)
    // a task title toggle: navigating from the sidebar/body leaves focus alone.
    // Scrolling is handled by the layout effect above, so we focus with
    // preventScroll to avoid fighting it.
    useLayoutEffect(() => {
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

        // A virtualized target row may not be mounted this frame. Retry after
        // the layout effect's scroll mounts it; if it still cannot be found,
        // blur the stale toggle so no lingering ring remains on the old row.
        if (typeof requestAnimationFrame !== 'function') {
            if (typeof activeToggle.blur === 'function') activeToggle.blur();
            return;
        }
        const frame = requestAnimationFrame(() => {
            if (focusTarget()) return;
            if (typeof activeToggle.blur === 'function') activeToggle.blur();
        });
        return () => cancelAnimationFrame(frame);
    }, [filteredTasks, selectedIndex, selectionScrollVersion]);

    useEffect(() => {
        if (!highlightTaskId) {
            focusedHighlightIdRef.current = null;
            return;
        }
        const index = filteredTasks.findIndex((task) => task.id === highlightTaskId);
        if (index < 0) return;

        setSelectedIndex(index);
        // Focus once per highlight: the effect re-runs on list changes during
        // the flash window, and refocusing then could steal focus from a modal
        // the user already opened on the revealed task.
        if (focusedHighlightIdRef.current !== highlightTaskId) {
            focusedHighlightIdRef.current = highlightTaskId;
            focusTaskRowWhenMounted(highlightTaskId);
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
    }, [filteredTasks, highlightTaskId, scrollToVirtualIndex, setHighlightTask, shouldVirtualize]);

    // Keyboard navigation only requests the follow-up: the layout effects above
    // own the virtualization-aware scroll and the #860 rule that focus follows
    // the selection only when it already sits on a task title.
    const revealSelected = useCallback(() => {
        requestSelectionScroll();
        pendingSelectionFocusRef.current = true;
    }, [requestSelectionScroll]);

    // Entering the list from the sidebar (ArrowRight / `l`) must land DOM focus
    // on the selected task's title so its highlight shows and the container
    // does not paint a focus ring around the whole list (#890). The row is
    // already highlighted via `selectedIndex`; here we move focus and scroll it
    // into view. Returns false only when there is nothing to select.
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

    // Keyboard multi-select: entering selection mode on first select and
    // leaving it when the selection empties keeps the mode invisible unless
    // it is actually in use.
    const toggleSelectTask = useCallback((task: Task) => {
        toggleMultiSelect(task.id);
    }, [toggleMultiSelect]);

    useRegisteredTaskListScope(registerTaskListScope, {
        addInputRef,
        enabled: !isProcessing,
        focusSelected,
        getSelectedIndex: () => selectedIndex,
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

    const handleBatchAssignArea = useCallback(async (areaId: string | null) => {
        await assignAreaToSelectedTasks(areaId);
    }, [assignAreaToSelectedTasks]);

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

    // Removal offers only the tags the selection actually carries, so a typo can
    // never look like a silent no-op.
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
        handleBatchAssignArea,
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
