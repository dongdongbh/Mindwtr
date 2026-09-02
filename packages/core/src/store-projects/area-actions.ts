import { DEFAULT_PROJECT_COLOR } from '../color-constants';
import { ensureDeviceId, getNextDataChangeAt, nextRevision, persist } from '../store-helpers';
import { logWarn } from '../logger';
import { clearDerivedCache } from '../store-settings';
import { generateUUID as uuidv4 } from '../uuid';
import type { Area, AreaActions, ProjectActionContext } from './shared';
import { actionFail, actionOk, mutateEntities } from './shared';

export const createAreaActions = ({
    set,
    get,
    debouncedSave,
}: ProjectActionContext): AreaActions => ({
    addArea: async (name: string, initialProps?: Partial<Area>) => {
        const trimmedName = typeof name === 'string' ? name.trim() : '';
        if (!trimmedName) return null;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const normalized = trimmedName.toLowerCase();
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
            persist(set, debouncedSave, state, {
                areas: newAllAreas,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allAreas: newAllAreas,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (existingAreaId) {
            if (shouldRestoreDeletedArea) {
                const restoreResult = await get().restoreArea(existingAreaId);
                if (!restoreResult.success) {
                    set({ error: 'Failed to restore area' });
                    return null;
                }
            }
            const restoredArea = get()._allAreas.find((area) => area.id === existingAreaId);
            const shouldUpdateExistingArea = Boolean(
                (initialProps && Object.keys(initialProps).length > 0)
                || (shouldRestoreDeletedArea && restoredArea?.name !== trimmedName)
            );
            if (shouldUpdateExistingArea) {
                const result = await get().updateArea(existingAreaId, {
                    ...(initialProps ?? {}),
                    ...(shouldRestoreDeletedArea ? { deletedAt: undefined, name: trimmedName } : {}),
                });
                if (!result.success) {
                    set({ error: 'Failed to update area' });
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
        return createdArea;
    },

    updateArea: async (id: string, updates: Partial<Area>) => {
        const changeAt = Date.now();
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
                    const deletedArea: Area = {
                        ...area,
                        deletedAt: now,
                        updatedAt: now,
                        rev: nextRevision(area.rev),
                        revBy: deviceState.deviceId,
                    };
                    const mergedArea: Area = {
                        ...existing,
                        ...updates,
                        name: trimmedName,
                        updatedAt: now,
                        rev: nextRevision(existing.rev),
                        revBy: deviceState.deviceId,
                    };
                    const newAllAreas = allAreas
                        .filter((a) => a.id !== id && a.id !== existing.id)
                        .concat(deletedArea, mergedArea)
                        .sort((a, b) => a.order - b.order);
                    const newAllProjects = state._allProjects.map((project) => {
                        if (project.areaId !== id) return project;
                        return {
                            ...project,
                            areaId: existing.id,
                            areaTitle: mergedArea.name,
                            color: mergedArea.color ?? project.color,
                            updatedAt: now,
                            rev: nextRevision(project.rev),
                            revBy: deviceState.deviceId,
                        };
                    });
                    const newAllTasks = state._allTasks.map((task) => {
                        if (task.areaId !== id) return task;
                        return {
                            ...task,
                            areaId: task.projectId ? undefined : existing.id,
                            updatedAt: now,
                            rev: nextRevision(task.rev),
                            revBy: deviceState.deviceId,
                        };
                    });
                    clearDerivedCache();
                    persist(set, debouncedSave, state, {
                        tasks: newAllTasks,
                        areas: newAllAreas,
                        projects: newAllProjects,
                        ...(deviceState.updated ? { settings: deviceState.settings } : {}),
                    });
                    return {
                        _allAreas: newAllAreas,
                        _allProjects: newAllProjects,
                        _allTasks: newAllTasks,
                        lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                        ...(deviceState.updated ? { settings: deviceState.settings } : {}),
                    };
                }
            }
            const now = new Date().toISOString();
            const nextOrder = Number.isFinite(updates.order) ? (updates.order as number) : area.order;
            const nextName = updates.name !== undefined ? updates.name.trim() : area.name;
            let projectsChanged = false;
            let newAllProjects = state._allProjects;
            // Project.color is required, so clearing the area color repaints its
            // projects back to the neutral default rather than leaving them stuck
            // on the color the area just lost. `areaTitle` is the denormalized
            // copy of the area name: leaving it stale would make the next sync
            // merge repair every child project (sync-normalization.ts).
            const repaintColor = 'color' in updates;
            const nextAreaColor = updates.color ?? DEFAULT_PROJECT_COLOR;
            const nextAreaTitle = nextName.trim() || undefined;
            if (repaintColor || nextAreaTitle !== area.name?.trim()) {
                newAllProjects = state._allProjects.map((project) => {
                    if (project.areaId !== id) return project;
                    const wantsColor = repaintColor && project.color !== nextAreaColor;
                    const wantsTitle = project.areaTitle !== nextAreaTitle;
                    if (!wantsColor && !wantsTitle) return project;
                    projectsChanged = true;
                    return {
                        ...project,
                        ...(wantsColor ? { color: nextAreaColor } : {}),
                        ...(wantsTitle ? { areaTitle: nextAreaTitle } : {}),
                        updatedAt: now,
                        rev: nextRevision(project.rev),
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
                        rev: nextRevision(a.rev),
                        revBy: deviceState.deviceId,
                    }
                    : a))
                .sort((a, b) => a.order - b.order);
            persist(set, debouncedSave, state, {
                areas: newAllAreas,
                ...(projectsChanged ? { projects: newAllProjects } : {}),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allAreas: newAllAreas,
                ...(projectsChanged ? { _allProjects: newAllProjects } : {}),
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
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
        return actionOk();
    },

    deleteArea: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
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
                            rev: nextRevision(item.rev),
                            revBy: deviceState.deviceId,
                        }
                        : item
                )
                .sort((a, b) => a.order - b.order);
            const newAllProjects = state._allProjects.map((project) => {
                if (project.areaId !== id || project.deletedAt) return project;
                return {
                    ...project,
                    areaId: undefined,
                    areaTitle: undefined,
                    updatedAt: now,
                    rev: nextRevision(project.rev),
                    revBy: deviceState.deviceId,
                };
            });
            const newAllTasks = state._allTasks.map((task) => {
                // Trashed tasks are detached too: the sync merge clears a link to a
                // non-live area on every device, and restoreArea never re-links
                // children, so keeping it here only made the next sync repair it.
                if (task.areaId !== id) return task;
                return {
                    ...task,
                    areaId: undefined,
                    updatedAt: now,
                    rev: nextRevision(task.rev),
                    revBy: deviceState.deviceId,
                };
            });
            clearDerivedCache();
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                projects: newAllProjects,
                areas: newAllAreas,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allAreas: newAllAreas,
                _allProjects: newAllProjects,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
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
        return actionOk();
    },

    restoreArea: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
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
            // deleteArea DETACHES children (clears areaId, keeps them live), so
            // under the current model nothing below ever matches this timestamp.
            // The cascade-restore sweep exists only for data written by old app
            // versions whose area delete cascaded deletedAt onto children — do
            // not read it as the current delete model (see P2: detach, never
            // cascade).
            const cascadeDeletedAt = area.deletedAt;
            const newAllAreas = state._allAreas
                .map((item) => (
                    item.id === id
                        ? {
                            ...item,
                            deletedAt: undefined,
                            updatedAt: now,
                            rev: nextRevision(item.rev),
                            revBy: deviceState.deviceId,
                        }
                        : item
                ))
                .sort((a, b) => a.order - b.order);
            const restoredArea = newAllAreas.find((item) => item.id === id);
            const newAllProjects = state._allProjects.map((project) => (
                project.areaId === id && project.deletedAt === cascadeDeletedAt
                    ? {
                        ...project,
                        deletedAt: undefined,
                        areaTitle: typeof project.areaTitle === 'string' && project.areaTitle.trim().length > 0
                            ? project.areaTitle
                            : restoredArea?.name,
                        updatedAt: now,
                        rev: nextRevision(project.rev),
                        revBy: deviceState.deviceId,
                    }
                    : project
            ));
            const restoredProjectIds = new Set(
                newAllProjects
                    .filter((project) => project.areaId === id && !project.deletedAt)
                    .map((project) => project.id)
            );
            const newAllSections = state._allSections.map((section) => (
                restoredProjectIds.has(section.projectId) && section.deletedAt === cascadeDeletedAt
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
                    .filter((section) => restoredProjectIds.has(section.projectId) && !section.deletedAt)
                    .map((section) => section.id)
            );
            const newAllTasks = state._allTasks.map((task) => {
                const belongsToRestoredArea = task.areaId === id || (task.projectId && restoredProjectIds.has(task.projectId));
                if (!belongsToRestoredArea || task.deletedAt !== cascadeDeletedAt) return task;
                return {
                    ...task,
                    deletedAt: undefined,
                    purgedAt: undefined,
                    sectionId: task.sectionId && restoredSectionIds.has(task.sectionId)
                        ? task.sectionId
                        : undefined,
                    updatedAt: now,
                    rev: nextRevision(task.rev),
                    revBy: deviceState.deviceId,
                };
            });
            clearDerivedCache();
            persist(set, debouncedSave, state, {
                areas: newAllAreas,
                projects: newAllProjects,
                sections: newAllSections,
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allAreas: newAllAreas,
                _allProjects: newAllProjects,
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        return missingArea ? actionFail('Area not found') : actionOk();
    },

    reorderAreas: async (orderedIds: string[]) => {
        if (orderedIds.length === 0) return;
        const orderById = new Map<string, number>();
        await mutateEntities({ set, debouncedSave }, {
            collection: 'areas',
            select: (state) => {
                const activeAreas = state._allAreas.filter((area) => !area.deletedAt);
                const areaById = new Map(activeAreas.map((area) => [area.id, area]));
                const seen = new Set<string>();
                const reordered: Area[] = [];
                orderedIds.forEach((id, index) => {
                    const area = areaById.get(id);
                    if (!area) return;
                    seen.add(id);
                    orderById.set(id, index);
                    reordered.push(area);
                });
                const remaining = activeAreas
                    .filter((area) => !seen.has(area.id))
                    .sort((a, b) => a.order - b.order);
                remaining.forEach((area, index) => {
                    orderById.set(area.id, reordered.length + index);
                });
                return [...reordered, ...remaining];
            },
            buildUpdates: (area, { now }) => ({
                order: orderById.get(area.id) ?? area.order,
                updatedAt: now,
            }),
        });
    },
});
