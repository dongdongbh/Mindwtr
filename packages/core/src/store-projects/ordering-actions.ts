import { getTaskOrder, getNextDataChangeAt, nextRevision, persist } from '../store-helpers';
import { getProjectSectionsForView } from '../project-utils';
import { sameSectionDeleteJson, sameSectionSqliteRow, sameTaskSqliteRow } from './section-actions';
import { sameProjectSqliteRow } from './project-actions';
import type { PreparedProjectSectionOrder, PreparedProjectTaskOrder, PreparedTaskEditResult } from '../store-types';
import { planProjectTaskOrderMove, projectTaskOrderToken, type ProjectReorderFlatItem } from '../project-task-reorder';
import { compareProjectsByOrder, compareTasksByProjectOrder, sortTasksByBoardOrder } from '../task-utils';
import { mutateTasks } from '../store-tasks';
import { logInfo } from '../logger';
import type { OrderingActions, Project, ProjectActionContext, Section, Task, TaskStatus } from './shared';
import { mutateEntities } from './shared';

const ORDER_STEP = 1024;

type SparseOrderPlan =
    | { kind: 'single'; id: string; order: number }
    | { kind: 'rebalance'; orderById: Map<string, number> };

const finiteOrder = (value: number | null | undefined): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const sameOrder = (left: string[], right: string[]): boolean => (
    left.length === right.length && left.every((id, index) => id === right[index])
);

const uniqueValidIds = (orderedIds: string[], validIds: Set<string>): string[] => {
    const seen = new Set<string>();
    return orderedIds.filter((id) => {
        if (!validIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
    });
};

const finalOrderedIds = (currentIds: string[], orderedIds: string[]): string[] => {
    const orderedSet = new Set(orderedIds);
    return [...orderedIds, ...currentIds.filter((id) => !orderedSet.has(id))];
};

const boardOrderedIds = (currentIds: string[], shownIds: string[], movedTaskId?: string): string[] => {
    const shown = new Set(shownIds);
    const currentShown = currentIds.filter((id) => shown.has(id));
    if (sameOrder(currentShown, shownIds)) return currentIds;
    const moved = movedTaskId && shown.has(movedTaskId) ? movedTaskId : findSingleMovedId(currentShown, shownIds);
    if (moved) {
        const remaining = currentIds.filter((id) => id !== moved);
        const shownWithoutMoved = shownIds.filter((id) => id !== moved);
        const at = shownIds.indexOf(moved);
        const next = shownWithoutMoved[at];
        const previous = shownWithoutMoved[at - 1];
        const insert = previous ? remaining.indexOf(previous) + 1 : next ? remaining.indexOf(next) : remaining.length;
        remaining.splice(insert, 0, moved);
        return remaining;
    }
    let index = 0;
    return currentIds.map((id) => shown.has(id) ? shownIds[index++] : id);
};

const findSingleMovedId = (currentIds: string[], nextIds: string[]): string | null => {
    if (currentIds.length !== nextIds.length || sameOrder(currentIds, nextIds)) return null;
    if (new Set(currentIds).size !== currentIds.length || new Set(nextIds).size !== nextIds.length) return null;

    const changedIds = new Set<string>();
    nextIds.forEach((id, index) => {
        if (currentIds[index] !== id) {
            changedIds.add(id);
            const currentId = currentIds[index];
            if (currentId) changedIds.add(currentId);
        }
    });

    for (const id of changedIds) {
        const fromIndex = currentIds.indexOf(id);
        const toIndex = nextIds.indexOf(id);
        if (fromIndex === -1 || toIndex === -1) continue;
        const candidate = currentIds.slice();
        candidate.splice(fromIndex, 1);
        candidate.splice(toIndex, 0, id);
        if (sameOrder(candidate, nextIds)) return id;
    }
    return null;
};

const sparseOrderForMove = (
    nextIds: string[],
    movedId: string,
    orderById: Map<string, number | undefined>,
): number | null => {
    const index = nextIds.indexOf(movedId);
    if (index === -1) return null;

    const previousId = nextIds[index - 1];
    const nextId = nextIds[index + 1];
    const previousOrder = previousId ? finiteOrder(orderById.get(previousId)) : undefined;
    const nextOrder = nextId ? finiteOrder(orderById.get(nextId)) : undefined;

    // Orders must stay integers: fractional midpoints don't survive integer-typed
    // storage layers (desktop SQLite bound orderNum as i64, CloudKit stores INT64),
    // where they degrade to NULL/truncation and the task jumps after a sync (#784).
    if (!previousId && !nextId) return finiteOrder(orderById.get(movedId)) ?? 0;
    if (!previousId) return nextOrder === undefined ? 0 : Math.floor(nextOrder) - ORDER_STEP;
    if (previousOrder === undefined) return null;
    if (!nextId) return Math.floor(previousOrder) + ORDER_STEP;
    if (nextOrder === undefined) return Math.floor(previousOrder) + ORDER_STEP;
    const midpoint = Math.floor((previousOrder + nextOrder) / 2);
    if (midpoint <= previousOrder || midpoint >= nextOrder) return null;
    return midpoint;
};

const createSparseOrderPlan = (
    currentIds: string[],
    nextIds: string[],
    orderById: Map<string, number | undefined>,
    movedTaskId?: string,
): SparseOrderPlan | null => {
    if (sameOrder(currentIds, nextIds)) return null;

    const movedId = movedTaskId && currentIds.includes(movedTaskId) && nextIds.includes(movedTaskId)
        && sameOrder(currentIds.filter((id) => id !== movedTaskId), nextIds.filter((id) => id !== movedTaskId))
        ? movedTaskId : findSingleMovedId(currentIds, nextIds);
    if (movedId) {
        const order = sparseOrderForMove(nextIds, movedId, orderById);
        if (order !== null && Number.isFinite(order)) {
            return { kind: 'single', id: movedId, order };
        }
    }

    const rebalanceOrderById = new Map<string, number>();
    nextIds.forEach((id, index) => {
        rebalanceOrderById.set(id, index * ORDER_STEP);
    });
    return { kind: 'rebalance', orderById: rebalanceOrderById };
};

const orderFromPlan = (plan: SparseOrderPlan, id: string): number | undefined => (
    plan.kind === 'single' ? (plan.id === id ? plan.order : undefined) : plan.orderById.get(id)
);

/** RN Board merge and sparse/rebalance calculation, shared by prepared native writes. */
export const boardTaskOrderUpdates = (columnTasks: readonly Task[], orderedIds: string[], movedTaskId?: string): Map<string, number> => {
    const validOrderedIds = uniqueValidIds(orderedIds, new Set(columnTasks.map((task) => task.id)));
    if (!validOrderedIds.length) return new Map();
    const currentIds = sortTasksByBoardOrder([...columnTasks]).map((task) => task.id);
    const nextIds = boardOrderedIds(currentIds, validOrderedIds, movedTaskId);
    const orderById = new Map(columnTasks.map((task) => [task.id, finiteOrder(task.boardOrder)]));
    const plan = createSparseOrderPlan(currentIds, nextIds, orderById);
    const updates = new Map<string, number>();
    if (plan) for (const task of columnTasks) {
        const nextOrder = orderFromPlan(plan, task.id);
        if (Number.isFinite(nextOrder) && task.boardOrder !== nextOrder) updates.set(task.id, nextOrder!);
    }
    return updates;
};

/** The same sparse task-order calculation used by RN and prepared native moves. */
export const projectTaskOrderUpdates = (tasks: readonly Task[], orderedIds: string[], movedTaskId?: string): Map<string, number> => {
    const validOrderedIds = uniqueValidIds(orderedIds, new Set(tasks.map((task) => task.id)));
    if (validOrderedIds.length === 0) return new Map();
    const sorted = [...tasks].sort(compareTasksByProjectOrder);
    const currentIds = sorted.map((task) => task.id);
    const nextIds = boardOrderedIds(currentIds, validOrderedIds, movedTaskId);
    const orderById = new Map(tasks.map((task) => [task.id, getTaskOrder(task)]));
    const plan = createSparseOrderPlan(currentIds, nextIds, orderById, movedTaskId);
    const updates = new Map<string, number>();
    if (plan) for (const task of tasks) {
        const nextOrder = orderFromPlan(plan, task.id);
        if (Number.isFinite(nextOrder)
            && !(getTaskOrder(task) === nextOrder && task.order === nextOrder && task.orderNum === nextOrder)) {
            updates.set(task.id, nextOrder!);
        }
    }
    return updates;
};

/** The same sparse Section plan used by RN and native prepared writes. */
export const projectSectionOrderUpdates = (sections: readonly Section[], orderedIds: string[]): Map<string, number> => {
    const sorted = [...sections].sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
        const bOrder = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
    });
    const currentIds = sorted.map((section) => section.id);
    const validIds = uniqueValidIds(orderedIds, new Set(currentIds));
    if (validIds.length === 0) return new Map();
    const nextIds = finalOrderedIds(currentIds, validIds);
    const orderById = new Map(sorted.map((section) => [section.id, finiteOrder(section.order)]));
    const plan = createSparseOrderPlan(currentIds, nextIds, orderById);
    const updates = new Map<string, number>();
    if (plan) for (const section of sorted) {
        const nextOrder = orderFromPlan(plan, section.id);
        if (Number.isFinite(nextOrder) && section.order !== nextOrder) updates.set(section.id, nextOrder!);
    }
    return updates;
};

export const projectSectionOrderEffect = (sections: readonly Section[], orderedIds: string[],
    deviceId: string, now: string): PreparedProjectSectionOrder['effect'] => {
    const updates = projectSectionOrderUpdates(sections, orderedIds);
    return { sections: sections.filter((row) => updates.has(row.id)).map((before) => ({
        before, after: { ...before, order: updates.get(before.id)!, updatedAt: now,
            rev: nextRevision(before.rev), revBy: deviceId },
    })) };
};

/** Apply RN's drop destination and sparse order plan in one task-row effect. */
export const projectTaskOrderEffect = (scope: PreparedProjectTaskOrder['scope'],
    request: PreparedProjectTaskOrder['request'], deviceId: string, now: string):
    { effect: PreparedProjectTaskOrder['effect']; result: PreparedProjectTaskOrder['result'] } | null => {
    const byId = new Map(scope.tasks.map((task) => [task.id, task]));
    const flat: ProjectReorderFlatItem<Task>[] = [];
    for (const item of scope.items) {
        if (item.type === 'task') {
            const task = byId.get(item.id);
            if (!task) return null;
            flat.push({ type: 'task', key: `task:${task.id}`, task });
        } else {
            flat.push({ type: 'header', key: `section:${item.id}`,
                group: { id: item.id, sectionId: item.sectionId, title: item.id, tasks: [] } });
        }
    }
    const plan = planProjectTaskOrderMove(flat, request.taskId, request.after);
    if (!plan) return null;
    const moved = byId.get(request.taskId)!;
    const sectionIds = new Set(scope.sections.map((row) => row.id));
    const bucket = (task: Task) => task.sectionId && sectionIds.has(task.sectionId) ? task.sectionId : null;
    const movedSectionId = plan.drop.sectionId;
    const sectionChanged = (moved.sectionId ?? null) !== movedSectionId;
    const orderedTasks = scope.tasks.filter((task) => task.id === moved.id || bucket(task) === movedSectionId)
        .map((task) => task.id === moved.id && sectionChanged
            ? { ...task, sectionId: movedSectionId ?? undefined } : task);
    const updates = projectTaskOrderUpdates(orderedTasks, plan.drop.orderedIds, request.taskId);
    const effect: PreparedProjectTaskOrder['effect'] = { tasks: scope.tasks.flatMap((before) => {
        const order = updates.get(before.id);
        if (order === undefined && !(before.id === moved.id && sectionChanged)) return [];
        const after: Task = { ...before,
            ...(before.id === moved.id && sectionChanged ? { sectionId: movedSectionId ?? undefined } : {}),
            ...(order !== undefined ? { order, orderNum: order } : {}),
            updatedAt: now, rev: nextRevision(before.rev), revBy: deviceId };
        return [{ before, after }];
    }) };
    return { effect, result: { projectId: request.projectId, taskId: request.taskId, sectionId: movedSectionId } };
};

export const createOrderingActions = ({
    set,
    debouncedSave,
}: ProjectActionContext): OrderingActions => ({
    commitPreparedProjectTaskOrder: async (input: PreparedProjectTaskOrder): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project task order conflicts with current data' };
        set((state) => {
            const pairs = input.effect.tasks;
            const affectedIds = new Set(pairs.map(({ after }) => after.id));
            const allById = new Map<string, Task>();
            const duplicateIds = new Set<string>();
            for (const row of state._allTasks) {
                if (allById.has(row.id)) duplicateIds.add(row.id);
                allById.set(row.id, row);
            }
            if (pairs.length > 0 && affectedIds.size === pairs.length
                && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && pairs.every(({ after }) => {
                    const current = allById.get(after.id);
                    return current && !duplicateIds.has(after.id)
                        && sameTaskSqliteRow(current, after) && sameSectionDeleteJson(current, after);
                })) {
                result = { success: true, id: input.request.taskId, outcome: 'replayed' };
                return state;
            }
            const parent = state._projectsById.get(input.request.projectId);
            if (!parent || parent.deletedAt || parent.purgedAt || parent.status === 'archived'
                || !sameProjectSqliteRow(parent, input.scope.project)
                || !sameSectionDeleteJson(parent, input.scope.project)
                || !sameSectionDeleteJson(state.settings, input.scope.settings)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null))
                return state;
            const sections = getProjectSectionsForView(parent,
                state._allSections.filter((row) => !row.deletedAt), state._allSections);
            const duplicateSections = new Set<string>();
            const seenSections = new Set<string>();
            for (const row of state._allSections) {
                if (seenSections.has(row.id)) duplicateSections.add(row.id);
                seenSections.add(row.id);
            }
            if (sections.length !== input.scope.sections.length || sections.some((row, index) =>
                duplicateSections.has(row.id) || !sameSectionDeleteJson(row, input.scope.sections[index])
                || !sameSectionSqliteRow(row, input.scope.sections[index]))) return state;
            const tasks = state._allTasks.filter((row) => row.projectId === parent.id && !row.deletedAt)
                .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            if (tasks.length !== input.scope.tasks.length || tasks.some((row, index) =>
                duplicateIds.has(row.id) || !sameSectionDeleteJson(row, input.scope.tasks[index])
                || !sameTaskSqliteRow(row, input.scope.tasks[index]))) return state;
            const planned = projectTaskOrderEffect(input.scope, input.request,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.preparedAt);
            if (!planned || !sameSectionDeleteJson(planned.effect, input.effect) || pairs.length === 0
                || projectTaskOrderToken({ project: parent, sections, tasks,
                    sortBy: 'default', items: input.scope.items }) !== input.request.expectedOrder) return state;
            const replacements = new Map(planned.effect.tasks.map(({ after }) => [after.id, after]));
            const allTasks = state._allTasks.map((row) => replacements.get(row.id) ?? row);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { tasks: allTasks,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: input.request.taskId, outcome: 'applied' };
            return { _allTasks: allTasks, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },
    commitPreparedProjectSectionOrder: async (input: PreparedProjectSectionOrder): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Section order conflicts with current data' };
        set((state) => {
            const pairs = input.effect.sections;
            const affectedIds = new Set(pairs.map(({ after }) => after.id));
            const allById = new Map<string, Section>();
            const duplicateIds = new Set<string>();
            for (const row of state._allSections) {
                if (allById.has(row.id)) duplicateIds.add(row.id);
                allById.set(row.id, row);
            }
            // A complete affected-row receipt wins before mutable parent and scope checks.
            if (pairs.length > 0 && affectedIds.size === pairs.length
                && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && pairs.every(({ after }) => {
                    const current = allById.get(after.id);
                    return current && !duplicateIds.has(after.id) && sameSectionSqliteRow(current, after);
                })) {
                result = { success: true, id: input.request.projectId, outcome: 'replayed' };
                return state;
            }
            const parent = state._projectsById.get(input.request.projectId);
            if (!parent || parent.deletedAt || parent.purgedAt || parent.status === 'archived'
                || !sameProjectSqliteRow(parent, input.scope.project)
                || !sameSectionDeleteJson(parent, input.scope.project)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null))
                return state;
            const live = getProjectSectionsForView(parent,
                state._allSections.filter((row) => !row.deletedAt), state._allSections);
            if (live.length !== input.scope.sections.length || live.some((row, index) =>
                duplicateIds.has(row.id) || !sameSectionDeleteJson(row, input.scope.sections[index])
                || !sameSectionSqliteRow(row, input.scope.sections[index]))) return state;
            const effect = projectSectionOrderEffect(live, input.result.orderedIds,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.preparedAt);
            if (effect.sections.length === 0 || !sameSectionDeleteJson(effect, input.effect)) return state;
            const replacements = new Map(effect.sections.map(({ after }) => [after.id, after]));
            const sections = state._allSections.map((row) => replacements.get(row.id) ?? row);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { sections,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: input.request.projectId, outcome: 'applied' };
            return { _allSections: sections, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },
    reorderProjects: async (orderedIds: string[], areaId?: string) => {
        if (orderedIds.length === 0) return;
        const targetAreaId = areaId ?? undefined;
        let orderPlan: SparseOrderPlan | null = null;
        await mutateEntities({ set, debouncedSave }, {
            collection: 'projects',
            select: (state) => {
                const isInArea = (project: Project) => (
                    (project.areaId ?? undefined) === targetAreaId && !project.deletedAt
                );
                const areaProjects = state._allProjects.filter(isInArea);
                const currentIds = areaProjects
                    .sort(compareProjectsByOrder)
                    .map((project) => project.id);
                const validOrderedIds = uniqueValidIds(orderedIds, new Set(currentIds));
                if (validOrderedIds.length === 0) return [];
                const nextIds = finalOrderedIds(currentIds, validOrderedIds);
                const orderById = new Map(areaProjects.map((project) => [project.id, finiteOrder(project.order)]));
                orderPlan = createSparseOrderPlan(currentIds, nextIds, orderById);
                if (!orderPlan) return [];
                return areaProjects.filter((project) => {
                    const nextOrder = orderFromPlan(orderPlan!, project.id);
                    return Number.isFinite(nextOrder) && project.order !== nextOrder;
                });
            },
            buildUpdates: (project) => {
                const nextOrder = orderFromPlan(orderPlan!, project.id);
                return Number.isFinite(nextOrder) ? { order: nextOrder as number } : null;
            },
        });
    },

    reorderSections: async (projectId: string, orderedIds: string[]) => {
        if (!projectId || orderedIds.length === 0) return;
        let updates = new Map<string, number>();
        await mutateEntities({ set, debouncedSave }, {
            collection: 'sections',
            select: (state) => {
                if (!state._allProjects.some((project) => project.id === projectId && !project.deletedAt)) return [];
                const isInProject = (section: Section) => section.projectId === projectId && !section.deletedAt;
                const projectSections = state._allSections.filter(isInProject);
                updates = projectSectionOrderUpdates(projectSections, orderedIds);
                return projectSections.filter((section) => updates.has(section.id));
            },
            buildUpdates: (section) => {
                const nextOrder = updates.get(section.id);
                return nextOrder !== undefined ? { order: nextOrder } : null;
            },
        });
    },

    reorderProjectTasks: async (projectId: string, orderedIds: string[], sectionId?: string | null, movedTaskId?: string) => {
        if (!projectId || orderedIds.length === 0) return;
        let updates = new Map<string, number>();
        let changedCount = 0;
        await mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const hasSectionFilter = sectionId !== undefined;
                const isInProject = (task: Task) => {
                    if (task.projectId !== projectId || task.deletedAt) return false;
                    if (!hasSectionFilter) return true;
                    return sectionId ? task.sectionId === sectionId : !task.sectionId;
                };
                const projectTasks = state._allTasks.filter(isInProject);
                updates = projectTaskOrderUpdates(projectTasks, orderedIds, movedTaskId);
                const changed = projectTasks.filter((task) => updates.has(task.id));
                changedCount = changed.length;
                return changed;
            },
            buildUpdates: (task) => {
                const nextOrder = updates.get(task.id);
                return {
                    order: nextOrder!,
                    orderNum: nextOrder!,
                };
            },
        });
        if (changedCount > 0) logInfo('Project task order applied', {
            scope: 'store', category: 'storage',
            context: { releaseCheck: 'v1.3.3/project-filtered-task-order', count: changedCount },
        });
    },

    reorderBoardTasks: async (status: TaskStatus, orderedIds: string[], movedTaskId?: string) => {
        if (!status || orderedIds.length === 0) return;
        let updates = new Map<string, number>();
        await mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const columnTasks = state._allTasks.filter((task) => task.status === status && !task.deletedAt);
                updates = boardTaskOrderUpdates(columnTasks, orderedIds, movedTaskId);
                return columnTasks.filter((task) => updates.has(task.id));
            },
            buildUpdates: (task) => ({ boardOrder: updates.get(task.id)! }),
        });
    },
});
