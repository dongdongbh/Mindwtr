import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { AlertTriangle, ChevronDown, ChevronRight, CornerDownRight, Folder, Plus, Star } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { SortableProjectRow } from './SortableRows';
import type { Area, Project, StoreActionResult, Task } from '@mindwtr/core';
import { reportError } from '../../../lib/report-error';
import {
    computeProjectAreaDragResult,
    getProjectAreaContainerId,
    ProjectAreaDropZone,
} from './project-area-dnd';

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

type TasksByProject = Record<string, Task[]>;

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
    onStartCreate: () => void;
    onCancelCreate: () => void;
    onCreateProject: (event: React.FormEvent) => void;
    onChangeNewProjectTitle: (value: string) => void;
    onSelectTag: (value: string) => void;
    groupedActiveProjects: GroupedProjects;
    groupedDeferredProjects: GroupedProjects;
    groupedArchivedProjects: GroupedProjects;
    areaById: Map<string, Area>;
    collapsedAreas: Record<string, boolean>;
    onToggleAreaCollapse: (areaId: string) => void;
    showDeferredProjects: boolean;
    onToggleDeferredProjects: () => void;
    showArchivedProjects: boolean;
    onToggleArchivedProjects: () => void;
    selectedProjectId: string | null;
    onSelectProject: (projectId: string) => void;
    getProjectColor: (project: Project) => string;
    tasksByProject: TasksByProject;
    projects: Project[];
    toggleProjectFocus: (projectId: string) => void;
    updateProject: (projectId: string, updates: Partial<Project>) => Promise<StoreActionResult> | void;
    reorderProjects: (projectIds: string[], areaId?: string) => Promise<void> | void;
    onDuplicateProject: (projectId: string) => void;
    showToast?: (message: string, tone?: 'success' | 'error' | 'info', durationMs?: number) => void;
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
    onStartCreate,
    onCancelCreate,
    onCreateProject,
    onChangeNewProjectTitle,
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
    tasksByProject,
    projects,
    toggleProjectFocus,
    updateProject,
    reorderProjects,
    onDuplicateProject,
    showToast,
}: ProjectsSidebarProps) {
    const projectSensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 4 },
        }),
    );

    const focusedCount = useMemo(() => projects.filter((project) => project.isFocused).length, [projects]);
    const [contextMenu, setContextMenu] = useState<{ projectId: string; x: number; y: number } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement | null>(null);
    const pendingProjectSelectionRef = useRef<{ projectId: string; timeoutId: number } | null>(null);

    const closeContextMenu = useCallback(() => setContextMenu(null), []);
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
        const handlePointer = (event: Event) => {
            if (contextMenuRef.current && contextMenuRef.current.contains(event.target as Node)) return;
            closeContextMenu();
        };
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeContextMenu();
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

    const buildProjectDndState = useCallback((groups: GroupedProjects) => {
        const projectIdsByArea = new Map<string, string[]>();
        const projectAreaById = new Map<string, string>();
        groups.forEach(([areaId, areaProjects]) => {
            const ids = areaProjects.map((project) => project.id);
            projectIdsByArea.set(areaId, ids);
            ids.forEach((id) => projectAreaById.set(id, areaId));
        });
        return { projectIdsByArea, projectAreaById };
    }, []);

    const activeProjectDnd = useMemo(() => buildProjectDndState(groupedActiveProjects), [buildProjectDndState, groupedActiveProjects]);
    const deferredProjectDnd = useMemo(() => buildProjectDndState(groupedDeferredProjects), [buildProjectDndState, groupedDeferredProjects]);
    const archivedProjectDnd = useMemo(() => buildProjectDndState(groupedArchivedProjects), [buildProjectDndState, groupedArchivedProjects]);
    const removeFromFocusLabel = t('projects.removeFromFocus');
    const addToFocusLabel = t('projects.addToFocus');
    const maxFocusedProjectsLabel = t('projects.maxFocusedProjects');

    const handleProjectDragEnd = useCallback((dndState: ReturnType<typeof buildProjectDndState>) => (event: DragEndEvent) => {
        const failProjectMove = (error: unknown) => {
            reportError('Failed to move project between areas', error);
            showToast?.('Failed to move project', 'error');
        };
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const move = computeProjectAreaDragResult({
            activeId: String(active.id),
            overId: String(over.id),
            projectIdsByArea: dndState.projectIdsByArea,
            projectAreaById: dndState.projectAreaById,
        });
        if (!move) return;

        const sourceAreaArg = move.sourceAreaId === noAreaId ? undefined : move.sourceAreaId;
        const destinationAreaArg = move.destinationAreaId === noAreaId ? undefined : move.destinationAreaId;

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
    }, [noAreaId, reorderProjects, showToast, updateProject]);

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
                <button
                    onClick={onStartCreate}
                    className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={isCreatingProject}
                >
                    <Plus className="w-4 h-4" />
                </button>
            </div>

            <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t('projects.tagFilter')}
                </label>
                <select
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

            {isCreating && (
                <form onSubmit={onCreateProject} className="border border-border/60 rounded-lg p-3 space-y-3 animate-in slide-in-from-top-2">
                    <input
                        autoFocus
                        type="text"
                        value={newProjectTitle}
                        onChange={(e) => onChangeNewProjectTitle(e.target.value)}
                        placeholder={t('projects.projectName')}
                        className="w-full bg-transparent border-b border-primary/50 p-1 text-sm focus:outline-none disabled:opacity-60 disabled:cursor-not-allowed"
                        disabled={isCreatingProject}
                        aria-busy={isCreatingProject}
                    />
                    <div className="flex gap-2 justify-end">
                        <button
                            type="button"
                            onClick={onCancelCreate}
                            className="text-xs px-2 py-1 hover:bg-muted rounded disabled:opacity-60 disabled:cursor-not-allowed"
                            disabled={isCreatingProject}
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            type="submit"
                            className="text-xs bg-primary text-primary-foreground px-2 py-1 rounded disabled:opacity-60 disabled:cursor-not-allowed"
                            disabled={isCreatingProject}
                        >
                            {t('projects.create')}
                        </button>
                    </div>
                </form>
            )}

            <div className="space-y-3 overflow-y-auto flex-1">
                {groupedActiveProjects.length > 0 && (
                    <div className="pt-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {t('projects.activeSection')}
                    </div>
                )}
                {groupedActiveProjects.length > 0 && (
                    <DndContext
                        sensors={projectSensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleProjectDragEnd(activeProjectDnd)}
                    >
                        {groupedActiveProjects.map(([areaId, areaProjects]) => {
                            const area = areaById.get(areaId);
                            const areaLabel = area ? area.name : t('projects.noArea');
                            const isCollapsed = collapsedAreas[areaId] ?? false;

                            return (
                                <div key={areaId} className="space-y-1">
                                    <button
                                        type="button"
                                        onClick={() => onToggleAreaCollapse(areaId)}
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
                                        <ProjectAreaDropZone id={getProjectAreaContainerId(areaId)} className="space-y-1 rounded-lg">
                                            <SortableContext items={areaProjects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
                                                {areaProjects.map((project) => {
                                            const projTasks = tasksByProject[project.id] || [];
                                            let nextAction = undefined;
                                            let nextCandidate = undefined;
                                            for (const task of projTasks) {
                                                if (!nextCandidate && task.status === 'next') {
                                                    nextCandidate = task;
                                                }
                                                if (!nextAction && task.status === 'inbox') {
                                                    nextAction = task;
                                                }
                                            }
                                            nextAction = nextAction || nextCandidate;

                                            return (
                                                <SortableProjectRow key={project.id} projectId={project.id}>
                                                    {({ handle, isDragging }) => (
                                                <div
                                                    className={cn(
                                                        "group rounded-lg cursor-pointer transition-colors text-sm",
                                                        selectedProjectId === project.id
                                                            ? "bg-primary/10 text-primary"
                                                            : project.isFocused
                                                                ? "bg-amber-500/10 hover:bg-amber-500/15"
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
                                                                <button
                                                                    data-project-selection-ignore="true"
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        toggleProjectFocus(project.id);
                                                                    }}
                                                                    className={cn(
                                                                        "text-sm transition-colors",
                                                                        project.isFocused ? "text-amber-500" : "text-muted-foreground hover:text-amber-500",
                                                                        !project.isFocused && focusedCount >= 5 && "opacity-30 cursor-not-allowed",
                                                                    )}
                                                                    title={project.isFocused ? removeFromFocusLabel : focusedCount >= 5 ? maxFocusedProjectsLabel : addToFocusLabel}
                                                                    aria-label={project.isFocused ? removeFromFocusLabel : addToFocusLabel}
                                                                >
                                                                    <Star className="w-4 h-4" fill={project.isFocused ? 'currentColor' : 'none'} />
                                                                </button>
                                                                <Folder className="w-4 h-4" style={{ color: getProjectColor(project) }} />
                                                                <span className="flex-1 truncate font-medium">{project.title}</span>
                                                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/60 text-muted-foreground min-w-5 text-center">
                                                                    {projTasks.length}
                                                                </span>
                                                            </div>
                                                            <div className="px-2 pb-2 pl-10">
                                                                {nextAction ? (
                                                                    <span className="text-xs text-muted-foreground truncate flex items-center gap-1">
                                                                        <CornerDownRight className="w-3 h-3" />
                                                                        {nextAction.title}
                                                                    </span>
                                                                ) : projTasks.length > 0 ? (
                                                                    <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
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
                                        </ProjectAreaDropZone>
                                    )}
                                </div>
                            );
                        })}
                    </DndContext>
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
                                <DndContext
                                    sensors={projectSensors}
                                    collisionDetection={closestCenter}
                                    onDragEnd={handleProjectDragEnd(deferredProjectDnd)}
                                >
                                    {groupedDeferredProjects.map(([areaId, areaProjects]) => {
                                        const area = areaById.get(areaId);
                                        const areaLabel = area ? area.name : t('projects.noArea');
                                        const isCollapsed = collapsedAreas[areaId] ?? false;

                                        return (
                                            <div key={`deferred-${areaId}`} className="space-y-1">
                                                <button
                                                    type="button"
                                                    onClick={() => onToggleAreaCollapse(areaId)}
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
                                                    <ProjectAreaDropZone id={getProjectAreaContainerId(areaId)} className="space-y-1 rounded-lg">
                                                        <SortableContext items={areaProjects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
                                                            {areaProjects.map((project) => (
                                                            <SortableProjectRow key={project.id} projectId={project.id}>
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
                                                                            <span className="flex-1 truncate font-medium">{project.title}</span>
                                                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground uppercase">
                                                                                {t(`status.${project.status}`) || project.status}
                                                                            </span>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </SortableProjectRow>
                                                            ))}
                                                        </SortableContext>
                                                    </ProjectAreaDropZone>
                                                )}
                                            </div>
                                        );
                                    })}
                                </DndContext>
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
                            <span>{t('status.archived') || 'Archived'}</span>
                            {showArchivedProjects ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                        {showArchivedProjects && (
                            <div className="space-y-3">
                                <DndContext
                                    sensors={projectSensors}
                                    collisionDetection={closestCenter}
                                    onDragEnd={handleProjectDragEnd(archivedProjectDnd)}
                                >
                                    {groupedArchivedProjects.map(([areaId, areaProjects]) => {
                                        const area = areaById.get(areaId);
                                        const areaLabel = area ? area.name : t('projects.noArea');
                                        const isCollapsed = collapsedAreas[areaId] ?? false;

                                        return (
                                            <div key={`archived-${areaId}`} className="space-y-1">
                                                <button
                                                    type="button"
                                                    onClick={() => onToggleAreaCollapse(areaId)}
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
                                                    <ProjectAreaDropZone id={getProjectAreaContainerId(areaId)} className="space-y-1 rounded-lg">
                                                        <SortableContext items={areaProjects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
                                                            {areaProjects.map((project) => (
                                                                <SortableProjectRow key={project.id} projectId={project.id}>
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
                                                                                <span className="flex-1 truncate font-medium">{project.title}</span>
                                                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground uppercase">
                                                                                    {t(`status.${project.status}`) || project.status}
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </SortableProjectRow>
                                                            ))}
                                                        </SortableContext>
                                                    </ProjectAreaDropZone>
                                                )}
                                            </div>
                                        );
                                    })}
                                </DndContext>
                            </div>
                        )}
                    </div>
                )}

                {groupedActiveProjects.length === 0 && groupedDeferredProjects.length === 0 && groupedArchivedProjects.length === 0 && !isCreating && (
                    <div className="text-sm text-muted-foreground text-center py-8 space-y-3">
                        <p className="text-base font-medium text-foreground">
                            {areaFilterLabel
                                ? (t('projects.noProjectsInArea') === 'projects.noProjectsInArea'
                                    ? 'No projects in this area.'
                                    : t('projects.noProjectsInArea'))
                                : t('projects.noProjects')}
                        </p>
                        <p>
                            {areaFilterLabel
                                ? (t('projects.emptyHintFiltered') === 'projects.emptyHintFiltered'
                                    ? 'Try switching the Area filter or create a project in this area.'
                                    : t('projects.emptyHintFiltered'))
                                : (() => {
                                    const hint = t('projects.emptyHint');
                                    return hint === 'projects.emptyHint'
                                        ? 'Create your first project to start organizing work.'
                                        : hint;
                                })()}
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
            </div>

            {contextMenu && (
                <div
                    ref={contextMenuRef}
                    className="fixed z-50 min-w-[160px] rounded-md border border-border bg-card shadow-lg p-1 text-sm"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                    <button
                        type="button"
                        className="w-full text-left px-3 py-2 rounded hover:bg-muted transition-colors"
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
