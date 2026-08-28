// Fields TASK_SYNC_FIELD_SCHEMA marks client-writable (cloudWrite 'create-patch' or 'patch')
// that the MCP write surface (task-write-fields.ts) deliberately does NOT expose as generic
// per-field tool input, each with a one-line reason — no silent gaps.
//
// Split out from task-write-fields.ts (which also needs a `@mindwtr/core/task-sync-schema`
// import that requires `bun install` to resolve — safe for apps/mcp-server's own build, but
// not for scripts/check-synced-field-parity.ts's "native-schema" CI job, which runs with no
// node_modules at all) so that script can check this list for staleness on its own. The only
// import here is `import type`, which TypeScript erases entirely before execution — nothing
// for that job's zero-install environment to resolve.
import type { Task } from '@mindwtr/core';

export const TASK_WRITE_FIELD_EXCLUSIONS: Readonly<Partial<Record<keyof Task, string>>> = {
    attachments: 'MCP tools have no file-upload/byte-transport path; attachments need real '
        + 'file bytes this text interface cannot supply.',
    orderNum: 'Legacy alias of `order` (same SQLite column) — this surface exposes only '
        + '`order` to avoid two keys writing one value.',
    viewSectionIds: 'Presentational per-view grouping whose section ids live in a settings '
        + 'catalogue this surface cannot enumerate or create, so a raw id map would be '
        + 'unusable from a tool call (#1090).',
};
