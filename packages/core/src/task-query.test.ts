import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { taskMatchesQuery } from './task-query';
import { SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import type { AppData, Project, Task } from './types';
import type { TaskQueryOptions } from './storage';


type TaskQueryFixtureCase = {
    name: string;
    tasks: Task[];
    containers?: { projects?: Array<Pick<Project, 'id' | 'title' | 'status' | 'color' | 'createdAt' | 'updatedAt'>> };
    query: TaskQueryOptions;
    expectedIds: string[];
    rustQuery: Record<string, string> | null;
};

const fixtureCases = JSON.parse(
    readFileSync(new URL('./task-query.fixtures.json', import.meta.url), 'utf8')
) as TaskQueryFixtureCase[];


const PINNED_CASE_NAMES = [
    'JS default hides archived but keeps done (core matcher / sqlite-adapter / mobile default)',
    'includeArchived true opts out of default hiding entirely (mcp list_tasks contract)',
    'includeArchived false plus excludeStatuses done hides both (cloud REST API / desktop local API default)',
    'includeDeleted true surfaces soft-deleted tasks alongside includeArchived true',
    'explicit single status filter',
    'status all sentinel disables status filtering',
    'excludeStatuses filters an arbitrary status list',
    'projectId filters to one project',
    'isFocusedToday true matches only starred tasks',
    'isFocusedToday false matches unstarred and never-set tasks (NULL-safe)',
    'isFocusedToday omitted applies no focus filter',
].sort();

const matchedIds = (tasks: Task[], query: TaskQueryOptions): string[] =>
    tasks.filter((task) => taskMatchesQuery(task, query)).map((task) => task.id).sort();

describe('task query fixture (taskMatchesQuery)', () => {
    it('covers exactly the pinned case roster', () => {
        expect(fixtureCases.map((testCase) => testCase.name).sort()).toEqual(PINNED_CASE_NAMES);
    });

    it.each(fixtureCases.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
        expect(matchedIds(testCase.tasks, testCase.query)).toEqual([...testCase.expectedIds].sort());
    });
});


const require = createRequire(import.meta.url);
type BunStatement = { run: (params?: unknown[]) => unknown; all: (params?: unknown[]) => unknown[] };
type NodeStatement = { run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[] };
type Database = { exec: (sql: string) => void; close: () => void; query?: (sql: string) => BunStatement; prepare?: (sql: string) => NodeStatement };
type DatabaseCtor = new (filename: string) => Database;

const loadDatabaseCtor = (): DatabaseCtor | null => {
    const bunGlobal = globalThis as typeof globalThis & { Bun?: unknown };
    if (typeof bunGlobal.Bun !== 'undefined') {
        try {
            return (require('bun:sqlite') as { Database: DatabaseCtor }).Database;
        } catch {
            return null;
        }
    }
    try {
        return (require('node:sqlite') as { DatabaseSync: DatabaseCtor }).DatabaseSync;
    } catch {
        return null;
    }
};

const RuntimeDatabase = loadDatabaseCtor();
const describeSqlite = RuntimeDatabase ? describe : describe.skip;


it('has a sqlite runtime available to run the buildTaskWhere fixture suite', () => {
    expect(RuntimeDatabase).not.toBeNull();
});

const createClient = (db: Database): SqliteClient => ({
    run: async (sql, params = []) => {
        const statement = db.prepare ? db.prepare(sql) : db.query!(sql);
        if (db.prepare) (statement as NodeStatement).run(...params);
        else (statement as BunStatement).run(params);
    },
    all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const statement = db.prepare ? db.prepare(sql) : db.query!(sql);
        return (db.prepare ? (statement as NodeStatement).all(...params) : (statement as BunStatement).all(params)) as T[];
    },
    get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const rows = await createClient(db).all<T>(sql, params);
        return rows[0];
    },
    exec: async (sql) => { db.exec(sql); },
});

const emptyAppData = (tasks: Task[], projects: Project[]): AppData => ({
    tasks,
    projects,
    sections: [],
    areas: [],
    people: [],
    settings: {},
});

describeSqlite('task query fixture (buildTaskWhere via SqliteAdapter.queryTasks)', () => {
    let db: Database;
    let adapter: SqliteAdapter;

    beforeEach(() => {
        db = new RuntimeDatabase!(':memory:');
        adapter = new SqliteAdapter(createClient(db));
    });

    afterEach(() => {
        db.close();
    });

    it.each(fixtureCases.map((testCase) => [testCase.name, testCase] as const))('%s', async (_name, testCase) => {
        await adapter.saveData(emptyAppData(testCase.tasks, (testCase.containers?.projects ?? []) as Project[]));
        if (testCase.name === 'isFocusedToday false matches unstarred and never-set tasks (NULL-safe)') {


            await createClient(db).run("UPDATE tasks SET isFocusedToday = NULL WHERE id = 'missing-focus-1'");
        }
        const rows = await adapter.queryTasks(testCase.query);
        expect(rows.map((task) => task.id).sort()).toEqual([...testCase.expectedIds].sort());
    });
});
