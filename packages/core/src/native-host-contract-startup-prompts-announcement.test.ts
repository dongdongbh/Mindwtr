import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract, type NativeAboutHost, type NativeHostResult } from './native-host-contract';
import { MOBILE_ONBOARDING_STORAGE_KEY } from './first-run-onboarding';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';

// A maintainer announcement (ACTIVE_APP_ANNOUNCEMENT is null in the shipped code), so its window and dismissal can be pinned.
vi.mock('./announcements', async (importOriginal) => ({
    ...await importOriginal<typeof import('./announcements')>(),
    ACTIVE_APP_ANNOUNCEMENT: { id: 'v1.4-notes', title: 'What is new', body: 'Notes', action: { type: 'feedback', label: 'Tell us' } },
}));

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

describe('native host contract: the maintainer announcement', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('opens over the update and donation prompts and stores its dismissal under RN\'s key', async () => {
        const storage = new Map<string, string>([[MOBILE_ONBOARDING_STORAGE_KEY, 'dismissed']]);
        const host = {
            app: { appName: 'Mindwtr', version: '1.3.4', releaseVersion: '', build: '154', packageName: 'tech.dongdongbh.mindwtr', isFossBuild: false,
                isDev: false, platform: 'android', platformVersion: 34, osRelease: '14', feedbackEndpointUrl: '', analyticsHeartbeatUrl: '', analyticsHeartbeatChannel: '' },
            storage: {
                getItem: async (key: string) => storage.get(key) ?? null,
                setItem: async (key: string, next: string) => { storage.set(key, next); },
                removeItem: async (key: string) => { storage.delete(key); },
            },
            fetcher: async () => { throw new Error('no network'); },
            locale: () => 'en-US',
            generateId: () => 'made-id',
            feedbackDiagnostics: async () => null,
            logWarn: () => undefined,
            logInfo: () => undefined,
        } as unknown as NativeAboutHost;
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
        const contract = createNativeHostContract({ about: host });
        value(await contract.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' }));
        value(await contract.activate({ writeSafetyReady: true }));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const run = contract.beginStartupPrompts({ installerSource: 'sideload', donationEnabled: true });
        await vi.runAllTimersAsync();
        expect(value(await run).prompt).toMatchObject({ id: 'announcement', announcement: { id: 'v1.4-notes', title: 'What is new' } });
        value(await contract.startupPromptAction({ id: 'announcement', action: 'act' }));
        expect(storage.get('mindwtr:announcement-dismissed:v1.4-notes')).toBe('dismissed');
    });
});
