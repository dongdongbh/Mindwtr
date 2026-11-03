import {
    ensureDeviceId,
    getNextDataChangeAt,
    nextRevision,
    persist,
    replaceEntitiesInArray,
} from '../store-helpers';
import { logWarn } from '../logger';
import { clearDerivedCache } from '../store-settings';
import { getPersonNameKey, normalizePersonName, normalizePersonNote, normalizePersonReferenceLink } from '../people';
import { taskEditValuesEqual } from '../json-value-equality';
import { PERSON_SQLITE_COLUMNS, personFromSqliteRow, personToSqliteRow } from '../person-sync-schema';
import { planManageEditorSave } from '../manage-settings-model';
import { planPersonMetadataUpdates, planPersonRename, planPersonEditorSave, selectPersonRenameDestination, selectPersonRenameTasks } from '../person-edit';
import { sameAreaAdditionRow } from '../area-rename';
import { normalizeTaskForLoad } from '../task-status';
import { normalizeProjectLifecycleFields } from '../project-status';
import { getPersistenceStatus } from '../store';
import type { PreparedPersonDelete, PreparedTaskEditResult } from '../store-types';
import { generateUUID as uuidv4 } from '../uuid';
import type { PeopleActions, Person, ProjectActionContext } from './shared';
import { actionFail, actionOk, mutateEntities } from './shared';

export const resolvePersonAddition = (people: readonly Person[], name: string): Person | null => {
    const key = getPersonNameKey(name);
    const matches = (person: Person) => getPersonNameKey(person.name) === key;
    return people.find((person) => !person.deletedAt && matches(person))
        ?? people.find((person) => person.deletedAt && matches(person)) ?? null;
};


export function planPersonAddition(people: readonly Person[], name: string, props: Partial<Person> | undefined,
    id: string, deviceId: string, now: string):
    { kind: 'live' | 'fresh' | 'restored'; before: Person | null; person: Person } | null {
    const normalizedName = normalizePersonName(name);
    if (!normalizedName) return null;
    const before = resolvePersonAddition(people, normalizedName);
    if (before && !before.deletedAt) return { kind: 'live', before, person: before };
    const person: Person = before ? {
        ...before, ...props, name: normalizedName, deletedAt: undefined,
        note: Object.prototype.hasOwnProperty.call(props ?? {}, 'note') ? normalizePersonNote(props?.note) : before.note,
        referenceLink: Object.prototype.hasOwnProperty.call(props ?? {}, 'referenceLink')
            ? normalizePersonReferenceLink(props?.referenceLink) : before.referenceLink,
        rev: nextRevision(before.rev), revBy: deviceId, updatedAt: now,
    } : {
        id, ...props, name: normalizedName,
        note: normalizePersonNote(props?.note), referenceLink: normalizePersonReferenceLink(props?.referenceLink),
        rev: 1, revBy: deviceId, createdAt: props?.createdAt ?? now, updatedAt: now,
    };
    return { kind: before ? 'restored' : 'fresh', before, person };
}


export function personCreateProps(request: { name: string; note: string; referenceLink: string }): Partial<Person> | undefined {
    const write = planManageEditorSave({ type: 'newPerson' }, { ...request, color: '' }, {})?.[0];
    return write?.kind === 'addPerson' ? write.props : undefined;
}

export const samePersonAdditionRow = (left: Person, right: Person): boolean =>
    taskEditValuesEqual(personToSqliteRow(left, left.updatedAt), personToSqliteRow(right, right.updatedAt));


export function personPersistedSnapshot(person: Person): Person {
    const values = personToSqliteRow(person, person.updatedAt);
    return JSON.parse(JSON.stringify(personFromSqliteRow(Object.fromEntries(
        PERSON_SQLITE_COLUMNS.map((column, index) => [column, values[index]])), person.updatedAt))) as Person;
}


export const personDeleteUpdates = (now: string): Pick<Person, 'deletedAt'> => ({ deletedAt: now });

export function personDeleteEffect(person: Person, deviceId: string, now: string): PreparedPersonDelete['effect'] {
    return { person: { before: person, after: { ...person, ...personDeleteUpdates(now),
        updatedAt: now, rev: nextRevision(person.rev), revBy: deviceId } } };
}

export const createPeopleActions = ({
    set,
    debouncedSave,
}: ProjectActionContext): PeopleActions => ({
    addPerson: async (name: string, initialProps?: Partial<Person>) => {
        if (!normalizePersonName(name)) return null;
        const now = new Date().toISOString();
        let person: Person | null = null;
        set((state) => {
            const live = resolvePersonAddition(state._allPeople, name);
            if (live && !live.deletedAt) { person = live; return state; }
            const device = ensureDeviceId(state.settings);
            const planned = planPersonAddition(state._allPeople, name, initialProps, uuidv4(), device.deviceId, now);
            if (!planned || planned.kind === 'live') return state;
            const people = planned.before
                ? replaceEntitiesInArray(state._allPeople, [planned.person])
                : [...state._allPeople, planned.person];

            person = planned.before && planned.before.id !== planned.person.id ? null : planned.person;
            persist(set, debouncedSave, state, { people, ...(device.updated ? { settings: device.settings } : {}) });
            return { _allPeople: people, lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt),
                ...(device.updated ? { settings: device.settings } : {}) };
        });
        return person;
    },

    commitPreparedPersonCreate: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared Person conflicts with current data' };
        set((state) => {
            const { request, effect } = input;
            const target = state._allPeople.find((person) => person.id === request.expectedPersonId);
            if (target && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && samePersonAdditionRow(target, effect.person.after)) {
                result = { success: true, id: target.id, outcome: 'replayed' };
                return state;
            }
            if ((input.kind === 'fresh' && target) || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)) return state;
            const selected = resolvePersonAddition(state._allPeople, request.name);
            if (selected ? !input.scope.person || selected.id !== request.expectedPersonId
                || !samePersonAdditionRow(selected, input.scope.person) : input.scope.person !== null) return state;
            const planned = planPersonAddition(state._allPeople, request.name, personCreateProps(request), request.requestId,
                input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!planned || planned.kind !== input.kind || planned.person.id !== request.expectedPersonId
                || !samePersonAdditionRow(planned.person, effect.person.after)) return state;
            const people = planned.before
                ? state._allPeople.map((person) => person.id === planned.before!.id ? planned.person : person)
                : [...state._allPeople, planned.person];
            const settings = input.deviceIdToInitialize ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { people, ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: planned.person.id, outcome: 'applied' };
            return { _allPeople: people, settings, lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedPersonDelete: async (input): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared Person deletion conflicts with current data' };
        set((state) => {
            const current = state._allPeople.find((person) => person.id === input.request.personId);
            if (current && (!input.deviceIdToInitialize || state.settings.deviceId === input.deviceIdToInitialize)
                && samePersonAdditionRow(current, input.effect.person.after)) {
                result = { success: true, id: current.id, outcome: 'replayed' };
                return state;
            }
            if (!current || current.deletedAt || !samePersonAdditionRow(current, input.scope.person)
                || !samePersonAdditionRow(current, input.request.expected)
                || (state.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)) return state;
            const effect = personDeleteEffect(current, input.deviceIdBefore ?? input.deviceIdToInitialize!, input.updateAt);
            if (!samePersonAdditionRow(effect.person.after, input.effect.person.after)) return state;
            const people = replaceEntitiesInArray(state._allPeople, [effect.person.after]);
            const settings = input.deviceIdToInitialize ? { ...state.settings, deviceId: input.deviceIdToInitialize } : state.settings;
            persist(set, debouncedSave, state, { people, ...(settings !== state.settings ? { settings } : {}) });
            result = { success: true, id: current.id, outcome: 'applied' };
            return { _allPeople: people, settings, lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt) };
        });
        return result;
    },

    commitPreparedPersonEdit: async (input, authority): Promise<PreparedTaskEditResult> => {
        let result: PreparedTaskEditResult = { success: false, reason: 'conflict', error: 'Prepared Person edit conflicts with current data' };
        set((state) => {
            const { scope, effect } = input;
            if (state._allTasks !== authority.taskReference || state.lastDataChangeAt !== authority.lastDataChangeAt) return state;
            const durable = authority.snapshot;
            const durablePeople = durable.people ?? [];
            const completeAfter = effect.people.every(({ after }) => {
                const row = durablePeople.find((candidate) => candidate.id === after.id);
                return row && samePersonAdditionRow(row, after);
            }) && effect.tasks.every(({ after }) => {
                const row = durable.tasks.find((candidate) => candidate.id === after.id);
                return row && sameAreaAdditionRow.task(row, after);
            });
            if (completeAfter && (!input.deviceIdToInitialize || durable.settings.deviceId === input.deviceIdToInitialize)) {
                result = { success: true, id: scope.person.id, outcome: 'replayed' };
                return state;
            }
            const source = durablePeople.find((row) => row.id === scope.person.id);
            if (!source || source.deletedAt || !samePersonAdditionRow(source, scope.person)
                || (durable.settings.deviceId ?? null) !== input.deviceIdBefore
                || (input.deviceIdBefore === null ? !input.deviceIdToInitialize : input.deviceIdToInitialize !== null)) return state;
            if (input.renameAt !== null) {
                const destination = selectPersonRenameDestination(durablePeople, source.id, input.request.name);
                if (destination ? !scope.destination || !samePersonAdditionRow(destination, scope.destination)
                    : scope.destination !== null) return state;
                const tasks = selectPersonRenameTasks(durable.tasks, source.name);
                if (tasks.length !== scope.tasks.length || tasks.some((row) => {
                    const before = scope.tasks.find((candidate) => candidate.id === row.id);
                    return !before || !sameAreaAdditionRow.task(row, before);
                })) return state;
            }
            const planned = planPersonEditorSave({ people: [personPersistedSnapshot(source), ...(scope.destination ? [scope.destination] : [])],
                tasks: scope.tasks }, source.id, input.request, input.deviceIdBefore ?? input.deviceIdToInitialize!,
                input.updateAt, input.renameAt);
            if (!planned || !taskEditValuesEqual(planned.result, input.result)
                || !taskEditValuesEqual(JSON.parse(JSON.stringify(planned.effect)), effect)) return state;
            const people = replaceEntitiesInArray(durablePeople, effect.people.map(({ after }) => after));
            const tasks = replaceEntitiesInArray(durable.tasks, effect.tasks.map(({ after }) => after));
            const settings = input.deviceIdToInitialize ? { ...durable.settings, deviceId: input.deviceIdToInitialize } : durable.settings;


            const memoryTasks = tasks.map((row) => {
                const existing = state._allTasks.find((candidate) => candidate.id === row.id);
                const pair = effect.tasks.find(({ after }) => after.id === row.id);
                if (existing && pair) {
                    const freshBefore = normalizeTaskForLoad(pair.before);
                    const base = sameAreaAdditionRow.task(existing, freshBefore) ? existing : freshBefore;
                    return { ...base, assignedTo: pair.after.assignedTo, updatedAt: pair.after.updatedAt,
                        rev: pair.after.rev, revBy: pair.after.revBy };
                }
                return existing && sameAreaAdditionRow.task(existing, row) ? existing : normalizeTaskForLoad(row);
            });
            clearDerivedCache();
            persist(set, debouncedSave, { ...state, _allTasks: durable.tasks, _allPeople: durablePeople,
                _allProjects: durable.projects, _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [],
                settings: durable.settings }, { ...durable, people, tasks, settings });
            const lastDataChangeAt = getNextDataChangeAt(state.lastDataChangeAt);
            authority.saveBoundary = { taskReference: memoryTasks, lastDataChangeAt,
                generation: getPersistenceStatus().generation, failure: state.persistenceFailure };
            result = { success: true, id: source.id, outcome: 'applied' };
            return { _allPeople: people, _allTasks: memoryTasks,
                _allProjects: durable.projects.map(normalizeProjectLifecycleFields), _allSections: durable.sections ?? [], _allAreas: durable.areas ?? [], settings,
                lastDataChangeAt };
        });
        return result;
    },

    updatePerson: async (id: string, updates: Partial<Person>) => {
        let invalidName = false;
        const result = await mutateEntities({ set, debouncedSave }, {
            collection: 'people',
            select: (state) => state._allPeople.filter((person) => person.id === id),
            buildUpdates: (person) => {
                const normalizedUpdates = planPersonMetadataUpdates(person, updates);
                if (!normalizedUpdates) invalidName = true;
                return normalizedUpdates;
            },
            missingMessage: 'Person not found',
        });
        if (!result.success) {
            const message = result.error ?? 'Person not found';
            logWarn('updatePerson skipped: person not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        if (invalidName) {
            const message = 'Person name is required';
            set({ error: message });
            return actionFail(message);
        }
        return result;
    },

    renamePerson: async (id: string, name: string, options?: { updateTasks?: boolean }) => {
        const nextName = normalizePersonName(name);
        if (!nextName) {
            const message = 'Person name is required';
            set({ error: message });
            return actionFail(message);
        }
        const now = new Date().toISOString();
        const changeAt = Date.now();
        let missingPerson = false;
        set((state) => {
            const person = state._allPeople.find((item) => item.id === id);
            if (!person) {
                missingPerson = true;
                return state;
            }
            if (getPersonNameKey(person.name) === getPersonNameKey(nextName) && person.name === nextName) return state;
            const deviceState = ensureDeviceId(state.settings);
            const planned = planPersonRename({ people: state._allPeople, tasks: state._allTasks }, id, nextName,
                options?.updateTasks !== false, deviceState.deviceId, now)!;
            const nextAllPeople = planned.people;
            const nextAllTasks = planned.tasks;

            clearDerivedCache();
            persist(set, debouncedSave, state, {
                people: nextAllPeople,
                tasks: nextAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allPeople: nextAllPeople,
                _allTasks: nextAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (missingPerson) {
            const message = 'Person not found';
            set({ error: message });
            return actionFail(message);
        }
        return actionOk();
    },

    deletePerson: async (id: string) => {
        const result = await mutateEntities({ set, debouncedSave }, {
            collection: 'people',
            select: (state) => state._allPeople.filter((person) => person.id === id && !person.deletedAt),
            buildUpdates: (_person, { now }) => personDeleteUpdates(now),
            missingMessage: 'Person not found',
        });
        if (!result.success) {
            const message = result.error ?? 'Person not found';
            set({ error: message });
            return actionFail(message);
        }
        return result;
    },

    restorePerson: async (id: string) => {
        let duplicateActivePerson = false;
        const result = await mutateEntities({ set, debouncedSave }, {
            collection: 'people',
            select: (state) => state._allPeople.filter((person) => person.id === id),
            buildUpdates: (person, { state }) => {
                if (!person.deletedAt) return null;
                const restoredNameKey = getPersonNameKey(person.name);
                if (state._allPeople.some((item) => (
                    item.id !== id
                    && !item.deletedAt
                    && getPersonNameKey(item.name) === restoredNameKey
                ))) {
                    duplicateActivePerson = true;
                    return null;
                }
                return { deletedAt: undefined };
            },
            missingMessage: 'Person not found',
        });
        if (!result.success) {
            const message = result.error ?? 'Person not found';
            set({ error: message });
            return actionFail(message);
        }
        if (duplicateActivePerson) {
            const message = 'A person with this name already exists';
            set({ error: message });
            return actionFail(message);
        }
        return result;
    },
});
