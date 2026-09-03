import { describe, expect, it } from 'vitest';
import { TASK_SYNC_FIELD_SCHEMA } from '@mindwtr/core/task-sync-schema';
import { PROJECT_SYNC_FIELD_SCHEMA } from '@mindwtr/core/project-sync-schema';
import { SECTION_SYNC_FIELD_SCHEMA } from '@mindwtr/core/section-sync-schema';
import {
    CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS,
    CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS,
    CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS,
    CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS,
    MAX_AREA_NAME_LENGTH,
    parseArgs,
} from './server-config';

describe('parseArgs', () => {
    // apps/mcp-server/src/flags.ts's parseArgs already accepted this form; cloud's own copy
    // silently ignored it (a `--port=8787` in an env/script invocation was read as if `--port`
    // had no value at all, falling back to the default instead of erroring or applying it).
    it('accepts --key=value flags alongside the existing --key value form', () => {
        expect(parseArgs(['--port=9000', '--host', '0.0.0.0', '--verbose'])).toEqual({
            port: '9000',
            host: '0.0.0.0',
            verbose: true,
        });
    });

    it('treats an empty --key= as an explicit empty string, not "flag with no value"', () => {
        expect(parseArgs(['--token='])).toEqual({ token: '' });
    });
});

describe('area name length limit', () => {
    it('is aligned with apps/mcp-server (200), not the old reused 500-char task-title cap', () => {
        expect(MAX_AREA_NAME_LENGTH).toBe(200);
    });
});

const sorted = (values: Iterable<string>): string[] => Array.from(values).sort();

describe('cloud Task schema contract', () => {
    it('keeps creation validation aligned with schema write semantics', () => {
        const expected = TASK_SYNC_FIELD_SCHEMA
            .filter((field) => field.cloudWrite === 'create-patch')
            .map((field) => field.name);

        expect(sorted(CLOUD_TASK_CREATION_ALLOWED_PROP_KEYS)).toEqual(sorted(expected));
    });

    it('keeps patch validation aligned with schema write semantics', () => {
        const expected = TASK_SYNC_FIELD_SCHEMA
            .filter((field) => field.cloudWrite === 'create-patch' || field.cloudWrite === 'patch')
            .map((field) => field.name);

        expect(sorted(CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS)).toEqual(sorted(expected));
    });
});

// Frozen snapshot of the pre-refactor hand-written literals (parity-entities follow-up to the
// 2026-07-20 generative-schema refactor). CLOUD_PROJECT_*/CLOUD_SECTION_* allowlists are now
// derived from PROJECT_SYNC_FIELD_SCHEMA / SECTION_SYNC_FIELD_SCHEMA's cloudWrite flag instead
// of hand-maintained Sets. Do not update these lists to match a schema change — grow the
// schema and leave this alone; these snapshots cover the unchanged entity descriptors only.
const PRE_REFACTOR_CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS = [
    'status', 'color', 'order', 'tagIds', 'isSequential', 'taskSortBy', 'isFocused',
    'supportNotes', 'attachments', 'startDate', 'dueDate', 'reviewAt', 'areaId', 'areaTitle',
];

const PRE_REFACTOR_CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS = [
    'title', 'deletedAt', 'purgedAt',
    ...PRE_REFACTOR_CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS,
];

const PRE_REFACTOR_CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS = [
    'description', 'order', 'isCollapsed',
];

const PRE_REFACTOR_CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS = [
    'projectId', 'title',
    ...PRE_REFACTOR_CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS,
];

describe('cloud Project schema contract', () => {
    it('keeps creation validation aligned with schema write semantics', () => {
        const expected = PROJECT_SYNC_FIELD_SCHEMA
            .filter((field) => field.cloudWrite === 'create-patch')
            .map((field) => field.name);

        expect(sorted(CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS)).toEqual(sorted(expected));
    });

    it('keeps patch validation aligned with schema write semantics', () => {
        const expected = PROJECT_SYNC_FIELD_SCHEMA
            .filter((field) => field.cloudWrite === 'create-patch' || field.cloudWrite === 'patch')
            .map((field) => field.name);

        expect(sorted(CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS)).toEqual(sorted(expected));
    });

    it('derives CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS identical to the pre-refactor literal', () => {
        expect(sorted(CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS)).toEqual(sorted(PRE_REFACTOR_CLOUD_PROJECT_CREATION_ALLOWED_PROP_KEYS));
    });

    it('derives CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS identical to the pre-refactor literal', () => {
        expect(sorted(CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS)).toEqual(sorted(PRE_REFACTOR_CLOUD_PROJECT_PATCH_ALLOWED_PROP_KEYS));
    });
});

describe('cloud Section schema contract', () => {
    it('keeps creation validation aligned with schema write semantics', () => {
        const expected = SECTION_SYNC_FIELD_SCHEMA
            .filter((field) => field.cloudWrite === 'create-patch')
            .map((field) => field.name);

        expect(sorted(CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS)).toEqual(sorted(expected));
    });

    it('keeps patch validation aligned with schema write semantics', () => {
        const expected = SECTION_SYNC_FIELD_SCHEMA
            .filter((field) => field.cloudWrite === 'create-patch' || field.cloudWrite === 'patch')
            .map((field) => field.name);

        expect(sorted(CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS)).toEqual(sorted(expected));
    });

    it('derives CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS identical to the pre-refactor literal', () => {
        expect(sorted(CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS)).toEqual(sorted(PRE_REFACTOR_CLOUD_SECTION_CREATION_ALLOWED_PROP_KEYS));
    });

    it('derives CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS identical to the pre-refactor literal', () => {
        expect(sorted(CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS)).toEqual(sorted(PRE_REFACTOR_CLOUD_SECTION_PATCH_ALLOWED_PROP_KEYS));
    });
});
