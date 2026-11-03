


import { TASK_SYNC_FIELD_SCHEMA } from '@mindwtr/core/task-sync-schema';
import type { Task } from '@mindwtr/core';

import { TASK_WRITE_FIELD_EXCLUSIONS } from './task-write-field-exclusions.js';

export { TASK_WRITE_FIELD_EXCLUSIONS };


const DEDICATED_FIELD_NAMES = new Set<keyof Task>([
    'title',
    'status',
    'priority',
    'energyLevel',
    'assignedTo',
    'startTime',
    'dueDate',
    'recurrence',
    'tags',
    'contexts',
    'description',
    'projectId',
    'sectionId',
    'timeEstimate',

    'attachments',
]);

const isDerivedFromSchema = (name: keyof Task): boolean => (
    !DEDICATED_FIELD_NAMES.has(name)
    && !Object.prototype.hasOwnProperty.call(TASK_WRITE_FIELD_EXCLUSIONS, name)
);


export const TASK_CREATE_FIELD_NAMES: readonly (keyof Task)[] = TASK_SYNC_FIELD_SCHEMA
    .filter((field) => field.cloudWrite === 'create-patch' && isDerivedFromSchema(field.name))
    .map((field) => field.name);


export const TASK_PATCH_FIELD_NAMES: readonly (keyof Task)[] = TASK_SYNC_FIELD_SCHEMA
    .filter((field) => (
        (field.cloudWrite === 'create-patch' || field.cloudWrite === 'patch')
        && isDerivedFromSchema(field.name)
    ))
    .map((field) => field.name);


export const pickDefinedTaskFields = (
    names: readonly (keyof Task)[],
    input: Record<string, unknown>,
): Partial<Task> => {
    const props: Record<string, unknown> = {};
    for (const name of names) {
        const value = input[name];
        if (value !== undefined) props[name] = value;
    }
    return props as Partial<Task>;
};
