import { useState, useMemo, useEffect, useCallback, type ReactNode } from 'react';
import { ErrorBoundary } from '../ErrorBoundary';
import { useTaskStore, Attachment, Task, type Project, type Section, generateUUID, parseQuickAdd } from '@mindwtr/core';
import { ChevronDown, ChevronRight, FileText, Folder, Pencil, Plus, Trash2 } from 'lucide-react';
import { DndContext, PointerSensor, MeasuringStrategy, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { useLanguage } from '../../contexts/language-context';
import { PromptModal } from '../PromptModal';
import { normalizeAttachmentInput } from '../../lib/attachment-utils';
import { cn } from '../../lib/utils';
import { SortableProjectTaskRow } from './projects/SortableRows';
import { ProjectsSidebar } from './projects/ProjectsSidebar';
import { AreaManagerModal } from './projects/AreaManagerModal';
import { ProjectNotesSection } from './projects/ProjectNotesSection';
import { ProjectDetailsHeader } from './projects/ProjectDetailsHeader';
import { ProjectDetailsFields } from './projects/ProjectDetailsFields';
import { TaskItem } from '../TaskItem';
import { TaskInput } from '../Task/TaskInput';
import {
    DEFAULT_AREA_COLOR,
    getProjectColor,
    parseTagInput,
    sortAreasByColor as sortAreasByColorIds,
    sortAreasByName as sortAreasByNameIds,
    toDateInputValue,
    toDateTimeLocalValue,
} from './projects/projects-utils';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { useUiStore } from '../../store/ui-store';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, projectMatchesAreaFilter } from '../../lib/area-filter';
import { reportError } from '../../lib/report-error';
import { useAreaSidebarState } from './projects/useAreaSidebarState';
import { useProjectAttachmentActions } from './projects/useProjectAttachmentActions';
import { SectionDropZone, getSectionContainerId, getSectionIdFromContainer, NO_SECTION_CONTAINER } from './projects/section-dnd';
import { useProjectSectionActions } from './projects/useProjectSectionActions';
import { useProjectsViewStore } from './projects/useProjectsViewStore';
import { projectTaskCollisionDetection } from './projects/project-task-dnd';
import { splitProjectsForSidebar } from './projects/project-sidebar-grouping';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

const projectTaskDndMeasuring = {
    droppable: {
        strategy: MeasuringStrategy.WhileDragging,
        frequency: 16,
    },
} as const;

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
    const [showNotesPreview, setShowNotesPreview] = useState(true);
    const [showDeferredProjects, setShowDeferredProjects] = useState(false);
    const [showArchivedProjects, setShowArchivedProjects] = useState(false);
    const [collapsedAreas, setCollapsedAreas] = useState<Record<string, boolean>>({});
    const [showAreaManager, setShowAreaManager] = useState(false);
    const [newAreaName, setNewAreaName] = useState('');
    const [newAreaColor, setNewAreaColor] = useState(DEFAULT_AREA_COLOR);
    const [showQuickAreaPrompt, setShowQuickAreaPrompt] = useState(false);
    const [pendingAreaAssignProjectId, setPendingAreaAssignProjectId] = useState<string | null>(null);
    const [showSectionPrompt, setShowSectionPrompt] = useState(false);
    const [sectionDraft, setSectionDraft] = useState('');
    const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
    const [sectionNotesOpen, setSectionNotesOpen] = useState<Record<string, boolean>>({});
    const [showSectionTaskPrompt, setShowSectionTaskPrompt] = useState(false);
    const [sectionTaskDraft, setSectionTaskDraft] = useState('');
    const [sectionTaskTargetId, setSectionTaskTargetId] = useState<string | null>(null);
    const [tagDraft, setTagDraft] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [editProjectTitle, setEditProjectTitle] = useState('');
    const [projectTaskTitle, setProjectTaskTitle] = useState('');
    const [projectDetailsExpanded, setProjectDetailsExpanded] = useState(false);
    const [isCreatingProject, setIsCreatingProject] = useState(false);
    const [isProjectDeleting, setIsProjectDeleting] = useState(false);
    const [isAreaCreating, setIsAreaCreating] = useState(false);
    const ALL_AREAS = AREA_FILTER_ALL;
    const NO_AREA = AREA_FILTER_NONE;
    const ALL_TAGS = '__all__';
    const NO_TAGS = '__none__';
    const [selectedTag, setSelectedTag] = useState(ALL_TAGS);

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

    const taskSensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 6 },
        }),
    );

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

    const handleCreateProject = async (e: React.FormEvent) => {
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

    const normalizedSearchQuery = searchQuery.trim().toLowerCase();

    const {
        handleAddSection,
        handleRenameSection,
        handleDeleteSection,
        handleToggleSection,
        handleToggleSectionNotes,
        handleOpenSectionTaskPrompt,
    } = useProjectSectionActions({
        t,
        selectedProject,
        setEditingSectionId,
        setSectionDraft,
        setShowSectionPrompt,
        deleteSection,
        updateSection,
        setSectionNotesOpen,
        setSectionTaskTargetId,
        setSectionTaskDraft,
        setShowSectionTaskPrompt,
        requestConfirmation,
    });

    useEffect(() => {
        if (!selectedProjectId || !selectedProject) return;
        if (!projectMatchesAreaFilter(selectedProject, selectedArea, areaById)) {
            setSelectedProjectId(null);
        }
    }, [areaById, selectedArea, selectedProject, selectedProjectId, setSelectedProjectId]);

    useEffect(() => {
        setEditProjectTitle(selectedProject?.title ?? '');
    }, [selectedProject?.id, selectedProject?.title]);
    const projectAllTasks = useMemo(() => {
        if (!selectedProjectId) return [];
        return allTasks.filter((task) => {
            if (task.deletedAt || task.projectId !== selectedProjectId) return false;
            if (normalizedSearchQuery && !task.title.toLowerCase().includes(normalizedSearchQuery)) return false;
            return true;
        });
    }, [allTasks, normalizedSearchQuery, selectedProjectId]);
    const projectTasks = useMemo(() => (
        projectAllTasks.filter((task) => task.status !== 'done' && task.status !== 'reference' && task.status !== 'archived')
    ), [projectAllTasks]);

    const sortProjectTasks = useCallback((items: Task[]) => {
        const sorted = [...items];
        const hasOrder = sorted.some((task) => Number.isFinite(task.order) || Number.isFinite(task.orderNum));
        sorted.sort((a, b) => {
            if (hasOrder) {
                const aOrder = Number.isFinite(a.order)
                    ? (a.order as number)
                    : Number.isFinite(a.orderNum)
                        ? (a.orderNum as number)
                        : Number.POSITIVE_INFINITY;
                const bOrder = Number.isFinite(b.order)
                    ? (b.order as number)
                    : Number.isFinite(b.orderNum)
                        ? (b.orderNum as number)
                        : Number.POSITIVE_INFINITY;
                if (aOrder !== bOrder) return aOrder - bOrder;
            }
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });
        return sorted;
    }, []);

    const orderedProjectTasks = useMemo(() => {
        if (!selectedProject) return projectTasks;
        return sortProjectTasks(projectTasks);
    }, [projectTasks, selectedProject, sortProjectTasks]);

    const projectSections = useMemo(() => {
        if (!selectedProjectId) return [];
        return sections
            .filter((section) => section.projectId === selectedProjectId && !section.deletedAt)
            .sort((a, b) => {
                const aOrder = Number.isFinite(a.order) ? a.order : 0;
                const bOrder = Number.isFinite(b.order) ? b.order : 0;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.title.localeCompare(b.title);
            });
    }, [sections, selectedProjectId]);

    const sectionTaskGroups = useMemo(() => {
        if (!selectedProjectId || projectSections.length === 0) {
            return { sections: [] as Array<{ section: Section; tasks: Task[] }>, unsectioned: orderedProjectTasks };
        }
        const sectionIds = new Set(projectSections.map((section) => section.id));
        const tasksBySection = new Map<string, Task[]>();
        const unsectioned: Task[] = [];
        projectTasks.forEach((task) => {
            const sectionId = task.sectionId && sectionIds.has(task.sectionId) ? task.sectionId : null;
            if (sectionId) {
                const list = tasksBySection.get(sectionId) ?? [];
                list.push(task);
                tasksBySection.set(sectionId, list);
            } else {
                unsectioned.push(task);
            }
        });
        const sectionsWithTasks = projectSections.map((section) => ({
            section,
            tasks: sortProjectTasks(tasksBySection.get(section.id) ?? []),
        }));
        return { sections: sectionsWithTasks, unsectioned: sortProjectTasks(unsectioned) };
    }, [orderedProjectTasks, projectSections, projectTasks, selectedProjectId, sortProjectTasks]);

    const orderedProjectTaskList = useMemo(() => {
        if (projectSections.length === 0) return orderedProjectTasks;
        const combined: Task[] = [];
        sectionTaskGroups.sections.forEach((group) => {
            combined.push(...group.tasks);
        });
        if (sectionTaskGroups.unsectioned.length > 0) {
            combined.push(...sectionTaskGroups.unsectioned);
        }
        return combined;
    }, [orderedProjectTasks, projectSections.length, sectionTaskGroups.sections, sectionTaskGroups.unsectioned]);

    const projectReferenceTasks = useMemo(() => {
        if (!selectedProject) return [] as Task[];

        const projectTagSet = new Set((selectedProject.tagIds || []).map((tag) => String(tag).toLowerCase()));
        const isProjectTagMatch = (task: Task) => {
            if (projectTagSet.size === 0) return false;
            const taskTags = task.tags || [];
            return taskTags.some((tag) => projectTagSet.has(String(tag).toLowerCase()));
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

    useEffect(() => {
        if (!highlightTaskId) return;
        const exists = [...orderedProjectTaskList, ...projectReferenceTasks].some((task) => task.id === highlightTaskId);
        if (!exists) return;
        const el = document.querySelector(`[data-task-id="${highlightTaskId}"]`) as HTMLElement | null;
        if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        const timer = window.setTimeout(() => setHighlightTask(null), 4000);
        return () => window.clearTimeout(timer);
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

    const handleTaskDragEnd = useCallback((event: DragEndEvent) => {
        if (!selectedProject) return;
        const failTaskMove = (error: unknown) => {
            reportError('Failed to reorder project tasks', error);
            showToast('Failed to move task', 'error');
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
                reorderProjectTasks(selectedProject.id, reordered, getSectionIdFromContainer(sourceContainer))
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
            if (nextSourceItems.length > 0) {
                await Promise.resolve(
                    reorderProjectTasks(selectedProject.id, nextSourceItems, getSectionIdFromContainer(sourceContainer))
                );
            }
            await Promise.resolve(
                reorderProjectTasks(selectedProject.id, nextDestinationItems, getSectionIdFromContainer(destinationContainer))
            );
        })().catch(failTaskMove);
    }, [reorderProjectTasks, selectedProject, showToast, taskIdToContainer, taskIdsByContainer, updateTask]);

    const renderSortableTasks = (list: Task[]) => (
        <SortableContext items={list.map((task) => task.id)} strategy={verticalListSortingStrategy}>
            <div className="divide-y divide-border/30">
                {list.map((task) => (
                    <SortableProjectTaskRow key={task.id} task={task} project={selectedProject!} />
                ))}
            </div>
        </SortableContext>
    );
    const renderProjectSections = (renderTasks: (list: Task[]) => ReactNode) => {
        if (projectSections.length === 0) {
            return (
                <SectionDropZone
                    id={NO_SECTION_CONTAINER}
                    className="min-h-[120px] rounded-lg border border-dashed border-border/70 p-4"
                >
                    {orderedProjectTasks.length > 0 ? (
                        renderTasks(orderedProjectTasks)
                    ) : (
                        <div className="text-center text-muted-foreground py-12">
                            {t('projects.noActiveTasks')}
                        </div>
                    )}
                </SectionDropZone>
            );
        }
        return (
            <div className="space-y-3">
                {sectionTaskGroups.sections.map((group) => {
                    const isCollapsed = group.section.isCollapsed;
                    const taskCount = group.tasks.length;
                    const hasNotes = Boolean(group.section.description?.trim());
                    const notesOpen = sectionNotesOpen[group.section.id] ?? false;
                    return (
                        <SectionDropZone
                            key={group.section.id}
                            id={getSectionContainerId(group.section.id)}
                            className="rounded-lg border border-border/60"
                        >
                            <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
                                <button
                                    type="button"
                                    onClick={() => handleToggleSection(group.section)}
                                    className="flex items-center gap-2 text-sm font-semibold"
                                >
                                    {isCollapsed ? (
                                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                    ) : (
                                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                    )}
                                    <span>{group.section.title}</span>
                                    <span className="text-xs text-muted-foreground">{taskCount}</span>
                                </button>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => handleOpenSectionTaskPrompt(group.section.id)}
                                        className="h-7 w-7 rounded-md hover:bg-muted/40 text-muted-foreground hover:text-foreground flex items-center justify-center"
                                        aria-label={t('projects.addTask')}
                                    >
                                        <Plus className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleToggleSectionNotes(group.section.id)}
                                        className={cn(
                                            'h-7 w-7 rounded-md hover:bg-muted/40 text-muted-foreground hover:text-foreground flex items-center justify-center',
                                            (hasNotes || notesOpen) && 'text-primary'
                                        )}
                                        aria-label={t('projects.sectionNotes')}
                                    >
                                        <FileText className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleRenameSection(group.section)}
                                        className="h-7 w-7 rounded-md hover:bg-muted/40 text-muted-foreground hover:text-foreground flex items-center justify-center"
                                        aria-label={t('common.edit')}
                                    >
                                        <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleDeleteSection(group.section)}
                                        className="h-7 w-7 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive flex items-center justify-center"
                                        aria-label={t('common.delete')}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>
                            {notesOpen && (
                                <div className="px-3 py-2 border-b border-border/50">
                                    <textarea
                                        className="w-full min-h-[90px] p-2 text-xs bg-background border border-border rounded resize-y focus:outline-none focus:bg-accent/5"
                                        placeholder={t('projects.sectionNotesPlaceholder')}
                                        defaultValue={group.section.description || ''}
                                        onBlur={(event) => {
                                            const nextValue = event.target.value.trimEnd();
                                            updateSection(group.section.id, { description: nextValue || undefined });
                                        }}
                                    />
                                </div>
                            )}
                            {!isCollapsed && (
                                <div className="p-3">
                                    {taskCount > 0 ? (
                                        renderTasks(group.tasks)
                                    ) : (
                                        <div className="text-xs text-muted-foreground py-2">
                                            {t('projects.noActiveTasks')}
                                        </div>
                                    )}
                                </div>
                            )}
                        </SectionDropZone>
                    );
                })}
                <SectionDropZone
                    id={NO_SECTION_CONTAINER}
                    className="rounded-lg border border-dashed border-border/70"
                >
                    <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <span>{t('projects.noSection')}</span>
                            <span className="text-xs text-muted-foreground">
                                {sectionTaskGroups.unsectioned.length}
                            </span>
                        </div>
                    </div>
                    <div className="p-3">
                        {sectionTaskGroups.unsectioned.length > 0 ? (
                            renderTasks(sectionTaskGroups.unsectioned)
                        ) : (
                            <div className="text-xs text-muted-foreground py-2">
                                {t('projects.noActiveTasks')}
                            </div>
                        )}
                    </div>
                </SectionDropZone>
                {sectionTaskGroups.sections.length === 0 && sectionTaskGroups.unsectioned.length === 0 && (
                    <div className="text-center text-muted-foreground py-12">
                        {t('projects.noActiveTasks')}
                    </div>
                )}
            </div>
        );
    };
    const tasksContent = (
        <DndContext
            sensors={taskSensors}
            collisionDetection={projectTaskCollisionDetection}
            measuring={projectTaskDndMeasuring}
            onDragEnd={handleTaskDragEnd}
        >
            {renderProjectSections(renderSortableTasks)}
        </DndContext>
    );

    const visibleAttachments = (selectedProject?.attachments || []).filter((a) => !a.deletedAt);
    const projectProgress = useMemo(() => {
        if (!selectedProjectId) return null;
        const doneCount = projectAllTasks.filter((task) => task.status === 'done').length;
        const remainingCount = projectTasks.length;
        const total = doneCount + remainingCount;
        return { doneCount, remainingCount, total };
    }, [projectAllTasks, projectTasks, selectedProjectId]);

    const handleCommitProjectTitle = () => {
        if (!selectedProject) return;
        const nextTitle = editProjectTitle.trim();
        if (!nextTitle) {
            setEditProjectTitle(selectedProject.title);
            return;
        }
        if (nextTitle !== selectedProject.title) {
            updateProject(selectedProject.id, { title: nextTitle });
        }
    };

    const handleResetProjectTitle = () => {
        if (!selectedProject) return;
        setEditProjectTitle(selectedProject.title);
    };

    const handleArchiveProject = async () => {
        if (!selectedProject) return;
        try {
            const confirmed = await requestConfirmation({
                title: t('projects.archive') || 'Archive',
                description: t('projects.archiveConfirm'),
                confirmLabel: t('projects.archive') || 'Archive',
                cancelLabel: t('common.cancel') || 'Cancel',
            });
            if (confirmed) {
                await Promise.resolve(updateProject(selectedProject.id, { status: 'archived' }));
            }
        } catch (error) {
            reportError('Failed to archive project', error);
            showToast(t('projects.archiveFailed') || 'Failed to archive project', 'error');
        }
    };

    const handleDeleteProject = async () => {
        if (!selectedProject) return;
        try {
            const confirmed = await requestConfirmation({
                title: t('common.delete') || 'Delete',
                description: t('projects.deleteConfirm'),
                confirmLabel: t('common.delete') || 'Delete',
                cancelLabel: t('common.cancel') || 'Cancel',
            });
            if (confirmed) {
                setIsProjectDeleting(true);
                try {
                    await Promise.resolve(deleteProject(selectedProject.id));
                    setSelectedProjectId(null);
                } finally {
                    setIsProjectDeleting(false);
                }
            }
        } catch (error) {
            reportError('Failed to delete project', error);
            showToast(t('projects.deleteFailed') || 'Failed to delete project', 'error');
            setIsProjectDeleting(false);
        }
    };
    const resolveValidationMessage = (error?: string) => {
        if (error === 'file_too_large') return t('attachments.fileTooLarge');
        if (error === 'mime_type_blocked' || error === 'mime_type_not_allowed') return t('attachments.invalidFileType');
        return t('attachments.fileNotSupported');
    };

    const {
        attachmentError,
        showLinkPrompt,
        setShowLinkPrompt,
        isProjectAttachmentBusy,
        openAttachment,
        addProjectFileAttachment,
        addProjectLinkAttachment,
        removeProjectAttachment,
    } = useProjectAttachmentActions({
        t,
        selectedProject,
        updateProject,
        resolveValidationMessage,
    });

    useEffect(() => {
        if (!selectedProject) {
            setTagDraft('');
            return;
        }
        setTagDraft((selectedProject.tagIds || []).join(', '));
    }, [selectedProject?.id, selectedProject?.tagIds]);

    useEffect(() => {
        setProjectTaskTitle('');
    }, [selectedProject?.id]);

    useEffect(() => {
        setProjectDetailsExpanded(false);
    }, [selectedProject?.id]);

    const selectedProjectAreaLabel = useMemo(() => {
        if (!selectedProject?.areaId) return undefined;
        return areaById.get(selectedProject.areaId)?.name;
    }, [areaById, selectedProject?.areaId]);

    useEffect(() => {
        setSectionNotesOpen({});
        setShowSectionTaskPrompt(false);
        setSectionTaskTargetId(null);
    }, [selectedProjectId]);

    const handleAddTaskForProject = useCallback(
        async (value: string, sectionId?: string | null) => {
            if (!selectedProject) return;
            const { title: parsedTitle, props, projectTitle, invalidDateCommands } = parseQuickAdd(value, projects, new Date(), areas);
            if (invalidDateCommands && invalidDateCommands.length > 0) {
                showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
                return;
            }
            const finalTitle = (parsedTitle || value).trim();
            if (!finalTitle) return;
            const initialProps: Partial<Task> = { projectId: selectedProject.id, status: 'next', ...props };
            if (!props.status) initialProps.status = 'next';
            if (!props.projectId) initialProps.projectId = selectedProject.id;
            if (!initialProps.projectId && projectTitle) {
                const created = await addProject(projectTitle, DEFAULT_AREA_COLOR);
                if (!created) return;
                initialProps.projectId = created.id;
            }
            if (sectionId && initialProps.projectId === selectedProject.id) {
                initialProps.sectionId = sectionId;
            } else {
                initialProps.sectionId = undefined;
            }
            try {
                await addTask(finalTitle, initialProps);
            } catch (error) {
                reportError('Failed to add task to project', error);
                showToast(t('projects.addTaskFailed') || 'Failed to add task', 'error');
            }
        },
        [addProject, addTask, areas, projects, selectedProject, showToast, t]
    );

    return (
        <ErrorBoundary>
            <div className="h-full px-4 py-3">
                <div className="mx-auto flex h-full w-full max-w-[84rem] min-w-0 gap-5 xl:gap-6 2xl:max-w-[88rem]">
                    <div className="min-w-[14.75rem] w-[clamp(15rem,19vw,19.5rem)] flex-none min-h-0">
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

                    {/* Project Details & Tasks */}
                    <div className="flex-1 min-w-0 h-full flex">
                        <div className="flex flex-col h-full min-h-0 w-full max-w-none">
                            <div className="mb-4">
                                <input
                                    type="text"
                                    data-view-filter-input
                                    placeholder={t('common.search')}
                                    value={searchQuery}
                                    onChange={(event) => setSearchQuery(event.target.value)}
                                    className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                                />
                            </div>
                            {selectedProject ? (
                                <div className="flex-1 min-h-0 overflow-y-auto pr-2">
                                    {(isCreatingProject || isProjectDeleting || isAreaCreating) && (
                                        <div className="mb-4 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                                            {t('common.loading') || 'Loading...'}
                                        </div>
                                    )}
                                    <ProjectDetailsHeader
                                        project={selectedProject}
                                        projectColor={getProjectColorForTask(selectedProject)}
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
                                        onDuplicate={() => handleDuplicateProject(selectedProject.id)}
                                        onArchive={handleArchiveProject}
                                        onReactivate={() => {
                                            Promise.resolve(updateProject(selectedProject.id, { status: 'active' })).catch((error) => {
                                                reportError('Failed to reactivate project', error);
                                                showToast(t('projects.reactivateFailed') || 'Failed to reactivate project', 'error');
                                            });
                                        }}
                                        onDelete={handleDeleteProject}
                                        isDeleting={isProjectDeleting}
                                        projectProgress={projectProgress}
                                        t={t}
                                    />

                                    {projectDetailsExpanded && (
                                        <>
                                            <ProjectDetailsFields
                                                project={selectedProject}
                                                selectedAreaId={
                                                    selectedProject.areaId && areaById.has(selectedProject.areaId)
                                                        ? selectedProject.areaId
                                                        : NO_AREA
                                                }
                                                sortedAreas={sortedAreas}
                                                noAreaId={NO_AREA}
                                                t={t}
                                                tagDraft={tagDraft}
                                                onTagDraftChange={setTagDraft}
                                                onCommitTags={() => {
                                                    const tags = parseTagInput(tagDraft);
                                                    updateProject(selectedProject.id, { tagIds: tags });
                                                }}
                                                onNewArea={() => {
                                                    setPendingAreaAssignProjectId(selectedProject.id);
                                                    setShowQuickAreaPrompt(true);
                                                }}
                                                onManageAreas={() => setShowAreaManager(true)}
                                                onAreaChange={(value) => {
                                                    updateProject(selectedProject.id, { areaId: value === NO_AREA ? undefined : value });
                                                }}
                                                isSequential={selectedProject.isSequential === true}
                                                onToggleSequential={() => updateProject(selectedProject.id, { isSequential: !selectedProject.isSequential })}
                                                status={selectedProject.status}
                                                onChangeStatus={(status) => updateProject(selectedProject.id, { status })}
                                                dueDateValue={toDateInputValue(selectedProject.dueDate)}
                                                onDueDateChange={(value) => updateProject(selectedProject.id, { dueDate: value || undefined })}
                                                reviewAtValue={toDateTimeLocalValue(selectedProject.reviewAt)}
                                                onReviewAtChange={(value) => updateProject(selectedProject.id, { reviewAt: value || undefined })}
                                            />

                                            <ProjectNotesSection
                                                project={selectedProject}
                                                showNotesPreview={showNotesPreview}
                                                onTogglePreview={() => setShowNotesPreview((value) => !value)}
                                                onAddFile={addProjectFileAttachment}
                                                onAddLink={addProjectLinkAttachment}
                                                attachmentsBusy={isProjectAttachmentBusy}
                                                visibleAttachments={visibleAttachments}
                                                attachmentError={attachmentError}
                                                onOpenAttachment={openAttachment}
                                                onRemoveAttachment={removeProjectAttachment}
                                                onUpdateNotes={(value) => updateProject(selectedProject.id, { supportNotes: value })}
                                                t={t}
                                                language={language}
                                            />
                                        </>
                                    )}

                                    <section className="py-5 border-t border-border/50">
                                        <form
                                            onSubmit={async (e) => {
                                                e.preventDefault();
                                                if (!projectTaskTitle.trim()) return;
                                                await handleAddTaskForProject(projectTaskTitle);
                                                setProjectTaskTitle('');
                                            }}
                                            className="mb-4 flex gap-2"
                                        >
                                            <TaskInput
                                                value={projectTaskTitle}
                                                projects={projects}
                                                contexts={allTokens}
                                                areas={areas}
                                                onCreateProject={async (title) => {
                                                    const created = await addProject(title, DEFAULT_AREA_COLOR);
                                                    return created?.id ?? null;
                                                }}
                                                onChange={(next) => setProjectTaskTitle(next)}
                                                placeholder={t('projects.addTaskPlaceholder')}
                                                containerClassName="flex-1"
                                                className="h-9 w-full bg-background border border-border rounded-md px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                            />
                                            <button
                                                type="submit"
                                                className="h-9 bg-primary text-primary-foreground px-4 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors whitespace-nowrap"
                                            >
                                                {t('projects.addTask')}
                                            </button>
                                        </form>
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="text-xs uppercase tracking-wider text-muted-foreground">
                                                {t('projects.sectionsLabel')}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={handleAddSection}
                                                aria-label={t('projects.addSection')}
                                                className="inline-flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-md border border-border bg-background hover:bg-muted/40 transition-colors"
                                            >
                                                <Plus className="h-3.5 w-3.5" />
                                                {t('projects.addSection')}
                                            </button>
                                        </div>
                                        {tasksContent}
                                    </section>

                                    {projectReferenceTasks.length > 0 && (
                                        <section className="py-5 border-t border-border/50">
                                            <div className="flex items-center justify-between mb-3">
                                                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                                                    {t('status.reference')} ({projectReferenceTasks.length})
                                                </div>
                                            </div>
                                            <div className="divide-y divide-border/30 border-t border-border/40">
                                                {projectReferenceTasks.map((task) => (
                                                    <TaskItem
                                                        key={`project-reference-${task.id}`}
                                                        task={task}
                                                        project={selectedProject}
                                                        enableDoubleClickEdit
                                                        showProjectBadgeInActions={false}
                                                    />
                                                ))}
                                            </div>
                                        </section>
                                    )}
                                </div>
                            ) : (
                                <div className="flex-1 flex items-center justify-center text-muted-foreground p-6">
                                    <div className="text-center border border-dashed border-border/70 px-10 py-12">
                                        <Folder className="w-12 h-12 mx-auto mb-4 opacity-25" />
                                        <p>{t('projects.selectProject')}</p>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
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
                        if (!selectedProject) return;
                        const trimmed = value.trim();
                        if (!trimmed) return;
                        if (editingSectionId) {
                            updateSection(editingSectionId, { title: trimmed });
                        } else {
                            addSection(selectedProject.id, trimmed);
                        }
                        setShowSectionPrompt(false);
                        setEditingSectionId(null);
                        setSectionDraft('');
                    }}
                />

                <PromptModal
                    isOpen={showSectionTaskPrompt}
                    title={t('projects.addTask')}
                    description={t('projects.addTaskPlaceholder')}
                    placeholder={t('projects.addTaskPlaceholder')}
                    defaultValue={sectionTaskDraft}
                    confirmLabel={t('projects.addTask')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => {
                        setShowSectionTaskPrompt(false);
                        setSectionTaskTargetId(null);
                        setSectionTaskDraft('');
                    }}
                    onConfirm={async (value) => {
                        if (!sectionTaskTargetId) return;
                        await handleAddTaskForProject(value, sectionTaskTargetId);
                        setShowSectionTaskPrompt(false);
                        setSectionTaskTargetId(null);
                        setSectionTaskDraft('');
                    }}
                />

                <PromptModal
                    isOpen={showLinkPrompt}
                    title={t('attachments.addLink')}
                    description={t('attachments.linkInputHint')}
                    placeholder={t('attachments.linkPlaceholder')}
                    defaultValue=""
                    confirmLabel={t('common.save')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => setShowLinkPrompt(false)}
                    onConfirm={(value) => {
                        if (!selectedProject) return;
                        const normalized = normalizeAttachmentInput(value);
                        if (!normalized.uri) return;
                        const now = new Date().toISOString();
                        const attachment: Attachment = {
                            id: generateUUID(),
                            kind: normalized.kind,
                            title: normalized.title,
                            uri: normalized.uri,
                            createdAt: now,
                            updatedAt: now,
                        };
                        updateProject(selectedProject.id, { attachments: [...(selectedProject.attachments || []), attachment] });
                        setShowLinkPrompt(false);
                    }}
                />

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
