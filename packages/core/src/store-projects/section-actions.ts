import { ensureDeviceId, getNextDataChangeAt, nextRevision, persist, replaceEntitiesInArray } from '../store-helpers';
import { taskEditValuesEqual } from '../json-value-equality';
import { logWarn } from '../logger';
import { generateUUID as uuidv4 } from '../uuid';
import { sectionToSqliteRow } from '../section-sync-schema';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from '../task-sync-schema';
import { toStableSyncJson } from '../sync-helpers';
import { logProjectFlowModeSaved, sameProjectSqliteRow } from './project-actions';
import type { PreparedProjectSectionCreate, PreparedProjectSectionDelete, PreparedProjectSectionRename, PreparedTaskEditResult } from '../store-types';
import type { ProjectActionContext, Section, SectionActions, Task } from './shared';
import { actionFail, actionOk, mutateEntities } from './shared';

export const projectSectionOrderMax = (sections: readonly Section[], projectId: string): number =>
    sections.filter((section) => section.projectId === projectId && !section.deletedAt)
        .reduce((max, section) => Math.max(max, Number.isFinite(section.order) ? section.order : -1), -1);

/** Shared RN/native Section defaults; the caller supplies the ID and clock. */
export const buildNewSection = (input: { id: string; projectId: string; title: string;
    initialProps?: Partial<Section>; orderMax: number; deviceId: string; now: string }): Section => ({
    id: input.id,
    projectId: input.projectId,
    title: input.title.trim(),
    description: input.initialProps?.description,
    order: Number.isFinite(input.initialProps?.order) ? input.initialProps!.order! : input.orderMax + 1,
    isCollapsed: input.initialProps?.isCollapsed ?? false,
    ...(typeof input.initialProps?.isSequential === 'boolean' ? { isSequential: input.initialProps.isSequential } : {}),
    rev: 1,
    revBy: input.deviceId,
    createdAt: input.initialProps?.createdAt ?? input.now,
    updatedAt: input.now,
});

export const sameSectionSqliteRow = (left: Section, right: Section): boolean =>
    JSON.stringify(sectionToSqliteRow(left)) === JSON.stringify(sectionToSqliteRow(right));

const taskJsonColumns = new Set(['relativeStartOffset', 'recurrence', 'tags', 'contexts',
    'checklist', 'attachments', 'viewSectionIds']);
export const sameTaskSqliteRow = (left: Task, right: Task): boolean => {
    const before = taskToSqliteRow(left);
    const after = taskToSqliteRow(right);
    return before.length === after.length && before.every((value, index) => {
        const other = after[index];
        return taskJsonColumns.has(TASK_SQLITE_COLUMNS[index]) && typeof value === 'string'
            && typeof other === 'string' ? taskEditValuesEqual(JSON.parse(value), JSON.parse(other))
                : Object.is(value, other);
    });
};

/** Compare raw JSON without reordering arrays or equating null with an absent field. */
export const sameSectionDeleteJson = (left: unknown, right: unknown): boolean => {
    const sorted = (_key: string, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
        : value;
    return JSON.stringify(left, sorted) === JSON.stringify(right, sorted);
};

const SECTION_DELETE_TASK_JSON_COLUMNS = new Set([
    'relativeStartOffset', 'recurrence', 'tags', 'contexts', 'checklist', 'attachments', 'viewSectionIds',
]);

/** A saved Task receipt may cross Swift's sorted-key JSON journal boundary. */
const sameSectionDeleteTaskSqliteRow = (left: Task, right: Task): boolean => {
    const stored = taskToSqliteRow(left);
    const frozen = taskToSqliteRow(right);
    return stored.length === frozen.length && stored.every((value, index) => {
        if (value === frozen[index]) return true;
        if (!SECTION_DELETE_TASK_JSON_COLUMNS.has(TASK_SQLITE_COLUMNS[index])
            || typeof value !== 'string' || typeof frozen[index] !== 'string') return false;
        try { return sameSectionDeleteJson(JSON.parse(value), JSON.parse(frozen[index])); }
        catch { return false; }
    });
};

/** RN updateSection's title-only row, preserving every unrelated raw field. */
export const sectionRenameEffect = (before: Section, title: string, deviceId: string,
    now: string): PreparedProjectSectionRename['effect'] => ({
    section: { before, after: { ...before, title: title.trim(), updatedAt: now,
        rev: nextRevision(before.rev), revBy: deviceId } },
});

/** The existing deleteSection tombstone and every sectionId-linked Task detach. */
export const sectionDeleteEffect = (section: Section, tasks: readonly Task[], deviceId: string,
    now: string): PreparedProjectSectionDelete['effect'] => ({
    section: { before: section, after: { ...section, deletedAt: now, updatedAt: now,
        rev: nextRevision(section.rev), revBy: deviceId } },
    tasks: tasks.map((before) => ({ before, after: { ...before, sectionId: undefined,
        updatedAt: now, rev: nextRevision(before.rev), revBy: deviceId } })),
});

export const createSectionActions = ({
    set,
    debouncedSave,
    flushPendingSave,
}: ProjectActionContext): SectionActions => ({
    addSection: async (projectId: string, title: string, initialProps?: Partial<Section>) => {
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!projectId || !trimmedTitle) return null;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let createdSection: Section | null = null;
        set((state) => {
            const projectExists = state._allProjects.some((project) => project.id === projectId && !project.deletedAt);
            if (!projectExists) return state;
            const deviceState = ensureDeviceId(state.settings);
            const allSections = state._allSections;
            const newSection = buildNewSection({ id: uuidv4(), projectId, title: trimmedTitle, initialProps,
                orderMax: projectSectionOrderMax(allSections, projectId), deviceId: deviceState.deviceId, now });
            createdSection = newSection;
            const newAllSections = [...allSections, newSection];
            persist(set, debouncedSave, state, {
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allSections: newAllSections,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        return createdSection;
    },

    commitPreparedProjectSectionCreate: async (input: PreparedProjectSectionCreate): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Section creation conflicts with current data' };
        set((state) => {
            const existing = state._allSections.find((section) => section.id === input.section.id);
            // A complete Section receipt and initialized device precede mutable parent/order checks.
            if (existing && !existing.deletedAt && !('purgedAt' in existing)
                && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && JSON.stringify(sectionToSqliteRow(existing)) === JSON.stringify(sectionToSqliteRow(input.section))) {
                result = { success: true, id: existing.id, outcome: 'replayed' };
                return state;
            }
            const current = state._projectsById.get(input.scope.project.id);
            if (existing || !current || current.deletedAt || current.purgedAt || current.status === 'archived'
                || !sameProjectSqliteRow(current, input.scope.project)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)
                || projectSectionOrderMax(state._allSections, current.id) !== input.scope.orderMax) return state;
            const planned = buildNewSection({ id: input.section.id, projectId: current.id,
                title: input.request.title, orderMax: input.scope.orderMax,
                deviceId: input.deviceIdBefore ?? input.deviceIdToInitialize!, now: input.preparedAt });
            if (JSON.stringify(sectionToSqliteRow(planned)) !== JSON.stringify(sectionToSqliteRow(input.section))) return state;
            const sections = [...state._allSections, planned];
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { sections,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: planned.id, outcome: 'applied' };
            return { _allSections: sections, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectSectionRename: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Section rename conflicts with current data' };
        set((state) => {
            const current = state._allSections.find((section) => section.id === input.request.sectionId);
            // The complete Section receipt precedes mutable parent, title, and device guards.
            if (current && !current.deletedAt && !('purgedAt' in current)
                && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameSectionSqliteRow(current, input.effect.section.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            const parent = state._projectsById.get(input.request.projectId);
            if (!current || current.projectId !== input.request.projectId || current.deletedAt
                || 'purgedAt' in current || !parent || parent.deletedAt || parent.purgedAt
                || parent.status === 'archived' || !sameProjectSqliteRow(parent, input.scope.project)
                || !sameSectionSqliteRow(current, input.effect.section.before)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null))
                return state;
            const title = input.request.title.trim();
            if (!title || title === current.title) return state;
            const planned = sectionRenameEffect(current, title,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.preparedAt);
            if (toStableSyncJson(planned) !== toStableSyncJson(input.effect)) return state;
            const sections = replaceEntitiesInArray(state._allSections, [planned.section.after]);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { sections,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allSections: sections, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedProjectSectionDelete: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
            error: 'Prepared Project Section delete conflicts with current data' };
        set((state) => {
            const sectionsAtId = state._allSections.filter((row) => row.id === input.request.sectionId);
            const current = sectionsAtId.length === 1 ? sectionsAtId[0] : null;
            const tasksById = new Map<string, Task>();
            const duplicateTaskIds = new Set<string>();
            for (const task of state._allTasks) {
                if (tasksById.has(task.id)) duplicateTaskIds.add(task.id);
                tasksById.set(task.id, task);
            }
            const frozenTasks = input.effect.tasks;
            // The full durable receipt precedes mutable parent and linked-task scope checks.
            if (current && !('purgedAt' in current)
                && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && sameSectionSqliteRow(current, input.effect.section.after)
                && frozenTasks.every(({ after }) => {
                    const stored = tasksById.get(after.id);
                    return stored && !duplicateTaskIds.has(after.id) && sameSectionDeleteTaskSqliteRow(stored, after);
                })) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            const parent = state._projectsById.get(input.request.projectId);
            if (!current || current.projectId !== input.request.projectId || current.deletedAt
                || 'purgedAt' in current || !parent || parent.deletedAt || parent.purgedAt
                || parent.status === 'archived' || !sameProjectSqliteRow(parent, input.scope.project)
                || !sameSectionDeleteJson(parent, input.scope.project)
                || !sameSectionSqliteRow(current, input.scope.section)
                || !sameSectionDeleteJson(current, input.scope.section)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null))
                return state;
            const linked = state._allTasks.filter((task) => task.sectionId === current.id);
            if (linked.length !== input.scope.tasks.length) return state;
            const scopedById = new Map(input.scope.tasks.map((task) => [task.id, task]));
            if (scopedById.size !== input.scope.tasks.length || linked.some((task) => {
                const before = scopedById.get(task.id);
                return !before || duplicateTaskIds.has(task.id)
                    || !sameSectionDeleteTaskSqliteRow(task, before) || !sameSectionDeleteJson(task, before);
            })) return state;
            const effect = sectionDeleteEffect(current,
                input.scope.tasks.map((task) => tasksById.get(task.id)!),
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.preparedAt);
            if (!sameSectionDeleteJson(effect, input.effect)) return state;
            const replacements = new Map(effect.tasks.map(({ after }) => [after.id, after]));
            const tasks = state._allTasks.map((task) => replacements.get(task.id) ?? task);
            const sections = state._allSections.map((section) => section.id === current.id
                ? effect.section.after : section);
            const settings = input.deviceIdToInitialize
                ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { sections, tasks,
                ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allSections: sections, _allTasks: tasks, settings,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    updateSection: async (id: string, updates: Partial<Section>) => {
        let invalidTitle = false;
        const result = await mutateEntities({ set, debouncedSave }, {
            collection: 'sections',
            select: (state) => state._allSections.filter((section) => section.id === id),
            buildUpdates: (section) => {
                const nextTitle = updates.title !== undefined ? updates.title.trim() : section.title;
                if (!nextTitle) {
                    invalidTitle = true;
                    return null;
                }
                const { projectId: _ignored, ...restUpdates } = updates;
                return { ...restUpdates, title: nextTitle };
            },
            missingMessage: 'Section not found',
        });
        if (!result.success) {
            const message = result.error ?? 'Section not found';
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
        if (typeof updates.isSequential === 'boolean') {
            await flushPendingSave();
            logProjectFlowModeSaved(updates.isSequential ? 'sectionSequential' : 'sectionParallel', 0);
        }
        return result;
    },

    deleteSection: async (id: string) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let missingSection = false;
        set((state) => {
            const allSections = state._allSections;
            const section = allSections.find((item) => item.id === id);
            if (!section) {
                missingSection = true;
                return state;
            }
            if (section.deletedAt) return state;
            const deviceState = ensureDeviceId(state.settings);
            const effect = sectionDeleteEffect(section,
                state._allTasks.filter((task) => task.sectionId === id), deviceState.deviceId, now);
            const newAllSections = allSections.map((item) => item.id === id
                ? sectionDeleteEffect(item, [], deviceState.deviceId, now).section.after : item);
            let linkedIndex = 0;
            const newAllTasks = state._allTasks.map((task) => task.sectionId === id
                ? effect.tasks[linkedIndex++].after : task);
            persist(set, debouncedSave, state, {
                tasks: newAllTasks,
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allSections: newAllSections,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
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
        return actionOk();
    },
});
