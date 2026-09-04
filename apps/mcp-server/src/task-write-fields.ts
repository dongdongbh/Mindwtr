// Which Task fields the MCP write surface (mindwtr_add_task/mindwtr_update_task) exposes as
// generic per-field input, derived from TASK_SYNC_FIELD_SCHEMA the same way
// apps/cloud/src/server-config.ts derives CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS /
// CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS — so a new synced field doesn't need a hand-edit here to
// reach MCP task creation/updates (see task-field-schemas.ts, which maps these names to Zod
// types).
//
// Package-style import, NOT the relative path task-sync-schema.ts's own sibling schema files
// use for scripts/check-synced-field-parity.ts's benefit: apps/mcp-server's tsconfig sets an
// emitting `rootDir: "src"`, so a relative import reaching outside it breaks `tsc`'s output
// layout (unlike apps/cloud, which never emits). Because of that, this file — unlike
// task-recurrence-fields.ts/shared-api-write-limits.ts — needs `bun install` to resolve and
// so is NOT safe for the parity script's zero-install "native-schema" CI job to import
// directly; task-field-schemas.test.ts is where the real derived field sets get cross-checked
// against TASK_SYNC_FIELD_SCHEMA (see that file for the independent recomputation). The
// exclusion list itself lives in the sibling task-write-field-exclusions.ts specifically so
// the parity script CAN import that one piece directly (see its own header comment).
import { TASK_SYNC_FIELD_SCHEMA } from '@mindwtr/core/task-sync-schema';
import type { Task } from '@mindwtr/core';

import { TASK_WRITE_FIELD_EXCLUSIONS } from './task-write-field-exclusions.js';

export { TASK_WRITE_FIELD_EXCLUSIONS };

// Fields kept as their own hand-written Zod definitions in index.ts (nontrivial validators —
// enums, date patterns, the recurrence union, token-array rules) rather than routed through
// the generic per-field map in task-field-schemas.ts. title/quickAdd are dedicated top-level
// tool inputs on both add and update (matching how the cloud REST API also takes title
// outside its generic props bag); the rest already had working, tested hand-written schemas
// before this derivation existed and gain nothing from being rebuilt generically.
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
    // Link-kind attachments only, with their own merge rule (link-attachments.ts).
    'attachments',
]);

const isDerivedFromSchema = (name: keyof Task): boolean => (
    !DEDICATED_FIELD_NAMES.has(name)
    && !Object.prototype.hasOwnProperty.call(TASK_WRITE_FIELD_EXCLUSIONS, name)
);

/** Fields mindwtr_add_task exposes beyond its dedicated title/quickAdd inputs. */
export const TASK_CREATE_FIELD_NAMES: readonly (keyof Task)[] = TASK_SYNC_FIELD_SCHEMA
    .filter((field) => field.cloudWrite === 'create-patch' && isDerivedFromSchema(field.name))
    .map((field) => field.name);

/** Fields mindwtr_update_task exposes beyond its dedicated id/title inputs. */
export const TASK_PATCH_FIELD_NAMES: readonly (keyof Task)[] = TASK_SYNC_FIELD_SCHEMA
    .filter((field) => (
        (field.cloudWrite === 'create-patch' || field.cloudWrite === 'patch')
        && isDerivedFromSchema(field.name)
    ))
    .map((field) => field.name);

/**
 * Copies every named field present (and not `undefined`) on `input` onto a props object,
 * shared by service.ts (local core adapter) and cloud-service.ts (cloud REST adapter) for the
 * generated create-only fields that need no extra null-handling (unlike buildTaskUpdates'
 * per-field loop for updates, which must decide what "clear this field" means per field).
 */
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
