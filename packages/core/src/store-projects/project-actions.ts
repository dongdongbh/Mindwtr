import {
    archiveSectionForProjectArchive,
    completeTaskForProjectArchive,
    ensureDeviceId,
    getNextDataChangeAt,
    nextRevision,
    persist,
    restoreSectionFromProjectArchive,
    restoreTaskFromProjectArchive,
} from '../store-helpers';
import { logWarn } from '../logger';
import { clearDerivedCache } from '../store-settings';
import { generateUUID as uuidv4 } from '../uuid';
import { DEFAULT_PROJECT_COLOR } from '../color-constants';
import { findSelectableProjectByTitleAndArea } from '../project-utils';
import { isTaskFinished } from '../task-status';
import type { Area } from '../types';
import type { Project, ProjectCoreActions, ProjectActionContext, Task, TaskStatus } from './shared';
import type { TaskStore } from '../store-types';
import type { PendingRemoteAttachmentDelete } from '../types';
import {
    compactPurgedProjectForLocalStorage,
    compactPurgedProjectSectionTombstone,
} from '../tombstone-compaction';
import { actionFail, actionOk, mutateEntities } from './shared';

const duplicateProjectAttachmentCopy = (attachment: NonNullable<Project['attachments']>[number], now: string) => ({
    ...attachment,
    id: uuidv4(),
    createdAt: now,
    updatedAt: now,
    deletedAt: undefined,
    cloudKey: undefined,
    fileHash: undefined,
    localStatus: undefined,
    contentRev: undefined,
    contentMtimeMs: undefined,
    contentSize: undefined,
});

const collectRetainedAttachmentCloudKeys = (
    projects: readonly Project[],
    tasks: readonly Task[],
): Set<string> => {
    const cloudKeys = new Set<string>();
    for (const project of projects) {
        if (project.purgedAt) continue;
        for (const attachment of project.attachments || []) {
            if (attachment.kind === 'file' && attachment.cloudKey) {
                cloudKeys.add(attachment.cloudKey);
            }
        }
    }
    for (const task of tasks) {
        if (task.purgedAt) continue;
        for (const attachment of task.attachments || []) {
            if (attachment.kind === 'file' && attachment.cloudKey) {
                cloudKeys.add(attachment.cloudKey);
            }
        }
    }
    return cloudKeys;
};

const collectPendingRemoteDeletesForProjects = (
    projects: readonly Project[],
    remainingProjects: readonly Project[],
    tasks: readonly Task[],
): PendingRemoteAttachmentDelete[] => {
    const byCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    const retainedCloudKeys = collectRetainedAttachmentCloudKeys(remainingProjects, tasks);
    for (const project of projects) {
        for (const attachment of project.attachments || []) {
            if (attachment.kind !== 'file' || !attachment.cloudKey) continue;
            if (retainedCloudKeys.has(attachment.cloudKey)) continue;
            if (byCloudKey.has(attachment.cloudKey)) continue;
            byCloudKey.set(attachment.cloudKey, {
                cloudKey: attachment.cloudKey,
            });
        }
    }
    return Array.from(byCloudKey.values());
};

const appendPendingRemoteDeletes = (
    settings: TaskStore['settings'],
    pendingDeletes: readonly PendingRemoteAttachmentDelete[],
): TaskStore['settings'] => {
    if (pendingDeletes.length === 0) return settings;
    const byCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    for (const existing of settings.attachments?.pendingRemoteDeletes || []) {
        byCloudKey.set(existing.cloudKey, existing);
    }
    for (const pending of pendingDeletes) {
        if (byCloudKey.has(pending.cloudKey)) continue;
        byCloudKey.set(pending.cloudKey, pending);
    }
    return {
        ...settings,
        attachments: {
            ...settings.attachments,
            pendingRemoteDeletes: Array.from(byCloudKey.values()),
        },
    };
};

type BuildNewProjectParams = {
    title: string;
    color?: string;
    initialProps?: Partial<Project>;
    existingProjects: readonly Project[];
    /** Needed only to stamp `areaTitle`, the denormalized copy of the area name
     *  that every other project writer keeps in step. Omitting it at creation
     *  leaves a project the sync merge has to repair on the next cycle. */
    existingAreas: readonly Area[];
    settings: TaskStore['settings'];
    deviceId: string;
    now: string;
    id?: string;
};

export const buildNewProject = ({
    title,
    color,
    initialProps,
    existingProjects,
    existingAreas,
    settings,
    deviceId,
    now,
    id,
}: BuildNewProjectParams): Project => {
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    const targetAreaId = initialProps?.areaId;
    const maxOrder = existingProjects
        .filter((project) => (project.areaId ?? undefined) === (targetAreaId ?? undefined))
        .reduce((max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1), -1);
    const baseOrder = Number.isFinite(initialProps?.order) ? (initialProps?.order as number) : maxOrder + 1;
    const hasExplicitFlowMode = Boolean(
        initialProps && Object.prototype.hasOwnProperty.call(initialProps, 'isSequential')
    );
    const useSequentialDefault = !hasExplicitFlowMode
        && settings.gtd?.defaultProjectFlowMode === 'sequential';

    const project: Project = {
        id: id ?? uuidv4(),
        title: trimmedTitle,
        color: color ?? DEFAULT_PROJECT_COLOR,
        order: baseOrder,
        status: 'active',
        rev: 1,
        revBy: deviceId,
        createdAt: now,
        updatedAt: now,
        // Canonical form for both is an explicit `false` (sync-normalization.ts
        // materializes them); see the same note in store-tasks.ts.
        isSequential: false,
        isFocused: false,
        ...(useSequentialDefault ? { isSequential: true } : {}),
        ...initialProps,
        tagIds: initialProps?.tagIds ?? [],
    };
    // Resolved from the FINAL areaId, which initialProps may have supplied.
    const areaTitle = project.areaId
        ? existingAreas.find((area) => area.id === project.areaId && !area.deletedAt)?.name?.trim() || undefined
        : undefined;
    return areaTitle === project.areaTitle ? project : { ...project, areaTitle };
};

export const createProjectCoreActions = ({
    set,
    get,
    debouncedSave,
}: ProjectActionContext): ProjectCoreActions => ({
    addProject: async (title: string, color: string, initialProps?: Partial<Project>) => {
        const changeAt = Date.now();
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!trimmedTitle) {
            set({ error: 'Project title is required' });
            return null;
        }
        const targetAreaId = typeof initialProps?.areaId === 'string' ? initialProps.areaId : undefined;
        let createdProject: Project | null = null;
        let existingProject: Project | null = null;
        set((state) => {
            const duplicate = findSelectableProjectByTitleAndArea(state._allProjects, trimmedTitle, targetAreaId);
            if (duplicate) {
                existingProject = duplicate;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const now = new Date().toISOString();
            const newProject = buildNewProject({
                title: trimmedTitle,
                color,
                initialProps,
                existingProjects: state._allProjects,
                existingAreas: state._allAreas,
                settings: state.settings,
                deviceId: deviceState.deviceId,
                now,
            });
            createdProject = newProject;
            const newAllProjects = [...state._allProjects, newProject];
            persist(set, debouncedSave, state, {
                projects: newAllProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (existingProject) {
            return existingProject;
        }
        return createdProject;
    },

    updateProject: async (id: string, updates: Partial<Project>) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
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
                newAllTasks = newAllTasks.map(task => {
                    if (
                        task.projectId === id &&
                        !task.deletedAt &&
                        !isTaskFinished(task)
                    ) {
                        return completeTaskForProjectArchive(task, now, deviceState.deviceId);
                    }
                    return task;
                });
                newAllSections = newAllSections.map((section) => {
                    if (section.projectId === id && !section.deletedAt) {
                        return archiveSectionForProjectArchive(section, now, deviceState.deviceId);
                    }
                    return section;
                });
            } else if (statusChanged && oldProject.status === 'archived' && incomingStatus !== 'archived') {
                newAllTasks = newAllTasks.map((task) => {
                    if (task.projectId !== id || !task.projectArchivedAt) return task;
                    return restoreTaskFromProjectArchive(task, now, deviceState.deviceId);
                });
                newAllSections = newAllSections.map((section) => {
                    if (section.projectId !== id || !section.projectArchivedAt) return section;
                    return restoreSectionFromProjectArchive(section, now, deviceState.deviceId);
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
                        rev: nextRevision(project.rev),
                        revBy: deviceState.deviceId,
                    }
                    : project
            );

            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allTasks: newAllTasks,
                _allSections: newAllSections,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
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

        return actionOk();
    },

    deleteProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
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
                        rev: nextRevision(project.rev),
                        revBy: deviceState.deviceId,
                    }
                    : project
            );
            const sectionIdsForProject = new Set(
                state._allSections
                    .filter((section) => section.projectId === id)
                    .map((section) => section.id)
            );
            const newAllSections = state._allSections.map((section) =>
                sectionIdsForProject.has(section.id) && !section.deletedAt
                    ? {
                        ...section,
                        deletedAt: now,
                        updatedAt: now,
                        rev: nextRevision(section.rev),
                        revBy: deviceState.deviceId,
                    }
                    : section
            );
            const newAllTasks = state._allTasks.map(task =>
                !task.deletedAt && (task.projectId === id || (task.sectionId && sectionIdsForProject.has(task.sectionId)))
                    ? {
                        ...task,
                        projectId: undefined,
                        sectionId: undefined,
                        updatedAt: now,
                        rev: nextRevision(task.rev),
                        revBy: deviceState.deviceId,
                    }
                    : task
            );
            clearDerivedCache();
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allTasks: newAllTasks,
                _allSections: newAllSections,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
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
        return actionOk();
    },

    restoreProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
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
                purgedAt: undefined,
                areaId: restoredArea ? target.areaId : undefined,
                areaTitle: restoredArea
                    ? (typeof target.areaTitle === 'string' && target.areaTitle.trim().length > 0
                        ? target.areaTitle
                        : restoredArea.name)
                    : undefined,
                updatedAt: now,
                rev: nextRevision(target.rev),
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
                        rev: nextRevision(section.rev),
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
                        rev: nextRevision(task.rev),
                        revBy: deviceState.deviceId,
                    }
                    : task
            ));
            clearDerivedCache();
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        return missingProject ? actionFail('Project not found') : actionOk();
    },

    purgeProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let missingProject = false;
        set((state) => {
            const target = state._allProjects.find((project) => project.id === id && !project.purgedAt);
            if (!target) {
                missingProject = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const sectionIdsForProject = new Set(
                state._allSections
                    .filter((section) => section.projectId === id)
                    .map((section) => section.id)
            );
            const remainingProjects = state._allProjects.filter((project) => project.id !== id);
            const pendingDeletes = collectPendingRemoteDeletesForProjects([target], remainingProjects, state._allTasks);
            const nextSettings = pendingDeletes.length > 0
                ? appendPendingRemoteDeletes(deviceState.settings, pendingDeletes)
                : deviceState.settings;
            const settingsChanged = deviceState.updated || pendingDeletes.length > 0;

            const newAllProjects = state._allProjects.map((project) =>
                project.id === id
                    ? compactPurgedProjectForLocalStorage({
                        ...project,
                        deletedAt: project.deletedAt ?? now,
                        purgedAt: now,
                        updatedAt: now,
                        rev: nextRevision(project.rev),
                        revBy: deviceState.deviceId,
                    })
                    : project
            );
            const newAllSections = state._allSections.map((section) =>
                sectionIdsForProject.has(section.id)
                    ? compactPurgedProjectSectionTombstone({
                        ...section,
                        deletedAt: now,
                        updatedAt: now,
                        rev: nextRevision(section.rev),
                        revBy: deviceState.deviceId,
                    }, now)
                    : section
            );
            const newAllTasks = state._allTasks.map(task =>
                !task.deletedAt && (task.projectId === id || (task.sectionId && sectionIdsForProject.has(task.sectionId)))
                    ? {
                        ...task,
                        projectId: undefined,
                        sectionId: undefined,
                        updatedAt: now,
                        rev: nextRevision(task.rev),
                        revBy: deviceState.deviceId,
                    }
                    : task
            );
            clearDerivedCache();
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(settingsChanged ? { settings: nextSettings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(settingsChanged ? { settings: nextSettings } : {}),
            };
        });
        if (missingProject) {
            const message = 'Project not found';
            logWarn('purgeProject skipped: project not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        return actionOk();
    },

    purgeDeletedProjects: async () => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        set((state) => {
            const selectedProjects = state._allProjects.filter((project) => project.deletedAt && !project.purgedAt);
            if (selectedProjects.length === 0) return state;
            const selectedIds = new Set(selectedProjects.map((project) => project.id));
            const deviceState = ensureDeviceId(state.settings);
            const sectionIdsForProjects = new Set(
                state._allSections
                    .filter((section) => selectedIds.has(section.projectId))
                    .map((section) => section.id)
            );
            const remainingProjects = state._allProjects.filter((project) => !selectedIds.has(project.id));
            const pendingDeletes = collectPendingRemoteDeletesForProjects(selectedProjects, remainingProjects, state._allTasks);
            const nextSettings = pendingDeletes.length > 0
                ? appendPendingRemoteDeletes(deviceState.settings, pendingDeletes)
                : deviceState.settings;
            const settingsChanged = deviceState.updated || pendingDeletes.length > 0;

            const newAllProjects = state._allProjects.map((project) =>
                selectedIds.has(project.id)
                    ? compactPurgedProjectForLocalStorage({
                        ...project,
                        deletedAt: project.deletedAt ?? now,
                        purgedAt: now,
                        updatedAt: now,
                        rev: nextRevision(project.rev),
                        revBy: deviceState.deviceId,
                    })
                    : project
            );
            const newAllSections = state._allSections.map((section) =>
                sectionIdsForProjects.has(section.id)
                    ? compactPurgedProjectSectionTombstone({
                        ...section,
                        deletedAt: now,
                        updatedAt: now,
                        rev: nextRevision(section.rev),
                        revBy: deviceState.deviceId,
                    }, now)
                    : section
            );
            const newAllTasks = state._allTasks.map(task =>
                !task.deletedAt && (task.projectId && selectedIds.has(task.projectId)
                    || task.sectionId && sectionIdsForProjects.has(task.sectionId))
                    ? {
                        ...task,
                        projectId: undefined,
                        sectionId: undefined,
                        updatedAt: now,
                        rev: nextRevision(task.rev),
                        revBy: deviceState.deviceId,
                    }
                    : task
            );
            clearDerivedCache();
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(settingsChanged ? { settings: nextSettings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(settingsChanged ? { settings: nextSettings } : {}),
            };
        });
        return actionOk();
    },

    duplicateProject: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
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
                .map((attachment) => duplicateProjectAttachmentCopy(attachment, now));

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
                    .map((attachment) => duplicateProjectAttachmentCopy(attachment, now));
                const nextSectionId = task.sectionId ? sectionIdMap.get(task.sectionId) : undefined;
                const newTask: Task = {
                    ...task,
                    id: uuidv4(),
                    projectId: newProject.id,
                    sectionId: nextSectionId,
                    status: (task.status === 'reference' ? 'reference' : 'next') as TaskStatus,
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
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        return createdProject;
    },

    toggleProjectFocus: async (id: string) => {
        await mutateEntities({ set, debouncedSave }, {
            collection: 'projects',
            select: (state) => state._allProjects.filter((project) => project.id === id),
            buildUpdates: (project) => {
                if (project.status !== 'active' && !project.isFocused) return null;
                if (!project.isFocused && get().getDerivedState().focusedProjectCount >= 5) return null;
                return { isFocused: !project.isFocused };
            },
        });
    },
});
