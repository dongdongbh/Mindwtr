import { buildSaveSnapshot, ensureDeviceId, normalizeRevision, selectVisibleTasks } from '../store-helpers';
import { logWarn } from '../logger';
import { generateUUID as uuidv4 } from '../uuid';
import type { ProjectActionContext, Section, SectionActions } from './shared';
import { actionFail, actionOk } from './shared';

export const createSectionActions = ({
    set,
    debouncedSave,
}: ProjectActionContext): SectionActions => ({
    addSection: async (projectId: string, title: string, initialProps?: Partial<Section>) => {
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!projectId || !trimmedTitle) return null;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
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
        let snapshot = null;
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
        let snapshot = null;
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
});
