import { describe, expect, it } from 'vitest';
import {
    PROJECT_SQLITE_COLUMNS,
} from './sqlite-adapter';
import {
    PROJECT_SYNC_FIELD_SCHEMA,
    PROJECT_SYNC_SCHEMA_FIXTURE,
    PROJECT_SYNC_SCHEMA_VERSION,
} from './project-sync-schema';
import cloudKitProductionSchema from './cloudkit-production-schema.json';


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
});
