import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
    applyMindwtrCsvImport,
    parseMindwtrCsvImportSource,
    type ParsedMindwtrCsvImportData,
} from './mindwtr-csv-import';
import { createImportDiagnostics, formatImportDiagnostic } from './import-diagnostics';
import { formatI18nTemplate, getTranslator } from './i18n';
import { mockAppData } from './sync-test-utils';
import { withQuickJsArgumentLimit } from './quickjs-test-utils';
import { generateDeterministicUUID } from './uuid';

const quoteCell = (cell: string): string => `"${cell.replace(/"/gu, '""')}"`;

const buildCsv = (headers: string[], rows: string[][], delimiter = ','): string => (
    [headers, ...rows].map((row) => row.map(quoteCell).join(delimiter)).join('\n')
);

const FULL_HEADERS = [
    'Title', 'Description', 'Status', 'Project', 'Section', 'Area', 'Contexts', 'Tags',
    'Assigned To', 'Priority', 'Energy', 'Start Date', 'Due Date', 'Review Date',
    'Completed At', 'Checklist', 'Location', 'Order', 'ID', 'Created At',
];

describe('mindwtr csv import', () => {
    const translate = (key: string, params?: Record<string, number | string>) => formatI18nTemplate(getTranslator('en')(key), params ?? {});

    it('counts blank CSV records in diagnostic locations while preserving import row identities', () => {
        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: 'Title,Due Date\r\n\r\n"Example\ncontinued",invalid-date\r\n' });
        expect(result.valid).toBe(true);
        expect(result.parsedData?.tasks[0].sourceId).toBe('row-2');
        const diagnostic = createImportDiagnostics(result.warnings, 'warning')[0];
        expect(diagnostic.params).toEqual({ count: 1, locations: '0:3:2', omittedLocations: 0 });
        expect(formatImportDiagnostic(diagnostic, translate)).toContain('row 3, column 2');
    });

    it('localizes bounded unknown-header and date locations without source contents or physical-line numbering', () => {
        const result = parseMindwtrCsvImportSource({ fileName: 'private-file.csv', text: buildCsv(
            ['Title', 'Due Date', ...Array.from({ length: 7 }, (_, index) => `private-header-${index}`)],
            Array.from({ length: 7 }, (_, index) => [`private-title-${index}\ncontinued`, `private-date-${index}`, ...Array(7).fill('private-cell')]),
        ) });
        expect(result.valid).toBe(true);
        expect(result.parsedData?.tasks).toHaveLength(7);
        expect(result.parsedData?.tasks.every((task) => task.dueDate === undefined)).toBe(true);
        const diagnostics = createImportDiagnostics(result.warnings, 'warning');
        expect(diagnostics).toEqual([
            { code: 'unknown-columns', severity: 'warning', params: { count: 7, locations: '0:1:3,0:1:4,0:1:5,0:1:6,0:1:7', omittedLocations: 2 } },
            { code: 'unmapped-date', severity: 'warning', params: { count: 7, locations: '0:2:2,0:3:2,0:4:2,0:5:2,0:6:2', omittedLocations: 2 } },
        ]);
        const formatted = diagnostics.map((diagnostic) => formatImportDiagnostic(diagnostic, translate));
        expect(formatted[0]).toBe('7 unknown column(s) were ignored. Locations (CSV records; header = row 1): row 1, column 3; row 1, column 4; row 1, column 5; row 1, column 6; row 1, column 7. 2 more location(s) not shown.');
        expect(formatted[1]).toBe('7 date value(s) could not be mapped and were omitted. Locations (CSV records; header = row 1): row 2, column 2; row 3, column 2; row 4, column 2; row 5, column 2; row 6, column 2. 2 more location(s) not shown.');
        expect(JSON.stringify([result.warnings, diagnostics, formatted])).not.toContain('private-');
    });

    it('imports one zipped CSV entry with more rows than a QuickJS call takes arguments', () => {
        const rows = Array.from({ length: 70_000 }, (_, index) => [`Task ${index}`]);
        const bytes = zipSync({ 'tasks.csv': strToU8(buildCsv(['Title'], rows)) });
        const result = withQuickJsArgumentLimit(() => parseMindwtrCsvImportSource({ fileName: 'export.zip', bytes }));
        expect(result.errors).toEqual([]);
        expect(result.parsedData?.tasks).toHaveLength(70_000);
    }, 30_000);

    it('disambiguates ZIP CSV entries with numeric ordinals rather than source filenames', () => {
        const result = parseMindwtrCsvImportSource({ fileName: 'private-archive.zip', bytes: zipSync({
            'private-first.csv': strToU8('Title,Due Date,private-header\nprivate-first,private-date,private-cell'),
            'private-ignored.txt': strToU8('private-text'),
            'private-second.csv': strToU8('Title,Created At,private-header\nprivate-second,private-date,private-cell'),
        }) });
        const diagnostics = createImportDiagnostics(result.warnings, 'warning');
        expect(diagnostics.find((item) => item.code === 'unknown-columns')?.params).toEqual({ count: 2, locations: '1:1:3,2:1:3', omittedLocations: 0 });
        const dateDiagnostic = diagnostics.find((item) => item.code === 'unmapped-date')!;
        expect(dateDiagnostic.params).toEqual({ count: 2, locations: '1:2:2,2:2:2', omittedLocations: 0 });
        expect(formatImportDiagnostic(dateDiagnostic, translate)).toBe('2 date value(s) could not be mapped and were omitted. Locations (CSV records; header = row 1): CSV entry 1, row 2, column 2; CSV entry 2, row 2, column 2.');
        expect(JSON.stringify([result.warnings, diagnostics])).not.toContain('private-');
    });

    it('parses a full-featured row into the right task, project, section, and area fields', () => {
        const csv = buildCsv(FULL_HEADERS, [
            [
                'Draft launch email', 'Multi-line\ndescription text', 'waiting', 'Marketing', 'Launch', 'Work',
                '@phone, home', '#urgent, review', 'Alex', 'high', 'low', '2026-09-01',
                '2026-09-05T14:30:00+02:00', '2026-09-10', '', '[x] Draft copy|[ ] Get approval|Send',
                'Office', '5', 'task-1', '2026-08-01T09:00:00Z',
            ],
        ]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.parsedData?.areas).toMatchObject([{ name: 'Work', sourceKey: 'work' }]);
        expect(result.parsedData?.projects).toMatchObject([
            { name: 'Marketing', sourceKey: 'work:marketing', areaSourceKey: 'work' },
        ]);
        expect(result.parsedData?.sections).toMatchObject([
            { name: 'Launch', projectSourceKey: 'work:marketing', sourceKey: 'work:marketing:launch' },
        ]);

        const [task] = result.parsedData?.tasks ?? [];
        expect(task).toMatchObject({
            title: 'Draft launch email',
            description: 'Multi-line\ndescription text',
            status: 'waiting',
            projectSourceKey: 'work:marketing',
            sectionSourceKey: 'work:marketing:launch',
            contexts: ['@phone', '@home'],
            tags: ['#urgent', '#review'],
            assignedTo: 'Alex',
            priority: 'high',
            energyLevel: 'low',
            startTime: '2026-09-01',
            dueDate: '2026-09-05T12:30:00.000Z',
            reviewAt: '2026-09-10',
            location: 'Office',
            sourceId: 'task-1',
            createdAt: '2026-08-01T09:00:00.000Z',
        });
        expect(task?.checklist).toEqual([
            { id: expect.any(String), title: 'Draft copy', isCompleted: true },
            { id: expect.any(String), title: 'Get approval', isCompleted: false },
            { id: expect.any(String), title: 'Send', isCompleted: false },
        ]);
    });

    it('parses a semicolon-delimited file', () => {
        const csv = buildCsv(['Title', 'Project'], [['Semicolon task', 'Ops']], ';');

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.valid).toBe(true);
        expect(result.parsedData?.tasks).toMatchObject([{ title: 'Semicolon task', projectSourceKey: 'ops' }]);
    });

    it('rejects a checklist that exceeds the safe item limit before allocating items', () => {
        const checklist = Array.from({ length: 1_001 }, (_, index) => `item ${index}`).join('|');

        const result = parseMindwtrCsvImportSource({
            fileName: 'export.csv',
            text: buildCsv(['Title', 'Checklist'], [['Too many items', checklist]]),
        });

        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('checklist');
    });

    it('errors when the Title column is missing', () => {
        const csv = buildCsv(['Status', 'Project'], [['next', 'Ops']]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.valid).toBe(false);
        expect(result.parsedData).toBeNull();
        expect(result.errors).toEqual(['Mindwtr CSV is missing the required column: Title']);
    });

    it('maps an unrecognized status to Inbox and warns', () => {
        const csv = buildCsv(['Title', 'Status'], [['Mystery task', 'urgent-ish']]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.tasks).toMatchObject([{ status: 'inbox' }]);
        expect(result.warnings).toContain('1 task status could not be mapped and was imported to Inbox.');
    });

    it('ignores a Section without a Project and warns', () => {
        const csv = buildCsv(['Title', 'Section'], [['Orphan section task', 'Some Section']]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.sections).toEqual([]);
        expect(result.parsedData?.tasks).toMatchObject([{ sectionSourceKey: undefined }]);
        expect(result.warnings).toContain('1 Section was ignored because its row had no Project.');
    });

    it('keeps a date-only value date-only while a datetime keeps its time', () => {
        const csv = buildCsv(
            ['Title', 'Start Date', 'Due Date'],
            [['Mixed dates', '2026-10-01', '2026-10-02T09:15:00']]
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.tasks).toMatchObject([
            { startTime: '2026-10-01', dueDate: '2026-10-02T09:15:00' },
        ]);
    });

    it('rejects an impossible date-only value instead of rolling it into another month', () => {
        const csv = buildCsv(['Title', 'Due Date'], [['Impossible date', '2026-02-31']]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.tasks).toMatchObject([{ dueDate: undefined }]);
        expect(result.warnings).toContain('1 date value could not be parsed and was skipped. [csv-locations=0:2:2; omitted=0]');
    });

    it('rejects local datetimes with impossible calendar or clock components', () => {
        const csv = buildCsv(
            ['Title', 'Start Date', 'Due Date'],
            [['Impossible datetimes', '2026-13-01T09:30:00', '2026-02-28T24:00:00']]
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.tasks).toMatchObject([{ startTime: undefined, dueDate: undefined }]);
        expect(result.warnings).toContain('2 date values could not be parsed and were skipped. [csv-locations=0:2:3,0:2:2; omitted=0]');
    });

    it('rejects an entity timestamp that would roll into another calendar date', () => {
        const csv = buildCsv(['Title', 'Created At'], [['Impossible timestamp', '2026-02-31T09:30:00']]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.tasks).toMatchObject([{ createdAt: undefined }]);
        expect(result.warnings).toContain('1 date value could not be parsed and was skipped. [csv-locations=0:2:2; omitted=0]');
    });

    it('defaults empty Status to next with a Project and to inbox without one', () => {
        const csv = buildCsv(
            ['Title', 'Project', 'Status'],
            [
                ['Has a project', 'Ops', ''],
                ['No project', '', ''],
            ]
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        const tasks = result.parsedData?.tasks ?? [];
        expect(tasks.find((task) => task.title === 'Has a project')).toMatchObject({ status: 'next', projectSourceKey: 'ops' });
        expect(tasks.find((task) => task.title === 'No project')).toMatchObject({ status: 'inbox', projectSourceKey: undefined });
    });

    it('defaults empty Status to done when Completed At is set', () => {
        const csv = buildCsv(
            ['Title', 'Status', 'Completed At'],
            [['Finished already', '', '2026-08-05T10:00:00Z']]
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.tasks).toMatchObject([{ status: 'done' }]);
    });

    it('defaults empty Status to archived when Cancelled At is set', () => {
        const csv = buildCsv(
            ['Title', 'Status', 'Cancelled At'],
            [['Cancelled already', '', '2026-08-05T10:00:00Z']],
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.tasks).toMatchObject([{
            status: 'archived',
            cancelledAt: '2026-08-05T10:00:00.000Z',
        }]);
    });

    it('warns once about unknown columns without repeating per row', () => {
        const csv = buildCsv(
            ['Title', 'Notes'],
            [['Row one', 'ignored'], ['Row two', 'ignored too']]
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.warnings).toContain('1 unknown column was ignored. [csv-locations=0:1:2; omitted=0]');
    });

    it('parses a zipped export and skips unsupported archive entries', () => {
        const csv = buildCsv(['Title', 'Project'], [['Zipped task', 'Ops']]);
        const archive = zipSync({
            'backup.csv': strToU8(csv),
            'notes.txt': strToU8('skip me'),
            'nested.zip': new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        });

        const result = parseMindwtrCsvImportSource({ fileName: 'export.zip', bytes: archive });

        expect(result.valid).toBe(true);
        expect(result.preview).toMatchObject({ taskCount: 1, projectCount: 1 });
        expect(result.warnings).toContain('1 non-CSV file inside the ZIP was skipped.');
        expect(result.warnings).toContain('1 nested ZIP file inside the archive was skipped.');
    });

    it('imports parsed data into areas, projects, sections, and tasks with fresh revisions', () => {
        const csv = buildCsv(FULL_HEADERS, [
            [
                'Draft launch email', 'Notes', 'waiting', 'Marketing', 'Launch', 'Work',
                '@phone', '#urgent', 'Alex', 'high', 'low', '2026-09-01', '2026-09-05', '2026-09-10',
                '', '[x] Draft copy', 'Office', '1', 'task-1', '2026-08-01T09:00:00Z',
            ],
        ]);
        const parsedData = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv }).parsedData as ParsedMindwtrCsvImportData;

        const result = applyMindwtrCsvImport(mockAppData([], [], []), parsedData, { now: '2026-08-08T12:00:00.000Z' });

        expect(result.importedAreaCount).toBe(1);
        expect(result.importedProjectCount).toBe(1);
        expect(result.importedSectionCount).toBe(1);
        expect(result.importedTaskCount).toBe(1);
        expect(result.importedChecklistItemCount).toBe(1);
        expect(result.importedStandaloneTaskCount).toBe(0);
        expect(result.data.settings.deviceId).toBeTruthy();

        const area = result.data.areas[0];
        expect(area).toMatchObject({ name: 'Work', rev: 1, revBy: result.data.settings.deviceId });

        const project = result.data.projects[0];
        expect(project).toMatchObject({ title: 'Marketing', areaId: area.id, rev: 1, revBy: result.data.settings.deviceId });

        const section = result.data.sections[0];
        expect(section).toMatchObject({ title: 'Launch', projectId: project.id, rev: 1, revBy: result.data.settings.deviceId });

        const task = result.data.tasks[0];
        expect(task).toMatchObject({
            title: 'Draft launch email',
            status: 'waiting',
            projectId: project.id,
            sectionId: section.id,
            assignedTo: 'Alex',
            priority: 'high',
            energyLevel: 'low',
            location: 'Office',
            rev: 1,
            revBy: result.data.settings.deviceId,
        });
        expect(task.areaId).toBeUndefined();
        expect(task.checklist).toEqual([{ id: expect.any(String), title: 'Draft copy', isCompleted: true }]);
    });

    it('keeps equal project and section names distinct across areas when parsing and applying', () => {
        const csv = buildCsv(
            ['Title', 'Project', 'Section', 'Area', 'ID'],
            [
                ['Plan work', 'Planning', 'Backlog', 'Work', 'work-plan'],
                ['Plan home', 'Planning', 'Backlog', 'Home', 'home-plan'],
            ]
        );

        const parsed = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(parsed.preview).toMatchObject({ areaCount: 2, projectCount: 2, sectionCount: 2, taskCount: 2 });
        expect(parsed.parsedData?.projects).toMatchObject([
            { name: 'Planning', areaSourceKey: 'work', sourceKey: 'work:planning' },
            { name: 'Planning', areaSourceKey: 'home', sourceKey: 'home:planning' },
        ]);
        expect(parsed.parsedData?.sections).toMatchObject([
            { name: 'Backlog', projectSourceKey: 'work:planning', sourceKey: 'work:planning:backlog' },
            { name: 'Backlog', projectSourceKey: 'home:planning', sourceKey: 'home:planning:backlog' },
        ]);

        const applied = applyMindwtrCsvImport(
            mockAppData([], [], []),
            parsed.parsedData as ParsedMindwtrCsvImportData,
            { now: '2026-08-08T12:00:00.000Z' }
        );
        const workArea = applied.data.areas.find((area) => area.name === 'Work');
        const homeArea = applied.data.areas.find((area) => area.name === 'Home');
        const workProject = applied.data.projects.find((project) => project.areaId === workArea?.id);
        const homeProject = applied.data.projects.find((project) => project.areaId === homeArea?.id);
        const workSection = applied.data.sections.find((section) => section.projectId === workProject?.id);
        const homeSection = applied.data.sections.find((section) => section.projectId === homeProject?.id);

        expect(workProject?.id).toBeTruthy();
        expect(homeProject?.id).toBeTruthy();
        expect(workProject?.id).not.toBe(homeProject?.id);
        expect(workProject?.title).toBe('Planning');
        expect(homeProject?.title).toBe('Planning');
        expect(applied.warnings.some((warning) => warning.includes('was renamed'))).toBe(false);
        expect(workSection?.id).toBeTruthy();
        expect(homeSection?.id).toBeTruthy();
        expect(workSection?.id).not.toBe(homeSection?.id);
        expect(applied.data.tasks.find((task) => task.title === 'Plan work')).toMatchObject({
            projectId: workProject?.id,
            sectionId: workSection?.id,
        });
        expect(applied.data.tasks.find((task) => task.title === 'Plan home')).toMatchObject({
            projectId: homeProject?.id,
            sectionId: homeSection?.id,
        });
    });

    it('keeps delimiter-shaped project and section paths distinct through parse and apply', () => {
        const csv = buildCsv(
            ['Title', 'Project', 'Section', 'Area', 'ID'],
            [
                ['Colon in area', 'Ops', 'Queue', 'Work:North', 'area-colon'],
                ['Colon in project', 'North:Ops', 'Queue', 'Work', 'project-colon'],
                ['Colon before section', 'Ops:North', 'Backlog', 'Work', 'project-section-colon'],
                ['Colon in section', 'Ops', 'North:Backlog', 'Work', 'section-colon'],
            ]
        );

        const parsed = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(parsed.preview).toMatchObject({ areaCount: 2, projectCount: 4, sectionCount: 4, taskCount: 4 });
        const parsedProjects = parsed.parsedData?.projects ?? [];
        const parsedSections = parsed.parsedData?.sections ?? [];
        expect(new Set(parsedProjects.map((project) => project.sourceKey))).toHaveProperty('size', 4);
        expect(new Set(parsedSections.map((section) => section.sourceKey))).toHaveProperty('size', 4);

        const applied = applyMindwtrCsvImport(
            mockAppData([], [], []),
            parsed.parsedData as ParsedMindwtrCsvImportData,
            { now: '2026-08-08T12:00:00.000Z' }
        );

        expect(applied.data.projects).toHaveLength(4);
        expect(applied.data.sections).toHaveLength(4);
        expect(applied.data.tasks).toHaveLength(4);
        expect(new Set(applied.data.tasks.map((task) => task.projectId))).toHaveProperty('size', 4);
        expect(new Set(applied.data.tasks.map((task) => task.sectionId))).toHaveProperty('size', 4);
    });

    it('reuses IDs from the colon-scoped importer after tuple escaping is introduced', () => {
        const csv = buildCsv(
            ['Title', 'Project', 'Section', 'Area', 'ID'],
            [['Keep lineage', 'Ops:Core', 'Queue:Now', 'Work:North', 'task:1']]
        );
        const escaped = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv })
            .parsedData as ParsedMindwtrCsvImportData;
        const colonProjectSourceKey = 'work:north:ops:core';
        const colonSectionSourceKey = 'work:north:ops:core:queue:now';
        const colonScoped: ParsedMindwtrCsvImportData = {
            ...escaped,
            projects: escaped.projects.map((project) => ({
                ...project,
                sourceKey: colonProjectSourceKey,
            })),
            sections: escaped.sections.map((section) => ({
                ...section,
                projectSourceKey: colonProjectSourceKey,
                sourceKey: colonSectionSourceKey,
            })),
            tasks: escaped.tasks.map((task) => ({
                ...task,
                projectSourceKey: colonProjectSourceKey,
                sectionSourceKey: colonSectionSourceKey,
            })),
        };
        const first = applyMindwtrCsvImport(mockAppData([], [], []), colonScoped, {
            now: '2026-08-08T12:00:00.000Z',
        });

        const second = applyMindwtrCsvImport(first.data, escaped, {
            now: '2026-08-09T12:00:00.000Z',
        });

        expect(second.importedProjectCount).toBe(0);
        expect(second.importedSectionCount).toBe(0);
        expect(second.importedTaskCount).toBe(0);
        expect(second.data.projects).toHaveLength(1);
        expect(second.data.sections).toHaveLength(1);
        expect(second.data.tasks).toHaveLength(1);
    });

    it('reuses a task ID from the escaped project-scoped importer', () => {
        const csv = buildCsv(
            ['Title', 'Project', 'Section', 'Area', 'ID'],
            [['Keep lineage', 'Ops:Core', 'Queue:Now', 'Work:North', 'task:1']],
        );
        const parsed = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv })
            .parsedData as ParsedMindwtrCsvImportData;
        const first = applyMindwtrCsvImport(mockAppData([], [], []), parsed, {
            now: '2026-08-08T12:00:00.000Z',
        });
        const priorTaskId = generateDeterministicUUID(
            'mindwtr:csv-import:v1:task:work%3Anorth:ops%3Acore:task%3A1',
        );
        const priorData = {
            ...first.data,
            tasks: first.data.tasks.map((task) => ({ ...task, id: priorTaskId })),
        };

        const second = applyMindwtrCsvImport(priorData, parsed, {
            now: '2026-08-09T12:00:00.000Z',
        });

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks).toHaveLength(1);
        expect(second.data.tasks[0]?.id).toBe(priorTaskId);
    });

    it('migrates a moved task from the project-scoped importer without changing its ID', () => {
        const beforeCsv = buildCsv(
            ['Title', 'Project', 'ID'],
            [['Move prior import', 'Before', 'stable-task']],
        );
        const afterCsv = buildCsv(
            ['Title', 'Project', 'ID'],
            [['Move prior import', 'After', 'stable-task']],
        );
        const beforeParsed = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: beforeCsv })
            .parsedData as ParsedMindwtrCsvImportData;
        const afterParsed = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: afterCsv })
            .parsedData as ParsedMindwtrCsvImportData;
        const first = applyMindwtrCsvImport(mockAppData([], [], []), beforeParsed, {
            now: '2026-08-08T12:00:00.000Z',
        });
        const targetSeed = parseMindwtrCsvImportSource({
            fileName: 'target.csv',
            text: buildCsv(
                ['Title', 'Project', 'ID'],
                [['Existing target task', 'After', 'existing-after-task']],
            ),
        }).parsedData as ParsedMindwtrCsvImportData;
        const seeded = applyMindwtrCsvImport(first.data, targetSeed, {
            now: '2026-08-08T13:00:00.000Z',
        });
        const priorTaskId = generateDeterministicUUID(
            'mindwtr:csv-import:v1:task:before:stable-task',
        );
        const priorData = {
            ...seeded.data,
            tasks: seeded.data.tasks.map((task) => task.title === 'Move prior import'
                ? { ...task, id: priorTaskId }
                : task),
        };

        const second = applyMindwtrCsvImport(priorData, afterParsed, {
            now: '2026-08-09T12:00:00.000Z',
        });
        const afterProject = second.data.projects.find((project) => project.title === 'After');
        const migratedTask = second.data.tasks.find((task) => task.title === 'Move prior import');

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks).toHaveLength(2);
        expect(migratedTask).toMatchObject({
            id: priorTaskId,
            projectId: afterProject?.id,
            order: 1,
            orderNum: 1,
            rev: 2,
            revBy: second.data.settings.deviceId,
        });
    });

    // BUG-12 (plan 029): the historical-id fallback scan used to rebuild each candidate
    // key with one encodeSourceKeyTuple(...area, project, sourceId) call per (row, project)
    // pair; ff816361a precomputes each project's tuplePrefix = encodeSourceKeyTuple(area,
    // project) + ':' once and appends encodeURIComponent(sourceId) per row instead. The two
    // constructions are algebraically identical (encodeURIComponent never emits a literal
    // ':'), but this pins it as a byte-identical id-resolution equality check across an
    // area-scoped project with a colon in both the project name and the source id -- the
    // shape the escaping exists for in the first place (see encodeSourceKeyTuple's doc
    // comment) -- rather than trusting the algebra.
    it('resolves a moved task to a hand-computed historical id through the area-scoped tuple prefix (BUG-12)', () => {
        const beforeCsv = buildCsv(
            ['Title', 'Area', 'Project', 'ID'],
            [['Move within area', 'Work', 'Legacy:Team', 'north:9']],
        );
        const afterCsv = buildCsv(
            ['Title', 'Area', 'Project', 'ID'],
            [['Move within area', 'Work', 'New:Team', 'north:9']],
        );
        const beforeParsed = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: beforeCsv })
            .parsedData as ParsedMindwtrCsvImportData;
        const afterParsed = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: afterCsv })
            .parsedData as ParsedMindwtrCsvImportData;
        const first = applyMindwtrCsvImport(mockAppData([], [], []), beforeParsed, {
            now: '2026-08-08T12:00:00.000Z',
        });

        // Hand-computed via encodeSourceKeyTuple's own formula (each component
        // encodeURIComponent'd, joined by ':'), not read off `first.data` -- this is the
        // independent expectation the refactor's tuplePrefix + encodeURIComponent(sourceId)
        // split must still land on.
        const priorTaskId = generateDeterministicUUID(
            'mindwtr:csv-import:v1:task:work:legacy%3Ateam:north%3A9',
        );
        const priorData = {
            ...first.data,
            tasks: first.data.tasks.map((task) => ({ ...task, id: priorTaskId })),
        };

        const second = applyMindwtrCsvImport(priorData, afterParsed, {
            now: '2026-08-09T12:00:00.000Z',
        });
        const migratedTask = second.data.tasks.find((task) => task.title === 'Move within area');

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks).toHaveLength(1);
        expect(migratedTask?.id).toBe(priorTaskId);
    });

    it('does not collapse rows at the same position across two CSVs in one ZIP (C1)', () => {
        const csvA = buildCsv(['Title', 'Project'], [['Task from A', 'Ops']]);
        const csvB = buildCsv(['Title', 'Project'], [['Task from B', 'Ops']]);
        const archive = zipSync({
            'a.csv': strToU8(csvA),
            'b.csv': strToU8(csvB),
        });

        const result = parseMindwtrCsvImportSource({ fileName: 'export.zip', bytes: archive });

        expect(result.valid).toBe(true);
        const titles = (result.parsedData?.tasks ?? []).map((task) => task.title).sort();
        expect(titles).toEqual(['Task from A', 'Task from B']);

        const applied = applyMindwtrCsvImport(mockAppData([], [], []), result.parsedData as ParsedMindwtrCsvImportData, { now: '2026-08-08T12:00:00.000Z' });
        expect(applied.importedTaskCount).toBe(2);
    });

    it('keeps row fallbacks distinct across separately imported standalone CSV files', () => {
        const firstParsed = parseMindwtrCsvImportSource({
            fileName: 'first.csv',
            text: buildCsv(['Title', 'Project'], [['First file task', 'Ops']]),
        }).parsedData as ParsedMindwtrCsvImportData;
        const secondParsed = parseMindwtrCsvImportSource({
            fileName: 'second.csv',
            text: buildCsv(['Title', 'Project'], [['Second file task', 'Personal']]),
        }).parsedData as ParsedMindwtrCsvImportData;

        const first = applyMindwtrCsvImport(mockAppData([], [], []), firstParsed, {
            now: '2026-08-08T12:00:00.000Z',
        });
        const second = applyMindwtrCsvImport(first.data, secondParsed, {
            now: '2026-08-09T12:00:00.000Z',
        });

        expect(second.importedTaskCount).toBe(1);
        expect(second.data.tasks.map((task) => task.title)).toEqual([
            'First file task',
            'Second file task',
        ]);
        expect(second.warnings.some((warning) => warning.includes('already imported'))).toBe(false);
    });

    it('keeps no-ID rows distinct when same-named CSV files have different content', () => {
        const firstParsed = parseMindwtrCsvImportSource({
            fileName: 'export.csv',
            text: buildCsv(['Title'], [['First document task']]),
        }).parsedData as ParsedMindwtrCsvImportData;
        const secondParsed = parseMindwtrCsvImportSource({
            fileName: 'export.csv',
            text: buildCsv(['Title'], [['Second document task']]),
        }).parsedData as ParsedMindwtrCsvImportData;

        const first = applyMindwtrCsvImport(mockAppData([], [], []), firstParsed);
        const second = applyMindwtrCsvImport(first.data, secondParsed);

        expect(second.importedTaskCount).toBe(1);
        expect(second.data.tasks.map((task) => task.title)).toEqual([
            'First document task',
            'Second document task',
        ]);
    });

    it('keeps no-ID row identity stable when identical CSV content is renamed', () => {
        const csv = buildCsv(['Title'], [['Stable document task']]);
        const firstParsed = parseMindwtrCsvImportSource({
            fileName: 'first-name.csv',
            text: csv,
        }).parsedData as ParsedMindwtrCsvImportData;
        const renamedParsed = parseMindwtrCsvImportSource({
            fileName: 'renamed.csv',
            text: csv,
        }).parsedData as ParsedMindwtrCsvImportData;

        const first = applyMindwtrCsvImport(mockAppData([], [], []), firstParsed);
        const second = applyMindwtrCsvImport(first.data, renamedParsed);

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks).toHaveLength(1);
        expect(second.data.tasks[0]?.id).toBe(first.data.tasks[0]?.id);
    });

    it('keeps same-entry no-ID rows distinct across separate ZIP archives', () => {
        const firstArchive = zipSync({
            'tasks.csv': strToU8(buildCsv(['Title'], [['First archive task']])),
        });
        const secondArchive = zipSync({
            'tasks.csv': strToU8(buildCsv(['Title'], [['Second archive task']])),
        });
        const firstParsed = parseMindwtrCsvImportSource({
            fileName: 'first.zip',
            bytes: firstArchive,
        }).parsedData as ParsedMindwtrCsvImportData;
        const secondParsed = parseMindwtrCsvImportSource({
            fileName: 'second.zip',
            bytes: secondArchive,
        }).parsedData as ParsedMindwtrCsvImportData;

        const first = applyMindwtrCsvImport(mockAppData([], [], []), firstParsed);
        const second = applyMindwtrCsvImport(first.data, secondParsed);

        expect(second.importedTaskCount).toBe(1);
        expect(second.data.tasks.map((task) => task.title)).toEqual([
            'First archive task',
            'Second archive task',
        ]);
    });

    it('reuses IDs created by the preceding filename-based no-ID namespace', () => {
        const parsed = parseMindwtrCsvImportSource({
            fileName: 'export.csv',
            text: buildCsv(['Title'], [['Existing filename task']]),
        }).parsedData as ParsedMindwtrCsvImportData;
        const legacyFilenameParsed: ParsedMindwtrCsvImportData = {
            ...parsed,
            tasks: parsed.tasks.map((task) => ({
                ...task,
                sourceKey: 'row-fallback:standalone-file:export.csv:2',
            })),
        };

        const first = applyMindwtrCsvImport(mockAppData([], [], []), legacyFilenameParsed);
        const second = applyMindwtrCsvImport(first.data, parsed);

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks).toHaveLength(1);
        expect(second.data.tasks[0]?.id).toBe(first.data.tasks[0]?.id);
    });

    it('normalizes a date-only Created At to a full UTC instant (C2)', () => {
        const csv = buildCsv(['Title', 'Created At'], [['Old task', '2026-08-01']]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        const [task] = result.parsedData?.tasks ?? [];
        expect(task?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('accepts SQL-shaped timestamps: long fractional seconds and a space before the offset (#1011)', () => {
        const csv = buildCsv(
            ['Title', 'Due Date', 'Completed At', 'Status'],
            [['SQL task', '2026-02-21 22:44:00.6390000 +00:00', '2026-02-21 22:44:00.6390000 +00:00', 'done']],
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        const [task] = result.parsedData?.tasks ?? [];
        expect(task?.completedAt).toBe('2026-02-21T22:44:00.639Z');
        expect(task?.dueDate).toBe('2026-02-21T22:44:00.639Z');
        expect(result.parsedData?.warnings ?? []).toEqual([]);
    });

    it('treats literal NULL cells as empty (#1011)', () => {
        const csv = buildCsv(
            ['Title', 'Project', 'Contexts', 'Tags', 'Due Date'],
            [['Real task', 'NULL', 'null', 'NULL', 'NULL'], ['NULL', 'Ops', '', '', '']],
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.tasks).toHaveLength(1);
        const [task] = result.parsedData?.tasks ?? [];
        expect(task?.title).toBe('Real task');
        expect(task?.projectSourceKey).toBeUndefined();
        expect(task?.contexts).toEqual([]);
        expect(task?.tags).toEqual([]);
        expect(task?.dueDate).toBeUndefined();
        expect(result.parsedData?.warnings.some((w) => w.includes('empty title'))).toBe(true);
    });

    it('reports skipped rows when re-importing after the tasks were deleted (#1011)', () => {
        const csv = buildCsv(['Title', 'Project'], [['Task one', 'Ops'], ['Task two', 'Ops']]);
        const parsedData = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv }).parsedData as ParsedMindwtrCsvImportData;

        const first = applyMindwtrCsvImport(mockAppData([], [], []), parsedData, { now: '2026-08-08T12:00:00.000Z' });
        const withDeletion = {
            ...first.data,
            tasks: first.data.tasks.map((task, index) => (index === 0
                ? { ...task, deletedAt: '2026-08-09T00:00:00.000Z' }
                : task)),
        };
        const second = applyMindwtrCsvImport(withDeletion, parsedData, { now: '2026-08-09T12:00:00.000Z' });

        expect(second.importedTaskCount).toBe(0);
        expect(second.warnings.some((w) => w.includes('1 task was skipped because it was already imported earlier.'))).toBe(true);
        expect(second.warnings.some((w) => w.includes('deleted here; deletions are kept on re-import'))).toBe(true);
    });

    it('does not duplicate a Section when the same import is applied again (T1)', () => {
        const csv = buildCsv(['Title', 'Project', 'Section'], [['Task one', 'Ops', 'Backlog']]);
        const parsedData = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv }).parsedData as ParsedMindwtrCsvImportData;

        const first = applyMindwtrCsvImport(mockAppData([], [], []), parsedData, { now: '2026-08-08T12:00:00.000Z' });
        const second = applyMindwtrCsvImport(first.data, parsedData, { now: '2026-08-09T12:00:00.000Z' });

        expect(first.importedSectionCount).toBe(1);
        expect(second.importedSectionCount).toBe(0);
        expect(second.data.sections).toHaveLength(1);
    });

    it('recognizes records created by the pre-area-scoped deterministic IDs', () => {
        const csv = buildCsv(
            ['Title', 'Area', 'Project', 'Section', 'ID'],
            [['Legacy task', 'Work', 'Ops', 'Backlog', 'stable-task']],
        );
        const scoped = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv })
            .parsedData as ParsedMindwtrCsvImportData;
        const legacy: ParsedMindwtrCsvImportData = {
            ...scoped,
            projects: scoped.projects.map((project) => ({ ...project, sourceKey: 'ops' })),
            sections: scoped.sections.map((section) => ({
                ...section,
                projectSourceKey: 'ops',
                sourceKey: 'ops:backlog',
            })),
            tasks: scoped.tasks.map((task) => ({
                ...task,
                projectSourceKey: 'ops',
                sectionSourceKey: 'ops:backlog',
            })),
        };
        const first = applyMindwtrCsvImport(mockAppData([], [], []), legacy, {
            now: '2026-08-08T12:00:00.000Z',
        });

        const second = applyMindwtrCsvImport(first.data, scoped, {
            now: '2026-08-09T12:00:00.000Z',
        });

        expect(second.importedProjectCount).toBe(0);
        expect(second.importedSectionCount).toBe(0);
        expect(second.importedTaskCount).toBe(0);
        expect(second.data.projects).toHaveLength(1);
        expect(second.data.sections).toHaveLength(1);
        expect(second.data.tasks).toHaveLength(1);
    });

    it('keeps an edited shared legacy task in its current container without duplicating it', () => {
        const csv = buildCsv(
            ['Title', 'Area', 'Project', 'Section', 'ID'],
            [
                ['Work task', 'Work', 'Ops', 'Backlog', 'work-task'],
                ['Home task', 'Home', 'Ops', 'Backlog', 'home-task'],
            ]
        );
        const scoped = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv })
            .parsedData as ParsedMindwtrCsvImportData;
        const workProject = scoped.projects.find((project) => project.areaSourceKey === 'work');
        const workSection = scoped.sections.find((section) => section.projectSourceKey === workProject?.sourceKey);
        const legacy: ParsedMindwtrCsvImportData = {
            ...scoped,
            projects: [{ ...(workProject as NonNullable<typeof workProject>), sourceKey: 'ops' }],
            sections: [{
                ...(workSection as NonNullable<typeof workSection>),
                projectSourceKey: 'ops',
                sourceKey: 'ops:backlog',
            }],
            tasks: scoped.tasks.map((task) => ({
                ...task,
                projectSourceKey: 'ops',
                sectionSourceKey: 'ops:backlog',
            })),
        };
        const first = applyMindwtrCsvImport(mockAppData([], [], []), legacy, {
            now: '2026-08-08T12:00:00.000Z',
        });
        expect(first.data.projects).toHaveLength(1);
        expect(first.data.sections).toHaveLength(1);
        expect(first.data.tasks).toHaveLength(2);
        const legacyHomeTask = first.data.tasks.find((task) => task.title === 'Home task');
        const editedFirstData = {
            ...first.data,
            tasks: first.data.tasks.map((task) => task.id === legacyHomeTask?.id
                ? {
                    ...task,
                    description: 'Keep this local edit',
                    priority: 'urgent' as const,
                    rev: 7,
                    updatedAt: '2026-08-08T18:00:00.000Z',
                }
                : task),
        };

        const second = applyMindwtrCsvImport(editedFirstData, scoped, {
            now: '2026-08-09T12:00:00.000Z',
        });

        const workArea = second.data.areas.find((area) => area.name === 'Work');
        const homeArea = second.data.areas.find((area) => area.name === 'Home');
        const upgradedWorkProject = second.data.projects.find((project) => project.areaId === workArea?.id);
        const newHomeProject = second.data.projects.find((project) => project.areaId === homeArea?.id);
        const upgradedWorkSection = second.data.sections.find((section) => (
            section.projectId === upgradedWorkProject?.id
        ));
        const newHomeSection = second.data.sections.find((section) => section.projectId === newHomeProject?.id);
        expect(second.importedProjectCount).toBe(1);
        expect(second.importedSectionCount).toBe(1);
        expect(second.importedTaskCount).toBe(0);
        expect(second.data.projects).toHaveLength(2);
        expect(second.data.sections).toHaveLength(2);
        expect(second.data.tasks).toHaveLength(2);
        expect(upgradedWorkProject?.id).toBe(first.data.projects[0]?.id);
        expect(newHomeProject?.id).toBeTruthy();
        expect(newHomeProject?.id).not.toBe(upgradedWorkProject?.id);
        expect(upgradedWorkSection?.id).toBe(first.data.sections[0]?.id);
        expect(newHomeSection?.id).toBeTruthy();
        expect(newHomeSection?.id).not.toBe(upgradedWorkSection?.id);
        expect(second.data.tasks.find((task) => (
            task.title === 'Work task' && task.projectId === upgradedWorkProject?.id
        ))?.id).toBe(first.data.tasks.find((task) => task.title === 'Work task')?.id);
        expect(second.data.tasks.find((task) => task.title === 'Home task')).toMatchObject({
            id: legacyHomeTask?.id,
            projectId: legacyHomeTask?.projectId,
            sectionId: legacyHomeTask?.sectionId,
            description: 'Keep this local edit',
            priority: 'urgent',
            rev: 7,
            updatedAt: '2026-08-08T18:00:00.000Z',
        });
        expect(second.warnings).toContain(
            '1 previously imported task was kept in its current container because it was edited after import.',
        );
        expect(second.warnings).not.toContain('1 previously imported task was moved to match its CSV container.');

        const third = applyMindwtrCsvImport(second.data, scoped, {
            now: '2026-08-10T12:00:00.000Z',
        });
        expect(third.importedProjectCount).toBe(0);
        expect(third.importedSectionCount).toBe(0);
        expect(third.importedTaskCount).toBe(0);
        expect(third.data.projects).toHaveLength(2);
        expect(third.data.sections).toHaveLength(2);
        expect(third.data.tasks).toHaveLength(2);
    });

    it('clears project ordering when an untouched legacy task is safely moved to Inbox', () => {
        const beforeParsed = parseMindwtrCsvImportSource({
            fileName: 'export.csv',
            text: buildCsv(
                ['Title', 'Project', 'Order', 'ID'],
                [['Move to Inbox', 'Before', '4', 'stable-task']],
            ),
        }).parsedData as ParsedMindwtrCsvImportData;
        const afterParsed = parseMindwtrCsvImportSource({
            fileName: 'export.csv',
            text: buildCsv(['Title', 'ID'], [['Move to Inbox', 'stable-task']]),
        }).parsedData as ParsedMindwtrCsvImportData;
        const first = applyMindwtrCsvImport(mockAppData([], [], []), beforeParsed, {
            now: '2026-08-08T12:00:00.000Z',
        });
        const priorTaskId = generateDeterministicUUID(
            'mindwtr:csv-import:v1:task:before:stable-task',
        );
        const priorData = {
            ...first.data,
            tasks: first.data.tasks.map((task) => ({ ...task, id: priorTaskId })),
        };

        const second = applyMindwtrCsvImport(priorData, afterParsed, {
            now: '2026-08-09T12:00:00.000Z',
        });

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks).toHaveLength(1);
        expect(second.data.tasks[0]).toMatchObject({
            id: priorTaskId,
            projectId: undefined,
            sectionId: undefined,
            areaId: undefined,
            order: undefined,
            orderNum: undefined,
            rev: 2,
        });
        expect(second.warnings).toContain('1 previously imported task was moved to match its CSV container.');
    });

    it('repairs a task from a previously colliding colon-scoped path without duplicating it', () => {
        const csv = buildCsv(
            ['Title', 'Area', 'Project', 'Section', 'ID'],
            [
                ['Area-colon task', 'Work:North', 'Ops', 'Queue', 'area-task'],
                ['Project-colon task', 'Work', 'North:Ops', 'Queue', 'project-task'],
            ],
        );
        const scoped = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv })
            .parsedData as ParsedMindwtrCsvImportData;
        const firstProject = scoped.projects[0] as NonNullable<(typeof scoped.projects)[number]>;
        const firstSection = scoped.sections.find((section) => section.projectSourceKey === firstProject.sourceKey);
        const colonProjectSourceKey = 'work:north:ops';
        const colonSectionSourceKey = 'work:north:ops:queue';
        const colonScoped: ParsedMindwtrCsvImportData = {
            ...scoped,
            projects: [{ ...firstProject, sourceKey: colonProjectSourceKey }],
            sections: [{
                ...(firstSection as NonNullable<typeof firstSection>),
                projectSourceKey: colonProjectSourceKey,
                sourceKey: colonSectionSourceKey,
            }],
            tasks: scoped.tasks.map((task) => ({
                ...task,
                projectSourceKey: colonProjectSourceKey,
                sectionSourceKey: colonSectionSourceKey,
            })),
        };
        const first = applyMindwtrCsvImport(mockAppData([], [], []), colonScoped, {
            now: '2026-08-08T12:00:00.000Z',
        });
        const priorProjectTask = first.data.tasks.find((task) => task.title === 'Project-colon task');

        const second = applyMindwtrCsvImport(first.data, scoped, {
            now: '2026-08-09T12:00:00.000Z',
        });
        const workArea = second.data.areas.find((area) => area.name === 'Work');
        const workProject = second.data.projects.find((project) => project.areaId === workArea?.id);
        const workSection = second.data.sections.find((section) => section.projectId === workProject?.id);

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks).toHaveLength(2);
        expect(second.data.tasks.find((task) => task.title === 'Project-colon task')).toMatchObject({
            id: priorProjectTask?.id,
            projectId: workProject?.id,
            sectionId: workSection?.id,
            rev: 2,
            revBy: second.data.settings.deviceId,
        });
    });

    it('drops a later repeated CSV ID before legacy migration matching', () => {
        const csv = buildCsv(
            ['Title', 'Area', 'Project', 'ID'],
            [
                ['Work task', 'Work', 'Ops', 'shared-task'],
                ['Home task', 'Home', 'Ops', 'shared-task'],
            ],
        );
        const scoped = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv })
            .parsedData as ParsedMindwtrCsvImportData;
        const workProject = scoped.projects.find((project) => project.areaSourceKey === 'work');
        const legacy: ParsedMindwtrCsvImportData = {
            ...scoped,
            projects: [{ ...(workProject as NonNullable<typeof workProject>), sourceKey: 'ops' }],
            sections: [],
            tasks: scoped.tasks.map((task) => ({ ...task, projectSourceKey: 'ops' })),
        };
        const first = applyMindwtrCsvImport(mockAppData([], [], []), legacy, {
            now: '2026-08-08T12:00:00.000Z',
        });
        const priorTask = first.data.tasks[0];

        const second = applyMindwtrCsvImport(first.data, scoped, {
            now: '2026-08-09T12:00:00.000Z',
        });

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks).toHaveLength(1);
        expect(second.data.tasks[0]).toMatchObject({
            id: priorTask?.id,
            projectId: priorTask?.projectId,
            rev: priorTask?.rev,
        });
        expect(second.warnings).toContain(
            '1 row had an ID that duplicated an earlier row in this import and was dropped.',
        );
        expect(second.warnings).not.toContain(
            '1 repeated CSV ID matched a prior import; existing tasks were kept unchanged.',
        );
    });

    it('treats a stable legacy task ID as the same task when its scoped container changes', () => {
        const legacyCsv = buildCsv(
            ['Title', 'Area', 'Project', 'Section', 'ID'],
            [['Legacy home task', 'Home', 'Ops', 'Backlog', 'stable-task']]
        );
        const legacyScoped = parseMindwtrCsvImportSource({ fileName: 'legacy.csv', text: legacyCsv })
            .parsedData as ParsedMindwtrCsvImportData;
        const legacy: ParsedMindwtrCsvImportData = {
            ...legacyScoped,
            projects: legacyScoped.projects.map((project) => ({ ...project, sourceKey: 'ops' })),
            sections: legacyScoped.sections.map((section) => ({
                ...section,
                projectSourceKey: 'ops',
                sourceKey: 'ops:backlog',
            })),
            tasks: legacyScoped.tasks.map((task) => ({
                ...task,
                projectSourceKey: 'ops',
                sectionSourceKey: 'ops:backlog',
            })),
        };
        const first = applyMindwtrCsvImport(mockAppData([], [], []), legacy, {
            now: '2026-08-08T12:00:00.000Z',
        });
        const workCsv = buildCsv(
            ['Title', 'Area', 'Project', 'Section', 'ID'],
            [['Scoped work task', 'Work', 'Ops', 'Backlog', 'stable-task']]
        );
        const workScoped = parseMindwtrCsvImportSource({ fileName: 'work.csv', text: workCsv })
            .parsedData as ParsedMindwtrCsvImportData;

        const second = applyMindwtrCsvImport(first.data, workScoped, {
            now: '2026-08-09T12:00:00.000Z',
        });

        const homeArea = second.data.areas.find((area) => area.name === 'Home');
        const workArea = second.data.areas.find((area) => area.name === 'Work');
        const homeProject = second.data.projects.find((project) => project.areaId === homeArea?.id);
        const workProject = second.data.projects.find((project) => project.areaId === workArea?.id);
        expect(second.importedProjectCount).toBe(1);
        expect(second.importedSectionCount).toBe(1);
        expect(second.importedTaskCount).toBe(0);
        expect(homeProject?.id).toBe(first.data.projects[0]?.id);
        expect(workProject?.id).toBeTruthy();
        expect(workProject?.id).not.toBe(homeProject?.id);
        expect(second.data.tasks).toHaveLength(1);
        expect(second.data.tasks[0]).toMatchObject({
            id: first.data.tasks[0]?.id,
            title: 'Legacy home task',
            projectId: workProject?.id,
        });
        expect(second.warnings).toContain('1 previously imported task was moved to match its CSV container.');
    });

    it('parses a tab-delimited file (T2)', () => {
        const csv = buildCsv(['Title', 'Project'], [['Tab task', 'Ops']], '\t');

        const result = parseMindwtrCsvImportSource({ fileName: 'export.tsv', text: csv });

        expect(result.valid).toBe(true);
        expect(result.parsedData?.tasks).toMatchObject([{ title: 'Tab task', projectSourceKey: 'ops' }]);
    });

    it('reorders tasks within a project by the Order column, falling back to row order on ties (T3)', () => {
        const csv = buildCsv(
            ['Title', 'Project', 'Order'],
            [
                ['Third', 'Ops', '3'],
                ['First', 'Ops', '1'],
                ['Second-a', 'Ops', '2'],
                ['Second-b', 'Ops', '2'],
            ]
        );
        const parsedData = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv }).parsedData as ParsedMindwtrCsvImportData;

        const result = applyMindwtrCsvImport(mockAppData([], [], []), parsedData, { now: '2026-08-08T12:00:00.000Z' });

        const byOrder = [...result.data.tasks].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
        expect(byOrder.map((task) => task.title)).toEqual(['First', 'Second-a', 'Second-b', 'Third']);
    });

    it('imports a Recurrence rule onto the task (T4)', () => {
        const csv = buildCsv(['Title', 'Recurrence'], [['Repeats weekly', 'FREQ=WEEKLY;BYDAY=MO,TH']]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.warnings).toEqual([]);
        expect(result.parsedData?.tasks[0].recurrence).toEqual({
            rule: 'weekly',
            byDay: ['MO', 'TH'],
            rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
        });
    });

    it('reads the after-completion token back as the fluid strategy', () => {
        const csv = buildCsv(['Title', 'Recurrence'], [['Water plants', 'FREQ=DAILY;INTERVAL=3;X-MINDWTR-STRATEGY=FLUID']]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.warnings).toEqual([]);
        expect(result.parsedData?.tasks[0].recurrence).toEqual({
            rule: 'daily',
            strategy: 'fluid',
            rrule: 'FREQ=DAILY;INTERVAL=3',
        });
    });

    it('applies an imported recurrence to the created task', () => {
        const csv = buildCsv(['Title', 'Recurrence'], [['Pay rent', 'FREQ=MONTHLY;BYMONTHDAY=1']]);
        const parsedData = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv }).parsedData as ParsedMindwtrCsvImportData;

        const result = applyMindwtrCsvImport(mockAppData([], [], []), parsedData, { now: '2026-08-08T12:00:00.000Z' });

        expect(result.data.tasks[0].recurrence).toMatchObject({ rule: 'monthly', byMonthDay: [1] });
    });

    // A rule the model cannot express must never be imported as the nearest thing it can:
    // FREQ=MONTHLY;BYSETPOS=2;BYDAY=TU means "second Tuesday", and dropping BYSETPOS would
    // silently turn it into "every Tuesday".
    it.each([
        ['unparseable text', 'every other Tuesday'],
        ['an unsupported frequency', 'FREQ=HOURLY;INTERVAL=6'],
        ['an unsupported rule part', 'FREQ=MONTHLY;BYSETPOS=2;BYDAY=TU'],
    ])('imports the task without recurrence and names the row when the rule has %s', (_label, rule) => {
        const csv = buildCsv(['Title', 'Recurrence'], [['Fine row', 'FREQ=DAILY'], ['Odd row', rule]]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.tasks.map((item) => item.title)).toEqual(['Fine row', 'Odd row']);
        expect(result.parsedData?.tasks[1].recurrence).toBeUndefined();
        expect(result.warnings).toContain('1 Recurrence rule could not be understood; that task was imported without recurrence.');
        expect(result.warnings).toContain(`Unsupported Recurrence rules: row 3: ${rule}.`);
    });

    it('lists at most three unsupported Recurrence rules alongside the total', () => {
        const csv = buildCsv(
            ['Title', 'Recurrence'],
            Array.from({ length: 4 }, (_unused, index) => [`Row ${index}`, `every ${index} Tuesdays`]),
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.warnings).toContain('4 Recurrence rules could not be understood; those tasks were imported without recurrence.');
        expect(result.warnings).toContain('Unsupported Recurrence rules: row 2: every 0 Tuesdays; row 3: every 1 Tuesdays; row 4: every 2 Tuesdays.');
    });

    it('imports a file with no Recurrence column unchanged', () => {
        const csv = buildCsv(['Title', 'Due Date'], [['No column', '2026-09-01']]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.warnings).toEqual([]);
        expect(result.parsedData?.tasks[0].recurrence).toBeUndefined();
    });

    it('warns when a date cell cannot be parsed', () => {
        const csv = buildCsv(['Title', 'Due Date'], [['Bad date', '09/05/2026']]);

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });

        expect(result.parsedData?.tasks).toMatchObject([{ dueDate: undefined }]);
        expect(result.warnings).toContain('1 date value could not be parsed and was skipped. [csv-locations=0:2:2; omitted=0]');
    });

    it('warns when an ID value is duplicated within one import', () => {
        const csv = buildCsv(
            ['Title', 'Area', 'Project', 'Section', 'ID'],
            [
                ['First', 'Work', 'Ops', 'Backlog', 'dup-1'],
                ['Second', 'Home', 'Personal', 'Later', 'dup-1'],
            ]
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });
        const applied = applyMindwtrCsvImport(
            mockAppData([], [], []),
            result.parsedData as ParsedMindwtrCsvImportData,
        );

        expect(result.warnings).toContain('1 row had an ID that duplicated an earlier row in this import and was dropped.');
        expect(result.preview).toMatchObject({
            areaCount: 1,
            projectCount: 1,
            sectionCount: 1,
            taskCount: 1,
            projects: [{ areaName: 'Work', name: 'Ops', taskCount: 1 }],
        });
        expect(result.parsedData?.tasks.map((task) => task.title)).toEqual(['First']);
        expect(applied.importedTaskCount).toBe(1);
        expect(applied.data.areas.map((area) => area.name)).toEqual(['Work']);
        expect(applied.data.projects.map((project) => project.title)).toEqual(['Ops']);
        expect(applied.data.sections.map((section) => section.title)).toEqual(['Backlog']);
        expect(applied.warnings.some((warning) => warning.includes('already imported earlier'))).toBe(false);
    });

    it('does not warn that distinct tuple-shaped IDs were dropped when both import', () => {
        const csv = buildCsv(
            ['Title', 'Area', 'Project', 'ID'],
            [
                ['Colon in ID', '', 'a', 'b:c'],
                ['Colon in project path', 'a', 'b', 'c'],
            ],
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });
        const applied = applyMindwtrCsvImport(
            mockAppData([], [], []),
            result.parsedData as ParsedMindwtrCsvImportData,
        );

        expect(result.warnings.some((warning) => warning.includes('duplicated an earlier row'))).toBe(false);
        expect(applied.importedTaskCount).toBe(2);
    });

    it('keeps an explicit row-shaped ID distinct from a synthetic row fallback', () => {
        const csv = buildCsv(
            ['Title', 'ID'],
            [
                ['Synthetic fallback', ''],
                ['Explicit stable ID', 'row-2'],
            ],
        );

        const result = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv });
        const applied = applyMindwtrCsvImport(
            mockAppData([], [], []),
            result.parsedData as ParsedMindwtrCsvImportData,
        );

        expect(result.preview?.taskCount).toBe(2);
        expect(result.warnings.some((warning) => warning.includes('duplicated an earlier row'))).toBe(false);
        expect(applied.importedTaskCount).toBe(2);
        expect(applied.data.tasks.map((task) => task.title)).toEqual([
            'Synthetic fallback',
            'Explicit stable ID',
        ]);
    });

    it('reuses the preceding global task ID for an unambiguous explicit CSV ID', () => {
        const parsed = parseMindwtrCsvImportSource({
            fileName: 'export.csv',
            text: buildCsv(['Title', 'Project', 'ID'], [['Existing task', 'Ops', 'stable-task']]),
        }).parsedData as ParsedMindwtrCsvImportData;
        const first = applyMindwtrCsvImport(mockAppData([], [], []), parsed, {
            now: '2026-08-08T12:00:00.000Z',
        });
        const precedingGlobalId = generateDeterministicUUID(
            'mindwtr:csv-import:v1:task:stable-task',
        );
        const precedingData = {
            ...first.data,
            tasks: first.data.tasks.map((task) => ({ ...task, id: precedingGlobalId })),
        };

        const second = applyMindwtrCsvImport(precedingData, parsed, {
            now: '2026-08-09T12:00:00.000Z',
        });

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks).toHaveLength(1);
        expect(second.data.tasks[0]?.id).toBe(precedingGlobalId);
    });

    it('does not duplicate records when a file with an ID column is imported again', () => {
        const csv = buildCsv(FULL_HEADERS, [
            [
                'Repeatable task', '', 'next', 'Ops', '', '', '', '', '', '', '', '', '', '',
                '', '', '', '', 'stable-id', '',
            ],
        ]);
        const parsedData = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: csv }).parsedData as ParsedMindwtrCsvImportData;

        const first = applyMindwtrCsvImport(mockAppData([], [], []), parsedData, { now: '2026-08-08T12:00:00.000Z' });
        const second = applyMindwtrCsvImport(first.data, parsedData, { now: '2026-08-09T12:00:00.000Z' });

        expect(first.importedTaskCount).toBe(1);
        expect(second.importedTaskCount).toBe(0);
        expect(second.importedProjectCount).toBe(0);
        expect(second.data.tasks).toHaveLength(first.data.tasks.length);
        expect(second.data.projects).toHaveLength(first.data.projects.length);
    });

    it('keeps a stable task identity when a corrected re-export moves it between projects', () => {
        const firstCsv = buildCsv(
            ['Title', 'Project', 'ID'],
            [['Move me', 'Before', 'stable-task']],
        );
        const movedCsv = buildCsv(
            ['Title', 'Project', 'ID'],
            [['Move me', 'After', 'stable-task']],
        );
        const firstParsed = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: firstCsv })
            .parsedData as ParsedMindwtrCsvImportData;
        const movedParsed = parseMindwtrCsvImportSource({ fileName: 'export.csv', text: movedCsv })
            .parsedData as ParsedMindwtrCsvImportData;

        const first = applyMindwtrCsvImport(mockAppData([], [], []), firstParsed, {
            now: '2026-08-08T12:00:00.000Z',
        });
        const originalTask = first.data.tasks[0];
        const second = applyMindwtrCsvImport(first.data, movedParsed, {
            now: '2026-08-09T12:00:00.000Z',
        });

        expect(second.importedTaskCount).toBe(0);
        expect(second.data.tasks).toHaveLength(1);
        expect(second.data.tasks[0]?.id).toBe(originalTask?.id);
        expect(second.data.tasks[0]?.projectId).toBe(originalTask?.projectId);
    });
});
