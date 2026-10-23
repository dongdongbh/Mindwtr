import { useState, useMemo, useEffect, useCallback, useRef, useLayoutEffect, type Key, type ReactNode, type RefObject } from 'react';
import { isGettingStartedProject } from '@mindwtr/core';
import { GettingStartedActions } from '../../GettingStartedActions';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Attachment,
    Task,
    collectBulkTaskTokens,
    collectProjectTaskLinks,
    compareTasksByProjectOrder,
    getProjectSectionsForView,
    getProjectToSectionEligibility,
    getSequentialProjectTaskCues,
    getProjectFlowMode,
    isTaskFinished,
    isTaskCompleted,
    type BulkOrganizeTaskUpdateInput,
    type Project,
    type ProjectSequenceTaskCue,
    type Section,
    type TaskSortBy,
    generateUUID,
    formatI18nTemplate,
    parseAttachmentLinkBatch,
    getInlineMarkdownPreview,
    stripMarkdown,
    PROJECT_TASK_SORT_OPTIONS,
    resolveTaskSortByForFeatures,
    sortTasksBy,
    splitCompletedTasks, tFallback, undoProjectDelete, updateProjectFromDraft, useTaskStore, } from '@mindwtr/core';
import { useDndMonitor } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { Search, FileText, CheckCircle2, ChevronDown, ChevronRight, Folder, PanelLeftOpen, Plus, X } from 'lucide-react';

import { PromptModal } from '../../PromptModal';
import { browseForLinkTarget } from '../../../lib/attachment-import';
import { isTauriRuntime } from '../../../lib/runtime';
import { TokenPickerModal } from '../../TokenPickerModal';
import { TaskItem } from '../../TaskItem';
import { InlineMarkdown } from '../../Markdown';
import { useUiStore } from '../../../store/ui-store';
import { BulkSelectionToolbar } from '../list/BulkSelectionToolbar';
import { LIST_END_GAP, SortBySelect, VIEW_FILTER_INPUT } from '../list/list-toolbar';
import { sortDoneTasksForListView } from '../list/done-sort';
import { focusTaskRowWhenMounted, useTaskListScope } from '../list/task-list-scope';
import { useTaskSelection } from '../list/useTaskSelection';
import { ListBulkActions } from '../list/ListBulkActions';
import { TaskBulkOrganizeModal } from '../list/TaskBulkOrganizeModal';
import { cn } from '../../../lib/utils';
import { reportError } from '../../../lib/report-error';
import { showUndoToast } from '../../../lib/undo-registry';
import { useMiddleMousePan } from './use-column-pan';
import { appendProjectAttachments, useProjectAttachmentActions } from './useProjectAttachmentActions';
import { useProjectSectionActions } from './useProjectSectionActions';
import { useProjectWorkspaceStore } from './useProjectWorkspaceStore';
import { ProjectDetailsHeader } from './ProjectDetailsHeader';
import { ProjectDetailsFields } from './ProjectDetailsFields';
import { ProjectNotesSection } from './ProjectNotesSection';
import { ProjectSectionActionsMenu } from './ProjectSectionActionsMenu';
import { ProjectTaskToolbarMenu } from './ProjectTaskToolbarMenu';
import { DraggableProjectTaskRow, SortableProjectTaskRow } from './SortableRows';
import { SectionDropZone, getSectionContainerId, getSectionIdFromContainer, NO_SECTION_CONTAINER } from './section-dnd';
import {
    DEFAULT_AREA_COLOR,
    getProjectColor,
    parseTagInput,
    toDateInputValue,
} from './projects-utils';
import { toDateTimeLocalValue } from '../../Task/task-item-helpers';
import type { ConfirmationRequestOptions } from '../../../hooks/useConfirmDialog';

// The one visible line is far shorter; the cap only keeps a pathological
// single-line note out of the inline markdown tokenizer.
const SECTION_NOTES_PREVIEW_MAX_CHARS = 300;

const PROJECT_TASK_VIRTUALIZATION_THRESHOLD = 80;
const PROJECT_TASK_ROW_ESTIMATE = 88;
const PROJECT_TASK_VIRTUAL_OVERSCAN = 8;
const PROJECT_TASK_VIRTUAL_INITIAL_HEIGHT = 720;
const PROJECT_TASK_TOOLBAR_COLLAPSE_SCROLL_Y = 96;
const PROJECT_TASK_TOOLBAR_EXPAND_SCROLL_Y = 8;

type ProjectScrollSnapshot = {
    scrollTop: number;
    scrollLeft: number;
    projectId: string | null;
    anchorKey?: string;
    anchorTop?: number;
};

const PROJECT_SCROLL_ANCHOR_SELECTOR = '[data-task-id],[data-project-completed-toggle]';

const getProjectScrollAnchorKey = (element: HTMLElement): string | null => {
    const taskId = element.getAttribute('data-task-id');
    if (taskId) return `task:${taskId}`;
    if (element.hasAttribute('data-project-completed-toggle')) return 'completed-toggle';
    return null;
};

const findProjectScrollAnchorByKey = (scrollElement: HTMLElement, anchorKey: string): HTMLElement | null => (
    Array.from(scrollElement.querySelectorAll<HTMLElement>(PROJECT_SCROLL_ANCHOR_SELECTOR))
        .find((element) => getProjectScrollAnchorKey(element) === anchorKey) ?? null
);

const createProjectScrollSnapshot = (scrollElement: HTMLElement, projectId: string | null): ProjectScrollSnapshot => {
    const snapshot: ProjectScrollSnapshot = {
        scrollTop: scrollElement.scrollTop,
        scrollLeft: scrollElement.scrollLeft,
        projectId,
    };
    const scrollRect = scrollElement.getBoundingClientRect();
    const visibleAnchor = Array.from(scrollElement.querySelectorAll<HTMLElement>(PROJECT_SCROLL_ANCHOR_SELECTOR))
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => (
            Number.isFinite(rect.top)
            && Number.isFinite(rect.bottom)
            && rect.bottom > scrollRect.top
            && rect.top < scrollRect.bottom
        ))
        .sort((a, b) => Math.abs(a.rect.top - scrollRect.top) - Math.abs(b.rect.top - scrollRect.top))[0];
    if (!visibleAnchor) return snapshot;
    const anchorKey = getProjectScrollAnchorKey(visibleAnchor.element);
    if (!anchorKey) return snapshot;
    return {
        ...snapshot,
        anchorKey,
        anchorTop: visibleAnchor.rect.top,
    };
};

const restoreProjectScrollSnapshot = (scrollElement: HTMLElement, snapshot: ProjectScrollSnapshot) => {
    scrollElement.scrollTop = snapshot.scrollTop;
    scrollElement.scrollLeft = snapshot.scrollLeft;

    if (!snapshot.anchorKey || typeof snapshot.anchorTop !== 'number') return;
    const anchor = findProjectScrollAnchorByKey(scrollElement, snapshot.anchorKey);
    if (!anchor) return;
    const nextAnchorTop = anchor.getBoundingClientRect().top;
    const delta = nextAnchorTop - snapshot.anchorTop;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return;
    scrollElement.scrollTop += delta;
};

type ProjectTaskRowsProps = {
    tasks: readonly Task[];
    renderTask: (task: Task) => ReactNode;
    scrollRef: RefObject<HTMLDivElement | null>;
    pinnedTaskId?: string | null;
};

type ProjectTaskVirtualRow = {
    index: number;
    key: Key;
    start: number;
};

/**
 * Where to draw a row the virtualizer is not currently rendering — the task
 * being edited, or the one a new-task highlight wants scrolled into view.
 *
 * It has to be the offset the virtualizer itself holds for that index, never
 * `index * estimate`. Once rows have been measured they come out shorter than
 * the estimate, so the list is far shorter than `index * estimate` suggests;
 * placing the row there puts it past the end of the list, and scrolling it into
 * view leaves the viewport in empty space with nothing rendered (#916).
 * The estimate is only a fallback for the first render, before any measuring,
 * where the two agree anyway.
 */
export function resolvePinnedRowStart(
    measuredStart: number | undefined,
    index: number,
    scrollMargin: number,
): number {
    return measuredStart ?? scrollMargin + index * PROJECT_TASK_ROW_ESTIMATE;
}

function ProjectTaskRows({ tasks, renderTask, scrollRef, pinnedTaskId }: ProjectTaskRowsProps) {
    const shouldVirtualize = tasks.length > PROJECT_TASK_VIRTUALIZATION_THRESHOLD;
    const listRef = useRef<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);

    const updateScrollMargin = useCallback(() => {
        const scrollElement = scrollRef.current;
        const listElement = listRef.current;
        if (!scrollElement || !listElement) return;

        const scrollRect = scrollElement.getBoundingClientRect();
        const listRect = listElement.getBoundingClientRect();
        setScrollMargin(listRect.top - scrollRect.top + scrollElement.scrollTop);
    }, [scrollRef]);

    useLayoutEffect(() => {
        if (!shouldVirtualize) return;

        updateScrollMargin();

        if (typeof window === 'undefined') return;

        const resizeObserver = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(updateScrollMargin)
            : null;

        if (resizeObserver) {
            if (scrollRef.current) resizeObserver.observe(scrollRef.current);
            if (listRef.current) resizeObserver.observe(listRef.current);
        }

        window.addEventListener('resize', updateScrollMargin);
        return () => {
            resizeObserver?.disconnect();
            window.removeEventListener('resize', updateScrollMargin);
        };
    }, [shouldVirtualize, scrollRef, tasks.length, updateScrollMargin]);

    useLayoutEffect(() => {
        if (shouldVirtualize) updateScrollMargin();
    });

    const rowVirtualizer = useVirtualizer({
        // Inactive section virtualizers must not reset the shared scroller on mount (#1262).
        enabled: shouldVirtualize,
        count: shouldVirtualize ? tasks.length : 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => PROJECT_TASK_ROW_ESTIMATE,
        overscan: PROJECT_TASK_VIRTUAL_OVERSCAN,
        getItemKey: (index) => tasks[index]?.id ?? index,
        initialRect: { width: 0, height: PROJECT_TASK_VIRTUAL_INITIAL_HEIGHT },
        scrollMargin,
    });

    if (!shouldVirtualize) {
        return (
            <div className="divide-y divide-border/30">
                {tasks.map((task) => renderTask(task))}
            </div>
        );
    }

    const virtualRows = rowVirtualizer.getVirtualItems();
    let rowsToRender: ProjectTaskVirtualRow[] = virtualRows.length > 0
        ? virtualRows.map((row) => ({
            index: row.index,
            key: row.key,
            start: row.start,
        }))
        : Array.from({
            length: Math.min(
                tasks.length,
                Math.ceil(PROJECT_TASK_VIRTUAL_INITIAL_HEIGHT / PROJECT_TASK_ROW_ESTIMATE)
                    + PROJECT_TASK_VIRTUAL_OVERSCAN * 2,
            ),
        }, (_, index) => ({
            index,
            key: tasks[index]?.id ?? index,
            start: index * PROJECT_TASK_ROW_ESTIMATE,
        }));
    const pinnedTaskIndex = pinnedTaskId
        ? tasks.findIndex((task) => task.id === pinnedTaskId)
        : -1;
    if (pinnedTaskIndex >= 0 && !rowsToRender.some((row) => row.index === pinnedTaskIndex)) {
        rowsToRender = [
            ...rowsToRender,
            {
                index: pinnedTaskIndex,
                key: tasks[pinnedTaskIndex]?.id ?? pinnedTaskIndex,
                start: resolvePinnedRowStart(
                    rowVirtualizer.measurementsCache[pinnedTaskIndex]?.start,
                    pinnedTaskIndex,
                    scrollMargin,
                ),
            },
        ].sort((a, b) => a.index - b.index);
    }
    const totalSize = rowVirtualizer.getTotalSize() || tasks.length * PROJECT_TASK_ROW_ESTIMATE;

    return (
        <div
            ref={listRef}
            data-virtualized-task-list="true"
            className="relative"
            style={{ height: totalSize }}
        >
            {rowsToRender.map((virtualRow) => {
                const task = tasks[virtualRow.index];
                if (!task) return null;

                return (
                    <div
                        key={virtualRow.key}
                        ref={virtualRows.length > 0 ? rowVirtualizer.measureElement : undefined}
                        data-index={virtualRow.index}
                        className="absolute left-0 top-0 w-full border-b border-border/30"
                        style={{
                            transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                        }}
                    >
                        {renderTask(task)}
                    </div>
                );
            })}
        </div>
    );
}

// Renders one section as a board column. The column body is its own vertical
// scroller, so the shared ProjectTaskRows virtualizer measures against the
// column instead of the page — columns need no task-count ceiling of their own.
function ProjectSectionColumn({
    id,
    dashed,
    header,
    notes,
    collapsed,
    children,
}: {
    id: string;
    dashed?: boolean;
    header: ReactNode;
    notes?: ReactNode;
    collapsed?: boolean;
    children: (scrollRef: RefObject<HTMLDivElement | null>) => ReactNode;
}) {
    const columnScrollRef = useRef<HTMLDivElement | null>(null);

    return (
        <SectionDropZone
            id={id}
            className={cn(
                'flex w-96 flex-none flex-col self-start rounded-lg border',
                dashed ? 'border-dashed border-border/70' : 'border-border/60',
            )}
        >
            <div className="border-b border-border/50 px-3 py-2">{header}</div>
            {notes}
            {!collapsed && (
                <div ref={columnScrollRef} className="max-h-[60vh] min-h-[5rem] overflow-y-auto p-3">
                    {children(columnScrollRef)}
                </div>
            )}
        </SectionDropZone>
    );
}

type RenderProjectTasks = (list: Task[], scrollRef?: RefObject<HTMLDivElement | null>) => ReactNode;

type BulkTokenPickerState = {
    field: 'tags' | 'contexts';
    action: 'add' | 'remove';
} | null;

// The workspace reads its store data and actions itself (useProjectWorkspaceStore
// + useUiStore); only genuinely wrapper-owned state stays a prop. Store slices
// re-threaded through ProjectsView were removed (arch review 2026-07-20 #8).
type ProjectWorkspaceProps = {
    // Cross-view navigation highlight — set from other views, cleared here.
    highlightTaskId: string | null;
    // Area-creation-in-progress flag; drives the shared workspace loading banner.
    isAreaCreating: boolean;
    // Project-creation-in-progress flag; drives the shared loading banner.
    isCreatingProject: boolean;
    // App language (React context); threaded so tests keep translation control.
    language: string;
    // Duplicate-then-select action; also wired to the sidebar in ProjectsView.
    onDuplicateProject: (projectId: string) => Promise<void> | void;
    onConvertProjectToSection?: (projectId: string) => Promise<void> | void;
    // Opens the AreaManagerModal, whose open/close state lives in ProjectsView.
    onManageAreas: () => void;
    // Opens the quick-area prompt, whose state lives in ProjectsView.
    onRequestQuickArea: (projectId: string) => void;
    // Setter for the persisted showCompletedTasks view state (localStorage).
    onToggleShowCompletedTasks: () => void;
    // The confirm-dialog host is rendered by ProjectsView.
    requestConfirmation: (options: ConfirmationRequestOptions) => Promise<boolean>;
    // Selection identity — owned by ProjectsView (UI store + reset effects).
    selectedProjectId: string | null;
    // Persisted view state (localStorage) owned by ProjectsView.
    showCompletedTasks: boolean;
    // Translator (React context); threaded so tests keep translation control.
    t: (key: string) => string;
    // Wrapper layout state.
    projectsSidebarCollapsed?: boolean;
    // Toggles wrapper layout state.
    onToggleProjectsSidebar?: () => void;
    // ADR 0023: the Projects view owns the shared DndContext; the workspace
    // registers its in-list drag-end handling here so the view can delegate
    // non-sidebar drops.
    taskDragEndRef: RefObject<((event: DragEndEvent) => void) | null>;
};

export function shouldShowProjectWorkspaceTask(
    task: Task,
    project?: Project,
    showCompletedTasks = false,
): boolean {
    if (!project) return false;
    if (task.deletedAt || task.projectId !== project.id) return false;
    if (task.status === 'reference') return false;
    if (project.status === 'archived') return isTaskFinished(task);
    if (isTaskFinished(task)) return showCompletedTasks;
    return true;
}

export function ProjectWorkspace({
    highlightTaskId,
    isAreaCreating,
    isCreatingProject,
    language,
    onDuplicateProject,
    onConvertProjectToSection,
    onManageAreas,
    onRequestQuickArea,
    onToggleShowCompletedTasks,
    requestConfirmation,
    selectedProjectId,
    showCompletedTasks,
    t,
    projectsSidebarCollapsed = false,
    onToggleProjectsSidebar,
    taskDragEndRef,
}: ProjectWorkspaceProps) {
    const {
        projects,
        sections,
        allSections,
        areas,
        allTasks,
        settings,
        undoNotificationsEnabled,
        addSection,
        updateSection,
        deleteSection,
        reorderSections,
        reorderProjectTasks,
        updateProject,
        cancelProject,
        deleteProject,
        updateTask,
        restoreTask,
        batchMoveTasks,
        batchDeleteTasks,
        batchUpdateTasks,
        setHighlightTask,
        allTokens,
        selectedProjectTasks,
        sortedAreas,
        areaById,
        noAreaId,
    } = useProjectWorkspaceStore(selectedProjectId);
    const showToast = useUiStore((state) => state.showToast);
    const setProjectView = useUiStore((state) => state.setProjectView);
    const storedProjectLayout = useUiStore((state) => (
        selectedProjectId ? state.projectLayouts[selectedProjectId] : undefined
    ));
    const setProjectLayout = useUiStore((state) => state.setProjectLayout);
    const setSelectedProjectId = useCallback(
        (value: string | null) => setProjectView({ selectedProjectId: value }),
        [setProjectView],
    );
    const selectedProject = useMemo(
        () => projects.find((project) => project.id === selectedProjectId),
        [projects, selectedProjectId],
    );
    const selectedProjectRef = useRef<Project | undefined>(selectedProject);
    selectedProjectRef.current = selectedProject;
    const [showNotesPreview, setShowNotesPreview] = useState(true);
    const [showSectionPrompt, setShowSectionPrompt] = useState(false);
    const [sectionDraft, setSectionDraft] = useState('');
    const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
    const [sectionNotesOpen, setSectionNotesOpen] = useState<Record<string, boolean>>({});
    const [archivedSectionCollapsed, setArchivedSectionCollapsed] = useState<Record<string, boolean>>({});
    const [tagDraft, setTagDraft] = useState('');
    // The project the tag draft was last filled from: its save merges against it.
    const tagDraftBaseRef = useRef<Project | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [editProjectTitle, setEditProjectTitle] = useState('');
    // Effective sort is read straight from the selected project so it persists
    // across restarts and view switches; the change handler writes it back via
    // updateProject. Core normalizes 'default' to an absent field.
    const projectTaskSortBy: TaskSortBy = resolveTaskSortByForFeatures(
        selectedProject?.taskSortBy ?? 'default',
        settings,
    );
    const [projectDetailsExpanded, setProjectDetailsExpanded] = useState(false);
    const [projectNotesExpanded, setProjectNotesExpanded] = useState(false);
    const [isProjectDeleting, setIsProjectDeleting] = useState(false);
    const [bulkTokenPicker, setBulkTokenPicker] = useState<BulkTokenPickerState>(null);
    const [bulkOrganizeOpen, setBulkOrganizeOpen] = useState(false);
    const [completedTasksCollapsed, setCompletedTasksCollapsed] = useState(true);
    const [projectTaskToolbarCompact, setProjectTaskToolbarCompact] = useState(false);
    const editingTaskId = useUiStore((state) => state.editingTaskId);
    const projectScrollRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const lastProjectScrollTopRef = useRef(0);
    const pendingProjectScrollRestoreRef = useRef<ProjectScrollSnapshot | null>(null);
    const selectedProjectIdRef = useRef<string | null>(selectedProjectId);
    const isArchivedProject = selectedProject?.status === 'archived';
    const isPerSectionProject = Boolean(selectedProject && getProjectFlowMode(selectedProject) === 'perSection');
    const shouldGroupCompletedTasks = Boolean(
        selectedProject && getProjectFlowMode(selectedProject) === 'parallel' && !isArchivedProject && showCompletedTasks
    );
    const resolveText = useCallback((key: string, fallback: string) => {
        const value = t(key);
        return value && value !== key ? value : fallback;
    }, [t]);
    const archivedReadOnlyHint = `${resolveText('status.archived', 'Archived')}. ${resolveText('projects.reactivate', 'Reactivate')}.`;
    const getMutableSelectedProject = useCallback(() => {
        const current = selectedProjectRef.current;
        if (!current || current.status === 'archived') return null;
        const stored = useTaskStore.getState()._allProjects?.find((project) => project.id === current.id);
        return stored?.status === 'archived' ? null : current;
    }, []);
    const updateMutableSelectedProject = useCallback((updates: Partial<Project>) => {
        const current = getMutableSelectedProject();
        if (!current) return;
        return updateProject(current.id, updates);
    }, [getMutableSelectedProject, updateProject]);

    useLayoutEffect(() => {
        selectedProjectIdRef.current = selectedProjectId;
    }, [selectedProjectId]);

    const captureProjectScrollBeforeLayoutChange = useCallback(() => {
        const scrollElement = projectScrollRef.current;
        if (!scrollElement) return;
        pendingProjectScrollRestoreRef.current = createProjectScrollSnapshot(scrollElement, selectedProjectIdRef.current);
    }, []);

    useLayoutEffect(() => {
        const snapshot = pendingProjectScrollRestoreRef.current;
        if (!snapshot) return;
        pendingProjectScrollRestoreRef.current = null;
        if (selectedProjectIdRef.current !== snapshot.projectId) return;
        const scrollElement = projectScrollRef.current;
        if (!scrollElement) return;
        restoreProjectScrollSnapshot(scrollElement, snapshot);
    });

    const handleProjectScroll = useCallback(() => {
        const scrollElement = projectScrollRef.current;
        if (!scrollElement) return;
        const scrollTop = scrollElement.scrollTop;
        const previousScrollTop = lastProjectScrollTopRef.current;

        setProjectTaskToolbarCompact((current) => {
            if (scrollTop <= PROJECT_TASK_TOOLBAR_EXPAND_SCROLL_Y) return false;
            if (current) return true;
            if (scrollTop > previousScrollTop && scrollTop >= PROJECT_TASK_TOOLBAR_COLLAPSE_SCROLL_Y) return true;
            return current;
        });
        lastProjectScrollTopRef.current = scrollTop;
    }, []);

    useEffect(() => {
        setProjectTaskToolbarCompact(false);
        lastProjectScrollTopRef.current = 0;
    }, [selectedProjectId]);

    const handleClearProjectSearch = useCallback(() => {
        setSearchQuery('');
        searchInputRef.current?.focus();
    }, []);

    const openProjectQuickAdd = useCallback((sectionId?: string | null) => {
        const current = getMutableSelectedProject();
        if (!current) return;
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: {
                initialProps: {
                    projectId: current.id,
                    status: 'next',
                    ...(sectionId ? { sectionId } : {}),
                },
            },
        }));
    }, [getMutableSelectedProject]);

    const {
        handleAddSection,
        handleRenameSection,
        handleDeleteSection,
        handleToggleSection,
        handleToggleSectionNotes,
    } = useProjectSectionActions({
        t,
        selectedProject,
        readOnly: isArchivedProject,
        setEditingSectionId,
        setSectionDraft,
        setShowSectionPrompt,
        deleteSection,
        updateSection,
        setSectionNotesOpen,
        requestConfirmation,
    });

    const normalizedSearchQuery = searchQuery.trim().toLowerCase();

    useEffect(() => {
        setEditProjectTitle(selectedProject?.title ?? '');
    }, [isArchivedProject, selectedProject?.id, selectedProject?.title]);

    useEffect(() => {
        tagDraftBaseRef.current = selectedProject ?? null;
        if (!selectedProject) {
            setTagDraft('');
            return;
        }
        setTagDraft((selectedProject.tagIds || []).join(', '));
    }, [isArchivedProject, selectedProject?.id, selectedProject?.tagIds]);

    useEffect(() => {
        setProjectDetailsExpanded(false);
        setProjectNotesExpanded(false);
    }, [selectedProject?.id]);

    useEffect(() => {
        setCompletedTasksCollapsed(true);
    }, [selectedProject?.id, showCompletedTasks]);

    useEffect(() => {
        setSectionNotesOpen({});
        setArchivedSectionCollapsed({});
    }, [isArchivedProject, selectedProjectId]);

    useEffect(() => {
        if (!isArchivedProject) return;
        setShowSectionPrompt(false);
        setEditingSectionId(null);
        setSectionDraft('');
    }, [isArchivedProject]);

    const projectTaskSource = selectedProjectTasks;
    const projectAllTasks = useMemo(() => {
        if (!selectedProjectId) return [];
        return projectTaskSource.filter((task) => {
            if (task.deletedAt || task.projectId !== selectedProjectId) return false;
            if (normalizedSearchQuery && !task.title.toLowerCase().includes(normalizedSearchQuery)) return false;
            return true;
        });
    }, [projectTaskSource, normalizedSearchQuery, selectedProjectId]);

    const projectTasks = useMemo(
        () => projectAllTasks.filter((task) => shouldShowProjectWorkspaceTask(task, selectedProject, showCompletedTasks)),
        [projectAllTasks, selectedProject, showCompletedTasks],
    );

    const handleProjectTaskSortByChange = useCallback((next: TaskSortBy) => {
        const current = getMutableSelectedProject();
        if (!current) return;
        void Promise.resolve(updateProject(current.id, { taskSortBy: next })).catch((error) => {
            reportError('Failed to update project task sort', error);
        });
    }, [getMutableSelectedProject, updateProject]);

    const sortProjectTasks = useCallback((items: Task[]) => {
        if (projectTaskSortBy !== 'default') {
            return sortTasksBy(items, projectTaskSortBy);
        }
        return [...items].sort(compareTasksByProjectOrder);
    }, [projectTaskSortBy]);

    const sortedProjectTasks = useMemo(() => {
        if (!selectedProject) return projectTasks;
        return sortProjectTasks(projectTasks);
    }, [projectTasks, selectedProject, sortProjectTasks]);

    const { activeTasks: orderedProjectTasks, completedTasks: completedProjectTasks } = useMemo(() => {
        if (!shouldGroupCompletedTasks) {
            return { activeTasks: sortedProjectTasks, completedTasks: [] as Task[] };
        }
        const { activeTasks, completedTasks } = splitCompletedTasks(sortedProjectTasks);
        return {
            activeTasks,
            completedTasks: sortDoneTasksForListView(completedTasks),
        };
    }, [shouldGroupCompletedTasks, sortedProjectTasks]);

    const projectSections = useMemo(
        () => getProjectSectionsForView(selectedProject, sections, allSections),
        [allSections, sections, selectedProject],
    );

    // Progressive disclosure: the layout toggle exists only where sections do,
    // and a project that loses its last section falls back to the list.
    const hasProjectSections = projectSections.length > 0;
    const columnsLayout = hasProjectSections && storedProjectLayout === 'columns';
    const columnsScrollRef = useRef<HTMLDivElement | null>(null);
    const handleColumnsPointerDown = useMiddleMousePan(columnsScrollRef);

    const handleMoveSection = useCallback((sectionId: string, offset: -1 | 1) => {
        const current = getMutableSelectedProject();
        if (!current) return;
        const currentIndex = projectSections.findIndex((section) => section.id === sectionId);
        const nextIndex = currentIndex + offset;
        if (currentIndex < 0 || nextIndex < 0 || nextIndex >= projectSections.length) return;
        const nextSections = [...projectSections];
        const [moved] = nextSections.splice(currentIndex, 1);
        if (!moved) return;
        nextSections.splice(nextIndex, 0, moved);
        void Promise.resolve(reorderSections(current.id, nextSections.map((section) => section.id))).catch((error) => {
            reportError('Failed to reorder sections', error);
            showToast(resolveText('projects.sectionReorderFailed', 'Failed to reorder sections.'), 'error');
        });
    }, [getMutableSelectedProject, projectSections, reorderSections, resolveText, showToast]);

    const sectionTaskGroups = useMemo(() => {
        if (!selectedProjectId || projectSections.length === 0) {
            return { sections: [] as Array<{ section: Section; tasks: Task[] }>, unsectioned: orderedProjectTasks };
        }

        const sectionIds = new Set(projectSections.map((section) => section.id));
        const tasksBySection = new Map<string, Task[]>();
        const unsectioned: Task[] = [];

        orderedProjectTasks.forEach((task) => {
            const sectionId = task.sectionId && sectionIds.has(task.sectionId) ? task.sectionId : null;
            if (sectionId) {
                const list = tasksBySection.get(sectionId) ?? [];
                list.push(task);
                tasksBySection.set(sectionId, list);
            } else {
                unsectioned.push(task);
            }
        });

        return {
            sections: projectSections.map((section) => ({
                section,
                tasks: sortProjectTasks(tasksBySection.get(section.id) ?? []),
            })),
            unsectioned: sortProjectTasks(unsectioned),
        };
    }, [orderedProjectTasks, projectSections, selectedProjectId, sortProjectTasks]);

    // "No Section" is a bucket, not a section: it renders after the named
    // sections and only while it has tasks. During a live drag it must exist
    // even when empty — it's the drop target that clears a task's section.
    const [taskDragActive, setTaskDragActive] = useState(false);
    useDndMonitor(useMemo(() => ({
        onDragStart: () => setTaskDragActive(true),
        onDragEnd: () => setTaskDragActive(false),
        onDragCancel: () => setTaskDragActive(false),
    }), []));
    const showUnsectionedGroup = sectionTaskGroups.unsectioned.length > 0 || taskDragActive;

    const orderedProjectTaskList = useMemo(() => {
        if (projectSections.length === 0) return [...orderedProjectTasks, ...completedProjectTasks];
        const combined: Task[] = [];
        sectionTaskGroups.sections.forEach((group) => {
            combined.push(...group.tasks);
        });
        if (sectionTaskGroups.unsectioned.length > 0) {
            combined.push(...sectionTaskGroups.unsectioned);
        }
        if (completedProjectTasks.length > 0) {
            combined.push(...completedProjectTasks);
        }
        return combined;
    }, [completedProjectTasks, orderedProjectTasks, projectSections.length, sectionTaskGroups.sections, sectionTaskGroups.unsectioned]);
    const projectTaskSequenceCues = useMemo<Map<string, ProjectSequenceTaskCue>>(() => {
        if (!selectedProject || projectTaskSortBy !== 'default') return new Map();
        return getSequentialProjectTaskCues(selectedProject, selectedProjectTasks, projectSections);
    }, [projectSections, projectTaskSortBy, selectedProject, selectedProjectTasks]);
    const availableSequenceLabel = resolveText('projects.availableNextAction', 'Available next action');
    const laterSequenceLabel = resolveText('projects.laterInSequence', 'Later in sequence');
    const visibleProjectTaskList = useMemo(() => {
        if (projectSections.length === 0) {
            return completedTasksCollapsed
                ? orderedProjectTasks
                : [...orderedProjectTasks, ...completedProjectTasks];
        }
        const combined: Task[] = [];
        // Keyboard order follows reading order: named sections, then the
        // unsectioned tasks, in both layouts — "No Section" renders last.
        sectionTaskGroups.sections.forEach((group) => {
            if (!group.section.isCollapsed) {
                combined.push(...group.tasks);
            }
        });
        combined.push(...sectionTaskGroups.unsectioned);
        if (!completedTasksCollapsed) {
            combined.push(...completedProjectTasks);
        }
        return combined;
    }, [completedProjectTasks, completedTasksCollapsed, orderedProjectTasks, projectSections.length, sectionTaskGroups.sections, sectionTaskGroups.unsectioned]);
    const visibleProjectTaskIds = useMemo(
        () => visibleProjectTaskList.map((task) => task.id),
        [visibleProjectTaskList],
    );
    // Deliberately over allTasks (visible tasks), not the store's _tasksById
    // (all tasks incl. hidden) — PERF-03 leaves this site alone on purpose.
    const tasksById = useMemo(() => new Map(allTasks.map((task) => [task.id, task])), [allTasks]);
    const {
        activeAction,
        allVisibleTasksSelected,
        moveSelectedTasksToDestination,
        clearTaskSelection,
        deleteSelectedTasks,
        exitSelectionMode: exitTaskSelectionMode,
        exportSelectedTasks,
        isExporting,
        multiSelectedIds,
        moveSelectedTasks,
        organizeSelectedTasks,
        selectedIdsArray,
        selectionMode,
        selectAllVisibleTasks,
        setSelectionMode,
        toggleMultiSelect,
        updateSelectedTaskTokens,
    } = useTaskSelection(visibleProjectTaskIds, {
        batchDeleteTasks,
        batchMoveTasks,
        batchUpdateTasks,
        restoreTask,
        showToast,
        t,
        tasksById,
        undoNotificationsEnabled,
    });
    const addTagOptions = useMemo(
        () => allTokens.filter((token) => token.startsWith('#')),
        [allTokens],
    );
    const addContextOptions = useMemo(
        () => allTokens.filter((token) => token.startsWith('@')),
        [allTokens],
    );
    const removableTagOptions = useMemo(
        () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'tags'),
        [selectedIdsArray, tasksById],
    );
    const removableContextOptions = useMemo(
        () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'contexts'),
        [selectedIdsArray, tasksById],
    );

    const exitSelectionMode = useCallback(() => {
        exitTaskSelectionMode();
        setBulkTokenPicker(null);
        setBulkOrganizeOpen(false);
    }, [exitTaskSelectionMode]);

    useEffect(() => {
        exitSelectionMode();
    }, [exitSelectionMode, isArchivedProject, selectedProjectId]);

    const handleBatchMove = useCallback((...args: Parameters<typeof moveSelectedTasks>) => {
        if (!getMutableSelectedProject()) return;
        return moveSelectedTasks(...args);
    }, [getMutableSelectedProject, moveSelectedTasks]);

    const handleBatchMoveToDestination = useCallback((...args: Parameters<typeof moveSelectedTasksToDestination>) => {
        if (!getMutableSelectedProject()) return;
        return moveSelectedTasksToDestination(...args);
    }, [moveSelectedTasksToDestination, getMutableSelectedProject]);

    const handleApplyTaskBulkOrganize = useCallback(async (input: BulkOrganizeTaskUpdateInput) => {
        if (!getMutableSelectedProject()) return;
        await organizeSelectedTasks(input, {
            afterSuccess: () => setBulkOrganizeOpen(false),
        });
    }, [getMutableSelectedProject, organizeSelectedTasks]);

    const handleBatchDelete = useCallback(async () => {
        if (!getMutableSelectedProject()) return;
        await deleteSelectedTasks({
            confirm: async () => {
                const confirmed = await requestConfirmation({
                    title: tFallback(t, 'common.delete', 'Delete'),
                    description: tFallback(t, 'list.confirmBatchDelete', 'Delete selected tasks?'),
                    confirmLabel: tFallback(t, 'common.delete', 'Delete'),
                    cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
                });
                return confirmed && Boolean(getMutableSelectedProject());
            },
        });
    }, [deleteSelectedTasks, getMutableSelectedProject, requestConfirmation, t]);

    const handleBatchTokenPick = useCallback((field: 'tags' | 'contexts', action: 'add' | 'remove') => {
        if (!getMutableSelectedProject() || selectedIdsArray.length === 0) return;
        setBulkTokenPicker({ field, action });
    }, [getMutableSelectedProject, selectedIdsArray.length]);

    const handleBulkTokenConfirm = useCallback(async (values: string[]) => {
        if (!getMutableSelectedProject() || !bulkTokenPicker || selectedIdsArray.length === 0) return;
        await updateSelectedTaskTokens(
            bulkTokenPicker.field,
            values,
            bulkTokenPicker.action,
            {
                afterNoop: () => setBulkTokenPicker(null),
                afterSuccess: () => setBulkTokenPicker(null),
            },
        );
    }, [bulkTokenPicker, getMutableSelectedProject, selectedIdsArray.length, updateSelectedTaskTokens]);

    const projectReferenceTasks = useMemo(() => {
        if (!selectedProject) return [] as Task[];

        const projectTagSet = new Set((selectedProject.tagIds || []).map((tag) => String(tag).toLowerCase()));
        const isProjectTagMatch = (task: Task) => {
            if (projectTagSet.size === 0) return false;
            return (task.tags || []).some((tag) => projectTagSet.has(String(tag).toLowerCase()));
        };

        const references = allTasks.filter((task) => {
            if (task.deletedAt) return false;
            if (task.status !== 'reference') return false;
            if (normalizedSearchQuery && !task.title.toLowerCase().includes(normalizedSearchQuery)) return false;
            if (task.projectId === selectedProject.id) return true;
            return isProjectTagMatch(task);
        });

        return sortProjectTasks(references);
    }, [allTasks, normalizedSearchQuery, selectedProject, sortProjectTasks]);

    const referenceTaskGroups = useMemo(() => {
        if (!hasProjectSections) return [];
        const tasksBySection = new Map<string, Task[]>(projectSections.map((section) => [section.id, []]));
        const unsectioned: Task[] = [];
        // References are already sorted; retain that order within each bucket.
        for (const task of projectReferenceTasks) {
            const sectionTasks = task.projectId === selectedProjectId && task.sectionId
                ? tasksBySection.get(task.sectionId)
                : undefined;
            (sectionTasks ?? unsectioned).push(task);
        }
        return [
            ...projectSections.map((section) => ({
                id: section.id,
                title: section.title,
                tasks: tasksBySection.get(section.id)!,
            })),
            { id: NO_SECTION_CONTAINER, title: t('projects.noSection'), tasks: unsectioned },
        ].filter((group) => group.tasks.length > 0);
    }, [hasProjectSections, projectReferenceTasks, projectSections, selectedProjectId, t]);

    // Reference tasks render as their own section below the task list, so the
    // keyboard walks them last rather than skipping them.
    const keyboardVisibleTasks = useMemo(
        () => [
            ...visibleProjectTaskList,
            ...(hasProjectSections ? referenceTaskGroups.flatMap((group) => group.tasks) : projectReferenceTasks),
        ],
        [hasProjectSections, projectReferenceTasks, referenceTaskGroups, visibleProjectTaskList],
    );
    const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);
    // Last highlight id whose row was handed DOM focus (#1014).
    const focusedHighlightIdRef = useRef<string | null>(null);
    useTaskListScope({
        getTasks: () => keyboardVisibleTasks,
        getSelectedIds: () => multiSelectedIds,
        getSelectedIndex: () => selectedTaskIndex,
        setSelectedIndex: setSelectedTaskIndex,
        t,
        toggleSelect: (task) => toggleMultiSelect(task.id),
    });

    useEffect(() => {
        if (!highlightTaskId) {
            focusedHighlightIdRef.current = null;
            return;
        }
        const exists = [...orderedProjectTaskList, ...projectReferenceTasks].some((task) => task.id === highlightTaskId);
        if (!exists) return;
        // Focus once per highlight: the effect re-runs on list changes during
        // the flash window, and refocusing then could steal focus from a modal
        // the user already opened on the revealed task (#1014).
        if (focusedHighlightIdRef.current !== highlightTaskId) {
            focusedHighlightIdRef.current = highlightTaskId;
            focusTaskRowWhenMounted(highlightTaskId);
        }
        let retryTimer: number | null = null;
        let cancelled = false;
        let attempts = 0;
        const scrollHighlightedTask = () => {
            if (cancelled) return;
            const el = document.querySelector(`[data-task-id="${highlightTaskId}"]`) as HTMLElement | null;
            if (el) {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    }, [highlightTaskId, orderedProjectTaskList, projectReferenceTasks, setHighlightTask]);

    const { taskIdsByContainer, taskIdToContainer } = useMemo(() => {
        const idsByContainer = new Map<string, string[]>();
        const idToContainer = new Map<string, string>();

        sectionTaskGroups.sections.forEach((group) => {
            const containerId = getSectionContainerId(group.section.id);
            const ids = group.tasks.map((task) => task.id);
            idsByContainer.set(containerId, ids);
            ids.forEach((id) => idToContainer.set(id, containerId));
        });

        const unsectionedIds = sectionTaskGroups.unsectioned.map((task) => task.id);
        idsByContainer.set(NO_SECTION_CONTAINER, unsectionedIds);
        unsectionedIds.forEach((id) => idToContainer.set(id, NO_SECTION_CONTAINER));

        return { taskIdsByContainer: idsByContainer, taskIdToContainer: idToContainer };
    }, [sectionTaskGroups]);

    const canReorderProjectTasks = !isArchivedProject && projectTaskSortBy === 'default';

    const handleTaskDragEnd = useCallback((event: DragEndEvent) => {
        const current = getMutableSelectedProject();
        if (!current || !selectedProject || isArchivedProject) return;
        // In non-default sort modes the list is not a drop target; tasks can only
        // be dragged out to the sidebar (handled by the Projects view).
        if (!canReorderProjectTasks) return;

        const failTaskMove = (error: unknown) => {
            reportError('Failed to reorder project tasks', error);
            showToast(tFallback(t, 'projects.taskMoveFailed', 'Failed to move task'), 'error');
        };

        const { active, over } = event;
        if (!over) return;

        const activeId = String(active.id);
        const overId = String(over.id);
        const sourceContainer = taskIdToContainer.get(activeId);
        const destinationContainer =
            taskIdToContainer.get(overId) ||
            (taskIdsByContainer.has(overId) ? overId : undefined);
        if (!sourceContainer || !destinationContainer) return;

        const sourceItems = taskIdsByContainer.get(sourceContainer) ?? [];
        const destinationItems = taskIdsByContainer.get(destinationContainer) ?? [];

        if (sourceContainer === destinationContainer) {
            const oldIndex = sourceItems.indexOf(activeId);
            if (oldIndex === -1) return;
            const newIndex = taskIdToContainer.has(overId)
                ? sourceItems.indexOf(overId)
                : sourceItems.length - 1;
            if (newIndex === -1 || oldIndex === newIndex) return;
            const reordered = arrayMove(sourceItems, oldIndex, newIndex);
            void Promise.resolve(
                reorderProjectTasks(current.id, reordered, getSectionIdFromContainer(sourceContainer), activeId),
            ).catch(failTaskMove);
            return;
        }

        const sourceIndex = sourceItems.indexOf(activeId);
        if (sourceIndex === -1) return;
        const nextSourceItems = [...sourceItems];
        nextSourceItems.splice(sourceIndex, 1);

        const nextDestinationItems = [...destinationItems];
        const overIndex = taskIdToContainer.has(overId) ? nextDestinationItems.indexOf(overId) : -1;
        const insertIndex = overIndex === -1 ? nextDestinationItems.length : overIndex;
        nextDestinationItems.splice(insertIndex, 0, activeId);

        const nextSectionId = getSectionIdFromContainer(destinationContainer) ?? undefined;
        void (async () => {
            const updateResult = await Promise.resolve(updateTask(activeId, { sectionId: nextSectionId }));
            if (updateResult && updateResult.success === false) {
                throw new Error(updateResult.error || 'Failed to move task');
            }
            if (getMutableSelectedProject()?.id !== current.id) return;
            if (nextSourceItems.length > 0) {
                await Promise.resolve(
                    reorderProjectTasks(current.id, nextSourceItems, getSectionIdFromContainer(sourceContainer)),
                );
            }
            if (getMutableSelectedProject()?.id !== current.id) return;
            await Promise.resolve(
                reorderProjectTasks(current.id, nextDestinationItems, getSectionIdFromContainer(destinationContainer), activeId),
            );
        })().catch(failTaskMove);
    }, [canReorderProjectTasks, getMutableSelectedProject, isArchivedProject, reorderProjectTasks, selectedProject, showToast, taskIdToContainer, taskIdsByContainer, updateTask]);

    useEffect(() => {
        taskDragEndRef.current = handleTaskDragEnd;
        return () => {
            taskDragEndRef.current = null;
        };
    }, [handleTaskDragEnd, taskDragEndRef]);

    const renderSortableTasks: RenderProjectTasks = (list, scrollRef = projectScrollRef) => (
        <SortableContext items={list.map((task) => task.id)} strategy={verticalListSortingStrategy}>
            <ProjectTaskRows
                tasks={list}
                scrollRef={scrollRef}
                pinnedTaskId={editingTaskId ?? highlightTaskId}
                renderTask={(task) => (
                    <SortableProjectTaskRow
                        key={task.id}
                        task={task}
                        project={selectedProject!}
                        onToggleSelect={(options) => toggleMultiSelect(task.id, options)}
                        interactionDisabled={isArchivedProject}
                        narrow={columnsLayout}
                        sequenceCue={projectTaskSequenceCues.get(task.id)}
                        availableSequenceLabel={availableSequenceLabel}
                        laterSequenceLabel={laterSequenceLabel}
                        dragLabel={`${t('board.dragTask')}: ${t('task.moveToProjectOrArea')}`}
                    />
                )}
            />
        </SortableContext>
    );

    const renderDraggableTasks: RenderProjectTasks = (list, scrollRef = projectScrollRef) => (
        <ProjectTaskRows
            tasks={list}
            scrollRef={scrollRef}
            pinnedTaskId={editingTaskId ?? highlightTaskId}
            renderTask={(task) => (
                <DraggableProjectTaskRow
                    key={task.id}
                    task={task}
                    project={selectedProject!}
                    onToggleSelect={(options) => toggleMultiSelect(task.id, options)}
                    interactionDisabled={isArchivedProject}
                    narrow={columnsLayout}
                    sequenceCue={projectTaskSequenceCues.get(task.id)}
                    availableSequenceLabel={availableSequenceLabel}
                    laterSequenceLabel={laterSequenceLabel}
                    dragLabel={`${t('board.dragTask')}: ${t('task.moveToProjectOrArea')}`}
                />
            )}
        />
    );

    const renderSelectableTasks: RenderProjectTasks = (list, scrollRef = projectScrollRef) => (
        <ProjectTaskRows
            tasks={list}
            scrollRef={scrollRef}
            pinnedTaskId={editingTaskId ?? highlightTaskId}
            renderTask={(task) => (
                <TaskItem
                    key={task.id}
                    task={task}
                    project={selectedProject}
                    enableDoubleClickEdit
                    showProjectBadgeInActions={false}
                    showProjectBadgeInMetadata={false}
                    interactionDisabled={isArchivedProject}
                    selectionMode={selectionMode}
                    isMultiSelected={multiSelectedIds.has(task.id)}
                    onToggleSelect={(options) => toggleMultiSelect(task.id, options)}
                />
            )}
        />
    );

    const renderStaticTasks: RenderProjectTasks = (list, scrollRef = projectScrollRef) => (
        <ProjectTaskRows
            tasks={list}
            scrollRef={scrollRef}
            pinnedTaskId={editingTaskId ?? highlightTaskId}
            renderTask={(task) => (
                <TaskItem
                    key={task.id}
                    task={task}
                    project={selectedProject}
                    onToggleSelect={isArchivedProject || task.status === 'reference'
                        ? undefined
                        : (options) => toggleMultiSelect(task.id, options)}
                    enableDoubleClickEdit
                    showProjectBadgeInActions={false}
                    showProjectBadgeInMetadata={false}
                    interactionDisabled={isArchivedProject}
                />
            )}
        />
    );

    const renderCompletedTaskGroup = () => {
        if (completedProjectTasks.length === 0) return null;
        const completedLabel = resolveText('list.done', resolveText('status.done', 'Completed'));
        const renderCompletedTasks = selectionMode ? renderSelectableTasks : renderStaticTasks;

        return (
            <div className="border-b border-border/50">
                <button
                    type="button"
                    onClick={() => {
                        captureProjectScrollBeforeLayoutChange();
                        setCompletedTasksCollapsed((value) => !value);
                    }}
                    aria-expanded={!completedTasksCollapsed}
                    data-project-completed-toggle
                    className="flex w-full items-center justify-between border-b border-border/50 px-3 py-2 text-left text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
                >
                    <span className="flex items-center gap-2">
                        {completedTasksCollapsed ? (
                            <ChevronRight className="h-4 w-4" />
                        ) : (
                            <ChevronDown className="h-4 w-4" />
                        )}
                        <CheckCircle2 className="h-4 w-4" />
                        <span>{completedLabel}</span>
                    </span>
                    <span className="text-xs">{completedProjectTasks.length}</span>
                </button>
                {!completedTasksCollapsed && (
                    <div className="p-3">
                        {renderCompletedTasks(completedProjectTasks)}
                    </div>
                )}
            </div>
        );
    };

    // One header for both layouts; only the reorder arrows change axis, because
    // in columns the same section order reads left-to-right.
    const renderSectionHeader = (
        group: { section: Section; tasks: Task[] },
        index: number,
        orientation: 'vertical' | 'horizontal',
    ) => {
        const isCollapsed = isArchivedProject
            ? (archivedSectionCollapsed[group.section.id] ?? group.section.isCollapsed ?? false)
            : Boolean(group.section.isCollapsed);
        const hasNotes = Boolean(group.section.description?.trim());
        const notesOpen = sectionNotesOpen[group.section.id] ?? false;
        const canMoveBack = index > 0;
        const canMoveForward = index < sectionTaskGroups.sections.length - 1;
        const isHorizontal = orientation === 'horizontal';
        const moveBackLabel = isHorizontal
            ? resolveText('projects.moveSectionLeft', 'Move section left')
            : resolveText('projects.moveSectionUp', 'Move section up');
        const moveForwardLabel = isHorizontal
            ? resolveText('projects.moveSectionRight', 'Move section right')
            : resolveText('projects.moveSectionDown', 'Move section down');
        // Hidden while the editor is open: the textarea below already shows the
        // notes, and it saves on blur, so a preview would sit there stale.
        const notesPreview = hasNotes && !notesOpen
            ? getInlineMarkdownPreview(group.section.description ?? '').slice(0, SECTION_NOTES_PREVIEW_MAX_CHARS)
            : '';
        // The tooltip is plain text, so it gets the markers stripped rather than
        // rendered, and an ellipsis where the preview cut the notes short.
        const notesTooltip = notesPreview
            ? (() => {
                const stripped = stripMarkdown(getInlineMarkdownPreview(group.section.description ?? ''));
                return stripped.length > SECTION_NOTES_PREVIEW_MAX_CHARS
                    ? `${stripped.slice(0, SECTION_NOTES_PREVIEW_MAX_CHARS).trimEnd()}…`
                    : stripped;
            })()
            : '';
        const moreOptionsLabel = resolveText('taskEdit.moreOptions', 'More options');
        // Per section Flow mode (#1429): the label and menu choice appear only then.
        const sectionFlowLabel = isPerSectionProject
            ? (group.section.isSequential === true ? t('projects.sequential') : t('projects.parallel'))
            : null;

        return (
            <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={() => {
                        if (isArchivedProject) {
                            setArchivedSectionCollapsed((current) => ({
                                ...current,
                                [group.section.id]: !isCollapsed,
                            }));
                            return;
                        }
                        handleToggleSection(group.section);
                    }}
                    className="project-section-title flex min-w-0 items-center gap-3 text-base font-semibold"
                >
                    {isCollapsed ? (
                        <ChevronRight className="h-4 w-4 flex-none text-muted-foreground" />
                    ) : (
                        <ChevronDown className="h-4 w-4 flex-none text-muted-foreground" />
                    )}
                    <span className="truncate">{group.section.title}</span>
                    <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{group.tasks.length}</span>
                    {sectionFlowLabel && (
                        <span data-section-flow-label className="text-xs font-normal text-muted-foreground">
                            {sectionFlowLabel}
                        </span>
                    )}
                </button>
                <div className="flex items-center gap-1">
                    {!isArchivedProject && (
                        <button
                            type="button"
                            data-add-task-trigger
                            onClick={() => openProjectQuickAdd(group.section.id)}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                            aria-label={t('projects.addTask')}
                        >
                            <Plus className="h-3.5 w-3.5" />
                        </button>
                    )}
                    <ProjectSectionActionsMenu
                        sectionTitle={group.section.title}
                        orientation={orientation}
                        moreOptionsLabel={moreOptionsLabel}
                        moveBackLabel={moveBackLabel}
                        moveForwardLabel={moveForwardLabel}
                        notesLabel={t('projects.sectionNotes')}
                        editLabel={t('common.edit')}
                        deleteLabel={t('common.delete')}
                        canMoveBack={sectionTaskGroups.sections.length > 1 && canMoveBack}
                        canMoveForward={sectionTaskGroups.sections.length > 1 && canMoveForward}
                        readOnly={isArchivedProject}
                        readOnlyHint={archivedReadOnlyHint}
                        notesActive={hasNotes || notesOpen}
                        onMoveBack={() => handleMoveSection(group.section.id, -1)}
                        onMoveForward={() => handleMoveSection(group.section.id, 1)}
                        onToggleNotes={() => handleToggleSectionNotes(group.section.id)}
                        onRename={() => handleRenameSection(group.section)}
                        onDelete={() => handleDeleteSection(group.section)}
                        flow={isPerSectionProject ? {
                            label: resolveText('projects.sequenceMode', 'Flow Mode'),
                            parallelLabel: t('projects.parallel'),
                            sequentialLabel: t('projects.sequential'),
                            isSequential: group.section.isSequential === true,
                            onChange: (isSequential) => {
                                if (!getMutableSelectedProject()) return;
                                void updateSection(group.section.id, { isSequential });
                            },
                        } : undefined}
                    />
                </div>
                {notesPreview && (
                    <div
                        data-section-notes-preview
                        title={notesTooltip}
                        className="w-full truncate text-xs font-normal text-muted-foreground"
                    >
                        <InlineMarkdown markdown={notesPreview} interactiveLinks={false} />
                    </div>
                )}
            </div>
        );
    };

    // Every section body in both layouts shows this: an empty *section* is not
    // an empty project, so it must not borrow the project-level empty copy.
    const sectionEmptyState = (
        <div className="py-2 text-xs text-muted-foreground">
            {t('projects.sectionEmpty')}
        </div>
    );

    const renderSectionNotes = (section: Section) => {
        if (!(sectionNotesOpen[section.id] ?? false)) return null;
        if (isArchivedProject) {
            return (
                <div className="border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
                    <InlineMarkdown markdown={section.description || ''} interactiveLinks={false} />
                </div>
            );
        }
        return (
            <div className="border-b border-border/50 px-3 py-2">
                <textarea
                    className="min-h-[90px] w-full resize-y rounded border border-border bg-background p-2 text-xs focus:bg-accent/5 focus:outline-none"
                    placeholder={t('projects.sectionNotesPlaceholder')}
                    defaultValue={section.description || ''}
                    onBlur={(event) => {
                        if (!getMutableSelectedProject()) return;
                        const nextValue = event.target.value.trimEnd();
                        updateSection(section.id, { description: nextValue || undefined });
                    }}
                />
            </div>
        );
    };

    // Sections as side-by-side columns (#1019). The drop containers, the
    // sortable contexts and the drag-end resolver are the list layout's — only
    // the box the sections sit in changes, so cross-column drops are the same
    // cross-section drops the stacked layout already performed.
    const renderProjectSectionColumns = (renderTasks: RenderProjectTasks) => (
        <div className="space-y-3">
            <div
                ref={columnsScrollRef}
                data-project-section-columns
                onPointerDown={handleColumnsPointerDown}
                className="flex items-start gap-3 overflow-x-auto pb-2"
            >
                {sectionTaskGroups.sections.map((group, index) => (
                    <ProjectSectionColumn
                        key={group.section.id}
                        id={getSectionContainerId(group.section.id)}
                        header={renderSectionHeader(group, index, 'horizontal')}
                        notes={renderSectionNotes(group.section)}
                        collapsed={isArchivedProject
                            ? (archivedSectionCollapsed[group.section.id] ?? group.section.isCollapsed ?? false)
                            : Boolean(group.section.isCollapsed)}
                    >
                        {(scrollRef) => (group.tasks.length > 0 ? (
                            renderTasks(group.tasks, scrollRef)
                        ) : (
                            sectionEmptyState
                        ))}
                    </ProjectSectionColumn>
                ))}
                {showUnsectionedGroup && (
                    <ProjectSectionColumn
                        id={NO_SECTION_CONTAINER}
                        dashed
                        header={(
                            <div className="flex items-center gap-2 text-sm font-semibold">
                                <span className="truncate">{t('projects.noSection')}</span>
                                <span className="text-xs text-muted-foreground">
                                    {sectionTaskGroups.unsectioned.length}
                                </span>
                            </div>
                        )}
                    >
                        {(scrollRef) => (sectionTaskGroups.unsectioned.length > 0 ? (
                            renderTasks(sectionTaskGroups.unsectioned, scrollRef)
                        ) : (
                            sectionEmptyState
                        ))}
                    </ProjectSectionColumn>
                )}
            </div>
            {renderCompletedTaskGroup()}
        </div>
    );

    const renderProjectSections = (renderTasks: RenderProjectTasks) => {
        if (projectSections.length === 0) {
            return (
                <div className="space-y-3">
                    <SectionDropZone
                        id={NO_SECTION_CONTAINER}
                        className="min-h-[120px] py-1"
                    >
                        {orderedProjectTasks.length > 0 ? (
                            renderTasks(orderedProjectTasks)
                        ) : (
                            <div className="py-12 text-center text-muted-foreground">
                                {t('projects.noActiveTasks')}
                            </div>
                        )}
                    </SectionDropZone>
                    {renderCompletedTaskGroup()}
                </div>
            );
        }

        return (
            <div className="space-y-3">
                {sectionTaskGroups.sections.map((group, index) => (
                    <SectionDropZone
                        key={group.section.id}
                        id={getSectionContainerId(group.section.id)}
                        className="border-b border-border/40 pb-3"
                    >
                        <div className="border-b border-border/50 px-1 py-3">
                            {renderSectionHeader(group, index, 'vertical')}
                        </div>
                        {renderSectionNotes(group.section)}
                        {!(isArchivedProject
                            ? (archivedSectionCollapsed[group.section.id] ?? group.section.isCollapsed ?? false)
                            : Boolean(group.section.isCollapsed)) && (
                            <div className="px-1 py-1">
                                {group.tasks.length > 0 ? (
                                    renderTasks(group.tasks)
                                ) : (
                                    sectionEmptyState
                                )}
                            </div>
                        )}
                    </SectionDropZone>
                ))}
                {showUnsectionedGroup && (
                    <SectionDropZone
                        id={NO_SECTION_CONTAINER}
                        className="border-b border-border/40 pb-3"
                    >
                        <div className="flex items-center justify-between px-1 py-3">
                            <div className="flex items-center gap-2 text-sm font-semibold">
                                <span>{t('projects.noSection')}</span>
                                <span className="text-xs text-muted-foreground">
                                    {sectionTaskGroups.unsectioned.length}
                                </span>
                            </div>
                        </div>
                        <div className="px-1 py-1">
                            {sectionTaskGroups.unsectioned.length > 0 ? (
                                renderTasks(sectionTaskGroups.unsectioned)
                            ) : (
                                sectionEmptyState
                            )}
                        </div>
                    </SectionDropZone>
                )}
                {sectionTaskGroups.sections.length === 0 && sectionTaskGroups.unsectioned.length === 0 && (
                    <div className="py-12 text-center text-muted-foreground">
                        {t('projects.noActiveTasks')}
                    </div>
                )}
                {renderCompletedTaskGroup()}
            </div>
        );
    };

    const renderSectionLayout = columnsLayout ? renderProjectSectionColumns : renderProjectSections;
    const tasksContent = renderSectionLayout(
        isArchivedProject
            ? renderStaticTasks
            : selectionMode
            ? renderSelectableTasks
            : !canReorderProjectTasks
                ? renderDraggableTasks
                : renderSortableTasks,
    );

    const visibleAttachments = (selectedProject?.attachments || []).filter((attachment) => !attachment.deletedAt);
    const completedProjectTaskCount = projectAllTasks.filter((task) => task.status === 'done').length;
    const projectProgress = (() => {
        if (!selectedProjectId) return null;
        if (isArchivedProject) {
            const completedCount = projectAllTasks.filter((task) => isTaskCompleted(task)).length;
            return {
                doneCount: completedCount,
                remainingCount: 0,
                total: completedCount,
                isArchived: true,
            };
        }
        const doneCount = projectAllTasks.filter((task) => task.status === 'done').length;
        const remainingCount = projectAllTasks.filter((task) => shouldShowProjectWorkspaceTask(task, selectedProject, false)).length;
        return {
            doneCount,
            remainingCount,
            total: doneCount + remainingCount,
        };
    })();

    const handleCommitProjectTitle = () => {
        const current = getMutableSelectedProject();
        if (!current) {
            if (selectedProjectRef.current) setEditProjectTitle(selectedProjectRef.current.title);
            return;
        }
        const nextTitle = editProjectTitle.trim();
        if (!nextTitle) {
            setEditProjectTitle(current.title);
            return;
        }
        if (nextTitle !== current.title) {
            updateProject(current.id, { title: nextTitle });
        }
    };

    const handleResetProjectTitle = () => {
        if (!selectedProject) return;
        setEditProjectTitle(selectedProject.title);
    };

    // Archive without a confirmation: the action is fully reversible from the
    // same header slot (the button becomes Reactivate and task statuses are
    // restored), matching the mobile editor. Delete keeps its confirmation.
    const handleArchiveProject = async () => {
        const current = getMutableSelectedProject();
        if (!current) return;
        try {
            await Promise.resolve(updateProject(current.id, { status: 'archived' }));
        } catch (error) {
            reportError('Failed to archive project', error);
            showToast(tFallback(t, 'projects.archiveFailed', 'Failed to archive project'), 'error');
        }
    };

    const handleCancelProject = async () => {
        const current = getMutableSelectedProject();
        if (!current) return;
        const projectId = current.id;
        const confirmed = await requestConfirmation({
            title: tFallback(t, 'projects.cancelConfirmTitle', 'Cancel project?'),
            description: tFallback(
                t,
                'projects.cancelConfirmBody',
                'Cancel this project and its unfinished tasks? Completed work and project history will be kept.',
            ),
            confirmLabel: tFallback(t, 'projects.cancel', 'Cancel project'),
            cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
        });
        if (!confirmed || getMutableSelectedProject()?.id !== projectId) return;
        try {
            const result = await cancelProject(projectId);
            if (!result.success) {
                showToast(result.error || tFallback(t, 'projects.cancelFailed', 'Failed to cancel project'), 'error');
            }
        } catch (error) {
            reportError('Failed to cancel project', error);
            showToast(tFallback(t, 'projects.cancelFailed', 'Failed to cancel project'), 'error');
        }
    };

    const handleDeleteProject = async () => {
        const current = getMutableSelectedProject();
        if (!current) return;
        const projectId = current.id;
        const projectTitle = current.title;
        try {
            const confirmed = await requestConfirmation({
                title: tFallback(t, 'common.delete', 'Delete'),
                description: t('projects.deleteConfirm'),
                confirmLabel: tFallback(t, 'common.delete', 'Delete'),
                cancelLabel: tFallback(t, 'common.cancel', 'Cancel'),
            });
            if (confirmed && getMutableSelectedProject()?.id === projectId) {
                setIsProjectDeleting(true);
                try {
                    // Deleting detaches the project's tasks, and only Undo can know
                    // which they were -- the links must be read before the delete.
                    const detachedTasks = collectProjectTaskLinks(projectId);
                    await Promise.resolve(deleteProject(projectId));
                    setSelectedProjectId(null);
                    showUndoToast(resolveText('projects.deleted', 'Project moved to Trash'), () => {
                        void undoProjectDelete(projectId, detachedTasks)
                            .then(() => setSelectedProjectId(projectId))
                            .catch((error) => {
                                reportError('Failed to restore project', error);
                                showToast(resolveText('projects.restoreFailed', 'Failed to restore project'), 'error');
                            });
                    }, t);
                } finally {
                    setIsProjectDeleting(false);
                }
            }
        } catch (error) {
            reportError('Failed to delete project', error);
            showToast(resolveText('projects.deleteFailed', `Failed to delete ${projectTitle || 'project'}`), 'error');
            setIsProjectDeleting(false);
        }
    };

    const {
        attachmentError,
        showLinkPrompt,
        setShowLinkPrompt,
        isProjectAttachmentBusy,
        openAttachment,
        addProjectFileAttachment,
        addProjectLinkAttachment,
        addProjectFolderLinkAttachment,
        removeProjectAttachment,
    } = useProjectAttachmentActions({
        t,
        selectedProject,
        readOnly: isArchivedProject,
    });

    const selectedProjectAreaLabel = (() => {
        if (!selectedProject?.areaId) return undefined;
        return areaById.get(selectedProject.areaId)?.name;
    })();
    const expandProjectsSidebarLabel = resolveText('projects.expandSidebar', 'Expand projects panel');
    const showProjectsSidebarToggle = projectsSidebarCollapsed && Boolean(onToggleProjectsSidebar);
    const removeTagLabel = resolveText('bulk.removeTag', 'Remove tag');
    const tokenPickerTitle = (() => {
        if (!bulkTokenPicker) return '';
        if (bulkTokenPicker.field === 'tags') {
            return bulkTokenPicker.action === 'add' ? t('bulk.addTag') : removeTagLabel;
        }
        return bulkTokenPicker.action === 'add' ? t('bulk.addContext') : t('bulk.removeContext');
    })();
    const tokenPickerOptions = (() => {
        if (!bulkTokenPicker) return [] as string[];
        if (bulkTokenPicker.field === 'tags') {
            return bulkTokenPicker.action === 'add' ? addTagOptions : removableTagOptions;
        }
        return bulkTokenPicker.action === 'add' ? addContextOptions : removableContextOptions;
    })();
    const tokenPickerPlaceholder = bulkTokenPicker?.field === 'tags'
        ? t('taskEdit.tagsPlaceholder')
        : t('taskEdit.contextsPlaceholder');

    const columnsLayoutLabel = resolveText('projects.layoutColumns', 'Columns');

    const clearSearchLabel = resolveText('common.clearSearch', 'Clear search');
    const projectAddTaskButton = !isArchivedProject ? (
        <button
            type="button"
            data-add-task-trigger
            onClick={() => openProjectQuickAdd()}
            className="inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('projects.addTask')}
        </button>
    ) : null;
    const selectProjectTasksButton = selectedProject && !isArchivedProject ? (
        <button
            type="button"
            data-task-selection-toggle
            onClick={() => {
                captureProjectScrollBeforeLayoutChange();
                if (selectionMode) exitSelectionMode();
                else setSelectionMode(true);
            }}
            className={cn(
                'h-8 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40',
                selectionMode
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground',
            )}
        >
            {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
        </button>
    ) : null;
    const completedControlLabel = showCompletedTasks
        ? resolveText('common.hideCompleted', 'Hide completed')
        : resolveText('common.showCompleted', 'Show completed');
    const taskToolbarMoreLabel = `${resolveText('taskEdit.moreOptions', 'More options')}: ${t('projects.sectionsLabel')}`;
    const projectTaskToolbarMenu = selectedProjectId ? (
        <ProjectTaskToolbarMenu
            triggerLabel={taskToolbarMoreLabel}
            columnsLabel={columnsLayoutLabel}
            columnsLayout={columnsLayout}
            showColumns={hasProjectSections}
            onToggleColumns={() => {
                captureProjectScrollBeforeLayoutChange();
                setProjectLayout(selectedProjectId, columnsLayout ? 'list' : 'columns');
            }}
            completedLabel={completedControlLabel}
            showCompletedTasks={showCompletedTasks}
            completedTaskCount={completedProjectTaskCount}
            showCompletedControl={!isArchivedProject}
            onToggleShowCompletedTasks={onToggleShowCompletedTasks}
            addSectionLabel={t('projects.addSection')}
            showAddSection={!isArchivedProject}
            onAddSection={handleAddSection}
        />
    ) : null;

    const projectSearch = (
        <div className="min-w-0 flex-1">
            <div data-project-search-row className="flex flex-col gap-2 sm:flex-row">
                {showProjectsSidebarToggle && (
                    <button
                        type="button"
                        onClick={onToggleProjectsSidebar}
                        className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        title={expandProjectsSidebarLabel}
                        aria-label={expandProjectsSidebarLabel}
                        aria-expanded={false}
                    >
                        <PanelLeftOpen className="h-4 w-4" />
                    </button>
                )}
                <div className="relative min-w-0 flex-1">
                    <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                        ref={searchInputRef}
                        type="text"
                        data-view-filter-input
                        placeholder={t('common.search')}
                        aria-label={t('common.search')}
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        className={cn(
                            VIEW_FILTER_INPUT,
                            'min-w-0 pl-10',
                            searchQuery && 'pr-9',
                        )}
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={handleClearProjectSearch}
                            aria-label={clearSearchLabel}
                            className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );

    return (
        <>
            <div className={cn("project-workspace flex-1 min-w-0 h-full flex", !columnsLayout && "project-workspace--list")}>
                <div className="flex h-full min-h-0 w-full max-w-none flex-col">
                    {!selectedProject && projectSearch}
                    {selectedProject ? (
                        <div
                            ref={projectScrollRef}
                            data-project-scroll-container
                            onScroll={handleProjectScroll}
                            className="flex-1 min-h-0 overflow-y-auto pr-2"
                        >
                            {(isCreatingProject || isProjectDeleting || isAreaCreating) && (
                                <div className="mb-4 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                                    {tFallback(t, 'common.loading', 'Loading...')}
                                </div>
                            )}
                            <ProjectDetailsHeader
                                primaryAction={projectAddTaskButton}
                                project={selectedProject}
                                projectColor={getProjectColor(selectedProject, areaById, DEFAULT_AREA_COLOR)}
                                areaLabel={selectedProjectAreaLabel}
                                isSequential={selectedProject.isSequential === true}
                                dueDate={selectedProject.dueDate}
                                reviewAt={selectedProject.reviewAt}
                                editTitle={editProjectTitle}
                                onEditTitleChange={setEditProjectTitle}
                                onCommitTitle={handleCommitProjectTitle}
                                onResetTitle={handleResetProjectTitle}
                                detailsExpanded={projectDetailsExpanded}
                                onToggleDetails={() => setProjectDetailsExpanded((prev) => !prev)}
                                onDuplicate={() => onDuplicateProject(selectedProject.id)}
                                onConvertToSection={onConvertProjectToSection ? () => { void onConvertProjectToSection(selectedProject.id); } : undefined}
                                convertToSectionBlockedReason={onConvertProjectToSection ? (() => {
                                    const eligibility = getProjectToSectionEligibility(useTaskStore.getState(), selectedProject.id);
                                    return eligibility.ok ? undefined : tFallback(t, `projects.convertBlocked.${eligibility.reason}`, eligibility.reason);
                                })() : undefined}
                                onArchive={handleArchiveProject}
                                onCancel={handleCancelProject}
                                onReactivate={() => {
                                    Promise.resolve(updateProject(selectedProject.id, { status: 'active' })).catch((error) => {
                                        reportError('Failed to reactivate project', error);
                                        showToast(tFallback(t, 'projects.reactivateFailed', 'Failed to reactivate project'), 'error');
                                    });
                                }}
                                onDelete={handleDeleteProject}
                                isDeleting={isProjectDeleting}
                                readOnly={isArchivedProject}
                                readOnlyHint={archivedReadOnlyHint}
                                projectProgress={selectedProject.cancelledAt ? null : projectProgress}
                                t={t}
                            />
                            {isGettingStartedProject(selectedProject, allTasks) && <GettingStartedActions t={t} />}

                            {projectDetailsExpanded && (
                                <ProjectDetailsFields
                                        project={selectedProject}
                                        selectedAreaId={
                                            selectedProject.areaId && areaById.has(selectedProject.areaId)
                                                ? selectedProject.areaId
                                                : noAreaId
                                        }
                                        sortedAreas={sortedAreas}
                                        noAreaId={noAreaId}
                                        t={t}
                                        tagDraft={tagDraft}
                                        tagSuggestions={addTagOptions}
                                        onTagDraftChange={setTagDraft}
                                        onCommitTags={() => {
                                            // Merged by token onto the latest row against the project the draft was
                                            // filled from: a tag another device added since stays.
                                            const current = getMutableSelectedProject();
                                            if (!current) return;
                                            const base = tagDraftBaseRef.current?.id === current.id ? tagDraftBaseRef.current : current;
                                            void updateProjectFromDraft(current.id, base, { tagIds: parseTagInput(tagDraft) });
                                        }}
                                        onNewArea={() => {
                                            const current = getMutableSelectedProject();
                                            if (current) onRequestQuickArea(current.id);
                                        }}
                                        onManageAreas={onManageAreas}
                                        onAreaChange={(value) => {
                                            updateMutableSelectedProject({ areaId: value === noAreaId ? undefined : value });
                                        }}
                                        onColorChange={async (colorOverride) => {
                                            const state = useTaskStore.getState();
                                            if (state.persistenceFailure) await state.retryPersistence();
                                            return updateMutableSelectedProject({ colorOverride });
                                        }}
                                        flowMode={getProjectFlowMode(selectedProject)}
                                        onFlowModeChange={(mode) => {
                                            const current = getMutableSelectedProject();
                                            if (current) void useTaskStore.getState().setProjectFlowMode(current.id, mode);
                                        }}
                                        sequentialScope={selectedProject.sequentialScope ?? 'project'}
                                        onSequentialScopeChange={(sequentialScope) => updateMutableSelectedProject({ sequentialScope })}
                                        status={selectedProject.status}
                                        onChangeStatus={(status) => updateMutableSelectedProject({ status })}
                                        startDateValue={toDateInputValue(selectedProject.startDate)}
                                        onStartDateChange={(value) => updateMutableSelectedProject({ startDate: value || undefined })}
                                        dueDateValue={toDateInputValue(selectedProject.dueDate)}
                                        onDueDateChange={(value) => updateMutableSelectedProject({ dueDate: value || undefined })}
                                        reviewAtValue={toDateTimeLocalValue(selectedProject.reviewAt)}
                                        onReviewAtChange={(value) => updateMutableSelectedProject({ reviewAt: value || undefined })}
                                        readOnly={isArchivedProject}
                                        readOnlyHint={archivedReadOnlyHint}
                                />
                            )}

                            <button
                                type="button"
                                data-project-notes-disclosure
                                aria-expanded={projectNotesExpanded}
                                onClick={() => setProjectNotesExpanded((value) => !value)}
                                className="flex h-12 w-full items-center justify-between border-b border-border/50 px-1 text-left text-base font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                                <span className="inline-flex items-center gap-3"><FileText className="h-5 w-5" aria-hidden="true" />{t('project.notes')}</span>
                                {projectNotesExpanded
                                    ? <ChevronDown className="h-4 w-4" aria-hidden="true" />
                                    : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                            </button>
                            {projectNotesExpanded && (
                                <ProjectNotesSection
                                        project={selectedProject}
                                        showNotesPreview={showNotesPreview}
                                        onTogglePreview={() => setShowNotesPreview((value) => !value)}
                                        onAddFile={addProjectFileAttachment}
                                        onAddLink={addProjectLinkAttachment}
                                        onLinkFolder={isTauriRuntime() ? addProjectFolderLinkAttachment : undefined}
                                        attachmentsBusy={isProjectAttachmentBusy}
                                        visibleAttachments={visibleAttachments}
                                        attachmentError={attachmentError}
                                        onOpenAttachment={openAttachment}
                                        onRemoveAttachment={removeProjectAttachment}
                                        onUpdateNotes={(value) => updateMutableSelectedProject({ supportNotes: value })}
                                        t={t}
                                        language={language}
                                        readOnly={isArchivedProject}
                                        readOnlyHint={archivedReadOnlyHint}
                                        showHeading={false}
                                />
                            )}

                            <section className="py-4">
                                <div
                                    data-project-task-toolbar
                                    data-compact={projectTaskToolbarCompact ? 'true' : 'false'}
                                    className={cn(
                                        'sticky top-0 z-20 -mx-2 mb-4 bg-background/95 px-2 shadow-sm backdrop-blur transition-[padding] duration-150 supports-[backdrop-filter]:bg-background/85',
                                        projectTaskToolbarCompact ? 'py-2' : 'py-3',
                                    )}
                                >
                                    <div
                                        className="flex flex-wrap items-center justify-between gap-3"
                                        data-project-task-toolbar-row
                                    >
                                        <div
                                            className="flex min-w-[160px] flex-1 items-center gap-3"
                                            data-project-task-primary-controls
                                        >
                                            {projectSearch}
                                        </div>
                                        <div
                                            className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2"
                                            data-project-task-secondary-controls
                                        >
                                            <fieldset
                                                className="m-0 min-w-0 border-0 p-0 disabled:cursor-not-allowed disabled:opacity-60"
                                                disabled={isArchivedProject}
                                                title={isArchivedProject ? archivedReadOnlyHint : undefined}
                                            >
                                                <SortBySelect
                                                    value={projectTaskSortBy}
                                                    defaultValue="default"
                                                    options={PROJECT_TASK_SORT_OPTIONS}
                                                    onChange={handleProjectTaskSortByChange}
                                                    t={t}
                                                />
                                            </fieldset>
                                            {selectProjectTasksButton}
                                            {projectTaskToolbarMenu}
                                        </div>
                                    </div>
                                    {selectionMode && (
                                        <div className="mt-3 space-y-3">
                                            <BulkSelectionToolbar
                                                selectionCount={selectedIdsArray.length}
                                                totalCount={visibleProjectTaskList.length}
                                                allSelected={allVisibleTasksSelected}
                                                onSelectAll={selectAllVisibleTasks}
                                                onClearSelection={clearTaskSelection}
                                                t={t}
                                            />
                                            {selectedIdsArray.length > 0 && (
                                                <ListBulkActions
                                                    selectionCount={selectedIdsArray.length}
                                                    onMoveToStatus={handleBatchMove}
                                                    onMoveToDestination={handleBatchMoveToDestination}
                                                    projects={projects}
                                                    areas={areas}
                                                    onBulkOrganize={() => setBulkOrganizeOpen(true)}
                                                    onAddTag={() => handleBatchTokenPick('tags', 'add')}
                                                    onRemoveTag={() => handleBatchTokenPick('tags', 'remove')}
                                                    disableRemoveTag={removableTagOptions.length === 0}
                                                    onAddContext={() => handleBatchTokenPick('contexts', 'add')}
                                                    onRemoveContext={() => handleBatchTokenPick('contexts', 'remove')}
                                                    disableRemoveContext={removableContextOptions.length === 0}
                                                    onExportCsv={() => { void exportSelectedTasks(); }}
                                                    isExporting={isExporting}
                                                    onDelete={handleBatchDelete}
                                                    isDeleting={activeAction === 'delete'}
                                                    t={t}
                                                />
                                            )}
                                        </div>
                                    )}
                                </div>
                                {tasksContent}
                            </section>

                            {projectReferenceTasks.length > 0 && (
                                <section data-project-reference-tasks className="border-t border-border/50 py-5">
                                    <div className="mb-3 flex items-center justify-between">
                                        <div className="text-xs uppercase tracking-wider text-muted-foreground">
                                            {t('status.reference')} ({projectReferenceTasks.length})
                                        </div>
                                    </div>
                                    {hasProjectSections ? (
                                        <div className="space-y-3">
                                            {referenceTaskGroups.map((group) => (
                                                <div key={group.id} className="rounded-lg border border-border/60">
                                                    <h3 className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-sm font-semibold">
                                                        <span>{group.title}</span>
                                                        <span className="text-xs text-muted-foreground">{group.tasks.length}</span>
                                                    </h3>
                                                    <div className="p-3">{renderStaticTasks(group.tasks)}</div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="border-t border-border/40">
                                            {renderStaticTasks(projectReferenceTasks)}
                                        </div>
                                    )}
                                </section>
                            )}
                            <div data-list-end className={LIST_END_GAP} aria-hidden="true" />
                        </div>
                    ) : (
                        <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
                            <div className="border border-dashed border-border/70 px-10 py-12 text-center">
                                <Folder className="mx-auto mb-4 h-12 w-12 opacity-25" />
                                <p>{t('projects.selectProject')}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <PromptModal
                isOpen={showSectionPrompt}
                title={editingSectionId ? t('projects.sectionsLabel') : t('projects.addSection')}
                description={t('projects.sectionPlaceholder')}
                placeholder={t('projects.sectionPlaceholder')}
                defaultValue={sectionDraft}
                confirmLabel={editingSectionId ? t('common.save') : t('projects.create')}
                cancelLabel={t('common.cancel')}
                onCancel={() => {
                    setShowSectionPrompt(false);
                    setEditingSectionId(null);
                    setSectionDraft('');
                }}
                onConfirm={(value) => {
                    const current = getMutableSelectedProject();
                    if (!current) return;
                    const trimmed = value.trim();
                    if (!trimmed) return;
                    if (editingSectionId) {
                        updateSection(editingSectionId, { title: trimmed });
                    } else {
                        addSection(current.id, trimmed);
                    }
                    setShowSectionPrompt(false);
                    setEditingSectionId(null);
                    setSectionDraft('');
                }}
            />

            <PromptModal
                isOpen={showLinkPrompt}
                title={t('attachments.addLink')}
                description={t('attachments.linkBatchHint')}
                placeholder={t('attachments.linkPlaceholder')}
                defaultValue=""
                multiline
                validate={(value) => {
                    const { invalidLine } = parseAttachmentLinkBatch(value, true);
                    return invalidLine === null ? null : formatI18nTemplate(t('attachments.invalidLinkLine'), { line: invalidLine });
                }}
                browseLabel={isTauriRuntime() ? t('attachments.linkToFile') : undefined}
                onBrowse={isTauriRuntime() ? () => browseForLinkTarget(t('attachments.linkToFile')) : undefined}
                confirmLabel={t('common.save')}
                cancelLabel={t('common.cancel')}
                onCancel={() => setShowLinkPrompt(false)}
                onConfirm={(value) => {
                    const current = getMutableSelectedProject();
                    if (!current) return;
                    const batch = parseAttachmentLinkBatch(value, true);
                    if (batch.invalidLine !== null || batch.entries.length === 0) return;
                    const now = new Date().toISOString();
                    const attachments: Attachment[] = batch.entries.map((entry) => ({
                        id: generateUUID(),
                        kind: entry.kind,
                        title: entry.title,
                        uri: entry.uri,
                        createdAt: now,
                        updatedAt: now,
                    }));
                    void appendProjectAttachments(current.id, attachments);
                    setShowLinkPrompt(false);
                }}
            />
            <TokenPickerModal
                isOpen={bulkTokenPicker !== null}
                title={tokenPickerTitle}
                description={tokenPickerTitle}
                tokens={tokenPickerOptions}
                placeholder={tokenPickerPlaceholder}
                allowCustomValue={bulkTokenPicker?.action === 'add'}
                multiSelect={bulkTokenPicker?.action === 'remove'}
                confirmLabel={t('common.save')}
                cancelLabel={t('common.cancel')}
                onCancel={() => setBulkTokenPicker(null)}
                onConfirm={handleBulkTokenConfirm}
            />
            <TaskBulkOrganizeModal
                isOpen={bulkOrganizeOpen}
                selectedCount={selectedIdsArray.length}
                projects={projects}
                areas={areas}
                sectionScope={selectedProject ? { projectId: selectedProject.id, sections: projectSections } : undefined}
                isApplying={activeAction === 'organize'}
                t={t}
                onCancel={() => setBulkOrganizeOpen(false)}
                onApply={handleApplyTaskBulkOrganize}
            />
        </>
    );
}
