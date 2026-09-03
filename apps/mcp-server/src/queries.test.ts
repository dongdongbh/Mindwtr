import { describe, expect, test } from 'bun:test';
import {
    getPerson,
    getProject,
    getTask,
    listPeople,
    listProjects,
    listTasks,
    parseQuickAdd,
    type ProjectRef,
} from './queries.js';
import type { DbClient } from './db.js';
import { filterTasksBySearch } from '@mindwtr/core';

const createMockDb = (
    rows: any[] = [],
    options: { hasTasksFts?: boolean; hasPeopleTable?: boolean; projects?: any[] } = {},
): { db: DbClient; calls: { sql: string; params: any[] }[] } => {
    const calls: { sql: string; params: any[] }[] = [];
    const db: DbClient = {
        prepare: (sql: string) => ({
            all: (...params: any[]) => {
                calls.push({ sql, params });
                if (sql.startsWith('PRAGMA table_info(tasks)')) {
                    return [
                        { name: 'id' },
                        { name: 'title' },
                        { name: 'status' },
                        { name: 'priority' },
                        { name: 'energyLevel' },
                        { name: 'assignedTo' },
                        { name: 'taskMode' },
                        { name: 'startTime' },
                        { name: 'dueDate' },
                        { name: 'recurrence' },
                        { name: 'pushCount' },
                        { name: 'tags' },
                        { name: 'contexts' },
                        { name: 'checklist' },
                        { name: 'description' },
                        { name: 'textDirection' },
                        { name: 'attachments' },
                        { name: 'location' },
                        { name: 'projectId' },
                        { name: 'sectionId' },
                        { name: 'areaId' },
                        { name: 'orderNum' },
                        { name: 'isFocusedToday' },
                        { name: 'timeEstimate' },
                        { name: 'reviewAt' },
                        { name: 'completedAt' },
                        { name: 'createdAt' },
                        { name: 'updatedAt' },
                        { name: 'deletedAt' },
                        { name: 'purgedAt' },
                        { name: 'focusOrder' },
                    ];
                }
                if (sql.startsWith('PRAGMA table_info(projects)')) {
                    return [
                        { name: 'id' },
                        { name: 'title' },
                        { name: 'status' },
                        { name: 'color' },
                        { name: 'orderNum' },
                        { name: 'tagIds' },
                        { name: 'isSequential' },
                        { name: 'sequentialScope' },
                        { name: 'taskSortBy' },
                        { name: 'isFocused' },
                        { name: 'supportNotes' },
                        { name: 'attachments' },
                        { name: 'dueDate' },
                        { name: 'reviewAt' },
                        { name: 'areaId' },
                        { name: 'areaTitle' },
                        { name: 'rev' },
                        { name: 'revBy' },
                        { name: 'createdAt' },
                        { name: 'updatedAt' },
                        { name: 'deletedAt' },
                        { name: 'purgedAt' },
                        { name: 'startDate' },
                    ];
                }
                if (sql.startsWith('PRAGMA table_info(people)')) {
                    if (options.hasPeopleTable === false) return [];
                    return [
                        { name: 'id' },
                        { name: 'name' },
                        { name: 'note' },
                        { name: 'referenceLink' },
                        { name: 'rev' },
                        { name: 'revBy' },
                        { name: 'createdAt' },
                        { name: 'updatedAt' },
                        { name: 'deletedAt' },
                    ];
                }
                if (sql.includes("FROM sqlite_master")) {
                    return options.hasTasksFts ? [{ name: 'tasks_fts' }] : [];
                }
                if (options.projects && sql.includes('FROM projects')) return options.projects;
                // Honor LIMIT/OFFSET: without this the mock hands back every row regardless of
                // pagination, which hid the view filter reading a capped base set (D2).
                if (/LIMIT \? OFFSET \?/.test(sql)) {
                    const [limit, offset] = params.slice(-2) as number[];
                    return rows.slice(offset, offset + limit);
                }
                return rows;
            },
            get: (...params: any[]) => {
                calls.push({ sql, params });
                return rows[0];
            },
            run: (...params: any[]) => {
                calls.push({ sql, params });
                return { changes: 1 };
            },
        }),
        close: () => undefined,
    };
    return { db, calls };
};

describe('mcp queries', () => {
    test('parseQuickAdd resolves project by +Title token', () => {
        const projects: ProjectRef[] = [{ id: 'p1', title: 'Home' }];
        const parsed = parseQuickAdd('Buy milk +Home @errands #weekly', projects);
        expect(parsed.title).toBe('Buy milk');
        expect(parsed.props.projectId).toBe('p1');
        expect(parsed.props.contexts).toEqual(['@errands']);
        expect(parsed.props.tags).toEqual(['#weekly']);
    });

    test('parseQuickAdd parses focus token as implied next', () => {
        const parsed = parseQuickAdd('Call plumber /*', []);
        expect(parsed.title).toBe('Call plumber');
        expect(parsed.props.status).toBe('next');
        expect(parsed.props.isFocusedToday).toBe(true);
    });

    test('listTasks treats SQL wildcards in the search as literal text', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db } = createMockDb([
            { id: 't1', title: '100%_done\\now', status: 'inbox', createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 't2', title: 'anything at all', status: 'inbox', createdAt: now, updatedAt: now, isFocusedToday: 0 },
        ]);

        // Under LIKE these were wildcards needing escaping; core matches them literally.
        expect(listTasks(db, { search: '100%_done\\now', includeDeleted: false }).map((t) => t.id)).toEqual(['t1']);
        expect(listTasks(db, { search: '%', includeDeleted: false }).map((t) => t.id)).toEqual(['t1']);
    });


    // scripts/mindwtr-automation-core.ts (the CLI's list/search path) resolves the same
    // operator query with core's filterTasksBySearch. Same fixture, same query, same task set:
    // the two automation surfaces answer identically.
    test('answers the same operator queries as the CLI automation service', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const fixture = [
            { id: 't1', title: 'Call plumber', status: 'next', contexts: '["@phone"]', tags: '["#home"]', createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 't2', title: 'Call bank', status: 'someday', contexts: '["@phone"]', tags: '[]', createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 't3', title: 'Mow lawn', status: 'next', contexts: '["@home"]', tags: '["#home"]', createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 't4', title: 'Reporting weekly', status: 'inbox', contexts: '[]', tags: '[]', createdAt: now, updatedAt: now, isFocusedToday: 0 },
        ];
        const { db } = createMockDb(fixture);
        const asCoreTasks = fixture.map((row) => ({
            ...row,
            contexts: JSON.parse(row.contexts),
            tags: JSON.parse(row.tags),
        })) as any[];

        for (const query of ['status:next', 'context:@phone', 'tag:#home', 'context:@phone -status:someday', '"Call bank"', 'port']) {
            const mcpIds = listTasks(db, { search: query }).map((task) => task.id).sort();
            const cliIds = filterTasksBySearch(asCoreTasks, [], query).map((task) => task.id).sort();
            expect({ query, ids: mcpIds }).toEqual({ query, ids: cliIds });
        }
    });

    // core's filterTasksBySearch drops deletedAt unconditionally, so a search silently wins
    // over includeDeleted. Documented in the tool schema; pinned here.
    test('listTasks search excludes deleted tasks even with includeDeleted', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db } = createMockDb([
            { id: 'live', title: 'Report live', status: 'inbox', createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 'gone', title: 'Report gone', status: 'inbox', deletedAt: now, createdAt: now, updatedAt: now, isFocusedToday: 0 },
        ]);

        expect(listTasks(db, { includeDeleted: true }).map((t) => t.id).sort()).toEqual(['gone', 'live']);
        expect(listTasks(db, { includeDeleted: true, search: 'Report' }).map((t) => t.id)).toEqual(['live']);
    });

    // V2 guard: the sequential-chain scan is O(all), so deriving it inside the filter made the
    // view O(matched x all) — 10s at 10k tasks. Coarse on purpose: a wall-clock budget would be
    // flaky, but a quadratic reintroduction shows up as a ~4x jump when the library doubles.
    test('listTasks view cost grows about linearly with the library', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const build = (count: number) => createMockDb(
            Array.from({ length: count }, (_unused, index) => ({
                id: `t${String(index).padStart(5, '0')}`,
                title: `Task ${index}`,
                status: 'next',
                projectId: 'p-seq',
                orderNum: index,
                createdAt: now,
                updatedAt: now,
                isFocusedToday: 0,
            })),
            { projects: [{ id: 'p-seq', title: 'Sequential', status: 'active', isSequential: 1, createdAt: now, updatedAt: now }] },
        ).db;

        const time = (count: number) => {
            const db = build(count);
            const started = performance.now();
            listTasks(db, { view: 'blocked', limit: 1000 });
            return performance.now() - started;
        };

        time(500); // warm up, so JIT does not inflate the first real sample
        const small = time(1000);
        const large = time(2000);

        // Linear would be ~2x; quadratic ~4x. 3x leaves room for noise on a loaded machine.
        expect(large < Math.max(small, 1) * 3).toBe(true);
    });

    // D2: eligibility depends on the whole library, so the base set must not be a page.
    // Step 1 sits past the 200-row default limit; if the view path reads a capped set it
    // cannot see it, designates step 2 as first, and reports a blocked task as available.
    test('listTasks view sees sequential step 1 beyond the pagination default', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const filler = Array.from({ length: 250 }, (_unused, index) => ({
            id: `filler-${String(index).padStart(3, '0')}`,
            title: `Filler ${index}`,
            status: 'someday',
            projectId: null,
            createdAt: now,
            updatedAt: now,
            isFocusedToday: 0,
        }));
        // Both steps sit PAST the 200-row default so a capped base set sees neither, and the
        // mock returns rows in array order (it does not honor ORDER BY).
        const { db } = createMockDb([
            ...filler,
            { id: 'step1', title: 'Step one', status: 'next', projectId: 'p-seq', orderNum: 1, createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 'step2', title: 'Step two', status: 'next', projectId: 'p-seq', orderNum: 2, createdAt: now, updatedAt: now, isFocusedToday: 0 },
        ], { projects: [{ id: 'p-seq', title: 'Sequential', status: 'active', isSequential: 1, createdAt: now, updatedAt: now }] });

        expect(listTasks(db, { view: 'available' }).map((t) => t.id)).toEqual(['step1']);
        expect(listTasks(db, { view: 'blocked' }).map((t) => t.id)).toEqual(['step2']);
    });

    // The GTD availability question ("what can I actually do now") — deferral and sequential
    // blocking come from core's getTaskFocusEligibility, not re-derived here.
    test('listTasks view splits available, deferred and blocked', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const future = '2099-01-01T00:00:00.000Z';
        const { db } = createMockDb([
            { id: 'ready', title: 'Ready', status: 'next', projectId: null, createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 'later', title: 'Later', status: 'next', projectId: null, startTime: future, createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 'step1', title: 'Step one', status: 'next', projectId: 'p-seq', orderNum: 1, createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 'step2', title: 'Step two', status: 'next', projectId: 'p-seq', orderNum: 2, createdAt: now, updatedAt: now, isFocusedToday: 0 },
        ], { projects: [{ id: 'p-seq', title: 'Sequential', status: 'active', isSequential: 1, createdAt: now, updatedAt: now }] });

        expect(listTasks(db, { view: 'available' }).map((t) => t.id).sort()).toEqual(['ready', 'step1']);
        expect(listTasks(db, { view: 'deferred' }).map((t) => t.id)).toEqual(['later']);
        expect(listTasks(db, { view: 'blocked' }).map((t) => t.id)).toEqual(['step2']);
        // Without a view the deferred and blocked tasks are still listed.
        expect(listTasks(db, {}).map((t) => t.id).sort()).toEqual(['later', 'ready', 'step1', 'step2']);
    });

    test('listTasks filters isFocusedToday with a NULL-safe predicate', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb([
            { id: 't1', title: 'Task', status: 'inbox', createdAt: now, updatedAt: now, isFocusedToday: 1 },
        ]);

        listTasks(db, { isFocusedToday: false, includeDeleted: false });
        const queryCall = calls.find((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM tasks '));
        // isFocusedToday reaches existing databases via ALTER TABLE ADD COLUMN
        // (TASK_SQLITE_MIGRATION_COLUMNS), and SQLite backfills already-stored rows with
        // NULL rather than 0. A bare `isFocusedToday = 0` therefore returns nothing for
        // every task written before the column existed, so pin the NULL-safe form.
        expect(queryCall?.sql.includes('COALESCE(isFocusedToday, 0) = ?')).toBe(true);
        expect(queryCall?.sql.includes('WHERE isFocusedToday = ?')).toBe(false);
        expect(queryCall?.params).toContain(0);
    });

    test('listTasks keeps isFocusedToday filters narrow when the column is missing', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb([
            { id: 't1', title: 'Task', status: 'inbox', createdAt: now, updatedAt: now },
        ]);
        // A database old enough to predate the migration has no such column at all;
        // referencing it would throw and take the whole tool down.
        const originalPrepare = db.prepare.bind(db);
        db.prepare = (sql: string) => {
            if (sql.startsWith('PRAGMA table_info(tasks)')) {
                return { all: () => [{ name: 'id' }, { name: 'title' }, { name: 'status' }, { name: 'createdAt' }, { name: 'updatedAt' }] } as never;
            }
            return originalPrepare(sql);
        };

        expect(listTasks(db, { isFocusedToday: true, includeDeleted: false })).toEqual([]);
        expect(listTasks(db, { isFocusedToday: false, includeDeleted: false })).toHaveLength(1);
        const queryCall = calls.find((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM tasks '));
        expect(queryCall?.sql.includes('isFocusedToday')).toBe(false);
    });

    test('listTasks runs the search through core, not SQL', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb(
            [
                { id: 't1', title: 'Write the report', status: 'inbox', createdAt: now, updatedAt: now, isFocusedToday: 0 },
                { id: 't2', title: 'Book flights', status: 'inbox', createdAt: now, updatedAt: now, isFocusedToday: 0 },
            ],
            { hasTasksFts: true },
        );

        const tasks = listTasks(db, { search: 'report', includeDeleted: false });

        expect(tasks.map((task) => task.id)).toEqual(['t1']);
        // No FTS MATCH and no LIKE: the operator language cannot be expressed in SQL, so the
        // query runs in core over the rows the other filters selected.
        const queryCall = calls.find((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM tasks '));
        expect(queryCall?.sql.includes('tasks_fts MATCH ?')).toBe(false);
        expect(queryCall?.sql.includes('LIKE ?')).toBe(false);
    });

    test('listTasks supports the documented search operators', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db } = createMockDb([
            { id: 't1', title: 'Call plumber', status: 'next', contexts: '["@phone"]', createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 't2', title: 'Call bank', status: 'someday', contexts: '["@phone"]', createdAt: now, updatedAt: now, isFocusedToday: 0 },
            { id: 't3', title: 'Mow lawn', status: 'next', contexts: '["@home"]', createdAt: now, updatedAt: now, isFocusedToday: 0 },
        ]);

        expect(listTasks(db, { search: 'status:next' }).map((t) => t.id)).toEqual(['t1', 't3']);
        expect(listTasks(db, { search: 'context:@phone' }).map((t) => t.id)).toEqual(['t1', 't2']);
        expect(listTasks(db, { search: 'context:@phone -status:someday' }).map((t) => t.id)).toEqual(['t1']);
        expect(listTasks(db, { search: '"Call bank"' }).map((t) => t.id)).toEqual(['t2']);
    });

    // searchAll caps results at SEARCH_RESULT_LIMIT (200) BEFORE any caller paginates, so
    // routing through it would strand every match past the 200th. listTasks uses the uncapped
    // predicate: limit/offset page the FULL match set.
    test('listTasks paginates the whole search match set, past 200', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const rows = Array.from({ length: 250 }, (_unused, index) => ({
            id: `t${String(index).padStart(3, '0')}`,
            title: `Report ${index}`,
            status: 'inbox',
            createdAt: now,
            updatedAt: now,
            isFocusedToday: 0,
        }));
        const { db } = createMockDb(rows);

        expect(listTasks(db, { search: 'Report', limit: 500 })).toHaveLength(250);
        const page = listTasks(db, { search: 'Report', limit: 10, offset: 240 });
        expect(page).toHaveLength(10);
        expect(page[0]?.id).toBe('t240');
    });


    test('listTasks compares mixed date-only and datetime due filters as dates', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb([
            {
                id: 't1',
                title: 'Task',
                status: 'inbox',
                dueDate: '2026-02-01',
                createdAt: now,
                updatedAt: now,
                isFocusedToday: 0,
            },
        ]);

        listTasks(db, {
            dueDateFrom: '2026-02-01T00:00:00.000Z',
            dueDateTo: '2026-02-01T23:59:59.999Z',
            includeDeleted: false,
        });

        const queryCall = calls.find((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM tasks '));
        expect(queryCall).toBeTruthy();
        expect(queryCall?.sql).toContain('date(dueDate) >= date(?)');
        expect(queryCall?.sql).toContain('date(dueDate) <= date(?)');
    });

    test('listTasks caches task column introspection per db client', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb([
            {
                id: 't1',
                title: 'Task',
                status: 'inbox',
                createdAt: now,
                updatedAt: now,
                isFocusedToday: 0,
            },
        ]);

        listTasks(db, { includeDeleted: false });
        listTasks(db, { includeDeleted: false });

        const pragmaCalls = calls.filter((call) => call.sql.startsWith('PRAGMA table_info(tasks)'));
        expect(pragmaCalls).toHaveLength(1);
    });

    test('listTasks exposes sectionId, areaId, textDirection, and location fields', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db } = createMockDb([
            {
                id: 't1',
                title: 'Task',
                status: 'inbox',
                textDirection: 'rtl',
                location: 'Office',
                projectId: 'p1',
                sectionId: 's1',
                areaId: 'a1',
                createdAt: now,
                updatedAt: now,
                isFocusedToday: 0,
            },
        ]);

        const tasks = listTasks(db, { includeDeleted: false });

        expect(tasks).toHaveLength(1);
        expect(tasks[0]).toMatchObject({
            textDirection: 'rtl',
            location: 'Office',
            projectId: 'p1',
            sectionId: 's1',
            areaId: 'a1',
        });
    });

    test('maps area, section, text direction, and location fields from task rows', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db } = createMockDb([
            {
                id: 't1',
                title: 'Task',
                status: 'inbox',
                textDirection: 'rtl',
                location: 'Office',
                projectId: 'p1',
                sectionId: 's1',
                areaId: 'a1',
                createdAt: now,
                updatedAt: now,
                isFocusedToday: 0,
            },
        ]);

        const [task] = listTasks(db, { includeDeleted: false });

        expect(task.textDirection).toBe('rtl');
        expect(task.location).toBe('Office');
        expect(task.projectId).toBe('p1');
        expect(task.sectionId).toBe('s1');
        expect(task.areaId).toBe('a1');
    });

    test('listTasks and getTask preserve focusOrder from sqlite', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb([
            {
                id: 't1',
                title: 'Focused task',
                status: 'next',
                isFocusedToday: 1,
                focusOrder: 4,
                createdAt: now,
                updatedAt: now,
            },
        ]);

        expect(listTasks(db, { includeDeleted: false })[0]?.focusOrder).toBe(4);
        expect(getTask(db, { id: 't1' }).focusOrder).toBe(4);

        const taskSelects = calls.filter((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM tasks'));
        expect(taskSelects).toHaveLength(2);
        expect(taskSelects.every((call) => call.sql.includes('focusOrder'))).toBe(true);
    });

    test('listProjects and getProject preserve taskSortBy from sqlite', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb([
            {
                id: 'p1',
                title: 'Release',
                status: 'active',
                color: '#3B82F6',
                orderNum: 0,
                tagIds: '[]',
                isSequential: 0,
                taskSortBy: 'due',
                createdAt: now,
                updatedAt: now,
            },
        ]);

        expect(listProjects(db)[0]?.taskSortBy).toBe('due');
        expect(getProject(db, { id: 'p1' }).taskSortBy).toBe('due');

        const projectSelects = calls.filter((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM projects'));
        expect(projectSelects).toHaveLength(2);
        expect(projectSelects.every((call) => call.sql.includes('taskSortBy'))).toBe(true);
    });

    test('listProjects and getProject preserve startDate from sqlite, the same as dueDate', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb([
            {
                id: 'p1',
                title: 'Release',
                status: 'active',
                color: '#3B82F6',
                orderNum: 0,
                tagIds: '[]',
                isSequential: 0,
                dueDate: '2026-05-10',
                startDate: '2026-04-15',
                createdAt: now,
                updatedAt: now,
            },
        ]);

        expect(listProjects(db)[0]?.dueDate).toBe('2026-05-10');
        expect(listProjects(db)[0]?.startDate).toBe('2026-04-15');
        expect(getProject(db, { id: 'p1' }).startDate).toBe('2026-04-15');

        const projectSelects = calls.filter((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM projects'));
        expect(projectSelects.every((call) => call.sql.includes('startDate'))).toBe(true);
    });

    test('listPeople maps active managed people from sqlite rows', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb([
            {
                id: 'person1',
                name: 'Alex',
                note: 'Design lead',
                referenceLink: 'https://example.com/alex',
                rev: 2,
                revBy: 'device-a',
                createdAt: now,
                updatedAt: now,
            },
        ]);

        const people = listPeople(db);

        expect(people).toEqual([
            {
                id: 'person1',
                name: 'Alex',
                note: 'Design lead',
                referenceLink: 'https://example.com/alex',
                rev: 2,
                revBy: 'device-a',
                createdAt: now,
                updatedAt: now,
                deletedAt: undefined,
            },
        ]);
        const queryCall = calls.find((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM people'));
        expect(queryCall?.sql).toContain('WHERE deletedAt IS NULL');
    });

    test('getPerson reports not found when the people table is absent', () => {
        const { db } = createMockDb([], { hasPeopleTable: false });

        expect(() => getPerson(db, { id: 'person1' })).toThrow('Person not found: person1');
        expect(listPeople(db)).toEqual([]);
    });
});
