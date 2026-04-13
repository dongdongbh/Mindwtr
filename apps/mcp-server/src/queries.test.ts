import { describe, expect, test } from 'bun:test';
import { addTask, deleteTask, listTasks, parseQuickAdd, updateTask, type Project } from './queries.js';
import type { DbClient } from './db.js';

const createMockDb = (
    rows: any[] = [],
    options: { hasTasksFts?: boolean } = {},
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
                    ];
                }
                if (sql.includes("FROM sqlite_master")) {
                    return options.hasTasksFts ? [{ name: 'tasks_fts' }] : [];
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
        const projects: Project[] = [{ id: 'p1', title: 'Home' }];
        const parsed = parseQuickAdd('Buy milk +Home @errands #weekly', projects);
        expect(parsed.title).toBe('Buy milk');
        expect(parsed.props.projectId).toBe('p1');
        expect(parsed.props.contexts).toEqual(['@errands']);
        expect(parsed.props.tags).toEqual(['#weekly']);
    });

    test('listTasks escapes wildcard characters in search input', () => {
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

        const tasks = listTasks(db, { search: '100%_done\\now', includeDeleted: false });
        expect(tasks).toHaveLength(1);
        const queryCall = calls.find((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM tasks '));
        expect(queryCall).toBeTruthy();
        expect(queryCall?.params[0]).toBe('%100\\%\\_done\\\\now%');
        expect(queryCall?.params[1]).toBe('%100\\%\\_done\\\\now%');
    });

    test('listTasks uses FTS search when tasks_fts is available', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb(
            [
                {
                    id: 't1',
                    title: 'Task',
                    status: 'inbox',
                    createdAt: now,
                    updatedAt: now,
                    isFocusedToday: 0,
                },
            ],
            { hasTasksFts: true },
        );

        listTasks(db, { search: 'project alpha', includeDeleted: false });
        const queryCall = calls.find((call) => call.sql.startsWith('SELECT') && call.sql.includes('FROM tasks '));
        expect(queryCall).toBeTruthy();
        expect(queryCall?.sql.includes('tasks_fts MATCH ?')).toBe(true);
        expect(queryCall?.params[0]).toBe('project* alpha*');
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

    test('addTask quickAdd uses lightweight project lookup', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb([{ id: 'p1', title: 'Home', createdAt: now, updatedAt: now }]);

        const created = addTask(db, { quickAdd: 'Buy milk +Home' });

        expect(created.title).toBe('Buy milk');
        expect(created.projectId).toBe('p1');
        const projectLookup = calls.find((call) => call.sql.startsWith('SELECT id, title FROM projects WHERE deletedAt IS NULL'));
        expect(projectLookup).toBeTruthy();
    });

    test('wraps addTask in a transaction', () => {
        const now = '2026-02-01T00:00:00.000Z';
        const { db, calls } = createMockDb([{ id: 'p1', title: 'Home', createdAt: now, updatedAt: now }]);

        addTask(db, { title: 'Task in tx' });

        expect(calls.some((call) => call.sql === 'BEGIN IMMEDIATE')).toBe(true);
        expect(calls.some((call) => call.sql === 'COMMIT')).toBe(true);
    });

    test('rolls back addTask transaction on error', () => {
        const { db, calls } = createMockDb([]);

        expect(() => addTask(db, { title: '   ' })).toThrow('Task title is required.');

        expect(calls.some((call) => call.sql === 'BEGIN IMMEDIATE')).toBe(true);
        expect(calls.some((call) => call.sql === 'ROLLBACK')).toBe(true);
    });

    test('rejects invalid task status instead of defaulting to inbox', () => {
        const { db, calls } = createMockDb([]);

        expect(() => addTask(db, { title: 'Task', status: 'not-a-status' as any })).toThrow('Invalid task status: not-a-status');

        expect(calls.some((call) => call.sql === 'BEGIN IMMEDIATE')).toBe(true);
        expect(calls.some((call) => call.sql === 'ROLLBACK')).toBe(true);
    });

    test('wraps updateTask and deleteTask in transactions', () => {
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

        updateTask(db, { id: 't1', title: 'Updated' });
        deleteTask(db, { id: 't1' });

        const beginCount = calls.filter((call) => call.sql === 'BEGIN IMMEDIATE').length;
        const commitCount = calls.filter((call) => call.sql === 'COMMIT').length;
        expect(beginCount).toBe(2);
        expect(commitCount).toBe(2);
    });

    test('rejects invalid status when updating tasks', () => {
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

        expect(() => updateTask(db, { id: 't1', status: 'bad-status' as any })).toThrow('Invalid task status: bad-status');

        const rollbackCount = calls.filter((call) => call.sql === 'ROLLBACK').length;
        expect(rollbackCount).toBe(1);
    });

    test('updates energyLevel and assignedTo when provided', () => {
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

        updateTask(db, { id: 't1', energyLevel: 'high', assignedTo: 'Alex' });

        const updateCall = calls.find((call) => call.sql.includes('UPDATE tasks'));
        expect(updateCall).toBeTruthy();
        expect(updateCall?.params[0]).toMatchObject({
            energyLevel: 'high',
            assignedTo: 'Alex',
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
});
