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
import { ErrorBoundary } from '../ErrorBoundary';
import { tFallback, useTaskStore, Task, type Project } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { PromptModal } from '../PromptModal';
import { ProjectsSidebar } from './projects/ProjectsSidebar';
import { AreaManagerModal } from './projects/AreaManagerModal';
import { ProjectWorkspace } from './projects/ProjectWorkspace';
import {
    DEFAULT_AREA_COLOR,
    getProjectColor,
    sortAreasByColor as sortAreasByColorIds,
    sortAreasByName as sortAreasByNameIds,
} from './projects/projects-utils';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { useUiStore } from '../../store/ui-store';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, projectMatchesAreaFilter } from '../../lib/area-filter';
import { reportError } from '../../lib/report-error';
import { useAreaSidebarState } from './projects/useAreaSidebarState';
import { useProjectsViewStore } from './projects/useProjectsViewStore';
import { splitProjectsForSidebar } from './projects/project-sidebar-grouping';
import {
    PROJECTS_SIDEBAR_DEFAULT_WIDTH,
    PROJECTS_SIDEBAR_MAX_WIDTH,
    PROJECTS_SIDEBAR_MIN_WIDTH,
    clampProjectsSidebarWidth,
    getProjectsSidebarMaxWidth,
    loadProjectsSidebarWidth,
    saveProjectsSidebarWidth,
} from './projects/projects-sidebar-width';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

const COLLAPSED_AREAS_STORAGE_KEY = 'mindwtr:projects:collapsedAreas';
const PROJECTS_VIEW_DEFAULT_MAX_WIDTH = 1344;
const PROJECTS_VIEW_2XL_MAX_WIDTH = 1408;
const PROJECTS_VIEW_2XL_BREAKPOINT = 1536;

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
        tasks,
        sections,
        areas,
        addArea,
        updateArea,
        deleteArea,
        reorderAreas,
        reorderProjects,
        reorderProjectTasks,
        addProject,
        updateProject,
        deleteProject,
        duplicateProject,
        updateTask,
        addSection,
        updateSection,
        deleteSection,
        addTask,
        toggleProjectFocus,
        allTasks,
        highlightTaskId,
        setHighlightTask,
        settings,
        getDerivedState,
    } = useProjectsViewStore();
    const { allContexts, allTags } = getDerivedState();
    const allTokens = useMemo(
        () => Array.from(new Set([...allContexts, ...allTags])).sort(),
        [allContexts, allTags],
    );
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
    const [showDeferredProjects, setShowDeferredProjects] = useState(false);
    const [showArchivedProjects, setShowArchivedProjects] = useState(false);
    const [collapsedAreas, setCollapsedAreas] = useState<Record<string, boolean>>(loadCollapsedAreas);
    useEffect(() => { saveCollapsedAreas(collapsedAreas); }, [collapsedAreas]);
    const projectsLayoutRef = useRef<HTMLDivElement | null>(null);
    const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
    const sidebarWidthSyncFrameRef = useRef<number | null>(null);
    const [sidebarWidth, setSidebarWidth] = useState(loadProjectsSidebarWidth);
    const [isSidebarResizing, setIsSidebarResizing] = useState(false);
    const [availableProjectsWidth, setAvailableProjectsWidth] = useState<number | null>(null);
    const [showAreaManager, setShowAreaManager] = useState(false);
    const [newAreaName, setNewAreaName] = useState('');
    const [newAreaColor, setNewAreaColor] = useState(DEFAULT_AREA_COLOR);
    const [showQuickAreaPrompt, setShowQuickAreaPrompt] = useState(false);
    const [pendingAreaAssignProjectId, setPendingAreaAssignProjectId] = useState<string | null>(null);
    const [isCreatingProject, setIsCreatingProject] = useState(false);
    const [isAreaCreating, setIsAreaCreating] = useState(false);
    const ALL_AREAS = AREA_FILTER_ALL;
    const NO_AREA = AREA_FILTER_NONE;
    const ALL_TAGS = '__all__';
    const NO_TAGS = '__none__';
    const [selectedTag, setSelectedTag] = useState(ALL_TAGS);

    const getProjectsBaseMaxWidth = useCallback(() => {
        if (typeof window === 'undefined') return PROJECTS_VIEW_DEFAULT_MAX_WIDTH;
        return window.innerWidth >= PROJECTS_VIEW_2XL_BREAKPOINT
            ? PROJECTS_VIEW_2XL_MAX_WIDTH
            : PROJECTS_VIEW_DEFAULT_MAX_WIDTH;
    }, []);

    const projectsLayoutMaxWidth = useMemo(() => {
        const baseMaxWidth = getProjectsBaseMaxWidth();
        const desiredMaxWidth = baseMaxWidth + Math.max(0, sidebarWidth - PROJECTS_SIDEBAR_DEFAULT_WIDTH);

        if (typeof availableProjectsWidth !== 'number' || !Number.isFinite(availableProjectsWidth)) {
            return desiredMaxWidth;
        }

        return Math.min(desiredMaxWidth, availableProjectsWidth);
    }, [availableProjectsWidth, getProjectsBaseMaxWidth, sidebarWidth]);

    const clampSidebarWidth = useCallback(
        (width: number) => clampProjectsSidebarWidth(width, projectsLayoutMaxWidth),
        [projectsLayoutMaxWidth],
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
                setSidebarWidth((current) => clampSidebarWidth(current - 24));
                break;
            case 'ArrowRight':
                event.preventDefault();
                setSidebarWidth((current) => clampSidebarWidth(current + 24));
                break;
            case 'Home':
                event.preventDefault();
                setSidebarWidth(clampSidebarWidth(PROJECTS_SIDEBAR_MIN_WIDTH));
                break;
            case 'End':
                event.preventDefault();
                setSidebarWidth(clampSidebarWidth(getProjectsSidebarMaxWidth(projectsLayoutMaxWidth)));
                break;
            default:
                break;
        }
    }, [clampSidebarWidth, projectsLayoutMaxWidth]);

    const handleDuplicateProject = useCallback(async (projectId: string) => {
        try {
            const created = await duplicateProject(projectId);
            if (created) {
                setSelectedProjectId(created.id);
                return;
            }
            showToast('Failed to duplicate project', 'error');
        } catch (error) {
            reportError('Failed to duplicate project', error);
            showToast('Failed to duplicate project', 'error');
        }
    }, [duplicateProject, setSelectedProjectId, showToast]);

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ProjectsView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const {
        selectedArea,
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

    const sortAreasByName = () => reorderAreas(sortAreasByNameIds(sortedAreas));
    const sortAreasByColor = () => reorderAreas(sortAreasByColorIds(sortedAreas));

    // Group tasks by project to avoid O(N*M) filtering
    const { tasksByProject } = useMemo(() => {
        const map = projects.reduce((acc, project) => {
            acc[project.id] = [];
            return acc;
        }, {} as Record<string, Task[]>);
        tasks.forEach(task => {
            if (
                task.projectId
                && !task.deletedAt
                && task.status !== 'done'
                && task.status !== 'reference'
                && task.status !== 'archived'
            ) {
                if (map[task.projectId]) {
                    map[task.projectId].push(task);
                }
            }
        });
        return {
            tasksByProject: map,
        };
    }, [projects, tasks]);

    const tagOptions = useMemo(() => {
        const visibleProjects = projects.filter(p => !p.deletedAt);
        const tags = new Set<string>();
        let hasNoTags = false;
        visibleProjects.forEach((project) => {
            const list = project.tagIds || [];
            if (list.length === 0) {
                hasNoTags = true;
                return;
            }
            list.forEach((tag) => tags.add(tag));
        });
        return {
            list: Array.from(tags).sort(),
            hasNoTags,
        };
    }, [projects]);

    const { groupedActiveProjects, groupedDeferredProjects, groupedArchivedProjects } = useMemo(() => {
        const visibleProjects = projects.filter(p => !p.deletedAt);
        const sorted = [...visibleProjects].sort((a, b) => {
            const orderA = Number.isFinite(a.order) ? a.order : 0;
            const orderB = Number.isFinite(b.order) ? b.order : 0;
            if (orderA !== orderB) return orderA - orderB;
            return a.title.localeCompare(b.title);
        });
        const filtered = sorted.filter((project) => {
            if (selectedArea === ALL_AREAS) return true;
            if (selectedArea === NO_AREA) return !project.areaId || !areaById.has(project.areaId);
            return project.areaId === selectedArea;
        });
        const filteredByTag = filtered.filter((project) => {
            const tags = project.tagIds || [];
            if (selectedTag === ALL_TAGS) return true;
            if (selectedTag === NO_TAGS) return tags.length === 0;
            return tags.includes(selectedTag);
        });

        const groupByArea = (list: typeof filtered) => {
            const groups = new Map<string, typeof filtered>();
            for (const project of list) {
                const areaId = project.areaId && areaById.has(project.areaId) ? project.areaId : NO_AREA;
                if (!groups.has(areaId)) groups.set(areaId, []);
                groups.get(areaId)!.push(project);
            }
            const ordered: Array<[string, typeof filtered]> = [];
            sortedAreas.forEach((area) => {
                const entries = groups.get(area.id);
                if (entries && entries.length > 0) ordered.push([area.id, entries]);
            });
            const noAreaEntries = groups.get(NO_AREA);
            if (noAreaEntries && noAreaEntries.length > 0) ordered.push([NO_AREA, noAreaEntries]);
            return ordered;
        };

        const { active, deferred, archived } = splitProjectsForSidebar(filteredByTag);

        return {
            groupedActiveProjects: groupByArea(active),
            groupedDeferredProjects: groupByArea(deferred),
            groupedArchivedProjects: groupByArea(archived),
        };
    }, [projects, selectedArea, selectedTag, ALL_AREAS, NO_AREA, ALL_TAGS, NO_TAGS, areaById, sortedAreas]);

    const handleCreateProject = async (e: FormEvent) => {
        e.preventDefault();
        if (!newProjectTitle.trim() || isCreatingProject) return;
        setIsCreatingProject(true);
        try {
            const resolvedAreaId =
                selectedArea !== ALL_AREAS && selectedArea !== NO_AREA ? selectedArea : undefined;
            const areaColor = resolvedAreaId ? areaById.get(resolvedAreaId)?.color : undefined;
            await addProject(
                newProjectTitle,
                areaColor || DEFAULT_AREA_COLOR,
                resolvedAreaId ? { areaId: resolvedAreaId } : undefined
            );
            setNewProjectTitle('');
            setIsCreating(false);
        } catch (error) {
            reportError('Failed to create project', error);
            showToast(t('projects.createFailed') || 'Failed to create project', 'error');
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
        if (!projectMatchesAreaFilter(selectedProject, selectedArea, areaById)) {
            setSelectedProjectId(null);
        }
    }, [areaById, selectedArea, selectedProject, selectedProjectId, setSelectedProjectId]);

    return (
        <ErrorBoundary>
            <div className="h-full px-4 py-3">
                <div
                    ref={projectsLayoutRef}
                    className="mx-auto flex h-full w-full min-w-0 gap-5 xl:gap-6"
                    style={{ maxWidth: `${projectsLayoutMaxWidth}px` }}
                >
                    <div className="relative min-h-0 flex-none" style={{ width: `${sidebarWidth}px` }}>
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
                                onStartCreate={() => setIsCreating(true)}
                                onCancelCreate={() => setIsCreating(false)}
                                onCreateProject={handleCreateProject}
                                onChangeNewProjectTitle={setNewProjectTitle}
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
                                onSelectProject={setSelectedProjectId}
                                getProjectColor={getProjectColorForTask}
                                tasksByProject={tasksByProject}
                                projects={projects}
                                toggleProjectFocus={toggleProjectFocus}
                                updateProject={updateProject}
                                reorderProjects={reorderProjects}
                                onDuplicateProject={handleDuplicateProject}
                                showToast={showToast}
                            />
                        </div>
                        <div
                            role="separator"
                            aria-controls="projects-sidebar-panel"
                            aria-label={resizeSidebarLabel}
                            aria-orientation="vertical"
                            aria-valuemin={PROJECTS_SIDEBAR_MIN_WIDTH}
                            aria-valuemax={PROJECTS_SIDEBAR_MAX_WIDTH}
                            aria-valuenow={sidebarWidth}
                            title={resizeSidebarLabel}
                            tabIndex={0}
                            onPointerDown={handleSidebarResizePointerDown}
                            onKeyDown={handleSidebarResizeKeyDown}
                            className="absolute -right-3 top-0 z-10 flex h-full w-6 items-center justify-center cursor-col-resize touch-none rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        >
                            <span
                                className={`h-16 w-1 rounded-full transition-colors ${
                                    isSidebarResizing
                                        ? 'bg-primary/70'
                                        : 'bg-border/70 hover:bg-primary/45'
                                }`}
                            />
                        </div>
                    </div>

                    <ProjectWorkspace
                        addProject={addProject}
                        addSection={addSection}
                        addTask={addTask}
                        allTasks={allTasks}
                        allTokens={allTokens}
                        areaById={areaById}
                        areas={areas}
                        deleteProject={deleteProject}
                        deleteSection={deleteSection}
                        highlightTaskId={highlightTaskId}
                        isAreaCreating={isAreaCreating}
                        isCreatingProject={isCreatingProject}
                        language={language}
                        noAreaId={NO_AREA}
                        onDuplicateProject={handleDuplicateProject}
                        onManageAreas={() => setShowAreaManager(true)}
                        onRequestQuickArea={(projectId) => {
                            setPendingAreaAssignProjectId(projectId);
                            setShowQuickAreaPrompt(true);
                        }}
                        projects={projects}
                        reorderProjectTasks={reorderProjectTasks}
                        requestConfirmation={requestConfirmation}
                        sections={sections}
                        selectedProject={selectedProject}
                        selectedProjectId={selectedProjectId}
                        setHighlightTask={setHighlightTask}
                        setSelectedProjectId={setSelectedProjectId}
                        showToast={showToast}
                        sortedAreas={sortedAreas}
                        t={t}
                        updateProject={updateProject}
                        updateSection={updateSection}
                        updateTask={updateTask}
                    />
                </div>

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
                                showToast(t('projects.createAreaFailed') || 'Failed to create area', 'error');
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
                            showToast(t('projects.createAreaFailed') || 'Failed to create area', 'error');
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
