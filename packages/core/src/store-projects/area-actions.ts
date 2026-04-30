import { buildSaveSnapshot, ensureDeviceId, normalizeRevision, selectVisibleTasks } from '../store-helpers';
import { logWarn } from '../logger';
import { clearDerivedCache } from '../store-settings';
import { generateUUID as uuidv4 } from '../uuid';
import type { Area, AreaActions, ProjectActionContext } from './shared';
import { actionFail, actionOk } from './shared';

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
        let snapshot = null;
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
        let snapshot = null;
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
        let snapshot = null;
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
        let snapshot = null;
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
        let snapshot = null;
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
});
