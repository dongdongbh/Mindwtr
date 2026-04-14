import { useState, useMemo, useEffect, useCallback, type ReactNode } from 'react';
import {
    Attachment,
    Task,
    type Area,
    type Project,
    type Section,
    type StoreActionResult,
    generateUUID,
    parseQuickAdd,
} from '@mindwtr/core';
import { DndContext, PointerSensor, MeasuringStrategy, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { ChevronDown, ChevronRight, FileText, Folder, Pencil, Plus, Trash2 } from 'lucide-react';

import { PromptModal } from '../../PromptModal';
import { TaskItem } from '../../TaskItem';
import { TaskInput } from '../../Task/TaskInput';
import { normalizeAttachmentInput } from '../../../lib/attachment-utils';
import { cn } from '../../../lib/utils';
import { reportError } from '../../../lib/report-error';
import { useProjectAttachmentActions } from './useProjectAttachmentActions';
import { useProjectSectionActions } from './useProjectSectionActions';
import { ProjectDetailsHeader } from './ProjectDetailsHeader';
import { ProjectDetailsFields } from './ProjectDetailsFields';
import { ProjectNotesSection } from './ProjectNotesSection';
import { SortableProjectTaskRow } from './SortableRows';
import { SectionDropZone, getSectionContainerId, getSectionIdFromContainer, NO_SECTION_CONTAINER } from './section-dnd';
import { projectTaskCollisionDetection } from './project-task-dnd';
import {
    DEFAULT_AREA_COLOR,
    getProjectColor,
    parseTagInput,
    toDateInputValue,
    toDateTimeLocalValue,
} from './projects-utils';
import type { ConfirmationRequestOptions } from '../../../hooks/useConfirmDialog';

const projectTaskDndMeasuring = {
    droppable: {
        strategy: MeasuringStrategy.WhileDragging,
        frequency: 16,
    },
} as const;

type ShowToast = (message: string, tone?: 'success' | 'error' | 'info') => void;

type ProjectWorkspaceProps = {
    addProject: (
        title: string,
        color: string,
        options?: { areaId?: string }
    ) => Promise<Project | null | undefined> | Project | null | undefined;
    addSection: (projectId: string, title: string) => Promise<unknown> | unknown;
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<unknown> | unknown;
    allTasks: Task[];
    allTokens: string[];
    areaById: Map<string, Area>;
    areas: Area[];
    deleteProject: (projectId: string) => Promise<StoreActionResult | void> | StoreActionResult | void;
    deleteSection: (sectionId: string) => Promise<StoreActionResult | void> | StoreActionResult | void;
    highlightTaskId: string | null;
    isAreaCreating: boolean;
    isCreatingProject: boolean;
    language: string;
    noAreaId: string;
    onDuplicateProject: (projectId: string) => Promise<void> | void;
    onManageAreas: () => void;
    onRequestQuickArea: (projectId: string) => void;
    projects: Project[];
    reorderProjectTasks: (
        projectId: string,
        taskIds: string[],
        sectionId?: string | null,
    ) => Promise<unknown> | unknown;
    requestConfirmation: (options: ConfirmationRequestOptions) => Promise<boolean>;
    sections: Section[];
    selectedProject: Project | undefined;
    selectedProjectId: string | null;
    setHighlightTask: (taskId: string | null) => void;
    setSelectedProjectId: (taskId: string | null) => void;
    showToast: ShowToast;
    sortedAreas: Area[];
    t: (key: string) => string;
    updateProject: (
        projectId: string,
        updates: Partial<Project>,
    ) => Promise<StoreActionResult | void> | StoreActionResult | void;
    updateSection: (
        sectionId: string,
        updates: Partial<Section>,
    ) => Promise<StoreActionResult | void> | StoreActionResult | void;
    updateTask: (
        taskId: string,
        updates: Partial<Task>,
    ) => Promise<StoreActionResult | void> | StoreActionResult | void;
};

export function ProjectWorkspace({
    addProject,
    addSection,
    addTask,
    allTasks,
    allTokens,
    areaById,
    areas,
    deleteProject,
    deleteSection,
    highlightTaskId,
    isAreaCreating,
    isCreatingProject,
    language,
    noAreaId,
    onDuplicateProject,
    onManageAreas,
    onRequestQuickArea,
    projects,
    reorderProjectTasks,
    requestConfirmation,
    sections,
    selectedProject,
    selectedProjectId,
    setHighlightTask,
    setSelectedProjectId,
    showToast,
    sortedAreas,
    t,
    updateProject,
    updateSection,
    updateTask,
}: ProjectWorkspaceProps) {
    const [showNotesPreview, setShowNotesPreview] = useState(true);
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
    const [isProjectDeleting, setIsProjectDeleting] = useState(false);

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

    const taskSensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 6 },
        }),
    );

    const normalizedSearchQuery = searchQuery.trim().toLowerCase();

    useEffect(() => {
        setEditProjectTitle(selectedProject?.title ?? '');
    }, [selectedProject?.id, selectedProject?.title]);

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

    useEffect(() => {
        setSectionNotesOpen({});
        setShowSectionTaskPrompt(false);
        setSectionTaskTargetId(null);
    }, [selectedProjectId]);

    const projectAllTasks = useMemo(() => {
        if (!selectedProjectId) return [];
        return allTasks.filter((task) => {
            if (task.deletedAt || task.projectId !== selectedProjectId) return false;
            if (normalizedSearchQuery && !task.title.toLowerCase().includes(normalizedSearchQuery)) return false;
            return true;
        });
    }, [allTasks, normalizedSearchQuery, selectedProjectId]);

    const projectTasks = useMemo(
        () => projectAllTasks.filter((task) => task.status !== 'done' && task.status !== 'reference' && task.status !== 'archived'),
        [projectAllTasks],
    );

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

        return {
            sections: projectSections.map((section) => ({
                section,
                tasks: sortProjectTasks(tasksBySection.get(section.id) ?? []),
            })),
            unsectioned: sortProjectTasks(unsectioned),
        };
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
                reorderProjectTasks(selectedProject.id, reordered, getSectionIdFromContainer(sourceContainer)),
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
                    reorderProjectTasks(selectedProject.id, nextSourceItems, getSectionIdFromContainer(sourceContainer)),
                );
            }
            await Promise.resolve(
                reorderProjectTasks(selectedProject.id, nextDestinationItems, getSectionIdFromContainer(destinationContainer)),
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
                        <div className="py-12 text-center text-muted-foreground">
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
                            <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
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
                                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                                        aria-label={t('projects.addTask')}
                                    >
                                        <Plus className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleToggleSectionNotes(group.section.id)}
                                        className={cn(
                                            'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                                            (hasNotes || notesOpen) && 'text-primary',
                                        )}
                                        aria-label={t('projects.sectionNotes')}
                                    >
                                        <FileText className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleRenameSection(group.section)}
                                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                                        aria-label={t('common.edit')}
                                    >
                                        <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleDeleteSection(group.section)}
                                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                        aria-label={t('common.delete')}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>
                            {notesOpen && (
                                <div className="border-b border-border/50 px-3 py-2">
                                    <textarea
                                        className="min-h-[90px] w-full resize-y rounded border border-border bg-background p-2 text-xs focus:bg-accent/5 focus:outline-none"
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
                                        <div className="py-2 text-xs text-muted-foreground">
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
                    <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
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
                            <div className="py-2 text-xs text-muted-foreground">
                                {t('projects.noActiveTasks')}
                            </div>
                        )}
                    </div>
                </SectionDropZone>
                {sectionTaskGroups.sections.length === 0 && sectionTaskGroups.unsectioned.length === 0 && (
                    <div className="py-12 text-center text-muted-foreground">
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

    const visibleAttachments = (selectedProject?.attachments || []).filter((attachment) => !attachment.deletedAt);
    const projectProgress = useMemo(() => {
        if (!selectedProjectId) return null;
        const doneCount = projectAllTasks.filter((task) => task.status === 'done').length;
        const remainingCount = projectTasks.length;
        return {
            doneCount,
            remainingCount,
            total: doneCount + remainingCount,
        };
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

    const selectedProjectAreaLabel = useMemo(() => {
        if (!selectedProject?.areaId) return undefined;
        return areaById.get(selectedProject.areaId)?.name;
    }, [areaById, selectedProject?.areaId]);

    const handleAddTaskForProject = useCallback(
        async (value: string, sectionId?: string | null) => {
            if (!selectedProject) return;
            const {
                title: parsedTitle,
                props,
                projectTitle,
                invalidDateCommands,
            } = parseQuickAdd(value, projects, new Date(), areas);
            if (invalidDateCommands && invalidDateCommands.length > 0) {
                showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
                return;
            }

            const finalTitle = (parsedTitle || value).trim();
            if (!finalTitle) return;

            const initialProps: Partial<Task> = {
                projectId: selectedProject.id,
                status: 'next',
                ...props,
            };
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
        [addProject, addTask, areas, projects, selectedProject, showToast, t],
    );

    return (
        <>
            <div className="flex-1 min-w-0 h-full flex">
                <div className="flex h-full min-h-0 w-full max-w-none flex-col">
                    <div className="mb-4">
                        <input
                            type="text"
                            data-view-filter-input
                            placeholder={t('common.search')}
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
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
                                                : noAreaId
                                        }
                                        sortedAreas={sortedAreas}
                                        noAreaId={noAreaId}
                                        t={t}
                                        tagDraft={tagDraft}
                                        onTagDraftChange={setTagDraft}
                                        onCommitTags={() => {
                                            updateProject(selectedProject.id, { tagIds: parseTagInput(tagDraft) });
                                        }}
                                        onNewArea={() => onRequestQuickArea(selectedProject.id)}
                                        onManageAreas={onManageAreas}
                                        onAreaChange={(value) => {
                                            updateProject(selectedProject.id, { areaId: value === noAreaId ? undefined : value });
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

                            <section className="border-t border-border/50 py-5">
                                <form
                                    onSubmit={async (event) => {
                                        event.preventDefault();
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
                                        className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                                    />
                                    <button
                                        type="submit"
                                        className="h-9 whitespace-nowrap rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                                    >
                                        {t('projects.addTask')}
                                    </button>
                                </form>
                                <div className="mb-3 flex items-center justify-between">
                                    <div className="text-xs uppercase tracking-wider text-muted-foreground">
                                        {t('projects.sectionsLabel')}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={handleAddSection}
                                        aria-label={t('projects.addSection')}
                                        className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/40"
                                    >
                                        <Plus className="h-3.5 w-3.5" />
                                        {t('projects.addSection')}
                                    </button>
                                </div>
                                {tasksContent}
                            </section>

                            {projectReferenceTasks.length > 0 && (
                                <section className="border-t border-border/50 py-5">
                                    <div className="mb-3 flex items-center justify-between">
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
                    updateProject(selectedProject.id, {
                        attachments: [...(selectedProject.attachments || []), attachment],
                    });
                    setShowLinkPrompt(false);
                }}
            />
        </>
    );
}
