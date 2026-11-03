import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

import { splitSqlStatements, SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { SQLITE_BASE_SCHEMA, SQLITE_FTS_SCHEMA, SQLITE_INDEX_SCHEMA } from './sqlite-schema';

const require = createRequire(import.meta.url);

type Statement = {
    run: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
};

type Database = {
    exec: (sql: string) => void;
    close: () => void;
    query?: (sql: string) => Statement;
    prepare?: (sql: string) => Statement;
};

type DatabaseCtor = new (filename: string) => Database;

const loadDatabaseCtor = (): DatabaseCtor | null => {
    const bunGlobal = globalThis as typeof globalThis & { Bun?: unknown };
    if (typeof bunGlobal.Bun !== 'undefined') {
        try {
            const mod = require('bun:sqlite') as { Database: DatabaseCtor };
            return mod.Database;
        } catch {
            return null;
        }
    }
    try {
        const mod = require('node:sqlite') as { DatabaseSync: DatabaseCtor };
        return mod.DatabaseSync;
    } catch {
        return null;
    }
};

const RuntimeDatabase = loadDatabaseCtor();
const describeSqlite = RuntimeDatabase ? describe : describe.skip;


it('has a sqlite runtime available to run the schema suite', () => {
    expect(RuntimeDatabase).not.toBeNull();
});


const prepareSingle = (db: Database, sql: string): Statement => {
    if (typeof db.prepare === 'function') {

        const statement = db.prepare(sql) as unknown as {
            run: (...params: unknown[]) => unknown;
            all: (...params: unknown[]) => unknown[];
            get: (...params: unknown[]) => unknown;
        };
        return {
            run: (params: unknown[] = []) => statement.run(...params),
            all: (params: unknown[] = []) => statement.all(...params),
            get: (params: unknown[] = []) => statement.get(...params),
        };
    }
    if (typeof db.query === 'function') return db.query(sql);
    throw new Error('Unsupported sqlite runtime: missing prepare/query');
};

describe('splitSqlStatements', () => {
    it('keeps trigger bodies with inner semicolons as one statement', () => {
        const statements = splitSqlStatements(SQLITE_BASE_SCHEMA);
        const triggers = statements.filter((statement) => statement.toUpperCase().startsWith('CREATE TRIGGER'));
        expect(triggers).toHaveLength(4);
        for (const trigger of triggers) {
            expect(trigger.toUpperCase()).toMatch(/END$/);
        }

        expect(statements.some((statement) => statement.toUpperCase().startsWith('SELECT RAISE'))).toBe(false);
        expect(statements.some((statement) => statement.toUpperCase() === 'END')).toBe(false);
    });

    it('does not split on semicolons inside string literals or comments', () => {
        expect(splitSqlStatements("INSERT INTO t VALUES ('a;b'); SELECT 1")).toEqual([
            "INSERT INTO t VALUES ('a;b')",
            'SELECT 1',
        ]);
        expect(splitSqlStatements('SELECT 1; -- trailing; comment\nSELECT 2')).toEqual([
            'SELECT 1',
            '-- trailing; comment\nSELECT 2',
        ]);
        expect(splitSqlStatements('SELECT 1 /* not; a; split */; SELECT 2')).toEqual([
            'SELECT 1 /* not; a; split */',
            'SELECT 2',
        ]);
    });

    it('pairs CASE...END inside a trigger body', () => {
        const sql = `
CREATE TRIGGER t AFTER INSERT ON x BEGIN
  UPDATE x SET a = CASE WHEN new.b > 0 THEN 1 ELSE 0 END;
  UPDATE x SET c = 2;
END;
SELECT 1;
`;
        const statements = splitSqlStatements(sql);
        expect(statements).toHaveLength(2);
        expect(statements[0].toUpperCase()).toMatch(/^CREATE TRIGGER/);
        expect(statements[0].toUpperCase()).toMatch(/END$/);
        expect(statements[1]).toBe('SELECT 1');
    });

    it('treats statement-leading BEGIN as transaction control, not a block opener', () => {
        expect(splitSqlStatements('BEGIN IMMEDIATE; INSERT INTO t VALUES (1); COMMIT;')).toEqual([
            'BEGIN IMMEDIATE',
            'INSERT INTO t VALUES (1)',
            'COMMIT',
        ]);
    });

    it('keeps a trailing statement without a semicolon', () => {
        expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1']);
    });
});

describeSqlite('schema replay through single-statement execute (op-sqlite emulation)', () => {
    let db: Database;

    beforeEach(() => {
        if (!RuntimeDatabase) throw new Error('No compatible sqlite runtime available for tests');
        db = new RuntimeDatabase(':memory:');
    });

    afterEach(() => {
        db.close();
    });

    const createSingleStatementClient = (database: Database): SqliteClient => ({
        run: async (sql, params = []) => {
            prepareSingle(database, sql).run(...params);
        },
        all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
            prepareSingle(database, sql).all(...params) as T[],
        get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
            prepareSingle(database, sql).get(...params) as T | undefined,
        exec: async (sql) => {
            for (const statement of splitSqlStatements(sql)) {
                prepareSingle(database, statement).run();
            }
        },
    });

    it('every split schema statement prepares and the triggers are created', async () => {
        for (const schema of [SQLITE_BASE_SCHEMA, SQLITE_FTS_SCHEMA, SQLITE_INDEX_SCHEMA]) {
            for (const statement of splitSqlStatements(schema)) {
                prepareSingle(db, statement).run();
            }
        }
        const triggers = prepareSingle(
            db,
            "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
        ).all() as Array<{ name: string }>;
        expect(triggers.map((row) => row.name)).toEqual([
            'projects_ad',
            'projects_ai',
            'projects_au',
            'projects_validate_insert',
            'projects_validate_update',
            'tasks_ad',
            'tasks_ai',
            'tasks_au',
            'tasks_validate_insert',
            'tasks_validate_update',
        ]);

        expect(() =>
            prepareSingle(
                db,
                "INSERT INTO tasks (id, title, status, createdAt, updatedAt) VALUES ('t1', 'x', 'bogus', '2026-01-01', '2026-01-01')"
            ).run()
        ).toThrow(/invalid_task_status/);
    });

    it('SqliteAdapter.ensureSchema succeeds on a client that prepares one statement per execute', async () => {
        const adapter = new SqliteAdapter(createSingleStatementClient(db));
        await expect(adapter.ensureSchema()).resolves.toBeUndefined();
        const triggerCount = prepareSingle(
            db,
            "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'trigger'"
        ).get() as { count: number };
        expect(Number(triggerCount.count)).toBeGreaterThanOrEqual(10);
    });
});
