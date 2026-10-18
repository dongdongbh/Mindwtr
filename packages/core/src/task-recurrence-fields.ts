// Single home for the recurrence object's field-key allowlist. Before this file existed,
// the same 14 keys were hand-written twice: as a runtime Set in
// apps/cloud/src/server-validation.ts (CLOUD_RECURRENCE_ALLOWED_KEYS) and as the key set of
// a zod object in apps/mcp-server/src/input-validation.ts (recurrenceObjectSchema) — kept in
// sync only by developer care. Zod itself needs each key's *type*, not just its name, so this
// array can't replace the zod object outright; it's the shared source for the NAME list both
// sides validate their own key set against (see recurrenceObjectSchema's consolidation test).
//
// Zero external dependencies, so this stays safe to import from anywhere, including any
// future zero-install CI script (see task-sync-schema.ts's header comment for why that matters
// to sibling schema files in this directory).
export const TASK_RECURRENCE_FIELD_KEYS: readonly string[] = [
    'rule',
    'seriesId',
    'strategy',
    'preserveChecklistOnRepeat',
    'byDay',
    'byMonthDay',
    'weekStart',
    'count',
    'until',
    'completedOccurrences',
    'anchorDay',
    'startAnchorDay',
    'dueAnchorDay',
    'reviewAnchorDay',
    'rrule',
];
