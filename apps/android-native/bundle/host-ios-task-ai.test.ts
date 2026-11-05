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
    let ownerLive = true, credential: string | null = PRIVATE, fetched = 0, failCommit = false;
    let work: () => Promise<Response> = async () => response(provider, clarify);
    Object.assign(globalThis, {
        __mindwtrHostPlatform: platform, __mindwtrSyncSecrets: {}, __cancelHostCalls() {}, __resumeHostCalls() {},
        __mindwtrSecrets: { get: () => { effects.push('secret-store'); throw new Error(PRIVATE); },
            set: () => { effects.push('secret-write'); throw new Error(PRIVATE); }, delete: () => { effects.push('secret-delete'); throw new Error(PRIVATE); } },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push(sql); if (failCommit && /^COMMIT/i.test(sql.trim())) throw new Error('synthetic save failure'); db.exec(sql); return null; },
            sqlRun: (sql: string, raw: string) => { writes.push(sql); if (failCommit && /^COMMIT/i.test(sql.trim())) throw new Error('synthetic save failure'); db.query(sql).run(...JSON.parse(raw)); return null; },
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
    await import(`./host-entry.ts?taskAIFixture=${++sequence}`);
    const host = (globalThis as any).MindwtrHost;
    const poll = async (ticket: string) => {
        for (let i = 0; i < 15000; i++) {
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
        effects.length = 0; writes.length = 0; phases.length = 0;
    };
    const question = (operation: 'clarify' | 'breakdown' = 'clarify') => {
        const task = useTaskStore.getState()._tasksById.get(ID)!;
        return { operation, id: ID, draft: createTaskDraft(task), ...(operation === 'breakdown' ? { checklist: task.checklist } : {}) };
    };
    const saved = () => JSON.parse((db.query('SELECT data FROM settings WHERE id=1').get() as { data: string }).data);
    const held = () => {
        const waiting = deferred(), started = deferred();
        work = async () => { started.release(); await waiting.promise; return response(provider, clarify); };
        return { started: started.promise, release: waiting.release };
    };
    return { host, poll, raw, call, owner, boot, question, phases, writes, effects, saved, held, db, failCommit: (value: boolean) => { failCommit = value; },
        fetched: () => fetched, refuse: () => { ownerLive = false; }, missingCredential: () => { credential = null; },
        reply: (value: unknown) => { work = async () => response(provider, value); },
        modelReply: (value: unknown, status = 200) => { work = async () => new Response(JSON.stringify(value), { status }); },
        fail: () => { work = async () => { throw new Error(`Provider echoed ${PRIVATE} and endpoint-password`); }; } };
}

describe('private iOS manual task AI bridge', () => {
    it('projects only canonical manual-action labels for a legacy task ID, without writes or changing old editor shapes', async () => {
        const f = await fixture(); await f.boot();
        const { operation: _, ...input } = f.question();
        const before = await f.call('editDraft', input), saved = f.saved();
        expect(await f.call('iosTaskAIOptions', input)).toEqual({ ok: true, value: {
            enabled: true, clarify: 'AI clarify', breakdown: 'AI breakdown', working: 'Working...' } });
        expect(await f.call('editDraft', input)).toEqual(before);
        expect(f.saved()).toEqual(saved); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]); expect(f.phases).toEqual([]);
    });

    it.each(['openai', 'gemini', 'anthropic'] as const)('uses only the selected %s credential and returns canonical draft-only Clarify choices', async provider => {
        const f = await fixture(provider); await f.boot();
        useTaskStore.setState({ editLockCount: 1 });
        const before = structuredClone(useTaskStore.getState()._allTasks), settings = f.saved();
        const result = await f.call('iosTaskAIRequest', f.question());
        expect(result).toMatchObject({ ok: true, value: { kind: 'dialog', title: clarify.question,
            choices: [{ label: 'Book travel', apply: { type: 'fields', patch: { title: 'Book conference travel' } } },
                { apply: { type: 'fields', patch: { title: 'Reserve travel', contexts: '@desk, @phone', timeEstimate: '30min' } } },
                { apply: null }] } });
        expect(f.phases.filter(entry => entry.phase === 'credential')).toEqual([{ phase: 'credential', provider }]);
        expect(f.phases[0]).toMatchObject({ phase: 'begin', provider, language: 'en' });
        expect(f.fetched()).toBe(1); expect(f.effects).toEqual([]); expect(f.writes).toEqual([]);
        expect(useTaskStore.getState()._allTasks).toEqual(before); expect(f.saved()).toEqual(settings);
        expect(JSON.stringify(result)).not.toContain(PRIVATE);
    });

    it('returns canonical Breakdown checklist appends and list status edits, without saving', async () => {
        const f = await fixture(); const data = seed('openai');
        Object.assign(data.tasks[0], { taskMode: 'list', status: 'done', completedAt: AT });
        await f.boot(data); f.reply(breakdown);
        const before = structuredClone(useTaskStore.getState()._allTasks);
        const result = await f.call('iosTaskAIRequest', f.question('breakdown'));
        expect(result).toMatchObject({ ok: true, value: { kind: 'dialog', choices: [
            { apply: null }, { apply: { checklist: [{ id: 'kept', title: 'Passport', isCompleted: true },
                { id: expect.any(String), title: 'Book travel', isCompleted: false },
                { id: expect.any(String), title: 'Reserve hotel', isCompleted: false }],
            edit: { type: 'fields', patch: { status: 'next' } } } },
        ] } });
        expect(useTaskStore.getState()._allTasks).toEqual(before); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });

    it('refuses exact-shape/type/boundary violations before credential or HTTP work', async () => {
        const f = await fixture(); await f.boot(); const input = f.question();
        for (const malformed of [
            { ...input, extra: true }, { ...input, operation: 'copilot' }, { ...input, id: '' }, { ...input, id: 'a'.repeat(501) },
            { ...input, draft: { ...input.draft, title: 1 } }, { ...input, checklist: [] },
            { ...input, operation: 'breakdown' }, { ...input, operation: 'breakdown', checklist: [{ id: 'x', title: 'Step', isCompleted: 1 }] },
        ]) expect((await f.call('iosTaskAIRequest', malformed)).ok).toBe(false);
        expect((await f.call('iosTaskAIOptions', input)).ok).toBe(false);
        expect((await f.raw('iosTaskAIRequest', JSON.stringify(input), null)).ok).toBe(false);
        expect((await f.raw('iosTaskAIRequest', '{private malformed')).ok).toBe(false);
        expect((await f.raw('iosTaskAIRequest', ' '.repeat(2_000_001))).ok).toBe(false);
        expect(f.phases).toEqual([]); expect(f.fetched()).toBe(0); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });

    it('refuses non-iOS, unready, transition, read-only and native-refused owners', async () => {
        const unavailable = await fixture();
        expect((await unavailable.call('iosTaskAIRequest', { operation: 'clarify', id: ID, draft: {} })).ok).toBe(false);
        const android = await fixture('openai', 'android'); await android.boot();
        expect((await android.call('iosTaskAIRequest', android.question())).ok).toBe(false);
        const f = await fixture(); await f.boot();
        const transition = acquireWorkspaceTransitionLock();
        expect(transition).not.toBeNull();
        try { expect((await f.call('iosTaskAIRequest', f.question())).ok).toBe(false); } finally { transition?.(); }
        f.refuse(); expect((await f.call('iosTaskAIRequest', f.question())).ok).toBe(false);
        expect(f.fetched()).toBe(0);
        useTaskStore.setState(state => ({ _allProjects: state._allProjects.map(project => project.id === 'p1' ? { ...project, status: 'archived' } : project) }));
        f.phases.length = 0;
        expect((await f.call('iosTaskAIRequest', f.question())).ok).toBe(false); expect(f.phases).toEqual([]);
    });

    it('allows unrelated durable edits while HTTP waits and never lends its host to generic/capture/configuration requests', async () => {
        const f = await fixture(); await f.boot(); const input = f.question();
        const opened = await f.poll(f.host.captureOpen());
        const capture = await f.poll(f.host.captureCopilotOptions(JSON.stringify({ text: 'Plan another trip',
            options: opened.value.options, applied: { tags: [] } }), true));
        const session = '00000000-0000-4000-8000-000000000103';
        expect((await f.poll(f.host.iosAITextConfigurationSessionOpenV2(session, 'openai'))).ok).toBe(true);
        const configuration = await f.call('iosAITextConfigurationOptionsV2', {}, () => '');
        expect(configuration.ok).toBe(true);
        const held = f.held();
        const generation = getPersistenceStatus().generation;
        const ticket = f.host.iosTaskAIRequest(JSON.stringify(input), f.owner); await held.started;
        expect((await f.call('iosTaskAIRequest', input)).ok).toBe(false);
        expect((await f.poll(f.host.aiRequest('requestTaskEditorClarify', JSON.stringify(input)))).ok).toBe(false);
        const captureTicket = f.host.iosCaptureCopilotRequest(JSON.stringify({ revision: capture.value.revision,
            request: capture.value.request }), f.owner);
        expect((await f.call('iosAITextConfigurationSensitiveV2', { session,
            op: 'read-endpoint', expected: configuration.value.expected })).ok).toBe(false);
        await useTaskStore.getState().updateTask('unrelated', { title: 'Changed during HTTP' }); await flushPendingSave();
        expect(getPersistenceStatus().generation).toBeGreaterThan(generation);
        held.release(); expect((await f.poll(ticket)).ok).toBe(true);
        expect((await f.poll(captureTicket)).ok).toBe(false);
        expect(useTaskStore.getState()._tasksById.get('unrelated')?.title).toBe('Changed during HTTP');
        expect(useTaskStore.getState()._tasksById.get(ID)?.title).toBe('Plan conference trip'); expect(f.fetched()).toBe(1);
    });

    it('refuses task-AI entry while a real capture owner is waiting on HTTP', async () => {
        const f = await fixture(); await f.boot();
        const opened = await f.poll(f.host.captureOpen());
        const options = await f.poll(f.host.captureCopilotOptions(JSON.stringify({ text: 'Plan another trip',
            options: opened.value.options, applied: { tags: [] } }), true));
        const held = f.held();
        const ticket = f.host.iosCaptureCopilotRequest(JSON.stringify({ revision: options.value.revision,
            request: options.value.request }), f.owner);
        await held.started;
        expect((await f.call('iosTaskAIRequest', f.question())).ok).toBe(false);
        held.release(); expect((await f.poll(ticket)).ok).toBe(true);
        expect(f.fetched()).toBe(1);
    });

    it.each(['owner', 'task', 'deleted', 'project', 'project-task', 'config', 'estimates', 'language'] as const)('discards a held answer after %s changes', async change => {
        const f = await fixture(); await f.boot(); const held = f.held();
        const ticket = f.host.iosTaskAIRequest(JSON.stringify(f.question()), f.owner); await held.started;
        if (change === 'owner') f.refuse();
        else if (change === 'task' || change === 'deleted' || change === 'project-task')
            useTaskStore.setState(state => ({ _allTasks: state._allTasks.map(task => task.id === (change === 'project-task' ? 'sibling' : ID)
                ? { ...task, ...(change === 'deleted' ? { deletedAt: AT } : { title: 'Changed while held', rev: 3 }) } : task) }));
        else if (change === 'project') useTaskStore.setState(state => ({ _allProjects: state._allProjects.map(project => project.id === 'p1' ? { ...project, title: 'Changed project' } : project) }));
        else if (change === 'estimates') useTaskStore.setState(state => ({ settings: { ...state.settings, features: { ...state.settings.features, timeEstimates: false } } }));
        else if (change === 'config') useTaskStore.setState(state => ({ settings: { ...state.settings, ai: { ...state.settings.ai, model: 'changed-model' } } }));
        else expect((await f.poll(f.host.language('zh', 'zh-CN'))).ok).toBe(true);
        held.release(); const result = await f.poll(ticket);
        expect(result.ok).toBe(false); expect(result.error).toContain('STALE_REVISION'); expect(result).not.toHaveProperty('value');
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });

    it('cancels the actual ticket, retires its owner and permits the next explicit action', async () => {
        const f = await fixture(); await f.boot(); const held = f.held();
        const ticket = f.host.iosTaskAIRequest(JSON.stringify(f.question()), f.owner); await held.started;
        f.host.abort(ticket); held.release(); expect((await f.poll(ticket)).ok).toBe(false);
        f.reply(clarify); expect((await f.call('iosTaskAIRequest', f.question())).ok).toBe(true);
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });

    it('rejects malformed native credential replies without exposing their bytes or starting HTTP', async () => {
        const f = await fixture(); await f.boot();
        for (const malformed of [PRIVATE, JSON.stringify({ value: 1 }), JSON.stringify({ value: PRIVATE, extra: true })]) {
            const result = await f.call('iosTaskAIRequest', f.question(), (json: string) =>
                JSON.parse(json).phase === 'credential' ? malformed : '');
            expect(result).toMatchObject({ ok: true, value: { kind: 'alert' } });
            expect(JSON.stringify(result)).not.toContain(PRIVATE);
        }
        expect(f.fetched()).toBe(0); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });

    it('keeps disabled/missing-key answers canonical and redacts the request-specific credential and endpoint error', async () => {
        const f = await fixture(); await f.boot();
        useTaskStore.setState(state => ({ settings: { ...state.settings, ai: { ...state.settings.ai, enabled: false } } }));
        expect(await f.call('iosTaskAIRequest', f.question())).toMatchObject({ ok: true, value: { kind: 'alert' } });
        expect(f.phases.some(entry => entry.phase === 'credential')).toBe(false); expect(f.fetched()).toBe(0);
        useTaskStore.setState(state => ({ settings: { ...state.settings, ai: { ...state.settings.ai, enabled: true, baseUrl: 'https://api.openai.com/v1' } } }));
        f.missingCredential(); expect(await f.call('iosTaskAIRequest', f.question())).toMatchObject({ ok: true, value: { kind: 'alert' } });
        expect(f.fetched()).toBe(0);
        const errorFixture = await fixture(); const data = seed('openai');
        data.settings.ai!.baseUrl = 'https://fixture:endpoint-password@provider.invalid/v1';
        await errorFixture.boot(data); errorFixture.fail();
        const result = await errorFixture.call('iosTaskAIRequest', errorFixture.question());
        expect(result).toMatchObject({ ok: true, value: { kind: 'alert' } });
        expect(JSON.stringify(result)).not.toContain(PRIVATE); expect(JSON.stringify(result)).not.toContain('endpoint-password');
        expect(errorFixture.writes).toEqual([]); expect(errorFixture.effects).toEqual([]);
    });
    it('projects only canonical first-20 visible context in array order and resolved runtime language', async () => {
        const f = await fixture(), data = seed('openai'), target = data.tasks[0]!;
        const siblings = Array.from({ length: 22 }, (_, index) => ({ ...data.tasks[1]!, id: `context-${index}`,
            title: `Context ${index}`, status: 'next' as const }));
        data.tasks = [target, { ...siblings[0]!, id: 'archived-hidden', status: 'archived' },
            { ...siblings[0]!, id: 'deleted-hidden', deletedAt: AT }, ...siblings.reverse()];
        await f.boot(data);
        const { id, draft } = f.question(), input = { id, draft };
        const before = await f.call('iosTaskAIWitness', input);
        expect(before.ok).toBe(true);
        expect(Object.keys(before.value).sort()).toEqual(['contextTaskIDs', 'language', 'projectContext']);
        expect(before.value.contextTaskIDs).toEqual(siblings.slice(0, 20).map(task => task.id));
        expect(before.value.projectContext.projectTasks).toEqual(siblings.slice(0, 20).map(task => `${task.title} (next)`));
        await useTaskStore.getState().updateTask(siblings[20]!.id, { title: 'Outside bounded context' });
        await flushPendingSave();
        expect((await f.call('iosTaskAIWitness', input)).value).toEqual(before.value);
        expect((await f.poll(f.host.language('de', 'de-DE'))).ok).toBe(true);
        expect((await f.call('iosTaskAIWitness', input)).value.language).toBe('de');
        expect((await f.call('iosTaskAIWitness', { ...input, extra: true })).ok).toBe(false);
        expect(f.effects).toEqual([]); expect(f.fetched()).toBe(0);
    });

});


describe('private iOS Anthropic thinking settings bridge', () => {
    it('projects saved custom state with the unchanged V2 witness and no sensitive effects', async () => {
        const f = await fixture('anthropic'), data = seed('anthropic');
        data.settings.ai!.thinkingBudget = 3072;
        await f.boot(data);
        const setup = await f.call('iosAITextConfigurationOptionsV2', {}, () => '');
        const result = await f.call('iosAIAnthropicThinkingOptions', {}, () => '');
        expect(result).toMatchObject({ ok: true, value: { version: 1, enabled: true, value: 3072, expected: setup.value.expected } });
        expect(Object.keys(result.value).sort()).toEqual(['version', 'enabled', 'value', 'options', 'expected'].sort());
        expect(result.value.options.map((item: { value: number }) => item.value)).toEqual([1024, 2048, 4096]);
        expect(result.value.options.every((item: { label: string }) => typeof item.label === 'string' && item.label.length > 0)).toBe(true);
        expect(Object.keys(setup.value).sort()).toEqual(['version', 'provider', 'providerOptions', 'enabled', 'model', 'copilotModel', 'modelOptions', 'copilotModelOptions', 'expected'].sort());
        expect(JSON.stringify(result)).not.toContain(PRIVATE);
        expect(f.effects).toEqual([]); expect(f.writes).toEqual([]); expect(f.fetched()).toBe(0);
        expect(f.saved().ai.thinkingBudget).toBe(3072);
    });
    it('refuses wrong provider, stale owner, extra fields and ordinary read/write routes', async () => {
        const f = await fixture('openai'); await f.boot();
        expect((await f.call('iosAIAnthropicThinkingOptions', {}, () => '')).ok).toBe(false);
        expect((await f.call('iosAIAnthropicThinkingOptions', {}, () => 'stale')).ok).toBe(false);
        expect((await f.call('iosAIAnthropicThinkingOptions', { value: 1024 }, () => '')).ok).toBe(false);
        expect((await f.poll(f.host.menuRead('iosAIAnthropicThinkingOptions', '{}'))).ok).toBe(false);
        expect((await f.poll(f.host.menuCommand('iosAIAnthropicThinkingOptions', '{}'))).ok).toBe(false);
        expect(f.effects).toEqual([]); expect(f.writes).toEqual([]); expect(f.fetched()).toBe(0);
    });
    it('uses the existing prepared V2 writer for thinking without consent or provider requests', async () => {
        const f = await fixture('anthropic'); await f.boot();
        const options = (await f.call('iosAIAnthropicThinkingOptions', {}, () => '')).value;
        const request = { version: 2, requestId: '77bd7591-38b0-4904-842e-6f10b2cac329', expected: options.expected,
            change: { type: 'anthropicThinking', value: true }, consent: false };
        expect(await f.call('iosAITextConfigurationConsentTargetV2', request, () => '')).toEqual({ ok: true, value: { provider: null } });
        const prepared = await f.poll(f.host.iosAITextConfigurationPrepareV2(JSON.stringify(request), () => '', null));
        expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const committed = await f.call('iosAITextConfigurationCommitV2', { request, prepared: prepared.value.prepared }, () => '');
        expect(committed).toEqual({ ok: true, value: { change: request.change, changed: true } });
        expect(f.saved().ai.thinkingBudget).toBe(1024);
        expect((await f.call('iosAIAnthropicThinkingOptions', {}, () => '')).value).toMatchObject({ enabled: true, value: 1024 });
        expect(await f.call('iosAITextConfigurationRetryOutcomeV2', request, () => '')).toEqual(committed);
        expect(f.effects).toEqual([]); expect(f.fetched()).toBe(0);
    });
});


describe('private iOS OpenAI extra-body editor', () => {
    const session = '00000000-0000-4000-8000-000000000501';
    const attemptA = '00000000-0000-4000-8000-000000000502', attemptB = '00000000-0000-4000-8000-000000000503';
    const setup = async (provider: 'openai' | 'gemini' = 'openai', body?: Record<string, unknown>) => {
        const f = await fixture(provider), data = seed(provider);
        if (body) data.settings.ai!.openAIExtraBodyParams = body;
        await f.boot(data);
        expect((await f.poll(f.host.iosAITextConfigurationSessionOpenV2(session, provider))).ok).toBe(true);
        const options = await f.call('iosAITextConfigurationOptionsV2', {}, () => '');
        expect(options.ok).toBe(true);
        const read = { session, op: 'read-extra-body', expected: options.value.expected };
        const save = (value: string, attempt = attemptA) => ({ ...read, op: 'save-extra-body', value, attempt });
        return { ...f, read, save };
    };
    it('reads privately and saves only on explicit request, with no secrets, HTTP or durable sensitive receipt', async () => {
        const f = await setup('openai', { nested: { privateValue: 'PRIVATE-EXTRA-BODY' } });
        const before = f.saved(), tasks = structuredClone(useTaskStore.getState()._allTasks);
        const result = await f.call('iosAITextConfigurationSensitiveV2', f.read);
        expect(result).toEqual({ ok: true, value: { value: JSON.stringify(before.ai.openAIExtraBodyParams, null, 2) } });
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
        expect(await f.call('iosAITextConfigurationSensitiveV2', f.save('{"temperature":0.4}'))).toEqual({ ok: true, value: { changed: true } });
        expect(f.saved().ai).toEqual({ ...before.ai, openAIExtraBodyParams: { temperature: 0.4 } });
        expect(useTaskStore.getState()._allTasks).toEqual(tasks); expect(f.fetched()).toBe(0);
        expect(f.effects).toEqual([]);
        expect(f.db.query('SELECT * FROM native_request_receipts').all()).toEqual([]);
        expect(f.phases.some(p => p.phase === 'extra-body-save')).toBe(true);
    });
    it('rejects malformed, nonobject and expanding input before accepting a save; V1 stays closed', async () => {
        const f = await setup(), before = f.saved();
        for (const text of ['{PRIVATE-INVALID', '[]', 'null', '1', '"x"', ' '.repeat(4001), '{"x":'.repeat(100) + '{}' + '}'.repeat(100)]) {
            const result = await f.call('iosAITextConfigurationSensitiveV2', f.save(text));
            expect(result.ok).toBe(false); expect(result.error).toContain('INVALID_INPUT');
            expect(JSON.stringify(result)).not.toContain('PRIVATE-INVALID');
        }
        expect((await f.call('iosAITextConfigurationSensitive', f.read)).ok).toBe(false);
        expect((await f.call('iosAITextConfigurationSensitiveV2', { ...f.read, extra: true })).ok).toBe(false);
        expect(f.saved()).toEqual(before); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
        expect(f.phases.some(p => p.phase === 'extra-body-save')).toBe(false);
    });
    it('answers exact saved A after later B without overwriting B; rejects changed attempt bytes and another session', async () => {
        const f = await setup(), a = f.save('{"privateValue":"A"}'), b = f.save('{"privateValue":"B"}', attemptB);
        expect((await f.call('iosAITextConfigurationSensitiveV2', a)).ok).toBe(true);
        expect((await f.call('iosAITextConfigurationSensitiveV2', b)).ok).toBe(true);
        const later = f.saved(); f.writes.length = 0;
        expect(await f.call('iosAITextConfigurationSensitiveV2', a)).toEqual({ ok: true, value: { changed: true } });
        expect(f.saved()).toEqual(later); expect(f.writes).toEqual([]);
        expect((await f.call('iosAITextConfigurationSensitiveV2', { ...a, value: '{ "privateValue":"A"}' })).ok).toBe(false);
        expect((await f.call('iosAITextConfigurationSensitiveV2', { ...a, expected: {} })).ok).toBe(false);
        await f.poll(f.host.iosAITextConfigurationSessionClose(session));
        await f.poll(f.host.iosAITextConfigurationSessionOpenV2(session, 'openai'));
        expect((await f.call('iosAITextConfigurationSensitiveV2', a)).ok).toBe(false);
        expect(f.saved()).toEqual(later);
    });
    it('recovers a reply lost after confirmed save from the same process receipt', async () => {
        const f = await setup(), input = f.save('{"privateValue":"saved"}');
        let accepted = false;
        const lostOwner = (json: string) => {
            if (JSON.parse(json).phase === 'extra-body-save') { accepted = true; return ''; }
            return accepted ? 'reply owner temporarily unavailable' : '';
        };
        expect((await f.call('iosAITextConfigurationSensitiveV2', input, lostOwner)).ok).toBe(false);
        expect(f.saved().ai.openAIExtraBodyParams).toEqual({ privateValue: 'saved' }); f.writes.length = 0;
        expect(await f.call('iosAITextConfigurationSensitiveV2', input)).toEqual({ ok: true, value: { changed: true } });
        expect(f.writes).toEqual([]);
    });
    it('retains only the exact failed-save snapshot, then permits explicit retry and blank clear', async () => {
        const f = await setup(), input = f.save('{"privateValue":"pending"}'); f.failCommit(true);
        expect((await f.call('iosAITextConfigurationSensitiveV2', input)).ok).toBe(false);
        expect(f.saved().ai.openAIExtraBodyParams).toBeUndefined();
        expect((await f.call('iosAITextConfigurationSensitiveV2', { ...input, value: '{"privateValue":"changed"}' })).ok).toBe(false);
        f.failCommit(false);
        expect(await f.call('iosAITextConfigurationSensitiveV2', input)).toEqual({ ok: true, value: { changed: true } });
        expect(f.saved().ai.openAIExtraBodyParams).toEqual({ privateValue: 'pending' });
        expect((await f.call('iosAITextConfigurationSensitiveV2', f.save('{}', attemptB))).ok).toBe(true);
        expect(f.saved().ai.openAIExtraBodyParams).toBeUndefined();
    }, 30000);
    it('refuses other providers, stale private settings, retired and native-refused owners without writes', async () => {
        const other = await setup('gemini');
        expect((await other.call('iosAITextConfigurationSensitiveV2', other.read)).ok).toBe(false);
        const f = await setup();
        useTaskStore.setState(state => ({ settings: { ...state.settings, ai: { ...state.settings.ai, openAIExtraBodyParams: { changed: true } } } }));
        expect((await f.call('iosAITextConfigurationSensitiveV2', f.save('{}'))).ok).toBe(false);
        expect(f.writes).toEqual([]);
        await f.poll(f.host.iosAITextConfigurationSessionOpenV2(session, 'openai')); f.refuse();
        expect((await f.call('iosAITextConfigurationSensitiveV2', f.read)).ok).toBe(false);
        expect(f.writes).toEqual([]); expect(f.fetched()).toBe(0);
    });
});


describe('private iOS selected assistant model discovery', () => {
    const session = '00000000-0000-4000-8000-000000000601';
    const setup = async (provider: 'openai' | 'gemini' | 'anthropic' = 'openai', enabled = true, consent = false, credential: string | null = PRIVATE) => {
        const f = await fixture(provider), data = seed(provider);
        data.settings.ai!.enabled = enabled;
        data.settings.ai!.model = 'my-custom-model'; data.settings.ai!.copilotModel = 'my-custom-copilot';
        await f.boot(data);
        expect((await f.poll(f.host.iosAITextConfigurationSessionOpenV2(session, provider))).ok).toBe(true);
        const options = await f.call('iosAITextConfigurationOptionsV2', {}, () => '');
        const request = { session, expected: options.value.expected };
        const owner = (json: string) => {
            const value = f.owner(json); if (value === 'refused') return value;
            const p = JSON.parse(json);
            return p.phase === 'metadata' ? JSON.stringify({ consent })
                : p.phase === 'credential' ? JSON.stringify({ value: credential }) : value;
        };
        return { ...f, request, discoveryOwner: owner, options: options.value };
    };
    it.each(['openai', 'gemini', 'anthropic'] as const)('uses shared %s discovery and selected credential without settings writes', async provider => {
        const f = await setup(provider), before = f.saved(), tasks = structuredClone(useTaskStore.getState()._allTasks);
        f.modelReply(provider === 'gemini' ? { models: [{ name: 'models/gemini-new', supportedGenerationMethods: ['generateContent'] }] }
            : { data: [{ id: provider === 'openai' ? 'gpt-new' : 'claude-new' }] });
        const result = await f.call('iosAITextModelDiscovery', f.request, f.discoveryOwner);
        expect(result.ok).toBe(true); expect(result.value.status).toBe('loaded');
        expect(Object.keys(result.value).sort()).toEqual(['version', 'provider', 'status', 'modelOptions', 'copilotModelOptions', 'expected'].sort());
        expect(result.value.provider).toBe(provider); expect(result.value.expected).toEqual(f.request.expected);
        expect(result.value.modelOptions).toEqual(['my-custom-model', provider === 'openai' ? 'gpt-new' : provider === 'gemini' ? 'gemini-new' : 'claude-new']);
        expect(result.value.copilotModelOptions[0]).toBe('my-custom-copilot');
        expect(f.phases.filter(x => x.phase === 'credential')).toEqual([{ phase: 'credential', provider }]);
        expect(f.fetched()).toBe(1); expect(f.saved()).toEqual(before); expect(useTaskStore.getState()._allTasks).toEqual(tasks);
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]); expect(JSON.stringify(result)).not.toContain(PRIVATE);
    });
    it('checks consent before secret reads and allows consented keyless custom OpenAI', async () => {
        const denied = await setup('openai', false, false);
        expect((await denied.call('iosAITextModelDiscovery', denied.request, denied.discoveryOwner)).value.status).toBe('unavailable');
        expect(denied.phases.some(x => x.phase === 'credential')).toBe(false); expect(denied.fetched()).toBe(0);
        const f = await setup('openai', false, true, null); f.modelReply({ data: [{ id: 'self-hosted-model' }] });
        expect((await f.call('iosAITextModelDiscovery', f.request, f.discoveryOwner)).value.status).toBe('loaded');
        expect(f.fetched()).toBe(1); expect(f.saved().ai.enabled).toBe(false); expect(f.effects).toEqual([]);
    });
    it('keeps bounded static and custom choices on provider failure or overlarge live lists', async () => {
        const f = await setup();
        for (const reply of [{ malformed: true }, { data: [] }, { data: Array.from({ length: 101 }, (_, i) => ({ id: 'model-' + i })) }, { data: [{ id: 'x'.repeat(2001) }] }]) {
            f.modelReply(reply);
            const result = await f.call('iosAITextModelDiscovery', f.request, f.discoveryOwner);
            expect(result).toMatchObject({ ok: true, value: { status: 'fallback', modelOptions: f.options.modelOptions, copilotModelOptions: f.options.copilotModelOptions } });
        }
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });
    it.each(['owner', 'settings', 'session', 'abort'] as const)('discards held discovery after %s changes', async change => {
        const f = await setup(), held = f.held();
        const ticket = f.host.iosAITextModelDiscovery(JSON.stringify(f.request), f.discoveryOwner); await held.started;
        expect((await f.call('iosAITextModelDiscovery', f.request, f.discoveryOwner)).ok).toBe(false);
        if (change === 'owner') f.refuse();
        else if (change === 'settings') useTaskStore.setState(state => ({ settings: { ...state.settings, ai: { ...state.settings.ai, baseUrl: 'https://changed.invalid/v1' } } }));
        else if (change === 'session') {
            await f.poll(f.host.iosAITextConfigurationSessionClose(session));
            await f.poll(f.host.iosAITextConfigurationSessionOpenV2('00000000-0000-4000-8000-000000000602', 'openai'));
        } else f.host.abort(ticket);
        held.release(); expect((await f.poll(ticket)).ok).toBe(false);
        if (change === 'session') expect((await f.poll(f.host.iosAITextConfigurationSessionCheck('00000000-0000-4000-8000-000000000602'))).ok).toBe(true);
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });
    it('refuses malformed private requests and metadata without leaking callback text', async () => {
        const f = await setup();
        for (const request of [{ ...f.request, extra: true }, { ...f.request, expected: {} }, { ...f.request, session: 'foreign' }])
            expect((await f.call('iosAITextModelDiscovery', request, f.discoveryOwner)).ok).toBe(false);
        await f.poll(f.host.iosAITextConfigurationSessionOpenV2(session, 'openai'));
        const result = await f.call('iosAITextModelDiscovery', f.request, (json: string) => JSON.parse(json).phase === 'metadata' ? PRIVATE : '');
        expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(PRIVATE);
        expect(f.fetched()).toBe(0); expect(f.writes).toEqual([]);
    });
});
