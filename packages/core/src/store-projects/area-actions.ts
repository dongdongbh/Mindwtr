import { DEFAULT_PROJECT_COLOR } from '../color-constants';
import { ensureDeviceId, getNextDataChangeAt, nextRevision, persist, replaceEntitiesInArray } from '../store-helpers';
import { areaOrderIdsForIntent, sortAreasForOrderDisplay } from '../area-ordering';
import { countLiveProjectsByArea } from '../area-project-usage';
import { areaRenameEffect, planAreaColorChange, planAreaEditorSave, planAreaRename, sameAreaAdditionRow, selectAreaRenameScope } from '../area-rename';
import { logInfo, logWarn } from '../logger';
import { clearDerivedCache } from '../store-settings';
import { generateUUID as uuidv4 } from '../uuid';
import { taskEditValuesEqual } from '../json-value-equality';
import { normalizeTaskForLoad } from '../task-status';
import { normalizeProjectLifecycleFields } from '../project-status';
import { getPersistenceStatus, getStorageAdapter } from '../store';
import { referenceBatchModules } from '../store-reference-batch-modules';
import { rawReadTaskSnapshot, rawReadProjectSnapshot, rawReadAreaSnapshot } from '../sqlite-raw-snapshot';
import type { AppData } from '../types';
import type { PreparedAreaAuthority, TaskStore, PreparedAreaColor, PreparedAreaCreate, PreparedAreaDelete, PreparedAreaOrder, PreparedTaskEditResult } from '../store-types';
import type { Area, AreaActions, Project, ProjectActionContext, Section, Task } from './shared';
import { actionFail, actionOk, mutateEntities } from './shared';

export type AreaAdditionRows = { areas: Area[]; projects: Project[]; sections: Section[]; tasks: Task[] };

/** The existing deleteArea detach policy, including trashed directly linked Tasks. */
export function planAreaDeletion(area: Area, projects: Project[], tasks: Task[], deviceId: string, now: string, version: 1 | 2 = 2):
    { area: Area; projects: Project[]; tasks: Task[] } {
    return {
        area: { ...area, deletedAt: now, updatedAt: now,
            rev: nextRevision(area.rev), revBy: deviceId },
        projects: projects.map((project) => project.areaId === area.id && !project.deletedAt
            ? { ...project, areaId: undefined, areaTitle: undefined,
                ...(version === 2 ? { color: project.colorOverride ?? DEFAULT_PROJECT_COLOR } : {}), updatedAt: now,
                rev: nextRevision(project.rev), revBy: deviceId } : project),
        tasks: tasks.map((task) => task.areaId === area.id
            ? { ...task, areaId: undefined, updatedAt: now,
                rev: nextRevision(task.rev), revBy: deviceId } : task),
    };
}

export function selectAreaDeleteScope(areas: Area[], projects: Project[], tasks: Task[], areaId: string):
    PreparedAreaDelete['scope'] | null {
    const area = areas.find((row) => row.id === areaId);
    return area ? { area, tasks: tasks.filter((task) => task.areaId === areaId),
        liveProjects: projects.filter((project) => project.areaId === areaId && !project.deletedAt) } : null;
}

export function areaDeleteEffect(scope: PreparedAreaDelete['scope'], deviceId: string,
    now: string, detachProjects = false, version: 1 | 2 = 2): PreparedAreaDelete['effect'] {
    const planned = planAreaDeletion(scope.area, detachProjects ? scope.liveProjects : [], scope.tasks, deviceId, now, version);
    return { area: { before: scope.area, after: planned.area },
        tasks: scope.tasks.map((before, index) => ({ before, after: planned.tasks[index] })),
        ...(detachProjects ? { projects: scope.liveProjects.map((before, index) =>
            ({ before, after: planned.projects[index] })) } : {}) };
}

/** Preserve the direct store action's historical partial-ID and unknown-ID behavior. */
export function selectAreaOrderRows(activeAreas: Area[], orderedIds: string[]): Area[] {
    const areaById = new Map(activeAreas.map((area) => [area.id, area]));
    const seen = new Set<string>();
    const reordered: Area[] = [];
    orderedIds.forEach((id) => {
        const area = areaById.get(id);
        if (!area) return;
        seen.add(id);
        reordered.push(area);
    });
    return [...reordered, ...activeAreas.filter((area) => !seen.has(area.id))
        .sort((a, b) => a.order - b.order)];
}

export function areaOrderEffect(areas: Area[], orderedIds: string[], deviceId: string,
    now: string): PreparedAreaOrder['effect'] {
    const orderById = new Map(orderedIds.map((id, index) => [id, index]));
    return { areas: areas.map((before) => ({ before, after: {
        ...before, order: orderById.get(before.id) ?? before.order, updatedAt: now,
        rev: nextRevision(before.rev), revBy: deviceId,
    } })) };
}

export { planAreaColorChange } from '../area-rename';

export function selectAreaColorScope(areas: Area[], projects: Project[], areaId: string): PreparedAreaColor['scope'] | null {
    const area = areas.find((row) => row.id === areaId);
    return area ? { area, projects: projects.filter((row) => row.areaId === areaId) } : null;
}

export function areaColorEffect(scope: PreparedAreaColor['scope'], color: string | undefined,
    deviceId: string, now: string, version: 1 | 2 = 2): PreparedAreaColor['effect'] {
    const planned = planAreaColorChange(scope.area, scope.projects, color, deviceId, now, version);
    return { area: { before: scope.area, after: planned.area },
        projects: scope.projects.flatMap((before, index) => {
            const after = planned.projects[index];
            return taskEditValuesEqual(before, after) ? [] : [{ before, after }];
        }) };
}

/** The final rows of addArea, including restoreArea followed by updateArea for a tombstone. */
export function planAreaAddition(rows: AreaAdditionRows, name: string, props: Partial<Area> | undefined,
    id: string, deviceId: string, restoreAt: string, updateAt: string, version: 1 | 2 = 2):
    { kind: 'live' | 'fresh' | 'restored'; area: Area; rows: AreaAdditionRows } | null {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return null;
    const normalized = trimmed.toLowerCase();
    const matches = (area: Area) => area.name?.trim().toLowerCase() === normalized;
    const live = rows.areas.find((area) => !area.deletedAt && matches(area));
    if (live) return { kind: 'live', area: live, rows };
    const deleted = rows.areas.find((area) => area.deletedAt && matches(area));
    if (!deleted) {
        const maxOrder = rows.areas.reduce((max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1);
        const area: Area = {
            id, name: trimmed, ...props,
            order: Number.isFinite(props?.order) ? props!.order! : maxOrder + 1,
            rev: 1, revBy: deviceId, createdAt: props?.createdAt ?? restoreAt, updatedAt: restoreAt,
        };
        return { kind: 'fresh', area, rows: { ...rows, areas: [...rows.areas, area].sort((a, b) => a.order - b.order) } };
    }

    const cascadeDeletedAt = deleted.deletedAt;
    const restored: Area = { ...deleted, deletedAt: undefined, updatedAt: restoreAt,
        rev: nextRevision(deleted.rev), revBy: deviceId };
    let areas = rows.areas.map((area) => area.id === deleted.id ? restored : area).sort((a, b) => a.order - b.order);
    let projects = rows.projects.map((project) => project.areaId === deleted.id && project.deletedAt === cascadeDeletedAt
        ? { ...project, deletedAt: undefined,
            areaTitle: typeof project.areaTitle === 'string' && project.areaTitle.trim().length > 0
                ? project.areaTitle : restored.name,
            updatedAt: restoreAt, rev: nextRevision(project.rev), revBy: deviceId }
        : project);
    const restoredProjectIds = new Set(projects.filter((project) => project.areaId === deleted.id && !project.deletedAt)
        .map((project) => project.id));
    const sections = rows.sections.map((section) => restoredProjectIds.has(section.projectId) && section.deletedAt === cascadeDeletedAt
        ? { ...section, deletedAt: undefined, updatedAt: restoreAt,
            rev: nextRevision(section.rev), revBy: deviceId }
        : section);
    const restoredSectionIds = new Set(sections.filter((section) => restoredProjectIds.has(section.projectId) && !section.deletedAt)
        .map((section) => section.id));
    const tasks = rows.tasks.map((task) => {
        const belongs = task.areaId === deleted.id || Boolean(task.projectId && restoredProjectIds.has(task.projectId));
        if (!belongs || task.deletedAt !== cascadeDeletedAt) return task;
        return { ...task, deletedAt: undefined, purgedAt: undefined,
            sectionId: task.sectionId && restoredSectionIds.has(task.sectionId) ? task.sectionId : undefined,
            updatedAt: restoreAt, rev: nextRevision(task.rev), revBy: deviceId };
    });

    // A restored Area receives the same second updateArea revision when the
    // caller supplies props or changes the trimmed spelling.
    const update = Boolean(props && Object.keys(props).length > 0) || restored.name !== trimmed;
    let area = restored;
    if (update) {
        const updates = { ...props, deletedAt: undefined, name: trimmed };
        const nextOrder = Number.isFinite(updates.order) ? updates.order! : restored.order;
        const repaintColor = 'color' in updates;
        const color = updates.color ?? DEFAULT_PROJECT_COLOR;
        const title = trimmed || undefined;
        if (repaintColor || title !== restored.name?.trim()) {
            projects = projects.map((project) => {
                if (project.areaId !== deleted.id) return project;
                const wantsColor = repaintColor && (version === 1 || project.colorOverride == null) && project.color !== color;
                const wantsTitle = project.areaTitle !== title;
                return wantsColor || wantsTitle ? { ...project,
                    ...(wantsColor ? { color } : {}), ...(wantsTitle ? { areaTitle: title } : {}),
                    updatedAt: updateAt, rev: nextRevision(project.rev), revBy: deviceId } : project;
            });
        }
        area = { ...restored, ...updates, name: trimmed, order: nextOrder,
            updatedAt: updateAt, rev: nextRevision(restored.rev), revBy: deviceId };
        areas = areas.map((item) => item.id === deleted.id ? area : item).sort((a, b) => a.order - b.order);
    }
    return { kind: 'restored', area, rows: { areas, projects, sections, tasks } };
}

export function selectAreaAdditionScope(rows: AreaAdditionRows, area: Area | null): PreparedAreaCreate['scope'] {
    if (!area) return { area: null, projects: [], sections: [], tasks: [] };
    const projects = rows.projects.filter((project) => project.areaId === area.id);
    const restoredProjectIds = new Set(projects.filter((project) => !project.deletedAt || project.deletedAt === area.deletedAt)
        .map((project) => project.id));
    return {
        area,
        projects,
        sections: rows.sections.filter((section) => restoredProjectIds.has(section.projectId)),
        tasks: rows.tasks.filter((task) => task.areaId === area.id
            || Boolean(task.projectId && restoredProjectIds.has(task.projectId))),
    };
}

export function areaAdditionEffect(scope: PreparedAreaCreate['scope'], planned: AreaAdditionRows, targetId: string): PreparedAreaCreate['effect'] {
    const changed = <T extends { id: string }>(before: T[], after: T[]): Array<{ before: T; after: T }> => {
        const byId = new Map(after.map((row) => [row.id, row]));
        return before.flatMap((row) => {
            const next = byId.get(row.id);
            return next && JSON.stringify(row) !== JSON.stringify(next) ? [{ before: row, after: next }] : [];
        });
    };
    const area = planned.areas.find((row) => row.id === targetId)!;
    return { area: { before: scope.area, after: area },
        projects: changed(scope.projects, planned.projects),
        sections: changed(scope.sections, planned.sections),
        tasks: changed(scope.tasks, planned.tasks) };
}

export { sameAreaAdditionRow } from '../area-rename';

const areaAuthorityMatches = (state: TaskStore, authority: PreparedAreaAuthority) => {
    const before = authority.state;
    return state._allTasks === before._allTasks && state._allAreas === before._allAreas
        && state._allProjects === before._allProjects && state._allSections === before._allSections
        && state._allPeople === before._allPeople && state.settings === before.settings
        && state.lastDataChangeAt === before.lastDataChangeAt;
};
const areaDurableState = (state: TaskStore, data: AppData): TaskStore => ({ ...state,
    _allTasks: data.tasks, _allProjects: data.projects, _allSections: data.sections ?? [],
    _allAreas: data.areas ?? [], _allPeople: data.people ?? [], settings: data.settings });

/** Apply only the Area policy changes to the current Task display projection. */
const areaMemoryTasks = (memory: Task[], durable: Task[], effects: Array<{ before: Task; after: Task }>): Task[] => {
    const existing = new Map(memory.map((row) => [row.id, row]));
    const changes = new Map(effects.map((pair) => [pair.before.id, pair]));
    const fields = ['areaId', 'deletedAt', 'purgedAt', 'sectionId', 'updatedAt', 'rev', 'revBy'] as const;
    return durable.map((row) => {
        const current = existing.get(row.id);
        const pair = changes.get(row.id);
        if (!current) return normalizeTaskForLoad(row);
        if (!pair) return sameAreaAdditionRow.task(current, row) ? current : normalizeTaskForLoad(row);
        const freshBefore = normalizeTaskForLoad(pair.before);
        const projected = { ...(sameAreaAdditionRow.task(current, freshBefore) ? current : freshBefore) };
        for (const field of fields) {
            if (taskEditValuesEqual(pair.before[field], pair.after[field])) continue;
            if (pair.after[field] === undefined) delete projected[field];
            else Object.assign(projected, { [field]: pair.after[field] });
        }
        return projected;
    });
};

export const createAreaActions = ({
    set,
    debouncedSave,
}: ProjectActionContext): AreaActions => {
    const persistPreparedArea = (memory: TaskStore, durable: AppData, next: AppData,
        effects: Array<{ before: Task; after: Task }>, authority: PreparedAreaAuthority): Partial<TaskStore> => {
        persist(set, debouncedSave, areaDurableState(memory, durable), next);
        const taskReference = areaMemoryTasks(memory._allTasks, next.tasks, effects);
        const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
        // Capture the intended write before Zustand notifies synchronous or microtask subscribers.
        authority.saveBoundary = { taskReference, lastDataChangeAt,
            generation: getPersistenceStatus().generation, failure: memory.persistenceFailure };
        return { _allAreas: next.areas ?? [], _allProjects: next.projects.map(normalizeProjectLifecycleFields), _allSections: next.sections ?? [],
            _allPeople: next.people ?? [], _allTasks: taskReference,
            settings: next.settings, lastDataChangeAt };
    };
    return ({
    addArea: async (name: string, initialProps?: Partial<Area>) => {
        if (typeof name !== 'string' || !name.trim()) return null;
        const changeAt = Date.now();
        const restoreAt = new Date().toISOString();
        let area: Area | null = null;
        set((state) => {
            const rows = { areas: state._allAreas, projects: state._allProjects,
                sections: state._allSections, tasks: state._allTasks };
            const live = rows.areas.find((item) => !item.deletedAt
                && item.name?.trim().toLowerCase() === name.trim().toLowerCase());
            if (live) { area = live; return state; }
            const deviceState = ensureDeviceId(state.settings);
            const planned = planAreaAddition(rows, name, initialProps, uuidv4(), deviceState.deviceId,
                restoreAt, new Date().toISOString());
            if (!planned || planned.kind === 'live') { area = planned?.area ?? null; return state; }
            area = planned.area;
            if (planned.kind === 'restored') clearDerivedCache();
            persist(set, debouncedSave, state, {
                areas: planned.rows.areas,
                ...(planned.kind === 'restored' ? { projects: planned.rows.projects,
                    sections: planned.rows.sections, tasks: planned.rows.tasks } : {}),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allAreas: planned.rows.areas,
                ...(planned.kind === 'restored' ? { _allProjects: planned.rows.projects,
                    _allSections: planned.rows.sections, _allTasks: planned.rows.tasks } : {}),
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        return area;
    },

    /** A first raw creation effect only; a completed retry is answered by its typed receipt, never target equality. */
    commitPreparedInboxOrganizeDestinationCreate: async (input, authority): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Inbox destination creation conflicts with saved data' };
        const adapter = getStorageAdapter();
        // Match the existing registered prepared-batch seam and recheck every authority after yielding.
        await Promise.resolve();
        const shared = referenceBatchModules.shared;
        const checks = referenceBatchModules.inboxOrganizeCreate?.(input);
        if (!shared || !checks || getStorageAdapter() !== adapter
            || !(adapter instanceof shared.NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded
            || !checks.validateEnvelope()) return result;
        set(memory => {
            if (!areaAuthorityMatches(memory, authority) || getStorageAdapter() !== adapter) return memory;
            const durable = authority.snapshot;
            try { if (!checks.authorityMatches(durable)) return memory; } catch { return memory; }
            const bind = <T extends { id: string }>(rows: T[], pairs: { before: T | null; after: T }[],
                snapshot: (row: T) => T | null): T[] | null => {
                const current = new Map(rows.map(row => [row.id, row]));
                const updates = new Map<string, T>(); const created: T[] = [];
                for (const pair of pairs) {
                    const id = pair.after.id; const before = current.get(id);
                    if (updates.has(id) || (pair.before === null ? Boolean(before)
                        : !before || pair.before.id !== id || !taskEditValuesEqual(snapshot(before), pair.before))) return null;
                    updates.set(id, pair.after); if (pair.before === null) created.push(pair.after);
                }
                return [...rows.map(row => updates.get(row.id) ?? row), ...created];
            };
            const tasks = bind(durable.tasks, input.effect.tasks, rawReadTaskSnapshot);
            const projects = bind(durable.projects, input.effect.projects, rawReadProjectSnapshot);
            const sections = bind(durable.sections ?? [], input.effect.sections, row => row);
            const areas = bind(durable.areas ?? [], input.effect.areas, rawReadAreaSnapshot);
            if (!tasks || !projects || !sections || !areas) return memory;
            const settings = input.deviceIdToInitialize ? { ...durable.settings, deviceId: input.deviceIdToInitialize } : durable.settings;
            clearDerivedCache();
            result = { success: true, id: input.result.id, outcome: 'applied' };
            return persistPreparedArea(memory, durable, { ...durable, tasks, projects, sections,
                areas: input.request.kind === 'area' ? areas.sort((a, b) => a.order - b.order) : areas, settings },
            input.effect.tasks.flatMap(pair => pair.before ? [{ before: pair.before, after: pair.after }] : []), authority);
        });
        return result;
    },

    commitPreparedAreaCreate: async (input, authority): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared Area conflicts with current data' };
        set((memory) => {
            if (!areaAuthorityMatches(memory, authority)) return memory;
            const durable = authority.snapshot;
            const state = areaDurableState(memory, durable);
            const rows = { areas: state._allAreas, projects: state._allProjects,
                sections: state._allSections, tasks: state._allTasks };
            const { effect, request } = input;
            const target = rows.areas.find((area) => area.id === request.expectedAreaId);
            const after = target && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameAreaAdditionRow.area(target, effect.area.after)
                && effect.projects.every(({ after: row }) => {
                    const current = rows.projects.find((item) => item.id === row.id);
                    return current && sameAreaAdditionRow.project(current, row);
                })
                && effect.sections.every(({ after: row }) => {
                    const current = rows.sections.find((item) => item.id === row.id);
                    return current && sameAreaAdditionRow.section(current, row);
                })
                && effect.tasks.every(({ after: row }) => {
                    const current = rows.tasks.find((item) => item.id === row.id);
                    return current && sameAreaAdditionRow.task(current, row);
                });
            // A complete persisted effect is the receipt, even after mutable inputs changed.
            if (after) { result = { success: true, id: target!.id, outcome: 'replayed' }; return memory; }
            if ((input.kind === 'fresh' && target) || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)) return memory;
            const orderMax = rows.areas.reduce((max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1);
            if (orderMax !== input.orderMax) return memory;
            const selected = input.kind === 'restored' ? rows.areas.find((area) => area.id === request.expectedAreaId) ?? null : null;
            const scope = selectAreaAdditionScope(rows, selected);
            if (!taskEditValuesEqual(scope, input.scope)) return memory;
            const planned = planAreaAddition(rows, request.name, { color: request.color }, request.requestId,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.restoreAt, input.updateAt, input.version ?? 1);
            if (!planned || planned.kind !== input.kind || planned.area.id !== request.expectedAreaId
                || !taskEditValuesEqual(areaAdditionEffect(scope, planned.rows, request.expectedAreaId), effect)) return memory;
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            if (planned.kind === 'restored') clearDerivedCache();
            result = { success: true, id: planned.area.id, outcome: 'applied' };
            return persistPreparedArea(memory, durable, { ...durable, areas: planned.rows.areas,
                projects: planned.rows.projects, sections: planned.rows.sections, tasks: planned.rows.tasks, settings }, effect.tasks, authority);
        });
        return result;
    },

    commitPreparedAreaColor: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared Area color conflicts with current data' };
        set((state) => {
            const { request, scope, effect } = input;
            const target = state._allAreas.find((row) => row.id === request.areaId);
            const completeAfter = target && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameAreaAdditionRow.area(target, effect.area.after)
                && effect.projects.every(({ after }) => {
                    const current = state._allProjects.find((row) => row.id === after.id);
                    return current && sameAreaAdditionRow.project(current, after);
                });
            if (completeAfter) { result = { success: true, id: target.id, outcome: 'replayed' }; return state; }
            if (!target || target.deletedAt || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameAreaAdditionRow.area(target, scope.area)) return state;
            const linked = state._allProjects.filter((row) => row.areaId === request.areaId);
            const beforeProjects = new Map(scope.projects.map((row) => [row.id, row]));
            if (linked.length !== scope.projects.length || linked.some((row) => {
                const before = beforeProjects.get(row.id);
                return !before || !sameAreaAdditionRow.project(row, before);
            })) return state;
            // SQLite defaults can hide omitted fields; derive the write only from live rows.
            const planned = areaColorEffect({ area: target, projects: linked }, request.color ?? undefined,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt, input.version ?? 1);
            if (!taskEditValuesEqual(planned, effect)) return state;
            const nextAreas = state._allAreas.map((row) => row.id === request.areaId ? planned.area.after : row)
                .sort((left, right) => left.order - right.order);
            const changedProjects = new Map(planned.projects.map(({ after }) => [after.id, after]));
            const nextProjects = effect.projects.length ? state._allProjects.map((row) =>
                changedProjects.get(row.id) ?? row) : state._allProjects;
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { areas: nextAreas,
                ...(effect.projects.length ? { projects: nextProjects } : {}),
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: request.areaId, outcome: 'applied' };
            return { _allAreas: nextAreas,
                ...(effect.projects.length ? { _allProjects: nextProjects } : {}),
                settings, lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedAreaRename: async (input, authority): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Area rename conflicts with current data' };
        set((memory) => {
            if (!areaAuthorityMatches(memory, authority)) return memory;
            const durable = authority.snapshot;
            const state = areaDurableState(memory, durable);
            const { effect, request, scope } = input;
            const areasById = new Map(state._allAreas.map((row) => [row.id, row]));
            const projectsById = new Map(state._allProjects.map((row) => [row.id, row]));
            const tasksById = new Map(state._allTasks.map((row) => [row.id, row]));
            const completeAfter = effect.areas.length > 0 && (!input.deviceIdToInitialize
                || state.settings.deviceId === input.deviceIdToInitialize)
                && effect.areas.every(({ after }) => {
                    const current = areasById.get(after.id);
                    return current && sameAreaAdditionRow.area(current, after);
                })
                && effect.projects.every(({ after }) => {
                    const current = projectsById.get(after.id);
                    return current && sameAreaAdditionRow.project(current, after);
                })
                && effect.tasks.every(({ after }) => {
                    const current = tasksById.get(after.id);
                    return current && sameAreaAdditionRow.task(current, after);
                });
            if (completeAfter) {
                result = { success: true, id: request.areaId, outcome: 'replayed' };
                return memory;
            }
            if ((state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null))
                return memory;
            const liveAreas = state._allAreas.filter((row) => !row.deletedAt);
            if (liveAreas.length !== scope.areas.length || liveAreas.some((row, index) =>
                !sameAreaAdditionRow.area(row, scope.areas[index]))) return memory;
            const planned = planAreaEditorSave({ areas: state._allAreas, projects: state._allProjects,
                tasks: state._allTasks }, request.areaId, request.name, request.manageColor,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt, input.version ?? 1);
            if (!planned || !taskEditValuesEqual(planned.result, input.result)) return memory;
            const currentScope = selectAreaRenameScope({ areas: state._allAreas,
                projects: state._allProjects, tasks: state._allTasks }, request.areaId, planned.result.areaId);
            const sameRows = <T>(current: T[], frozen: T[], same: (left: T, right: T) => boolean) =>
                current.length === frozen.length && current.every((row, index) => same(row, frozen[index]));
            if (!sameRows(currentScope.projects, scope.projects, sameAreaAdditionRow.project)
                || !sameRows(currentScope.tasks, scope.tasks, sameAreaAdditionRow.task)) return memory;
            const replanned = areaRenameEffect(currentScope, request.areaId, request.name,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt, request.manageColor, input.version ?? 1);
            if (!replanned || !taskEditValuesEqual(replanned.effect, effect)
                || !taskEditValuesEqual(replanned.result, input.result)) return memory;
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            if (planned.merged) clearDerivedCache();
            result = { success: true, id: request.areaId, outcome: 'applied' };
            return persistPreparedArea(memory, durable, { ...durable, areas: planned.areas,
                projects: planned.projects, tasks: planned.tasks, settings }, effect.tasks, authority);
        });
        return result;
    },

    commitPreparedAreaOrder: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Area order conflicts with current data' };
        set((state) => {
            const { scope, effect, request } = input;
            if (effect.areas.length === 0 || effect.areas.every(({ before, after }) =>
                sameAreaAdditionRow.area(before, after))) return state;
            const currentById = new Map(state._allAreas.map((area) => [area.id, area]));
            const completeAfter = (!input.deviceIdToInitialize
                || state.settings.deviceId === input.deviceIdToInitialize)
                && effect.areas.every(({ after }) => {
                    const current = currentById.get(after.id);
                    return current && sameAreaAdditionRow.area(current, after);
                });
            if (completeAfter) { result = { success: true, outcome: 'replayed', ids: input.result.orderedIds }; return state; }

            if ((state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null))
                return state;
            const live = sortAreasForOrderDisplay(state._allAreas);
            const beforeById = new Map(scope.areas.map((area) => [area.id, area]));
            if (live.length !== scope.areas.length || live.some((area) => {
                const before = beforeById.get(area.id);
                return !before || !sameAreaAdditionRow.area(area, before);
            })) return state;
            const orderedIds = areaOrderIdsForIntent(live, request.intent);
            if (!orderedIds || !taskEditValuesEqual(orderedIds, input.result.orderedIds)) return state;
            const planned = areaOrderEffect(live, orderedIds, input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!taskEditValuesEqual(planned, effect)) return state;
            const nextAreas = replaceEntitiesInArray(state._allAreas, planned.areas.map(({ after }) => after));
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { areas: nextAreas,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, outcome: 'applied', ids: orderedIds };
            return { _allAreas: nextAreas, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    updateArea: async (id: string, updates: Partial<Area>) => {
        const changeAt = Date.now();
        let missingArea = false;
        let invalidName = false;
        let repairedDestinationProjects = 0;
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
                const planned = planAreaRename({ areas: allAreas, projects: state._allProjects,
                    tasks: state._allTasks }, id, updates, deviceState.deviceId, new Date().toISOString());
                if (!planned) return state;
                repairedDestinationProjects = planned.repairedDestinationProjects;
                if (planned.merged) {
                    clearDerivedCache();
                    persist(set, debouncedSave, state, {
                        tasks: planned.tasks,
                        areas: planned.areas,
                        projects: planned.projects,
                        ...(deviceState.updated ? { settings: deviceState.settings } : {}),
                    });
                    return {
                        _allAreas: planned.areas,
                        _allProjects: planned.projects,
                        _allTasks: planned.tasks,
                        lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                        ...(deviceState.updated ? { settings: deviceState.settings } : {}),
                    };
                }
                persist(set, debouncedSave, state, { areas: planned.areas,
                    ...(planned.projectsChanged ? { projects: planned.projects } : {}),
                    ...(deviceState.updated ? { settings: deviceState.settings } : {}) });
                return { _allAreas: planned.areas,
                    ...(planned.projectsChanged ? { _allProjects: planned.projects } : {}),
                    lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                    ...(deviceState.updated ? { settings: deviceState.settings } : {}) };
            }
            const now = new Date().toISOString();
            const nextOrder = Number.isFinite(updates.order) ? (updates.order as number) : area.order;
            const nextName = area.name;
            const plannedColor = Object.keys(updates).length === 1 && Object.prototype.hasOwnProperty.call(updates, 'color')
                ? planAreaColorChange(area, state._allProjects, updates.color, deviceState.deviceId, now) : null;
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
            if (plannedColor) {
                newAllProjects = plannedColor.projects;
                projectsChanged = plannedColor.projectsChanged;
            } else if (repaintColor || nextAreaTitle !== area.name?.trim()) {
                newAllProjects = state._allProjects.map((project) => {
                    if (project.areaId !== id) return project;
                    const wantsColor = repaintColor && project.colorOverride == null && project.color !== nextAreaColor;
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
                    ? (plannedColor?.area ?? {
                        ...a,
                        ...updates,
                        name: nextName,
                        order: nextOrder,
                        updatedAt: now,
                        rev: nextRevision(a.rev),
                        revBy: deviceState.deviceId,
                    })
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
        if (repairedDestinationProjects > 0) {
            logInfo('Area merge synchronized destination Project titles', {
                scope: 'store', category: 'storage',
                context: { releaseCheck: 'v1.3.3/rn-area-merge-project-titles',
                    count: repairedDestinationProjects },
            });
        }
        return actionOk();
    },

    commitPreparedAreaDelete: async (input, authority): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Area delete conflicts with current data' };
        set((memory) => {
            if (!areaAuthorityMatches(memory, authority)) return memory;
            const durable = authority.snapshot;
            const state = areaDurableState(memory, durable);
            const { scope, effect, request } = input;
            const target = state._allAreas.find((row) => row.id === request.areaId);
            const currentTasksById = new Map(state._allTasks.map((task) => [task.id, task]));
            const currentProjectsById = new Map(state._allProjects.map((project) => [project.id, project]));
            const completeAfter = target && (!input.deviceIdToInitialize
                || state.settings.deviceId === input.deviceIdToInitialize)
                && sameAreaAdditionRow.area(target, effect.area.after)
                && (effect.projects ?? []).every(({ after }) => {
                    const current = currentProjectsById.get(after.id);
                    return current && sameAreaAdditionRow.project(current, after);
                })
                && effect.tasks.every(({ after }) => {
                    const current = currentTasksById.get(after.id);
                    return current && sameAreaAdditionRow.task(current, after);
                });
            if (completeAfter) {
                result = { success: true, id: request.areaId, outcome: 'replayed' };
                return memory;
            }
            if (!target || target.deletedAt || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || !sameAreaAdditionRow.area(target, scope.area)
                || (!request.detachProjects && countLiveProjectsByArea(state._allProjects).has(request.areaId))) return memory;
            const linkedProjects = state._allProjects.filter((project) =>
                project.areaId === request.areaId && !project.deletedAt);
            const beforeProjects = new Map(scope.liveProjects.map((project) => [project.id, project]));
            if (linkedProjects.length !== scope.liveProjects.length || linkedProjects.some((project) => {
                const before = beforeProjects.get(project.id);
                return !before || !sameAreaAdditionRow.project(project, before);
            })) return memory;
            const linkedTasks = state._allTasks.filter((task) => task.areaId === request.areaId);
            const beforeTasks = new Map(scope.tasks.map((task) => [task.id, task]));
            if (linkedTasks.length !== scope.tasks.length || linkedTasks.some((task) => {
                const before = beforeTasks.get(task.id);
                return !before || !sameAreaAdditionRow.task(task, before);
            })) return memory;
            const planned = areaDeleteEffect({ area: target, tasks: linkedTasks, liveProjects: linkedProjects },
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt, request.detachProjects, input.version ?? 1);
            if (!taskEditValuesEqual(planned, effect)) return memory;
            const nextAreas = state._allAreas.map((row) => row.id === request.areaId ? planned.area.after : row)
                .sort((left, right) => left.order - right.order);
            const changedTasks = new Map(planned.tasks.map(({ after }) => [after.id, after]));
            const nextTasks = state._allTasks.map((task) => changedTasks.get(task.id) ?? task);
            const changedProjects = new Map((planned.projects ?? []).map(({ after }) => [after.id, after]));
            const nextProjects = state._allProjects.map((project) => changedProjects.get(project.id) ?? project);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            clearDerivedCache();
            result = { success: true, id: request.areaId, outcome: 'applied' };
            return persistPreparedArea(memory, durable, { ...durable, areas: nextAreas,
                projects: nextProjects, tasks: nextTasks, settings }, effect.tasks, authority);
        });
        return result;
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
            const planned = planAreaDeletion(area, state._allProjects, state._allTasks,
                deviceState.deviceId, now);
            const newAllAreas = allAreas
                .map((item) => item.id === id ? planned.area : item)
                .sort((a, b) => a.order - b.order);
            const newAllProjects = planned.projects;
            // Trashed tasks are detached too: sync clears links to non-live Areas.
            const newAllTasks = planned.tasks;
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
                const activeIds = new Set(activeAreas.map((area) => area.id));
                orderedIds.forEach((id, index) => {
                    if (!activeIds.has(id)) return;
                    orderById.set(id, index);
                });
                const selected = selectAreaOrderRows(activeAreas, orderedIds);
                const recognizedCount = orderedIds.filter((id) => activeIds.has(id)).length;
                selected.slice(recognizedCount)
                    .forEach((area, index) => {
                        orderById.set(area.id, recognizedCount + index);
                });
                return selected;
            },
            buildUpdates: (area, { now }) => ({
                order: orderById.get(area.id) ?? area.order,
                updatedAt: now,
            }),
        });
    },
});
};
