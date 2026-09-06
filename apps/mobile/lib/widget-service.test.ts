import { type AppData, loadTranslations } from '@mindwtr/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildWidgetPayload } from './widget-data';
import { resetMobileWidgetRenderCache, updateMobileWidgetFromData, updateMobileWidgetFromStore } from './widget-service';

const {
    mockAsyncStorageGetItem,
    mockAsyncStorageSetItem,
    mockGetSystemColorSchemeForWidget,
    mockIosWidgetReloadTimelines,
    mockIosWidgetSetItem,
    mockPlatform,
    mockAndroidWidgetIsSupported,
    mockAndroidWidgetSetPayload,
    mockAndroidWidgetUpdateWidgets,
    mockUseTaskStoreGetState,
} = vi.hoisted(() => ({
    mockAsyncStorageGetItem: vi.fn(),
    mockAsyncStorageSetItem: vi.fn(),
    mockGetSystemColorSchemeForWidget: vi.fn(() => 'light' as 'light' | 'dark' | undefined),
    mockIosWidgetReloadTimelines: vi.fn(),
    mockIosWidgetSetItem: vi.fn(),
    mockPlatform: {
        OS: 'android',
    },
    mockAndroidWidgetIsSupported: vi.fn(() => true),
    mockAndroidWidgetSetPayload: vi.fn(),
    mockAndroidWidgetUpdateWidgets: vi.fn(),
    mockUseTaskStoreGetState: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: mockPlatform,
}));

vi.mock('expo-constants', () => ({
    __esModule: true,
    default: { expoConfig: { version: '1.0.0' } },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: mockAsyncStorageGetItem,
        setItem: mockAsyncStorageSetItem,
    },
}));

// Only useTaskStore.getState is replaced -- widget-data.ts pulls real logic
// (sortTasksBy, isTaskActionable, translations, ...) from the rest of
// '@mindwtr/core' and must keep using it.
vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return {
        ...actual,
        useTaskStore: { getState: mockUseTaskStoreGetState },
    };
});

// Real buildWidgetPayload, wrapped so gate 0 (the store-level pre-check) can
// be asserted by call count instead of only by its native-render side effect.
vi.mock('./widget-data', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./widget-data')>();
    return {
        ...actual,
        buildWidgetPayload: vi.fn(actual.buildWidgetPayload),
    };
});

vi.mock('../modules/android-widget', () => ({
    isSupported: mockAndroidWidgetIsSupported,
    setPayload: mockAndroidWidgetSetPayload,
    updateWidgets: mockAndroidWidgetUpdateWidgets,
}));

vi.mock('react-native-widgetkit', () => ({
    reloadTimelines: mockIosWidgetReloadTimelines,
    setItem: mockIosWidgetSetItem,
}));

// Controllable per-test so gate 0's colour-scheme key (correction #2) can be
// flipped without a real Appearance/NativeModules mock.
vi.mock('./system-color-scheme', () => ({
    getSystemColorSchemeForWidget: mockGetSystemColorSchemeForWidget,
}));

const buildData = (taskCount = 5): AppData => {
    const now = new Date().toISOString();
    return {
        tasks: Array.from({ length: taskCount }, (_, index) => ({
            id: String(index + 1),
            title: `Focused ${index + 1}`,
            status: 'next',
            isFocusedToday: true,
            tags: [],
            contexts: [],
            createdAt: now,
            updatedAt: now,
        })),
        projects: [],
        areas: [],
        sections: [],
        settings: {},
    };
};

describe('widget-service', () => {
    beforeEach(() => {
        mockPlatform.OS = 'android';
        mockAsyncStorageGetItem.mockReset();
        mockAsyncStorageGetItem.mockResolvedValue(null);
        mockAsyncStorageSetItem.mockReset();
        mockAsyncStorageSetItem.mockResolvedValue(undefined);
        mockGetSystemColorSchemeForWidget.mockReset();
        mockGetSystemColorSchemeForWidget.mockReturnValue('light');
        mockIosWidgetReloadTimelines.mockReset();
        mockIosWidgetSetItem.mockReset();
        mockAndroidWidgetIsSupported.mockReset();
        mockAndroidWidgetIsSupported.mockReturnValue(true);
        mockAndroidWidgetSetPayload.mockReset();
        mockAndroidWidgetUpdateWidgets.mockReset();
        mockUseTaskStoreGetState.mockReset();
        // app-log's isLoggingEnabled reads useTaskStore.getState().settings on
        // every log call; give it a safe default even in tests that never call
        // updateMobileWidgetFromStore (which overrides this per-test).
        mockUseTaskStoreGetState.mockReturnValue({ settings: {} });
        vi.mocked(buildWidgetPayload).mockClear();
        resetMobileWidgetRenderCache();
    });

    it('never calls the native module when it is not linked (Expo Go)', async () => {
        mockAndroidWidgetIsSupported.mockReturnValue(false);

        expect(await updateMobileWidgetFromData(buildData(3))).toBe(false);

        expect(mockAndroidWidgetSetPayload).not.toHaveBeenCalled();
        expect(mockAndroidWidgetUpdateWidgets).not.toHaveBeenCalled();
    });

    it('skips the native render when nothing any widget shows changed (#766)', async () => {
        const data = buildData(3);
        expect(await updateMobileWidgetFromData(data)).toBe(true);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(1);

        expect(await updateMobileWidgetFromData({ ...data, tasks: data.tasks.map((task) => ({ ...task })) })).toBe(true);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(1);

        const changed = {
            ...data,
            tasks: data.tasks.map((task, index) => (index === 0 ? { ...task, title: 'Renamed' } : task)),
        };
        expect(await updateMobileWidgetFromData(changed)).toBe(true);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(2);
    });

    it('publishes one Android payload with the shared shape, the capture dialog labels and a scrolling item slice, then refreshes', async () => {
        expect(await updateMobileWidgetFromData(buildData(30))).toBe(true);

        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(1);
        expect(mockAndroidWidgetUpdateWidgets).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(mockAndroidWidgetSetPayload.mock.calls[0][0] as string);
        expect(payload.items).toHaveLength(20);
        expect(payload.items[0]).toMatchObject({ title: 'Focused 1', dueLabel: null, dueEmphasis: false });
        expect(payload.inboxLabel).toBe('Inbox');
        expect(payload.inboxCount).toBe(0);
        expect(payload.focusUri).toBe('mindwtr:///focus');
        expect(payload.palette.background).toMatch(/^#/);
        expect(payload.quickCapture).toEqual({
            title: 'Quick capture',
            placeholder: 'Add task to inbox...',
            save: 'Save',
            cancel: 'Cancel',
            added: 'Task added to Mindwtr.',
        });
    });

    it('localizes the capture dialog labels with the widget language', async () => {
        await loadTranslations('de');
        mockAsyncStorageGetItem.mockImplementation(async (key: string) => (key === 'mindwtr-language' ? 'de' : null));

        expect(await updateMobileWidgetFromData(buildData(1))).toBe(true);

        const payload = JSON.parse(mockAndroidWidgetSetPayload.mock.calls[0][0] as string);
        expect(payload.quickCapture.cancel).toBe('Abbrechen');
        expect(payload.quickCapture.save).toBe('Speichern');
    });

    it('writes family-specific iOS payloads with per-size item budgets', async () => {
        mockPlatform.OS = 'ios';
        mockIosWidgetSetItem.mockResolvedValue(undefined);

        const didUpdate = await updateMobileWidgetFromData(buildData(30));

        expect(didUpdate).toBe(true);
        expect(mockAndroidWidgetSetPayload).not.toHaveBeenCalled();
        expect(mockIosWidgetSetItem).toHaveBeenCalledTimes(6);
        const payloadByKey = new Map(
            mockIosWidgetSetItem.mock.calls.map(([key, value]) => [key, JSON.parse(value as string)])
        );
        expect(payloadByKey.get('mindwtr-ios-widget-payload-small')?.items).toHaveLength(3);
        expect(payloadByKey.get('mindwtr-ios-widget-payload-medium')?.items).toHaveLength(5);
        expect(payloadByKey.get('mindwtr-ios-widget-payload-large')?.items).toHaveLength(12);
        expect(payloadByKey.get('mindwtr-ios-widget-payload-extra-large')?.items).toHaveLength(24);
        expect(payloadByKey.get('mindwtr-ios-widget-payload')?.items).toHaveLength(12);
        expect(mockIosWidgetReloadTimelines).toHaveBeenCalledWith('MindwtrTasksWidget');
        expect(mockIosWidgetReloadTimelines).toHaveBeenCalledWith('MindwtrFocusLockWidget');

        const snapshot = payloadByKey.get('mindwtr-ios-shortcuts-snapshot');
        expect(snapshot.lists.next.length).toBeGreaterThan(0);
        expect(snapshot.lists.inbox).toEqual([]);
        expect(typeof snapshot.generatedAt).toBe('string');
    });

    it('refreshes only the iOS shortcuts snapshot when a change is invisible to the widget, skipping widget writes and reload (#980 correction)', async () => {
        mockPlatform.OS = 'ios';
        mockIosWidgetSetItem.mockResolvedValue(undefined);

        const data = buildData(2);
        await updateMobileWidgetFromData(data);
        mockIosWidgetSetItem.mockClear();
        mockIosWidgetReloadTimelines.mockClear();

        // A change outside the widget's own visible slice (a waiting-list task,
        // never rendered on the widget) must still refresh the snapshot -- the
        // snapshot has its own fingerprint, independent of the widget's.
        const withWaitingTask: AppData = {
            ...data,
            tasks: [
                ...data.tasks,
                {
                    id: 'waiting-1',
                    title: 'Waiting on reply',
                    status: 'waiting',
                    tags: [],
                    contexts: [],
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
            ],
        };
        await updateMobileWidgetFromData(withWaitingTask);

        // Only the snapshot key was written -- the widget's own fingerprint
        // didn't change, so its five setItem calls and reloadTimelines must be
        // skipped (restoring the #766 skip the shared fingerprint broke).
        expect(mockIosWidgetSetItem).toHaveBeenCalledTimes(1);
        expect(mockIosWidgetReloadTimelines).not.toHaveBeenCalled();
        const [key, value] = mockIosWidgetSetItem.mock.calls[0] as [string, string];
        expect(key).toBe('mindwtr-ios-shortcuts-snapshot');
        expect(JSON.parse(value).lists.waiting).toHaveLength(1);
    });

    it('refreshes only the widget payloads when a change is invisible to the snapshot, skipping the snapshot write (#980 correction)', async () => {
        mockPlatform.OS = 'ios';
        mockIosWidgetSetItem.mockResolvedValue(undefined);

        // 30 starred/next tasks: the widget only shows its top slice, so
        // pushing well past that slice (without changing snapshot content --
        // same tasks, same lists) isn't representative. Instead, change a
        // widget-visible task's title, which alters the widget fingerprint
        // (it's inside the widget's own payload) and also alters the
        // snapshot's "next" list content -- so assert the inverse case: a
        // theme change affects only the widget payload (palette), never the
        // snapshot (it carries no palette).
        const data = buildData(2);
        await updateMobileWidgetFromData(data);
        mockIosWidgetSetItem.mockClear();
        mockIosWidgetReloadTimelines.mockClear();

        const withThemeChange: AppData = { ...data, settings: { ...data.settings, theme: 'nord' } };
        await updateMobileWidgetFromData(withThemeChange);

        expect(mockIosWidgetSetItem).toHaveBeenCalledTimes(5);
        expect(mockIosWidgetReloadTimelines).toHaveBeenCalledWith('MindwtrTasksWidget');
        const keys = mockIosWidgetSetItem.mock.calls.map(([key]) => key);
        expect(keys).not.toContain('mindwtr-ios-shortcuts-snapshot');
    });

    it('skips rebuilding the widget payload via updateMobileWidgetFromStore when lastDataChangeAt/language/day are unchanged', async () => {
        const data = buildData(3);
        const storeState = {
            _allTasks: data.tasks,
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            tasks: data.tasks,
            projects: [],
            sections: [],
            areas: [],
            settings: {},
            lastDataChangeAt: 1,
        };
        mockUseTaskStoreGetState.mockReturnValue(storeState);

        expect(await updateMobileWidgetFromStore()).toBe(true);
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(1);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(1);

        // Repeated call, nothing changed: gate 0 must skip the payload build
        // entirely, before the JSON fingerprint gate even runs.
        expect(await updateMobileWidgetFromStore()).toBe(true);
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(1);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(1);

        // lastDataChangeAt moves and the content actually differs: gate 0 lets
        // the rebuild through, and gate 1 (the JSON fingerprint) sees new
        // content and renders again.
        const changedTasks = data.tasks.map((task, index) => (
            index === 0 ? { ...task, title: 'Renamed' } : task
        ));
        mockUseTaskStoreGetState.mockReturnValue({
            ...storeState,
            _allTasks: changedTasks,
            tasks: changedTasks,
            lastDataChangeAt: 2,
        });
        expect(await updateMobileWidgetFromStore()).toBe(true);
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(2);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(2);
    });

    it('skips the native render when a persisted fingerprint from a prior (cold) module instance matches (#766 follow-up)', async () => {
        const data = buildData(3);

        // First render, from a "cold" instance: persists its fingerprint to
        // AsyncStorage as updateMobileWidgetFromData does after every render.
        await updateMobileWidgetFromData(data);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(1);
        const [, persistedFingerprint] = mockAsyncStorageSetItem.mock.calls.find(
            ([key]) => key === 'mindwtr-widget-render-fingerprint',
        ) as [string, string];
        expect(typeof persistedFingerprint).toBe('string');

        // Simulate a fresh headless instance: module-scope render cache reset,
        // and AsyncStorage now serving the fingerprint persisted above.
        resetMobileWidgetRenderCache();
        mockAndroidWidgetSetPayload.mockClear();
        mockAsyncStorageGetItem.mockImplementation(async (key: string) => (
            key === 'mindwtr-widget-render-fingerprint' ? persistedFingerprint : null
        ));

        expect(await updateMobileWidgetFromData(data)).toBe(true);
        expect(mockAndroidWidgetSetPayload).not.toHaveBeenCalled();
    });

    it('retries the native render after a failed render, even with unchanged inputs (correction #1, blocking)', async () => {
        const data = buildData(3);
        const storeState = {
            _allTasks: data.tasks,
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            tasks: data.tasks,
            projects: [],
            sections: [],
            areas: [],
            settings: {},
            lastDataChangeAt: 1,
        };
        mockUseTaskStoreGetState.mockReturnValue(storeState);
        mockAndroidWidgetSetPayload.mockImplementation(() => { throw new Error('widget host busy'); });

        expect(await updateMobileWidgetFromStore()).toBe(false);
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(1);

        // Retry with unchanged inputs (the immediate + 800ms pair callers
        // use): gate 0 must not have cached the failed render, so the
        // payload is built and the native call attempted again.
        mockAndroidWidgetSetPayload.mockReset();
        expect(await updateMobileWidgetFromStore()).toBe(true);
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('rebuilds the widget payload via updateMobileWidgetFromStore when only the system colour scheme changes (correction #2)', async () => {
        const data = buildData(3);
        const storeState = {
            _allTasks: data.tasks,
            _allProjects: [],
            _allSections: [],
            _allAreas: [],
            tasks: data.tasks,
            projects: [],
            sections: [],
            areas: [],
            settings: {},
            lastDataChangeAt: 1,
        };
        mockUseTaskStoreGetState.mockReturnValue(storeState);

        expect(await updateMobileWidgetFromStore()).toBe(true);
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(1);

        // Same store state, but the system flips to dark mode: gate 0's key
        // must include the colour scheme so this is not treated as unchanged.
        mockGetSystemColorSchemeForWidget.mockReturnValue('dark');
        expect(await updateMobileWidgetFromStore()).toBe(true);
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(2);
    });

    it('renders again when a persisted fingerprint carries a different app version (correction #4)', async () => {
        const data = buildData(3);

        await updateMobileWidgetFromData(data);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(1);
        const [, persistedFingerprint] = mockAsyncStorageSetItem.mock.calls.find(
            ([key]) => key === 'mindwtr-widget-render-fingerprint',
        ) as [string, string];
        expect(typeof persistedFingerprint).toBe('string');

        // The fingerprint's leading `<version>:` segment is the app version
        // this module was built with (mocked to '1.0.0' above); replace it to
        // simulate a value persisted by an older build, keeping the rest (an
        // otherwise byte-identical payload) the same.
        const staleVersionFingerprint = persistedFingerprint.replace('1.0.0:', 'stale-app-version:');
        expect(staleVersionFingerprint).not.toBe(persistedFingerprint);

        resetMobileWidgetRenderCache();
        mockAndroidWidgetSetPayload.mockClear();
        mockAsyncStorageGetItem.mockImplementation(async (key: string) => (
            key === 'mindwtr-widget-render-fingerprint' ? staleVersionFingerprint : null
        ));

        expect(await updateMobileWidgetFromData(data)).toBe(true);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(1);
    });
});
