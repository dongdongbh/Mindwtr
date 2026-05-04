import { buildSaveSnapshot, ensureDeviceId, getNextDataChangeAt, normalizeRevision, normalizeTagId, selectVisibleTasks } from '../store-helpers';
import type { ProjectActionContext, TaxonomyActions } from './shared';
import { dedupeTagValuesLastWins, formatTagIdPreservingCase } from './shared';

export const createTaxonomyActions = ({
    set,
    debouncedSave,
}: ProjectActionContext): TaxonomyActions => ({
    deleteTag: async (tagId: string) => {
        const normalizedTarget = normalizeTagId(tagId);
        if (!normalizedTarget) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
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
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
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
        const nextTagId = formatTagIdPreservingCase(newTagId);
        if (!normalizedOld || !normalizedNew || !nextTagId) return;
        if (normalizedOld === normalizedNew && formatTagIdPreservingCase(oldTagId) === nextTagId) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const newAllTasks = state._allTasks.map((task) => {
                if (!task.tags || task.tags.length === 0) return task;
                const idx = task.tags.findIndex((tag) => normalizeTagId(tag) === normalizedOld);
                if (idx === -1) return task;
                const newTags = [...task.tags];
                newTags[idx] = nextTagId;
                return {
                    ...task,
                    tags: dedupeTagValuesLastWins(newTags, nextTagId),
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
                newTagIds[idx] = nextTagId;
                return {
                    ...project,
                    tagIds: dedupeTagValuesLastWins(newTagIds, nextTagId),
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
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
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
        let snapshot = null;
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
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
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
        if (!normalizedOld || !normalizedNew) return;
        if (normalizedOld === normalizedNew.toLowerCase() && oldContext.trim() === normalizedNew) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const newAllTasks = state._allTasks.map((task) => {
                if (!task.contexts || task.contexts.length === 0) return task;
                const idx = task.contexts.findIndex((ctx) => ctx.trim().toLowerCase() === normalizedOld);
                if (idx === -1) return task;
                const newContexts = [...task.contexts];
                newContexts[idx] = normalizedNew;
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
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },
});
