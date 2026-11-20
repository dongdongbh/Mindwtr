import { describe, expect, it } from 'vitest';
import {
    PROJECT_SQLITE_COLUMNS,
} from './sqlite-adapter';
import {
    PROJECT_SYNC_FIELD_SCHEMA,
    PROJECT_SYNC_SCHEMA_FIXTURE,
    PROJECT_SYNC_SCHEMA_VERSION,
    padProjectSqliteCells,
    projectToSqliteRow,
} from './project-sync-schema';
import cloudKitProductionSchema from './cloudkit-production-schema.json';
import { mergeAppDataWithStats } from './sync';
import { validateBackupJson } from './backup-transfer';
import { parseSyncDocument } from './sync-document';
import { sanitizeAppDataForRemote } from './sync-helpers';
import { normalizeProjectForContentComparison } from './sync-signatures';
import type { AppData, Project } from './types';


const sorted = (values: Iterable<string>): string[] => Array.from(values).sort();

describe('Project sync schema contract', () => {
    const fieldNames = PROJECT_SYNC_FIELD_SCHEMA.map((field) => field.name);

    it('has one unique entry and fixture value for every Project field', () => {
        expect(new Set(fieldNames).size).toBe(fieldNames.length);
        expect(Object.keys(PROJECT_SYNC_SCHEMA_FIXTURE).sort()).toEqual(sorted(fieldNames));
        expect(PROJECT_SYNC_SCHEMA_VERSION).toBeGreaterThan(0);
    });

    it('keeps SQLite columns exhaustive', () => {
        const expectedColumns = new Set(
            PROJECT_SYNC_FIELD_SCHEMA
                .map((field) => field.sqliteColumn)
                .filter((column): column is string => column !== null),
        );
        expect(sorted(PROJECT_SQLITE_COLUMNS)).toEqual(sorted(expectedColumns));
    });

    it('includes startDate as an optional, cloud-synced, create-patch-writable field', () => {
        const field = PROJECT_SYNC_FIELD_SCHEMA.find((entry) => entry.name === 'startDate');
        expect(field).toBeDefined();
        expect(field?.nullability).toBe('optional');
        expect(field?.cloudSynced).toBe(true);
        expect(field?.cloudWrite).toBe('create-patch');
        expect(field?.sqliteColumn).toBe('startDate');
        expect(field?.sqliteType).toBe('TEXT');
    });

    it('declares cancellation as an optional synced field deployed to CloudKit production', () => {
        const field = PROJECT_SYNC_FIELD_SCHEMA.find((entry) => entry.name === 'cancelledAt');
        expect(field).toMatchObject({
            nullability: 'optional',
            cloudSynced: true,
            cloudWrite: 'create-patch',
            sqliteColumn: 'cancelledAt',
            sqliteType: 'TEXT',
        });
        expect(cloudKitProductionSchema.records.MindwtrProject.deployed).toContain('cancelledAt');
        expect(cloudKitProductionSchema.records.MindwtrProject.pendingProduction).not.toContain('cancelledAt');
    });

    it('syncs an optional repeat interval and applies newer removal', () => {
        const oldProject: Project = { id: 'project', title: 'Project', status: 'active', color: '#6b7280',
            order: 0, tagIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', rev: 1 };
        const wrap = (project: Project): AppData => ({ tasks: [], projects: [project], sections: [], areas: [], people: [], settings: {} });
        const updated: Project = { ...oldProject, rev: 2, repeatAfterCount: 6, repeatAfterUnit: 'month' };
        const legacy = { ...oldProject, rev: 2, repeatAfterMonths: 6 };
        expect(normalizeProjectForContentComparison(updated)).not.toEqual(normalizeProjectForContentComparison(oldProject));
        expect(normalizeProjectForContentComparison(legacy)).toEqual(normalizeProjectForContentComparison(updated));
        const local = wrap(oldProject);
        const incoming = JSON.parse(JSON.stringify(sanitizeAppDataForRemote(wrap(legacy))));
        expect(incoming.projects[0]).toMatchObject({ repeatAfterCount: 6, repeatAfterUnit: 'month' });
        expect(incoming.projects[0]).not.toHaveProperty('repeatAfterMonths');
        expect(validateBackupJson(JSON.stringify(wrap(legacy)))).toMatchObject({ valid: true, data: { projects: [updated] } });
        expect(parseSyncDocument(wrap({ ...oldProject, repeatAfterCount: 6 }), 'remote')).toMatchObject({ ok: false });
        const merged = mergeAppDataWithStats(local, wrap(legacy)).data;
        expect(merged.projects[0]).toMatchObject({ repeatAfterCount: 6, repeatAfterUnit: 'month' });
        const aligned = mergeAppDataWithStats(merged, incoming);
        expect(aligned.data.projects).toEqual(merged.projects);
        expect(aligned.stats.projects.conflicts).toBe(0);

        const unitChanged: Project = { ...updated, rev: 3, repeatAfterUnit: 'day' };
        expect(mergeAppDataWithStats(merged, wrap(unitChanged)).data.projects[0]).toMatchObject({ repeatAfterCount: 6, repeatAfterUnit: 'day' });

        const cleared: Project & { repeatAfterMonths: number } = {
            ...oldProject, rev: 4, repeatAfterCount: undefined, repeatAfterUnit: undefined, repeatAfterMonths: 6,
        };
        const clearedMerge = mergeAppDataWithStats(merged, wrap(cleared)).data;
        expect(clearedMerge.projects[0]).toMatchObject({ repeatAfterCount: undefined, repeatAfterUnit: undefined });
        expect(clearedMerge.projects[0]).not.toHaveProperty('repeatAfterMonths');
        expect(mergeAppDataWithStats(clearedMerge, wrap(legacy)).data.projects).toEqual(clearedMerge.projects);
    });

    it('maps an older monthly SQLite row to a count and unit', () => {
        const month = { ...PROJECT_SYNC_SCHEMA_FIXTURE, repeatAfterUnit: 'month' as const };
        const cells = projectToSqliteRow(month);
        expect(padProjectSqliteCells(cells.slice(0, -1))).toEqual(cells);
        expect(padProjectSqliteCells(cells.slice(0, -2))?.slice(-2)).toEqual([null, null]);
    });
});
