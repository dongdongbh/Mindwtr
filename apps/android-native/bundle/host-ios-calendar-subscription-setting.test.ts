import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { build } from 'esbuild';
import vm from 'node:vm';

let source: string;
const fixtures: ReturnType<typeof fixture>[] = [];
const databases = new Set<Database>();
const at = '2026-10-09T10:00:00.000Z';
const requestId = '12345678-1234-4234-8234-123456789abc';
const privateUrl = 'https://PRIVATE_LOGIN:PRIVATE_SECRET@private.example/PRIVATE_PATH.ics?token=PRIVATE_TOKEN';
const feeds = () => [
    { id: 'é', name: 'PRIVATE CALENDAR', url: privateUrl, enabled: true, color: '#2563EB',
        areaIds: ['dangling-area', 'area-a'], retained: { ordered: ['keep', 'exact'] } },
    { id: 'e\u0301', name: 'PRIVATE SECOND CALENDAR', url: 'file:///PRIVATE_LOCAL.ics', enabled: true,
        areaIds: ['unrelated-dangling'], retained: { exact: true } },
];
const seedData = (settings: Record<string, unknown>) => ({
    tasks: [{ id: 'PRIVATE TASK ID', title: 'PRIVATE TASK', status: 'inbox', contexts: [], tags: [],
        createdAt: at, updatedAt: at }], projects: [], sections: [], people: [],
    areas: [{ id: 'area-a', name: 'PRIVATE AREA', color: '#2563EB', order: 0, createdAt: at, updatedAt: at }],
    settings: { deviceId: 'fixture-device', ...settings },
});
const canonicalSettings = () => ({ externalCalendars: feeds(),
    syncPreferencesUpdatedAt: { externalCalendars: at, general: at } });
const result = { changed: true, toasts: [], open: null, clearDraft: false };
const request = (expected: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ requestId,
    edit: { type: 'feed', feedId: 'é', field: 'enabled', value: false, revision: expected.revision }, expected, ...extra });

beforeAll(async () => {
    const built = await build({ stdin: { contents: `
        import './host-entry';
        import { useTaskStore, getStorageAdapter, setStorageAdapter, flushPendingSave, resetForTests } from '../../../packages/core/src/store';
        import { acquireWorkspaceTransitionLock, initializeSandboxRuntime } from '../../../packages/core/src/sandbox';
        globalThis.fixture = {
            flush: flushPendingSave, reset: resetForTests,
            replaceAdapter: () => setStorageAdapter({}),
            sandbox: () => initializeSandboxRuntime(true), transition: acquireWorkspaceTransitionLock,
            fail: () => useTaskStore.setState({ persistenceFailure: { message: 'PRIVATE failure' } }),
            clearFailure: () => useTaskStore.setState({ persistenceFailure: null }),
            seed: async data => {
                await flushPendingSave();
                const adapter = getStorageAdapter();
                await adapter.saveData(data);
                const saved = await adapter.getData();
                useTaskStore.setState({ _allTasks: saved.tasks, _allProjects: saved.projects, _allSections: saved.sections,
                    _allAreas: saved.areas, _allPeople: saved.people, settings: saved.settings });
                adapter.acknowledgeDataLoad?.(saved);
            },
        };
    `, resolveDir: import.meta.dir, loader: 'ts' }, bundle: true, write: false,
        format: 'iife', target: 'es2022', logLevel: 'silent' });
    source = built.outputFiles[0].text;
});

afterEach(async () => {
    for (const f of fixtures.splice(0)) {
        f.state.fixture.clearFailure(); await f.state.fixture.flush(); f.state.fixture.reset();
    }
    for (const database of databases) database.close();
    databases.clear();
});

const fixture = (options: { platform?: string; port?: boolean; database?: Database; kv?: Map<string, string> } = {}) => {
    const database = options.database ?? new Database(':memory:'); databases.add(database);
    const kv = options.kv ?? new Map([['mindwtr-external-calendars', JSON.stringify(feeds())]]);
    const writes: string[] = [], deviceWrites: unknown[] = [], legacyReads: unknown[] = [], providers: unknown[] = [];
    let logText = '', failLog = false, rawReply: string | undefined;
    const state: Record<string, any> = {
        AbortController, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout,
        __mindwtrHostPlatform: options.platform ?? 'ios', console: { log() {}, info() {}, warn() {}, error() {} },
        __cancelHostCalls() {}, __resumeHostCalls() {},
        __mindwtrCalendarCall: (value: unknown) => { providers.push(value); throw new Error('Unexpected PRIVATE provider operation'); },
        fetch: (...values: unknown[]) => { providers.push(values); throw new Error('Unexpected PRIVATE feed fetch'); },
        __mindwtrNative: {
            sqlExec: (sql: string) => { writes.push(sql); database.exec(sql); return null; },
            sqlRun: (sql: string, params: string) => { writes.push(sql); database.query(sql).run(...JSON.parse(params)); return null; },
            sqlAll: (sql: string, params: string) => JSON.stringify(database.query(sql).all(...JSON.parse(params))),
            nowMs: () => Date.parse(at), randomBytes: (count: number) => JSON.stringify(Array(count).fill(7)), log() {},
            rnStateCommit: () => { deviceWrites.push('rnStateCommit'); return null; },
            kvGet: (name: string) => JSON.stringify([kv.get(name) ?? null]),
            kvMultiGet: (names: string) => JSON.stringify(JSON.parse(names).map((name: string) => [name, kv.get(name) ?? null])),
            kvSet: (name: string, value: string) => { deviceWrites.push(['set', name, value]); kv.set(name, value); return null; },
            kvRemove: (name: string) => { deviceWrites.push(['remove', name]); kv.delete(name); return null; },
            fileList: () => 'null', fileRead: () => { providers.push('fileRead'); throw new Error('Unexpected private file read'); },
            fileDelete: () => { deviceWrites.push('fileDelete'); return null; },
            ...(options.port === false ? {} : { calendarSubscriptionRead: () => {
                legacyReads.push('mindwtr-external-calendars');
                return rawReply ?? JSON.stringify([kv.get('mindwtr-external-calendars') ?? null]);
            } }),
            logFile: (operation: string, text: string) => {
                if (failLog) throw new Error('PRIVATE_LOG_ERROR');
                if (operation === 'path' || operation === 'ensure') return 'files/logs/mindwtr.log';
                if (operation === 'size') return String(logText.length);
                if (operation === 'read') return logText;
                if (operation === 'exists') return logText ? '1' : '';
                if (operation === 'isAbsent') return logText ? '' : '1';
                if (operation === 'append') { logText += text; return ''; }
                if (operation === 'write') { logText = text; return ''; }
                if (operation === 'delete') { logText = ''; return '1'; }
                throw new Error('Unexpected diagnostic operation');
            },
        },
    };
    vm.runInNewContext(source, state);
    const poll = async (ticket: string) => {
        for (let step = 0; step < 200; step++) {
            const raw = state.MindwtrHost.poll(ticket);
            if (raw !== null) return JSON.parse(raw);
            await new Promise((done) => setTimeout(done, 0));
        }
        throw new Error('Calendar subscription bridge did not settle');
    };
    const f = { state, database, kv, writes, deviceWrites, legacyReads, providers,
        log: () => logText, failLog: () => { failLog = true; }, reply: (value: string) => { rawReply = value; },
        clearEffects: () => { writes.length = 0; deviceWrites.length = 0; legacyReads.length = 0; providers.length = 0; logText = ''; },
        raw: (method: string, input: string) => poll(state.MindwtrHost[method](input)),
        call: (method: string, input?: unknown) => poll(input === undefined
            ? state.MindwtrHost[method]() : state.MindwtrHost[method](JSON.stringify(input))),
        boot: async (settings?: Record<string, unknown>, recovery = false) => {
            expect(await poll(state.MindwtrHost[recovery ? 'bootRecovery' : 'boot']('', ''))).toMatchObject({ ok: true });
            if (settings) await state.fixture.seed(seedData(settings));
            f.clearEffects();
        },
        savedSettings: () => JSON.parse((database.query('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data),
        replaceSavedSettings: (settings: Record<string, unknown>) => database.query('UPDATE settings SET data = ? WHERE id = 1').run(JSON.stringify(settings)),
        domain: () => Object.fromEntries(['tasks', 'projects', 'sections', 'areas', 'people', 'calendar_sync', 'saved_filters']
            .map((table) => [table, database.query(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    };
    fixtures.push(f); return f;
};

const preparedCommand = async (f: ReturnType<typeof fixture>, selected?: ReturnType<typeof request>) => {
    const options = await f.call('calendarSubscriptionSettingOptions', {});
    expect(options.ok).toBe(true);
    const input = selected ?? request(options.value.expected);
    const prepared = await f.call('calendarSubscriptionSettingPrepare', input);
    expect(prepared).toMatchObject({ ok: true, value: { kind: 'prepared' } });
    return { request: input, prepared: prepared.value.prepared };
};
const assertNoExternalEffects = (f: ReturnType<typeof fixture>, before: Map<string, string>) => {
    expect(f.providers).toEqual([]); expect(f.deviceWrites).toEqual([]); expect(f.kv).toEqual(before);
};

describe('actual private iOS calendar subscription settings bundle', () => {
    it('projects controls and a same-capture canonical witness without any legacy/provider/device access', async () => {
        const f = fixture(); await f.boot(canonicalSettings());
        const device = new Map(f.kv), domain = f.domain(), settings = f.savedSettings();
        const options = await f.call('calendarSubscriptionSettingOptions', {});
        expect(options).toMatchObject({ ok: true, value: { expected: { source: 'canonical', revision: `synced:${at}`,
            stampPresent: true, stamp: at, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) } } });
        expect(options.value.model.revision).toBe(options.value.expected.revision);
        expect(options.value.model.items.map((item: any) => item.id)).toEqual(['é', 'e\u0301']);
        expect(options.value.model.items[0].name).toBe('PRIVATE CALENDAR');
        expect(options.value.model.items[0].url).not.toContain('PRIVATE_SECRET');
        const command = await preparedCommand(f);
        expect(Object.keys(command.prepared).sort()).toEqual(['deviceIdBefore', 'deviceIdToInitialize', 'preparedAt', 'request', 'stamp', 'version']);
        expect(await f.call('calendarSubscriptionSettingValidate', command)).toEqual({ ok: true, value: result });
        expect((await f.call('calendarSubscriptionSettingRetryOutcome', command.request)).ok).toBe(false);
        expect(JSON.stringify(command)).not.toContain('PRIVATE');
        expect(JSON.stringify(command)).not.toContain('private.example');
        expect(f.legacyReads).toEqual([]); expect(f.writes).toEqual([]); expect(f.log()).toBe('');
        expect(f.savedSettings()).toEqual(settings); expect(f.domain()).toEqual(domain); assertNoExternalEffects(f, device);
    });

    it.each(['before boot', 'android', 'missing port', 'adapter', 'sandbox', 'transition'])('refuses %s read/write admission before effects', async (guard) => {
        const healthy = fixture(); await healthy.boot(canonicalSettings());
        const command = await preparedCommand(healthy);
        const f = fixture({ platform: guard === 'android' ? 'android' : 'ios', port: guard !== 'missing port' });
        if (guard !== 'before boot') await f.boot(canonicalSettings());
        if (guard === 'adapter') f.state.fixture.replaceAdapter();
        if (guard === 'sandbox') f.state.fixture.sandbox();
        if (guard === 'transition') f.state.fixture.transition();
        expect(await f.call('calendarSubscriptionSettingOptions', {})).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY') });
        for (const [method, input] of [['calendarSubscriptionSettingPrepare', command.request],
            ['calendarSubscriptionSettingCommit', command], ['calendarSubscriptionSettingRetryOutcome', command.request]] as const)
            expect(await f.call(method, input)).toMatchObject({ ok: false, error: expect.stringContaining('NOT_READY') });
        expect(await f.call('calendarSubscriptionSettingValidate', command)).toEqual({ ok: true, value: result });
        expect(f.writes).toEqual([]); expect(f.legacyReads).toEqual([]); expect(f.providers).toEqual([]); expect(f.deviceWrites).toEqual([]);
    });

    it('binds imported saved rows even with an unchanged group stamp, and keeps stale no-ops effect free', async () => {
        const f = fixture(); await f.boot(canonicalSettings());
        const first = await f.call('calendarSubscriptionSettingOptions', {});
        const imported = f.savedSettings(); imported.externalCalendars[0].name = 'PRIVATE IMPORT';
        imported.externalCalendars[0].url = 'https://private.example/PRIVATE_IMPORTED.ics';
        f.replaceSavedSettings(imported);
        const second = await f.call('calendarSubscriptionSettingOptions', {});
        expect(second.ok).toBe(true); expect(second.value.model.items[0].name).toBe('PRIVATE IMPORT');
        expect(second.value.model.revision).toBe(first.value.model.revision);
        expect(second.value.expected.fingerprint).not.toBe(first.value.expected.fingerprint);
        expect(await f.call('calendarSubscriptionSettingPrepare', request(first.value.expected)))
            .toMatchObject({ ok: false, error: expect.stringContaining('STALE_REVISION') });
        const noop = request(first.value.expected); noop.edit.value = true;
        expect(await f.call('calendarSubscriptionSettingPrepare', noop)).toEqual({ ok: true,
            value: { kind: 'noop', result: { ...result, changed: false } } });
        expect(await f.call('calendarSubscriptionSettingPrepare', { ...noop,
            edit: { type: 'removeFeed', feedId: 'absent', revision: noop.expected.revision } })).toEqual({ ok: true,
            value: { kind: 'noop', result: { ...result, changed: false } } });
        expect(f.writes).toEqual([]); expect(f.legacyReads).toEqual([]); expect(f.savedSettings()).toEqual(imported);
    });

    it('saves only canonical metadata with an admitted durable receipt, and fresh-VM replay wins after later changes', async () => {
        const f = fixture(); await f.boot(canonicalSettings());
        const device = new Map(f.kv), domain = f.domain(), before = f.savedSettings(), command = await preparedCommand(f);
        expect(await f.call('calendarSubscriptionSettingCommit', command)).toEqual({ ok: true, value: result });
        const saved = f.savedSettings();
        expect(saved.externalCalendars).toEqual([{ ...before.externalCalendars[0], enabled: false }, before.externalCalendars[1]]);
        expect({ ...saved, externalCalendars: before.externalCalendars, syncPreferencesUpdatedAt: before.syncPreferencesUpdatedAt }).toEqual(before);
        expect(saved.syncPreferencesUpdatedAt.general).toBe(at);
        expect(saved.syncPreferencesUpdatedAt.externalCalendars).toBe(command.prepared.stamp);
        const receipt = f.database.query('SELECT * FROM native_request_receipts WHERE request_id = ?').get(requestId) as Record<string, string>;
        expect(receipt).toBeTruthy(); expect(receipt.method).toMatch(/^calendarSubscriptionSetting:/);
        expect(JSON.stringify(receipt)).not.toContain('PRIVATE'); expect(JSON.stringify(receipt)).not.toContain('private.example');
        expect(f.domain()).toEqual(domain); expect(f.legacyReads).toEqual([]); assertNoExternalEffects(f, device);
        saved.externalCalendars[0].name = 'PRIVATE LATER CHOICE'; saved.externalCalendars[0].enabled = true;
        saved.syncPreferencesUpdatedAt.externalCalendars = '2026-10-10T10:00:00.000Z'; f.replaceSavedSettings(saved);
        f.kv.set('mindwtr-external-calendars', 'PRIVATE CHANGED LEGACY CELL');
        const cold = fixture({ database: f.database, kv: f.kv }); await cold.boot(undefined, true);
        const coldDevice = new Map(cold.kv);
        expect(cold.savedSettings()).toEqual(saved);
        expect(await cold.call('calendarSubscriptionSettingRetryOutcome', command.request)).toEqual({ ok: true, value: result });
        expect(await cold.call('calendarSubscriptionSettingCommit', command)).toEqual({ ok: true, value: result });
        expect(cold.writes).toEqual([]); expect(cold.legacyReads).toEqual([]); expect(cold.savedSettings()).toEqual(saved);
        assertNoExternalEffects(cold, coldDevice);
    });

    it('keeps explicit canonical [] authoritative and does not resurrect the poisoned compatibility cell', async () => {
        const f = fixture(); await f.boot({ externalCalendars: [] });
        f.kv.set('mindwtr-external-calendars', 'PRIVATE MALFORMED LEGACY'); const device = new Map(f.kv);
        const options = await f.call('calendarSubscriptionSettingOptions', {});
        expect(options).toMatchObject({ ok: true, value: { model: { items: [] }, expected: { source: 'canonical' } } });
        expect(await f.call('calendarSubscriptionSettingPrepare', { requestId,
            edit: { type: 'removeFeed', feedId: 'é', revision: options.value.expected.revision }, expected: options.value.expected }))
            .toEqual({ ok: true, value: { kind: 'noop', result: { ...result, changed: false } } });
        expect(f.legacyReads).toEqual([]); expect(f.writes).toEqual([]); assertNoExternalEffects(f, device);
    });

    it('uses only the fixed legacy read and refuses changed bytes before canonical promotion without device writes', async () => {
        const f = fixture(); await f.boot({}); const device = new Map(f.kv);
        const command = await preparedCommand(f);
        expect(command.request.expected.source).toBe('legacy');
        expect(f.legacyReads.length).toBeGreaterThan(0); expect(f.writes).toEqual([]);
        f.kv.set('mindwtr-external-calendars', ` ${device.get('mindwtr-external-calendars')}`);
        expect(await f.call('calendarSubscriptionSettingCommit', command)).toMatchObject({ ok: false, error: expect.stringContaining('STALE_REVISION') });
        expect(f.writes).toEqual([]); expect(f.savedSettings()).not.toHaveProperty('externalCalendars');
        expect(f.providers).toEqual([]); expect(f.deviceWrites).toEqual([]);
        f.kv.set('mindwtr-external-calendars', device.get('mindwtr-external-calendars')!);
        const options = await f.call('calendarSubscriptionSettingOptions', {});
        const fresh = await preparedCommand(f, request(options.value.expected,
            { requestId: '22345678-1234-4234-8234-123456789abc' }));
        expect(await f.call('calendarSubscriptionSettingCommit', fresh)).toEqual({ ok: true, value: result });
        expect(f.savedSettings().externalCalendars.map((feed: any) => [feed.id, feed.enabled])).toEqual([['é', false], ['e\u0301', true]]);
        assertNoExternalEffects(f, device);
    });

    it.each(['[]', '[null,null]', '[123]', '{}', '["PRIVATE_UNPARSEABLE"]'])('refuses malformed fixed-cell reply %s without effects or parser excerpts', async (reply) => {
        const f = fixture(); await f.boot({}); f.reply(reply);
        const answer = await f.call('calendarSubscriptionSettingOptions', {});
        expect(answer.ok).toBe(false); expect(JSON.stringify(answer)).not.toContain('PRIVATE');
        expect(f.writes).toEqual([]); expect(f.deviceWrites).toEqual([]); expect(f.providers).toEqual([]);
    });

    it('refuses malformed/forged compact commands before effects and preserves pure validation before boot', async () => {
        const f = fixture(); await f.boot(canonicalSettings()); const command = await preparedCommand(f);
        const cold = fixture();
        expect(await cold.call('calendarSubscriptionSettingValidate', command)).toEqual({ ok: true, value: result });
        const invalid = [null, [], {}, { ...command.request, rawCell: privateUrl },
            { ...command.request, expected: { ...command.request.expected, url: privateUrl } },
            { ...command.request, requestId: requestId.toUpperCase() },
            { ...command.request, edit: { ...command.request.edit, revision: 'different' } },
            { ...command.request, edit: { ...command.request.edit, field: 'url', value: privateUrl } },
            { ...command.request, edit: { ...command.request.edit, field: 'areaIds', value: Array(501).fill('area') } }];
        for (const input of invalid) {
            const answer = await f.call('calendarSubscriptionSettingPrepare', input);
            expect(answer.ok).toBe(false); expect(JSON.stringify(answer)).not.toContain('PRIVATE');
        }
        for (const forged of [{ ...command, rawList: feeds() },
            { ...command, prepared: { ...command.prepared, list: feeds() } },
            { ...command, prepared: { ...command.prepared, stamp: at } }]) {
            expect((await f.call('calendarSubscriptionSettingValidate', forged)).ok).toBe(false);
            expect((await f.call('calendarSubscriptionSettingCommit', forged)).ok).toBe(false);
        }
        expect(f.writes).toEqual([]); expect(f.legacyReads).toEqual([]); expect(f.deviceWrites).toEqual([]); expect(f.providers).toEqual([]);
        expect(cold.writes).toEqual([]); expect(cold.legacyReads).toEqual([]);
    });

    it('refuses operation byte overflow and malformed private JSON without leaking input or performing effects', async () => {
        const f = fixture(); await f.boot(canonicalSettings());
        for (const [method, limit] of [['calendarSubscriptionSettingPrepare', 1_048_576],
            ['calendarSubscriptionSettingCommit', 4_194_304], ['calendarSubscriptionSettingRetryOutcome', 1_048_576]] as const) {
            const answer = await f.raw(method, ' '.repeat(limit + 1) + '{}');
            expect(answer.ok).toBe(false);
        }
        expect(await f.raw('calendarSubscriptionSettingPrepare', '{"PRIVATE_SECRET":'))
            .toMatchObject({ ok: false, error: expect.not.stringContaining('PRIVATE') });
        const huge = f.savedSettings(); huge.externalCalendars[0].url = 'https://private.example/' + '漢'.repeat(350_000);
        f.replaceSavedSettings(huge);
        expect((await f.call('calendarSubscriptionSettingOptions', {})).ok).toBe(false);
        expect(f.writes).toEqual([]); expect(f.legacyReads).toEqual([]); expect(f.deviceWrites).toEqual([]); expect(f.providers).toEqual([]);
    });

    it('accepts the existing maximum escaped Area edit through the compact prepare/validate frame without effects', async () => {
        const f = fixture(); await f.boot(canonicalSettings());
        const options = await f.call('calendarSubscriptionSettingOptions', {});
        const selected = { requestId, expected: options.value.expected, edit: { type: 'feed', feedId: 'é',
            field: 'areaIds', value: Array(500).fill('\u0001'.repeat(200)), revision: options.value.expected.revision } };
        const raw = JSON.stringify(selected);
        expect(new TextEncoder().encode(raw).length).toBeGreaterThan(600_000);
        expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(1_048_576);
        const answer = await f.raw('calendarSubscriptionSettingPrepare', raw);
        expect(answer).toMatchObject({ ok: true, value: { kind: 'prepared' } });
        const command = { request: selected, prepared: answer.value.prepared };
        const envelope = JSON.stringify(command);
        expect(new TextEncoder().encode(envelope).length).toBeGreaterThan(1_200_000);
        expect(new TextEncoder().encode(envelope).length).toBeLessThanOrEqual(4_194_304);
        expect(await f.raw('calendarSubscriptionSettingValidate', envelope)).toEqual({ ok: true, value: result });
        expect(f.writes).toEqual([]); expect(f.legacyReads).toEqual([]); expect(f.providers).toEqual([]); expect(f.deviceWrites).toEqual([]);
    });

    it.each([true, false])('emits only the preference-respecting fixed acknowledgment context when logging=%s', async (loggingEnabled) => {
        const f = fixture(); await f.boot({ ...canonicalSettings(), diagnostics: { loggingEnabled } });
        expect(await f.call('calendarSubscriptionSettingAcknowledged')).toEqual({ ok: true, value: null });
        const entries = f.log().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        expect(entries.filter((entry) => entry.message === 'Native iOS calendar subscription setting saved').map((entry) => entry.context))
            .toEqual(loggingEnabled ? [{ releaseCheck: 'v1.3.5/ios-calendar-subscription-setting', outcome: 'saved' }] : []);
        for (const secret of ['PRIVATE', 'private.example', requestId, 'fingerprint', 'é', 'e\u0301']) expect(f.log()).not.toContain(secret);
        const before = f.log(); f.failLog();
        expect(await f.call('calendarSubscriptionSettingAcknowledged')).toEqual({ ok: true, value: null });
        expect(f.log()).toBe(before); expect(f.writes).toEqual([]); expect(f.deviceWrites).toEqual([]); expect(f.providers).toEqual([]);
    });
});
