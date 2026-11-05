import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTaskDraft } from '../../../packages/core/src/task-draft';
import { getPersistenceStatus, getStorageAdapter, flushPendingSave, resetForTests, useTaskStore } from '../../../packages/core/src/store';
import { resetNativeRequestReceipts } from '../../../packages/core/src/native-request-receipts';
import { acquireWorkspaceTransitionLock } from '../../../packages/core/src/sandbox';
import type { AppData } from '../../../packages/core/src/types';

const AT = '2026-08-01T12:00:00.000Z', ID = 'legacy-task-id', PRIVATE = 'PRIVATE-SELECTED-KEY';
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
        { id: ID, title: 'Plan conference trip', description: 'Keep original notes', status: 'next', projectId: 'p1',
            contexts: ['@desk'], tags: [], checklist: [{ id: 'kept', title: 'Passport', isCompleted: true }], createdAt: AT, updatedAt: AT, rev: 2 },
        { id: 'sibling', title: 'Budget', status: 'next', projectId: 'p1', contexts: [], tags: [], createdAt: AT, updatedAt: AT },
        { id: 'unrelated', title: 'Other work', status: 'next', projectId: 'p2', contexts: [], tags: [], createdAt: AT, updatedAt: AT },
    ],
    projects: ['p1', 'p2'].map(id => ({ id, title: id === 'p1' ? 'Conference' : 'Other', status: 'active', color: '#123456', order: 0,
        tagIds: [], createdAt: AT, updatedAt: AT })), sections: [], areas: [], people: [],
    settings: { deviceId: 'fixture-device', features: { timeEstimates: true },
        ai: { enabled: true, provider, ...(provider === 'openai' ? { baseUrl: 'https://provider.invalid/v1' } : {}) } },
});
const clarify = { suggestions: [{ id: ID, action: 'someday', reason: 'Reconsider later' }, { id: 'sibling', action: 'archive', reason: 'No longer needed' }] };
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
    const writes: string[] = [], effects: unknown[] = [], logs: { op: string; text: string }[] = [], phases: Record<string, unknown>[] = [], kv = new Map<string, string>();
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
            logFile: (op: string, text: string) => {
                if (['ensure', 'exists', 'append'].includes(op)) logs.push({ op, text });
                else effects.push(['log', op]);
                return op === 'path' || op === 'ensure' ? 'files/logs/mindwtr.log'
                : op === 'size' ? '0' : op === 'isAbsent' ? '1' : ''; },
        },
        fetch: async () => { fetched += 1; return work(); },
    });
    await import(`./host-entry.ts?reviewAIFixture=${++sequence}`);
    const host = (globalThis as any).MindwtrHost;
    const poll = async (ticket: string) => {
        for (let i = 0; i < 1000; i++) {
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
        currentView = {};
        effects.length = 0; writes.length = 0; phases.length = 0;
    };
    const question = () => ({});
    const saved = () => JSON.parse((db.query('SELECT data FROM settings WHERE id=1').get() as { data: string }).data);
    const held = () => {
        const waiting = deferred(), started = deferred();
        work = async () => { started.release(); await waiting.promise; return response(provider, clarify); };
        return { started: started.promise, release: waiting.release };
    };
    return { host, poll, raw, call, owner, boot, question, phases, writes, effects, saved, held, db, view: () => currentView,
        logs, fetched: () => fetched, refuse: () => { ownerLive = false; }, missingCredential: () => { credential = null; },
        reply: (value: unknown) => { work = async () => response(provider, value); },
        fail: () => { work = async () => { throw new Error(`Provider echoed ${PRIVATE} and endpoint-password`); }; } };
}

describe('private iOS Weekly Review AI', () => {
    it('uses section sequence candidates for iOS analysis and the Weekly Review stale step without a flag', async () => {
        const f = await fixture(), data = seed('openai');
        data.projects[0] = { ...data.projects[0], perSectionFlow: true };
        data.sections = [{ id: 'sequence', projectId: 'p1', title: 'Steps', order: 0, isSequential: true, createdAt: AT, updatedAt: AT }];
        data.tasks = [{ ...data.tasks[0], sectionId: 'sequence', order: 1 },
            { ...data.tasks[0], id: 'fresh-waiting-head', status: 'waiting', sectionId: 'sequence', order: 0, updatedAt: new Date().toISOString() }];
        await f.boot(data);
        const witness = (await f.call('iosReviewAIWitness', {})).value;
        expect(witness.items.some((item: { id: string }) => item.id === ID)).toBe(false);
        const answer = await f.call('iosReviewAIRequest', {});
        expect(answer).toMatchObject({ ok: true, value: { suggestions: [], selectedIds: [] } });
        expect(f.logs.filter(row => row.op === 'append').map(row => row.text).join('')).toContain('v1.3.8/ios-review-sequence');
        expect(f.logs.filter(row => row.op === 'append').map(row => row.text).join('')).toContain('prepared');
        expect(f.writes).toEqual([]);
        const plain = await f.poll(f.host.menuRead('weeklyReview', JSON.stringify({ checkpoint: JSON.stringify({ step: 'stale', startedAt: new Date().toISOString() }), offset: 0, limit: 100 })));
        expect(plain.value.items.some((item: { row?: { id: string } }) => item.row?.id === ID)).toBe(false);
    });

    it('invalidates held analysis when section flow makes an offered tail blocked', async () => {
        const f = await fixture(), data = seed('openai');
        data.projects[0] = { ...data.projects[0], perSectionFlow: true };
        data.sections = [{ id: 'sequence', projectId: 'p1', title: 'Steps', order: 0, isSequential: false, createdAt: AT, updatedAt: AT }];
        data.tasks = [{ ...data.tasks[0], sectionId: 'sequence', order: 1 },
            { ...data.tasks[0], id: 'fresh-waiting-head', status: 'waiting', sectionId: 'sequence', order: 0, updatedAt: new Date().toISOString() }];
        await f.boot(data);
        const held = f.held(), pending = f.call('iosReviewAIRequest', {}); await held.started;
        const state = useTaskStore.getState();
        useTaskStore.setState({ _allSections: state._allSections.map(section => ({ ...section, isSequential: true })) });
        held.release(); expect((await pending).ok).toBe(false);
        expect(f.writes).toEqual([]);
    });

    it('refuses a new Apply against fresh section-only SQL sequencing without adopting a write baseline', async () => {
        const f = await fixture(), data = seed('openai');
        data.projects[0] = { ...data.projects[0], perSectionFlow: true };
        data.sections = [{ id: 'sequence', projectId: 'p1', title: 'Steps', order: 0, isSequential: false, createdAt: AT, updatedAt: AT }];
        data.tasks = [{ ...data.tasks[0], sectionId: 'sequence', order: 1 },
            { ...data.tasks[0], id: 'fresh-waiting-head', status: 'waiting', sectionId: 'sequence', order: 0, updatedAt: new Date().toISOString() }];
        await f.boot(data);
        const answer = await f.call('iosReviewAIRequest', {}), selected = answer.value.suggestions[0];
        expect(selected.id).toBe(ID);
        const request = { requestId: crypto.randomUUID(), suggestions: [{ id: selected.id, action: selected.action, reason: selected.reason }], taskRevisions: { [selected.id]: selected.taskRevision } };
        const validate = () => f.poll(f.host.iosReviewAIValidateApply(JSON.stringify(request), JSON.stringify({ tasks: f.db.query('SELECT * FROM tasks ORDER BY rowid').all(), projects: f.db.query('SELECT * FROM projects ORDER BY rowid').all(), sections: f.db.query('SELECT * FROM sections ORDER BY rowid').all() })));
        expect(await validate()).toEqual({ ok: true, value: null });
        f.db.query('UPDATE sections SET isSequential=1 WHERE id=?').run('sequence');
        const before = JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all());
        expect(await validate()).toMatchObject({ ok: false, error: expect.stringContaining('STALE_REVISION') });
        expect(useTaskStore.getState().sections[0].isSequential).toBe(false);
        expect(JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all())).toBe(before);
        expect(f.writes).toEqual([]);
        f.db.query('UPDATE tasks SET reviewAt=? WHERE id=?').run('2026-01-01', ID);
        expect(await validate()).toEqual({ ok: true, value: null });
        f.db.query('UPDATE tasks SET reviewAt=NULL,status=? WHERE id=?').run('waiting', ID);
        expect(await validate()).toEqual({ ok: true, value: null });
    });

    it.each(['openai', 'gemini', 'anthropic'] as const)('keeps %s analysis canonical/read-only then applies only selected rows with durable exact receipts', async provider => {
        const f = await fixture(provider); await f.boot();
        const before = JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all());
        const readBefore = await f.poll(f.host.menuRead('weeklyReview', JSON.stringify({ offset: 0, limit: 100 })));
        const answer = await f.call('iosReviewAIRequest', {});
        expect(answer).toMatchObject({ ok: true, value: { error: null, selectedIds: [ID, 'sibling'] } });
        expect(answer.value.suggestions).toHaveLength(2);
        expect(JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all())).toBe(before);
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
        const readAfter = await f.poll(f.host.menuRead('weeklyReview', JSON.stringify({ offset: 0, limit: 100 })));
        expect(Object.keys(readAfter.value).sort()).toEqual(Object.keys(readBefore.value).sort());
        const selected = answer.value.suggestions[0];
        const request = { requestId: crypto.randomUUID(), suggestions: [{ id: selected.id, action: selected.action, reason: selected.reason }],
            taskRevisions: { [selected.id]: selected.taskRevision } };
        const applied = await f.call('iosReviewAIApply', request);
        expect(applied).toEqual({ ok: true, value: { changed: true, toast: null, createdId: null } });
        expect(await f.call('iosReviewAIOutcome', request)).toEqual(applied);
        expect(f.db.query('SELECT status FROM tasks WHERE id=?').get(ID)).toEqual({ status: 'someday' });
        expect(f.db.query('SELECT status FROM tasks WHERE id=?').get('sibling')).toEqual({ status: 'next' });
        const rows = JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all());
        expect(await f.call('iosReviewAIApply', request)).toEqual(applied);
        expect(JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all())).toBe(rows);
        expect(f.fetched()).toBe(1);
        expect(f.db.query('SELECT count(*) AS total FROM native_request_receipts WHERE request_id=?').get(request.requestId)).toEqual({ total: 1 });
        expect((await f.call('iosReviewAIApply', { ...request, suggestions: [{ ...request.suggestions[0], action: 'archive' }] })).ok).toBe(false);
    });

    it('preserves null versus empty results and keeps secrets out of canonical failure', async () => {
        const f = await fixture(); await f.boot();
        f.fail(); const failed = await f.call('iosReviewAIRequest', {});
        expect(failed.ok).toBe(true); expect(failed.value.suggestions).toBeNull(); expect(failed.value.selectedIds).toBeNull();
        expect(JSON.stringify(failed)).not.toContain(PRIVATE);
        f.reply({ suggestions: [] });
        expect(await f.call('iosReviewAIRequest', {})).toEqual({ ok: true, value: { error: null, suggestions: [], selectedIds: [] } });
        expect(f.writes).toEqual([]);
    });

    it('refuses a stale owner/changed offered input and validates every selection before writing', async () => {
        const f = await fixture(); await f.boot(); const held = f.held();
        const pending = f.call('iosReviewAIRequest', {}); await held.started;
        await useTaskStore.getState().updateTask(ID, { title: 'Changed while held' }); await flushPendingSave();
        held.release(); expect((await pending).ok).toBe(false);
        const answer = await f.call('iosReviewAIRequest', {}); const rows = answer.value.suggestions;
        const selected = rows.map((row: any) => ({ id: row.id, action: row.action, reason: row.reason }));
        const revisions = Object.fromEntries(rows.map((row: any) => [row.id, row.taskRevision]));
        const before = JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all());
        const request = { requestId: crypto.randomUUID(), suggestions: selected, taskRevisions: revisions };
        expect((await f.call('iosReviewAIApply', { ...request, suggestions: [selected[0], { ...selected[1], action: 'keep' }] })).ok).toBe(false);
        expect(JSON.stringify(f.db.query('SELECT * FROM tasks ORDER BY rowid').all())).toBe(before);
        useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map(task => task.id === selected[0].id ? { ...task, rev: (task.rev ?? 0) + 1, description: 'A newer edit' } : task) });
        expect((await f.call('iosReviewAIApply', request)).ok).toBe(false);
        expect(f.db.query('SELECT status FROM tasks WHERE id=?').get('sibling')).toEqual({ status: 'next' });
        f.refuse(); expect((await f.call('iosReviewAIRequest', {})).ok).toBe(false);
    });
});
