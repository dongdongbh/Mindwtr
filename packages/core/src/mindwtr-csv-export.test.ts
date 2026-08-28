import { describe, expect, it } from 'vitest';

import { serializeMindwtrCsv } from './mindwtr-csv-export';
import { MINDWTR_CSV_COLUMNS, MINDWTR_CSV_KNOWN_COLUMNS } from './mindwtr-csv-columns';
import { applyMindwtrCsvImport, parseMindwtrCsvImportSource } from './mindwtr-csv-import';
import type { AppData, Project, Recurrence, Section, Task } from './types';

const task = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Draft launch email',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
} as Task);

const project = (overrides: Partial<Project> = {}): Project => ({
    id: 'project-1',
    title: 'Marketing',
    color: '#000000',
    status: 'active',
    order: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
} as Project);

const appData = (overrides: Partial<AppData> = {}): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
    ...overrides,
});

const reimport = (csv: string) => {
    const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    return result.parsedData!;
};

describe('serializeMindwtrCsv', () => {
    it('writes the documented header, and the importer accepts every column of it', () => {
        const header = serializeMindwtrCsv(appData()).split('\n')[0];

        expect(header).toBe(MINDWTR_CSV_COLUMNS.join(','));
        // The column table is shared, so an export can never emit a header the
        // importer would count as unknown.
        for (const column of MINDWTR_CSV_COLUMNS) {
            expect(MINDWTR_CSV_KNOWN_COLUMNS.has(column.toUpperCase())).toBe(true);
        }
    });

    it('round-trips every field the importer preserves', () => {
        const data = appData({
            areas: [{ id: 'area-1', name: 'Work', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }] as AppData['areas'],
            projects: [project({ areaId: 'area-1' })],
            sections: [{ id: 'section-1', projectId: 'project-1', title: 'Launch', order: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }] as Section[],
            tasks: [task({
                projectId: 'project-1',
                sectionId: 'section-1',
                status: 'waiting',
                description: 'Multi-line\ndescription text',
                contexts: ['@phone', '@home'],
                tags: ['#urgent', '#review'],
                assignedTo: 'Alex',
                priority: 'high',
                energyLevel: 'low',
                startTime: '2026-09-01',
                dueDate: '2026-09-05T14:30:00.000Z',
                reviewAt: '2026-09-10',
                location: 'Office',
                order: 5,
                checklist: [
                    { id: 'c1', title: 'Draft copy', isCompleted: true },
                    { id: 'c2', title: 'Get approval', isCompleted: false },
                ],
            })],
        });

        const parsed = reimport(serializeMindwtrCsv(data));

        expect(parsed.areas).toMatchObject([{ name: 'Work' }]);
        expect(parsed.projects).toMatchObject([{ name: 'Marketing' }]);
        expect(parsed.sections).toMatchObject([{ name: 'Launch' }]);
        expect(parsed.tasks).toHaveLength(1);
        expect(parsed.tasks[0]).toMatchObject({
            title: 'Draft launch email',
            description: 'Multi-line\ndescription text',
            status: 'waiting',
            contexts: ['@phone', '@home'],
            tags: ['#urgent', '#review'],
            assignedTo: 'Alex',
            priority: 'high',
            energyLevel: 'low',
            reviewAt: '2026-09-10',
            location: 'Office',
            order: 5,
            createdAt: '2026-08-01T09:00:00.000Z',
            sourceIdentityKind: 'explicit-id',
            sourceId: 'task-1',
        });
        expect(parsed.tasks[0].checklist).toMatchObject([
            { title: 'Draft copy', isCompleted: true },
            { title: 'Get approval', isCompleted: false },
        ]);
        // Date-only stays date-only; a datetime keeps its instant (#797).
        expect(parsed.tasks[0].startTime).toBe('2026-09-01');
        expect(new Date(parsed.tasks[0].dueDate!).toISOString()).toBe('2026-09-05T14:30:00.000Z');
    });

    // D1: the previous version of this test only checked the PARSE output, so it proved the
    // parser was deterministic and never that importing an export leaves the task count alone.
    // Round-trip through applyMindwtrCsvImport or it proves nothing.
    it('re-imports an export onto the same tasks instead of duplicating them', () => {
        const data = appData({ tasks: [task({ id: 'stable-id' }), task({ id: 'other-id', title: 'Second' })] });

        const result = applyMindwtrCsvImport(data, reimport(serializeMindwtrCsv(data)));

        expect(result.data.tasks).toHaveLength(2);
        expect(result.data.tasks.map((item) => item.id).sort()).toEqual(['other-id', 'stable-id']);
    });

    // The importer is add-only: an already-present id is skipped, not updated
    // (import-apply.ts's existingTaskIds check). So an edited export does NOT push the edit
    // back in — it is reported as skipped. Pinned here so the round-trip contract is explicit
    // rather than assumed; changing it to update-in-place is a product decision, not a bug fix.
    // V1: containers round-trip by name, so an unmodified re-import used to add an empty
    // duplicate project and a renamed "<name> (Mindwtr CSV)" area even though every task was
    // skipped. Zero new entities of ANY kind is the contract.
    it('adds nothing at all when an unmodified export is re-imported', () => {
        const data = appData({
            areas: [{ id: 'area-1', name: 'Work', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }] as AppData['areas'],
            projects: [project({ areaId: 'area-1' })],
            sections: [{ id: 'section-1', projectId: 'project-1', title: 'Launch', order: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }] as Section[],
            tasks: [task({ id: 'stable-id', projectId: 'project-1', sectionId: 'section-1' })],
        });

        const result = applyMindwtrCsvImport(data, reimport(serializeMindwtrCsv(data)));

        expect(result.data.tasks).toHaveLength(1);
        expect(result.data.projects).toHaveLength(1);
        expect(result.data.sections).toHaveLength(1);
        expect(result.data.areas).toHaveLength(1);
        expect(result.data.areas.map((area) => area.name)).toEqual(['Work']);
        expect(result.data.projects.map((item) => item.title)).toEqual(['Marketing']);
    });

    // V1 correction: the container carry read a live task's project without checking either
    // was alive, so a re-import could orphan a NEW row into a project the user had deleted.
    it('never carries a container from a tombstoned task or into a deleted project', () => {
        const data = appData({
            projects: [project({ deletedAt: '2026-08-02T00:00:00.000Z' })],
            tasks: [
                task({ id: 'gone', title: 'Old', projectId: 'project-1', deletedAt: '2026-08-02T00:00:00.000Z' }),
                task({ id: 'fresh', title: 'New' }),
            ],
        });
        const csv = serializeMindwtrCsv(appData({
            projects: [project()],
            tasks: [task({ id: 'gone', title: 'Old', projectId: 'project-1' }), task({ id: 'added', title: 'Added', projectId: 'project-1' })],
        }));

        const result = applyMindwtrCsvImport(data, reimport(csv));

        const added = result.data.tasks.find((item) => item.title === 'Added');
        expect(added?.projectId).toBeDefined();
        const landedIn = result.data.projects.find((item) => item.id === added?.projectId);
        expect(landedIn?.deletedAt).toBeUndefined();
    });

    // V1 correction: the carry was first-wins, so when one task had moved to another project
    // the destination of new rows depended on CSV row order. Disagreement drops the carry.
    it('does not let row order decide where a moved task redirects new rows', () => {
        const exported = appData({
            projects: [project({ id: 'proj-alpha', title: 'Alpha' }), project({ id: 'proj-beta', title: 'Beta' })],
            tasks: [
                task({ id: 't1', title: 'One', projectId: 'proj-alpha' }),
                task({ id: 't2', title: 'Two', projectId: 'proj-alpha' }),
                task({ id: 't3', title: 'Three', projectId: 'proj-alpha' }),
            ],
        });
        const live = appData({
            projects: exported.projects,
            // t1 has since moved to Beta; t3 does not exist yet.
            tasks: [task({ id: 't1', title: 'One', projectId: 'proj-beta' }), task({ id: 't2', title: 'Two', projectId: 'proj-alpha' })],
        });

        const forward = serializeMindwtrCsv(exported);
        const lines = forward.split('\n');
        const reversed = [lines[0], ...lines.slice(1).reverse()].join('\n');

        const landed = (csv: string) => {
            const result = applyMindwtrCsvImport(live, reimport(csv));
            const three = result.data.tasks.find((item) => item.title === 'Three');
            expect(three?.projectId).toBeDefined();
            return result.data.projects.find((item) => item.id === three?.projectId)?.title;
        };

        expect(landed(forward)).toBe(landed(reversed));
        expect(landed(forward)).not.toBe('Beta');
    });

    // Section carry: once a CSV import has created the containers, their ids ARE the derived
    // ids, so a later re-import resolves the project by derivation while the section carry
    // still points at wherever a matched task has since moved — pairing this row's project
    // with another project's section, a state the app cannot otherwise produce.
    it('never pairs a resolved project with another project\'s section', () => {
        const csv = serializeMindwtrCsv(appData({ tasks: [task({ id: 't1', title: 'One' })] }))
            .replace('One,,next,,,', 'One,,next,Alpha,Sprint,');

        // Seed: the first import mints Alpha and Sprint under derived ids.
        const seeded = applyMindwtrCsvImport(appData({}), reimport(csv));
        const alpha = seeded.data.projects[0];
        const sprint = seeded.data.sections[0];
        expect(sprint?.projectId).toBe(alpha?.id);

        // The user then moves that task to a different project and section.
        const live = appData({
            projects: [alpha, project({ id: 'proj-beta', title: 'Beta' })],
            sections: [sprint, { id: 'sec-s2', projectId: 'proj-beta', title: 'Backlog', order: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }] as unknown as Section[],
            tasks: seeded.data.tasks.map((item) => ({ ...item, projectId: 'proj-beta', sectionId: 'sec-s2' })),
        });

        const withNewRow = `${csv}\nThree,,next,Alpha,Sprint,,,,,,,,,,,,,0,t3,2026-08-01T00:00:00.000Z`;
        const result = applyMindwtrCsvImport(live, reimport(withNewRow));

        const three = result.data.tasks.find((item) => item.title === 'Three');
        expect(three?.projectId).toBeDefined();
        expect(three?.sectionId).not.toBe('sec-s2');
        if (three?.sectionId) {
            const section = result.data.sections.find((item) => item.id === three.sectionId);
            expect(section?.projectId).toBe(three.projectId);
        }
    });

    it('skips rather than duplicates a re-imported export whose fields were edited', () => {
        const data = appData({ tasks: [task({ id: 'stable-id', title: 'Before' })] });
        const edited = serializeMindwtrCsv(data).replace('Before', 'After');

        const result = applyMindwtrCsvImport(data, reimport(edited));

        expect(result.data.tasks).toHaveLength(1);
        expect(result.data.tasks[0]).toMatchObject({ id: 'stable-id', title: 'Before' });
        expect(result.warnings.join(' ')).toContain('already imported');
    });

    it('survives quotes, delimiters, newlines and CJK in text', () => {
        const title = 'Say "hello", 你好\nand more; done';
        const parsed = reimport(serializeMindwtrCsv(appData({ tasks: [task({ title, location: 'a;b,c' })] })));

        expect(parsed.tasks[0].title).toBe(title);
        expect(parsed.tasks[0].location).toBe('a;b,c');
    });

    it('round-trips through a semicolon delimiter too', () => {
        const parsed = reimport(serializeMindwtrCsv(
            appData({ tasks: [task({ title: 'Comma, inside', location: 'x;y' })] }),
            { delimiter: ';' },
        ));

        expect(parsed.tasks[0].title).toBe('Comma, inside');
        expect(parsed.tasks[0].location).toBe('x;y');
    });

    it('never exports tombstones, which the CSV format cannot represent', () => {
        const data = appData({
            tasks: [
                task({ id: 'live' }),
                task({ id: 'deleted', title: 'Soft deleted', deletedAt: '2026-08-02T00:00:00.000Z' }),
                task({ id: 'purged', title: 'Purged', deletedAt: '2026-08-02T00:00:00.000Z', purgedAt: '2026-08-03T00:00:00.000Z' }),
            ],
        });

        const parsed = reimport(serializeMindwtrCsv(data));

        // Otherwise re-importing an export would resurrect deleted tasks.
        expect(parsed.tasks.map((item) => item.sourceId)).toEqual(['live']);
    });

    it('drops a section whose project was deleted, matching what import would do', () => {
        const data = appData({
            projects: [project({ deletedAt: '2026-08-02T00:00:00.000Z' })],
            sections: [{ id: 'section-1', projectId: 'project-1', title: 'Launch', order: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }] as Section[],
            tasks: [task({ projectId: 'project-1', sectionId: 'section-1' })],
        });

        const parsed = reimport(serializeMindwtrCsv(data));

        expect(parsed.projects).toEqual([]);
        expect(parsed.sections).toEqual([]);
        expect(parsed.tasks[0].projectSourceKey).toBeUndefined();
    });

    // Every family the recurrence editors can produce, pinned as an exact cell AND as the
    // recurrence the importer reads back out of it. Anything the RRULE subset cannot carry
    // (seriesId, occurrence counters, clamped anchor days) is dropped on purpose: an
    // imported task starts a fresh series.
    const RECURRENCE_MATRIX: Array<{ name: string; recurrence: Recurrence; cell: string; imported: Recurrence }> = [
        {
            name: 'daily',
            recurrence: { rule: 'daily' },
            cell: 'FREQ=DAILY',
            imported: { rule: 'daily', rrule: 'FREQ=DAILY' },
        },
        {
            name: 'every 3 days after completion',
            recurrence: { rule: 'daily', strategy: 'fluid', rrule: 'FREQ=DAILY;INTERVAL=3' },
            cell: 'FREQ=DAILY;INTERVAL=3;X-MINDWTR-STRATEGY=FLUID',
            imported: { rule: 'daily', strategy: 'fluid', rrule: 'FREQ=DAILY;INTERVAL=3' },
        },
        {
            name: 'weekly on two weekdays',
            recurrence: { rule: 'weekly', byDay: ['MO', 'WE'], rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' },
            cell: 'FREQ=WEEKLY;BYDAY=MO,WE',
            imported: { rule: 'weekly', byDay: ['MO', 'WE'], rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' },
        },
        {
            name: 'fortnightly with an explicit week start',
            recurrence: { rule: 'weekly', byDay: ['SU'], weekStart: 'MO', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;WKST=MO' },
            cell: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;WKST=MO',
            imported: { rule: 'weekly', byDay: ['SU'], weekStart: 'MO', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;WKST=MO' },
        },
        {
            name: 'monthly on days of the month',
            recurrence: { rule: 'monthly', byMonthDay: [1, 15], rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15' },
            cell: 'FREQ=MONTHLY;BYMONTHDAY=1,15',
            imported: { rule: 'monthly', byMonthDay: [1, 15], rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15' },
        },
        {
            name: 'monthly on the nth weekday',
            recurrence: { rule: 'monthly', byDay: ['2TU'], rrule: 'FREQ=MONTHLY;BYDAY=2TU' },
            cell: 'FREQ=MONTHLY;BYDAY=2TU',
            imported: { rule: 'monthly', byDay: ['2TU'], rrule: 'FREQ=MONTHLY;BYDAY=2TU' },
        },
        {
            name: 'monthly on the last weekday',
            recurrence: { rule: 'monthly', byDay: ['-1FR'], strategy: 'fluid', rrule: 'FREQ=MONTHLY;BYDAY=-1FR' },
            cell: 'FREQ=MONTHLY;BYDAY=-1FR;X-MINDWTR-STRATEGY=FLUID',
            imported: { rule: 'monthly', byDay: ['-1FR'], strategy: 'fluid', rrule: 'FREQ=MONTHLY;BYDAY=-1FR' },
        },
        {
            name: 'every other year',
            recurrence: { rule: 'yearly', rrule: 'FREQ=YEARLY;INTERVAL=2' },
            cell: 'FREQ=YEARLY;INTERVAL=2',
            imported: { rule: 'yearly', rrule: 'FREQ=YEARLY;INTERVAL=2' },
        },
        {
            name: 'a counted series',
            recurrence: { rule: 'daily', count: 5, completedOccurrences: 2, seriesId: 'series-a', rrule: 'FREQ=DAILY;COUNT=5' },
            cell: 'FREQ=DAILY;COUNT=5',
            imported: { rule: 'daily', count: 5, rrule: 'FREQ=DAILY;COUNT=5' },
        },
        {
            name: 'a series ending on a date',
            recurrence: { rule: 'weekly', until: '2026-12-31', rrule: 'FREQ=WEEKLY' },
            cell: 'FREQ=WEEKLY;UNTIL=20261231',
            imported: { rule: 'weekly', until: '2026-12-31', rrule: 'FREQ=WEEKLY;UNTIL=20261231' },
        },
        {
            name: 'a series ending at an instant',
            recurrence: { rule: 'weekly', until: '2026-12-31T17:00:00.000Z', rrule: 'FREQ=WEEKLY' },
            cell: 'FREQ=WEEKLY;UNTIL=20261231T170000Z',
            imported: { rule: 'weekly', until: '2026-12-31T17:00:00.000Z', rrule: 'FREQ=WEEKLY;UNTIL=20261231T170000Z' },
        },
    ];

    // Tab-delimited so the cell is never quote-wrapped and can be compared literally;
    // BYDAY/BYMONTHDAY lists would otherwise be quoted for their commas.
    const recurrenceCell = (recurrence?: Task['recurrence']): string => {
        const rows = serializeMindwtrCsv(appData({ tasks: [task({ recurrence })] }), { delimiter: '\t' }).split('\n');
        return rows[1].split('\t')[rows[0].split('\t').indexOf('Recurrence')];
    };

    it.each(RECURRENCE_MATRIX)('round-trips recurrence: $name', ({ recurrence, cell, imported }) => {
        expect(recurrenceCell(recurrence)).toBe(cell);
        expect(reimport(serializeMindwtrCsv(appData({ tasks: [task({ recurrence })] }))).tasks[0].recurrence)
            .toEqual(imported);
    });

    it('leaves the Recurrence cell empty for a task that does not repeat', () => {
        expect(recurrenceCell()).toBe('');
        expect(reimport(serializeMindwtrCsv(appData({ tasks: [task()] }))).tasks[0].recurrence).toBeUndefined();
    });

    it('normalizes a legacy bare-string recurrence into a rule the importer reads', () => {
        const csv = serializeMindwtrCsv(appData({ tasks: [task({ recurrence: 'weekly' })] }));

        expect(reimport(csv).tasks[0].recurrence).toEqual({ rule: 'weekly', rrule: 'FREQ=WEEKLY' });
    });
});

// #1096: a view exports what it currently shows. The subset narrows the ROWS
// only — every lookup table still comes from the full AppData.
describe('serializeMindwtrCsv with a task subset', () => {
    const titles = (csv: string) => csv.split('\n').slice(1).map((row) => row.split(',')[0]);

    const filterableData = () => appData({
        areas: [{ id: 'area-1', name: 'Work', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }] as AppData['areas'],
        projects: [project({ areaId: 'area-1' })],
        sections: [{ id: 'section-1', projectId: 'project-1', title: 'Launch', order: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }] as Section[],
        tasks: [
            task({ id: 'kept', title: 'Kept', projectId: 'project-1', sectionId: 'section-1', contexts: ['@customer1'] }),
            task({ id: 'dropped', title: 'Dropped', projectId: 'project-1', contexts: ['@other'] }),
        ],
    });

    it('writes only the given tasks', () => {
        const data = filterableData();
        const kept = data.tasks.filter((item) => item.contexts?.includes('@customer1'));

        expect(titles(serializeMindwtrCsv(data, { tasks: kept }))).toEqual(['Kept']);
    });

    it('still resolves project, section and inherited area from the full dataset', () => {
        const data = filterableData();
        const csv = serializeMindwtrCsv(data, { tasks: [data.tasks[0]] });
        const header = csv.split('\n')[0].split(',');
        const cells = csv.split('\n')[1].split(',');

        expect(csv.split('\n')).toHaveLength(2);
        expect(cells[header.indexOf('Project')]).toBe('Marketing');
        expect(cells[header.indexOf('Section')]).toBe('Launch');
        expect(cells[header.indexOf('Area')]).toBe('Work');
    });

    it('keeps the caller ordering', () => {
        const data = filterableData();

        expect(titles(serializeMindwtrCsv(data, { tasks: [data.tasks[1], data.tasks[0]] })))
            .toEqual(['Dropped', 'Kept']);
    });

    it('still drops tombstones from the subset', () => {
        const data = filterableData();
        const deleted = task({ id: 'gone', title: 'Gone', deletedAt: '2026-08-02T00:00:00.000Z' });

        expect(titles(serializeMindwtrCsv(data, { tasks: [data.tasks[0], deleted] }))).toEqual(['Kept']);
    });

    it('exports the whole dataset, byte for byte, when no subset is given', () => {
        const data = filterableData();

        expect(serializeMindwtrCsv(data, {})).toBe(serializeMindwtrCsv(data));
        expect(titles(serializeMindwtrCsv(data))).toEqual(['Kept', 'Dropped']);
    });
});
