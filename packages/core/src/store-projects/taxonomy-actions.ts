import { ensureDeviceId, getNextDataChangeAt, persist } from '../store-helpers';
import { planTaxonomyEffect, selectTaxonomyScope, taxonomyDestination,
    type TaxonomyAction, type TaxonomyKind } from '../taxonomy-policy';
import { getPersistenceStatus } from '../store';
import { taskEditValuesEqual } from '../json-value-equality';
import { normalizeTaskForLoad } from '../task-status';
import { normalizeProjectLifecycleFields } from '../project-status';
import { clearDerivedCache } from '../store-settings';
import type { PreparedTaxonomy, PreparedAreaAuthority, PreparedTaskEditResult } from '../store-types';
import type { ProjectActionContext, TaxonomyActions } from './shared';
import { addSavedTaxonomyToken } from '../taxonomy-catalog';
import { logInfo } from '../logger';

const same = taskEditValuesEqual;

export const createTaxonomyActions = ({ set, get, debouncedSave, flushPendingSave }: ProjectActionContext): TaxonomyActions => {
    const run = async (kind: TaxonomyKind, action: TaxonomyAction, name: string, to: string | null) => {
        if (taxonomyDestination(kind, action, name, to) === undefined) {
            if (get().persistenceFailure) await get().persistSnapshot();
            await flushPendingSave();
            if (get().persistenceFailure) throw new Error(get().persistenceFailure!.message);
            return;
        }
        const changeAt = Date.now();
        const now = new Date().toISOString();
        set((state) => {
            const device = ensureDeviceId(state.settings);
            const scope = selectTaxonomyScope(kind, name, state._allTasks, state._allProjects, state.settings, action);
            const effect = planTaxonomyEffect(kind, action, name, to, scope, device.deviceId, now)!;
            const taskChanges = new Map(effect.tasks.map(({ before, after }) => [before, after]));
            const projectChanges = new Map(effect.projects.map(({ before, after }) => [before, after]));
            const tasks = state._allTasks.map((row) => taskChanges.get(row) ?? row);
            const projects = kind === 'tag'
                ? state._allProjects.map((row) => projectChanges.get(row) ?? row) : state._allProjects;
            const settings = { ...device.settings, taxonomy: effect.catalogue!.after };
            persist(set, debouncedSave, state, { tasks,
                ...(kind === 'tag' ? { projects } : {}),
                settings });
            return { _allTasks: tasks, ...(kind === 'tag' ? { _allProjects: projects } : {}),
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                settings };
        });
        await flushPendingSave();
        if (get().persistenceFailure) throw new Error(get().persistenceFailure!.message);
        logInfo('Saved context or tag updated', { scope: 'store', category: 'storage', force: true,
            context: { releaseCheck: 'v1.3.7/saved-taxonomy', operation: action, taxonomyKind: kind, outcome: 'persisted' } });
    };
    const add = async (kind: TaxonomyKind, name: string) => {
        if (!get().settings.deviceId || get().isLoading) throw new Error('Load data before creating a saved value');
        const now = new Date().toISOString();
        set((state) => {
            const device = ensureDeviceId(state.settings);
            const settings = addSavedTaxonomyToken(device.settings, kind, name, device.deviceId, now);
            if (settings === state.settings && !state.persistenceFailure) return state;
            persist(set, debouncedSave, state, { settings });
            return { settings, lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        await flushPendingSave();
        if (get().persistenceFailure) throw new Error(get().persistenceFailure!.message);
        logInfo('Saved context or tag updated', { scope: 'store', category: 'storage', force: true,
            context: { releaseCheck: 'v1.3.7/saved-taxonomy', operation: 'create', taxonomyKind: kind, outcome: 'persisted' } });
    };
    return {
        addContext: (name) => add('context', name),
        addTag: (name) => add('tag', name),
        deleteTag: async (name) => run('tag', 'delete', name, null),
        renameTag: async (name, to) => run('tag', 'rename', name, to),
        deleteContext: async (name) => run('context', 'delete', name, null),
        renameContext: async (name, to) => run('context', 'rename', name, to),
        commitPreparedTaxonomy: async (input: PreparedTaxonomy, authority: PreparedAreaAuthority): Promise<PreparedTaskEditResult> => {
            let result: PreparedTaskEditResult = { success: false, reason: 'conflict',
                error: 'Prepared taxonomy changed; refresh Manage' };
            set((memory) => {
                const before = authority.state;
                if (memory._allTasks !== before._allTasks || memory._allProjects !== before._allProjects
                    || memory._allAreas !== before._allAreas || memory._allSections !== before._allSections
                    || memory._allPeople !== before._allPeople || memory.settings !== before.settings
                    || memory.lastDataChangeAt !== before.lastDataChangeAt) return memory;
                const durable = authority.snapshot;
                const { request, scope, effect } = input;
                const current = selectTaxonomyScope(request.kind, request.name, durable.tasks, durable.projects,
                    scope.catalogue === undefined ? undefined : durable.settings, request.action);
                const taskById = new Map(durable.tasks.map((row) => [row.id, row]));
                const projectById = new Map(durable.projects.map((row) => [row.id, row]));
                const completeAfter = effect.tasks.every(({ after }) => same(taskById.get(after.id), after))
                    && effect.projects.every(({ after }) => same(projectById.get(after.id), after))
                    && (!effect.catalogue || same(durable.settings.taxonomy ?? null, effect.catalogue.after))
                    && (!input.deviceIdToInitialize || durable.settings.deviceId === input.deviceIdToInitialize);
                if (completeAfter) {
                    result = { success: true, outcome: 'replayed' };
                    return memory;
                }
                if ((durable.settings.deviceId ?? null) !== input.deviceIdBefore
                    || !same(current, scope)) return memory;
                const planned = planTaxonomyEffect(request.kind, request.action, request.name, request.to,
                    current, input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
                if (!planned || !same(planned, effect)) return memory;
                const changedTasks = new Map(effect.tasks.map(({ after }) => [after.id, after]));
                const changedProjects = new Map(effect.projects.map(({ after }) => [after.id, after]));
                const tasks = durable.tasks.map((row) => changedTasks.get(row.id) ?? row);
                const projects = durable.projects.map((row) => changedProjects.get(row.id) ?? row);
                let settings = input.deviceIdToInitialize
                    ? { ...durable.settings, deviceId: input.deviceIdToInitialize } : durable.settings;
                if (effect.catalogue) settings = { ...settings, taxonomy: effect.catalogue.after };
                const freshTasks = tasks.map((row) => normalizeTaskForLoad(row));
                const freshProjects = projects.map(normalizeProjectLifecycleFields);
                clearDerivedCache();
                persist(set, debouncedSave, { ...memory, _allTasks: durable.tasks,
                    _allProjects: durable.projects, _allAreas: durable.areas ?? [],
                    _allSections: durable.sections ?? [], _allPeople: durable.people ?? [], settings: durable.settings },
                { ...durable, tasks, projects, settings });
                const lastDataChangeAt = getNextDataChangeAt(memory.lastDataChangeAt);
                authority.saveBoundary = { taskReference: freshTasks, lastDataChangeAt,
                    generation: getPersistenceStatus().generation, failure: memory.persistenceFailure };
                result = { success: true, outcome: 'applied' };
                return { _allTasks: freshTasks, _allProjects: freshProjects,
                    _allAreas: durable.areas ?? [], _allSections: durable.sections ?? [],
                    _allPeople: durable.people ?? [], settings, lastDataChangeAt };
            });
            return result;
        },
    };
};
