import { createWithEqualityFn } from 'zustand/traditional';
import { useTaskStore, type FilterCriteria, type TaskSortBy } from '@mindwtr/core';
import { DONE_AXES, FOCUS_AXES, REFERENCE_AXES, SOMEDAY_AXES, sanitizeAxis, type DoneGroupBy, type NextGroupBy, type ReferenceGroupBy, type SomedayGroupBy } from '../components/views/list/next-grouping';
import { DONE_SORT_OPTIONS } from '../lib/task-list-sort';

const toastTimeouts = new Map<string, number>();
// These are the localStorage sanitizers for what the Focus/Next and Reference
// dropdowns write. They read the dropdowns' own rosters, so a value the menu
// offers can never be one this rejects — which would silently reset the user's
// grouping to the default on the next launch.
type ListNextGroupBy = NextGroupBy;
type ListReferenceGroupBy = ReferenceGroupBy;
type ListDoneGroupBy = DoneGroupBy;
type ListSomedayGroupBy = SomedayGroupBy;
type ListOptions = {
    showDetails: boolean;
    // One axis per list: these all share FOCUS_AXES, but "group Focus by
    // project" and "group my Inbox by context" are different questions, so a
    // single shared key made changing one list silently regroup four (#1063).
    focusGroupBy: ListNextGroupBy;
    inboxGroupBy: ListNextGroupBy;
    nextGroupBy: ListNextGroupBy;
    waitingGroupBy: ListNextGroupBy;
    somedayGroupBy: ListSomedayGroupBy;
    referenceGroupBy: ListReferenceGroupBy;
    // Done keeps its own axis rather than sharing nextGroupBy: 'completedDate'
    // is not in FOCUS_AXES, so that sanitizer would reset it on every launch.
    doneGroupBy: ListDoneGroupBy;
    doneSortBy?: TaskSortBy;
    // Archive is completed work too, so it reads the same rosters as Done — but
    // keeps its own values, because "group my archive by project" and "group my
    // Done list by completion date" are different questions (#959).
    archivedGroupBy: ListDoneGroupBy;
    archivedSortBy?: TaskSortBy;
    focusTop3Only: boolean;
};

export const LIST_OPTIONS_STORAGE_KEY = 'mindwtr:list-options:v1';

// Sections-as-columns is a per-project *presentation* choice, so it stays
// device-local next to the other view options rather than becoming a synced
// Project field (#1019).
export type ProjectLayout = 'list' | 'columns';
export const PROJECT_LAYOUTS_STORAGE_KEY = 'mindwtr:project-layouts:v1';

const DEFAULT_LIST_OPTIONS: ListOptions = {
    showDetails: false,
    focusGroupBy: 'none',
    inboxGroupBy: 'none',
    nextGroupBy: 'none',
    waitingGroupBy: 'none',
    somedayGroupBy: 'none',
    referenceGroupBy: 'area',
    doneGroupBy: 'none',
    archivedGroupBy: 'none',
    focusTop3Only: false,
};

function getPersistentStorage(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function readStoredListOptions(): ListOptions {
    const storage = getPersistentStorage();
    if (!storage) return DEFAULT_LIST_OPTIONS;
    try {
        const raw = storage.getItem(LIST_OPTIONS_STORAGE_KEY);
        if (!raw) return DEFAULT_LIST_OPTIONS;
        const parsed = JSON.parse(raw) as Partial<ListOptions> | null;
        const doneSortBy = DONE_SORT_OPTIONS.includes(parsed?.doneSortBy as TaskSortBy)
            ? parsed?.doneSortBy as TaskSortBy
            : undefined;
        const archivedSortBy = DONE_SORT_OPTIONS.includes(parsed?.archivedSortBy as TaskSortBy)
            ? parsed?.archivedSortBy as TaskSortBy
            : undefined;
        // Every list shared nextGroupBy before #1063, so a key the blob does not
        // have yet seeds from it — otherwise the split would read as a reset.
        const perViewAxis = (value: unknown) => sanitizeAxis(FOCUS_AXES, value ?? parsed?.nextGroupBy, DEFAULT_LIST_OPTIONS.nextGroupBy);
        return {
            showDetails: typeof parsed?.showDetails === 'boolean' ? parsed.showDetails : DEFAULT_LIST_OPTIONS.showDetails,
            focusGroupBy: perViewAxis(parsed?.focusGroupBy),
            inboxGroupBy: perViewAxis(parsed?.inboxGroupBy),
            nextGroupBy: sanitizeAxis(FOCUS_AXES, parsed?.nextGroupBy, DEFAULT_LIST_OPTIONS.nextGroupBy),
            waitingGroupBy: perViewAxis(parsed?.waitingGroupBy),
            somedayGroupBy: sanitizeAxis(
                SOMEDAY_AXES,
                parsed?.somedayGroupBy ?? parsed?.nextGroupBy,
                DEFAULT_LIST_OPTIONS.somedayGroupBy,
            ),
            referenceGroupBy: sanitizeAxis(REFERENCE_AXES, parsed?.referenceGroupBy, DEFAULT_LIST_OPTIONS.referenceGroupBy),
            doneGroupBy: sanitizeAxis(DONE_AXES, parsed?.doneGroupBy, DEFAULT_LIST_OPTIONS.doneGroupBy),
            ...(doneSortBy ? { doneSortBy } : {}),
            archivedGroupBy: sanitizeAxis(DONE_AXES, parsed?.archivedGroupBy, DEFAULT_LIST_OPTIONS.archivedGroupBy),
            ...(archivedSortBy ? { archivedSortBy } : {}),
            focusTop3Only: typeof parsed?.focusTop3Only === 'boolean' ? parsed.focusTop3Only : DEFAULT_LIST_OPTIONS.focusTop3Only,
        };
    } catch {
        return DEFAULT_LIST_OPTIONS;
    }
}

function saveStoredListOptions(options: ListOptions) {
    const storage = getPersistentStorage();
    if (!storage) return;
    try {
        storage.setItem(LIST_OPTIONS_STORAGE_KEY, JSON.stringify(options));
    } catch {
        // View options are convenience state; storage failures should not block UI updates.
    }
}

function readStoredProjectLayouts(): Record<string, ProjectLayout> {
    const storage = getPersistentStorage();
    if (!storage) return {};
    try {
        const raw = storage.getItem(PROJECT_LAYOUTS_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== 'object') return {};
        const layouts: Record<string, ProjectLayout> = {};
        for (const [projectId, value] of Object.entries(parsed)) {
            if (value === 'list' || value === 'columns') layouts[projectId] = value;
        }
        return layouts;
    } catch {
        return {};
    }
}

// Drops entries for projects the store no longer knows about (deleted and
// purged, not just soft-deleted — _allProjects keeps trashed ones restorable).
// Skipped when _allProjects is empty: that means "not loaded yet" at cold
// boot, not "no projects exist", and pruning against it would wipe every
// saved layout on every launch.
function pruneProjectLayouts(layouts: Record<string, ProjectLayout>): Record<string, ProjectLayout> {
    const allProjects = useTaskStore.getState()._allProjects;
    if (allProjects.length === 0) return layouts;
    const validIds = new Set(allProjects.map((project) => project.id));
    const pruned: Record<string, ProjectLayout> = {};
    for (const [projectId, layout] of Object.entries(layouts)) {
        if (validIds.has(projectId)) pruned[projectId] = layout;
    }
    return pruned;
}

function saveStoredProjectLayouts(layouts: Record<string, ProjectLayout>) {
    const storage = getPersistentStorage();
    if (!storage) return;
    try {
        storage.setItem(PROJECT_LAYOUTS_STORAGE_KEY, JSON.stringify(layouts));
    } catch {
        // Layout choice is convenience state; storage failures should not block UI updates.
    }
}

interface UiState {
    isFocusMode: boolean;
    setFocusMode: (value: boolean) => void;
    toggleFocusMode: () => void;
    toasts: Array<{
        id: string;
        message: string;
        tone: 'success' | 'error' | 'info';
        action?: { label: string; onClick: () => void };
    }>;
    showToast: (
        message: string,
        tone?: 'success' | 'error' | 'info',
        durationMs?: number,
        action?: { label: string; onClick: () => void }
    ) => void;
    dismissToast: (id: string) => void;
    listFilters: {
        criteria: FilterCriteria;
        open: boolean;
    };
    setListFilters: (partial: Partial<UiState['listFilters']>) => void;
    resetListFilters: () => void;
    listOptions: ListOptions;
    setListOptions: (partial: Partial<UiState['listOptions']>) => void;
    editingTaskId: string | null;
    setEditingTaskId: (value: string | null) => void;
    expandedTaskIds: Record<string, true>;
    collapseAllTaskDetails: () => void;
    setTaskExpanded: (taskId: string, expanded: boolean) => void;
    toggleTaskExpanded: (taskId: string) => void;
    boardFilters: {
        criteria: FilterCriteria;
    };
    setBoardFilters: (partial: Partial<UiState['boardFilters']>) => void;
    projectView: {
        selectedProjectId: string | null;
    };
    setProjectView: (partial: Partial<UiState['projectView']>) => void;
    projectLayouts: Record<string, ProjectLayout>;
    setProjectLayout: (projectId: string, layout: ProjectLayout) => void;
}

export const useUiStore = createWithEqualityFn<UiState>()((set) => ({
    isFocusMode: false,
    setFocusMode: (value) => set({ isFocusMode: value }),
    toggleFocusMode: () => set((state) => ({ isFocusMode: !state.isFocusMode })),
    toasts: [],
    showToast: (message, tone = 'info', durationMs = 3000, action) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        set((state) => ({ toasts: [...state.toasts, { id, message, tone, action }] }));
        const timeoutId = window.setTimeout(() => {
            toastTimeouts.delete(id);
            set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
        }, durationMs);
        toastTimeouts.set(id, timeoutId);
    },
    dismissToast: (id) => {
        const timeoutId = toastTimeouts.get(id);
        if (timeoutId) {
            window.clearTimeout(timeoutId);
            toastTimeouts.delete(id);
        }
        set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    },
    listFilters: {
        criteria: {},
        open: false,
    },
    setListFilters: (partial) =>
        set((state) => ({ listFilters: { ...state.listFilters, ...partial } })),
    resetListFilters: () =>
        set((state) => ({
            listFilters: {
                ...state.listFilters,
                criteria: {},
            },
        })),
    listOptions: readStoredListOptions(),
    setListOptions: (partial) =>
        set((state) => {
            const listOptions = { ...state.listOptions, ...partial };
            saveStoredListOptions(listOptions);
            return { listOptions };
        }),
    editingTaskId: null,
    setEditingTaskId: (value) => set({ editingTaskId: value }),
    expandedTaskIds: {},
    collapseAllTaskDetails: () =>
        set((state) => (Object.keys(state.expandedTaskIds).length === 0 ? state : { expandedTaskIds: {} })),
    setTaskExpanded: (taskId, expanded) =>
        set((state) => {
            const currentExpanded = Boolean(state.expandedTaskIds[taskId]);
            if (currentExpanded === expanded) return state;
            if (expanded) {
                return {
                    expandedTaskIds: {
                        ...state.expandedTaskIds,
                        [taskId]: true,
                    },
                };
            }
            const nextExpanded = { ...state.expandedTaskIds };
            delete nextExpanded[taskId];
            return { expandedTaskIds: nextExpanded };
        }),
    toggleTaskExpanded: (taskId) =>
        set((state) => {
            const isExpanded = Boolean(state.expandedTaskIds[taskId]);
            if (isExpanded) {
                const nextExpanded = { ...state.expandedTaskIds };
                delete nextExpanded[taskId];
                return { expandedTaskIds: nextExpanded };
            }
            return {
                expandedTaskIds: {
                    ...state.expandedTaskIds,
                    [taskId]: true,
                },
            };
        }),
    boardFilters: {
        criteria: {},
    },
    setBoardFilters: (partial) =>
        set((state) => ({ boardFilters: { ...state.boardFilters, ...partial } })),
    projectView: {
        selectedProjectId: null,
    },
    setProjectView: (partial) =>
        set((state) => ({ projectView: { ...state.projectView, ...partial } })),
    projectLayouts: readStoredProjectLayouts(),
    setProjectLayout: (projectId, layout) =>
        set((state) => {
            const projectLayouts = pruneProjectLayouts({ ...state.projectLayouts, [projectId]: layout });
            saveStoredProjectLayouts(projectLayouts);
            return { projectLayouts };
        }),
}));
