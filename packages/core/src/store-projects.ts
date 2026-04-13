import type { AppData, Area, Project, Section, Task, TaskStatus } from './types';
import type { StoreActionResult, TaskStore } from './store-types';
import {
    buildSaveSnapshot,
    ensureDeviceId,
    getTaskOrder,
    normalizeRevision,
    normalizeTagId,
    selectVisibleTasks,
    toVisibleTask,
} from './store-helpers';
import { logWarn } from './logger';
import { generateUUID as uuidv4 } from './uuid';
import { clearDerivedCache } from './store-settings';

type ProjectActions = Pick<
    TaskStore,
    | 'addProject'
    | 'updateProject'
    | 'deleteProject'
    | 'restoreProject'
    | 'duplicateProject'
    | 'toggleProjectFocus'
    | 'addSection'
    | 'updateSection'
    | 'deleteSection'
    | 'addArea'
    | 'updateArea'
    | 'deleteArea'
    | 'restoreArea'
    | 'reorderAreas'
    | 'reorderProjects'
    | 'reorderProjectTasks'
    | 'deleteTag'
    | 'renameTag'
    | 'deleteContext'
    | 'renameContext'
>;

type ProjectActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
};

const actionOk = (extra?: Omit<StoreActionResult, 'success'>): StoreActionResult => ({ success: true, ...extra });
const actionFail = (error: string): StoreActionResult => ({ success: false, error });

const dedupeTagValuesLastWins = (values: string[], preferredValue?: string): string[] => {
    const preferredNormalized = preferredValue ? normalizeTagId(preferredValue) : '';
    const seen = new Set<string>();
    const dedupedReversed: string[] = [];
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        const normalized = normalizeTagId(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        dedupedReversed.push(normalized === preferredNormalized ? preferredValue! : value);
    }
    return dedupedReversed.reverse();
};

export const createProjectActions = ({ set, get, debouncedSave }: ProjectActionContext): ProjectActions => ({
    /**
     * Add a new project.
     * @param title Project title
     * @param color Project color hex code
     */
    addProject: async (title: string, color: string, initialProps?: Partial<Project>) => {
        const changeAt = Date.now();
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!trimmedTitle) {
            set({ error: 'Project title is required' });
            return null;
        }
        const normalizedTitle = trimmedTitle.toLowerCase();
        let snapshot: AppData | null = null;
        let createdProject: Project | null = null;
        let existingProject: Project | null = null;
        set((state) => {
            const duplicate = state._allProjects.find(
                (project) =>
                    !project.deletedAt &&
                    typeof project.title === 'string' &&
                    project.title.trim().toLowerCase() === normalizedTitle
            );
            if (duplicate) {
                existingProject = duplicate;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const targetAreaId = initialProps?.areaId;
            const maxOrder = state._allProjects
                .filter((project) => (project.areaId ?? undefined) === (targetAreaId ?? undefined))
                .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1);
            const baseOrder = Number.isFinite(initialProps?.order) ? (initialProps?.order as number) : maxOrder + 1;
            const now = new Date().toISOString();
            const newProject: Project = {
                id: uuidv4(),
                title: trimmedTitle,
                color,
                order: baseOrder,
                status: 'active',
                rev: 1,
                revBy: deviceState.deviceId,
                createdAt: now,
                updatedAt: now,
                ...initialProps,
                tagIds: initialProps?.tagIds ?? [],
            };
            createdProject = newProject;
            const newAllProjects = [...state._allProjects, newProject];
            const newVisibleProjects = [...state.projects, newProject];
            snapshot = buildSaveSnapshot(state, {
                projects: newAllProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                projects: newVisibleProjects,
                _allProjects: newAllProjects,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (existingProject) {
            return existingProject;
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return createdProject;
    },

    /**
     * Update an existing project.
     * @param id Project ID
     * @param updates Properties to update
     */
    updateProject: async (id: string, updates: Partial<Project>) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingProject = false;
        set((state) => {
            const allProjects = state._allProjects;
            const oldProject = allProjects.find(p => p.id === id);
            if (!oldProject) {
                missingProject = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);

            const incomingStatus = updates.status ?? oldProject.status;
            const statusChanged = incomingStatus !== oldProject.status;

            let newAllTasks = state._allTasks;
            let newAllSections = state._allSections;

            if (statusChanged && incomingStatus === 'archived') {
                const taskStatus: TaskStatus = 'archived';
                newAllTasks = newAllTasks.map(task => {
                    if (
                        task.projectId === id &&
                        !task.deletedAt &&
                        task.status !== taskStatus
                    ) {
                        return {
                            ...task,
                            status: taskStatus,
                            completedAt: task.completedAt || now,
                            isFocusedToday: false,
                            updatedAt: now,
                            rev: normalizeRevision(task.rev) + 1,
                            revBy: deviceState.deviceId,
                        };
                    }
                    return task;
                });
                newAllSections = newAllSections.map((section) => {
                    if (section.projectId === id && !section.deletedAt) {
                        return {
                            ...section,
                            deletedAt: now,
                            updatedAt: now,
                            rev: normalizeRevision(section.rev) + 1,
                            revBy: deviceState.deviceId,
                        };
                    }
                    return section;
                });
            }

            let adjustedOrder = updates.order;
            const nextAreaId = updates.areaId ?? oldProject.areaId;
            const areaChanged = updates.areaId !== undefined && updates.areaId !== oldProject.areaId;
            if (areaChanged && !Number.isFinite(adjustedOrder)) {
                const maxOrder = allProjects
                    .filter((project) => (project.areaId ?? undefined) === (nextAreaId ?? undefined))
                    .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1);
                adjustedOrder = maxOrder + 1;
            }

            const finalProjectUpdates: Partial<Project> = {
                ...updates,
                ...(Number.isFinite(adjustedOrder) ? { order: adjustedOrder } : {}),
                ...(statusChanged && incomingStatus !== 'active'
                    ? { isFocused: false }
                    : {}),
            };

            const newAllProjects = allProjects.map(project =>
                project.id === id
                    ? {
                        ...project,
                        ...finalProjectUpdates,
                        updatedAt: now,
                        rev: normalizeRevision(project.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : project
            );

            const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
            const newVisibleTasks = selectVisibleTasks(newAllTasks);
            const newVisibleSections = newAllSections.filter((section) => !section.deletedAt);

            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                projects: newVisibleProjects,
                _allProjects: newAllProjects,
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                sections: newVisibleSections,
                _allSections: newAllSections,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        if (missingProject) {
            const message = 'Project not found';
            logWarn('updateProject skipped: project not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    /**
     * Soft-delete a project and all its tasks.
     * @param id Project ID
     */
    deleteProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingProject = false;
        set((state) => {
            const target = state._allProjects.find((project) => project.id === id && !project.deletedAt);
            if (!target) {
                missingProject = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            // Soft-delete project
            const newAllProjects = state._allProjects.map((project) =>
                project.id === id
                    ? {
                        ...project,
                        deletedAt: now,
                        updatedAt: now,
                        rev: normalizeRevision(project.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : project
            );
            const newAllSections = state._allSections.map((section) =>
                section.projectId === id && !section.deletedAt
                    ? {
                        ...section,
                        deletedAt: now,
                        updatedAt: now,
                        rev: normalizeRevision(section.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : section
            );
            // Keep section ids on tombstones so project restore can recover the original structure.
            const newAllTasks = state._allTasks.map(task =>
                task.projectId === id && !task.deletedAt
                    ? {
                        ...task,
                        deletedAt: now,
                        updatedAt: now,
                        rev: normalizeRevision(task.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : task
            );
            // Filter for UI state
            const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
            const newVisibleTasks = selectVisibleTasks(newAllTasks);
            const newVisibleSections = newAllSections.filter((section) => !section.deletedAt);
            clearDerivedCache();
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                projects: newVisibleProjects,
                tasks: newVisibleTasks,
                sections: newVisibleSections,
                _allProjects: newAllProjects,
                _allTasks: newAllTasks,
                _allSections: newAllSections,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingProject) {
            const message = 'Project not found';
            logWarn('deleteProject skipped: project not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    restoreProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingProject = false;
        set((state) => {
            const target = state._allProjects.find((project) => project.id === id);
            if (!target) {
                missingProject = true;
                return state;
            }
            if (!target.deletedAt) {
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const cascadeDeletedAt = target.deletedAt;
            // Only revive sections/tasks deleted by this project deletion cascade.
            // Items deleted earlier keep their older deletedAt and remain tombstoned.
            const restoredArea = target.areaId
                ? state._allAreas.find((area) => area.id === target.areaId && !area.deletedAt)
                : undefined;
            const restoredProject: Project = {
                ...target,
                deletedAt: undefined,
                areaId: restoredArea ? target.areaId : undefined,
                areaTitle: restoredArea
                    ? (typeof target.areaTitle === 'string' && target.areaTitle.trim().length > 0
                        ? target.areaTitle
                        : restoredArea.name)
                    : undefined,
                updatedAt: now,
                rev: normalizeRevision(target.rev) + 1,
                revBy: deviceState.deviceId,
            };
            const newAllProjects = state._allProjects.map((project) =>
                project.id === id ? restoredProject : project
            );
            const newAllSections = state._allSections.map((section) => (
                section.projectId === id && section.deletedAt === cascadeDeletedAt
                    ? {
                        ...section,
                        deletedAt: undefined,
                        updatedAt: now,
                        rev: normalizeRevision(section.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : section
            ));
            const restoredSectionIds = new Set(
                newAllSections
                    .filter((section) => section.projectId === id && !section.deletedAt)
                    .map((section) => section.id)
            );
            const newAllTasks = state._allTasks.map((task) => (
                task.projectId === id && task.deletedAt === cascadeDeletedAt
                    ? {
                        ...task,
                        deletedAt: undefined,
                        purgedAt: undefined,
                        sectionId: task.sectionId && restoredSectionIds.has(task.sectionId)
                            ? task.sectionId
                            : undefined,
                        updatedAt: now,
                        rev: normalizeRevision(task.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : task
            ));
            const newVisibleProjects = newAllProjects.filter((project) => !project.deletedAt);
            const newVisibleSections = newAllSections.filter((section) => !section.deletedAt);
            const newVisibleTasks = selectVisibleTasks(newAllTasks);
            clearDerivedCache();
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                projects: newVisibleProjects,
                sections: newVisibleSections,
                tasks: newVisibleTasks,
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return missingProject ? actionFail('Project not found') : actionOk();
    },

    /**
     * Duplicate a project with its sections and tasks.
     * - Creates a new project named "{Original} (Copy)"
     * - Copies sections/tasks, resets task status + scheduling
     */
    duplicateProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let createdProject: Project | null = null;
        set((state) => {
            const sourceProject = state._allProjects.find((project) => project.id === id && !project.deletedAt);
            if (!sourceProject) return state;
            const deviceState = ensureDeviceId(state.settings);
            const targetAreaId = sourceProject.areaId;
            const maxOrder = state._allProjects
                .filter((project) => !project.deletedAt && (project.areaId ?? undefined) === (targetAreaId ?? undefined))
                .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1);
            const baseOrder = maxOrder + 1;

            const projectAttachments = (sourceProject.attachments || [])
                .filter((attachment) => !attachment.deletedAt)
                .map((attachment) => ({
                    ...attachment,
                    id: uuidv4(),
                    createdAt: now,
                    updatedAt: now,
                    deletedAt: undefined,
                }));

            const newProject: Project = {
                ...sourceProject,
                id: uuidv4(),
                title: `${sourceProject.title} (Copy)`,
                order: baseOrder,
                isFocused: false,
                attachments: projectAttachments.length > 0 ? projectAttachments : undefined,
                createdAt: now,
                updatedAt: now,
                deletedAt: undefined,
                rev: 1,
                revBy: deviceState.deviceId,
            };
            createdProject = newProject;

            const sourceSections = state._allSections.filter(
                (section) => section.projectId === sourceProject.id && !section.deletedAt
            );
            const sectionIdMap = new Map<string, string>();
            const newSections = sourceSections.map((section) => {
                const newId = uuidv4();
                sectionIdMap.set(section.id, newId);
                return {
                    ...section,
                    id: newId,
                    projectId: newProject.id,
                    createdAt: now,
                    updatedAt: now,
                    deletedAt: undefined,
                    rev: 1,
                    revBy: deviceState.deviceId,
                };
            });

            const sourceTasks = state._allTasks.filter(
                (task) => task.projectId === sourceProject.id && !task.deletedAt
            );
            const newTasks: Task[] = sourceTasks.map((task) => {
                const checklist = task.checklist?.map((item) => ({
                    ...item,
                    id: uuidv4(),
                    isCompleted: false,
                }));
                const attachments = (task.attachments || [])
                    .filter((attachment) => !attachment.deletedAt)
                    .map((attachment) => ({
                        ...attachment,
                        id: uuidv4(),
                        createdAt: now,
                        updatedAt: now,
                        deletedAt: undefined,
                    }));
                const nextSectionId = task.sectionId ? sectionIdMap.get(task.sectionId) : undefined;
                const newTask: Task = {
                    ...task,
                    id: uuidv4(),
                    projectId: newProject.id,
                    sectionId: nextSectionId,
                    status: 'next' as TaskStatus,
                    startTime: undefined,
                    dueDate: undefined,
                    reviewAt: undefined,
                    completedAt: undefined,
                    isFocusedToday: false,
                    pushCount: 0,
                    checklist,
                    attachments: attachments.length > 0 ? attachments : undefined,
                    createdAt: now,
                    updatedAt: now,
                    deletedAt: undefined,
                    purgedAt: undefined,
                    rev: 1,
                    revBy: deviceState.deviceId,
                };
                return newTask;
            });

            const newAllProjects = [...state._allProjects, newProject];
            const newAllSections = [...state._allSections, ...newSections];
            const newAllTasks = [...state._allTasks, ...newTasks];
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                projects: [...state.projects, newProject],
                sections: [...state.sections, ...newSections],
                tasks: [...state.tasks, ...newTasks.map(toVisibleTask)],
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return createdProject;
    },

    /**
     * Toggle the focus status of a project.
     * Enforces a maximum of 5 focused projects.
     * @param id Project ID
     */
    toggleProjectFocus: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        set((state) => {
            const allProjects = state._allProjects;
            const project = allProjects.find(p => p.id === id);
            if (!project) return state;
            if (project.status !== 'active' && !project.isFocused) return state;
            const deviceState = ensureDeviceId(state.settings);

            // If turning on focus, check if we already have 5 focused
            const focusedCount = allProjects.filter(p => p.isFocused && !p.deletedAt).length;
            const isCurrentlyFocused = project.isFocused;

            // Don't allow more than 5 focused projects
            if (!isCurrentlyFocused && focusedCount >= 5) {
                return state;
            }

            const newAllProjects = allProjects.map(p =>
                p.id === id
                    ? {
                        ...p,
                        isFocused: !p.isFocused,
                        updatedAt: now,
                        rev: normalizeRevision(p.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : p
            );
            const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
            snapshot = buildSaveSnapshot(state, {
                projects: newAllProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                projects: newVisibleProjects,
                _allProjects: newAllProjects,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    addSection: async (projectId: string, title: string, initialProps?: Partial<Section>) => {
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!projectId || !trimmedTitle) return null;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let createdSection: Section | null = null;
        set((state) => {
            const projectExists = state._allProjects.some((project) => project.id === projectId && !project.deletedAt);
            if (!projectExists) return state;
            const deviceState = ensureDeviceId(state.settings);
            const allSections = state._allSections;
            const maxOrder = allSections
                .filter((section) => section.projectId === projectId && !section.deletedAt)
                .reduce((max, section) => Math.max(max, Number.isFinite(section.order) ? section.order : -1), -1);
            const baseOrder = Number.isFinite(initialProps?.order) ? (initialProps?.order as number) : maxOrder + 1;
            const newSection: Section = {
                id: uuidv4(),
                projectId,
                title: trimmedTitle,
                description: initialProps?.description,
                order: baseOrder,
                isCollapsed: initialProps?.isCollapsed ?? false,
                rev: 1,
                revBy: deviceState.deviceId,
                createdAt: initialProps?.createdAt ?? now,
                updatedAt: now,
            };
            createdSection = newSection;
            const newAllSections = [...allSections, newSection];
            const newVisibleSections = [...state.sections, newSection];
            snapshot = buildSaveSnapshot(state, {
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                sections: newVisibleSections,
                _allSections: newAllSections,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return createdSection;
    },

    updateSection: async (id: string, updates: Partial<Section>) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingSection = false;
        let invalidTitle = false;
        set((state) => {
            const allSections = state._allSections;
            const section = allSections.find((item) => item.id === id);
            if (!section) {
                missingSection = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const nextTitle = updates.title !== undefined ? updates.title.trim() : section.title;
            if (!nextTitle) {
                invalidTitle = true;
                return state;
            }
            const { projectId: _ignored, ...restUpdates } = updates;
            const newAllSections = allSections.map((item) =>
                item.id === id
                    ? {
                        ...item,
                        ...restUpdates,
                        title: nextTitle,
                        updatedAt: now,
                        rev: normalizeRevision(item.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : item
            );
            const newVisibleSections = newAllSections.filter((item) => !item.deletedAt);
            snapshot = buildSaveSnapshot(state, {
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                sections: newVisibleSections,
                _allSections: newAllSections,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingSection) {
            const message = 'Section not found';
            logWarn('updateSection skipped: section not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        if (invalidTitle) {
            const message = 'Section title is required';
            set({ error: message });
            return actionFail(message);
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    deleteSection: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingSection = false;
        set((state) => {
            const allSections = state._allSections;
            const section = allSections.find((item) => item.id === id);
            if (!section) {
                missingSection = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const newAllSections = allSections.map((item) =>
                item.id === id
                    ? {
                        ...item,
                        deletedAt: now,
                        updatedAt: now,
                        rev: normalizeRevision(item.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : item
            );
            const newAllTasks = state._allTasks.map((task) => {
                if (task.sectionId !== id) return task;
                return {
                    ...task,
                    sectionId: undefined,
                    updatedAt: now,
                    rev: normalizeRevision(task.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });
            const newVisibleSections = newAllSections.filter((item) => !item.deletedAt);
            const newVisibleTasks = selectVisibleTasks(newAllTasks);
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                sections: newVisibleSections,
                _allSections: newAllSections,
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingSection) {
            const message = 'Section not found';
            logWarn('deleteSection skipped: section not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    addArea: async (name: string, initialProps?: Partial<Area>) => {
        const trimmedName = typeof name === 'string' ? name.trim() : '';
        if (!trimmedName) return null;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const normalized = trimmedName.toLowerCase();
        let snapshot: AppData | null = null;
        let createdArea: Area | null = null;
        let existingAreaId: string | null = null;
        let shouldRestoreDeletedArea = false;
        set((state) => {
            const allAreas = state._allAreas;
            const existingActive = allAreas.find((area) => !area.deletedAt && area?.name?.trim().toLowerCase() === normalized);
            if (existingActive) {
                existingAreaId = existingActive.id;
                return state;
            }
            const existingDeleted = allAreas.find((area) => area.deletedAt && area?.name?.trim().toLowerCase() === normalized);
            if (existingDeleted) {
                existingAreaId = existingDeleted.id;
                shouldRestoreDeletedArea = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const maxOrder = allAreas.reduce(
                (max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1),
                -1
            );
            const baseOrder = Number.isFinite(initialProps?.order) ? (initialProps?.order as number) : maxOrder + 1;
            const newArea: Area = {
                id: uuidv4(),
                name: trimmedName,
                ...initialProps,
                order: baseOrder,
                rev: 1,
                revBy: deviceState.deviceId,
                createdAt: initialProps?.createdAt ?? now,
                updatedAt: now,
            };
            createdArea = newArea;
            const newAllAreas = [...allAreas, newArea].sort((a, b) => a.order - b.order);
            const newVisibleAreas = newAllAreas.filter((area) => !area.deletedAt);
            snapshot = buildSaveSnapshot(state, {
                areas: newAllAreas,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                areas: newVisibleAreas,
                _allAreas: newAllAreas,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (existingAreaId) {
            if (shouldRestoreDeletedArea || (initialProps && Object.keys(initialProps).length > 0)) {
                const result = await get().updateArea(existingAreaId, {
                    ...(initialProps ?? {}),
                    ...(shouldRestoreDeletedArea ? { deletedAt: undefined, name: trimmedName } : {}),
                });
                if (!result.success) {
                    set({ error: shouldRestoreDeletedArea ? 'Failed to restore area' : 'Failed to update area' });
                    return null;
                }
            }
            const resolvedArea = get()._allAreas.find((area) => area.id === existingAreaId);
            if (shouldRestoreDeletedArea && (!resolvedArea || resolvedArea.deletedAt)) {
                set({ error: 'Failed to restore area' });
                return null;
            }
            return resolvedArea && !resolvedArea.deletedAt ? resolvedArea : null;
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return createdArea;
    },

    updateArea: async (id: string, updates: Partial<Area>) => {
        let snapshot: AppData | null = null;
        let missingArea = false;
        let invalidName = false;
        set((state) => {
            const allAreas = state._allAreas;
            const area = allAreas.find(a => a.id === id);
            if (!area) {
                missingArea = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            if (updates.name !== undefined) {
                const trimmedName = updates.name.trim();
                if (!trimmedName) {
                    invalidName = true;
                    return state;
                }
                const normalized = trimmedName.toLowerCase();
                const existing = allAreas.find((a) => a.id !== id && !a.deletedAt && a?.name?.trim().toLowerCase() === normalized);
                if (existing) {
                    const now = new Date().toISOString();
                    const mergedArea: Area = {
                        ...existing,
                        ...updates,
                        name: trimmedName,
                        updatedAt: now,
                        rev: normalizeRevision(existing.rev) + 1,
                        revBy: deviceState.deviceId,
                    };
                    const newAllAreas = allAreas
                        .filter((a) => a.id !== id && a.id !== existing.id)
                        .concat(mergedArea)
                        .sort((a, b) => a.order - b.order);
                    const newAllProjects = state._allProjects.map((project) => {
                        if (project.areaId !== id) return project;
                        return {
                            ...project,
                            areaId: existing.id,
                            color: mergedArea.color ?? project.color,
                            updatedAt: now,
                            rev: normalizeRevision(project.rev) + 1,
                            revBy: deviceState.deviceId,
                        };
                    });
                    const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
                    snapshot = buildSaveSnapshot(state, {
                        areas: newAllAreas,
                        projects: newAllProjects,
                        ...(deviceState.updated ? { settings: deviceState.settings } : {}),
                    });
                    return {
                        areas: newAllAreas.filter((item) => !item.deletedAt),
                        _allAreas: newAllAreas,
                        projects: newVisibleProjects,
                        _allProjects: newAllProjects,
                        lastDataChangeAt: Date.now(),
                        ...(deviceState.updated ? { settings: deviceState.settings } : {}),
                    };
                }
            }
            const changeAt = Date.now();
            const now = new Date().toISOString();
            const nextOrder = Number.isFinite(updates.order) ? (updates.order as number) : area.order;
            const nextName = updates.name !== undefined ? updates.name.trim() : area.name;
            let projectsChanged = false;
            let newAllProjects = state._allProjects;
            if (typeof updates.color === 'string') {
                const nextAreaColor = updates.color;
                newAllProjects = state._allProjects.map((project) => {
                    if (project.areaId !== id) return project;
                    if (project.color === nextAreaColor) return project;
                    projectsChanged = true;
                    return {
                        ...project,
                        color: nextAreaColor,
                        updatedAt: now,
                        rev: normalizeRevision(project.rev) + 1,
                        revBy: deviceState.deviceId,
                    };
                });
            }
            const newAllAreas = allAreas
                .map(a => (a.id === id
                    ? {
                        ...a,
                        ...updates,
                        name: nextName,
                        order: nextOrder,
                        updatedAt: now,
                        rev: normalizeRevision(a.rev) + 1,
                        revBy: deviceState.deviceId,
                    }
                    : a))
                .sort((a, b) => a.order - b.order);
            snapshot = buildSaveSnapshot(state, {
                areas: newAllAreas,
                ...(projectsChanged ? { projects: newAllProjects } : {}),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                areas: newAllAreas.filter((item) => !item.deletedAt),
                _allAreas: newAllAreas,
                ...(projectsChanged
                    ? {
                        projects: newAllProjects.filter((item) => !item.deletedAt),
                        _allProjects: newAllProjects,
                    }
                    : {}),
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingArea) {
            const message = 'Area not found';
            logWarn('updateArea skipped: area not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        if (invalidName) {
            const message = 'Area name is required';
            set({ error: message });
            return actionFail(message);
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    deleteArea: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingArea = false;
        set((state) => {
            const allAreas = state._allAreas;
            const area = allAreas.find((item) => item.id === id);
            if (!area || area.deletedAt) {
                missingArea = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const newAllAreas = allAreas
                .map((item) =>
                    item.id === id
                        ? {
                            ...item,
                            deletedAt: now,
                            updatedAt: now,
                            rev: normalizeRevision(item.rev) + 1,
                            revBy: deviceState.deviceId,
                        }
                        : item
                )
                .sort((a, b) => a.order - b.order);
            const newAllProjects = state._allProjects.map((project) => {
                if (project.areaId !== id) return project;
                return {
                    ...project,
                    areaId: undefined,
                    areaTitle: undefined,
                    updatedAt: now,
                    rev: normalizeRevision(project.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });
            const newAllTasks = state._allTasks.map((task) => {
                if (task.areaId !== id) return task;
                return {
                    ...task,
                    areaId: undefined,
                    updatedAt: now,
                    rev: normalizeRevision(task.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });
            const newVisibleProjects = newAllProjects.filter(p => !p.deletedAt);
            const newVisibleTasks = selectVisibleTasks(newAllTasks);
            const newVisibleAreas = newAllAreas.filter((item) => !item.deletedAt);
            clearDerivedCache();
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                areas: newAllAreas,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                areas: newVisibleAreas,
                _allAreas: newAllAreas,
                projects: newVisibleProjects,
                _allProjects: newAllProjects,
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingArea) {
            const message = 'Area not found';
            logWarn('deleteArea skipped: area not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    restoreArea: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingArea = false;
        set((state) => {
            const area = state._allAreas.find((item) => item.id === id);
            if (!area) {
                missingArea = true;
                return state;
            }
            if (!area.deletedAt) {
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const newAllAreas = state._allAreas
                .map((item) => (
                    item.id === id
                        ? {
                            ...item,
                            deletedAt: undefined,
                            updatedAt: now,
                            rev: normalizeRevision(item.rev) + 1,
                            revBy: deviceState.deviceId,
                        }
                        : item
                ))
                .sort((a, b) => a.order - b.order);
            const newVisibleAreas = newAllAreas.filter((item) => !item.deletedAt);
            clearDerivedCache();
            snapshot = buildSaveSnapshot(state, {
                areas: newAllAreas,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                areas: newVisibleAreas,
                _allAreas: newAllAreas,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return missingArea ? actionFail('Area not found') : actionOk();
    },

    reorderAreas: async (orderedIds: string[]) => {
        if (orderedIds.length === 0) return;
        let snapshot: AppData | null = null;
        set((state) => {
            const allAreas = state._allAreas;
            const activeAreas = allAreas.filter((area) => !area.deletedAt);
            const deletedAreas = allAreas.filter((area) => area.deletedAt);
            const areaById = new Map(activeAreas.map(area => [area.id, area]));
            const seen = new Set<string>();
            const now = new Date().toISOString();
            const deviceState = ensureDeviceId(state.settings);

            const reordered: Area[] = [];
            orderedIds.forEach((id, index) => {
                const area = areaById.get(id);
                if (!area) return;
                seen.add(id);
                reordered.push({ ...area, order: index, updatedAt: now });
            });

            const remaining = activeAreas
                .filter(area => !seen.has(area.id))
                .sort((a, b) => a.order - b.order)
                .map((area, idx) => ({
                    ...area,
                    order: reordered.length + idx,
                    updatedAt: now,
                }));

            const newVisibleAreas = [...reordered, ...remaining].map((area) => ({
                ...area,
                rev: normalizeRevision(area.rev) + 1,
                revBy: deviceState.deviceId,
            }));
            const newAllAreas = [...newVisibleAreas, ...deletedAreas];
            snapshot = buildSaveSnapshot(state, {
                areas: newAllAreas,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                areas: newVisibleAreas,
                _allAreas: newAllAreas,
                lastDataChangeAt: Date.now(),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    reorderProjects: async (orderedIds: string[], areaId?: string) => {
        if (orderedIds.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const targetAreaId = areaId ?? undefined;
        let snapshot: AppData | null = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const allProjects = state._allProjects;
            const isInArea = (project: Project) => (project.areaId ?? undefined) === targetAreaId && !project.deletedAt;

            const areaProjects = allProjects.filter(isInArea);
            const orderedSet = new Set(orderedIds);
            const remaining = areaProjects
                .filter((project) => !orderedSet.has(project.id))
                .sort((a, b) => (Number.isFinite(a.order) ? a.order : 0) - (Number.isFinite(b.order) ? b.order : 0));

            const finalIds = [...orderedIds, ...remaining.map((project) => project.id)];
            const orderById = new Map<string, number>();
            finalIds.forEach((id, index) => {
                orderById.set(id, index);
            });

            const newAllProjects = allProjects.map((project) => {
                if (!isInArea(project)) return project;
                const nextOrder = orderById.get(project.id);
                if (!Number.isFinite(nextOrder)) return project;
                return {
                    ...project,
                    order: nextOrder as number,
                    updatedAt: now,
                    rev: normalizeRevision(project.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });

            const newVisibleProjects = newAllProjects.filter((p) => !p.deletedAt);
            snapshot = buildSaveSnapshot(state, {
                projects: newAllProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                projects: newVisibleProjects,
                _allProjects: newAllProjects,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    reorderProjectTasks: async (projectId: string, orderedIds: string[], sectionId?: string | null) => {
        if (!projectId || orderedIds.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const allTasks = state._allTasks;
            const hasSectionFilter = sectionId !== undefined;
            const isInProject = (task: Task) => {
                if (task.projectId !== projectId || task.deletedAt) return false;
                if (!hasSectionFilter) return true;
                if (!sectionId) {
                    return !task.sectionId;
                }
                return task.sectionId === sectionId;
            };

            const projectTasks = allTasks.filter(isInProject);
            const orderedSet = new Set(orderedIds);
            const remaining = projectTasks
                .filter((task) => !orderedSet.has(task.id))
                .sort((a, b) => {
                    const aOrder = getTaskOrder(a) ?? Number.POSITIVE_INFINITY;
                    const bOrder = getTaskOrder(b) ?? Number.POSITIVE_INFINITY;
                    if (aOrder !== bOrder) return aOrder - bOrder;
                    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
                });

            const finalIds = [...orderedIds, ...remaining.map((task) => task.id)];
            const orderById = new Map<string, number>();
            finalIds.forEach((id, index) => {
                orderById.set(id, index);
            });

            const newAllTasks = allTasks.map((task) => {
                if (!isInProject(task)) return task;
                const nextOrder = orderById.get(task.id);
                if (!Number.isFinite(nextOrder)) return task;
                return {
                    ...task,
                    order: nextOrder as number,
                    orderNum: nextOrder as number,
                    updatedAt: now,
                    rev: normalizeRevision(task.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });

            const newVisibleTasks = selectVisibleTasks(newAllTasks);
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    deleteTag: async (tagId: string) => {
        const normalizedTarget = normalizeTagId(tagId);
        if (!normalizedTarget) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const newAllTasks = state._allTasks.map((task) => {
                if (!task.tags || task.tags.length === 0) return task;
                const filtered = task.tags.filter((tag) => normalizeTagId(tag) !== normalizedTarget);
                if (filtered.length === task.tags.length) return task;
                return {
                    ...task,
                    tags: filtered,
                    updatedAt: now,
                    rev: normalizeRevision(task.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });

            const newAllProjects = state._allProjects.map((project) => {
                if (!project.tagIds || project.tagIds.length === 0) return project;
                const filtered = project.tagIds.filter((tag) => normalizeTagId(tag) !== normalizedTarget);
                if (filtered.length === project.tagIds.length) return project;
                return {
                    ...project,
                    tagIds: filtered,
                    updatedAt: now,
                    rev: normalizeRevision(project.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });

            const newVisibleTasks = selectVisibleTasks(newAllTasks);
            const newVisibleProjects = newAllProjects.filter((p) => !p.deletedAt);

            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                projects: newVisibleProjects,
                _allTasks: newAllTasks,
                _allProjects: newAllProjects,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    renameTag: async (oldTagId: string, newTagId: string) => {
        const normalizedOld = normalizeTagId(oldTagId);
        const normalizedNew = normalizeTagId(newTagId);
        if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const newAllTasks = state._allTasks.map((task) => {
                if (!task.tags || task.tags.length === 0) return task;
                const idx = task.tags.findIndex((tag) => normalizeTagId(tag) === normalizedOld);
                if (idx === -1) return task;
                const newTags = [...task.tags];
                newTags[idx] = normalizedNew;
                return {
                    ...task,
                    tags: dedupeTagValuesLastWins(newTags, normalizedNew),
                    updatedAt: now,
                    rev: normalizeRevision(task.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });

            const newAllProjects = state._allProjects.map((project) => {
                if (!project.tagIds || project.tagIds.length === 0) return project;
                const idx = project.tagIds.findIndex((tag) => normalizeTagId(tag) === normalizedOld);
                if (idx === -1) return project;
                const newTagIds = [...project.tagIds];
                newTagIds[idx] = normalizedNew;
                return {
                    ...project,
                    tagIds: dedupeTagValuesLastWins(newTagIds, normalizedNew),
                    updatedAt: now,
                    rev: normalizeRevision(project.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });

            const newVisibleTasks = selectVisibleTasks(newAllTasks);
            const newVisibleProjects = newAllProjects.filter((p) => !p.deletedAt);

            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                projects: newVisibleProjects,
                _allTasks: newAllTasks,
                _allProjects: newAllProjects,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    deleteContext: async (context: string) => {
        const normalized = context.trim().toLowerCase();
        if (!normalized) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const newAllTasks = state._allTasks.map((task) => {
                if (!task.contexts || task.contexts.length === 0) return task;
                const filtered = task.contexts.filter((ctx) => ctx.trim().toLowerCase() !== normalized);
                if (filtered.length === task.contexts.length) return task;
                return {
                    ...task,
                    contexts: filtered,
                    updatedAt: now,
                    rev: normalizeRevision(task.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });

            const newVisibleTasks = selectVisibleTasks(newAllTasks);

            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    renameContext: async (oldContext: string, newContext: string) => {
        const normalizedOld = oldContext.trim().toLowerCase();
        const normalizedNew = newContext.trim();
        if (!normalizedOld || !normalizedNew || normalizedOld === normalizedNew.toLowerCase()) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const newAllTasks = state._allTasks.map((task) => {
                if (!task.contexts || task.contexts.length === 0) return task;
                const idx = task.contexts.findIndex((ctx) => ctx.trim().toLowerCase() === normalizedOld);
                if (idx === -1) return task;
                const newContexts = [...task.contexts];
                newContexts[idx] = normalizedNew;
                // Deduplicate
                const seen = new Set<string>();
                const unique = newContexts.filter((ctx) => {
                    const key = ctx.trim().toLowerCase();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
                return {
                    ...task,
                    contexts: unique,
                    updatedAt: now,
                    rev: normalizeRevision(task.rev) + 1,
                    revBy: deviceState.deviceId,
                };
            });

            const newVisibleTasks = selectVisibleTasks(newAllTasks);

            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: changeAt,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },
});
