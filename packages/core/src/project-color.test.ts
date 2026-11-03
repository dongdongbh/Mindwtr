import { describe, expect, it } from 'vitest';
import { serializeBackupData, validateBackupJson } from './backup-transfer';
import { PROJECT_SQLITE_COLUMNS, projectFromSqliteRow, projectToSqliteRow } from './project-sync-schema';
import { normalizeProjectForSyncMerge, repairMergedSyncReferences } from './sync-normalization';
import { mergeAppDataWithStats } from './sync';
import { getProjectAccentColor } from './task-accent-color';
import type { AppData, Project } from './types';

const at = '2026-10-20T10:00:00.000Z';
const project: Project = { id: 'p', title: 'Project', status: 'active', color: '#3b82f6',
    colorOverride: '#3b82f6', areaId: 'a', areaTitle: 'Area', order: 0, tagIds: [],
    rev: 2, revBy: 'updated-peer', createdAt: at, updatedAt: at };
const data = (row = project): AppData => ({ tasks: [], projects: [row], sections: [], people: [],
    areas: [{ id: 'a', name: 'Area', color: '#ef4444', order: 0, rev: 3, revBy: 'other-peer', createdAt: at, updatedAt: at }], settings: {} });
const roundTrip = (row: Project) => projectFromSqliteRow(Object.fromEntries(
    PROJECT_SQLITE_COLUMNS.map((column, i) => [column, projectToSqliteRow(row)[i]])));

describe('Project color persistence and merge', () => {
    it('round-trips an explicit choice and reset through SQL cells and backup JSON', () => {
        expect(roundTrip(project).colorOverride).toBe('#3b82f6');
        expect(roundTrip({ ...project, colorOverride: null }).colorOverride).toBeUndefined();
        const backup = validateBackupJson(serializeBackupData(data()));
        expect(backup.data!.projects[0].colorOverride).toBe('#3b82f6');
        const reset = validateBackupJson(serializeBackupData(data({ ...project, colorOverride: null })));
        expect(reset.data!.projects[0].colorOverride ?? null).toBeNull();
    });

    it('converges updated peers after an Area-only change and a newer explicit reset', () => {
        const local = data();
        const changedArea = { ...local, areas: local.areas.map((area) => ({ ...area, color: '#10b981', rev: 4 })) };
        const first = mergeAppDataWithStats(local, changedArea, { nowIso: at });
        expect(first.data.projects[0].colorOverride).toBe('#3b82f6');
        expect(getProjectAccentColor(first.data.projects[0], new Map(first.data.areas.map((a) => [a.id, a])))).toBe('#3b82f6');
        const reset = data({ ...project, colorOverride: null, color: '#10b981', rev: 3, updatedAt: '2026-10-20T10:01:00.000Z' });
        const merged = mergeAppDataWithStats(first.data, reset, { nowIso: '2026-10-20T10:02:00.000Z' });
        expect(merged.data.projects[0].colorOverride ?? null).toBeNull();
        const aligned = mergeAppDataWithStats(merged.data, merged.data, { nowIso: '2026-10-20T10:02:00.000Z' });
        expect(aligned.stats.projects.conflicts).toBe(0);
        expect(aligned.data.projects).toEqual(merged.data.projects);
        expect(normalizeProjectForSyncMerge(normalizeProjectForSyncMerge(project))).toEqual(normalizeProjectForSyncMerge(project));
    });

    it('accepts an older writer without resurrecting an override that it stripped', () => {
        const old = { ...project, rev: 4, updatedAt: '2026-10-20T10:01:00.000Z' };
        delete old.colorOverride;
        const merged = mergeAppDataWithStats(data(), data(old), { nowIso: '2026-10-20T10:02:00.000Z' });
        expect(merged.data.projects[0].colorOverride).toBeUndefined();
        expect(mergeAppDataWithStats(merged.data, merged.data).stats.projects.conflicts).toBe(0);
    });

    it('detaches an inherited Project after Area deletion without manufacturing a legacy fallback', () => {
        const inherited = { ...project, colorOverride: null };
        const source = data(inherited);
        source.areas[0].deletedAt = at;
        const repaired = repairMergedSyncReferences(source, at);
        expect(repaired.projects[0]).toMatchObject({ areaId: undefined, color: '#94a3b8' });
        expect(getProjectAccentColor(repaired.projects[0], new Map())).toBeUndefined();
        expect(repairMergedSyncReferences(repaired, at).projects).toEqual(repaired.projects);
        source.projects = [project];
        expect(repairMergedSyncReferences(source, at).projects[0].colorOverride).toBe('#3b82f6');
    });
});
