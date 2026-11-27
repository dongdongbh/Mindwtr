import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mapSqliteTaskRow, SqliteAdapter, type SqliteClient } from './sqlite-adapter';
import { normalizeTaskForLoad, type TaskLoadTemporalContext } from './task-status';
import { TASK_SQLITE_COLUMNS, taskToSqliteRow } from './task-sync-schema';
import type { AppData, Task } from './types';

const corpusFile = join(dirname(fileURLToPath(import.meta.url)), 'task-load-normalizer-corpus.json');
const updating = process.env.UPDATE_LOAD_NORMALIZER_CORPUS === '1';
const NOW = '2026-10-27T10:00:00.000Z';
const AT = '2026-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T09:00:00.000Z';
const TEMPORAL: TaskLoadTemporalContext = { futureBoundary: '2026-10-27T23:59:59.999Z',
    dates: new Map([[FUTURE, { parsedAt: Date.parse(FUTURE) }], ['2020-01-01T09:00:00.000Z', { parsedAt: Date.parse('2020-01-01T09:00:00.000Z') }]]) };

const encode = (value: unknown): unknown => {
    if (value === undefined) return { $: 'undefined' };
    if (typeof value === 'number') {
        if (Number.isNaN(value)) return { $: 'NaN' };
        if (Object.is(value, -0)) return { $: '-0' };
        if (!Number.isFinite(value)) return { $: String(value) };
        return value;
    }
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return { $: typeof value };
    if (Array.isArray(value)) return { $array: value.map(encode) };
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return { $proto: Object.getPrototypeOf(value) === Object.prototype ? 'object' : 'other',
            $keys: Object.keys(record).map((key) => [key, encode(record[key])]) };
    }
    return value;
};

const loaded = (input: Task, output: Task) => {
    const inputRecord = input as unknown as Record<string, unknown>;
    const outputRecord = output as unknown as Record<string, unknown>;
    return {
        same: output === input,
        shared: Object.keys(outputRecord).filter((key) => outputRecord[key] !== null && typeof outputRecord[key] === 'object'
            && outputRecord[key] === inputRecord[key]),
        output: encode(output),
    };
};

const normalizeBoth = (input: Task) => {
    const before = JSON.stringify(encode(input));
    const plain = loaded(input, normalizeTaskForLoad(input, NOW));
    const timed = loaded(input, normalizeTaskForLoad(input, NOW, TEMPORAL));
    expect(JSON.stringify(encode(input))).toBe(before);
    return { plain, timed };
};

const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const sqliteRow = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...Object.fromEntries(TASK_SQLITE_COLUMNS.map((column) => [column, null])),
    id: 'row', title: 'Row', status: 'next', tags: '[]', contexts: '[]', pushCount: 0, createdAt: AT, updatedAt: AT, ...overrides,
});

const storeTask = (): Task => ({ id: 's', title: 'Store task', status: 'next', tags: ['t'], contexts: ['@home'], createdAt: AT, updatedAt: AT,
    rev: 3, revBy: 'device-a', pushCount: 0 } as Task);
const jsonTask = (): Task => ({ id: 'j', title: 'Desktop JSON task', status: 'inbox', tags: [], contexts: [], createdAt: AT, updatedAt: AT } as Task);
const BASES: Array<[string, () => Task]> = [
    ['store', storeTask],
    ['json', jsonTask],
    ['sqlite legacy', () => mapSqliteTaskRow(sqliteRow({ id: 'l', pushCount: null }))],
    ['sqlite synced', () => mapSqliteTaskRow(sqliteRow({ id: 'y', rev: 4, revBy: 'device-b' }))],
    ['normalized', () => normalizeTaskForLoad(storeTask(), NOW)],
];

const FIELD_VALUES: Record<string, unknown[]> = {
    status: ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived', 'planned', 'pending', 'in-progress', 'doing',
        ' DONE ', 'Archived', 'unknown', '', 7, null, undefined],
    createdAt: [AT, '2026-01-01', '2026-02-30T00:00:00.000Z', 'never', '', 5, null, undefined, '2027-01-01T00:00:00.000Z'],
    updatedAt: [AT, '2025-01-01T00:00:00.000Z', '2026-06-01T00:00:00+05:30', 'never', '', 0, null, undefined],
    projectId: ['p', '', '  ', 5, null, undefined],
    areaId: ['a', ' ', '', 9, null, undefined],
    textDirection: ['auto', 'ltr', 'rtl', 'RTL', 'up', '', 1, null, undefined],
    rev: [0, 1, 4, 1.5, -1, '2', Number.NaN, Number.POSITIVE_INFINITY, null, undefined],
    revBy: ['dev', ' dev ', '', '  ', 5, null, undefined],
    order: [0, 5, -0, 2.5, Number.NaN, '3', null, undefined],
    orderNum: [0, 6, Number.NaN, '4', null, undefined],
    pushCount: [0, 2, 1.5, Number.NaN, '1', null, undefined],
    purgedAt: [AT, '', null, undefined],
    deletedAt: [AT, null, undefined],
    completedAt: [AT, '2026-02-01T00:00:00.000Z', '', 'bad', null, undefined],
    cancelledAt: ['2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00+05:30', '2024-02-29T12:00:00Z', '2023-02-29T12:00:00Z',
        '2026-02-01', '2026-13-01T00:00:00Z', '2026-02-01T24:00:00Z', 5, null, undefined],
    isFocusedToday: [true, false, 1, 0, null, undefined],
    focusOrder: [0, 2, Number.NaN, null, undefined],
    startTime: [FUTURE, '2020-01-01T09:00:00.000Z', '2099-01-01', 'bad', null, undefined],
    dueDate: ['2026-11-01', '2026-11-01T09:00:00.000Z', '', null, undefined],
    relativeStartOffset: [{ value: 2, unit: 'days' }, { value: -1, unit: 'weeks' }, { value: 'x', unit: 'days' }, { value: 2, unit: 'years' },
        'x', [], null, undefined],
    recurrence: ['daily', 'weekly', 'bogus', { rule: 'daily' }, { rule: 'weekly', byDay: ['MO', 'WE'] },
        { rule: 'monthly', strategy: 'fluid', byMonthDay: [1, 15] }, { rule: 'bad' }, { rule: 'daily', count: 'x' }, [], 5, '', null, undefined],
    repeatReminderMinutes: [5, 15, 0, -3, 1.5, Number.NaN, 'x', null, undefined],
    dueReminderLeadMinutes: [5, 15, 60, 1440, -5, 13, Number.NaN, 'x', null, undefined],
    startReminderLeadMinutes: [0, 5, 15, 30, 60, 13, 61, -1, Number.NaN, null, undefined],
    timeSpentMinutes: [0, 12, 12.5, -3, Number.NaN, '7', null, undefined],
    checklist: [[{ id: 'c1', title: 'One', isCompleted: false }, { id: 'c2', title: 'Two', isCompleted: true }], [], null, undefined],
    attachments: [[{ id: 'a1', kind: 'link', title: 'Link', uri: 'https://example.com', createdAt: AT, updatedAt: AT }],
        [{ id: 'a2', kind: 'file', title: 'File', uri: 'file.txt', mimeType: 'text/plain', size: 3, createdAt: AT, updatedAt: AT, deletedAt: AT }],
        [], undefined],
    tags: [['a', 'b'], [], undefined],
    legacyField: ['kept', 1, undefined],
};

const variations = (): Array<[string, Task[]]> => BASES.flatMap(([baseName, base]) => Object.entries(FIELD_VALUES).map(([field, values]) => [
    `${baseName} ${field}`,
    values.flatMap((value) => {
        const set = { ...base(), [field]: value } as Task;
        const { [field]: _dropped, ...without } = base() as unknown as Record<string, unknown>;
        return [set, without as unknown as Task];
    }),
] as [string, Task[]]));

const randomTasks = (count: number, seed: number): Task[] => {
    const next = random(seed);
    const fields = Object.entries(FIELD_VALUES);
    return Array.from({ length: count }, (_, index) => {
        const [, base] = BASES[Math.floor(next() * BASES.length)];
        const task = { ...base(), id: `r${index}` } as Record<string, unknown>;
        for (const [field, values] of fields) {
            const roll = next();
            if (roll < 0.25) task[field] = values[Math.floor(next() * values.length)];
            else if (roll < 0.3) delete task[field];
        }
        if (next() < 0.2) {
            const keys = Object.keys(task).sort(() => next() - 0.5);
            return Object.fromEntries(keys.map((key) => [key, task[key]])) as unknown as Task;
        }
        return task as unknown as Task;
    });
};

const specialShapes = (): Array<[string, Task]> => [
    ['own __proto__ key', { ...jsonTask(), ...JSON.parse('{"__proto__":{"polluted":true}}') } as Task],
    ['rev first in key order', { rev: 2, revBy: 'dev', ...jsonTask() } as Task],
    ['revBy without rev', { ...jsonTask(), revBy: 'dev' } as Task],
    ['done focused future start', { ...storeTask(), status: 'done', isFocusedToday: true, focusOrder: 1, startTime: FUTURE } as Task],
    ['next focused future start', { ...storeTask(), isFocusedToday: true, focusOrder: 1, startTime: FUTURE } as Task],
    ['waiting focused future start', { ...storeTask(), status: 'waiting', isFocusedToday: true, focusOrder: 1, startTime: FUTURE } as Task],
    ['waiting focused future no focusOrder key', (() => { const task = { ...storeTask(), status: 'waiting', isFocusedToday: true, startTime: FUTURE } as Record<string, unknown>; delete task.focusOrder; return task as unknown as Task; })()],
    ['next focused already cleared', { ...storeTask(), isFocusedToday: true, focusOrder: undefined, startTime: FUTURE } as Task],
    ['archived cancelled normalized', normalizeTaskForLoad({ ...storeTask(), status: 'archived', cancelledAt: '2026-02-01T00:00:00.000Z' } as Task, NOW)],
    ['done normalized', normalizeTaskForLoad({ ...storeTask(), status: 'done' } as Task, NOW)],
    ['normalized with a bad createdAt and a future updatedAt', { ...normalizeTaskForLoad(storeTask(), NOW), createdAt: 'bad',
        updatedAt: '2099-01-01T00:00:00.000Z' } as Task],
    ['normalized with no createdAt and a future updatedAt', (() => { const task = { ...normalizeTaskForLoad(storeTask(), NOW),
        updatedAt: '2099-01-01T00:00:00.000Z' } as Record<string, unknown>; delete task.createdAt; return task as unknown as Task; })()],
    ['tombstone purged', { ...storeTask(), deletedAt: AT, purgedAt: AT, pushCount: undefined } as Task],
    ['every field', normalizeTaskForLoad({ ...storeTask(), status: 'archived', cancelledAt: '2026-02-01T00:00:00.000Z', projectId: 'p',
        textDirection: 'ltr', order: 3, dueDate: '2026-11-01', relativeStartOffset: { value: 1, unit: 'days' }, recurrence: { rule: 'weekly', byDay: ['MO'] },
        repeatReminderMinutes: 15, dueReminderLeadMinutes: 10, startReminderLeadMinutes: 5, timeSpentMinutes: 5 } as Task, NOW)],
];

const SQLITE_ROWS = (): Array<[string, Record<string, unknown>]> => [
    ['plain', {}],
    ['legacy status', { status: 'planned' }], ['upper status', { status: ' DONE ' }], ['empty status', { status: '' }],
    ['null rev and revBy', { rev: null, revBy: null }], ['synced', { rev: 7, revBy: 'device-c' }], ['blank revBy', { rev: 2, revBy: '  ' }],
    ['padded revBy', { rev: 2, revBy: ' dev ' }], ['negative rev', { rev: -1, revBy: 'dev' }],
    ['text direction', { textDirection: 'rtl', rev: 1, revBy: 'dev' }], ['bad text direction', { textDirection: 'up', rev: 1, revBy: 'dev' }],
    ['null pushCount', { pushCount: null }], ['null pushCount purged', { pushCount: null, deletedAt: AT, purgedAt: AT }],
    ['tombstone', { deletedAt: AT, rev: 3, revBy: 'dev' }],
    ['done without completedAt', { status: 'done', rev: 1, revBy: 'dev' }], ['done with completedAt', { status: 'done', completedAt: AT, rev: 1, revBy: 'dev' }],
    ['next with completedAt', { completedAt: AT, rev: 1, revBy: 'dev' }],
    ['archived cancelled', { status: 'archived', cancelledAt: '2026-02-01T00:00:00.000Z', completedAt: AT, rev: 1, revBy: 'dev' }],
    ['archived bad cancel', { status: 'archived', cancelledAt: 'bad', rev: 1, revBy: 'dev' }],
    ['focused done', { status: 'done', isFocusedToday: 1, focusOrder: 2, completedAt: AT, rev: 1, revBy: 'dev' }],
    ['focused done without focusOrder', { status: 'done', isFocusedToday: 1, completedAt: AT, rev: 1, revBy: 'dev' }],
    ['focused future', { isFocusedToday: 1, focusOrder: 1, startTime: FUTURE, rev: 1, revBy: 'dev' }],
    ['focused future waiting', { status: 'waiting', isFocusedToday: 1, focusOrder: 1, startTime: FUTURE, rev: 1, revBy: 'dev' }],
    ['bad dates', { createdAt: 'never', updatedAt: 'bad', rev: 1, revBy: 'dev' }], ['updated before created', { updatedAt: '2020-01-01T00:00:00.000Z' }],
    ['project and area', { projectId: 'p', areaId: 'a', rev: 1, revBy: 'dev' }], ['blank project', { projectId: ' ', areaId: 'a' }],
    ['order', { orderNum: 4, boardOrder: 2 }],
    ['recurrence json', { recurrence: '{"rule":"weekly","byDay":["MO","WE"]}', showFutureRecurrence: 1, rev: 1, revBy: 'dev' }],
    ['recurrence string json', { recurrence: '"daily"', rev: 1, revBy: 'dev' }], ['recurrence bad json', { recurrence: '{bad' }],
    ['recurrence bad rule', { recurrence: '{"rule":"hourly"}' }],
    ['checklist', { checklist: '[{"id":"c","title":"C","isCompleted":true},{"title":"no id"}]', rev: 1, revBy: 'dev' }],
    ['checklist bad json', { checklist: 'nope' }],
    ['attachments', { attachments: '[{"id":"a","kind":"file","title":"F","uri":"f.txt","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]', rev: 1, revBy: 'dev' }],
    ['tags bad json', { tags: 'x', contexts: '["@a",1]' }],
    ['relative start', { dueDate: '2026-11-01', relativeStartOffset: '{"value":2,"unit":"days"}', rev: 1, revBy: 'dev' }],
    ['relative start no due', { relativeStartOffset: '{"value":2,"unit":"days"}' }],
    ['reminders', { repeatReminderMinutes: 15, dueReminderLeadMinutes: 13, startReminderLeadMinutes: 60, timeSpentMinutes: 5, suppressMindwtrReminders: 1,
        reminderPolicy: 'single', rev: 1, revBy: 'dev' }],
    ['project archive fields', { status: 'archived', statusBeforeProjectArchive: 'next', isFocusedTodayBeforeProjectArchive: 0,
        projectArchivedAt: AT, archivedAt: AT, completedAt: AT, rev: 1, revBy: 'dev' }],
    ['view sections', { viewSectionIds: '{"focus":"s1"}', sectionId: 's', rev: 1, revBy: 'dev' }],
];

const results: Record<string, string> = {};
const frozen: Record<string, string> = updating ? {} : JSON.parse(readFileSync(corpusFile, 'utf8'));
const check = (name: string, value: unknown) => {
    const text = JSON.stringify(value);
    const digest = createHash('sha256').update(text).digest('hex');
    results[name] = digest;
    if (!updating) expect(digest, name).toBe(frozen[name]);
};

const clientFor = (db: DatabaseSync): SqliteClient => ({
    run: async (sql, params = []) => { db.prepare(sql).run(...params as SQLInputValue[]); },
    all: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params as SQLInputValue[]) as T[],
    get: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params as SQLInputValue[]) as T | undefined,
    exec: async (sql) => { db.exec(sql); },
});

const insert = (db: DatabaseSync, table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        .run(...columns.map((column) => row[column]) as SQLInputValue[]);
};

describe('load normalizer frozen corpus', () => {
    afterAll(() => {
        if (!updating) return;
        writeFileSync(corpusFile, `${JSON.stringify(results, null, 1)}\n`);
    });

    it.each(variations())('object field shapes: %s', (name, tasks) => {
        check(`object ${name}`, tasks.map(normalizeBoth));
    });

    it('special object shapes', () => {
        for (const [name, task] of specialShapes()) check(`special ${name}`, normalizeBoth(task));
    });

    it('random mixed shapes', () => {
        const tasks = randomTasks(1200, 20261127);
        for (let from = 0; from < tasks.length; from += 100) check(`random ${from}`, tasks.slice(from, from + 100).map(normalizeBoth));
    });

    it('SQLite rows through mapSqliteTaskRow', () => {
        for (const [name, overrides] of SQLITE_ROWS()) check(`sqlite ${name}`, normalizeBoth(mapSqliteTaskRow(sqliteRow(overrides))));
    });

    it('the performance fixture as stored objects, as SQLite rows and after a first load', async () => {
        const { fixture } = await import('../../../scripts/performance/fixture.mjs');
        const tasks = (fixture(2000) as { data: AppData }).data.tasks;
        const asRows = tasks.map((task) => mapSqliteTaskRow(Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, taskToSqliteRow(task)[index]]))));
        check('fixture objects', tasks.map(normalizeBoth));
        check('fixture rows', asRows.map(normalizeBoth));
        check('fixture reloaded', tasks.map((task) => normalizeBoth(normalizeTaskForLoad(task, NOW))));
    }, 60_000);

    it('a store load from SQLite with legacy task, project, section, area and person rows', async () => {
        const db = new DatabaseSync(':memory:');
        try {
            await new SqliteAdapter(clientFor(db)).getData();
            db.exec('PRAGMA foreign_keys = OFF');
            for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>)
                db.exec(`DROP TRIGGER "${name}"`);
            insert(db, 'areas', { id: 'a', name: 'Area', color: '#ff0000', orderNum: 0, createdAt: AT, updatedAt: AT });
            insert(db, 'areas', { id: 'a-old', name: 'Old area', orderNum: 1, createdAt: 'bad', updatedAt: AT, deletedAt: AT, rev: 2, revBy: 'dev' });
            insert(db, 'projects', { id: 'p', title: 'Project', status: 'active', color: '#000000', orderNum: 0, tagIds: '["#t"]', areaId: 'a',
                createdAt: AT, updatedAt: AT, rev: 1, revBy: 'dev' });
            insert(db, 'projects', { id: 'p-legacy', title: 'Legacy', status: 'someday', color: '#000000', createdAt: AT, updatedAt: AT });
            insert(db, 'projects', { id: 'p-archived', title: 'Archived', status: 'archived', color: '#000000', cancelledAt: 'bad', createdAt: AT, updatedAt: AT,
                attachments: '[{"id":"x","kind":"link","title":"L","uri":"https://example.com","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]' });
            insert(db, 'sections', { id: 's', projectId: 'p', title: 'Section', orderNum: 0, isCollapsed: 1, createdAt: AT, updatedAt: AT });
            insert(db, 'sections', { id: 's-gone', projectId: 'p', title: 'Gone', createdAt: AT, updatedAt: AT, deletedAt: AT });
            insert(db, 'people', { id: 'person', name: 'Ann', createdAt: AT, updatedAt: AT });
            db.prepare('INSERT OR REPLACE INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({ deviceId: 'corpus-device', analyticsProfileId: 'corpus-profile' }));
            SQLITE_ROWS().forEach(([name, overrides], index) => {
                const row = sqliteRow({ ...overrides, id: `sq${index}`, title: name });
                insert(db, 'tasks', Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)));
            });
            const load = async () => {
                vi.resetModules();
                vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
                try {
                    const store = await import('./store');
                    store.resetForTests();
                    const adapter = new SqliteAdapter(clientFor(db));
                    store.setStorageAdapter({ getData: () => adapter.getData(), saveData: async () => {} });
                    await store.useTaskStore.getState().fetchData({ throwOnError: true });
                    const first = store.useTaskStore.getState();
                    const firstTasks = first._allTasks;
                    await store.useTaskStore.getState().fetchData({ throwOnError: true });
                    const second = store.useTaskStore.getState();
                    return {
                        first: encode({ tasks: first._allTasks, projects: first._allProjects, sections: first._allSections, areas: first._allAreas,
                            people: first._allPeople }),
                        second: encode({ tasks: second._allTasks, projects: second._allProjects, sections: second._allSections, areas: second._allAreas,
                            people: second._allPeople }),
                        reused: second._allTasks.map((task, index) => task === firstTasks[index]),
                    };
                } finally { vi.useRealTimers(); }
            };
            check('store load from SQLite', await load());
        } finally { db.close(); }
    }, 60_000);

    it('checks every field it repairs before handing the task back unchanged', () => {
        const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'task-status.ts'), 'utf8');
        const body = source.slice(source.indexOf('export function normalizeTaskForLoad('));
        const check = body.slice(body.indexOf('const unchanged ='), body.indexOf('if (unchanged) return task;'));
        const copy = body.slice(body.indexOf('if (unchanged) return task;'), body.indexOf('return next;'));
        const checked = new Set([...check.matchAll(/(?:storedAs|hasOwnProperty\.call)\(task, '(\w+)'/g)].map((match) => match[1]));
        const copiedFromTheTaskItself = new Set(['textDirection']);
        const repaired = new Set([...copy.matchAll(/next\.(\w+) =/g)].map((match) => match[1]).filter((field) => !copiedFromTheTaskItself.has(field)));
        expect(repaired.size).toBeGreaterThan(15);
        expect([...checked].sort()).toEqual([...repaired].sort());
    });
});
