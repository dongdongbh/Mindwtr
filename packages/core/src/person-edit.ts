import { getPersonNameKey, normalizePersonName, normalizePersonNote, normalizePersonReferenceLink } from './people';
import { planManageEditorSave } from './manage-settings-model';
import { nextRevision } from './store-helpers';
import type { Person, Task } from './types';

export type PersonEditRows = { people: Person[]; tasks: Task[] };
export type PersonEditResult = { id: string; personId: string; name: string };
export type PersonEditScope = { person: Person; destination: Person | null; tasks: Task[] };
export type PersonEditEffect = { people: Array<{ before: Person; after: Person }>;
    tasks: Array<{ before: Task; after: Task }> };


export function planPersonMetadataUpdates(person: Person, updates: Partial<Person>): Partial<Person> | null {
    const name = updates.name !== undefined ? normalizePersonName(updates.name) : person.name;
    if (!name) return null;
    return { ...updates, name,
        note: Object.prototype.hasOwnProperty.call(updates, 'note') ? normalizePersonNote(updates.note) : person.note,
        referenceLink: Object.prototype.hasOwnProperty.call(updates, 'referenceLink')
            ? normalizePersonReferenceLink(updates.referenceLink) : person.referenceLink };
}

export const selectPersonRenameDestination = (people: readonly Person[], id: string, name: string): Person | null =>
    people.find((row) => row.id !== id && !row.deletedAt && getPersonNameKey(row.name) === getPersonNameKey(name)) ?? null;
export const selectPersonRenameTasks = (tasks: readonly Task[], name: string): Task[] =>
    tasks.filter((row) => !row.deletedAt && getPersonNameKey(row.assignedTo) === getPersonNameKey(name));


export function planPersonRename(rows: PersonEditRows, id: string, name: string, updateTasks: boolean,
    deviceId: string, now: string): (PersonEditRows & { changed: boolean; result: PersonEditResult }) | null {
    const source = rows.people.find((row) => row.id === id);
    const nextName = normalizePersonName(name);
    if (!source || !nextName) return null;
    if (getPersonNameKey(source.name) === getPersonNameKey(nextName) && source.name === nextName)
        return { ...rows, changed: false, result: { id, personId: id, name: source.name } };
    const destination = selectPersonRenameDestination(rows.people, id, nextName);
    const people = rows.people.map((row) => {
        if (row.id === id) return { ...row, ...(destination ? { deletedAt: now } : { name: nextName }),
            updatedAt: now, rev: nextRevision(row.rev), revBy: deviceId };
        if (row.id === destination?.id) return { ...row, note: row.note ?? source.note,
            referenceLink: row.referenceLink ?? source.referenceLink,
            updatedAt: now, rev: nextRevision(row.rev), revBy: deviceId };
        return row;
    });
    const oldKey = getPersonNameKey(source.name);
    const tasks = updateTasks ? rows.tasks.map((row) => row.deletedAt || getPersonNameKey(row.assignedTo) !== oldKey
        ? row : { ...row, assignedTo: nextName, updatedAt: now, rev: nextRevision(row.rev), revBy: deviceId }) : rows.tasks;
    return { people, tasks, changed: true, result: { id, personId: destination?.id ?? id,
        name: destination?.name ?? nextName } };
}


export function planPersonEditorSave(rows: PersonEditRows, id: string,
    draft: { name: string; note: string; referenceLink: string }, deviceId: string,
    updateAt: string, renameAt: string | null): (PersonEditRows & { metadata: boolean; renamed: boolean;
        result: PersonEditResult; effect: PersonEditEffect }) | null {
    const source = rows.people.find((row) => row.id === id);
    if (!source) return null;
    const writes = planManageEditorSave({ type: 'person', id, name: source.name,
        note: source.note, referenceLink: source.referenceLink }, { ...draft, color: '' }, {});
    if (!writes) return null;
    let people = rows.people;
    let tasks = rows.tasks;
    let metadata = false;
    let renamed = false;
    let result = { id, personId: id, name: source.name };
    for (const write of writes) {
        if (write.kind === 'updatePerson') {
            const current = people.find((row) => row.id === id)!;
            const updates = planPersonMetadataUpdates(current, write.updates);
            if (!updates) return null;
            people = people.map((row) => row.id === id ? { ...row, ...updates,
                updatedAt: updateAt, rev: nextRevision(row.rev), revBy: deviceId } : row);
            metadata = true;
        } else if (write.kind === 'renamePerson') {
            const plan = planPersonRename({ people, tasks }, id, write.name, true, deviceId, renameAt ?? updateAt);
            if (!plan) return null;
            people = plan.people; tasks = plan.tasks; renamed = plan.changed; result = plan.result;
        }
    }
    const pairs = <T extends { id: string }>(before: T[], after: T[]) => before.flatMap((row) => {
        const next = after.find((candidate) => candidate.id === row.id);
        return next && next !== row ? [{ before: row, after: next }] : [];
    });
    return { people, tasks, metadata, renamed, result,
        effect: { people: pairs(rows.people, people), tasks: pairs(rows.tasks, tasks) } };
}
