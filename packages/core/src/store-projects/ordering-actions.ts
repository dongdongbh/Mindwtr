import { buildSaveSnapshot, ensureDeviceId, getTaskOrder, normalizeRevision, selectVisibleTasks } from '../store-helpers';
import type { OrderingActions, Project, ProjectActionContext, Task } from './shared';

export const createOrderingActions = ({
    set,
    debouncedSave,
}: ProjectActionContext): OrderingActions => ({
    reorderProjects: async (orderedIds: string[], areaId?: string) => {
        if (orderedIds.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const targetAreaId = areaId ?? undefined;
        let snapshot = null;
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
        let snapshot = null;
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
});
