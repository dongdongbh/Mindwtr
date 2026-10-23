import { describe, expect, it } from 'vitest';
import { prepareNativeAppleReminderImportItem, validatePreparedNativeAppleReminderImportItem,
    type NativeAppleReminderImportRequest, type NativeAppleReminderImportFactory,
    type NativeAppleReminderImportTarget } from './native-apple-reminders-import-item';
import { classifyAppleReminderForImport } from './apple-reminders-import-model';
import { buildNewTask } from './task-creation';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import type { AppSettings, Area } from './types';
import { TASK_SQLITE_COLUMNS } from './task-sync-schema';

const REQUEST = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-10T00:00:00.000Z';
const SOURCE_UUID = 'AABBCCDD-1234-5678-9ABC-0123456789EF';
const input = (): { request: NativeAppleReminderImportRequest; target: NativeAppleReminderImportTarget;
    factory: NativeAppleReminderImportFactory } => ({ request: { version: 1, requestId: REQUEST, list: { id: 'list:one', sourceId: 'source:🧪' },
    reminder: { id: ' native:not-a-uuid ', title: '  Call Alex tomorrow @home #urgent  ', notes: '  Literal notes  ',
        completed: false, startDate: '2026-10-12', dueDate: '2026-10-15' }, generatedTaskId: TASK },
    target: { id: TASK, row: null }, factory: { preparedAt: AT, deviceIdBefore: 'device',
        deviceIdToInitialize: null, effectiveDefaultAreaId: null } });

describe('native Apple Reminders pure item preparation', () => {
    it('creates one literal Inbox task with a frozen generated UUID and no reminder-date or NLP inference', () => {
        const source = input(); const plan = prepareNativeAppleReminderImportItem(source)!;
        expect(plan.mode).toBe('new'); expect(plan.request).toEqual(source.request);
        expect(plan.target).toEqual({ id: TASK, row: null });
        expect(plan.result).toEqual({ taskId: TASK, importKey: 'native:not-a-uuid', mode: 'new' });
        if (plan.mode !== 'new') throw new Error('fixture');
        expect(plan.task).toMatchObject({ id: TASK, title: 'Call Alex tomorrow @home #urgent', description: 'Literal notes',
            status: 'inbox', taskMode: 'task', tags: [], contexts: [], pushCount: 0, rev: 1, revBy: 'device',
            createdAt: AT, updatedAt: AT, isFocusedToday: false, suppressMindwtrReminders: false });
        for (const name of ['startTime', 'dueDate', 'projectId', 'sectionId', 'areaId', 'deletedAt', 'purgedAt'])
            expect(Object.prototype.hasOwnProperty.call(plan.task, name)).toBe(false);
    });
    it('preserves a live UUID task raw row despite source differences and needs no creation witnesses', () => {
        const source = input(); const id = SOURCE_UUID.toLowerCase();
        const cells: Record<string, string | number | null> = { id, title: 'Existing title', status: 'archived',
            description: 'Existing notes', rev: 10, tags: ' [ ] ', timeSpentMinutes: 42 };
        const target = { id, row: TASK_SQLITE_COLUMNS.map((name) => cells[name] ?? null) };
        const request = { ...source.request, reminder: { ...source.request.reminder, id: ` ${SOURCE_UUID} ` }, generatedTaskId: null };
        const plan = prepareNativeAppleReminderImportItem({ request, target, factory: null })!;
        expect(plan).toEqual({ version: 1, mode: 'existing', request, target,
            result: { taskId: id, importKey: SOURCE_UUID, mode: 'existing' } });
        expect(target.row[TASK_SQLITE_COLUMNS.indexOf('tags')]).toBe(' [ ] ');
        expect(Object.prototype.hasOwnProperty.call(plan, 'task')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(plan, 'factory')).toBe(false);
    });
    it('matches RN normalized-list fallback while retaining exact colon/Unicode provider bytes', () => {
        const source = input(); source.request.list = { id: ' list:one ', sourceId: ' source:e\u0301:é ' };
        source.request.reminder = { id: ' ', title: ' 标题:🧪 ', notes: ' café:e\u0301 ', completed: false,
            creationDate: ' 2026-10-01T01:04:05.006Z ', startDate: ' local:date ', dueDate: '2026-10-03T00:00:00.000Z' };
        const plan = prepareNativeAppleReminderImportItem(source)!;
        expect(plan.result.importKey).toBe('fallback:list:one:标题:🧪:café:e\u0301:2026-10-01T01:04:05.006Z:local:date:2026-10-03T00:00:00.000Z');
        expect(plan.request).toEqual(source.request);
        expect(validatePreparedNativeAppleReminderImportItem({ request: source.request, prepared: JSON.parse(JSON.stringify(plan)) })).toEqual(plan);
    });
    it.each([{ completed: true, title: ' ' }, { completed: true, title: 'Task' }, { completed: false, title: ' ' },
        { completed: false }, { completed: false, title: ' Candidate ' }])('agrees with shared classification %j', (reminder) => {
        const source = input(); source.request.reminder = reminder;
        const classified = classifyAppleReminderForImport(reminder, source.request.list.id.trim(), new Set());
        const plan = prepareNativeAppleReminderImportItem(source);
        if (classified.kind !== 'candidate') expect(plan).toBeNull();
        else expect(plan!.result.importKey).toBe(classified.importKey);
    });
    it.each(['native:opaque:id', '__proto__', 'constructor', 'prototype', '列表:🧪:e\u0301:é', '']) (
        'accepts legitimate provider identifier strings without treating them as property names: %s', (id) => {
            const source = input(); source.request.reminder.id = id;
            const plan = prepareNativeAppleReminderImportItem(source)!;
            expect(plan.result.taskId).toBe(TASK); expect(plan.request.reminder.id).toBe(id);
            expect(plan.result.importKey).toBe(id || 'fallback:list:one:Call Alex tomorrow @home #urgent:Literal notes::2026-10-12:2026-10-15');
        });
    it('keeps source UUID lowercasing separate from raw/import identity and never generates a second UUID', () => {
        const source = input(); source.request.reminder.id = ` ${SOURCE_UUID} `; source.request.generatedTaskId = null;
        source.target.id = SOURCE_UUID.toLowerCase();
        const plan = prepareNativeAppleReminderImportItem(source)!;
        expect(plan.result).toEqual({ taskId: SOURCE_UUID.toLowerCase(), importKey: SOURCE_UUID, mode: 'new' });
        expect(plan.request.reminder.id).toBe(` ${SOURCE_UUID} `);
        expect(validatePreparedNativeAppleReminderImportItem({ request: source.request, prepared: plan })).toEqual(plan);
        expect(() => prepareNativeAppleReminderImportItem({ ...source, request: { ...source.request, generatedTaskId: TASK } })).toThrow();
        expect(() => prepareNativeAppleReminderImportItem({ ...input(), request: { ...input().request, generatedTaskId: null } })).toThrow();
    });
    it.each(['deletedAt', 'purgedAt'] as const)('refuses occupied UUID %s and non-UUID collisions without resurrection', (name) => {
        const source = input(); source.request.reminder.id = SOURCE_UUID; source.request.generatedTaskId = null;
        const id = SOURCE_UUID.toLowerCase();
        source.target = { id, row: TASK_SQLITE_COLUMNS.map((column) => column === 'id' ? id : column === name ? AT : null) };
        expect(() => prepareNativeAppleReminderImportItem({ ...source, factory: null })).toThrow();
        const collision = input(); collision.target.row = TASK_SQLITE_COLUMNS.map((column) => column === 'id' ? TASK : null);
        expect(() => prepareNativeAppleReminderImportItem(collision)).toThrow();
    });
    it.each([null, 'area:🧪'] as const)('reconstructs the ordinary Inbox factory with effective default Area %s', (areaId) => {
        const source = input(); source.factory.effectiveDefaultAreaId = areaId;
        const plan = prepareNativeAppleReminderImportItem(source)!;
        if (plan.mode !== 'new') throw new Error('fixture');
        const settings: AppSettings = { gtd: areaId ? { defaultAreaMode: 'fixed', defaultAreaId: areaId } : { defaultAreaMode: 'none' } };
        const areas = areaId ? [{ id: areaId, name: 'Ordinary default', color: '#fff' }] as Area[] : [];
        const built = buildNewTask({ title: source.request.reminder.title!.trim(), initialTaskProps: {
            status: 'inbox', description: source.request.reminder.notes!.trim() }, id: TASK, now: AT, deviceId: 'device',
            state: { settings, _allAreas: areas, _allProjects: [], _allSections: [] }, tasks: [], focusedCount: 0,
            focusTaskLimit: 1, projectOrderReserver: () => { throw new Error('No project order dependency'); } });
        expect(built.ok).toBe(true); if (!built.ok) throw new Error('fixture');
        expect(plan.task).toEqual(JSON.parse(JSON.stringify(built.task)));
        expect(plan.task.areaId).toBe(areaId ?? undefined); expect(plan.task.projectId).toBeUndefined();
    });
    it('omits empty notes and stamps one frozen generated device only when its before witness is absent', () => {
        const source = input(); source.request.reminder.notes = ' \t '; source.factory.deviceIdBefore = null;
        source.factory.deviceIdToInitialize = '33333333-3333-4333-8333-333333333333';
        const plan = prepareNativeAppleReminderImportItem(source)!;
        if (plan.mode !== 'new') throw new Error('fixture');
        expect(plan.task.revBy).toBe(source.factory.deviceIdToInitialize); expect(plan.task.description).toBeUndefined();
        for (const factory of [{ ...source.factory, deviceIdToInitialize: null },
            { ...source.factory, deviceIdToInitialize: 'not-a-uuid' }, { ...source.factory, deviceIdBefore: 'device' }])
            expect(() => prepareNativeAppleReminderImportItem({ ...source, factory })).toThrow();
    });
    it('detaches provider/source and factory data and validates the same captured UUID after serialization', () => {
        const source = input(); const request = structuredClone(source.request); const plan = prepareNativeAppleReminderImportItem(source)!;
        source.request.reminder.title = 'Later source edit'; source.request.list.sourceId = 'replacement';
        source.request.generatedTaskId = '44444444-4444-4444-8444-444444444444'; source.factory.preparedAt = '2026-10-11T00:00:00.000Z';
        const cold = JSON.parse(JSON.stringify(plan));
        expect(cold.request).toEqual(request); expect(cold.result.taskId).toBe(TASK);
        expect(validatePreparedNativeAppleReminderImportItem({ request, prepared: cold })).toEqual(plan);
        expect(() => validatePreparedNativeAppleReminderImportItem({ request: source.request, prepared: cold })).toThrow();
    });
    it('refuses same UUID with changed raw request even when trimmed classification/factory output would match', () => {
        const source = input(); const plan = prepareNativeAppleReminderImportItem(source)!;
        for (const request of [{ ...source.request, reminder: { ...source.request.reminder, title: source.request.reminder.title!.trim() } },
            { ...source.request, list: { ...source.request.list, sourceId: 'other' } },
            { ...source.request, generatedTaskId: '44444444-4444-4444-8444-444444444444' }])
            expect(() => validatePreparedNativeAppleReminderImportItem({ request, prepared: plan })).toThrow();
        const classification = classifyAppleReminderForImport(source.request.reminder, source.request.list.id, new Set(['native:not-a-uuid']));
        expect(classification.kind).toBe('duplicate');
        // A later registry state does not change an already accepted plan's pure validation.
        expect(validatePreparedNativeAppleReminderImportItem({ request: source.request, prepared: plan })).toEqual(plan);
    });
    it('rejects every factory/task/result witness alteration and existing-mode creation authority', () => {
        const source = input(); const plan = prepareNativeAppleReminderImportItem(source)!;
        if (plan.mode !== 'new') throw new Error('fixture');
        const forged = [ { ...plan, factory: { ...plan.factory, preparedAt: '2026-10-11T00:00:00.000Z' } },
            { ...plan, factory: { ...plan.factory, deviceIdBefore: 'other' } },
            { ...plan, factory: { ...plan.factory, effectiveDefaultAreaId: 'other' } },
            { ...plan, task: { ...plan.task, rev: 2 } }, { ...plan, task: { ...plan.task, dueDate: '2026-10-12' } },
            { ...plan, task: { ...plan.task, isFocusedToday: true } }, { ...plan, task: { ...plan.task, unknown: 'injected' } },
            { ...plan, result: { ...plan.result, importKey: 'other' } }, { ...plan, result: { ...plan.result, extra: 1 } },
            { ...plan, target: { id: TASK, row: [] } }, { ...plan, mode: 'existing' }, { ...plan, version: 2 }, { ...plan, extra: true } ];
        for (const prepared of forged) expect(() => validatePreparedNativeAppleReminderImportItem({ request: source.request, prepared })).toThrow();
        const id = SOURCE_UUID.toLowerCase(); const request = { ...source.request,
            reminder: { ...source.request.reminder, id: SOURCE_UUID }, generatedTaskId: null };
        const target = { id, row: TASK_SQLITE_COLUMNS.map((name) => name === 'id' ? id : null) };
        const existing = prepareNativeAppleReminderImportItem({ request, target, factory: null })!;
        expect(() => prepareNativeAppleReminderImportItem({ request, target, factory: source.factory })).toThrow();
        expect(() => validatePreparedNativeAppleReminderImportItem({ request, prepared: { ...existing, factory: source.factory } })).toThrow();
    });
    it('rejects malformed/extra/prototype/deep/non-JSON primitive and raw baseline forms', () => {
        const source = input();
        const bad = [ { ...source, extra: true }, { ...source, request: { ...source.request, extra: 1 } },
            { ...source, request: { ...source.request, version: 2 } }, { ...source, request: { ...source.request, requestId: 'UPPERCASE' } },
            { ...source, request: { ...source.request, list: { ...source.request.list, extra: true } } },
            { ...source, request: { ...source.request, reminder: { completed: 'true', title: 'Task' } } },
            { ...source, request: { ...source.request, reminder: { completed: false, title: null } } },
            { ...source, request: { ...source.request, reminder: { completed: false, title: 'Task', creationDate: new Date() } } },
            { ...source, request: { ...source.request, reminder: { ...source.request.reminder, areaId: 'list' } } },
            { ...source, request: { ...source.request, reminder: Object.assign(Object.create({ inherited: true }), source.request.reminder) } },
            { ...source, request: { ...source.request, reminder: JSON.parse('{"completed":false,"title":"Task","__proto__":{}}') } },
            { ...source, factory: { ...source.factory, preparedAt: '2026-02-30T00:00:00.000Z' } },
            { ...source, factory: { ...source.factory, effectiveDefaultAreaId: 42 } },
            { ...source, target: { id: 'other', row: null } }, { ...source, target: { id: TASK, row: [TASK] } },
            { ...source, target: { id: TASK, row: TASK_SQLITE_COLUMNS.map((name) => name === 'id' ? TASK : Infinity) } },
            { ...source, target: { id: TASK, row: TASK_SQLITE_COLUMNS.map((name) => name === 'id' ? TASK : {}) } } ];
        let deep: unknown = 'value'; for (let i = 0; i < 26; i++) deep = { nested: deep };
        bad.push({ ...source, request: { ...source.request, reminder: deep } } as typeof source);
        for (const value of bad) expect(() => prepareNativeAppleReminderImportItem(value)).toThrow(/Invalid native Apple Reminders/);
        const cycle: Record<string, unknown> = { ...source }; cycle.cycle = cycle;
        expect(() => prepareNativeAppleReminderImportItem(cycle)).toThrow();
        expect(() => validatePreparedNativeAppleReminderImportItem({ request: source.request,
            prepared: prepareNativeAppleReminderImportItem(source), extra: true })).toThrow();
    });
    it('refuses sparse raw rows and enumerable array properties rather than changing the captured baseline', () => {
        const source = input(); const id = SOURCE_UUID.toLowerCase();
        const request = { ...source.request, reminder: { completed: false, id: SOURCE_UUID, title: 'Task' }, generatedTaskId: null };
        const sparse = TASK_SQLITE_COLUMNS.map((name) => name === 'id' ? id : null);
        delete sparse[TASK_SQLITE_COLUMNS.indexOf('status')];
        const extra = TASK_SQLITE_COLUMNS.map((name) => name === 'id' ? id : null);
        Object.defineProperty(extra, 'changed', { enumerable: true, value: 'discarded by JSON.stringify' });
        for (const row of [sparse, extra])
            expect(() => prepareNativeAppleReminderImportItem({ request, target: { id, row }, factory: null })).toThrow();
    });
    it('checks provider UTF8 bounds and complete escaped plan size without truncating identities or literal text', () => {
        const source = input(); source.request.reminder.id = '🧪'.repeat(256);
        source.request.reminder.title = 'é'.repeat(524_288);
        const plan = prepareNativeAppleReminderImportItem(source)!;
        expect(plan.request.reminder.title).toBe(source.request.reminder.title);
        expect(plan.result.importKey).toBe(source.request.reminder.id);
        for (const request of [{ ...source.request, reminder: { ...source.request.reminder, id: '🧪'.repeat(257) } },
            { ...source.request, reminder: { ...source.request.reminder, title: source.request.reminder.title + 'é' } },
            { ...source.request, list: { ...source.request.list, sourceId: 'é'.repeat(513) } }])
            expect(() => prepareNativeAppleReminderImportItem({ ...source, request })).toThrow();
        const escaped = input(); escaped.request.reminder = { completed: false, title: '"'.repeat(1_048_576),
            notes: '\\'.repeat(1_048_576), creationDate: 'x'.repeat(1_048_576), startDate: 'x'.repeat(1_048_576), dueDate: 'x'.repeat(1_048_576) };
        expect(isNativeJsonWithinBytes(escaped.request, 8 * 1024 * 1024)).toBe(true);
        expect(() => prepareNativeAppleReminderImportItem(escaped)).toThrow();
    });
    it('admits exactly 8MiB complete existing plans and refuses the next UTF8 byte', () => {
        const source = input(); const id = SOURCE_UUID.toLowerCase();
        const request = { ...source.request, reminder: { completed: false, id: SOURCE_UUID, title: 'Task' }, generatedTaskId: null };
        const cells = TASK_SQLITE_COLUMNS.map((name) => name === 'id' ? id : name === 'description' ? '' : null);
        const target = { id, row: cells }; const base = prepareNativeAppleReminderImportItem({ request, target, factory: null })!;
        const padding = 8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(base), 'utf8');
        cells[TASK_SQLITE_COLUMNS.indexOf('description')] = 'x'.repeat(padding);
        const exact = prepareNativeAppleReminderImportItem({ request, target, factory: null })!;
        expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(8 * 1024 * 1024);
        expect(validatePreparedNativeAppleReminderImportItem({ request, prepared: exact })).toEqual(exact);
        cells[TASK_SQLITE_COLUMNS.indexOf('description')] += 'x';
        expect(() => prepareNativeAppleReminderImportItem({ request, target, factory: null })).toThrow();
    });
    it('creates the row under Skip as RN addTask does, in an unchanged version-1 plan', () => {
        const plan = prepareNativeAppleReminderImportItem(input(), 'skip')!;
        if (plan.mode !== 'new') throw new Error('fixture');
        expect(plan.version).toBe(1); expect(plan.task.suppressMindwtrReminders).toBe(true);
        expect(Object.keys(plan.factory).sort()).toEqual(['deviceIdBefore', 'deviceIdToInitialize', 'effectiveDefaultAreaId', 'preparedAt']);
        expect(validatePreparedNativeAppleReminderImportItem({ request: plan.request, prepared: plan })).toEqual(plan);
        const sent = prepareNativeAppleReminderImportItem(input())!;
        if (sent.mode !== 'new') throw new Error('fixture');
        expect(sent.task.suppressMindwtrReminders).toBe(false);
        expect(validatePreparedNativeAppleReminderImportItem({ request: sent.request, prepared: sent })).toEqual(sent);
        const forged = JSON.parse(JSON.stringify(plan)); forged.task.title = 'Different';
        expect(() => validatePreparedNativeAppleReminderImportItem({ request: plan.request, prepared: forged })).toThrow();
    });
});
