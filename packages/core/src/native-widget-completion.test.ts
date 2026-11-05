import { createNativeWidgetCompletionMethods } from './native-host-contract-task-checklist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { openSqliteHost } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { createNativeRequestReceipts, resetNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { buildWidgetCompletionToken } from './widget-completion-token';
import { createNextRecurringTask } from './recurrence';
import { NATIVE_WIDGET_NAMESPACE, PRODUCTION_WIDGET_NAMESPACE, nativeWidgetIdentifier, readNativeWidgetCompletionSource,
    nativeWidgetCompletionPayload, type NativeWidgetCompletionEnvelope, type NativeWidgetCompletionSource } from './native-widget-completion';
import type { AppData, Task } from './types';

const NOW = '2026-10-30T12:00:00.000Z', TAP = '2026-10-27T10:00:00.000Z';
const UUID = '00000000-0000-4000-8000-000000000901';
const value = <T,>(reply: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`); return reply.value;
};
const task = (patch: Partial<Task> = {}): Task => ({ id: 'widget-task', title: 'Synthetic widget title', status: 'next',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z', rev: 3, revBy: 'device-a',
    contexts: ['@home'], tags: ['#keep'], checklist: [{ id: 'one', title: 'Synthetic step', isCompleted: false }], ...patch });
const seed = (source = task(), extra: Partial<AppData> = {}): Partial<AppData> => ({ tasks: [source], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'device-a', analyticsProfileId: UUID, gtd: { focusTaskLimit: 3, autoArchiveDays: 0 } }, ...extra });
const source = (original = task(), createdAt = Date.parse(TAP)): NativeWidgetCompletionSource => ({ namespace: NATIVE_WIDGET_NAMESPACE,
    actionId: UUID, identifier: nativeWidgetIdentifier(original.id), token: buildWidgetCompletionToken(original), createdAt });
const productionSource = (original = task(), createdAt = Date.parse(TAP)): NativeWidgetCompletionSource => ({
    ...source(original, createdAt), namespace: PRODUCTION_WIDGET_NAMESPACE, identifier: original.id,
});
type Host = Awaited<ReturnType<typeof openSqliteHost>>;
const prepare = (sqlite: Host, input: NativeWidgetCompletionSource): NativeWidgetCompletionEnvelope => {
    const answer = value(sqlite.host.prepareWidgetCompletion(input));
    if (answer.kind !== 'prepared') throw new Error('Expected new preparation'); return answer.prepared;
};
const rows = async (sqlite: Host) => Object.fromEntries(await Promise.all(['tasks', 'projects', 'sections', 'settings', 'native_request_receipts']
    .map(async table => [table, await sqlite.sql(`SELECT * FROM ${table} ORDER BY rowid`)])));
const savedTask = () => useTaskStore.getState()._tasksById.get('widget-task')!;
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });
const clock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); };

describe('private source-receipted native widget completion', () => {
    it('validates exact source fields and canonical scoped UTF8 IDs without normalization', () => {
        for (const id of ['é', 'é', '﻿first', 'Task', 'task', 'legacy/ID ?#😀']) {
            const input = source(task({ id }));
            const scope = createHash('sha256').update(NATIVE_WIDGET_NAMESPACE).digest('hex');
            expect(input.identifier).toBe(scope + '.' + Buffer.from(id).toString('base64url'));
            expect(readNativeWidgetCompletionSource(input)).toEqual(input);
        }
        const valid = source();
        for (const edit of [{ extra: true }, { namespace: 'tech.dongdongbh.mindwtr' }, { actionId: UUID.toUpperCase() + 'x' },
            { createdAt: -1 }, { createdAt: NaN }, { identifier: valid.identifier + '=' }, { identifier: 'widget-task' },
            { token: JSON.stringify(['other', 3, TAP, 'next']) }, { token: JSON.stringify(['widget-task', true, TAP, 'next']) },
            { token: JSON.stringify(['widget-task', 3, TAP, 'unknown']) }, { token: valid.token + ' '.repeat(8192) }]) {
            expect(readNativeWidgetCompletionSource({ ...valid, ...edit })).toBeNull();
        }
    });

    it('uses tap time for completion, drain time for revisions, and preserves old completion contracts', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const input = source(), envelope = prepare(sqlite, input), checklist = envelope.checklist!;
            expect(checklist.request).toEqual({ id: 'widget-task', requestId: UUID, taskRevision: taskRevisionOf(savedTask()) });
            expect(checklist.prepared.witness.preparedAt).toBe(NOW);
            expect(checklist.prepared.witness.direct).toEqual({ status: 'done', completedAt: TAP });
            expect(value(sqlite.host.validatePreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'completed' });
            expect(sqlite.host.validatePreparedTaskChecklistWrite({ request: checklist.prepared.request, prepared: checklist.prepared }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const ordinary = value(await sqlite.host.prepareTaskCompletion(checklist.request));
            expect(Object.keys(ordinary.prepared).sort()).toEqual(['checklist', 'kind', 'notice', 'request', 'result', 'version']);
            expect(ordinary.prepared.result.completion.completedAt).toBe(NOW);
            expect(sqlite.host.validatePreparedTaskCompletion({ request: checklist.request, prepared: {
                ...ordinary.prepared, checklist: checklist.prepared,
                result: { ...ordinary.prepared.result, completion: { ...ordinary.prepared.result.completion, completedAt: TAP } },
            } })).toMatchObject({ ok: false });
            expect(value(await sqlite.host.commitPreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'completed' });
            expect(savedTask()).toMatchObject({ status: 'done', completedAt: TAP, updatedAt: NOW, rev: 4,
                contexts: ['@home'], tags: ['#keep'], checklist: task().checklist });
            const receipt = await sqlite.sql<{ method: string; reply: string }>('SELECT method,reply FROM native_request_receipts WHERE request_id=?', [UUID]);
            expect(receipt).toEqual([{ method: nativeWidgetCompletionPayload(input), reply: JSON.stringify({ actionId: UUID, outcome: 'completed' }) }]);
        } finally { await sqlite.close(); }
    });

    it.each(['strict', 'after-completion'] as const)('reuses canonical %s recurrence with the tap instant and one frozen child', async strategy => {
        clock(); const original = task({ dueDate: '2026-10-26', recurrence: { rule: 'daily', strategy, seriesId: 'widget-task' } });
        const sqlite = await openSqliteHost(seed(original));
        try {
            const input = source(original), envelope = prepare(sqlite, input);
            const expected = createNextRecurringTask(original, TAP)!;
            const child = envelope.checklist!.prepared.effect.tasks.find(row => row.before === null)!.after;
            expect(child.dueDate).toBe(expected.dueDate);
            expect(value(await sqlite.host.commitPreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'completed' });
            expect(savedTask().completedAt).toBe(TAP); expect(useTaskStore.getState()._allTasks).toHaveLength(2);
            const before = await rows(sqlite); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await sqlite.host.commitPreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'completed' });
            expect(await rows(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it.each([0, Date.parse('2099-01-01T00:00:00.000Z')])('keeps RN fallback to drain time for tap=%s', async tapped => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const envelope = prepare(sqlite, source(task(), tapped));
            expect(envelope.checklist!.prepared.witness.direct).toEqual({ status: 'done' });
            value(await sqlite.host.commitPreparedWidgetCompletion(envelope)); expect(savedTask().completedAt).toBe(NOW);
        } finally { await sqlite.close(); }
    });

    it.each(['missing', 'deleted', 'purged', 'done', 'archived', 'reference', 'stale', 'read-only'])('durably discards %s without task mutation', async disposition => {
        clock(); const original = task(); let stored: Task = original;
        if (disposition === 'deleted') stored = task({ deletedAt: TAP });
        if (disposition === 'purged') stored = task({ purgedAt: TAP });
        if (disposition === 'done' || disposition === 'archived' || disposition === 'reference') stored = task({ status: disposition });
        if (disposition === 'stale') stored = task({ title: 'Later', rev: 4, updatedAt: NOW });
        if (disposition === 'read-only') stored = task({ projectId: 'readonly' });
        const sqlite = await openSqliteHost(seed(stored, { ...(disposition === 'missing' ? { tasks: [] } : {}),
            ...(disposition === 'read-only' ? { projects: [{ id: 'readonly', title: 'Synthetic', status: 'archived', color: '#123456',
                order: 0, tagIds: [], createdAt: TAP, updatedAt: TAP }] } : {}) }));
        try {
            const input = source(disposition === 'stale' || disposition === 'missing' ? original : stored), before = await rows(sqlite);
            const envelope = prepare(sqlite, input); expect(envelope.checklist).toBeNull();
            expect(value(await sqlite.host.commitPreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'discarded' });
            const after = await rows(sqlite);
            for (const table of ['tasks', 'projects', 'sections', 'settings']) expect(after[table]).toEqual(before[table]);
            expect(await sqlite.receiptIds()).toEqual([UUID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(sqlite.host.widgetCompletionOutcome(input))).toEqual({ actionId: UUID, outcome: 'discarded' });
        } finally { await sqlite.close(); }
    });

    it('answers a cold landed source before later mutable edits and refuses same UUID with another source', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const input = source(), envelope = prepare(sqlite, input);
            value(await sqlite.host.commitPreparedWidgetCompletion(envelope));
            expect(await useTaskStore.getState().updateTask('widget-task', { status: 'next', title: 'Later legitimate edit' })).toEqual({ success: true });
            await flushPendingSave(); const before = await rows(sqlite); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(sqlite.host.widgetCompletionOutcome(input))).toEqual({ actionId: UUID, outcome: 'completed' });
            expect(value(sqlite.host.prepareWidgetCompletion(input))).toEqual({ kind: 'settled', result: { actionId: UUID, outcome: 'completed' } });
            expect(value(await sqlite.host.commitPreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'completed' });
            for (const changed of [{ ...input, createdAt: input.createdAt + 1 }, source(savedTask())]) {
                expect(sqlite.host.widgetCompletionOutcome(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(sqlite.host.prepareWidgetCompletion(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await rows(sqlite)).toEqual(before); expect(savedTask().title).toBe('Later legitimate edit');
        } finally { await sqlite.close(); }
    });

    it('rejects forged source, timestamp, revision and effects without allowing the ordinary reader to opt in', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const envelope = prepare(sqlite, source()), before = await rows(sqlite);
            for (const field of ['source', 'timestamp', 'revision', 'effect']) {
                const forged = structuredClone(envelope), plan = forged.checklist!.prepared;
                if (field === 'source') forged.source.createdAt++;
                if (field === 'timestamp') plan.witness.direct.completedAt = NOW;
                if (field === 'revision') forged.checklist!.request.taskRevision = 'forged';
                if (field === 'effect') plan.effect.tasks[0].after.title = 'Injected';
                expect(sqlite.host.validatePreparedWidgetCompletion(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(await sqlite.host.commitPreparedWidgetCompletion(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await rows(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('retains the exact effect through COMMIT failure and does not generate a second recurring child', async () => {
        clock(); const fault = { commits: 0 }, original = task({ dueDate: '2026-10-26', recurrence: { rule: 'daily', strategy: 'after-completion' } });
        const sqlite = await openSqliteHost(seed(original), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected widget COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            const input = source(original), envelope = prepare(sqlite, input), before = await rows(sqlite);
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedWidgetCompletion(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await rows(sqlite)).toEqual(before); expect(value(sqlite.host.widgetCompletionOutcome(input))).toBeNull();
            fault.commits = 0; value(await sqlite.host.commitPreparedWidgetCompletion(envelope));
            expect(useTaskStore.getState()._allTasks).toHaveLength(2); const saved = await rows(sqlite);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(sqlite.host.widgetCompletionOutcome(input))).toEqual({ actionId: UUID, outcome: 'completed' });
            expect(await rows(sqlite)).toEqual(saved);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);

    it('rechecks a receipt-only discarded decision and refuses a newly eligible unchanged task', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            let readOnly = true;
            const save = vi.fn(async () => ({ ok: true as const, value: null }));
            // Exercise the real factory's current read-only policy seam without a Project lifecycle write changing the child.
            const methods = createNativeWidgetCompletionMethods({ readiness: () => ({ ok: true, value: null }), save,
                receipts: createNativeRequestReceipts({ save }), validateField: () => true, language: () => 'en', isReadOnly: () => readOnly });
            const input = source(savedTask()), response = value(methods.prepareWidgetCompletion(input));
            if (response.kind !== 'prepared') throw new Error('Expected discarded preparation');
            expect(response.prepared.checklist).toBeNull(); readOnly = false;
            expect(buildWidgetCompletionToken(savedTask())).toBe(input.token);
            const before = await rows(sqlite);
            expect(await methods.commitPreparedWidgetCompletion(response.prepared)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await rows(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]); expect(save).not.toHaveBeenCalled();
        } finally { await sqlite.close(); }
    });

    it('refuses another task edit after preparation with no partial effect or receipt', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            const envelope = prepare(sqlite, source());
            expect(await useTaskStore.getState().updateTask('widget-task', { title: 'Newer Task edit' })).toEqual({ success: true });
            await flushPendingSave(); const before = await rows(sqlite);
            expect(await sqlite.host.commitPreparedWidgetCompletion(envelope)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await rows(sqlite)).toEqual(before); expect(await sqlite.receiptIds()).toEqual([]);
        } finally { await sqlite.close(); }
    });

    it('keeps an already discarded source terminal after cold restart and later Task changes', async () => {
        clock(); const original = task({ status: 'done', completedAt: TAP }), sqlite = await openSqliteHost(seed(original));
        try {
            const input = source(original), envelope = prepare(sqlite, input); expect(envelope.checklist).toBeNull();
            value(await sqlite.host.commitPreparedWidgetCompletion(envelope));
            expect(await useTaskStore.getState().updateTask('widget-task', { status: 'next', title: 'Legitimately reopened' })).toEqual({ success: true });
            await flushPendingSave(); const before = await rows(sqlite); await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(sqlite.host.widgetCompletionOutcome(input))).toEqual({ actionId: UUID, outcome: 'discarded' });
            expect(value(await sqlite.host.commitPreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'discarded' });
            expect(await rows(sqlite)).toEqual(before); expect(savedTask().status).toBe('next');
        } finally { await sqlite.close(); }
    });

    it('refuses before durable receipt ownership is loaded', async () => {
        clock(); const sqlite = await openSqliteHost(seed());
        try {
            resetNativeRequestReceipts(); const before = await rows(sqlite);
            expect(sqlite.host.prepareWidgetCompletion(source())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(sqlite.host.widgetCompletionOutcome(source())).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await rows(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });
});


describe('production raw widget completion sources', () => {
    it('preserves raw Unicode IDs and token bytes under the exact five-field production contract', () => {
        for (const id of ['é', 'é', '﻿first', 'Task', 'task', 'legacy/ID ?#😀']) {
            const input = productionSource(task({ id }));
            input.token = ' ' + input.token + ' ';
            expect(readNativeWidgetCompletionSource(input)).toEqual(input);
            const tuple = JSON.parse(nativeWidgetCompletionPayload(input));
            expect(tuple[0]).toBe('iosWidgetCompletion');
            expect(Object.keys(tuple[1]).sort()).toEqual(['actionId', 'createdAt', 'identifier', 'namespace', 'token']);
            expect(tuple[1]).toEqual(input);
            expect(readNativeWidgetCompletionSource({ ...input, namespace: NATIVE_WIDGET_NAMESPACE })).toBeNull();
            expect(readNativeWidgetCompletionSource({ ...input, identifier: nativeWidgetIdentifier(id) })).toBeNull();
        }
        const input = productionSource(task({ id: 'é' }));
        for (const patch of [{ extra: true }, { namespace: 'foreign.app' }, { identifier: 'é' },
            { actionId: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF' }, { createdAt: true }, { createdAt: -1 },
            { createdAt: Infinity }, { createdAt: 8_640_000_000_000_001 },
            { token: JSON.stringify(['é', true, TAP, 'next']) }, { token: JSON.stringify(['é', 3, TAP, 'unknown']) },
            { token: input.token + ' '.repeat(8192) }, { token: JSON.stringify(['\ud800', 3, TAP, 'next']) },
            { identifier: 'x'.repeat(501), token: JSON.stringify(['x'.repeat(501), 3, TAP, 'next']) }]) {
            expect(readNativeWidgetCompletionSource({ ...input, ...patch })).toBeNull();
        }
        expect(readNativeWidgetCompletionSource(source())).toEqual(source());
    });

    it('retries a failed production save once and cold-decodes the exact receipt before later task edits', async () => {
        clock(); const fault = { commits: 0 }, original = task({ dueDate: '2026-10-26', recurrence: { rule: 'daily', strategy: 'after-completion' } });
        const sqlite = await openSqliteHost(seed(original), client => ({ ...client, run: async (sql, params) => {
            if (sql === 'COMMIT' && fault.commits > 0) { fault.commits--; throw new Error('Injected production widget COMMIT failure'); }
            return client.run(sql, params);
        } }));
        try {
            const input = productionSource(original), envelope = prepare(sqlite, input), before = await rows(sqlite);
            fault.commits = 10;
            expect(await sqlite.host.commitPreparedWidgetCompletion(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await rows(sqlite)).toEqual(before);
            expect(value(sqlite.host.widgetCompletionOutcome(input))).toBeNull();
            fault.commits = 0;
            expect(value(await sqlite.host.commitPreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'completed' });
            expect(savedTask().completedAt).toBe(TAP);
            expect(useTaskStore.getState()._allTasks).toHaveLength(2);
            expect(await sqlite.receiptIds()).toEqual([UUID]);
            expect(await sqlite.sql('SELECT method FROM native_request_receipts WHERE request_id=?', [UUID]))
                .toEqual([{ method: nativeWidgetCompletionPayload(input) }]);
            expect(await useTaskStore.getState().updateTask('widget-task', { status: 'next', title: 'Later legitimate production edit' })).toEqual({ success: true });
            await flushPendingSave(); const saved = await rows(sqlite);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(sqlite.host.prepareWidgetCompletion(input))).toEqual({ kind: 'settled', result: { actionId: UUID, outcome: 'completed' } });
            expect(value(sqlite.host.widgetCompletionOutcome(input))).toEqual({ actionId: UUID, outcome: 'completed' });
            expect(value(await sqlite.host.commitPreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'completed' });
            for (const changed of [{ ...input, createdAt: input.createdAt + 1 }, source(original)]) {
                expect(sqlite.host.prepareWidgetCompletion(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                expect(sqlite.host.widgetCompletionOutcome(changed)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(await rows(sqlite)).toEqual(saved);
            expect(savedTask().status).toBe('next');
            expect(useTaskStore.getState()._allTasks).toHaveLength(2);
        } finally { fault.commits = 0; await sqlite.close(); }
    }, 30_000);

    it('cold-decodes a production changed-token discard without modifying the later task', async () => {
        clock(); const original = task(), stored = task({ rev: 4, updatedAt: NOW, title: 'Later source' });
        const sqlite = await openSqliteHost(seed(stored));
        try {
            const input = productionSource(original), before = await rows(sqlite), envelope = prepare(sqlite, input);
            expect(envelope.checklist).toBeNull();
            expect(value(await sqlite.host.commitPreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'discarded' });
            const committed = await rows(sqlite);
            for (const table of ['tasks', 'projects', 'sections', 'settings']) expect(committed[table]).toEqual(before[table]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(sqlite.host.widgetCompletionOutcome(input))).toEqual({ actionId: UUID, outcome: 'discarded' });
            expect(value(sqlite.host.prepareWidgetCompletion(input))).toEqual({ kind: 'settled', result: { actionId: UUID, outcome: 'discarded' } });
            expect(value(await sqlite.host.commitPreparedWidgetCompletion(envelope))).toEqual({ actionId: UUID, outcome: 'discarded' });
            expect(await rows(sqlite)).toEqual(committed);
        } finally { await sqlite.close(); }
    });
});
