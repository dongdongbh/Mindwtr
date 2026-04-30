import {
    buildSaveSnapshot,
    ensureDeviceId,
    normalizeRevision,
    selectVisibleTasks,
    toVisibleTask,
} from '../store-helpers';
import { logWarn } from '../logger';
import { clearDerivedCache } from '../store-settings';
import { generateUUID as uuidv4 } from '../uuid';
import type { Project, ProjectCoreActions, ProjectActionContext, Task, TaskStatus } from './shared';
import { actionFail, actionOk } from './shared';

export const createProjectCoreActions = ({
    set,
    debouncedSave,
}: ProjectActionContext): ProjectCoreActions => ({
    addProject: async (title: string, color: string, initialProps?: Partial<Project>) => {
        const changeAt = Date.now();
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!trimmedTitle) {
            set({ error: 'Project title is required' });
            return null;
        }
        const normalizedTitle = trimmedTitle.toLowerCase();
        let snapshot = null;
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

    updateProject: async (id: string, updates: Partial<Project>) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
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

    deleteProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
        let missingProject = false;
        set((state) => {
            const target = state._allProjects.find((project) => project.id === id && !project.deletedAt);
            if (!target) {
                missingProject = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
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
        let snapshot = null;
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

    duplicateProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
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

    toggleProjectFocus: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
        set((state) => {
            const allProjects = state._allProjects;
            const project = allProjects.find(p => p.id === id);
            if (!project) return state;
            if (project.status !== 'active' && !project.isFocused) return state;
            const deviceState = ensureDeviceId(state.settings);

            const focusedCount = allProjects.filter(p => p.isFocused && !p.deletedAt).length;
            const isCurrentlyFocused = project.isFocused;

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
});
