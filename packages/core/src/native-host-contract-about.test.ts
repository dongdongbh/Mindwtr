import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTranslator, resolveI18nText } from './i18n';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract, type NativeAboutHost, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings } from './types';

/**
 * Settings › About, the heartbeat and the store review prompt through the native host contract, against React Native's frozen
 * fixture (about-settings-parity.fixtures.json, captured from RN's screen at HEAD by about-settings-screen.parity.test.tsx):
 * the same scenario must show the same rows, alerts and toasts, store the same keys and send the same requests.
 */
const fixture = JSON.parse(readFileSync(new URL('./about-settings-parity.fixtures.json', import.meta.url), 'utf8'));
const NOW = Date.parse(fixture.now);

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

type Event = unknown[];
type GithubAnswer = { status: number; body?: unknown };

/** The host's device as RN's harness stubs it: AsyncStorage in memory, GitHub's queued answers, the feedback endpoint. */
function device(options: { storage?: Record<string, string>; github?: GithubAnswer[]; feedbackStatus?: number; foss?: boolean; feedbackEndpointUrl?: string;
    releaseVersion?: string; heartbeatUrl?: string; channel?: string; isDev?: boolean } = {}) {
    const storage = new Map(Object.entries(options.storage ?? {}));
    const events: Event[] = [];
    const github = [...(options.github ?? [])];
    const host: NativeAboutHost = {
        app: {
            appName: 'Mindwtr', version: '1.3.4', releaseVersion: options.releaseVersion ?? '', build: '154', packageName: 'tech.dongdongbh.mindwtr',
            isFossBuild: options.foss ?? false, isDev: options.isDev ?? false, platform: 'android', platformVersion: 34, osRelease: '14',
            feedbackEndpointUrl: options.feedbackEndpointUrl ?? '', analyticsHeartbeatUrl: options.heartbeatUrl ?? '', analyticsHeartbeatChannel: options.channel ?? '',
        },
        storage: {
            getItem: async (key) => storage.get(key) ?? null,
            setItem: async (key, next) => { events.push(['storage.set', key, next]); storage.set(key, next); },
            removeItem: async (key) => { events.push(['storage.remove', key]); storage.delete(key); },
        },
        fetcher: async (input, init) => {
            const url = String(input);
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
            if (body && typeof body.submittedAt === 'string') body.submittedAt = '<now>';
            events.push(['fetch', { url, method: init?.method ?? 'GET', headers: init?.headers ?? null, body: body ?? null }]);
            if (url.startsWith('https://api.github.com/')) {
                const next = github.shift();
                if (!next) throw new Error('No GitHub answer queued');
                return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as Response;
            }
            const status = options.feedbackStatus ?? 200;
            return { ok: status < 300, status, json: async () => ({}) } as Response;
        },
        locale: () => 'en-US',
        generateId: () => 'made-id',
        feedbackDiagnostics: async () => '{"ts":"2026-10-07T09:59:00.000Z","level":"warn","scope":"sync","message":"x"}',
        logWarn: () => undefined,
        logInfo: () => undefined,
    };
    return { host, storage, events };
}

let current: ReturnType<typeof device> | null = null;
async function openContract(bound: ReturnType<typeof device> | null, language = 'en', settings: AppSettings = {}) {
    await flushPendingSave();
    resetForTests();
    let data = { tasks: [], projects: [], sections: [], areas: [], people: [], settings };
    setStorageAdapter({
        getData: async () => JSON.parse(JSON.stringify(data)),
        saveData: async (next) => { data = JSON.parse(JSON.stringify(next)); },
    });
    useTaskStore.setState({ error: null, persistenceFailure: null, isLoading: false, editLockCount: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    current = bound;
    const contract = createNativeHostContract(bound ? { about: bound.host } : {});
    value(await contract.setLanguage({ storedLanguage: language, systemLocale: 'en-US' }));
    value(await contract.activate({ writeSafetyReady: true }));
    return contract;
}

type Scenario = { name: string; language?: string; foss?: boolean; releaseVersion?: string; feedbackEndpointUrl?: string;
    referrer?: { value?: string; error?: string }; storage?: Record<string, string>; play?: ({ value: { updateAvailable: boolean; availableVersionCode: number | null } } | { error: string })[];
    github?: GithubAnswer[]; feedbackStatus?: number; steps?: Record<string, unknown>[] };
type Observed = { name: string; screens: string[][]; events: Event[]; storage: Record<string, string> };

const scenarios = fixture.scenarios as Scenario[];
const observed = (name: string) => (fixture.observations.about as Observed[]).find((entry) => entry.name === name)!;
const installer = (scenario: Scenario) => (scenario.foss ? 'sideload' : scenario.referrer?.error ? 'unknown' : (scenario.referrer?.value ?? '').trim() ? 'play-store' : 'sideload');
const label = (language: string, key: string) => resolveI18nText(getTranslator(language), key, {});

describe('native host contract: Settings › About against RN\'s frozen fixture', () => {
    beforeAll(async () => {
        await loadTranslations('zh');
    });
    afterEach(() => {
        vi.useRealTimers();
        current = null;
    });

    it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))('%s: the screen RN draws', async (_name, scenario) => {
        const contract = await openContract(device({ foss: scenario.foss, releaseVersion: scenario.releaseVersion, feedbackEndpointUrl: scenario.feedbackEndpointUrl }), scenario.language ?? 'en');
        const about = value(contract.getAboutSettings({ installerSource: installer(scenario) }));
        // RN's first screen: the top bar's title, the header, then each row's label and value.
        const texts = [about.title, about.appName, about.versionText, ...about.rows.flatMap((row) => [row.label, row.value])];
        expect(observed(scenario.name).screens[0].slice(0, texts.length)).toEqual(texts);
    });

    /**
     * Check for updates: from the storage RN held when the user tapped it, with the channel's last queued answer (RN's silent
     * check took the earlier ones), the same alert or toast, the same keys stored and GitHub asked the same way.
     */
    const manual = scenarios.filter((scenario) => scenario.steps?.some((step) => step.tap === 'settings.checkForUpdates'));
    it.each(manual.map((scenario) => [scenario.name, scenario] as const))('%s: Check for updates as RN runs it', async (_name, scenario) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const rn = observed(scenario.name);
        const tap = rn.events.findIndex((event) => event[0] === 'tap' && event[1] === 'settings.checkForUpdates');
        const before = { ...(scenario.storage ?? {}) };
        for (const event of rn.events.slice(0, tap)) {
            if (event[0] === 'storage.set') before[event[1] as string] = event[2] as string;
            if (event[0] === 'storage.remove') delete before[event[1] as string];
        }
        const bound = device({ storage: before, github: scenario.github?.slice(-1), foss: scenario.foss, releaseVersion: scenario.releaseVersion });
        const contract = await openContract(bound, scenario.language ?? 'en');
        const play = scenario.play?.at(-1) ?? null;
        const answer = value(await contract.runAboutUpdateCheck({ mode: 'manual', installerSource: installer(scenario), play, marketAvailable: true }));
        // RN's events after the tap, in RN's shapes: canOpenURL and the press are the host's, the dot is the answer's.
        const after = rn.events.slice(tap + 1);
        const press = after.findIndex((event) => event[0] === 'openURL');
        const expected = after.slice(0, press === -1 ? after.length : press)
            .filter((event) => event[0] === 'storage.set' || event[0] === 'storage.remove' || event[0] === 'fetch');
        expect(bound.events).toEqual(expected);
        const notices = after.filter((event) => event[0] === 'alert' || event[0] === 'toast').map((event) => event[1] as Record<string, unknown>);
        expect(answer.notices.map((notice) => {
            if (notice.kind === 'toast') {
                const { kind: _kind, ...toast } = notice;
                return toast;
            }
            return { title: notice.title, message: notice.message, buttons: notice.buttons.map((button) => ({ text: button.text, ...(button.style ? { style: button.style } : {}) })) };
        })).toEqual(notices);
        const badges = after.filter((event) => event[0] === 'badge');
        expect(answer.badge).toBe(badges.length ? badges.at(-1)![1] : null);
        // The pressed button opens the link RN opened.
        const opened = after[press];
        if (opened) {
            const pressed = scenario.steps!.find((step) => 'pressAlert' in step)!.pressAlert as string;
            const notice = answer.notices[0];
            expect(notice.kind).toBe('alert');
            if (notice.kind === 'alert') expect(notice.buttons.find((button) => button.text === label(scenario.language ?? 'en', pressed))?.url).toBe(opened[1]);
        }
        expect(Object.fromEntries([...bound.storage.entries()].sort())).toEqual(rn.storage);
    });

    it('the silent check asks once a day and answers the stored dot within it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const within = device({ storage: { 'mindwtr-update-last-check': String(NOW - 60_000), 'mindwtr-update-available': 'true' } });
        let contract = await openContract(within);
        expect(value(await contract.runAboutUpdateCheck({ mode: 'silent', installerSource: 'play-store', play: null, marketAvailable: true }))).toEqual({ badge: true, notices: [] });
        expect(within.events).toEqual([]);
        // RN's first scenario: a stale check on a Play install finds Play's update.
        const stale = device({ storage: { 'mindwtr-update-last-check': String(NOW - 25 * 60 * 60 * 1000) } });
        contract = await openContract(stale);
        const answer = value(await contract.runAboutUpdateCheck({ mode: 'silent', installerSource: 'play-store',
            play: { value: { updateAvailable: true, availableVersionCode: 160 } }, marketAvailable: true }));
        expect(answer).toEqual({ badge: true, notices: [] });
        expect(stale.events).toEqual(observed('play: screen opens, silent check finds a Play update').events.filter((event) => event[0] !== 'badge'));
        // A FOSS build never checks.
        const foss = device({ foss: true });
        contract = await openContract(foss);
        expect(value(await contract.runAboutUpdateCheck({ mode: 'silent', installerSource: 'sideload', play: null, marketAvailable: false }))).toEqual({ badge: null, notices: [] });
        expect(foss.events).toEqual([]);
    });

    it('says whether a check is due before the host asks Google Play, so Play is asked only when core checks', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const within = device({ storage: { 'mindwtr-update-last-check': String(NOW - 60_000) } });
        let contract = await openContract(within);
        expect(value(await contract.isAboutUpdateCheckDue({ mode: 'silent' }))).toEqual({ due: false });
        expect(value(await contract.isAboutUpdateCheckDue({ mode: 'manual' }))).toEqual({ due: true });
        expect(within.events).toEqual([]);
        contract = await openContract(device({ storage: { 'mindwtr-update-last-check': String(NOW - 25 * 60 * 60 * 1000) } }));
        expect(value(await contract.isAboutUpdateCheckDue({ mode: 'silent' }))).toEqual({ due: true });
        contract = await openContract(device({ foss: true }));
        expect(value(await contract.isAboutUpdateCheckDue({ mode: 'manual' }))).toEqual({ due: false });
        expect(await contract.isAboutUpdateCheckDue({ mode: 'later' as never })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('reads the install from Play\'s installer and the referrer, as RN does', async () => {
        let contract = await openContract(device());
        const source = (referrer: string | null, installerPackageName: string | null) => value(contract.getAboutInstallerSource({ referrer, installerPackageName })).source;
        expect(source('', 'com.android.vending')).toBe('play-store');
        expect(source(null, 'com.android.vending')).toBe('play-store');
        expect(source('utm_source=google-play', null)).toBe('play-store');
        expect(source('', null)).toBe('sideload');
        // An unreadable referrer, and no Play installer: RN's 'unknown'.
        expect(source(null, null)).toBe('unknown');
        contract = await openContract(device({ foss: true }));
        expect(source('utm_source=google-play', 'com.android.vending')).toBe('sideload');
        expect(contract.getAboutInstallerSource({ referrer: 1 as never, installerPackageName: null })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('a FOSS build\'s Check for updates is RN\'s info toast', async () => {
        const contract = await openContract(device({ foss: true }));
        const t = getTranslator('en');
        expect(value(await contract.runAboutUpdateCheck({ mode: 'manual', installerSource: 'sideload', play: null, marketAvailable: false })).notices).toEqual([{
            kind: 'toast', title: resolveI18nText(t, 'settings.aboutMobile.updatesAreManagedByYourDistributionSource', {}),
            message: resolveI18nText(t, 'settings.aboutMobile.inAppUpdateChecksAreDisabledInThisFossBuild', {}), tone: 'info', durationMs: 4800,
        }]);
    });

    it('rate and links open RN\'s urls', async () => {
        const contract = await openContract(device());
        const about = value(contract.getAboutSettings({ installerSource: 'play-store' }));
        const opened = observed('links: rate, website, tutorials, privacy, terms, sponsor').events.filter((event) => event[0] === 'openURL').map((event) => event[1]);
        expect([about.rate.urls[0], ...['website', 'tutorials', 'privacy', 'terms', 'sponsor'].map((id) => about.rows.find((row) => row.id === id)!.url)]).toEqual(opened);
        expect(about.rate.urls[1]).toBe('https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr');
    });

    /** Each feedback scenario's draft, as the steps typed it, sent through the contract: RN's request body, or RN's line. */
    const feedback = scenarios.filter((scenario) => scenario.steps?.some((step) => step.tap === 'settings.feedback'));
    it.each(feedback.map((scenario) => [scenario.name, scenario] as const))('%s: feedback as RN sends it', async (_name, scenario) => {
        const rn = observed(scenario.name);
        const draft = { category: 'bug', message: '', email: '', location: '', includeDiagnostics: false };
        const locations: Record<string, string> = { 'settings.feedbackWhereSync': 'sync', 'settings.feedbackWhereInbox': 'inbox' };
        for (const step of scenario.steps ?? []) {
            if (step.tap === 'settings.feedbackCategoryFeature') { draft.category = 'feature'; draft.includeDiagnostics = false; draft.location = ''; }
            if (step.tap === 'settings.feedbackCategoryOther') { draft.category = 'other'; draft.includeDiagnostics = false; draft.location = ''; }
            if (typeof step.tap === 'string' && locations[step.tap]) draft.location = draft.location === locations[step.tap] ? '' : locations[step.tap];
            if (step.type) draft[(step.type as { field: 'message' | 'email' }).field] = (step.type as { text: string }).text;
            if (typeof step.diagnostics === 'boolean') draft.includeDiagnostics = step.diagnostics;
        }
        const bound = device({ foss: scenario.foss, feedbackEndpointUrl: scenario.feedbackEndpointUrl, feedbackStatus: scenario.feedbackStatus });
        const contract = await openContract(bound);
        const installerSource = installer(scenario);
        const check = value(contract.checkAboutFeedback({ message: draft.message, email: draft.email, sending: false, error: null, category: draft.category, location: draft.location }));
        expect(check.messageMaxLength).toBe(draft.location ? 4000 - `Where: ${draft.location === 'sync' ? 'Sync' : 'Inbox'}\n\n`.length : 4000);
        const submitTap = rn.events.find((event) => event[0] === 'tap' && event[1] === 'settings.feedbackSubmit')!;
        expect(check.canSubmit).toBe(submitTap[2] === 'enabled');
        const lastScreen = rn.screens.at(-1)!;
        if (!check.canSubmit) {
            if (check.visibleError) expect(lastScreen).toContain(check.visibleError);
            return;
        }
        const answer = value(await contract.submitAboutFeedback({ draft, installerSource }));
        expect(bound.events).toEqual(rn.events.filter((event) => event[0] === 'fetch'));
        if (answer.sent) expect(lastScreen).toContain(label('en', 'settings.feedbackSent'));
        else expect(lastScreen).toContain(answer.failed);
        // The GitHub link RN opened for the category.
        const github = rn.events.find((event) => event[0] === 'openURL');
        if (github) expect(value(contract.getAboutSettings({ installerSource })).feedback.text.gitHub[draft.category as 'bug'].url).toBe(github[1]);
    });

    it('refuses a blank message and an invalid email with RN\'s lines, sending nothing', async () => {
        const bound = device({ feedbackEndpointUrl: 'https://feedback.example.test/submit' });
        const contract = await openContract(bound);
        const draft = { category: 'bug', message: ' ', email: '', location: '', includeDiagnostics: false };
        expect(value(await contract.submitAboutFeedback({ draft, installerSource: 'sideload' })).refused).toBe(label('en', 'settings.feedbackRequired'));
        expect(value(await contract.submitAboutFeedback({ draft: { ...draft, message: 'x', email: 'a@b' }, installerSource: 'sideload' })).refused)
            .toBe(label('en', 'settings.feedbackInvalidEmail'));
        expect(bound.events).toEqual([]);
        expect(contract.submitAboutFeedback({ draft: { ...draft, location: 'kitchen' }, installerSource: 'sideload' })).resolves.toMatchObject({ ok: false });
    });

    it('sends the heartbeat RN sends, from the synced settings', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const rn = (fixture.observations.heartbeats as { name: string; sent: boolean; events: Event[] }[]);
        const config = { heartbeatUrl: 'https://analytics.example.test/', releaseVersion: '1.3.4-rc.2' };
        const first = device(config);
        let contract = await openContract(first);
        expect(value(await contract.sendAboutHeartbeat())).toEqual({ sent: true });
        // The store gives every dataset its synced profile id (#1237); RN's fixture sent settings without one.
        const profileId = useTaskStore.getState().settings.analyticsProfileId;
        const sentBody = (first.events[1][1] as { body: Record<string, string> }).body;
        expect(sentBody.profile_id).toBe(profileId);
        delete sentBody.profile_id;
        expect(JSON.parse(JSON.stringify(first.events).split('made-id').join('<uuid>'))).toEqual(rn.find((entry) => entry.name === 'first heartbeat makes the distinct id')!.events);
        const profile = device({ ...config, storage: { 'mindwtr-analytics-distinct-id': ' stored-id ' } });
        contract = await openContract(profile, 'en', { analyticsProfileId: 'profile-1' });
        expect(value(await contract.sendAboutHeartbeat())).toEqual({ sent: true });
        expect(profile.events).toEqual(rn.find((entry) => entry.name === 'stored id and profile id')!.events);
        const off = device(config);
        contract = await openContract(off, 'en', { analytics: { heartbeatEnabled: false } });
        expect(value(await contract.sendAboutHeartbeat())).toEqual({ sent: false });
        expect(off.events).toEqual([]);
        const dev = device({ ...config, isDev: true });
        contract = await openContract(dev);
        expect(value(await contract.sendAboutHeartbeat())).toEqual({ sent: false });
        expect(dev.events).toEqual([]);
        const unset = device();
        contract = await openContract(unset);
        expect(value(await contract.sendAboutHeartbeat())).toEqual({ sent: false });
        expect(unset.events).toEqual([]);
    });

    it('asks for the store review when RN would, recording the attempt first', async () => {
        const rn = fixture.observations.storeReviews as { name: string; requested: boolean; storage: Record<string, string> }[];
        const day = 24 * 60 * 60 * 1000;
        const days = (count: number) => Array.from({ length: count }, (_, index) => new Date(NOW - index * day).toISOString().slice(0, 10));
        const state = (extra: Record<string, unknown> = {}) => JSON.stringify({ firstSeenAt: new Date(NOW - 20 * day).toISOString(), activeDayKeys: days(8), ...extra });
        const cases: { name: string; stored?: string; foss?: boolean; hasAction?: boolean }[] = [
            { name: 'eligible', stored: state() },
            { name: 'too few active days', stored: state({ activeDayKeys: days(3) }) },
            { name: 'recent attempt', stored: state({ storeReview: { lastAttemptAt: new Date(NOW - 30 * day).toISOString(), attemptCount: 1 } }) },
            { name: 'no review action', stored: state(), hasAction: false },
            { name: 'foss build', stored: state(), foss: true },
        ];
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        for (const entry of cases) {
            const bound = device({ foss: entry.foss, storage: entry.stored === undefined ? {} : { 'mindwtr:local-user-prompts:v1': entry.stored } });
            const contract = await openContract(bound);
            const answer = value(await contract.attemptAboutStoreReview({ storeReviewAvailable: entry.hasAction ?? true }));
            const expected = rn.find((item) => item.name === entry.name)!;
            expect(answer.request, entry.name).toBe(expected.requested);
            expect(Object.fromEntries(bound.storage.entries()), entry.name).toEqual(expected.storage);
        }
    });

    it('draws Data\'s analytics switch in a build with the heartbeat, and opts out as RN does', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const t = getTranslator('en');
        const none = await openContract(device());
        expect(value(none.getDataSettings()).diagnostics.analytics).toBeNull();
        expect(none.setDataSetting({ requestId: '00000000-0000-4000-8000-000000000001', edit: { type: 'analyticsOptOut', value: true } }))
            .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const bound = device({ heartbeatUrl: 'https://analytics.example.test/', storage: { 'mindwtr-analytics-distinct-id': 'id-6' } });
        const contract = await openContract(bound);
        const analytics = value(contract.getDataSettings()).diagnostics.analytics!;
        expect(analytics).toEqual({
            label: t('settings.analyticsHeartbeat'), description: t('settings.analyticsHeartbeatDesc'), value: false,
            edit: { type: 'analyticsOptOut', value: true },
            confirm: { title: t('settings.analyticsHeartbeatDisableTitle'), message: t('settings.analyticsHeartbeatDisableDesc'),
                keepLabel: t('settings.analyticsHeartbeatKeepEnabled'), disableLabel: t('settings.analyticsHeartbeatDisableConfirm') },
        });
        expect(value(await contract.setDataSetting({ requestId: '00000000-0000-4000-8000-000000000002', edit: analytics.edit })).changed).toBe(true);
        await vi.waitFor(() => expect(bound.storage.get('mindwtr-analytics-opt-out-sent')).toBe(new Date(NOW).toISOString()));
        expect(useTaskStore.getState().settings.analytics?.heartbeatEnabled).toBe(false);
        const optOut = bound.events.find((event) => event[0] === 'fetch')![1] as { body: Record<string, string> };
        expect(optOut.body).toMatchObject({ event: 'opt_out', analytics_enabled: 'false', distinct_id: 'id-6' });
        // A replay writes and sends nothing.
        const sends = bound.events.length;
        expect(value(await contract.setDataSetting({ requestId: '00000000-0000-4000-8000-000000000002', edit: analytics.edit })).changed).toBe(true);
        expect(bound.events.length).toBe(sends);
        const back = value(contract.getDataSettings()).diagnostics.analytics!;
        expect(back).toMatchObject({ value: true, edit: { type: 'analyticsOptOut', value: false } });
        expect(value(await contract.setDataSetting({ requestId: '00000000-0000-4000-8000-000000000003', edit: back.edit })).changed).toBe(true);
        await vi.waitFor(() => expect(bound.storage.has('mindwtr-analytics-opt-out-sent')).toBe(false));
        expect(useTaskStore.getState().settings.analytics?.heartbeatEnabled).toBe(true);
    });

    it('counts today for the prompts and logs it after the write, or the failure', async () => {
        const bound = device({ storage: { 'mindwtr:local-user-prompts:v1': JSON.stringify({ firstSeenAt: '2026-01-02T00:00:00.000Z', firstSeenDayKey: '2026-01-02', activeDayKeys: ['2026-01-02'] }) } });
        const lines: unknown[][] = [];
        bound.host.logInfo = (message, context) => { lines.push([message, context]); bound.events.push(['log', message]); };
        let contract = await openContract(bound);
        expect(value(await contract.recordAboutPromptActivity())).toBeNull();
        const stored = JSON.parse(bound.storage.get('mindwtr:local-user-prompts:v1')!);
        expect(stored.activeDayKeys.length).toBe(2);
        expect(bound.events.map((event) => event[0])).toEqual(['storage.set', 'log']);
        expect(lines).toEqual([['Native prompt activity recorded', { releaseCheck: 'v1.3.5/native-prompt-activity', outcome: 'stored' }]]);
        const failing = device();
        failing.host.storage.setItem = async () => { throw new Error('disk full'); };
        const failed: unknown[][] = [];
        failing.host.logInfo = (message, context) => { failed.push([message, context]); };
        contract = await openContract(failing);
        expect(value(await contract.recordAboutPromptActivity())).toBeNull();
        expect(failed).toEqual([['Native prompt activity recorded', { releaseCheck: 'v1.3.5/native-prompt-activity', outcome: 'failed' }]]);
    });

    it('answers ACTION_FAILED without an About host', async () => {
        const contract = await openContract(null);
        expect(contract.getAboutSettings({ installerSource: 'sideload' })).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(current).toBeNull();
    });
});
