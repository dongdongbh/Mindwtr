import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteHost } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { generateUUID } from './uuid';
import { canonicalInboxJSON, nativeInboxUndoOffer,
    readNativePreparedInboxUndo, type NativeInboxDecisionEnvelope, type NativeInboxUndoEnvelope } from './native-host-contract-process-inbox-undo';
import type { AppData, Task } from './types';
import { buildProcessInboxUndoRestoreUpdates } from './process-inbox-model';
import { SqliteAdapter } from './sqlite-adapter';
import { readNativePreparedInboxWrite } from './native-host-contract-process-inbox';
import * as logger from './logger';

const NOW = '2026-10-20T12:00:00.000Z';
const BEFORE = '2026-10-18T12:00:00.000Z';
const ID = 'process-original';
const value = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const task = (patch: Partial<Task> = {}): Task => ({ id: ID, title: 'A original task', description: 'Original note',
    status: 'inbox', contexts: ['@home'], tags: ['#keep'], priority: 'high', energyLevel: 'low', timeEstimate: '30min',
    createdAt: BEFORE, updatedAt: BEFORE, rev: 3, revBy: 'device-a',
    attachments: [{ id: 'retained-link', kind: 'link', title: 'Link', uri: 'https://example.test', createdAt: BEFORE }], ...patch });
const seed = (source = task(), extra: Task[] = []): Partial<AppData> => ({ tasks: [source, ...extra], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'device-a', analyticsProfileId: '00000000-0000-4000-8000-000000000744',
        gtd: { autoArchiveDays: 0, focusTaskLimit: 3 } } });
type Sqlite = Awaited<ReturnType<typeof openSqliteHost>>;
const snapshot = async (sqlite: Sqlite) => Object.fromEntries(await Promise.all(
    ['tasks', 'projects', 'sections', 'areas', 'people', 'settings', 'native_request_receipts'].map(async (table) =>
        [table, await sqlite.sql(`SELECT rowid AS evidence_rowid, * FROM ${table} ORDER BY rowid`)])));
type Decision = 'next' | 'waiting' | 'someday' | 'reference' | 'done' | 'trash' | 'later' | 'incubate';
const prepareDecision = (sqlite: Sqlite, kind: Decision = 'next'): NativeInboxDecisionEnvelope => {
    let view = value(sqlite.host.startInboxProcessing({ mode: 'quick' })).view!;
    const edit = (field: string, text: string) => {
        view = value(sqlite.host.getInboxProcessingStep({ sessionId: view.sessionId, taskId: view.taskId, step: view.step,
            edit: { type: 'set', field, value: text } }));
    };
    edit('title', 'Edited decision title'); edit('description', 'Edited decision note');
    const choose = (choice: string) => {
        const request = { sessionId: view.sessionId, taskId: view.taskId, step: view.step, decision: { choice }, requestId: generateUUID() };
        const answer = value(sqlite.host.inboxCommitPrepare(request));
        if (answer.kind === 'flow') { view = answer.result.view!; return null; }
        return { request, prepared: answer.prepared };
    };
    if (['reference', 'done', 'trash'].includes(kind)) return choose(kind)!;
    expect(choose(kind === 'waiting' ? 'delegate' : kind)).toBeNull();
    if (kind === 'waiting') edit('delegateWho', 'Team');
    if (kind === 'later' || kind === 'incubate') {
        view = value(sqlite.host.getInboxProcessingStep({ sessionId: view.sessionId, taskId: view.taskId, step: view.step,
            edit: { type: 'setDate', field: kind === 'later' ? 'startTime' : 'reviewAt', value: '2031-03-14' } }));
    }
    return choose('fileIt')!;
};
const prepareUndo = (sqlite: Sqlite, decision: NativeInboxDecisionEnvelope): NativeInboxUndoEnvelope => {
    const request = { requestId: generateUUID(), decisionRequestId: decision.request.requestId, taskId: decision.request.taskId };
    return { request, prepared: value(sqlite.host.inboxUndoPrepare({ request, decision })).prepared };
};
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); });
afterEach(async () => { await flushPendingSave(); resetForTests(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Process Inbox public Undo', () => {
    it.each(['next', 'waiting', 'someday', 'reference', 'done', 'trash', 'later', 'incubate'] as const)(
        'restores the original task through the real %s decision, with exact receipts and unchanged unrelated rows', async (kind) => {
            const sentinel = task({ id: 'sentinel', title: 'Z sentinel', status: 'next' });
            const sqlite = await openSqliteHost(seed(task(), [sentinel]));
            try {
                const original = JSON.parse(JSON.stringify(useTaskStore.getState()._tasksById.get(ID)!)) as Task;
                const decision = prepareDecision(sqlite, kind);
                const originalRows = await sqlite.sql('SELECT * FROM tasks WHERE id=?', [sentinel.id]);
                value(await sqlite.host.inboxPreparedCommit(decision));
                const afterDecision = value(sqlite.host.inboxAfterCommit({ sessionId: decision.request.sessionId, requestId: decision.request.requestId }));
                const offer = nativeInboxUndoOffer(decision.prepared)!;
                expect(afterDecision.toast).toMatchObject({ undoLabel: 'Undo', undo: offer });
                const undo = prepareUndo(sqlite, decision);
                expect(value(sqlite.host.inboxUndoValidate(undo))).toEqual(offer);
                expect(value(await sqlite.host.inboxUndoCommit(undo))).toEqual(offer);
                const restored = useTaskStore.getState()._tasksById.get(ID)!;
                const restoredFields = buildProcessInboxUndoRestoreUpdates(restored);
                const originalFields = buildProcessInboxUndoRestoreUpdates(original);
                expect({ ...restoredFields, dueReminderLeadMinutes: restoredFields.dueReminderLeadMinutes || undefined })
                    .toEqual({ ...originalFields, dueReminderLeadMinutes: originalFields.dueReminderLeadMinutes || undefined });
                if (kind === 'reference') expect(restored.dueReminderLeadMinutes).toBe(0);
                expect(restored.deletedAt).toBeUndefined();
                expect(restored.rev).toBeGreaterThan(original.rev!);
                expect(await sqlite.sql('SELECT * FROM tasks WHERE id=?', [sentinel.id])).toEqual(originalRows);
                expect(await sqlite.receiptIds()).toEqual([decision.request.requestId, undo.request.requestId].sort());
                const saved = await snapshot(sqlite);
                expect(value(await sqlite.host.inboxUndoCommit(undo))).toEqual(offer);
                expect(await snapshot(sqlite)).toEqual(saved);
            } finally { await sqlite.close(); }
        });

    it('restores a returning Someday task to its actual original status without rewinding the next-task session', async () => {
        const sqlite = await openSqliteHost(seed(task({ status: 'someday', reviewAt: '2026-10-19' }), [task({ id: 'next-inbox', title: 'Z next capture' })]));
        try {
            const decision = prepareDecision(sqlite, 'next');
            const before = decision.prepared.witness.source;
            value(await sqlite.host.inboxPreparedCommit(decision));
            const next = value(sqlite.host.inboxAfterCommit({ sessionId: decision.request.sessionId, requestId: decision.request.requestId }));
            const undo = prepareUndo(sqlite, decision);
            value(await sqlite.host.inboxUndoCommit(undo));
            expect(useTaskStore.getState()._tasksById.get(decision.request.taskId)?.status).toBe(before.status);
            if (next.view) expect(value(sqlite.host.getInboxProcessingStep({ sessionId: next.view.sessionId, taskId: next.view.taskId,
                step: next.view.step })).draft).toEqual(next.view.draft);
        } finally { await sqlite.close(); }
    });

    it('validates and cold-replays the old Reference decision bytes without weakening configured-lead or row guards', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            const current = prepareDecision(sqlite, 'reference');
            expect(current.prepared.effect.tasks.find((row) => row.after.id === ID)?.after.dueReminderLeadMinutes).toBe(0);
            const legacy = JSON.parse(canonicalInboxJSON(current)) as NativeInboxDecisionEnvelope;
            delete legacy.prepared.effect.tasks.find((row) => row.after.id === ID)!.after.dueReminderLeadMinutes;
            const frozen = canonicalInboxJSON(legacy);
            const info = vi.spyOn(logger, 'logInfo');
            expect(canonicalInboxJSON(readNativePreparedInboxWrite(legacy))).toBe(canonicalInboxJSON(legacy.prepared));
            expect(info).toHaveBeenCalledWith('Legacy Reference decision validated', { scope: 'native-host', force: true,
                context: { releaseCheck: 'v1.3.8/native-reference-legacy-decision', outcome: 'validated' } });
            const forged = JSON.parse(frozen) as NativeInboxDecisionEnvelope;
            forged.prepared.effect.tasks.find((row) => row.after.id === ID)!.after.title = 'Altered';
            expect(readNativePreparedInboxWrite(forged)).toBeNull();
            const configured = JSON.parse(frozen) as NativeInboxDecisionEnvelope;
            for (const row of [configured.prepared.witness.source, ...configured.prepared.witness.lists.tasks,
                configured.prepared.effect.sourceBefore, ...configured.prepared.effect.tasks.map((row) => row.before)]) {
                if (row?.id === ID) row.dueReminderLeadMinutes = 15;
            }
            expect(readNativePreparedInboxWrite(configured)).toBeNull();
            const done = value(await sqlite.host.inboxPreparedCommit(JSON.parse(frozen)));
            const undo = prepareUndo(sqlite, legacy);
            const frozenUndo = canonicalInboxJSON(undo);
            expect(canonicalInboxJSON(readNativePreparedInboxUndo(JSON.parse(frozenUndo)))).toBe(frozenUndo);
            expect(Object.prototype.hasOwnProperty.call(undo.prepared.effect.tasks.find((row) => row.after.id === ID)!.after,
                'dueReminderLeadMinutes')).toBe(false);
            const undone = value(await sqlite.host.inboxUndoCommit(JSON.parse(frozenUndo)));
            await sqlite.client().run('UPDATE tasks SET dueReminderLeadMinutes=15,rev=rev+1 WHERE id=?', [ID]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await snapshot(sqlite);
            expect(value(sqlite.host.inboxPreparedValidate(JSON.parse(frozen)))).toEqual(done);
            expect(value(await sqlite.host.inboxPreparedCommit(JSON.parse(frozen)))).toEqual(done);
            expect(value(sqlite.host.inboxUndoOutcome(JSON.parse(frozenUndo)))).toEqual(undone);
            expect(value(await sqlite.host.inboxUndoCommit(JSON.parse(frozenUndo)))).toEqual(undone);
            expect(canonicalInboxJSON(legacy)).toBe(frozen);
            expect(await snapshot(sqlite)).toEqual(before);
            expect(useTaskStore.getState()._tasksById.get(ID)?.dueReminderLeadMinutes).toBe(15);
        } finally { await sqlite.close(); }
    });

    it('refuses a receiptless old Reference decision after a current lead edit without touching the row', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            const legacy = prepareDecision(sqlite, 'reference');
            delete legacy.prepared.effect.tasks.find((row) => row.after.id === ID)!.after.dueReminderLeadMinutes;
            expect(readNativePreparedInboxWrite(legacy)).not.toBeNull();
            await useTaskStore.getState().updateTask(ID, { dueReminderLeadMinutes: 15 }); await flushPendingSave();
            const before = await snapshot(sqlite);
            expect(await sqlite.host.inboxPreparedCommit(legacy)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await snapshot(sqlite)).toEqual(before);
            expect(useTaskStore.getState()._tasksById.get(ID)?.dueReminderLeadMinutes).toBe(15);
        } finally { await sqlite.close(); }
    });

    it('does not offer Undo for actual Skip, project conversion or standalone destination creation', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            let view = value(sqlite.host.startInboxProcessing({ mode: 'quick' })).view!;
            const skipped = value(sqlite.host.inboxSkipPrepare({ sessionId: view.sessionId, taskId: ID, requestId: generateUUID() })).prepared;
            expect(nativeInboxUndoOffer(skipped)).toBeNull();
            const choose = (choice: string) => {
                const request = { sessionId: view.sessionId, taskId: ID, step: view.step, decision: { choice }, requestId: generateUUID() };
                const answer = value(sqlite.host.inboxCommitPrepare(request));
                if (answer.kind === 'flow') view = answer.result.view!;
                return answer;
            };
            choose('project'); choose('project');
            view = value(sqlite.host.getInboxProcessingStep({ sessionId: view.sessionId, taskId: ID, step: view.step,
                edit: { type: 'set', field: 'nextAction', value: 'First action' } }));
            const conversion = choose('createProject');
            expect(conversion.kind).toBe('prepared');
            if (conversion.kind === 'prepared') expect(nativeInboxUndoOffer(conversion.prepared)).toBeNull();
            view = value(sqlite.host.getInboxProcessingStep({ sessionId: view.sessionId, taskId: ID, step: view.step,
                edit: { type: 'selectProject', value: null } }));
            view = value(sqlite.host.getInboxProcessingStep({ sessionId: view.sessionId, taskId: ID, step: view.step,
                edit: { type: 'set', field: 'projectSearch', value: 'Fresh home' } }));
            const created = choose('submitProjectSearch');
            expect(created.kind).toBe('prepared');
            if (created.kind === 'prepared') expect(nativeInboxUndoOffer(created.prepared)).toBeNull();
        } finally { await sqlite.close(); }
    });

    it('requires an actual original saved receipt, and refuses a changed source before and after preparation without writes', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            const decision = prepareDecision(sqlite);
            const request = { requestId: generateUUID(), taskId: ID, decisionRequestId: decision.request.requestId };
            const before = await snapshot(sqlite);
            expect(sqlite.host.inboxUndoPrepare({ request, decision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await snapshot(sqlite)).toEqual(before);
            // A coherent AFTER row is not proof that this original request saved.
            expect((await useTaskStore.getState().commitPreparedInboxEffect(decision.prepared.effect)).success).toBe(true);
            await flushPendingSave();
            expect(sqlite.host.inboxUndoPrepare({ request, decision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            value(await sqlite.host.inboxPreparedCommit(decision));
            const undo = prepareUndo(sqlite, decision);
            await useTaskStore.getState().updateTask(ID, { title: 'Newer remote content', dueReminderLeadMinutes: 15 }); await flushPendingSave();
            const changed = await snapshot(sqlite);
            expect(sqlite.host.inboxUndoPrepare({ request, decision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await sqlite.host.inboxUndoCommit(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await snapshot(sqlite)).toEqual(changed);
        } finally { await sqlite.close(); }
    });

    it('replays the old absent-lead Undo envelope unchanged after a later configured lead and missing original proof', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            const decision = prepareDecision(sqlite); value(await sqlite.host.inboxPreparedCommit(decision));
            const undo = prepareUndo(sqlite, decision);
            const after = undo.prepared.effect.tasks.find((row) => row.after.id === ID)!.after;
            expect(Object.prototype.hasOwnProperty.call(after, 'dueReminderLeadMinutes')).toBe(false);
            const frozen = canonicalInboxJSON(undo);
            expect(canonicalInboxJSON(readNativePreparedInboxUndo(JSON.parse(frozen)))).toBe(frozen);
            const done = value(await sqlite.host.inboxUndoCommit(JSON.parse(frozen)));
            await useTaskStore.getState().updateTask(ID, { title: 'Later content', dueReminderLeadMinutes: 15 }); await flushPendingSave();
            await sqlite.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [decision.request.requestId]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            const before = await snapshot(sqlite);
            expect(value(sqlite.host.inboxUndoOutcome(JSON.parse(frozen)))).toEqual(done);
            expect(value(await sqlite.host.inboxUndoCommit(JSON.parse(frozen)))).toEqual(done);
            expect(canonicalInboxJSON(undo)).toBe(frozen);
            expect(useTaskStore.getState()._tasksById.get(ID)?.dueReminderLeadMinutes).toBe(15);
            expect(await snapshot(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it.each([['strict', false], ['strict', true], ['after-completion', false], ['after-completion', true]] as const)(
        'removes exactly its owned %s recurrence child or refuses its edit (changed=%s)', async (strategy, changed) => {
        const sqlite = await openSqliteHost(seed(task({ status: 'someday', reviewAt: '2026-10-19', dueDate: '2026-10-20',
            recurrence: { rule: 'daily', strategy, seriesId: ID } })));
        try {
            const decision = prepareDecision(sqlite, 'done'); value(await sqlite.host.inboxPreparedCommit(decision));
            const child = decision.prepared.effect.tasks.find((row) => row.before === null)!.after;
            const undo = prepareUndo(sqlite, decision);
            expect(undo.prepared.effect.tasks.find((row) => row.after.id === child.id)?.after.deletedAt).toBe(NOW);
            if (changed) {
                await useTaskStore.getState().updateTask(child.id, { title: 'Changed follow-up' }); await flushPendingSave();
                const before = await snapshot(sqlite);
                expect(sqlite.host.inboxUndoPrepare({ request: { ...undo.request, requestId: generateUUID() }, decision }))
                    .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await sqlite.host.inboxUndoCommit(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
                expect(await snapshot(sqlite)).toEqual(before);
            } else {
                value(await sqlite.host.inboxUndoCommit(undo));
                expect(useTaskStore.getState()._tasksById.get(child.id)).toMatchObject({ deletedAt: NOW, rev: child.rev! + 1 });
                expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({ status: 'someday', dueDate: '2026-10-20' });
            }
        } finally { await sqlite.close(); }
    });

    it('leaves a preexisting recurrence duplicate untouched during completion Undo', async () => {
        const recurrence = { rule: 'daily' as const, strategy: 'strict' as const, seriesId: ID };
        const sqlite = await openSqliteHost(seed(task({ status: 'someday', reviewAt: '2026-10-19', dueDate: '2026-10-20', recurrence })));
        try {
            const candidate = prepareDecision(sqlite, 'done').prepared.effect.tasks.find((row) => row.before === null)!.after;
            const existing = { ...candidate, id: 'existing-child' };
            const adapter = new SqliteAdapter(sqlite.client());
            const data = await adapter.getData({ rawTasks: true });
            await adapter.saveData({ ...data, tasks: [...data.tasks, existing] });
            await sqlite.restart(undefined, { recoveryLoad: true });
            const decision = prepareDecision(sqlite, 'done');
            expect(decision.prepared.effect.tasks.some((row) => row.before === null)).toBe(false);
            value(await sqlite.host.inboxPreparedCommit(decision));
            const before = await sqlite.sql('SELECT * FROM tasks WHERE id=?', [existing.id]);
            value(await sqlite.host.inboxUndoCommit(prepareUndo(sqlite, decision)));
            expect(await sqlite.sql('SELECT * FROM tasks WHERE id=?', [existing.id])).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('uses Trash restoration container sanitization after the old parent disappears, without restoring draft edits', async () => {
        const sqlite = await openSqliteHost({ ...seed(task({ projectId: 'parent' })),
            projects: [{ id: 'parent', title: 'Parent', status: 'active', color: '#94a3b8', order: 0, tagIds: [],
                createdAt: BEFORE, updatedAt: BEFORE, rev: 1, revBy: 'device-a' }] });
        try {
            const decision = prepareDecision(sqlite, 'trash'); value(await sqlite.host.inboxPreparedCommit(decision));
            await sqlite.client().run('UPDATE projects SET deletedAt=? WHERE id=?', [NOW, 'parent']);
            useTaskStore.setState({ _allProjects: useTaskStore.getState()._allProjects.map((project) => ({ ...project, deletedAt: NOW })) });
            const undo = prepareUndo(sqlite, decision); value(await sqlite.host.inboxUndoCommit(undo));
            expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({ title: 'A original task', description: 'Original note', status: 'inbox' });
            expect(useTaskStore.getState()._tasksById.get(ID)?.projectId).toBeUndefined();
        } finally { await sqlite.close(); }
    });

    it.each([0, 3])('uses RN conditional Focus restoration with %s occupied slots and the exact policy revision count', async (count) => {
        const focused = Array.from({ length: count }, (_, index) => task({ id: `focused-${index}`, title: `Z focused ${index}`, status: 'next', isFocusedToday: true }));
        const sqlite = await openSqliteHost(seed(task({ status: 'someday', reviewAt: '2026-10-19', isFocusedToday: true, focusOrder: 7 }), focused));
        try {
            const decision = prepareDecision(sqlite, 'done'); value(await sqlite.host.inboxPreparedCommit(decision));
            const completed = useTaskStore.getState()._tasksById.get(ID)!;
            const undo = prepareUndo(sqlite, decision); value(await sqlite.host.inboxUndoCommit(undo));
            const restored = useTaskStore.getState()._tasksById.get(ID)!;
            expect(restored.isFocusedToday).toBe(count < 3);
            expect(restored.focusOrder).toBe(count < 3 ? 7 : undefined);
            expect(restored.rev).toBe(completed.rev! + (count < 3 ? 2 : 1));
        } finally { await sqlite.close(); }
    });

    it.each(['decision', 'undo'] as const)('keeps the real %s COMMIT failure atomic, then retries once and replays after cold receipt load', async (operation) => {
        const fault = { commits: 0 };
        const sqlite = await openSqliteHost(seed(), (client) => ({ ...client, run: async (sql, args) => {
            if (sql === 'COMMIT' && fault.commits-- > 0) throw new Error('Injected Process Inbox COMMIT failure');
            return client.run(sql, args);
        } }));
        try {
            const decision = prepareDecision(sqlite);
            if (operation === 'undo') value(await sqlite.host.inboxPreparedCommit(decision));
            const undo = operation === 'undo' ? prepareUndo(sqlite, decision) : null;
            const commit = () => undo ? sqlite.host.inboxUndoCommit(undo) : sqlite.host.inboxPreparedCommit(decision);
            const before = await snapshot(sqlite); fault.commits = 10;
            expect(await commit()).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(await snapshot(sqlite)).toEqual(before);
            fault.commits = 0; const saved = value(await commit());
            const after = await snapshot(sqlite);
            await sqlite.restart(undefined, { recoveryLoad: true });
            expect(value(await commit())).toEqual(saved);
            expect(await snapshot(sqlite)).toEqual(after);
        } finally { fault.commits = 0; resetForTests(); await sqlite.close(); }
    }, 30_000);

    it('rejects forged effects, wrong original/Undo identities, invalid clocks and oversized journals before a writer', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            const decision = prepareDecision(sqlite); value(await sqlite.host.inboxPreparedCommit(decision));
            const undo = prepareUndo(sqlite, decision), before = await snapshot(sqlite);
            const writer = vi.spyOn(useTaskStore.getState(), 'commitPreparedChecklistEffect');
            const mutations = [
                (copy: NativeInboxUndoEnvelope) => { copy.prepared.effect.tasks[0].after.title = 'Forged'; },
                (copy: NativeInboxUndoEnvelope) => { copy.request.decisionRequestId = generateUUID(); },
                (copy: NativeInboxUndoEnvelope) => { copy.request.requestId = copy.request.decisionRequestId; },
                (copy: NativeInboxUndoEnvelope) => { copy.prepared.witness.preparedLocalDay = 'invalid'; },
                (copy: NativeInboxUndoEnvelope) => { copy.prepared.witness.source.title = 'x'.repeat(4_500_000); },
            ];
            for (const mutate of mutations) {
                const copy = structuredClone(undo); mutate(copy);
                expect(readNativePreparedInboxUndo(copy)).toBeNull();
                expect(await sqlite.host.inboxUndoCommit(copy)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect(writer).not.toHaveBeenCalled(); expect(await snapshot(sqlite)).toEqual(before);
        } finally { await sqlite.close(); }
    });

    it('keeps old v1 decision row-target replay compatible, but a new Undo UUID cannot borrow an already applied target', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            const decision = prepareDecision(sqlite);
            // The historical v1 committer could have saved its effect without a request receipt.
            expect((await useTaskStore.getState().commitPreparedInboxEffect(decision.prepared.effect)).success).toBe(true);
            await flushPendingSave(); expect(await sqlite.receiptIds()).toEqual([]);
            await sqlite.restart(undefined, { recoveryLoad: true });
            value(await sqlite.host.inboxPreparedCommit(JSON.parse(canonicalInboxJSON(decision))));
            expect(await sqlite.receiptIds()).toEqual([decision.request.requestId]);
            const undo = prepareUndo(sqlite, decision); value(await sqlite.host.inboxUndoCommit(undo));
            const freshRequest = { ...undo.request, requestId: generateUUID() };
            const copied = structuredClone(undo); copied.request = freshRequest; copied.prepared.request = freshRequest;
            const before = await snapshot(sqlite);
            expect(await sqlite.host.inboxUndoCommit(copied)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await snapshot(sqlite)).toEqual(before);
            const invalid = { ...decision, request: { ...decision.request, taskId: 'other' } };
            expect(await sqlite.host.inboxPreparedCommit(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        } finally { await sqlite.close(); }
    });

    it('rechecks requireBefore at the final store boundary when another owner lands the exact target after validation', async () => {
        const sqlite = await openSqliteHost(seed());
        try {
            const decision = prepareDecision(sqlite); value(await sqlite.host.inboxPreparedCommit(decision));
            const undo = prepareUndo(sqlite, decision), before = await snapshot(sqlite);
            const commit = useTaskStore.getState().commitPreparedChecklistEffect;
            vi.spyOn(useTaskStore.getState(), 'commitPreparedChecklistEffect').mockImplementationOnce(async (effect, options) => {
                const tasks = useTaskStore.getState()._allTasks.map((task) => effect.tasks.find((row) => row.after.id === task.id)?.after ?? task);
                useTaskStore.setState({ _allTasks: tasks });
                return commit(effect, options);
            });
            expect(await sqlite.host.inboxUndoCommit(undo)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await snapshot(sqlite)).toEqual(before);
            expect(await sqlite.receiptIds()).toEqual([decision.request.requestId]);
        } finally { await sqlite.close(); }
    });

    it('keeps a captured decision bound to its original task when another decision advances the session', async () => {
        const sqlite = await openSqliteHost(seed(task(), [task({ id: 'next-inbox', title: 'Z next capture' })]));
        try {
            const decision = prepareDecision(sqlite); value(await sqlite.host.inboxPreparedCommit(decision));
            const next = value(sqlite.host.inboxAfterCommit({ sessionId: decision.request.sessionId, requestId: decision.request.requestId })).view!;
            const secondRequest = { sessionId: next.sessionId, taskId: next.taskId, step: next.step, decision: { choice: 'trash' }, requestId: generateUUID() };
            const second = value(sqlite.host.inboxCommitPrepare(secondRequest));
            if (second.kind !== 'prepared') throw new Error('Expected a second decision');
            value(await sqlite.host.inboxPreparedCommit({ request: secondRequest, prepared: second.prepared }));
            const before = useTaskStore.getState()._tasksById.get(next.taskId);
            const undo = prepareUndo(sqlite, decision); value(await sqlite.host.inboxUndoCommit(undo));
            expect(useTaskStore.getState()._tasksById.get(ID)?.status).toBe('inbox');
            expect(useTaskStore.getState()._tasksById.get(next.taskId)).toEqual(before);
        } finally { await sqlite.close(); }
    });
});
