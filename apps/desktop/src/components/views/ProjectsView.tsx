import {
    useState,
    useMemo,
    useEffect,
    useCallback,
    useRef,
    type FormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
} from 'react';
import {
    DndContext,
    DragOverlay,
    KeyboardSensor,
    MeasuringStrategy,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import {
    AREA_FILTER_ALL,
    AREA_FILTER_NONE,
    buildProjectGroups,
    projectMatchesAreaFilterSelection,
    tFallback,
    useTaskStore,
    type Project,
    type ProjectAreaGroup,
    type ProjectTagFilter,
    type Task,
} from '@mindwtr/core';
import { ErrorBoundary } from '../ErrorBoundary';
import { useLanguage } from '../../contexts/language-context';
import { PromptModal } from '../PromptModal';
import { ProjectsSidebar } from './projects/ProjectsSidebar';
import { AreaManagerModal } from './projects/AreaManagerModal';
import { ProjectWorkspace } from './projects/ProjectWorkspace';
import { computeProjectAreaDragResult } from './projects/project-area-dnd';
import {
    projectsViewCollisionDetection,
    resolveTaskSidebarDropTarget,
    type ProjectsDragData,
    type TaskSidebarDropTarget,
} from './projects/projects-view-dnd';
import type { ProjectAreaSection } from './projects/project-area-collapse';
import {
    DEFAULT_AREA_COLOR,
    getProjectColor,
    sortAreasByColor as sortAreasByColorIds,
    sortAreasByName as sortAreasByNameIds,
} from './projects/projects-utils';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { useUiStore } from '../../store/ui-store';
import { reportError } from '../../lib/report-error';
import { registerUndoableAction, showUndoToast } from '../../lib/undo-registry';
import { useAreaSidebarState } from './projects/useAreaSidebarState';
import { useProjectsViewStore } from './projects/useProjectsViewStore';
import {
    PROJECTS_SIDEBAR_COLLAPSED_WIDTH,
    PROJECTS_SIDEBAR_DEFAULT_WIDTH,
    PROJECTS_SIDEBAR_MIN_WIDTH,
    clampProjectsSidebarWidth,
    getProjectsSidebarMaxWidth,
    loadProjectsSidebarWidth,
    saveProjectsSidebarWidth,
} from './projects/projects-sidebar-width';
import {
    PROJECTS_SIDEBAR_KEYBOARD_STEP,
    PROJECTS_VIEW_DEFAULT_MAX_WIDTH,
    PROJECTS_VIEW_WIDE_BREAKPOINT,
    PROJECTS_VIEW_WIDE_MAX_WIDTH,
} from '../../constants/layout';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';

const projectsViewDndMeasuring = {
    droppable: {
        strategy: MeasuringStrategy.WhileDragging,
        frequency: 16,
    },
} as const;

type ProjectsViewActiveDrag =
    | { type: 'task'; taskId: string }
    | { type: 'project'; section: ProjectAreaSection };

const COLLAPSED_AREAS_STORAGE_KEY = 'mindwtr:projects:collapsedAreas';
const PROJECTS_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:projects:v1';
const PROJECTS_LAYOUT_SIDEBAR_EXTRA_MULTIPLIER = 3;
const ALL_TAGS = '__all__';
const NO_TAGS = '__none__';

type ProjectsPersistedViewState = {
    projectsSidebarCollapsed: boolean;
    showDeferredProjects: boolean;
    showArchivedProjects: boolean;
    showCompletedProjectTasks: boolean;
    selectedTag: string;
};

const DEFAULT_PROJECTS_VIEW_STATE: ProjectsPersistedViewState = {
    projectsSidebarCollapsed: false,
    showDeferredProjects: false,
    showArchivedProjects: false,
    showCompletedProjectTasks: false,
    selectedTag: ALL_TAGS,
};

function sanitizeProjectsViewState(value: unknown, fallback: ProjectsPersistedViewState): ProjectsPersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<ProjectsPersistedViewState>
        : {};
    return {
        projectsSidebarCollapsed: typeof parsed.projectsSidebarCollapsed === 'boolean'
            ? parsed.projectsSidebarCollapsed
            : fallback.projectsSidebarCollapsed,
        showDeferredProjects: typeof parsed.showDeferredProjects === 'boolean'
            ? parsed.showDeferredProjects
            : fallback.showDeferredProjects,
        showArchivedProjects: typeof parsed.showArchivedProjects === 'boolean'
            ? parsed.showArchivedProjects
            : fallback.showArchivedProjects,
        showCompletedProjectTasks: typeof parsed.showCompletedProjectTasks === 'boolean'
            ? parsed.showCompletedProjectTasks
            : fallback.showCompletedProjectTasks,
        selectedTag: typeof parsed.selectedTag === 'string' && parsed.selectedTag.trim()
            ? parsed.selectedTag
            : fallback.selectedTag,
    };
}

function loadCollapsedAreas(): Record<string, boolean> {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(COLLAPSED_AREAS_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function saveCollapsedAreas(state: Record<string, boolean>) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(COLLAPSED_AREAS_STORAGE_KEY, JSON.stringify(state));
    } catch {
        // storage unavailable — fall back to in-memory only
    }
}

export function ProjectsView() {
    const perf = usePerformanceMonitor('ProjectsView');
    const {
        projects,
        areas,
        addArea,
        updateArea,
        deleteArea,
        reorderAreas,
        reorderProjects,
        addProject,
        updateProject,
        duplicateProject,
        updateTask,
        toggleProjectFocus,
        allTasks,
        highlightTaskId,
        settings,
        focusedProjectCount,
        projectTaskSummaryById,
    } = useProjectsViewStore();
    const { t, language } = useLanguage();
    const selectedProjectId = useUiStore((state) => state.projectView.selectedProjectId);
    const setProjectView = useUiStore((state) => state.setProjectView);
    const showToast = useUiStore((state) => state.showToast);
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const setSelectedProjectId = useCallback(
        (value: string | null) => setProjectView({ selectedProjectId: value }),
        [setProjectView]
    );
    const [isCreating, setIsCreating] = useState(false);
    const [newProjectTitle, setNewProjectTitle] = useState('');
    const [newProjectAreaId, setNewProjectAreaId] = useState('');
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        PROJECTS_VIEW_STATE_STORAGE_KEY,
        DEFAULT_PROJECTS_VIEW_STATE,
        sanitizeProjectsViewState
    );
    const projectsSidebarCollapsed = persistedViewState.projectsSidebarCollapsed;
    const showDeferredProjects = persistedViewState.showDeferredProjects;
    const showArchivedProjects = persistedViewState.showArchivedProjects;
    const showCompletedProjectTasks = persistedViewState.showCompletedProjectTasks;
    const selectedTag = persistedViewState.selectedTag;
    const [collapsedAreas, setCollapsedAreas] = useState<Record<string, boolean>>(loadCollapsedAreas);
    useEffect(() => { saveCollapsedAreas(collapsedAreas); }, [collapsedAreas]);
    const projectsLayoutRef = useRef<HTMLDivElement | null>(null);
    const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
    const sidebarWidthSyncFrameRef = useRef<number | null>(null);
    const [sidebarWidth, setSidebarWidth] = useState(loadProjectsSidebarWidth);
    const [isSidebarResizing, setIsSidebarResizing] = useState(false);
    const [availableProjectsWidth, setAvailableProjectsWidth] = useState<number | null>(null);
    const [compactSidebarOpen, setCompactSidebarOpen] = useState(false);
    const [showAreaManager, setShowAreaManager] = useState(false);
    const [newAreaName, setNewAreaName] = useState('');
    const [newAreaColor, setNewAreaColor] = useState<string | undefined>(DEFAULT_AREA_COLOR);
    const [showQuickAreaPrompt, setShowQuickAreaPrompt] = useState(false);
    const [pendingAreaAssignProjectId, setPendingAreaAssignProjectId] = useState<string | null>(null);
    const [isCreatingProject, setIsCreatingProject] = useState(false);
    const [isAreaCreating, setIsAreaCreating] = useState(false);
    const ALL_AREAS = AREA_FILTER_ALL;
    const NO_AREA = AREA_FILTER_NONE;
    const setShowDeferredProjects = useCallback((value: boolean | ((current: boolean) => boolean)) => {
        setPersistedViewState((current) => ({
            ...current,
            showDeferredProjects: typeof value === 'function' ? value(current.showDeferredProjects) : value,
        }));
    }, [setPersistedViewState]);
    const setShowArchivedProjects = useCallback((value: boolean | ((current: boolean) => boolean)) => {
        setPersistedViewState((current) => ({
            ...current,
            showArchivedProjects: typeof value === 'function' ? value(current.showArchivedProjects) : value,
        }));
    }, [setPersistedViewState]);
    const setShowCompletedProjectTasks = useCallback((value: boolean | ((current: boolean) => boolean)) => {
        setPersistedViewState((current) => ({
            ...current,
            showCompletedProjectTasks: typeof value === 'function' ? value(current.showCompletedProjectTasks) : value,
        }));
    }, [setPersistedViewState]);
    const setSelectedTag = useCallback((value: string) => {
        setPersistedViewState((current) => ({
            ...current,
            selectedTag: value,
        }));
    }, [setPersistedViewState]);
    const fallbackProjectsWidth = typeof window === 'undefined' ? PROJECTS_VIEW_DEFAULT_MAX_WIDTH : window.innerWidth;
    const isCompactProjectsLayout = (availableProjectsWidth ?? fallbackProjectsWidth) < 760;
    const projectsSidebarVisible = isCompactProjectsLayout
        ? compactSidebarOpen
        : !projectsSidebarCollapsed;
    const projectsSidebarEffectivelyCollapsed = !projectsSidebarVisible;

    const toggleProjectsSidebarCollapsed = useCallback(() => {
        if (isCompactProjectsLayout) {
            setCompactSidebarOpen((current) => !current);
            return;
        }
        setPersistedViewState((current) => ({
            ...current,
            projectsSidebarCollapsed: !current.projectsSidebarCollapsed,
        }));
    }, [isCompactProjectsLayout, setPersistedViewState]);

    useEffect(() => {
        if (!isCompactProjectsLayout) setCompactSidebarOpen(false);
    }, [isCompactProjectsLayout]);

    const getProjectsBaseMaxWidth = useCallback(() => {
        if (typeof window === 'undefined') return PROJECTS_VIEW_DEFAULT_MAX_WIDTH;
        return window.innerWidth >= PROJECTS_VIEW_WIDE_BREAKPOINT
            ? PROJECTS_VIEW_WIDE_MAX_WIDTH
            : PROJECTS_VIEW_DEFAULT_MAX_WIDTH;
    }, []);

    const projectsLayoutMaxWidth = useMemo(() => {
        const baseMaxWidth = getProjectsBaseMaxWidth();
        const desiredMaxWidth = projectsSidebarCollapsed
            ? baseMaxWidth + Math.max(0, sidebarWidth - PROJECTS_SIDEBAR_COLLAPSED_WIDTH)
            : baseMaxWidth
                + Math.max(0, sidebarWidth - PROJECTS_SIDEBAR_DEFAULT_WIDTH)
                * PROJECTS_LAYOUT_SIDEBAR_EXTRA_MULTIPLIER;

        if (typeof availableProjectsWidth !== 'number' || !Number.isFinite(availableProjectsWidth)) {
            return desiredMaxWidth;
        }

        return Math.min(desiredMaxWidth, availableProjectsWidth);
    }, [availableProjectsWidth, getProjectsBaseMaxWidth, projectsSidebarCollapsed, sidebarWidth]);

    const sidebarMaxWidth = useMemo(
        () => getProjectsSidebarMaxWidth(availableProjectsWidth ?? projectsLayoutMaxWidth),
        [availableProjectsWidth, projectsLayoutMaxWidth],
    );

    const clampSidebarWidth = useCallback(
        (width: number) => clampProjectsSidebarWidth(width, availableProjectsWidth ?? projectsLayoutMaxWidth),
        [availableProjectsWidth, projectsLayoutMaxWidth],
    );

    useEffect(() => {
        saveProjectsSidebarWidth(sidebarWidth);
    }, [sidebarWidth]);

    const syncSidebarWidth = useCallback(() => {
        const nextAvailableWidth = projectsLayoutRef.current?.parentElement?.clientWidth ?? null;
        setAvailableProjectsWidth((current) => current === nextAvailableWidth ? current : nextAvailableWidth);
        setSidebarWidth((current) => {
            const next = clampProjectsSidebarWidth(current, nextAvailableWidth ?? undefined);
            return current === next ? current : next;
        });
    }, []);

    useEffect(() => {
        const scheduleSidebarWidthSync = () => {
            if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                if (sidebarWidthSyncFrameRef.current !== null) return;
                sidebarWidthSyncFrameRef.current = window.requestAnimationFrame(() => {
                    sidebarWidthSyncFrameRef.current = null;
                    syncSidebarWidth();
                });
                return;
            }
            syncSidebarWidth();
        };

        scheduleSidebarWidthSync();

        if (typeof ResizeObserver === 'function' && projectsLayoutRef.current) {
            const observer = new ResizeObserver(scheduleSidebarWidthSync);
            observer.observe(projectsLayoutRef.current);
            const parentElement = projectsLayoutRef.current.parentElement;
            if (parentElement) observer.observe(parentElement);
            return () => {
                observer.disconnect();
                if (sidebarWidthSyncFrameRef.current !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
                    window.cancelAnimationFrame(sidebarWidthSyncFrameRef.current);
                    sidebarWidthSyncFrameRef.current = null;
                }
            };
        }

        window.addEventListener('resize', scheduleSidebarWidthSync);
        return () => {
            window.removeEventListener('resize', scheduleSidebarWidthSync);
            if (sidebarWidthSyncFrameRef.current !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
                window.cancelAnimationFrame(sidebarWidthSyncFrameRef.current);
                sidebarWidthSyncFrameRef.current = null;
            }
        };
    }, [syncSidebarWidth]);

    useEffect(() => () => {
        sidebarResizeCleanupRef.current?.();
    }, []);

    const resizeSidebarLabel = tFallback(t, 'projects.resizeSidebar', 'Resize projects panel');
    const collapseProjectsSidebarLabel = tFallback(t, 'projects.collapseSidebar', 'Collapse projects panel');

    const handleSidebarResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();

        sidebarResizeCleanupRef.current?.();

        const startX = event.clientX;
        const startWidth = sidebarWidth;
        const originalCursor = document.body.style.cursor;
        const originalUserSelect = document.body.style.userSelect;

        setIsSidebarResizing(true);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const cleanup = () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerUp);
            document.body.style.cursor = originalCursor;
            document.body.style.userSelect = originalUserSelect;
            setIsSidebarResizing(false);
            sidebarResizeCleanupRef.current = null;
        };

        const handlePointerMove = (moveEvent: PointerEvent) => {
            const deltaX = moveEvent.clientX - startX;
            setSidebarWidth(clampSidebarWidth(startWidth + deltaX));
        };

        const handlePointerUp = () => {
            cleanup();
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', handlePointerUp);
        sidebarResizeCleanupRef.current = cleanup;
    }, [clampSidebarWidth, sidebarWidth]);

    const handleSidebarResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
        switch (event.key) {
            case 'ArrowLeft':
                event.preventDefault();
                setSidebarWidth((current) => clampSidebarWidth(current - PROJECTS_SIDEBAR_KEYBOARD_STEP));
                break;
            case 'ArrowRight':
                event.preventDefault();
                setSidebarWidth((current) => clampSidebarWidth(current + PROJECTS_SIDEBAR_KEYBOARD_STEP));
                break;
            case 'Home':
                event.preventDefault();
                setSidebarWidth(clampSidebarWidth(PROJECTS_SIDEBAR_MIN_WIDTH));
                break;
            case 'End':
                event.preventDefault();
                setSidebarWidth(clampSidebarWidth(sidebarMaxWidth));
                break;
            default:
                break;
        }
    }, [clampSidebarWidth, sidebarMaxWidth]);

    const handleDuplicateProject = useCallback(async (projectId: string) => {
        try {
            const created = await duplicateProject(projectId);
            if (created) {
                setSelectedProjectId(created.id);
                showToast(tFallback(t, 'projects.duplicated', 'Project duplicated'), 'success');
                return;
            }
            showToast(tFallback(t, 'projects.duplicateFailed', 'Failed to duplicate project'), 'error');
        } catch (error) {
            reportError('Failed to duplicate project', error);
            showToast(tFallback(t, 'projects.duplicateFailed', 'Failed to duplicate project'), 'error');
        }
    }, [duplicateProject, setSelectedProjectId, showToast, t]);

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ProjectsView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const {
        selectedArea,
        selectedAreaValue,
        sortedAreas,
        areaById,
        areaFilterLabel,
        areaSensors,
        toggleAreaCollapse,
        handleAreaDragEnd,
        handleDeleteArea,
    } = useAreaSidebarState({
        areas,
        settings,
        t,
        reorderAreas,
        deleteArea,
        setCollapsedAreas,
        requestConfirmation,
        showToast,
    });

    const getProjectColorForTask = (project: Project) => getProjectColor(project, areaById, DEFAULT_AREA_COLOR);

    useEffect(() => {
        setNewProjectAreaId(selectedAreaValue !== ALL_AREAS && selectedAreaValue !== NO_AREA ? selectedAreaValue : '');
    }, [selectedAreaValue, ALL_AREAS, NO_AREA]);

    const sortAreasByName = () => reorderAreas(sortAreasByNameIds(sortedAreas));
    const sortAreasByColor = () => reorderAreas(sortAreasByColorIds(sortedAreas));

    const {
        tagOptions,
        groupedActiveProjects,
        groupedDeferredProjects,
        groupedArchivedProjects,
    } = useMemo(() => {
        const tagFilter: ProjectTagFilter = selectedTag === ALL_TAGS
            ? { kind: 'all' }
            : selectedTag === NO_TAGS
                ? { kind: 'untagged' }
                : { kind: 'tag', value: selectedTag };
        const grouped = buildProjectGroups({
            projects,
            orderedAreas: sortedAreas,
            areaFilter: selectedArea,
            tagFilter,
        });
        const toSidebarGroups = (groups: ProjectAreaGroup[]): Array<[string, Project[]]> => (
            groups.map((group) => [group.areaId ?? NO_AREA, group.projects])
        );
        return {
            tagOptions: {
                list: grouped.tagInventory.values,
                hasNoTags: grouped.tagInventory.hasUntagged,
            },
            groupedActiveProjects: toSidebarGroups(grouped.active),
            groupedDeferredProjects: toSidebarGroups(grouped.deferred),
            groupedArchivedProjects: toSidebarGroups(grouped.archived),
        };
    }, [NO_AREA, projects, selectedArea, selectedTag, sortedAreas]);

    useEffect(() => {
        // Keep persisted tag selections through the empty startup frame; reset only after we have a real tag inventory.
        if (tagOptions.list.length === 0 && !tagOptions.hasNoTags) return;
        if (selectedTag === ALL_TAGS || selectedTag === NO_TAGS || tagOptions.list.includes(selectedTag)) return;
        setSelectedTag(ALL_TAGS);
    }, [selectedTag, tagOptions.hasNoTags, tagOptions.list, setSelectedTag]);

    // One DndContext spans the sidebar and the workspace so task rows can be
    // dropped on sidebar projects/areas; drags carry typed data and handlers
    // branch on it (ADR 0023).
    const dndSensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 5 },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        }),
    );
    const [activeDrag, setActiveDrag] = useState<ProjectsViewActiveDrag | null>(null);
    const taskDragEndRef = useRef<((event: DragEndEvent) => void) | null>(null);

    const projectDndStates = useMemo(() => {
        const build = (groups: Array<[string, Project[]]>) => {
            const projectIdsByArea = new Map<string, string[]>();
            const projectAreaById = new Map<string, string>();
            groups.forEach(([areaId, areaProjects]) => {
                const ids = areaProjects.map((project) => project.id);
                projectIdsByArea.set(areaId, ids);
                ids.forEach((id) => projectAreaById.set(id, areaId));
            });
            return { projectIdsByArea, projectAreaById };
        };
        return {
            active: build(groupedActiveProjects),
            deferred: build(groupedDeferredProjects),
            archived: build(groupedArchivedProjects),
        };
    }, [groupedActiveProjects, groupedDeferredProjects, groupedArchivedProjects]);

    const handleProjectDragEnd = useCallback((section: ProjectAreaSection, event: DragEndEvent) => {
        const failProjectMove = (error: unknown) => {
            reportError('Failed to move project between areas', error);
            showToast(tFallback(t, 'projects.moveProjectFailed', 'Failed to move project'), 'error');
        };
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const dndState = projectDndStates[section];
        const move = computeProjectAreaDragResult({
            activeId: String(active.id),
            overId: String(over.id),
            projectIdsByArea: dndState.projectIdsByArea,
            projectAreaById: dndState.projectAreaById,
        });
        if (!move) return;

        const sourceAreaArg = move.sourceAreaId === NO_AREA ? undefined : move.sourceAreaId;
        const destinationAreaArg = move.destinationAreaId === NO_AREA ? undefined : move.destinationAreaId;

        if (!move.movedAcrossAreas) {
            void Promise.resolve(reorderProjects(move.nextDestinationIds, destinationAreaArg)).catch(failProjectMove);
            return;
        }

        void Promise.resolve(updateProject(move.movedProjectId, { areaId: destinationAreaArg }))
            .then(async (result) => {
                if (result && result.success === false) {
                    throw new Error(result.error || 'Failed to move project');
                }
                if (move.nextSourceIds.length > 0) {
                    await Promise.resolve(reorderProjects(move.nextSourceIds, sourceAreaArg));
                }
                await Promise.resolve(reorderProjects(move.nextDestinationIds, destinationAreaArg));
            })
            .catch(failProjectMove);
    }, [NO_AREA, projectDndStates, reorderProjects, showToast, t, updateProject]);

    const handleTaskSidebarDrop = useCallback((taskId: string, target: TaskSidebarDropTarget) => {
        const task = allTasks.find((candidate) => candidate.id === taskId);
        if (!task) return;

        let destinationName: string;
        let updates: Partial<Task>;
        if (target.kind === 'project') {
            if ((task.projectId ?? undefined) === target.projectId) return;
            const targetProject = projects.find(
                (candidate) => candidate.id === target.projectId && !candidate.deletedAt,
            );
            if (!targetProject || targetProject.status === 'archived') return;
            destinationName = targetProject.title;
            updates = { projectId: target.projectId };
        } else {
            const resolvedAreaId = target.areaId === NO_AREA ? undefined : target.areaId;
            if (resolvedAreaId && !areaById.has(resolvedAreaId)) return;
            if (!task.projectId && (task.areaId ?? undefined) === resolvedAreaId) return;
            destinationName = resolvedAreaId
                ? areaById.get(resolvedAreaId)?.name ?? ''
                : t('projects.noArea');
            updates = { projectId: undefined, areaId: resolvedAreaId };
        }

        const previous: Partial<Task> = {
            projectId: task.projectId,
            sectionId: task.sectionId,
            areaId: task.areaId,
            order: task.order,
            orderNum: task.orderNum,
        };
        const failTaskMove = (error: unknown) => {
            reportError('Failed to move task', error);
            showToast(tFallback(t, 'projects.taskMoveFailed', 'Failed to move task'), 'error');
        };
        void Promise.resolve(updateTask(taskId, updates))
            .then((result) => {
                if (result && result.success === false) {
                    throw new Error(result.error || 'Failed to move task');
                }
                const message = tFallback(t, 'projects.taskMovedTo', 'Moved to {{name}}')
                    .replace('{{name}}', destinationName);
                const undo = () => {
                    void Promise.resolve(updateTask(taskId, previous)).catch(failTaskMove);
                };
                if (settings?.undoNotificationsEnabled === false) {
                    // Undo toasts are off, but Ctrl+Z should still work, and
                    // a move still needs *some* confirmation — just not one
                    // dressed up as an undo notification the setting asked
                    // to hide.
                    registerUndoableAction(undo);
                    showToast(message, 'success');
                } else {
                    showUndoToast(message, undo, t);
                }
            })
            .catch(failTaskMove);
    }, [NO_AREA, allTasks, areaById, projects, settings, showToast, t, updateTask]);

    const handleDndDragStart = useCallback((event: DragStartEvent) => {
        const data = event.active.data.current as ProjectsDragData | undefined;
        if (data?.type === 'task') {
            setActiveDrag({ type: 'task', taskId: String(event.active.id) });
        } else if (data?.type === 'project') {
            setActiveDrag({ type: 'project', section: data.section });
        }
    }, []);

    const handleDndDragCancel = useCallback(() => setActiveDrag(null), []);

    const handleDndDragEnd = useCallback((event: DragEndEvent) => {
        setActiveDrag(null);
        const data = event.active.data.current as ProjectsDragData | undefined;
        if (data?.type === 'project') {
            handleProjectDragEnd(data.section, event);
            return;
        }
        if (data?.type === 'task') {
            const { over } = event;
            if (over) {
                const target = resolveTaskSidebarDropTarget(String(over.id), over.data.current);
                if (target) {
                    handleTaskSidebarDrop(String(event.active.id), target);
                    return;
                }
            }
            taskDragEndRef.current?.(event);
        }
    }, [handleProjectDragEnd, handleTaskSidebarDrop]);

    const draggedTask = useMemo(() => {
        if (activeDrag?.type !== 'task') return null;
        return allTasks.find((candidate) => candidate.id === activeDrag.taskId) ?? null;
    }, [activeDrag, allTasks]);

    const handleCreateProject = async (e: FormEvent) => {
        e.preventDefault();
        if (!newProjectTitle.trim() || isCreatingProject) return;
        setIsCreatingProject(true);
        try {
            const resolvedAreaId =
                newProjectAreaId && areaById.has(newProjectAreaId) ? newProjectAreaId : undefined;
            const areaColor = resolvedAreaId ? areaById.get(resolvedAreaId)?.color : undefined;
            await addProject(
                newProjectTitle,
                areaColor || DEFAULT_AREA_COLOR,
                resolvedAreaId ? { areaId: resolvedAreaId } : undefined
            );
            setNewProjectTitle('');
            setIsCreating(false);
            setNewProjectAreaId(selectedAreaValue !== ALL_AREAS && selectedAreaValue !== NO_AREA ? selectedAreaValue : '');
        } catch (error) {
            reportError('Failed to create project', error);
            showToast(tFallback(t, 'projects.createFailed', 'Failed to create project'), 'error');
        } finally {
            setIsCreatingProject(false);
        }
    };

    const selectedProject = projects.find(p => p.id === selectedProjectId);

    useEffect(() => {
        if (selectedProject?.status === 'archived') {
            setShowArchivedProjects(true);
        }
    }, [selectedProject?.id, selectedProject?.status]);

    useEffect(() => {
        if (!selectedProjectId || !selectedProject) return;
        if (!projectMatchesAreaFilterSelection(selectedProject, selectedArea, areaById)) {
            setSelectedProjectId(null);
        }
    }, [areaById, selectedArea, selectedProject, selectedProjectId, setSelectedProjectId]);

    return (
        <ErrorBoundary>
            <div className="h-full px-4 pt-3">
                <DndContext
                    sensors={dndSensors}
                    collisionDetection={projectsViewCollisionDetection}
                    measuring={projectsViewDndMeasuring}
                    onDragStart={handleDndDragStart}
                    onDragCancel={handleDndDragCancel}
                    onDragEnd={handleDndDragEnd}
                >
                <div
                    ref={projectsLayoutRef}
                    className="relative mx-auto flex h-full w-full min-w-0 gap-5 xl:gap-6"
                    style={{ maxWidth: `${projectsLayoutMaxWidth}px` }}
                >
                    {projectsSidebarVisible && (
                        <div
                            className={`relative min-h-0 flex-none ${
                                isCompactProjectsLayout
                                    ? 'absolute inset-y-0 left-0 z-20 border-r border-border bg-background pr-4 shadow-lg'
                                    : ''
                            }`}
                            style={{ width: `${sidebarWidth}px` }}
                        >
                            <div id="projects-sidebar-panel" className="h-full min-w-0">
                                <ProjectsSidebar
                                    t={t}
                                    areaFilterLabel={areaFilterLabel ?? undefined}
                                    selectedTag={selectedTag}
                                    noAreaId={NO_AREA}
                                    allTagsId={ALL_TAGS}
                                    noTagsId={NO_TAGS}
                                    tagOptions={tagOptions}
                                    isCreating={isCreating}
                                    isCreatingProject={isCreatingProject}
                                    newProjectTitle={newProjectTitle}
                                    newProjectAreaId={newProjectAreaId}
                                    areaOptions={sortedAreas}
                                    onStartCreate={() => setIsCreating(true)}
                                    onCancelCreate={() => {
                                        setIsCreating(false);
                                        setNewProjectAreaId(selectedAreaValue !== ALL_AREAS && selectedAreaValue !== NO_AREA ? selectedAreaValue : '');
                                    }}
                                    onCreateProject={handleCreateProject}
                                    onChangeNewProjectTitle={setNewProjectTitle}
                                    onChangeNewProjectAreaId={setNewProjectAreaId}
                                    onSelectTag={setSelectedTag}
                                    groupedActiveProjects={groupedActiveProjects}
                                    groupedDeferredProjects={groupedDeferredProjects}
                                    groupedArchivedProjects={groupedArchivedProjects}
                                    areaById={areaById}
                                    collapsedAreas={collapsedAreas}
                                    onToggleAreaCollapse={toggleAreaCollapse}
                                    showDeferredProjects={showDeferredProjects}
                                    onToggleDeferredProjects={() => setShowDeferredProjects((prev) => !prev)}
                                    showArchivedProjects={showArchivedProjects}
                                    onToggleArchivedProjects={() => setShowArchivedProjects((prev) => !prev)}
                                    selectedProjectId={selectedProjectId}
                                    onSelectProject={(projectId) => {
                                        setSelectedProjectId(projectId);
                                        if (isCompactProjectsLayout) setCompactSidebarOpen(false);
                                    }}
                                    getProjectColor={getProjectColorForTask}
                                    projectTaskSummaryById={projectTaskSummaryById}
                                    projects={projects}
                                    focusedProjectCount={focusedProjectCount}
                                    toggleProjectFocus={toggleProjectFocus}
                                    onDuplicateProject={handleDuplicateProject}
                                    draggingSection={activeDrag?.type === 'project' ? activeDrag.section : null}
                                    collapseLabel={collapseProjectsSidebarLabel}
                                    onToggleCollapsed={toggleProjectsSidebarCollapsed}
                                />
                            </div>
                            {!isCompactProjectsLayout && <div
                                role="separator"
                                aria-controls="projects-sidebar-panel"
                                aria-label={resizeSidebarLabel}
                                aria-orientation="vertical"
                                aria-valuemin={PROJECTS_SIDEBAR_MIN_WIDTH}
                                aria-valuemax={sidebarMaxWidth}
                                aria-valuenow={sidebarWidth}
                                title={resizeSidebarLabel}
                                tabIndex={0}
                                onPointerDown={handleSidebarResizePointerDown}
                                onKeyDown={handleSidebarResizeKeyDown}
                                className="group absolute -right-3 bottom-0 top-0 z-10 flex w-6 items-start justify-center cursor-col-resize touch-none rounded-full pt-20 outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                            >
                                <span
                                    aria-hidden="true"
                                    className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
                                        isSidebarResizing
                                            ? 'bg-primary/40'
                                            : 'bg-border/45 group-hover:bg-primary/25'
                                    }`}
                                />
                                <span
                                    className={`relative h-16 w-1 rounded-full transition-colors ${
                                        isSidebarResizing
                                            ? 'bg-primary/70'
                                            : 'bg-border/80 group-hover:bg-primary/45'
                                    }`}
                                />
                            </div>}
                        </div>
                    )}

                    <ProjectWorkspace
                        highlightTaskId={highlightTaskId}
                        isAreaCreating={isAreaCreating}
                        isCreatingProject={isCreatingProject}
                        language={language}
                        onDuplicateProject={handleDuplicateProject}
                        onManageAreas={() => setShowAreaManager(true)}
                        onRequestQuickArea={(projectId) => {
                            setPendingAreaAssignProjectId(projectId);
                            setShowQuickAreaPrompt(true);
                        }}
                        requestConfirmation={requestConfirmation}
                        selectedProjectId={selectedProjectId}
                        showCompletedTasks={showCompletedProjectTasks}
                        t={t}
                        projectsSidebarCollapsed={projectsSidebarEffectivelyCollapsed}
                        onToggleProjectsSidebar={toggleProjectsSidebarCollapsed}
                        onToggleShowCompletedTasks={() => setShowCompletedProjectTasks((prev) => !prev)}
                        taskDragEndRef={taskDragEndRef}
                    />
                </div>
                <DragOverlay dropAnimation={null}>
                    {draggedTask ? (
                        <div className="pointer-events-none max-w-[280px] truncate rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
                            {draggedTask.title}
                        </div>
                    ) : null}
                </DragOverlay>
                </DndContext>

                {showAreaManager && (
                    <AreaManagerModal
                        sortedAreas={sortedAreas}
                        areaSensors={areaSensors}
                        onDragEnd={handleAreaDragEnd}
                        onDeleteArea={handleDeleteArea}
                        onUpdateArea={updateArea}
                        newAreaColor={newAreaColor}
                        onChangeNewAreaColor={setNewAreaColor}
                        newAreaName={newAreaName}
                        onChangeNewAreaName={(event) => setNewAreaName(event.target.value)}
                        onCreateArea={async () => {
                            const name = newAreaName.trim();
                            if (!name) return;
                            setIsAreaCreating(true);
                            try {
                                await addArea(name, { color: newAreaColor });
                                setNewAreaName('');
                            } catch (error) {
                                reportError('Failed to create area', error);
                                showToast(tFallback(t, 'projects.createAreaFailed', 'Failed to create area'), 'error');
                            } finally {
                                setIsAreaCreating(false);
                            }
                        }}
                        isCreatingArea={isAreaCreating}
                        onSortByName={sortAreasByName}
                        onSortByColor={sortAreasByColor}
                        onClose={() => setShowAreaManager(false)}
                        t={t}
                    />
                )}

                <PromptModal
                    isOpen={showQuickAreaPrompt}
                    title={t('projects.areaLabel')}
                    description={t('projects.areaPlaceholder')}
                    placeholder={t('projects.areaPlaceholder')}
                    defaultValue=""
                    confirmLabel={t('projects.create')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => {
                        setShowQuickAreaPrompt(false);
                        setPendingAreaAssignProjectId(null);
                    }}
                    onConfirm={async (value) => {
                        const name = value.trim();
                        if (!name) return;
                        setIsAreaCreating(true);
                        try {
                            await addArea(name, { color: newAreaColor });
                            const state = useTaskStore.getState();
                            const matching = [...state.areas]
                                .filter((area) => area.name.trim().toLowerCase() === name.toLowerCase())
                                .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
                            const created = matching[0];
                            if (created && pendingAreaAssignProjectId) {
                                await Promise.resolve(updateProject(pendingAreaAssignProjectId, { areaId: created.id }));
                            }
                        } catch (error) {
                            reportError('Failed to create quick area', error);
                            showToast(tFallback(t, 'projects.createAreaFailed', 'Failed to create area'), 'error');
                        } finally {
                            setIsAreaCreating(false);
                            setShowQuickAreaPrompt(false);
                            setPendingAreaAssignProjectId(null);
                        }
                    }}
                />
                {confirmModal}
            </div>
        </ErrorBoundary>
    );
}
