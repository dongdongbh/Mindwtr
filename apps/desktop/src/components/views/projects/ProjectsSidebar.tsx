import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { AlertTriangle, ChevronDown, ChevronRight, ChevronsLeft, Folder, Plus } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FocusStarIcon } from '../../FocusStarIcon';
import { SortableProjectRow } from './SortableRows';
import { LIST_END_GAP } from '../list/list-toolbar';
import { isFocusedProjectMissingNextAction, tFallback, type Area, type Project, type ProjectTaskSummary } from '@mindwtr/core';
import { ProjectAreaDropZone } from './project-area-dnd';
import {
    isProjectAreaCollapsed,
    type ProjectAreaSection,
    type CollapsedProjectAreas,
} from './project-area-collapse';
import {
    useOptionalKeybindings,
    type ProjectListScope,
} from '../../../contexts/keybinding-context';

const PROJECT_SELECTION_IGNORE_SELECTOR = '[data-project-selection-ignore="true"]';

const getProjectSelectionTarget = (target: EventTarget | null) => {
    if (target instanceof Element) return target;
    if (target instanceof Node) return target.parentElement;
    return null;
};

const isEditableElement = (element: Element | null) =>
    element?.matches('input, textarea, select, [contenteditable="true"]') === true;

type TagOptionList = {
    list: string[];
    hasNoTags: boolean;
};

type GroupedProjects = Array<[string, Project[]]>;

export function getVisibleProjectIds({
    groupedActiveProjects,
    groupedDeferredProjects,
    groupedArchivedProjects,
    collapsedAreas,
    showDeferredProjects,
    showArchivedProjects,
}: {
    groupedActiveProjects: GroupedProjects;
    groupedDeferredProjects: GroupedProjects;
    groupedArchivedProjects: GroupedProjects;
    collapsedAreas: CollapsedProjectAreas;
    showDeferredProjects: boolean;
    showArchivedProjects: boolean;
}): string[] {
    const collectVisible = (
        section: ProjectAreaSection,
        groups: GroupedProjects,
        sectionVisible = true,
    ) => sectionVisible
        ? groups.flatMap(([areaId, areaProjects]) => (
            isProjectAreaCollapsed(collapsedAreas, section, areaId)
                ? []
                : areaProjects.map((project) => project.id)
        ))
        : [];

    return [
        ...collectVisible('active', groupedActiveProjects),
        ...collectVisible('deferred', groupedDeferredProjects, showDeferredProjects),
        ...collectVisible('archived', groupedArchivedProjects, showArchivedProjects),
    ];
}

interface ProjectsSidebarProps {
    embedded?: boolean;
    t: (key: string) => string;
    areaFilterLabel?: string;
    selectedTag: string;
    noAreaId: string;
    allTagsId: string;
    noTagsId: string;
    tagOptions: TagOptionList;
    isCreating: boolean;
    isCreatingProject: boolean;
    newProjectTitle: string;
    newProjectAreaId: string;
    areaOptions: Area[];
    onStartCreate: () => void;
    onCancelCreate: () => void;
    onCreateProject: (event: React.FormEvent) => void;
    onChangeNewProjectTitle: (value: string) => void;
    onChangeNewProjectAreaId: (value: string) => void;
    onSelectTag: (value: string) => void;
    groupedActiveProjects: GroupedProjects;
    groupedDeferredProjects: GroupedProjects;
    groupedArchivedProjects: GroupedProjects;
    areaById: Map<string, Area>;
    collapsedAreas: CollapsedProjectAreas;
    onToggleAreaCollapse: (section: ProjectAreaSection, areaId: string) => void;
    showDeferredProjects: boolean;
    onToggleDeferredProjects: () => void;
    showArchivedProjects: boolean;
    onToggleArchivedProjects: () => void;
    selectedProjectId: string | null;
    onSelectProject: (projectId: string) => void;
    onActivateProject?: (projectId: string) => void;
    navigationVisible?: boolean;
    onRequestNavigationVisible?: () => void;
    getProjectColor: (project: Project) => string;
    projectTaskSummaryById: Map<string, ProjectTaskSummary>;
    projects: Project[];
    focusedProjectCount: number;
    toggleProjectFocus: (projectId: string) => void;
    onDuplicateProject: (projectId: string) => void;
    draggingSection: ProjectAreaSection | null;
    collapseLabel?: string;
    onToggleCollapsed?: () => void;
}

export function ProjectsSidebar({
    t,
    areaFilterLabel,
    selectedTag,
    noAreaId,
    allTagsId,
    noTagsId,
    tagOptions,
    isCreating,
    isCreatingProject,
    newProjectTitle,
    newProjectAreaId,
    areaOptions,
    onStartCreate,
    onCancelCreate,
    onCreateProject,
    onChangeNewProjectTitle,
    onChangeNewProjectAreaId,
    onSelectTag,
    groupedActiveProjects,
    groupedDeferredProjects,
    groupedArchivedProjects,
    areaById,
    collapsedAreas,
    onToggleAreaCollapse,
    showDeferredProjects,
    onToggleDeferredProjects,
    showArchivedProjects,
    onToggleArchivedProjects,
    selectedProjectId,
    onSelectProject,
    onActivateProject,
    navigationVisible = true,
    onRequestNavigationVisible,
    getProjectColor,
    projectTaskSummaryById,
    focusedProjectCount,
    toggleProjectFocus,
    onDuplicateProject,
    draggingSection,
    collapseLabel,
    onToggleCollapsed,
    embedded = false,
}: ProjectsSidebarProps) {
    const focusedCount = focusedProjectCount;
    const [contextMenu, setContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement | null>(null);
    const contextMenuReturnFocusRef = useRef<HTMLElement | null>(null);
    const createProjectInputRef = useRef<HTMLInputElement | null>(null);
    const pendingProjectSelectionRef = useRef<{ projectId: string; timeoutId: number } | null>(null);
    const projectNavigationRootRef = useRef<HTMLDivElement | null>(null);
    const projectRowRefs = useRef(new Map<string, HTMLDivElement>());
    const pendingKeyboardFocusFrameRef = useRef<number | null>(null);
    const focusedProjectIdRef = useRef<string | null>(null);
    const projectListHadFocusRef = useRef(false);
    const previousVisibleProjectIdsRef = useRef<string[]>([]);
    const keybindings = useOptionalKeybindings();
    const registerProjectListScope = keybindings?.registerProjectListScope;

    useEffect(() => {
        if (isCreating && !isCreatingProject) createProjectInputRef.current?.focus();
    }, [isCreating, isCreatingProject]);

    const visibleProjectIds = useMemo(() => getVisibleProjectIds({
        groupedActiveProjects,
        groupedDeferredProjects,
        groupedArchivedProjects,
        collapsedAreas,
        showDeferredProjects,
        showArchivedProjects,
    }), [
        collapsedAreas,
        groupedActiveProjects,
        groupedArchivedProjects,
        groupedDeferredProjects,
        showArchivedProjects,
        showDeferredProjects,
    ]);

    const focusProject = useCallback((projectId: string): boolean => {
        const row = projectRowRefs.current.get(projectId);
        if (!row) return false;
        focusedProjectIdRef.current = projectId;
        projectListHadFocusRef.current = true;
        onSelectProject(projectId);
        row.focus();
        row.scrollIntoView?.({ block: 'nearest' });
        return true;
    }, [onSelectProject]);

    const activateProject = useCallback((projectId: string) => {
        onSelectProject(projectId);
        onActivateProject?.(projectId);
    }, [onActivateProject, onSelectProject]);

    const focusVisibleProjectAt = useCallback((index: number) => {
        if (visibleProjectIds.length === 0) return;
        const boundedIndex = Math.max(0, Math.min(index, visibleProjectIds.length - 1));
        focusProject(visibleProjectIds[boundedIndex]);
    }, [focusProject, visibleProjectIds]);

    const currentVisibleProjectIndex = useCallback(() => {
        const active = document.activeElement;
        const focusedId = active instanceof HTMLElement
            ? active.closest<HTMLElement>('[data-project-navigation-item]')?.dataset.projectId
            : undefined;
        const currentId = focusedId ?? selectedProjectId ?? focusedProjectIdRef.current;
        return currentId ? visibleProjectIds.indexOf(currentId) : -1;
    }, [selectedProjectId, visibleProjectIds]);

    const projectNavigationScope = useMemo<ProjectListScope>(() => ({
        kind: 'projectList',
        selectNext: () => {
            const currentIndex = currentVisibleProjectIndex();
            focusVisibleProjectAt(currentIndex < 0 ? 0 : currentIndex + 1);
        },
        selectPrev: () => {
            const currentIndex = currentVisibleProjectIndex();
            focusVisibleProjectAt(currentIndex < 0 ? visibleProjectIds.length - 1 : currentIndex - 1);
        },
        selectFirst: () => focusVisibleProjectAt(0),
        selectLast: () => focusVisibleProjectAt(visibleProjectIds.length - 1),
        focusSelected: () => {
            const targetId = selectedProjectId && visibleProjectIds.includes(selectedProjectId)
                ? selectedProjectId
                : visibleProjectIds[0];
            if (!targetId) return false;
            if (!navigationVisible && onRequestNavigationVisible) {
                onRequestNavigationVisible();
                if (pendingKeyboardFocusFrameRef.current !== null) {
                    window.cancelAnimationFrame(pendingKeyboardFocusFrameRef.current);
                }
                pendingKeyboardFocusFrameRef.current = window.requestAnimationFrame(() => {
                    pendingKeyboardFocusFrameRef.current = null;
                    focusProject(targetId);
                });
                return true;
            }
            return focusProject(targetId);
        },
        activateSelected: () => {
            const currentIndex = currentVisibleProjectIndex();
            const targetId = currentIndex >= 0 ? visibleProjectIds[currentIndex] : selectedProjectId;
            if (targetId) onActivateProject?.(targetId);
        },
        ownsFocus: () => {
            const active = document.activeElement;
            if (!(active instanceof HTMLElement) || !projectNavigationRootRef.current?.contains(active)) {
                return false;
            }
            return active.closest('[data-project-navigation-item]') !== null
                && active.closest(PROJECT_SELECTION_IGNORE_SELECTOR) === null;
        },
    }), [
        currentVisibleProjectIndex,
        focusProject,
        focusVisibleProjectAt,
        navigationVisible,
        onActivateProject,
        onRequestNavigationVisible,
        selectedProjectId,
        visibleProjectIds,
    ]);

    useEffect(() => {
        if (!registerProjectListScope) return;
        registerProjectListScope(projectNavigationScope);
        return () => registerProjectListScope(null);
    }, [projectNavigationScope, registerProjectListScope]);

    useEffect(() => {
        const previousIds = previousVisibleProjectIdsRef.current;
        previousVisibleProjectIdsRef.current = visibleProjectIds;
        const focusedProjectId = focusedProjectIdRef.current;
        const selectedWasRemoved = selectedProjectId !== null
            && previousIds.includes(selectedProjectId)
            && !visibleProjectIds.includes(selectedProjectId);
        const focusedProjectWasRemoved = projectListHadFocusRef.current
            && focusedProjectId !== null
            && previousIds.includes(focusedProjectId)
            && !visibleProjectIds.includes(focusedProjectId);
        if (!selectedWasRemoved && !focusedProjectWasRemoved) return;
        if (visibleProjectIds.length === 0) {
            focusedProjectIdRef.current = null;
            projectListHadFocusRef.current = false;
            return;
        }

        const removedId = focusedProjectWasRemoved ? focusedProjectId : selectedProjectId;
        const removedIndex = removedId ? previousIds.indexOf(removedId) : 0;
        const fallbackId = selectedProjectId && visibleProjectIds.includes(selectedProjectId)
            ? selectedProjectId
            : visibleProjectIds[Math.min(Math.max(removedIndex, 0), visibleProjectIds.length - 1)];
        const active = document.activeElement;
        const focusWasLostWithRemovedRow = focusedProjectWasRemoved
            && projectListHadFocusRef.current
            && (
                !(active instanceof HTMLElement)
                || active === document.body
                || !active.isConnected
            );
        if (focusWasLostWithRemovedRow) {
            focusProject(fallbackId);
        } else {
            projectListHadFocusRef.current = false;
            onSelectProject(fallbackId);
        }
    }, [focusProject, onSelectProject, selectedProjectId, visibleProjectIds]);

    const setProjectRowRef = useCallback((projectId: string, row: HTMLDivElement | null) => {
        if (row) {
            projectRowRefs.current.set(projectId, row);
        } else {
            projectRowRefs.current.delete(projectId);
        }
    }, []);

    const handleProjectFocus = useCallback((event: React.FocusEvent<HTMLDivElement>, projectId: string) => {
        if (getProjectSelectionTarget(event.target)?.closest(PROJECT_SELECTION_IGNORE_SELECTOR)) return;
        focusedProjectIdRef.current = projectId;
        projectListHadFocusRef.current = true;
        if (selectedProjectId !== projectId) onSelectProject(projectId);
    }, [onSelectProject, selectedProjectId]);

    const handleProjectBlur = useCallback(() => {
        window.setTimeout(() => {
            const active = document.activeElement;
            if (
                active instanceof HTMLElement
                && projectNavigationRootRef.current?.contains(active)
                && active.closest('[data-project-navigation-item]')
                && !active.closest(PROJECT_SELECTION_IGNORE_SELECTOR)
            ) {
                return;
            }
            projectListHadFocusRef.current = false;
        }, 0);
    }, []);

    const closeContextMenu = useCallback(() => {
        setContextMenu(null);
        const returnFocus = contextMenuReturnFocusRef.current;
        contextMenuReturnFocusRef.current = null;
        if (returnFocus?.isConnected) {
            window.setTimeout(() => returnFocus.focus(), 0);
        }
    }, []);
    const clearPendingProjectSelection = useCallback(() => {
        if (!pendingProjectSelectionRef.current) return;
        window.clearTimeout(pendingProjectSelectionRef.current.timeoutId);
        pendingProjectSelectionRef.current = null;
    }, []);

    const deferProjectSelection = useCallback((projectId: string) => {
        clearPendingProjectSelection();
        const timeoutId = window.setTimeout(() => {
            pendingProjectSelectionRef.current = null;
            activateProject(projectId);
        }, 0);
        pendingProjectSelectionRef.current = { projectId, timeoutId };
    }, [activateProject, clearPendingProjectSelection]);

    const shouldIgnoreProjectSelection = useCallback((target: EventTarget | null) => {
        const element = getProjectSelectionTarget(target);
        return element?.closest(PROJECT_SELECTION_IGNORE_SELECTOR) !== null;
    }, []);

    const handleProjectMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>, projectId: string) => {
        if (event.button !== 0) return;
        if (shouldIgnoreProjectSelection(event.target)) return;
        const activeElement = document.activeElement instanceof Element ? document.activeElement : null;
        const clickedRow = event.currentTarget;
        if (
            activeElement
            && activeElement !== document.body
            && activeElement !== clickedRow
            && !clickedRow.contains(activeElement)
            && isEditableElement(activeElement)
        ) {
            deferProjectSelection(projectId);
            (activeElement as HTMLElement).blur();
            return;
        }
        onSelectProject(projectId);
    }, [deferProjectSelection, onSelectProject, shouldIgnoreProjectSelection]);

    const handleProjectClick = useCallback((event: React.MouseEvent<HTMLDivElement>, projectId: string) => {
        if (shouldIgnoreProjectSelection(event.target)) return;
        if (pendingProjectSelectionRef.current?.projectId === projectId) return;
        activateProject(projectId);
    }, [activateProject, shouldIgnoreProjectSelection]);

    const handleProjectKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>, projectId: string) => {
        if (shouldIgnoreProjectSelection(event.target)) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activateProject(projectId);
    }, [activateProject, shouldIgnoreProjectSelection]);

    useEffect(() => {
        if (!contextMenu) return;
        contextMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
        const handlePointer = (event: Event) => {
            if (contextMenuRef.current && contextMenuRef.current.contains(event.target as Node)) return;
            closeContextMenu();
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            closeContextMenu();
        };
        window.addEventListener('mousedown', handlePointer);
        window.addEventListener('scroll', handlePointer, true);
        window.addEventListener('resize', handlePointer);
        window.addEventListener('contextmenu', handlePointer);
        window.addEventListener('keydown', handleKey);
        return () => {
            window.removeEventListener('mousedown', handlePointer);
            window.removeEventListener('scroll', handlePointer, true);
            window.removeEventListener('resize', handlePointer);
            window.removeEventListener('contextmenu', handlePointer);
            window.removeEventListener('keydown', handleKey);
        };
    }, [contextMenu, closeContextMenu]);

    useEffect(() => () => {
        clearPendingProjectSelection();
        if (pendingKeyboardFocusFrameRef.current !== null) {
            window.cancelAnimationFrame(pendingKeyboardFocusFrameRef.current);
        }
    }, [clearPendingProjectSelection]);

    const renderMissingAreaDropTargets = (section: ProjectAreaSection, groups: GroupedProjects) => {
        if (draggingSection !== section) return null;
        const present = new Set(groups.map(([groupAreaId]) => groupAreaId));
        const targets = [
            ...(present.has(noAreaId) ? [] : [{ id: noAreaId, name: t('projects.noArea'), color: undefined as string | undefined }]),
            ...areaOptions
                .filter((area) => !present.has(area.id))
                .map((area) => ({ id: area.id, name: area.name, color: area.color })),
        ];
        if (targets.length === 0) return null;
        return (
            <div className="space-y-1 pt-1">
                {targets.map((target) => (
                    <ProjectAreaDropZone
                        key={`${section}-target-${target.id}`}
                        section={section}
                        areaId={target.id}
                        className="rounded-lg border border-dashed border-border/60 px-2 py-1.5"
                    >
                        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            {target.color && (
                                <span
                                    className="w-2 h-2 rounded-full border border-border/50"
                                    style={{ backgroundColor: target.color }}
                                />
                            )}
                            {target.name}
                        </span>
                    </ProjectAreaDropZone>
                ))}
            </div>
        );
    };
    const removeFromFocusLabel = t('projects.removeFromFocus');
    const addToFocusLabel = t('projects.addToFocus');
    const maxFocusedProjectsLabel = t('projects.maxFocusedProjects');
    const createProjectLabel = `${tFallback(t, 'projects.create', 'Create')} ${tFallback(t, 'taskEdit.projectLabel', 'Project')}`;
    const newProjectLabel = tFallback(t, 'projects.new', 'New project');

    return (
        <div
            ref={projectNavigationRootRef}
            data-project-navigation-root
            className={cn("w-full min-h-0 flex flex-col gap-4", !embedded && "h-full border-r border-border pr-5 xl:pr-6")}
        >
            <div data-projects-sidebar-header className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <h2 className={embedded ? "text-xs font-semibold text-muted-foreground uppercase tracking-wide" : "text-xl font-bold tracking-tight"}>{t(embedded ? 'projects.activeSection' : 'projects.title')}</h2>
                    {areaFilterLabel && (
                        <span className="text-[10px] uppercase tracking-wide bg-muted/40 text-muted-foreground border border-border/60 rounded-full px-2 py-0.5 truncate max-w-[180px]">
                            {t('projects.areaLabel')}: {areaFilterLabel}
                        </span>
                    )}
                </div>
                <div className="flex flex-none items-center gap-1">
                    {!isCreating && (
                        <button
                            type="button"
                            onClick={onStartCreate}
                            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                            {newProjectLabel}
                        </button>
                    )}
                    {onToggleCollapsed && collapseLabel && (
                        <button
                            type="button"
                            onClick={onToggleCollapsed}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
                            title={collapseLabel}
                            aria-label={collapseLabel}
                            aria-controls="projects-sidebar-panel"
                            aria-expanded={true}
                        >
                            <ChevronsLeft className="h-4 w-4" />
                        </button>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-2">
                <label htmlFor="projects-tag-filter" className="flex-none text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('projects.tagFilter')}
                </label>
                <div className="relative min-w-0 flex-1" data-project-tag-filter-shell>
                    <select
                        id="projects-tag-filter"
                        aria-label={t('projects.tagFilter')}
                        value={selectedTag}
                        onChange={(e) => onSelectTag(e.target.value)}
                        className={cn(
                            'h-8 w-full appearance-none rounded border border-border/50 bg-transparent px-2 pr-7 text-xs transition-colors hover:border-border focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                            tagOptions.list.includes(selectedTag) ? 'text-foreground' : 'text-muted-foreground',
                        )}
                    >
                        <option value={allTagsId}>{t('projects.allTags')}</option>
                        {tagOptions.list.map((tag) => (
                            <option key={tag} value={tag}>
                                {tag}
                            </option>
                        ))}
                        {tagOptions.hasNoTags && (
                            <option value={noTagsId}>{t('projects.noTags')}</option>
                        )}
                    </select>
                    <ChevronDown
                        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                </div>
            </div>

            {isCreating && (
                <form
                    onSubmit={onCreateProject}
                    className="space-y-2 rounded-lg border border-border/70 bg-card/40 p-2.5"
                >
                    <label className="sr-only" htmlFor="new-project-title">
                        {createProjectLabel}
                    </label>
                    <div className="flex items-center gap-2">
                        <input
                            ref={createProjectInputRef}
                            id="new-project-title"
                            type="text"
                            value={newProjectTitle}
                            onChange={(e) => onChangeNewProjectTitle(e.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                    event.preventDefault();
                                    onCancelCreate();
                                } else if (event.key === 'Enter' && newProjectTitle.trim()) {
                                    event.preventDefault();
                                    event.currentTarget.form?.requestSubmit();
                                }
                            }}
                            placeholder={t('projects.projectName')}
                            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={isCreatingProject}
                            aria-busy={isCreatingProject}
                            aria-label={t('projects.projectName')}
                        />
                        <button
                            type="submit"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={!newProjectTitle.trim() || isCreatingProject}
                            title={t('projects.create')}
                            aria-label={createProjectLabel}
                        >
                            <Plus className="h-4 w-4" />
                        </button>
                    </div>
                    {areaOptions.length > 0 && (
                        <select
                            aria-label={t('projects.areaLabel')}
                            value={newProjectAreaId}
                            onChange={(e) => onChangeNewProjectAreaId(e.target.value)}
                            className="h-8 w-full rounded border border-border bg-background px-2 text-xs text-foreground"
                            disabled={isCreatingProject}
                        >
                            <option value="">{t('projects.noArea')}</option>
                            {areaOptions.map((area) => (
                                <option key={area.id} value={area.id}>
                                    {area.name}
                                </option>
                            ))}
                        </select>
                    )}
                    <div className="flex justify-end">
                        <button
                            type="button"
                            onClick={onCancelCreate}
                            className="text-xs px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground rounded disabled:opacity-60 disabled:cursor-not-allowed"
                            disabled={isCreatingProject}
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                </form>
            )}

            <div className={embedded ? "space-y-3" : "space-y-3 overflow-y-auto flex-1"}>
                {!embedded && groupedActiveProjects.length > 0 && (
                    <div className="pt-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {t('projects.activeSection')}
                    </div>
                )}
                {groupedActiveProjects.length > 0 && (
                    <>
                        {groupedActiveProjects.map(([areaId, areaProjects]) => {
                            const area = areaById.get(areaId);
                            const areaLabel = area ? area.name : t('projects.noArea');
                            const isCollapsed = isProjectAreaCollapsed(collapsedAreas, 'active', areaId);

                            return (
                                <ProjectAreaDropZone key={areaId} section="active" areaId={areaId} className="space-y-1 rounded-lg">
                                    <button
                                        type="button"
                                        onClick={() => onToggleAreaCollapse('active', areaId)}
                                        className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
                                    >
                                        <span className="flex items-center gap-2">
                                            {area?.color && (
                                                <span
                                                    className="w-2 h-2 rounded-full border border-border/50"
                                                    style={{ backgroundColor: area.color }}
                                                />
                                            )}
                                            {area?.icon && <span className="text-[10px]">{area.icon}</span>}
                                            {areaLabel}
                                        </span>
                                        {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                    </button>
                                    {!isCollapsed && (
                                            <SortableContext items={areaProjects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
                                                {areaProjects.map((project) => {
                                            const summary = projectTaskSummaryById.get(project.id);
                                            const activeTaskCount = summary?.activeTaskCount ?? 0;
                                            const showFocusedWarning = isFocusedProjectMissingNextAction(project, summary);

                                            return (
                                                <SortableProjectRow key={project.id} projectId={project.id} section="active">
                                                    {({ handle, isDragging, isTaskOver }) => (
                                                <div
                                                    className={cn(
                                                        "group rounded-lg cursor-pointer transition-colors text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                                        selectedProjectId === project.id
                                                            ? "bg-primary/10 text-primary"
                                                            : "hover:bg-muted/40 text-foreground",
                                                        isDragging && "opacity-70",
                                                        isTaskOver && "ring-2 ring-primary/50 bg-primary/5",
                                                    )}
                                                    role="button"
                                                    tabIndex={0}
                                                    data-project-navigation-item
                                                    data-project-id={project.id}
                                                    aria-pressed={selectedProjectId === project.id}
                                                    ref={(row) => setProjectRowRef(project.id, row)}
                                                    onFocus={(event) => handleProjectFocus(event, project.id)}
                                                    onBlur={handleProjectBlur}
                                                    onMouseDown={(event) => handleProjectMouseDown(event, project.id)}
                                                    onClick={(event) => handleProjectClick(event, project.id)}
                                                    onKeyDown={(event) => handleProjectKeyDown(event, project.id)}
                                                    onContextMenu={(event) => {
                                                        event.preventDefault();
                                                        contextMenuReturnFocusRef.current = event.currentTarget;
                                                        setContextMenu({
                                                                    projectId: project.id,
                                                                    x: event.clientX,
                                                                    y: event.clientY,
                                                                });
                                                            }}
                                                        >
                                                    <div className="flex items-center gap-2 px-2 py-2">
                                                                <div data-project-leading-icon className="relative flex h-8 w-8 flex-none items-center justify-center">
                                                                    <Folder
                                                                        className="h-4 w-4 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0"
                                                                        style={{ color: getProjectColor(project) }}
                                                                    />
                                                                    <span className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                                                                        {handle}
                                                                    </span>
                                                                </div>
                                                                <span className="flex-1 truncate font-medium" title={project.title}>
                                                                    {project.title}
                                                                    {isTaskOver && <span className="ml-2 text-xs text-primary">{t('task.moveTo')}</span>}
                                                                </span>
                                                                <button
                                                                    data-project-selection-ignore="true"
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        toggleProjectFocus(project.id);
                                                                    }}
                                                                    className={cn(
                                                                        "inline-flex h-8 w-8 flex-none items-center justify-center rounded-md text-sm transition-[color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                                                                        project.isFocused ? "text-warning" : "text-muted-foreground hover:text-warning",
                                                                        !project.isFocused && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
                                                                        !project.isFocused && focusedCount >= 5 && "opacity-30 cursor-not-allowed",
                                                                    )}
                                                                    title={project.isFocused ? removeFromFocusLabel : focusedCount >= 5 ? maxFocusedProjectsLabel : addToFocusLabel}
                                                                    aria-label={project.isFocused ? removeFromFocusLabel : addToFocusLabel}
                                                                >
                                                                    <FocusStarIcon className="h-4 w-4" filled={project.isFocused} />
                                                                </button>
                                                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground min-w-5 text-center">
                                                                    {activeTaskCount}
                                                                </span>
                                                            </div>
                                                            {showFocusedWarning && (
                                                            <div className="px-2 pb-2 pl-12">
                                                                    <span className="text-xs text-warning flex items-center gap-1">
                                                                        <AlertTriangle className="w-3 h-3" />
                                                                        {t('projects.noNextAction')}
                                                                    </span>
                                                            </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </SortableProjectRow>
                                            );
                                                })}
                                            </SortableContext>
                                    )}
                                </ProjectAreaDropZone>
                            );
                        })}
                        {renderMissingAreaDropTargets('active', groupedActiveProjects)}
                    </>
                )}

                {groupedDeferredProjects.length > 0 && (
                    <div className="pt-2 border-t border-border/60">
                        <button
                            type="button"
                            onClick={onToggleDeferredProjects}
                            className="w-full flex items-center justify-between py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
                        >
                            <span>{t('projects.deferredSection')}</span>
                            {showDeferredProjects ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                        {showDeferredProjects && (
                            <div className="space-y-3">
                                    {groupedDeferredProjects.map(([areaId, areaProjects]) => {
                                        const area = areaById.get(areaId);
                                        const areaLabel = area ? area.name : t('projects.noArea');
                                        const isCollapsed = isProjectAreaCollapsed(collapsedAreas, 'deferred', areaId);

                                        return (
                                            <ProjectAreaDropZone key={`deferred-${areaId}`} section="deferred" areaId={areaId} className="space-y-1 rounded-lg">
                                                <button
                                                    type="button"
                                                    onClick={() => onToggleAreaCollapse('deferred', areaId)}
                                                    className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
                                                >
                                                    <span className="flex items-center gap-2">
                                                        {area?.color && (
                                                            <span
                                                                className="w-2 h-2 rounded-full border border-border/50"
                                                                style={{ backgroundColor: area.color }}
                                                            />
                                                        )}
                                                        {area?.icon && <span className="text-[10px]">{area.icon}</span>}
                                                        {areaLabel}
                                                    </span>
                                                    {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                                </button>
                                                {!isCollapsed && (
                                                        <SortableContext items={areaProjects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
                                                            {areaProjects.map((project) => (
                                                            <SortableProjectRow key={project.id} projectId={project.id} section="deferred">
                                                                {({ handle, isDragging, isTaskOver }) => (
                                                                    <div
                                                                    className={cn(
                                                                        "group rounded-lg cursor-pointer transition-colors text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                                                        selectedProjectId === project.id
                                                                            ? "bg-primary/10 text-primary"
                                                                            : "hover:bg-muted/40 text-foreground",
                                                                        isDragging && "opacity-70",
                                                                        isTaskOver && "ring-2 ring-primary/50 bg-primary/5",
                                                                    )}
                                                                    role="button"
                                                                    tabIndex={0}
                                                                    data-project-navigation-item
                                                                    data-project-id={project.id}
                                                                    aria-pressed={selectedProjectId === project.id}
                                                                    ref={(row) => setProjectRowRef(project.id, row)}
                                                                    onFocus={(event) => handleProjectFocus(event, project.id)}
                                                                    onBlur={handleProjectBlur}
                                                                    onMouseDown={(event) => handleProjectMouseDown(event, project.id)}
                                                                    onClick={(event) => handleProjectClick(event, project.id)}
                                                                    onKeyDown={(event) => handleProjectKeyDown(event, project.id)}
                                                                    onContextMenu={(event) => {
                                                                        event.preventDefault();
                                                                        setContextMenu({
                                                                            projectId: project.id,
                                                                            x: event.clientX,
                                                                                y: event.clientY,
                                                                            });
                                                                        }}
                                                                    >
                                                                        <div className="flex items-center gap-2 px-2 py-2">
                                                                            <div data-project-leading-icon className="relative flex h-8 w-8 flex-none items-center justify-center">
                                                                                <Folder
                                                                                    className="h-4 w-4 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0"
                                                                                    style={{ color: getProjectColor(project) }}
                                                                                />
                                                                                <span className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                                                                                    {handle}
                                                                                </span>
                                                                            </div>
                                                                            <span className="flex-1 truncate font-medium" title={project.title}>
                                                                                {project.title}
                                                                    {isTaskOver && <span className="ml-2 text-xs text-primary">{t('task.moveTo')}</span>}
                                                                            </span>
                                                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground uppercase">
                                                                                {tFallback(t, `status.${project.status}`, project.status)}
                                                                            </span>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </SortableProjectRow>
                                                            ))}
                                                        </SortableContext>
                                                )}
                                            </ProjectAreaDropZone>
                                        );
                                    })}
                                    {renderMissingAreaDropTargets('deferred', groupedDeferredProjects)}
                            </div>
                        )}
                    </div>
                )}

                {groupedArchivedProjects.length > 0 && (
                    <div className="pt-2 border-t border-border/60">
                        <button
                            type="button"
                            onClick={onToggleArchivedProjects}
                            className="w-full flex items-center justify-between py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
                        >
                            <span>{tFallback(t, 'projects.closed', 'Closed')}</span>
                            {showArchivedProjects ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                        {showArchivedProjects && (
                            <div className="space-y-3">
                                    {groupedArchivedProjects.map(([areaId, areaProjects]) => {
                                        const area = areaById.get(areaId);
                                        const areaLabel = area ? area.name : t('projects.noArea');
                                        const isCollapsed = isProjectAreaCollapsed(collapsedAreas, 'archived', areaId);

                                        return (
                                            <ProjectAreaDropZone key={`archived-${areaId}`} section="archived" areaId={areaId} className="space-y-1 rounded-lg">
                                                <button
                                                    type="button"
                                                    onClick={() => onToggleAreaCollapse('archived', areaId)}
                                                    className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
                                                >
                                                    <span className="flex items-center gap-2">
                                                        {area?.color && (
                                                            <span
                                                                className="w-2 h-2 rounded-full border border-border/50"
                                                                style={{ backgroundColor: area.color }}
                                                            />
                                                        )}
                                                        {area?.icon && <span className="text-[10px]">{area.icon}</span>}
                                                        {areaLabel}
                                                    </span>
                                                    {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                                </button>
                                                {!isCollapsed && (
                                                        <SortableContext items={areaProjects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
                                                            {areaProjects.map((project) => (
                                                                <SortableProjectRow key={project.id} projectId={project.id} section="archived">
                                                                    {({ handle, isDragging }) => (
                                                                        <div
                                                                            className={cn(
                                                                                "group rounded-lg cursor-pointer transition-colors text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                                                                selectedProjectId === project.id
                                                                                    ? "bg-primary/10 text-primary"
                                                                                    : "hover:bg-muted/40 text-foreground",
                                                                                isDragging && "opacity-70",
                                                                            )}
                                                                            role="button"
                                                                            tabIndex={0}
                                                                            data-project-navigation-item
                                                                            data-project-id={project.id}
                                                                            aria-pressed={selectedProjectId === project.id}
                                                                            ref={(row) => setProjectRowRef(project.id, row)}
                                                                            onFocus={(event) => handleProjectFocus(event, project.id)}
                                                                            onBlur={handleProjectBlur}
                                                                            onMouseDown={(event) => handleProjectMouseDown(event, project.id)}
                                                                            onClick={(event) => handleProjectClick(event, project.id)}
                                                                            onKeyDown={(event) => handleProjectKeyDown(event, project.id)}
                                                                            onContextMenu={(event) => {
                                                                                event.preventDefault();
                                                                                setContextMenu({
                                                                                    projectId: project.id,
                                                                                    x: event.clientX,
                                                                                    y: event.clientY,
                                                                                });
                                                                            }}
                                                                        >
                                                                            <div className="flex items-center gap-2 px-2 py-2">
                                                                                <div data-project-leading-icon className="relative flex h-8 w-8 flex-none items-center justify-center">
                                                                                    <Folder
                                                                                        className="h-4 w-4 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0"
                                                                                        style={{ color: getProjectColor(project) }}
                                                                                    />
                                                                                    <span className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                                                                                        {handle}
                                                                                    </span>
                                                                                </div>
                                                                                <span className="flex-1 truncate font-medium" title={project.title}>
                                                                                    {project.title}
                                                                                </span>
                                                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground uppercase">
                                                                                    {project.cancelledAt
                                                                                        ? tFallback(t, 'projects.cancelled', 'Cancelled')
                                                                                        : tFallback(t, 'list.done', 'Completed')}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </SortableProjectRow>
                                                            ))}
                                                        </SortableContext>
                                                )}
                                            </ProjectAreaDropZone>
                                        );
                                    })}
                                    {renderMissingAreaDropTargets('archived', groupedArchivedProjects)}
                            </div>
                        )}
                    </div>
                )}

                {groupedActiveProjects.length === 0 && groupedDeferredProjects.length === 0 && groupedArchivedProjects.length === 0 && !isCreating && (
                    <div className="text-sm text-muted-foreground text-center py-8 space-y-3">
                        <p className="text-base font-medium text-foreground">
                            {areaFilterLabel
                                ? tFallback(t, 'projects.noProjectsInArea', 'No projects in this area.')
                                : t('projects.noProjects')}
                        </p>
                        <p>
                            {areaFilterLabel
                                ? tFallback(t, 'projects.emptyHintFiltered', 'Try switching the Area filter or create a project in this area.')
                                : tFallback(t, 'projects.emptyHint', 'Create your first project to start organizing work.')}
                        </p>
                        <button
                            type="button"
                            onClick={onStartCreate}
                            className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                        >
                            {t('projects.create')}
                        </button>
                    </div>
                )}
                <div data-list-end className={LIST_END_GAP} aria-hidden="true" />
            </div>

            {contextMenu && (
                <div
                    ref={contextMenuRef}
                    role="menu"
                    className="fixed z-50 min-w-[160px] rounded-md border border-border bg-card shadow-lg p-1 text-sm"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                    <button
                        type="button"
                        role="menuitem"
                        className="w-full text-left px-3 py-2 rounded hover:bg-muted transition-colors focus:outline-none focus:bg-muted focus-visible:ring-2 focus-visible:ring-primary/40"
                        onClick={() => {
                            onDuplicateProject(contextMenu.projectId);
                            closeContextMenu();
                        }}
                    >
                        {t('projects.duplicate')}
                    </button>
                </div>
            )}
        </div>
    );
}
