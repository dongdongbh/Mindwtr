import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTaskDraft } from '../../../packages/core/src/task-draft';
import { getPersistenceStatus, getStorageAdapter, flushPendingSave, resetForTests, useTaskStore } from '../../../packages/core/src/store';
import { resetNativeRequestReceipts } from '../../../packages/core/src/native-request-receipts';
import { acquireWorkspaceTransitionLock } from '../../../packages/core/src/sandbox';
import type { AppData } from '../../../packages/core/src/types';

const AT = '2026-10-30T12:00:00.000Z', ID = 'legacy-task-id', PRIVATE = 'PRIVATE-SELECTED-KEY';
let sequence = 0;
const databases = new Set<Database>(), globals = new Map<string, PropertyDescriptor | undefined>();
const names = ['MindwtrHost', '__mindwtrHostPlatform', '__mindwtrNative', '__mindwtrSecrets', '__mindwtrSyncSecrets',
    '__cancelHostCalls', '__resumeHostCalls', 'fetch'];
afterEach(async () => {
    await flushPendingSave().catch(() => undefined); resetForTests(); resetNativeRequestReceipts();
    for (const db of databases) db.close(); databases.clear();
    for (const [name, descriptor] of globals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
    globals.clear();
});
const seed = (provider: 'openai' | 'gemini' | 'anthropic'): AppData => ({
    tasks: [
        { id: ID, title: 'Plan conference trip', description: 'Keep original notes', status: 'inbox', projectId: 'p1',
            contexts: ['@desk'], tags: [], checklist: [{ id: 'kept', title: 'Passport', isCompleted: true }], createdAt: AT, updatedAt: AT, rev: 2 },
        { id: 'sibling', title: 'Budget', status: 'next', projectId: 'p1', contexts: [], tags: [], createdAt: AT, updatedAt: AT },
        { id: 'unrelated', title: 'Other work', status: 'next', projectId: 'p2', contexts: [], tags: [], createdAt: AT, updatedAt: AT },
    ],
    projects: ['p1', 'p2'].map(id => ({ id, title: id === 'p1' ? 'Conference' : 'Other', status: 'active', color: '#123456', order: 0,
        tagIds: [], createdAt: AT, updatedAt: AT })), sections: [], areas: [], people: [],
    settings: { deviceId: 'fixture-device', features: { timeEstimates: true },
        ai: { enabled: true, provider, ...(provider === 'openai' ? { baseUrl: 'https://provider.invalid/v1' } : {}) } },
});
const clarify = { question: 'What is the next action?', options: [{ label: 'Book travel', action: 'Book conference travel' }],
    suggestedAction: { title: 'Reserve travel', context: '@phone', timeEstimate: '30min' } };
const breakdown = { steps: [' Book travel ', '', 'Reserve hotel'] };
const response = (provider: string, value: unknown) => new Response(JSON.stringify(provider === 'gemini'
    ? { candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] }
    : provider === 'anthropic' ? { content: [{ type: 'text', text: JSON.stringify(value) }] }
        : { choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } });
const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
};

async function fixture(provider: 'openai' | 'gemini' | 'anthropic' = 'openai', platform = 'ios') {
    for (const name of names) if (!globals.has(name)) globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    resetForTests(); resetNativeRequestReceipts();
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        lastDataChangeAt: 0, persistenceFailure: null, error: null, isLoading: false, editLockCount: 0 });
    const db = new Database(':memory:'); databases.add(db);
    const writes: string[] = [], effects: unknown[] = [], phases: Record<string, unknown>[] = [], kv = new Map<string, string>();
    let currentView: any;
    let ownerLive = true, credential: string | null = PRIVATE, fetched = 0;
    let work: () => Promise<Response> = async () => response(provider, clarify);
    Object.assign(globalThis, {
        __mindwtrHostPlatform: platform, __mindwtrSyncSecrets: {}, __cancelHostCalls() {}, __resumeHostCalls() {},
        __mindwtrSecrets: { get: () => { effects.push('secret-store'); throw new Error(PRIVATE); },
            set: () => { effects.push('secret-write'); throw new Error(PRIVATE); }, delete: () => { effects.push('secret-delete'); throw new Error(PRIVATE); } },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push(sql); db.exec(sql); return null; },
            sqlRun: (sql: string, raw: string) => { writes.push(sql); db.query(sql).run(...JSON.parse(raw)); return null; },
            sqlAll: (sql: string, raw: string) => JSON.stringify(db.query(sql).all(...JSON.parse(raw))),
            nowMs: () => Date.parse(AT), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)), log() {},
            rnStateCommit: () => { effects.push('rnStateCommit'); return null; },
            kvGet: (name: string) => JSON.stringify([kv.get(name) ?? null]),
            kvMultiGet: (raw: string) => JSON.stringify(JSON.parse(raw).map((name: string) => [name, kv.get(name) ?? null])),
            kvSet: (name: string, value: string) => { effects.push('kv-write'); kv.set(name, value); return null; },
            kvRemove: (name: string) => { effects.push('kv-delete'); kv.delete(name); return null; },
            fileList: () => 'null', fileRead: () => { effects.push('file-read'); throw new Error(PRIVATE); },
            fileDelete: () => { effects.push('file-delete'); return null; },
            logFile: (op: string) => { effects.push(['log', op]); return op === 'path' || op === 'ensure' ? 'files/logs/mindwtr.log'
                : op === 'size' ? '0' : op === 'isAbsent' ? '1' : ''; },
        },
        fetch: async () => { fetched += 1; return work(); },
    });
    await import(`./host-entry.ts?inboxAIFixture=${++sequence}`);
    const host = (globalThis as any).MindwtrHost;
    const poll = async (ticket: string) => {
        for (const deadline = Date.now() + 4_000; Date.now() < deadline;) {
            const raw = host.poll(ticket); if (raw !== null) return JSON.parse(raw);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        throw new Error('Task AI did not settle');
    };
    const owner = (json: string) => {
        const request = JSON.parse(json); phases.push(request);
        if (!ownerLive) return 'refused';
        return request.phase === 'credential' ? JSON.stringify({ value: credential }) : '';
    };
    const raw = (method: string, json: string, callback: unknown = owner) => poll(host[method](json, callback));
    const call = (method: string, value: unknown, callback: unknown = owner) => raw(method, JSON.stringify(value), callback);
    const boot = async (data = seed(provider)) => {
        expect(await poll(host.boot('', ''))).toMatchObject({ ok: true });
        await flushPendingSave(); const adapter = getStorageAdapter(); await adapter.saveData(data);
        const saved = await adapter.getData();
        useTaskStore.setState({ _allTasks: saved.tasks, _allProjects: saved.projects, _allSections: saved.sections,
            _allAreas: saved.areas, _allPeople: saved.people, settings: saved.settings });
        adapter.acknowledgeDataLoad?.(saved);
        currentView = (await poll(host.inboxStart('guided'))).value.view;
        effects.length = 0; writes.length = 0; phases.length = 0;
    };
    const question = () => ({ sessionId: currentView.sessionId, taskId: currentView.taskId, step: currentView.step });
    const saved = () => JSON.parse((db.query('SELECT data FROM settings WHERE id=1').get() as { data: string }).data);
    const held = () => {
        const waiting = deferred(), started = deferred();
        work = async () => { started.release(); await waiting.promise; return response(provider, clarify); };
        return { started: started.promise, release: waiting.release };
    };
    return { host, poll, raw, call, owner, boot, question, phases, writes, effects, saved, held, db, view: () => currentView,
        fetched: () => fetched, refuse: () => { ownerLive = false; }, missingCredential: () => { credential = null; },
        reply: (value: unknown) => { work = async () => response(provider, value); },
        fail: () => { work = async () => { throw new Error(`Provider echoed ${PRIVATE} and endpoint-password`); }; } };
}

describe('private iOS Process Inbox AI', () => {
    it.each(['openai', 'gemini', 'anthropic'] as const)('keeps canonical %s Clarify and Apply draft-only, preserving existing read keys', async provider => {
        const f = await fixture(provider); await f.boot();
        const before = await f.call('inboxStep', f.question()), keys = Object.keys(before.value).sort();
        const rows = JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all()), settings = f.saved();
        expect(before.value.aiClarify).toMatchObject({ label: expect.any(String), working: expect.any(String) });
        const witness = await f.call('iosInboxAIWitness', f.question());
        expect(witness.ok).toBe(true); expect(Object.keys(witness.value).sort()).toEqual(['contexts', 'draft', 'language', 'mode', 'step']);
        const answer = await f.call('iosInboxAIRequest', f.question());
        expect(answer).toMatchObject({ ok: true }); expect(answer.value.kind).toBe('dialog');
        expect(f.phases.filter(p => p.phase === 'credential')).toEqual([{ phase: 'credential', provider }]);
        const choice = answer.value.choices.find((entry: any) => entry.variant === 'primary');
        expect(choice.apply).toEqual([{ type: 'set', field: 'title', value: 'Reserve travel' }, { type: 'addContext', value: '@phone' }]);
        const applied = await f.call('iosInboxAIApply', { request: f.question(), expected: witness.value, edits: choice.apply }, () => '');
        expect(applied.ok).toBe(true); expect(applied.value.draft.title).toBe('Reserve travel');
        expect(applied.value.draft.contexts).toEqual(['@desk', '@phone']);
        expect(Object.keys(applied.value).sort()).toEqual(keys);
        expect(JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all())).toBe(rows);
        expect(f.saved()).toEqual(settings); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]); expect(f.fetched()).toBe(1);
        expect((await f.call('iosInboxAIApply', { request: f.question(), expected: witness.value, edits: choice.apply }, () => '')).ok).toBe(false);
    });

    it('validates every Apply edit before changing any processing draft and requires its exact witness/owner', async () => {
        const f = await fixture(); await f.boot(); const witness = (await f.call('iosInboxAIWitness', f.question())).value;
        const valid = { type: 'set', field: 'title', value: 'Should not partially apply' };
        for (const edits of [[valid, { type: 'setPriority', value: 'high' }], [{ ...valid, extra: true }], [], [valid, { type: 'addContext', value: '' }]]) {
            expect((await f.call('iosInboxAIApply', { request: f.question(), expected: witness, edits }, () => '')).ok).toBe(false);
            expect((await f.call('iosInboxAIWitness', f.question())).value).toEqual(witness);
        }
        expect((await f.call('iosInboxAIApply', { request: f.question(), expected: witness, edits: [valid] }, () => 'refused')).ok).toBe(false);
        expect((await f.call('iosInboxAIWitness', f.question())).value).toEqual(witness);
        for (const input of [{ ...f.question(), extra: true }, { ...f.question(), taskId: '' }, { ...f.question(), step: 1 }, {}, []]) {
            expect((await f.call('iosInboxAIRequest', input)).ok).toBe(false);
            expect((await f.call('iosInboxAIWitness', input)).ok).toBe(false);
        }
        expect(f.fetched()).toBe(0); expect(f.writes).toEqual([]);
    });

    it.each(['input', 'mode', 'task', 'deleted', 'config', 'language', 'owner', 'session'] as const)('refuses a held response after %s changes', async change => {
        const f = await fixture(); await f.boot(); const question = f.question(), held = f.held();
        const ticket = f.host.iosInboxAIRequest(JSON.stringify(question), f.owner); await held.started;
        if (change === 'input') expect((await f.call('inboxStep', { ...question, edit: { type: 'set', field: 'title', value: 'Changed input' } })).ok).toBe(true);
        else if (change === 'mode') expect((await f.call('inboxStep', { ...question, mode: 'quick' })).ok).toBe(true);
        else if (change === 'task' || change === 'deleted') useTaskStore.setState(state => ({ _allTasks: state._allTasks.map(task => task.id === ID
            ? { ...task, ...(change === 'deleted' ? { deletedAt: AT } : { title: 'Changed target', rev: 3 }) } : task) }));
        else if (change === 'config') useTaskStore.setState(state => ({ settings: { ...state.settings, ai: { ...state.settings.ai, model: 'changed' } } }));
        else if (change === 'language') expect((await f.poll(f.host.language('de', 'de-DE'))).ok).toBe(true);
        else if (change === 'owner') f.refuse();
        else expect((await f.poll(f.host.inboxEnd(question.sessionId))).ok).toBe(true);
        held.release(); expect((await f.poll(ticket)).ok).toBe(false);
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });

    it('allows an unrelated durable save, selected abort and the next explicit request without runtime-wide cancellation', async () => {
        const f = await fixture(); await f.boot(); const held = f.held(), question = f.question();
        const ticket = f.host.iosInboxAIRequest(JSON.stringify(question), f.owner); await held.started;
        await useTaskStore.getState().updateTask('unrelated', { description: 'Saved during HTTP' }); await flushPendingSave();
        held.release(); expect((await f.poll(ticket)).ok).toBe(true);
        const second = f.held(), next = f.host.iosInboxAIRequest(JSON.stringify(question), f.owner); await second.started;
        f.host.abort(next); second.release(); expect((await f.poll(next)).ok).toBe(false);
        f.reply(clarify); expect((await f.call('iosInboxAIRequest', question)).ok).toBe(true);
        expect(useTaskStore.getState()._tasksById.get(ID)?.title).toBe('Plan conference trip');
    });

    it('keeps the Task AI and Inbox AI private owners exclusive', async () => {
        const f = await fixture(); await f.boot(); const held = f.held();
        const ticket = f.host.iosInboxAIRequest(JSON.stringify(f.question()), f.owner); await held.started;
        const task = useTaskStore.getState()._tasksById.get(ID)!;
        expect((await f.call('iosTaskAIRequest', { operation: 'clarify', id: ID, draft: createTaskDraft(task) })).ok).toBe(false);
        held.release(); expect((await f.poll(ticket)).ok).toBe(true);
        const other = f.held();
        const taskTicket = f.host.iosTaskAIRequest(JSON.stringify({ operation: 'clarify', id: ID, draft: createTaskDraft(task) }), f.owner); await other.started;
        expect((await f.call('iosInboxAIRequest', f.question())).ok).toBe(false);
        other.release(); expect((await f.poll(taskTicket)).ok).toBe(true);
    });

    it('preserves canonical disabled/missing-key toasts and secret-safe provider errors', async () => {
        const f = await fixture(); await f.boot(); f.missingCredential();
        useTaskStore.setState(state => ({ settings: { ...state.settings, ai: { ...state.settings.ai, baseUrl: undefined } } }));
        const missing = await f.call('iosInboxAIRequest', f.question());
        expect(missing.value).toMatchObject({ kind: 'toast', toast: { tone: 'warning', durationMs: 5200, action: { screen: 'ai' } } });
        expect(f.fetched()).toBe(0);
        useTaskStore.setState(state => ({ settings: { ...state.settings, ai: { ...state.settings.ai, enabled: false } } }));
        expect((await f.call('iosInboxAIRequest', f.question())).value.kind).toBe('toast');
        expect(f.writes).toEqual([]);
    });
    it('persists an applied suggestion only through the existing ordinary processing decision', async () => {
        const f = await fixture(); await f.boot(); const input = f.question();
        const expected = (await f.call('iosInboxAIWitness', input)).value;
        const answer = await f.call('iosInboxAIRequest', input);
        const edits = answer.value.choices.find((choice: any) => choice.variant === 'primary').apply;
        const view = (await f.call('iosInboxAIApply', { request: input, expected, edits }, () => '')).value;
        expect(useTaskStore.getState()._tasksById.get(ID)?.title).toBe('Plan conference trip');
        const flow = await f.call('inboxCommit', { ...input, step: view.step, decision: { choice: 'actionable' }, requestId: crypto.randomUUID() });
        expect(flow.ok).toBe(true);
        const next = flow.value.view;
        const saved = await f.call('inboxCommit', { ...input, step: next.step, decision: { choice: 'done' }, requestId: crypto.randomUUID() });
        expect(saved.ok).toBe(true); await flushPendingSave();
        expect(useTaskStore.getState()._tasksById.get(ID)).toMatchObject({ title: 'Reserve travel', status: 'done', contexts: ['@desk', '@phone'] });
        expect(f.fetched()).toBe(1);
    });

    it('refuses an oversized second canonical edit before changing the complete processing witness', async () => {
        const f = await fixture(); await f.boot(); const input = f.question();
        const expected = (await f.call('iosInboxAIWitness', input)).value;
        const rows = JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all());
        f.reply({ question: 'Choose', options: [], suggestedAction: { title: 'AI title before refused context', context: '@' + 'x'.repeat(500) } });
        const answer = (await f.call('iosInboxAIRequest', input)).value;
        const edits = answer.choices.find((choice: any) => choice.variant === 'primary').apply;
        expect(edits[1].value.length).toBe(501);
        expect((await f.call('iosInboxAIApply', { request: input, expected, edits }, () => '')).ok).toBe(false);
        expect((await f.call('iosInboxAIWitness', input)).value).toEqual(expected);
        expect((await f.call('iosInboxAIApply', { request: input, expected,
            edits: [{ type: 'set', field: 'title', value: 'x'.repeat(10_001) }] }, () => '')).ok).toBe(false);
        expect((await f.call('iosInboxAIWitness', input)).value).toEqual(expected);
        expect(JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all())).toBe(rows);
        expect(f.writes).toEqual([]);
    });

});
