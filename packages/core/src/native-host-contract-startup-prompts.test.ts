import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_ONBOARDING_STORAGE_KEY } from './first-run-onboarding';
import { createNativeHostContract, type NativeAboutHost, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { SYNC_BACKEND_KEY } from './sync-storage-keys';
import { LOCAL_USER_PROMPT_STATE_KEY, recordPromptActivity } from './user-prompts';

/**
 * The native hosts' startup prompts: core's RN descriptors and queue on the host's device keys, after the validated boot.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
// Sandbox mode is fixed per runtime (initializeSandboxRuntime); one test switches what the contract reads.
const sandbox = vi.hoisted(() => ({ on: false }));
vi.mock('./sandbox', async (importOriginal) => ({ ...await importOriginal<typeof import('./sandbox')>(), isSandboxMode: () => sandbox.on }));
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

function device(options: { storage?: Record<string, string>; github?: { status: number; body?: unknown }[]; foss?: boolean } = {}) {
    const storage = new Map(Object.entries(options.storage ?? {}));
    const fetched: string[] = [];
    const github = [...(options.github ?? [])];
    const host: NativeAboutHost = {
        app: {
            appName: 'Mindwtr', version: '1.3.4', releaseVersion: '', build: '154', packageName: 'tech.dongdongbh.mindwtr',
            isFossBuild: options.foss ?? false, isDev: false, platform: 'android', platformVersion: 34, osRelease: '14',
            feedbackEndpointUrl: '', analyticsHeartbeatUrl: '', analyticsHeartbeatChannel: '',
            githubReleasesApi: 'http://127.0.0.1:9/latest',
        },
        storage: {
            getItem: async (key) => storage.get(key) ?? null,
            setItem: async (key, next) => { storage.set(key, next); },
            removeItem: async (key) => { storage.delete(key); },
        },
        fetcher: async (input) => {
            fetched.push(String(input));
            const next = github.shift();
            if (!next) throw new Error('No GitHub answer queued');
            return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as Response;
        },
        locale: () => 'en-US',
        generateId: () => 'made-id',
        feedbackDiagnostics: async () => null,
        logWarn: () => undefined,
        logInfo: () => undefined,
    };
    return { host, storage, fetched };
}

async function openContract(bound: ReturnType<typeof device>) {
    await flushPendingSave();
    resetForTests();
    let data = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
    setStorageAdapter({
        getData: async () => JSON.parse(JSON.stringify(data)),
        saveData: async (next) => { data = JSON.parse(JSON.stringify(next)); },
    });
    useTaskStore.setState({ error: null, persistenceFailure: null, isLoading: false, editLockCount: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const contract = createNativeHostContract({ about: bound.host });
    value(await contract.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
    value(await contract.activate({ writeSafetyReady: true }));
    return contract;
}

type Contract = Awaited<ReturnType<typeof openContract>>;
const begin = async (contract: Contract, input: Record<string, unknown>) => {
    const run = contract.beginStartupPrompts({ installerSource: 'play-store', donationEnabled: false, ...input });
    await vi.runAllTimersAsync();
    return value(await run).prompt;
};
// A user first seen a month ago, active on two days since: past the update reminder's and donation ask's waits.
const settledUser = () => JSON.stringify(recordPromptActivity(recordPromptActivity({}, Date.now() - 30 * DAY_MS), Date.now() - 10 * DAY_MS));
// First seen 40 days ago and active on 25 of them: past the donation ask's 30 days and 21 active days.
const longTimeUser = () => JSON.stringify(Array.from({ length: 25 }, (_, day) => Date.now() - (40 - day) * DAY_MS)
    .reduce((state, at) => recordPromptActivity(state, at), {}));

describe('native host contract: the donation ask\'s synced record', () => {
    it('writes settings.supportPrompt once per request, with the time the ask showed', async () => {
        const contract = await openContract(device());
        const shownAt = '2026-10-22T10:00:00.000Z';
        const requestId = '0b6f8d0e-7c55-4a8e-9b1a-3d2f8f0c1a77';
        expect(value(await contract.supportPromptShown({ requestId, shownAt }))).toEqual({ changed: true });
        expect(useTaskStore.getState().settings.supportPrompt?.lastShownAt).toBe(shownAt);
        // A replay of the same request answers from its receipt and writes nothing new.
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, supportPrompt: { lastShownAt: '2026-10-23T00:00:00.000Z' } } } as never);
        expect(value(await contract.supportPromptShown({ requestId, shownAt }))).toEqual({ changed: true });
        expect(useTaskStore.getState().settings.supportPrompt?.lastShownAt).toBe('2026-10-23T00:00:00.000Z');
        expect((await contract.supportPromptShown({ requestId: 'not-a-uuid', shownAt })).ok).toBe(false);
        expect((await contract.supportPromptShown({ requestId: '1b6f8d0e-7c55-4a8e-9b1a-3d2f8f0c1a77', shownAt: 'soon' })).ok).toBe(false);
    });
});

describe('native host contract: startup prompts', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('opens the welcome sheet for an empty library with sync off, once, and records today first', async () => {
        const bound = device();
        const lines: unknown[][] = [];
        bound.host.logInfo = (message, context) => { lines.push([message, context]); };
        const contract = await openContract(bound);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const sheet = await begin(contract, {});
        expect(sheet).toMatchObject({ id: 'onboarding', language: 'en', words: { title: 'Welcome to Mindwtr', startFreshTitle: 'Start using Mindwtr', skipForNow: 'Skip for now', toastReady: 'Getting Started is ready in Projects.' } });
        expect(Object.values((sheet as { words: Record<string, string> }).words).every((word) => !word.startsWith('onboarding.'))).toBe(true);
        expect(JSON.parse(bound.storage.get(LOCAL_USER_PROMPT_STATE_KEY)!).activeDayKeys).toHaveLength(1);
        // The prompts' active day has one writer, logged once per process after the write.
        expect(lines).toEqual([['Native prompt activity recorded', { releaseCheck: 'v1.3.5/native-prompt-activity', outcome: 'stored' }]]);
        expect(value(await contract.startupPromptAction({ id: 'onboarding', action: 'dismiss' }))).toEqual({ shownAt: null });
        expect(bound.storage.get(MOBILE_ONBOARDING_STORAGE_KEY)).toBe('dismissed');
        expect(await begin(contract, {})).toBeNull();
    });

    it('never offers the welcome sheet with sync on', async () => {
        const contract = await openContract(device({ storage: { [SYNC_BACKEND_KEY]: 'webdav' } }));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        expect(await begin(contract, {})).toBeNull();
    });

    it('reminds a settled sideload user about a newer release, in the app words, then the donation ask after it is dismissed', async () => {
        const bound = device({
            storage: { [MOBILE_ONBOARDING_STORAGE_KEY]: 'dismissed', [LOCAL_USER_PROMPT_STATE_KEY]: settledUser() },
            github: [{ status: 200, body: { tag_name: 'v1.4.0', html_url: 'https://github.com/dongdongbh/Mindwtr/releases/tag/v1.4.0', published_at: '2026-10-01T00:00:00Z' } }],
        });
        const contract = await openContract(bound);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const prompt = await begin(contract, { installerSource: 'sideload', donationEnabled: true });
        expect(bound.fetched).toEqual(['http://127.0.0.1:9/latest']);
        expect(prompt).toEqual({
            id: 'update-reminder',
            notNow: 'Not now',
            closeLabel: 'Dismiss announcement',
            announcement: {
                id: 'update-reminder-1.4.0',
                title: 'Update available',
                body: 'Mindwtr 1.4.0 is available. You are using 1.3.4. Update when you have a minute to keep fixes and improvements current.',
                action: { type: 'url', label: 'Update now', url: 'https://github.com/dongdongbh/Mindwtr/releases/tag/v1.4.0' },
            },
        });
        value(await contract.startupPromptAction({ id: 'update-reminder', action: 'dismiss' }));
        expect(JSON.parse(bound.storage.get(LOCAL_USER_PROMPT_STATE_KEY)!).update.dismissedVersion).toBe('1.4.0');
        // RN's queue goes on after a dismissal; this user is too new for the donation ask, so nothing else opens, and the
        // update reminder is not checked again this session.
        expect(await begin(contract, { installerSource: 'sideload', donationEnabled: true })).toBeNull();
        expect(bound.fetched).toHaveLength(1);
    });

    it('asks for a donation in the app words and records the showing for the synced write', async () => {
        const bound = device({ storage: { [MOBILE_ONBOARDING_STORAGE_KEY]: 'dismissed', [LOCAL_USER_PROMPT_STATE_KEY]: longTimeUser() } });
        const contract = await openContract(bound);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const prompt = await begin(contract, { donationEnabled: true });
        expect(prompt).toMatchObject({ id: 'donation', announcement: { title: 'Keep Mindwtr free and independent', dismissLabel: 'Maybe later' } });
        expect(await begin(contract, { donationEnabled: false })).toBeNull();
        const { shownAt } = value(await contract.startupPromptAction({ id: 'donation', action: 'shown' }));
        expect(shownAt).toEqual(expect.any(String));
        expect(JSON.parse(bound.storage.get(LOCAL_USER_PROMPT_STATE_KEY)!).donation.lastShownAt).toBe(shownAt);
    });

    it('keeps the update reminder off FOSS and Play builds', async () => {
        for (const options of [{ foss: true, installerSource: 'sideload' }, { foss: false, installerSource: 'play-store' }]) {
            vi.useRealTimers();
            const bound = device({ foss: options.foss, storage: { [MOBILE_ONBOARDING_STORAGE_KEY]: 'dismissed', [LOCAL_USER_PROMPT_STATE_KEY]: settledUser() } });
            const contract = await openContract(bound);
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            expect(await begin(contract, { installerSource: options.installerSource })).toBeNull();
            expect(bound.fetched).toEqual([]);
        }
    });

    it('writes nothing for the welcome sheet\'s Sync and Import handoffs, and nothing for a donation dismissal', async () => {
        const bound = device();
        const contract = await openContract(bound);
        value(await contract.startupPromptAction({ id: 'onboarding', action: 'act' }));
        value(await contract.startupPromptAction({ id: 'donation', action: 'dismiss' }));
        value(await contract.startupPromptAction({ id: 'update-reminder', action: 'dismiss' }));
        expect([...bound.storage.keys()]).toEqual([]);
    });

    it('opens nothing in the sandbox', async () => {
        const bound = device();
        const contract = await openContract(bound);
        sandbox.on = true;
        try {
            expect(value(await contract.beginStartupPrompts({ installerSource: 'sideload', donationEnabled: true }))).toEqual({ prompt: null });
            expect([...bound.storage.keys()]).toEqual([]);
        } finally {
            sandbox.on = false;
        }
    });

    it('refuses before the boot is ready, and answers unavailable without a device', async () => {
        const early = createNativeHostContract({ about: device().host });
        expect((await early.beginStartupPrompts({ installerSource: 'sideload', donationEnabled: false })).ok).toBe(false);
        // A loaded store, then a contract with no device.
        await openContract(device());
        const hostless = createNativeHostContract({});
        value(await hostless.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
        value(await hostless.activate({ writeSafetyReady: true }));
        const answer = await hostless.beginStartupPrompts({ installerSource: 'sideload', donationEnabled: false });
        expect(answer.ok ? null : answer.error.code).toBe('ACTION_FAILED');
        expect((await hostless.startupPromptAction({ id: 'onboarding', action: 'dismiss' })).ok).toBe(false);
    });

    it('previews any prompt for a debug build without reading or writing the device', async () => {
        const bound = device();
        const contract = await openContract(bound);
        for (const id of ['onboarding', 'announcement', 'update-reminder', 'donation']) {
            const prompt = value(await contract.beginStartupPrompts({ installerSource: 'sideload', donationEnabled: false, preview: id })).prompt;
            expect(prompt?.id).toBe(id);
        }
        // RN's update test target: the Play listing for a Play install, View release for an unknown installer.
        const update = value(await contract.beginStartupPrompts({ installerSource: 'play-store', donationEnabled: false, preview: 'update-reminder' })).prompt;
        expect(update).toMatchObject({ announcement: { id: 'update-reminder-99.99.99',
            action: { label: 'Update now', url: 'https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr' } } });
        const unknown = value(await contract.beginStartupPrompts({ installerSource: 'unknown', donationEnabled: false, preview: 'update-reminder' })).prompt;
        expect(unknown).toMatchObject({ announcement: { action: { label: 'View release', url: 'https://github.com/dongdongbh/Mindwtr/releases/latest' } } });
        expect([...bound.storage.keys()]).toEqual([]);
        expect(bound.fetched).toEqual([]);
        expect((await contract.beginStartupPrompts({ installerSource: 'sideload', donationEnabled: false, preview: 'other' })).ok).toBe(false);
    });

    it('refuses malformed input', async () => {
        const contract = await openContract(device());
        expect((await contract.beginStartupPrompts({ installerSource: 'market', donationEnabled: false })).ok).toBe(false);
        expect((await contract.beginStartupPrompts({ installerSource: 'sideload' })).ok).toBe(false);
        expect((await contract.startupPromptAction({ id: 'donation', action: 'open' })).ok).toBe(false);
    });
    // Last: the store keeps this run's task ids, so a later empty library would be refused as a partial save.
    it('never offers the welcome sheet over data', async () => {
        const contract = await openContract(device());
        await useTaskStore.getState().addTask('Task');
        await flushPendingSave();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        expect(await begin(contract, {})).toBeNull();
    });
});
