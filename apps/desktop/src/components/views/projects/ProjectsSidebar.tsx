import { useState, useEffect, useRef, useCallback } from 'react';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { AlertTriangle, ChevronDown, ChevronRight, ChevronsLeft, CornerDownRight, Folder, Plus } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { FocusStarIcon } from '../../FocusStarIcon';
import { SortableProjectRow } from './SortableRows';
import { LIST_END_GAP } from '../list/list-toolbar';
import { tFallback, type Area, type Project, type Task } from '@mindwtr/core';
import { ProjectAreaDropZone } from './project-area-dnd';
import {
    isProjectAreaCollapsed,
    type ProjectAreaSection,
    type CollapsedProjectAreas,
} from './project-area-collapse';

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

// Matches core's projectTaskSummaryById value shape (store-types.ts DerivedState),
// computed once in store-helpers.ts computeTaskDerivedState. See #927.
type ProjectTaskSummary = { activeTaskCount: number; nextAction?: Task };

interface ProjectsSidebarProps {
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
    getProjectColor,
    projectTaskSummaryById,
    focusedProjectCount,
    toggleProjectFocus,
    onDuplicateProject,
    draggingSection,
    collapseLabel,
    onToggleCollapsed,
}: ProjectsSidebarProps) {
    const focusedCount = focusedProjectCount;
    const [contextMenu, setContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement | null>(null);
    const contextMenuReturnFocusRef = useRef<HTMLElement | null>(null);
    const pendingProjectSelectionRef = useRef<{ projectId: string; timeoutId: number } | null>(null);

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
            onSelectProject(projectId);
        }, 0);
        pendingProjectSelectionRef.current = { projectId, timeoutId };
    }, [clearPendingProjectSelection, onSelectProject]);

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
        onSelectProject(projectId);
    }, [onSelectProject, shouldIgnoreProjectSelection]);

    const handleProjectKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>, projectId: string) => {
        if (shouldIgnoreProjectSelection(event.target)) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelectProject(projectId);
    }, [onSelectProject, shouldIgnoreProjectSelection]);

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

    return (
        <div className="w-full h-full min-h-0 flex flex-col gap-4 border-r border-border pr-5 xl:pr-6">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                    <h2 className="text-xl font-bold tracking-tight">{t('projects.title')}</h2>
                    {areaFilterLabel && (
                        <span className="text-[10px] uppercase tracking-wide bg-muted/40 text-muted-foreground border border-border/60 rounded-full px-2 py-0.5 truncate max-w-[180px]">
                            {t('projects.areaLabel')}: {areaFilterLabel}
                        </span>
                    )}
                </div>
                {onToggleCollapsed && collapseLabel && (
                    <button
                        type="button"
                        onClick={onToggleCollapsed}
                        className="h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
                        title={collapseLabel}
                        aria-label={collapseLabel}
                        aria-controls="projects-sidebar-panel"
                        aria-expanded={true}
                    >
                        <ChevronsLeft className="w-4 h-4" />
                    </button>
                )}
            </div>

            <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t('projects.tagFilter')}
                </label>
                <select
                    aria-label={t('projects.tagFilter')}
                    value={selectedTag}
                    onChange={(e) => onSelectTag(e.target.value)}
                    className="w-full h-8 text-xs bg-background border border-border rounded px-2 text-foreground"
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
            </div>

            <form
                onSubmit={onCreateProject}
                className="rounded-lg border border-border/70 bg-card/40 p-2.5 space-y-2"
            >
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {createProjectLabel}
                </label>
                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        value={newProjectTitle}
                        onChange={(e) => onChangeNewProjectTitle(e.target.value)}
                        onFocus={onStartCreate}
                        placeholder={t('projects.projectName')}
                        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60 disabled:cursor-not-allowed"
                        disabled={isCreatingProject}
                        aria-busy={isCreatingProject}
                        aria-label={t('projects.projectName')}
                    />
                    <button
                        type="submit"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={!newProjectTitle.trim() || isCreatingProject}
                        title={t('projects.create')}
                        aria-label={createProjectLabel}
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>
                {(isCreating || newProjectTitle.trim().length > 0) && areaOptions.length > 0 && (
                    <select
                        aria-label={t('projects.areaLabel')}
                        value={newProjectAreaId}
                        onChange={(e) => onChangeNewProjectAreaId(e.target.value)}
                        className="w-full h-8 text-xs bg-background border border-border rounded px-2 text-foreground"
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
                {(isCreating || newProjectTitle.trim().length > 0) && (
                    <div className="flex justify-end">
                        <button
                            type="button"
                            onClick={() => {
                                onChangeNewProjectTitle('');
                                onCancelCreate();
                            }}
                            className="text-xs px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground rounded disabled:opacity-60 disabled:cursor-not-allowed"
                            disabled={isCreatingProject}
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                )}
            </form>

            <div className="space-y-3 overflow-y-auto flex-1">
                {groupedActiveProjects.length > 0 && (
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
                                            const nextAction = summary?.nextAction;

                                            return (
                                                <SortableProjectRow key={project.id} projectId={project.id} section="active">
                                                    {({ handle, isDragging, isTaskOver }) => (
                                                <div
                                                    className={cn(
                                                        "group rounded-lg cursor-pointer transition-colors text-sm",
                                                        selectedProjectId === project.id
                                                            ? "bg-primary/10 text-primary"
                                                            : project.isFocused
                                                                ? "bg-warning/10 hover:bg-warning/15"
                                                                : "hover:bg-muted/40 text-foreground",
                                                        isDragging && "opacity-70",
                                                        isTaskOver && "ring-2 ring-primary/50 bg-primary/5",
                                                    )}
                                                    role="button"
                                                    tabIndex={0}
                                                    aria-pressed={selectedProjectId === project.id}
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
                                                                <span className="opacity-40 group-hover:opacity-100 transition-opacity">
                                                                    {handle}
                                                                </span>
                                                                <button
                                                                    data-project-selection-ignore="true"
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        toggleProjectFocus(project.id);
                                                                    }}
                                                                    className={cn(
                                                                        "text-sm transition-colors",
                                                                        project.isFocused ? "text-warning" : "text-muted-foreground hover:text-warning",
                                                                        !project.isFocused && focusedCount >= 5 && "opacity-30 cursor-not-allowed",
                                                                    )}
                                                                    title={project.isFocused ? removeFromFocusLabel : focusedCount >= 5 ? maxFocusedProjectsLabel : addToFocusLabel}
                                                                    aria-label={project.isFocused ? removeFromFocusLabel : addToFocusLabel}
                                                                >
                                                                    <FocusStarIcon className="w-4 h-4" filled={project.isFocused} />
                                                                </button>
                                                                <Folder className="w-4 h-4" style={{ color: getProjectColor(project) }} />
                                                                <span className="flex-1 truncate font-medium" title={project.title}>
                                                                    {project.title}
                                                                </span>
                                                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground min-w-5 text-center">
                                                                    {activeTaskCount}
                                                                </span>
                                                            </div>
                                                            <div className="px-2 pb-2 pl-10">
                                                                {nextAction ? (
                                                                    <span className="text-xs text-muted-foreground truncate flex items-center gap-1" title={nextAction.title}>
                                                                        <CornerDownRight className="w-3 h-3" />
                                                                        {nextAction.title}
                                                                    </span>
                                                                ) : project.isFocused && activeTaskCount > 0 ? (
                                                                    <span className="text-xs text-warning flex items-center gap-1">
                                                                        <AlertTriangle className="w-3 h-3" />
                                                                        {t('projects.noNextAction')}
                                                                    </span>
                                                                ) : null}
                                                            </div>
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
                                                                        "group rounded-lg cursor-pointer transition-colors text-sm",
                                                                        selectedProjectId === project.id
                                                                            ? "bg-primary/10 text-primary"
                                                                            : "hover:bg-muted/40 text-foreground",
                                                                        isDragging && "opacity-70",
                                                                        isTaskOver && "ring-2 ring-primary/50 bg-primary/5",
                                                                    )}
                                                                    role="button"
                                                                    tabIndex={0}
                                                                    aria-pressed={selectedProjectId === project.id}
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
                                                                            <span className="opacity-40 group-hover:opacity-100 transition-opacity">
                                                                                {handle}
                                                                            </span>
                                                                            <Folder className="w-4 h-4" style={{ color: getProjectColor(project) }} />
                                                                            <span className="flex-1 truncate font-medium" title={project.title}>
                                                                                {project.title}
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
                            <span>{tFallback(t, 'projects.completed', 'Completed')}</span>
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
                                                                                "group rounded-lg cursor-pointer transition-colors text-sm",
                                                                                selectedProjectId === project.id
                                                                                    ? "bg-primary/10 text-primary"
                                                                                    : "hover:bg-muted/40 text-foreground",
                                                                                isDragging && "opacity-70",
                                                                            )}
                                                                            role="button"
                                                                            tabIndex={0}
                                                                            aria-pressed={selectedProjectId === project.id}
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
                                                                                <span className="opacity-40 group-hover:opacity-100 transition-opacity">
                                                                                    {handle}
                                                                                </span>
                                                                                <Folder className="w-4 h-4" style={{ color: getProjectColor(project) }} />
                                                                                <span className="flex-1 truncate font-medium" title={project.title}>
                                                                                    {project.title}
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
