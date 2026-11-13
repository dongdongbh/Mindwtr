import { describe, expect, it } from 'vitest';
import { serializeBackupData, validateBackupJson } from './backup-transfer';
import { isProjectCalendarReference, normalizeProjectCalendarReference } from './project-calendar-reference-schema';
import { PROJECT_SQLITE_COLUMNS, projectFromSqliteRow, projectToSqliteRow } from './project-sync-schema';
import { normalizeProjectForSyncMerge } from './sync-normalization';
import { normalizeProjectForContentComparison, toComparableSignature } from './sync-signatures';
import { mergeAppDataWithStats } from './sync';
import { getProjectToSectionEligibility } from './project-to-section';
import type { AppData, Project, ProjectCalendarReference } from './types';

const at = '2026-11-01T10:00:00.000Z';
const reference: ProjectCalendarReference = { sourceId: 'feed', uid: 'event', recurrenceId: at,
    sourceName: 'Calendar', title: 'Commitment', start: at, end: '2026-11-01T11:00:00.000Z', allDay: false };
const project: Project = { id: 'project', title: 'Project', status: 'active', color: '#6B7280',
    order: 0, tagIds: [], calendarReference: reference, rev: 1, revBy: 'new', createdAt: at, updatedAt: at };
const data = (row = project): AppData => ({ tasks: [], projects: [row], areas: [], sections: [], settings: {} });
const roundTrip = (row: Project) => projectFromSqliteRow(Object.fromEntries(
    PROJECT_SQLITE_COLUMNS.map((column, index) => [column, projectToSqliteRow(row)[index]])));

describe('Project calendar reference storage', () => {
    it('round-trips snapshots, omission and explicit removal through SQLite cells and backup JSON', () => {
        for (const value of [reference, undefined, null]) {
            const row = { ...project, calendarReference: value };
            expect(roundTrip(row).calendarReference).toEqual(value);
            expect(validateBackupJson(serializeBackupData(data(row))).data?.projects[0].calendarReference).toEqual(value);
        }
        expect(projectFromSqliteRow({ id: 'old', title: 'Old' }).calendarReference).toBeUndefined();
        expect(projectFromSqliteRow({ id: 'invalid', calendarReference: '{broken' }).calendarReference).toBeUndefined();
    });

    it('preserves newer omitted snapshots and removals from older clients in either merge direction', () => {
        for (const value of [reference, null]) {
            const current = data({ ...project, calendarReference: value });
            const old: Project = { ...project, title: 'Old client edit', rev: 2, revBy: 'old', updatedAt: '2026-11-01T10:01:00.000Z' };
            delete old.calendarReference;
            const forward = mergeAppDataWithStats(current, data(old), { nowIso: at });
            const reverse = mergeAppDataWithStats(data(old), current, { nowIso: at });
            expect(forward.data.projects[0]).toMatchObject({ title: 'Old client edit', calendarReference: value });
            expect(reverse.data.projects).toEqual(forward.data.projects);
            const aligned = mergeAppDataWithStats(forward.data, reverse.data, { nowIso: at });
            expect(aligned.stats.projects.conflicts).toBe(0);
            expect(aligned.data.projects).toEqual(forward.data.projects);
        }
    });

    it('keeps an explicit newer removal and converges through SQL and subsequent merges', () => {
        const removed = data({ ...project, calendarReference: null, rev: 2, updatedAt: '2026-11-01T10:01:00.000Z' });
        const merged = mergeAppDataWithStats(data(), removed, { nowIso: at });
        expect(merged.data.projects[0].calendarReference).toBeNull();
        const reopened = data(roundTrip(merged.data.projects[0]));
        expect(mergeAppDataWithStats(data(), reopened, { nowIso: at }).data.projects[0].calendarReference).toBeNull();
        expect(mergeAppDataWithStats(reopened, merged.data, { nowIso: at }).stats.projects.conflicts).toBe(0);
        const signature = (row: Project) => toComparableSignature(normalizeProjectForContentComparison(row));
        expect(signature(project)).not.toBe(signature({ ...project, calendarReference: undefined }));
        expect(signature({ ...project, calendarReference: null })).toBe(signature({ ...project, calendarReference: undefined }));
        expect(normalizeProjectForSyncMerge(normalizeProjectForSyncMerge(project))).toEqual(normalizeProjectForSyncMerge(project));
    });

    it('rejects malformed or unbounded input and normalizes invalid imported fields safely', () => {
        expect(isProjectCalendarReference(reference)).toBe(true);
        expect(isProjectCalendarReference({ ...reference, allDay: true, start: '2026-11-01', end: '2026-11-02' })).toBe(true);
        expect(isProjectCalendarReference({ ...reference, allDay: false, start: '2026-11-01', end: '2026-11-02' })).toBe(false);
        expect(isProjectCalendarReference({ ...reference, allDay: true, start: '2026-02-31', end: '2026-03-02' })).toBe(false);
        expect(isProjectCalendarReference({ ...reference, recurrenceId: 'DATE:2026-11-01' })).toBe(true);
        expect(isProjectCalendarReference({ ...reference, recurrenceId: 'FLOAT:2026-11-01T10:00:00' })).toBe(true);
        for (const patch of [{ uid: '' }, { sourceId: 'x'.repeat(2049) }, { title: 'x'.repeat(1001) },
            { recurrenceId: '' }, { recurrenceId: 'x'.repeat(2049) }, { start: '2026-02-31T00:00:00.000Z' }, { end: '2026-10-31T00:00:00.000Z' },
            { allDay: 1 }, { url: 'https://example.com/private' }]) {
            expect(isProjectCalendarReference({ ...reference, ...patch })).toBe(false);
            expect(normalizeProjectCalendarReference({ ...reference, ...patch })).toBeUndefined();
        }
        expect(normalizeProjectCalendarReference(null)).toBeNull();
        expect(normalizeProjectCalendarReference(undefined)).toBeUndefined();
    });

    it('blocks converting a Project with a reference into a Section', () => {
        expect(getProjectToSectionEligibility({ _allProjects: [project], _allTasks: [], _allSections: [] }, project.id))
            .toEqual({ ok: false, reason: 'source-dates' });
    });
});
