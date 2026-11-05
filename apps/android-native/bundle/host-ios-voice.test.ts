import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { useTaskStore, getStorageAdapter, flushPendingSave, resetForTests, setStorageAdapter } from '../../../packages/core/src/store';
import { resetNativeRequestReceipts } from '../../../packages/core/src/native-request-receipts';
import { acquireWorkspaceTransitionLock } from '../../../packages/core/src/sandbox';
import { createQuickCaptureOptions } from '../../../packages/core/src/quick-capture-model';

const ID = '12345678-1234-4234-8234-123456789abc', NEXT = '12345678-1234-4234-8234-123456789abd';
const AT = '2026-10-29T12:00:00.000Z';
const PRIVATE = 'PRIVATE-VOICE-CONTENT';
let sequence = 0;
const opened = new Set<Database>();
const snapshots = new Map<string, PropertyDescriptor | undefined>();
const names = ['MindwtrHost', '__mindwtrHostPlatform', '__mindwtrNative', '__mindwtrSecrets', '__mindwtrSyncSecrets',
    '__cancelHostCalls', '__resumeHostCalls', 'fetch'];
const remember = () => { for (const name of names) if (!snapshots.has(name)) snapshots.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); };
afterEach(async () => {
    await flushPendingSave().catch(() => undefined); resetForTests(); resetNativeRequestReceipts();
    for (const database of opened) database.close(); opened.clear();
    for (const [name, descriptor] of snapshots) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
    snapshots.clear();
});
const seed = () => ({ tasks: [{ id: 'raw', title: PRIVATE, status: 'inbox', contexts: [], tags: [], createdAt: AT, updatedAt: AT }],
    projects: [], sections: [], areas: [], people: [], settings: { deviceId: 'fixture-device', diagnostics: { loggingEnabled: true },
        ai: { provider: 'anthropic', enabled: false, model: PRIVATE, baseUrl: PRIVATE,
            speechToText: { enabled: true, provider: 'gemini', offlineModelPath: PRIVATE, baseUrl: PRIVATE } } } });

async function fixture(platform = 'ios', database = new Database(':memory:')) {
    remember(); opened.add(database); resetForTests(); resetNativeRequestReceipts();
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [], settings: {},
        lastDataChangeAt: 0, persistenceFailure: null, error: null, isLoading: false, editLockCount: 0 });
    const effects: unknown[] = [], writes: string[] = [], kv = new Map<string, string>();
    let log = '', logFailure = false, onLogAppend: (() => void) | null = null;
    const native = {
        sqlExec: (sql: string) => { writes.push(sql); database.exec(sql); return null; },
        sqlRun: (sql: string, raw: string) => { writes.push(sql); database.query(sql).run(...JSON.parse(raw)); return null; },
        sqlAll: (sql: string, raw: string) => JSON.stringify(database.query(sql).all(...JSON.parse(raw))),
        nowMs: () => Date.parse(AT), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)), log() {},
        rnStateCommit: () => { effects.push('rnStateCommit'); return null; },
        kvGet: (name: string) => JSON.stringify([kv.get(name) ?? null]),
        kvMultiGet: (raw: string) => JSON.stringify(JSON.parse(raw).map((name: string) => [name, kv.get(name) ?? null])),
        kvSet: (name: string, value: string) => { effects.push(['set', name, value]); kv.set(name, value); return null; },
        kvRemove: (name: string) => { effects.push(['remove', name]); kv.delete(name); return null; },
        fileList: () => 'null', fileRead: () => { effects.push('fileRead'); throw new Error('Unexpected private file read'); },
        fileDelete: () => { effects.push('fileDelete'); return null; },
        logFile: (op: string, text: string) => {
            if (logFailure) throw new Error(PRIVATE);
            if (op === 'path' || op === 'ensure') return 'files/logs/mindwtr.log';
            if (op === 'size') return String(log.length); if (op === 'read') return log;
            if (op === 'exists') return log ? '1' : ''; if (op === 'isAbsent') return log ? '' : '1';
            if (op === 'append') { log += text; onLogAppend?.(); return ''; } if (op === 'write') { log = text; return ''; }
            if (op === 'delete') { log = ''; return '1'; } throw new Error('Unexpected diagnostic operation');
        },
    };
    Object.assign(globalThis, { __mindwtrHostPlatform: platform, __mindwtrNative: native,
        __mindwtrSecrets: { get: () => { effects.push('secret-get'); throw new Error(PRIVATE); }, set: () => { effects.push('secret-set'); throw new Error(PRIVATE); } },
        __mindwtrSyncSecrets: {}, __cancelHostCalls() {}, __resumeHostCalls() {},
        fetch: () => { effects.push('http'); throw new Error(PRIVATE); } });
    await import(`./host-entry.ts?voiceFixture=${++sequence}`);
    const host = (globalThis as any).MindwtrHost;
    const poll = async (ticket: string) => {
        for (let i = 0; i < 10000; i++) {
            const raw = host.poll(ticket); if (raw !== null) return JSON.parse(raw);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        throw new Error('Voice bridge did not settle');
    };
    const call = (name: string, input: unknown = {}, owner: unknown = () => '') => poll(host[name](JSON.stringify(input), owner));
    const boot = async (data: ReturnType<typeof seed> | null = seed(), recovery = false) => {
        expect(await poll(host[recovery ? 'bootRecovery' : 'boot']('', ''))).toMatchObject({ ok: true });
        if (data) {
            await flushPendingSave(); const adapter = getStorageAdapter(); await adapter.saveData(data as never);
            const saved = await adapter.getData();
            useTaskStore.setState({ _allTasks: saved.tasks, _allProjects: saved.projects, _allSections: saved.sections,
                _allAreas: saved.areas, _allPeople: saved.people, settings: saved.settings });
            adapter.acknowledgeDataLoad?.(saved);
        }
        effects.length = 0; writes.length = 0; log = '';
    };
    return { host, database, effects, writes, call, poll, boot, log: () => log,
        raw: (method: string, raw: string, owner: unknown = () => '') => poll(host[method](raw, owner)),
        failLog: () => { logFailure = true; }, onLogAppend: (callback: () => void) => { onLogAppend = callback; }, saved: () => JSON.parse((database.query('SELECT data FROM settings WHERE id=1').get() as any).data) };
}
const captureRequest = () => ({ version: 1, requestId: ID, text: '', options: createQuickCaptureOptions({ projects: [], defaultAreaId: null }),
    recordedAt: AT, attachment: null, openAfterSave: false, applied: null });
const configuredRequest = () => ({ config: { model: 'gemini-3.6-flash', language: 'en', mode: 'smart_parse', fieldStrategy: 'smart', now: AT, timeZone: 'UTC' },
    audioBase64: 'TWE=', mimeType: 'audio/mp4' });
const prepared = async (f: Awaited<ReturnType<typeof fixture>>, prefix: string, request: unknown) => {
    const value = await f.call(prefix + 'Prepare', request); expect(value).toMatchObject({ ok: true, value: { kind: 'prepared' } });
    return { request, prepared: value.value.prepared };
};

describe('actual private iOS voice bridge', () => {
    it('reads only new metadata shapes and keeps existing assistant/settings untouched', async () => {
        const f = await fixture(); await f.boot(); const before = f.saved();
        const options = await f.call('iosVoiceSettingsOptions'), runtime = await f.call('iosVoiceRuntimeOptions');
        expect(options).toMatchObject({ ok: true, value: { provider: 'gemini', supported: true, enabled: true } });
        expect(runtime).toMatchObject({ ok: true, value: { saveAudioAttachments: true } });
        expect(Object.keys(options.value).sort()).toEqual(['version', 'provider', 'supported', 'enabled', 'model', 'modelOptions', 'language', 'mode', 'fieldStrategy', 'expected'].sort());
        expect(JSON.stringify([options, runtime])).not.toContain(PRIVATE); expect(f.saved()).toEqual(before);
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]); expect(f.log()).toBe('');
        expect((await f.poll(f.host.menuCommand('iosVoiceSettingsOptions', '{}'))).ok).toBe(false);
    });

    it('prepares, validates and durably commits settings/audio/late results with explicit private ownership and no HTTP', async () => {
        const f = await fixture(); await f.boot();
        const options = await f.call('iosVoiceSettingsOptions');
        const setting = await prepared(f, 'iosVoiceSettings', { version: 1, requestId: NEXT, expected: options.value.expected, change: { type: 'language', value: 'en' } });
        expect(await f.call('iosVoiceSettingsValidate', setting)).toEqual({ ok: true, value: { changed: true } });
        expect(await f.call('iosVoiceSettingsCommit', setting)).toEqual({ ok: true, value: { changed: true } });
        expect(await f.call('iosVoiceSettingsRetryOutcome', setting.request)).toEqual({ ok: true, value: { changed: true } });
        expect(await f.call('iosVoiceSettingsRecover', setting)).toEqual({ ok: true, value: { kind: 'saved', result: { changed: true } } });
        const audio = await prepared(f, 'iosVoiceCapture', captureRequest());
        expect((await f.call('iosVoiceCaptureValidate', audio)).ok).toBe(true);
        expect(await f.call('iosVoiceCaptureCommit', audio)).toMatchObject({ ok: true, value: { kind: 'saved', taskId: ID } });
        expect((await f.call('iosVoiceCaptureRetryOutcome', audio.request)).ok).toBe(true);
        const speech = await prepared(f, 'iosVoiceResult', { version: 1, requestId: '12345678-1234-4234-8234-123456789abe', capture: audio.request,
            result: { transcript: 'Buy milk', title: 'Buy milk', tags: ['errand'] }, at: AT });
        expect((await f.call('iosVoiceResultValidate', speech)).ok).toBe(true);
        expect(await f.call('iosVoiceResultCommit', speech)).toEqual({ ok: true, value: { taskId: ID, outcome: 'applied' } });
        expect(await f.call('iosVoiceResultRetryOutcome', speech.request)).toEqual({ ok: true, value: { taskId: ID, outcome: 'applied' } });
        expect(useTaskStore.getState().tasks.find(task => task.id === ID)).toMatchObject({ title: 'Buy milk', tags: ['#errand'] });
        expect(f.effects).toEqual([]); expect(f.log()).toBe(''); expect(f.saved().ai.provider).toBe('anthropic');
    });

    it('loads voice receipts for cold recovery and distinguishes initial authorization from saved proof', async () => {
        const f = await fixture(); await f.boot(); const audio = await prepared(f, 'iosVoiceCapture', captureRequest());
        const fresh = await fixture('ios', f.database); await fresh.boot(null, true);
        expect((await fresh.call('iosVoiceCaptureCommit', audio)).ok).toBe(false);
        expect(await fresh.call('iosVoiceCaptureRecover', audio)).toEqual({ ok: true, value: { kind: 'authorized' } });
        expect((await fresh.call('iosVoiceCaptureCommit', audio)).ok).toBe(true);
        const cold = await fixture('ios', f.database); await cold.boot(null, true);
        expect((await cold.call('iosVoiceCaptureRetryOutcome', audio.request)).ok).toBe(true);
        expect(await cold.call('iosVoiceCaptureRecover', audio)).toMatchObject({ ok: true, value: { kind: 'saved', result: { taskId: ID } } });
        expect(cold.effects).toEqual([]);
    });

    it('builds/decode Gemini data through pure shared helpers without credential/body persistence or network', async () => {
        const f = await fixture(); await f.boot(); const before = f.saved();
        const request = await f.call('iosVoiceGeminiRequestBuild', configuredRequest());
        expect(request).toMatchObject({ ok: true, value: { method: 'POST', headers: [['Content-Type', 'application/json']], timeoutMs: 30000 } });
        expect(request.value.url).toContain('generativelanguage.googleapis.com'); expect(request.value.body).toContain('TWE=');
        const wav = await f.call('iosVoiceGeminiRequestBuild', { ...configuredRequest(), mimeType: 'audio/wav' });
        expect(wav.ok).toBe(true); expect(JSON.parse(wav.value.body).contents[0].parts).toContainEqual({ inline_data: { mime_type: 'audio/wav', data: 'TWE=' } });
        expect((await f.call('iosVoiceGeminiRequestBuild', { ...configuredRequest(), mimeType: 'audio/unknown' })).ok).toBe(false);
        const decoded = await f.call('iosVoiceGeminiResponseDecode', { candidates: [{ content: { parts: [{ text: '{"transcript":"PRIVATE-VOICE-CONTENT"}' }] } }] });
        expect(decoded).toMatchObject({ ok: true, value: { transcript: PRIVATE } });
        for (const bad of [{ ...configuredRequest(), apiKey: PRIVATE }, { ...configuredRequest(), config: { ...configuredRequest().config, endpoint: PRIVATE } },
            { ...configuredRequest(), config: { ...configuredRequest().config, now: 'bad' } }, { ...configuredRequest(), audioBase64: 'TR==' }]) {
            const result = await f.call('iosVoiceGeminiRequestBuild', bad); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(PRIVATE);
        }
        expect((await f.raw('iosVoiceGeminiResponseDecode', '{"candidates":"' + PRIVATE)).ok).toBe(false);
        expect(f.saved()).toEqual(before); expect(f.effects).toEqual([]); expect(f.writes).toEqual([]); expect(f.log()).toBe('');
    });

    it('refuses no owner, changed adapter, stale owner, abort and byte overflow before writes', async () => {
        const f = await fixture();
        expect((await f.call('iosVoiceRuntimeOptions')).ok).toBe(false); await f.boot();
        for (const owner of [null, () => 'retired', () => '!MindwtrNativeError:' + PRIVATE]) {
            const result = await f.call('iosVoiceSettingsOptions', {}, owner); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(PRIVATE);
        }
        expect((await f.raw('iosVoiceSettingsOptions', ' '.repeat(255) + '{}')).ok).toBe(false);
        expect((await f.raw('iosVoiceSettingsOptions', JSON.stringify({ extra: 'é'.repeat(121) }))).ok).toBe(false);
        const ticket = f.host.iosVoiceSettingsOptions('{}', () => ''); f.host.cancel(ticket);
        expect((await f.poll(ticket)).ok).toBe(false);
        setStorageAdapter({} as never);
        expect((await f.call('iosVoiceSettingsOptions')).ok).toBe(false); expect(f.effects).toEqual([]); expect(f.writes).toEqual([]);
    });

    it('rejects the wrong platform before invoking owner callbacks', async () => {
        const f = await fixture('android'); let owners = 0;
        expect((await f.call('iosVoiceGeminiRequestBuild', configuredRequest(), () => { owners++; return ''; })).ok).toBe(false);
        expect((await f.call('iosVoiceSettingsValidate', {}, () => { owners++; return ''; })).ok).toBe(false);
        expect(owners).toBe(0); expect(f.effects).toEqual([]);
    });

    it('emits only fixed native acknowledgment fields and never logs a preparation as saved', async () => {
        const f = await fixture(); await f.boot();
        expect((await f.poll(f.host.iosVoiceAcknowledged('capture', 'source-ready', () => ''))).ok).toBe(false); expect(f.log()).toBe('');
        expect(await f.poll(f.host.iosVoiceAcknowledged('capture', 'saved', () => ''))).toEqual({ ok: true, value: null });
        const lines = f.log().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(lines.map(line => ({ message: line.message, context: line.context }))).toEqual([{ message: 'Native iOS voice operation completed',
            context: { releaseCheck: 'v1.3.9/ios-native-voice', provider: 'gemini', stage: 'capture', outcome: 'saved' } }]);
        expect(f.log()).not.toContain(PRIVATE); expect(f.log()).not.toContain(ID);
        f.failLog(); expect(await f.poll(f.host.iosVoiceAcknowledged('speech', 'applied', () => ''))).toEqual({ ok: true, value: null });
    });

    it('withholds an acknowledgment if its owner retires while awaited diagnostics append', async () => {
        const f = await fixture(); await f.boot(); let live = true;
        f.onLogAppend(() => { live = false; });
        const ticket = f.host.iosVoiceAcknowledged('capture', 'saved', () => live ? '' : 'retired');
        expect((await f.poll(ticket)).ok).toBe(false);
        expect(f.log()).toContain('Native iOS voice operation completed');
    });

    it('withholds an acknowledgment aborted while awaited diagnostics append', async () => {
        const f = await fixture(); await f.boot(); let ticket = '';
        f.onLogAppend(() => { f.host.abort(ticket); });
        ticket = f.host.iosVoiceAcknowledged('speech', 'applied', () => '');
        expect((await f.poll(ticket)).ok).toBe(false);
        expect(f.log()).toContain('Native iOS voice operation completed');
    });

    it('preserves accepted copilot metadata through private voice preparation and durable save', async () => {
        const f = await fixture(); await f.boot();
        const request = { ...captureRequest(), applied: { tags: ['#accepted'], context: '@accepted', timeEstimate: '30min' } };
        const audio = await prepared(f, 'iosVoiceCapture', request);
        expect(audio.prepared.capture.version).toBe(2);
        expect(await f.call('iosVoiceCaptureCommit', audio)).toMatchObject({ ok: true, value: { generated: false,
            taskAtSave: { tags: ['#accepted'], contexts: ['@accepted'], timeEstimate: '30min' } } });
        expect(f.effects).toEqual([]);
    });

    it('refuses workspace-transition admission before private effects', async () => {
        const f = await fixture(); await f.boot(); const release = acquireWorkspaceTransitionLock();
        expect((await f.call('iosVoiceRuntimeOptions')).ok).toBe(false); release?.();
        expect(f.effects).toEqual([]); expect(f.writes).toEqual([]);
    });
});


describe('private Watch OpenAI speech bridge', () => {
    it('projects configured custom speech without changing old recorder read keys or visiting secrets', async () => {
        const f = await fixture(); const selected = seed();
        selected.settings.ai.speechToText = { ...selected.settings.ai.speechToText, provider: 'openai',
            baseUrl: 'http://127.0.0.1:8080/v1' };
        await f.boot(selected);
        const old = await f.call('iosVoiceRuntimeOptions');
        expect(old).toMatchObject({ ok: true, value: { provider: 'openai', supported: true } });
        const runtime = await f.poll(f.host.iosWatchOpenAIRuntime());
        expect(runtime).toMatchObject({ ok: true, value: { provider: 'openai', enabled: true,
            endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions', credentialRequired: false } });
        expect(Object.keys(runtime.value).sort()).toEqual(['version','provider','enabled','model','language','mode',
            'fieldStrategy','endpoint','credentialRequired','parseModel','retryModel'].sort());
        expect(JSON.stringify(runtime)).not.toContain(PRIVATE);
        expect((await f.poll(f.host.iosWatchOpenAIRuntime('{}'))).ok).toBe(false);
        expect(f.effects).toEqual([]); expect(f.writes).toEqual([]); expect(f.log()).toBe('');
    });
    it('builds credential-free multipart fields and both parse APIs using shared policy', async () => {
        const f = await fixture(); await f.boot();
        const built = await f.call('iosVoiceOpenAITranscriptionBuild', { model: 'gpt-transcribe-2', language: 'en',
            endpoint: 'https://speech.example.org/v1/audio/transcriptions' });
        expect(built).toMatchObject({ ok: true, value: { url: 'https://speech.example.org/v1/audio/transcriptions',
            fields: [['model','gpt-transcribe-2'],['languages[]','en'],['response_format','json']], timeoutMs: 30000 } });
        expect(await f.call('iosVoiceOpenAITranscriptionDecode', { text: '  Spoken task  ' }))
            .toEqual({ ok: true, value: { transcript: 'Spoken task' } });
        for (const api of ['responses','chat']) {
            const built = await f.call('iosVoiceOpenAIParseBuild', { api, model: 'gpt-4o-mini', transcript: 'Spoken task',
                config: { language: 'en', fieldStrategy: 'smart', now: AT, timeZone: 'UTC' } });
            expect(built).toMatchObject({ ok: true, value: { method: 'POST', headers: [['Content-Type','application/json']], timeoutMs: 30000 } });
            const response = api === 'responses' ? { output_text: '{"transcript":"Final spoken task","title":"Parsed"}' }
                : { choices: [{ message: { content: '{"transcript":"Final spoken task","title":"Parsed"}' } }] };
            expect(await f.call('iosVoiceOpenAIParseDecode', { api, response }))
                .toMatchObject({ ok: true, value: { transcript: 'Final spoken task', title: 'Parsed' } });
        }
        expect(f.effects).toEqual([]); expect(f.writes).toEqual([]); expect(f.log()).toBe('');
    });
    it('refuses absent owner, unexpected secret fields and malformed provider replies without leaking content', async () => {
        const f = await fixture(); await f.boot();
        const input = { model: 'whisper-1', language: 'auto', endpoint: 'https://api.openai.com/v1/audio/transcriptions' };
        expect((await f.call('iosVoiceOpenAITranscriptionBuild', input, null)).ok).toBe(false);
        for (const bad of [{ ...input, apiKey: PRIVATE }, { ...input, model: 'bad\r\nheader' }]) {
            const result = await f.call('iosVoiceOpenAITranscriptionBuild', bad);
            expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(PRIVATE);
        }
        const result = await f.call('iosVoiceOpenAIParseDecode', { api: 'responses', response: { output_text: PRIVATE } });
        expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(PRIVATE);
        expect(f.effects).toEqual([]); expect(f.writes).toEqual([]);
    });
});


describe('private phone OpenAI endpoint settings', () => {
    const setup = async () => {
        const f = await fixture(); const data = seed();
        data.settings.ai.speechToText.provider = 'openai';
        await f.boot(data);
        const options = await f.call('iosVoiceSettingsOptions');
        expect(await f.poll(f.host.iosVoiceEndpointSessionOpen(ID))).toEqual({ ok: true, value: null });
        return { f, expected: options.value.expected };
    };
    it('keeps the speech endpoint separate from assistant settings and journals', async () => {
        const { f, expected } = await setup();
        expect(await f.call('iosVoiceEndpointSensitive', { session: ID, op: 'read-endpoint', expected }))
            .toEqual({ ok: true, value: { value: PRIVATE } });
        const value = 'https://speech.example.invalid/v1?private-endpoint-marker';
        expect(await f.call('iosVoiceEndpointSensitive', { session: ID, op: 'save-endpoint', expected, value }))
            .toEqual({ ok: true, value: { changed: true } });
        expect(f.saved().ai.baseUrl).toBe(PRIVATE);
        expect(f.saved().ai.speechToText.baseUrl).toBe(value);
        expect(f.database.query('SELECT count(*) AS count FROM native_request_receipts').get()).toEqual({ count: 0 });
        expect(f.effects).toEqual([]); expect(f.log()).not.toContain(value);
        const refreshed = (await f.call('iosVoiceSettingsOptions')).value.expected;
        expect(await f.call('iosVoiceEndpointSensitive', { session: ID, op: 'read-endpoint', expected: refreshed }))
            .toEqual({ ok: true, value: { value } });
        expect((await f.call('iosVoiceOpenAIRuntime')).value.credentialRequired).toBe(false);
        expect((await f.call('iosVoiceOpenAIRuntime', { extra: true })).ok).toBe(false);
    });
    it('refuses a changed settings snapshot, closed session, or stale owner before saving', async () => {
        const { f, expected } = await setup();
        const request = { session: ID, op: 'save-endpoint', expected, value: 'https://speech.example.invalid' };
        expect((await f.call('iosVoiceEndpointSensitive', request, () => 'stale')).ok).toBe(false);
        expect(f.saved().ai.speechToText.baseUrl).toBe(PRIVATE);
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, language: 'fr' } });
        expect((await f.call('iosVoiceEndpointSensitive', request)).ok).toBe(false);
        expect(await f.poll(f.host.iosVoiceEndpointSessionClose(ID))).toEqual({ ok: true, value: null });
        expect((await f.call('iosVoiceEndpointSensitive', request)).ok).toBe(false);
        expect(f.saved().ai.speechToText.baseUrl).toBe(PRIVATE);
    });
    it('keeps owner loss after an accepted failed write uncertain', async () => {
        const { f, expected } = await setup();
        const native = (globalThis as any).__mindwtrNative, run = native.sqlRun;
        native.sqlRun = () => { throw new Error('Synthetic storage failure'); };
        const value = 'https://speech.example.invalid/accepted-before-owner-loss';
        try {
            const result = await f.call('iosVoiceEndpointSensitive', { session: ID, op: 'save-endpoint', expected, value },
                () => useTaskStore.getState().persistenceFailure ? 'owner-lost' : '');
            expect(result).toEqual({ ok: false, error: 'ACTION_FAILED: Voice endpoint could not be confirmed' });
            expect(useTaskStore.getState().settings.ai?.speechToText?.baseUrl).toBe(value);
        } finally { native.sqlRun = run; }
    }, 20000);
    it('retains exact accepted endpoint save failure for an unchanged retry', async () => {
        const { f, expected } = await setup();
        const native = (globalThis as any).__mindwtrNative, run = native.sqlRun;
        native.sqlRun = () => { throw new Error(PRIVATE); };
        const value = 'https://speech.example.invalid/private-retry-marker';
        const request = { session: ID, op: 'save-endpoint', expected, value };
        const failed = await f.call('iosVoiceEndpointSensitive', request);
        expect(failed).toEqual({ ok: false, error: 'ACTION_FAILED: Voice endpoint could not be confirmed' });
        expect(useTaskStore.getState().settings.ai?.speechToText?.baseUrl).toBe(value);
        native.sqlRun = run;
        expect((await f.call('iosVoiceEndpointSensitive', { ...request, value: value + '/changed' })).ok).toBe(false);
        expect(await f.call('iosVoiceEndpointSensitive', request)).toEqual({ ok: true, value: { changed: true } });
        expect(f.saved().ai.speechToText.baseUrl).toBe(value);
        expect(f.database.query('SELECT count(*) AS count FROM native_request_receipts').get()).toEqual({ count: 0 });
        expect(f.log()).not.toContain(value);
    }, 20000);
});


describe('private Whisper model catalog bridge', () => {
    it('normalizes local language with the shared mobile rules and refuses unowned or malformed requests', async () => {
        const f = await fixture(); await f.boot(seed());
        for (const [model, language, expected] of [
            ['whisper-tiny.en', 'auto', 'en'], ['whisper-tiny', 'auto', 'auto'],
            ['whisper-base', ' English ', 'en'], ['whisper-base', 'es_MX', 'es'],
            ['whisper-base', 'zh-Hant', 'zh'], ['whisper-tiny.en', 'es', 'es'],
        ]) expect(await f.call('iosVoiceWhisperLanguage', { model, language })).toEqual({ ok: true, value: expected });
        for (const input of [{}, { model: 'whisper-large-v3', language: 'auto' },
            { model: 'whisper-tiny', language: 3 }, { model: 'whisper-tiny', language: 'a'.repeat(201) },
            { model: 'whisper-tiny', language: 'en', extra: true }])
            expect((await f.call('iosVoiceWhisperLanguage', input)).ok).toBe(false);
        const input = { model: 'whisper-tiny', language: 'en' };
        expect((await f.call('iosVoiceWhisperLanguage', input, () => 'stale')).ok).toBe(false);
        expect((await f.poll(f.host.menuCommand('iosVoiceWhisperLanguage', JSON.stringify(input)))).ok).toBe(false);
        expect(f.effects).toEqual([]); expect(f.writes).toEqual([]); expect(f.log()).toBe('');
    });
    it('projects the selected mobile catalog without exposing private settings or changing the provider', async () => {
        const f = await fixture(); const data = seed(); data.settings.ai.speechToText.provider = 'whisper';
        Object.assign(data.settings.ai.speechToText, { model: 'whisper-base.en' });
        await f.boot(data);
        const result = await f.call('iosVoiceWhisperModel');
        expect(result).toEqual({ ok: true, value: { version: 1, id: 'whisper-base.en', fileName: 'ggml-base.en.bin',
            sizeBytes: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
            urls: ['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
                'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'] } });
        expect(Object.keys(result.value).sort()).toEqual(['version', 'id', 'fileName', 'sizeBytes', 'sha256', 'urls'].sort());
        expect((await f.call('iosVoiceRuntimeOptions')).value.supported).toBe(true);
        expect(JSON.stringify(result)).not.toContain(PRIVATE);
        expect(f.effects).toEqual([]); expect(f.writes).toEqual([]); expect(f.log()).toBe('');
        expect((await f.call('iosVoiceWhisperModel', { path: PRIVATE })).ok).toBe(false);
        expect((await f.call('iosVoiceWhisperModel', {}, () => 'stale')).ok).toBe(false);
        expect((await f.poll(f.host.menuCommand('iosVoiceWhisperModel', '{}'))).ok).toBe(false);
    });
    it('uses shared mobile fallback for desktop models and does not silently select a different provider', async () => {
        const f = await fixture(); const data = seed(); data.settings.ai.speechToText.provider = 'whisper';
        Object.assign(data.settings.ai.speechToText, { model: 'whisper-large-v3-turbo' });
        await f.boot(data);
        expect((await f.call('iosVoiceWhisperModel')).value).toMatchObject({ id: 'whisper-tiny', sizeBytes: 77691713 });
        const original = f.saved();
        for (const provider of ['gemini', 'openai', 'parakeet']) {
            const settings = useTaskStore.getState().settings;
            useTaskStore.setState({ settings: { ...settings, ai: { ...settings.ai,
                speechToText: { ...settings.ai?.speechToText, provider: provider as never } } } });
            await useTaskStore.getState().persistSnapshot(); await flushPendingSave();
            expect(await f.call('iosVoiceWhisperModel')).toEqual({ ok: true, value: null });
        }
        expect(original.ai.speechToText.model).toBe('whisper-large-v3-turbo');
    });
});


describe('private iOS speech model discovery', () => {
    const setup = async (provider = 'openai', aiProvider = provider, aiEnabled = true, consent = false, credential: string | null = PRIVATE) => {
        const f = await fixture(), data = seed(); data.settings.ai.provider = aiProvider; data.settings.ai.enabled = aiEnabled;
        data.settings.ai.speechToText.provider = provider; data.settings.ai.speechToText.baseUrl = 'https://speech.invalid/v1';
        Object.assign(data.settings.ai.speechToText, { model: 'custom-speech-model' }); await f.boot(data);
        const options = await f.call('iosVoiceSettingsOptions'), request = { session: ID, expected: options.value.expected };
        const phases: Record<string, unknown>[] = [], urls: string[] = []; let live = true;
        const owner = (json: string) => {
            const p = JSON.parse(json); phases.push(p); if (!live) return 'refused';
            return p.phase === 'metadata' ? JSON.stringify({ consent }) : p.phase === 'credential' ? JSON.stringify({ value: credential }) : '';
        };
        const reply = (value: unknown) => { globalThis.fetch = (async (input: RequestInfo | URL) => {
            urls.push(String(input)); return new Response(JSON.stringify(value));
        }) as typeof fetch; };
        return { ...f, request, options: options.value, owner, phases, urls, reply, refuse: () => { live = false; } };
    };
    it('uses OpenAI transcription filtering and raw speech root, preserving saved settings and old DTO', async () => {
        const f = await setup(), before = f.saved();
        f.reply({ data: [{ id: 'gpt-chat-new', created: 10 }, { id: 'gpt-new-transcribe', created: 8 }, { id: 'whisper-old', created: 1 }] });
        const result = await f.call('iosVoiceModelDiscovery', f.request, f.owner);
        expect(result).toEqual({ ok: true, value: { version: 1, provider: 'openai', status: 'loaded',
            modelOptions: ['custom-speech-model', 'gpt-new-transcribe', 'whisper-old'], expected: f.request.expected } });
        expect(f.urls).toEqual(['https://speech.invalid/v1/models']);
        expect(f.phases.filter(x => x.phase === 'credential')).toEqual([{ phase: 'credential', provider: 'openai' }]);
        expect(f.saved()).toEqual(before); expect((await f.call('iosVoiceSettingsOptions')).value).toEqual(f.options);
        expect(f.effects).toEqual([]); expect(f.writes).toEqual([]); expect(f.log()).toBe(''); expect(JSON.stringify(result)).not.toContain(PRIVATE);
    });
    it('uses Gemini chat choices without treating speech enabled or another assistant as consent', async () => {
        for (const [aiProvider, aiEnabled, consent, allowed] of [
            ['gemini', false, false, false], ['anthropic', true, false, false], ['gemini', true, false, true], ['anthropic', false, true, true],
        ] as const) {
            const f = await setup('gemini', aiProvider, aiEnabled, consent);
            f.reply({ models: [{ name: 'models/gemini-speech-new', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/embedding-other', supportedGenerationMethods: ['embedContent'] }] });
            const result = await f.call('iosVoiceModelDiscovery', f.request, f.owner);
            expect(result.value.status).toBe(allowed ? 'loaded' : 'unavailable');
            expect(f.urls.length).toBe(allowed ? 1 : 0);
            expect(f.phases.filter(x => x.phase === 'credential').length).toBe(allowed ? 1 : 0);
            if (allowed) expect(result.value.modelOptions).toEqual(['custom-speech-model', 'gemini-speech-new']);
            expect(f.effects).toEqual([]); expect(f.writes).toEqual([]);
        }
    });
    it('allows consented keyless custom speech root and refuses local/unsupported providers before secret work', async () => {
        const f = await setup('openai', 'anthropic', false, true, null); f.reply({ data: [{ id: 'whisper-remote' }] });
        expect((await f.call('iosVoiceModelDiscovery', f.request, f.owner)).value.status).toBe('loaded');
        for (const provider of ['whisper', 'parakeet']) {
            const local = await setup(provider); local.reply({ data: [{ id: 'whisper-remote' }] });
            expect((await local.call('iosVoiceModelDiscovery', local.request, local.owner)).ok).toBe(false);
            expect(local.phases.some(x => x.phase === 'credential' || x.phase === 'metadata')).toBe(false);
            expect(local.urls).toEqual([]); expect(local.effects).toEqual([]); expect(local.writes).toEqual([]);
        }
    });
    it('keeps static choices for malformed/empty/overlarge provider replies without changing data', async () => {
        const f = await setup(), before = f.saved();
        for (const reply of [{ data: [] }, { malformed: true }, { data: Array.from({ length: 101 }, (_, i) => ({ id: 'whisper-' + i })) }]) {
            f.reply(reply); const result = await f.call('iosVoiceModelDiscovery', f.request, f.owner);
            expect(result).toMatchObject({ ok: true, value: { status: 'fallback', modelOptions: f.options.modelOptions } });
        }
        expect(f.saved()).toEqual(before); expect(f.effects).toEqual([]); expect(f.writes).toEqual([]);
    });
    it.each(['owner', 'settings', 'abort'] as const)('discards held discovery after %s change', async change => {
        const f = await setup(); let started!: () => void, release!: () => void;
        const began = new Promise<void>(resolve => { started = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
        globalThis.fetch = (async () => { started(); await waiting; return new Response(JSON.stringify({ data: [{ id: 'whisper-held' }] })); }) as typeof fetch;
        const ticket = f.host.iosVoiceModelDiscovery(JSON.stringify(f.request), f.owner); await began;
        expect((await f.call('iosVoiceModelDiscovery', f.request, f.owner)).ok).toBe(false);
        if (change === 'owner') f.refuse();
        else if (change === 'settings') useTaskStore.setState(state => ({ settings: { ...state.settings, ai: { ...state.settings.ai, enabled: false } } }));
        else f.host.abort(ticket);
        release(); expect((await f.poll(ticket)).ok).toBe(false); expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });
    it('rejects malformed request and callback data without exposing private values', async () => {
        const f = await setup();
        for (const request of [{ ...f.request, extra: true }, { ...f.request, session: 'foreign' }, { ...f.request, expected: {} }])
            expect((await f.call('iosVoiceModelDiscovery', request, f.owner)).ok).toBe(false);
        const result = await f.call('iosVoiceModelDiscovery', f.request, (json: string) => JSON.parse(json).phase === 'metadata' ? PRIVATE : '');
        expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(PRIVATE);
        expect(f.writes).toEqual([]); expect(f.effects).toEqual([]);
    });
});
