import { type AppData, loadTranslations, resolveAreaFilterSelection } from '@mindwtr/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildWidgetPayload } from './widget-data';
import { resetFocusWidgetFilter, setFocusWidgetFilter } from './focus-widget-filter';
import { resetMobileWidgetRenderCache, updateMobileWidgetFromData, updateMobileWidgetFromStore } from './widget-service';

const {
    mockAsyncStorageGetItem,
    mockAsyncStorageSetItem,
    mockGetSystemColorSchemeForWidget,
    mockIosWidgetReloadTimelines,
    mockIosWidgetSetItem,
    mockPlatform,
    mockAndroidWidgetGetWidgetListSelections,
    mockAndroidWidgetIsSupported,
    mockAndroidWidgetSetPayload,
    mockAndroidWidgetUpdateWidgets,
    mockLogError,
    mockLogInfo,
    mockLogWarn,
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
    mockAndroidWidgetGetWidgetListSelections: vi.fn(() => [] as string[]),
    mockAndroidWidgetIsSupported: vi.fn(() => true),
    mockAndroidWidgetSetPayload: vi.fn(),
    mockAndroidWidgetUpdateWidgets: vi.fn<() => ReturnType<typeof import('../modules/android-widget').updateWidgets>>(() => undefined),
    mockLogError: vi.fn(),
    mockLogInfo: vi.fn(),
    mockLogWarn: vi.fn(),
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
        resolveAreaFilterSelection: vi.fn(actual.resolveAreaFilterSelection),
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
    getWidgetListSelections: mockAndroidWidgetGetWidgetListSelections,
    isSupported: mockAndroidWidgetIsSupported,
    setPayload: mockAndroidWidgetSetPayload,
    updateWidgets: mockAndroidWidgetUpdateWidgets,
}));

vi.mock('./app-log', () => ({
    logError: mockLogError,
    logInfo: mockLogInfo,
    logWarn: mockLogWarn,
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
        mockAndroidWidgetGetWidgetListSelections.mockReset();
        mockAndroidWidgetGetWidgetListSelections.mockReturnValue([]);
        mockAndroidWidgetSetPayload.mockReset();
        mockAndroidWidgetUpdateWidgets.mockReset();
        mockAndroidWidgetUpdateWidgets.mockReturnValue(undefined);
        mockLogError.mockReset();
        mockLogInfo.mockReset();
        mockLogWarn.mockReset();
        mockUseTaskStoreGetState.mockReset();
        // app-log's isLoggingEnabled reads useTaskStore.getState().settings on
        // every log call; give it a safe default even in tests that never call
        // updateMobileWidgetFromStore (which overrides this per-test).
        mockUseTaskStoreGetState.mockReturnValue({ settings: {} });
        vi.mocked(buildWidgetPayload).mockClear();
        vi.mocked(resolveAreaFilterSelection).mockClear();
        resetFocusWidgetFilter();
        resetMobileWidgetRenderCache();
    });

    it('never calls the native module when it is not linked (Expo Go)', async () => {
        mockAndroidWidgetIsSupported.mockReturnValue(false);

        expect(await updateMobileWidgetFromData(buildData(3))).toBe(false);

        expect(mockAndroidWidgetSetPayload).not.toHaveBeenCalled();
        expect(mockAndroidWidgetUpdateWidgets).not.toHaveBeenCalled();
    });

    it('republishes native audio availability when only the speech setting changes (#1184)', async () => {
        const data = buildData(3);
        await updateMobileWidgetFromData(data);
        expect(JSON.parse(mockAndroidWidgetSetPayload.mock.calls.at(-1)![0]).quickCapture.audioEnabled).toBe(false);

        const enabled: AppData = {
            ...data,
            settings: { ai: { speechToText: { enabled: true, provider: 'whisper' } } },
        };
        await updateMobileWidgetFromData(enabled);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(2);
        expect(JSON.parse(mockAndroidWidgetSetPayload.mock.calls.at(-1)![0]).quickCapture).toMatchObject({
            audioEnabled: true,
            audioRecord: 'Start recording',
            audioStop: 'Stop recording',
            audioSaved: 'Saved. Audio will be transcribed when you open Mindwtr.',
        });

        await updateMobileWidgetFromData(data);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(3);
        expect(JSON.parse(mockAndroidWidgetSetPayload.mock.calls.at(-1)![0]).quickCapture.audioEnabled).toBe(false);
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

    it('publishes an honestly capped Android Focus + Today payload, then refreshes', async () => {
        const data = buildData(15);
        const now = new Date().toISOString();
        data.tasks.push(...Array.from({ length: 15 }, (_, index) => ({
            id: `today-${index + 1}`,
            title: `Today ${index + 1}`,
            status: 'next' as const,
            dueDate: '2000-01-01',
            tags: [],
            contexts: [],
            createdAt: now,
            updatedAt: now,
        })));

        expect(await updateMobileWidgetFromData(data)).toBe(true);

        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(1);
        expect(mockAndroidWidgetUpdateWidgets).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(mockAndroidWidgetSetPayload.mock.calls[0][0] as string);
        expect(payload.items).toHaveLength(20);
        expect(payload.items[0]).toMatchObject({ title: 'Focused 1', dueLabel: null, dueEmphasis: false });
        expect(payload.sections.map((section: { key: string; items: unknown[] }) => [section.key, section.items.length]))
            .toEqual([['focus', 15], ['schedule', 5]]);
        expect(payload.sections.flatMap((section: { items: { id: string }[] }) => section.items.map((item) => item.id)))
            .toEqual(payload.items.map((item: { id: string }) => item.id));
        expect(payload.lists.focus.items).toHaveLength(20);
        expect(payload.lists.focus.sections.flatMap((section: { items: unknown[] }) => section.items)).toHaveLength(20);
        expect(payload.subtitle).toBe('Inbox: 0 · +10 More');
        expect(payload.inboxLabel).toBe('Inbox');
        expect(payload.inboxCount).toBe(0);
        expect(payload.focusUri).toBe('mindwtr:///focus');
        expect(payload.palette.background).toMatch(/^#/);
        expect(payload.quickCapture).toMatchObject({
            title: 'Quick capture',
            placeholder: 'Add task to inbox...',
            save: 'Save',
            cancel: 'Cancel',
            added: 'Task added to Mindwtr.',
        });
        expect(mockLogInfo).toHaveBeenCalledWith('Android widget Focus and Today payload published', {
            scope: 'widget',
            extra: {
                releaseCheck: 'v1.3.0/widget-focus-today',
                focusItems: '15',
                todayItems: '5',
                totalItems: '20',
            },
        });
    });

    it('logs the number of legacy provider widgets refreshed by the native update', async () => {
        mockAndroidWidgetUpdateWidgets.mockReturnValue(2);

        expect(await updateMobileWidgetFromData(buildData(3))).toBe(true);

        expect(mockLogInfo).toHaveBeenCalledWith('Legacy Android Tasks widgets refreshed', {
            scope: 'widget',
            extra: {
                releaseCheck: 'v1.3.0/android-widget-provider-compat',
                legacyWidgetCount: '2',
            },
        });
    });

    it('logs compact refreshes from the native result alongside legacy widgets', async () => {
        mockAndroidWidgetUpdateWidgets.mockReturnValue({ legacyWidgetCount: 2, compactWidgetCount: 1 });
        expect(await updateMobileWidgetFromData(buildData(3))).toBe(true);
        expect(mockLogInfo).toHaveBeenCalledWith('Compact Android widgets refreshed', {
            scope: 'widget',
            extra: { releaseCheck: 'v1.3.0/android-compact-widget', count: '1' },
        });
        expect(mockLogInfo).toHaveBeenCalledWith('Legacy Android Tasks widgets refreshed', {
            scope: 'widget',
            extra: { releaseCheck: 'v1.3.0/android-widget-provider-compat', legacyWidgetCount: '2' },
        });
    });

    it('carries every GTD list once a widget is placed so the header chooser switches without the app (#1173)', async () => {
        const data = buildData(2);
        data.tasks.push({ id: 'w1', title: 'Waiting on Sam', status: 'waiting', tags: [], contexts: [], createdAt: data.tasks[0].createdAt, updatedAt: data.tasks[0].updatedAt });
        // No widget placed: nothing beyond the Focus list is worth building.
        expect(await updateMobileWidgetFromData(data)).toBe(true);
        expect(Object.keys(JSON.parse(mockAndroidWidgetSetPayload.mock.calls[0][0] as string).lists)).toEqual(['focus']);

        mockAndroidWidgetGetWidgetListSelections.mockReturnValue(['waiting', 'project:missing']);
        expect(await updateMobileWidgetFromData(data)).toBe(true);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(2);
        const payload = JSON.parse(mockAndroidWidgetSetPayload.mock.calls[1][0] as string);
        expect(Object.keys(payload.lists)).toEqual(['focus', 'inbox', 'next', 'waiting', 'someday']);
        expect(payload.lists.waiting).toMatchObject({ title: 'Waiting For', items: [{ title: 'Waiting on Sam' }] });
        expect(payload.listTitles).toMatchObject({ inbox: 'Inbox', next: 'Next Actions', someday: 'Someday/Maybe' });
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
        const data = buildData(30);

        const didUpdate = await updateMobileWidgetFromData(data);

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
        expect(Object.keys(payloadByKey.get('mindwtr-ios-widget-payload')?.lists)).toEqual(['focus', 'inbox', 'next', 'waiting', 'someday']);
        expect(payloadByKey.get('mindwtr-ios-widget-payload-small')?.lists.focus.items).toHaveLength(3);
        expect(mockIosWidgetReloadTimelines).toHaveBeenCalledWith('MindwtrTasksWidget');
        expect(mockIosWidgetReloadTimelines).toHaveBeenCalledWith('MindwtrCompactWidget');
        expect(mockIosWidgetReloadTimelines).toHaveBeenCalledWith('MindwtrFocusLockWidget');
        expect(mockLogInfo).toHaveBeenCalledWith('iOS widget family payloads published from one derivation', {
            scope: 'widget',
            extra: { releaseCheck: 'v1.3.0/widget-batch-derivation', count: 5 },
        });
        expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain('Focused 1');

        const listIds = ['focus', 'inbox', 'next', 'waiting', 'someday'];
        const expectedFamilies = new Map([
            ['mindwtr-ios-widget-payload', 12],
            ['mindwtr-ios-widget-payload-small', 3],
            ['mindwtr-ios-widget-payload-medium', 5],
            ['mindwtr-ios-widget-payload-large', 12],
            ['mindwtr-ios-widget-payload-extra-large', 24],
        ].map(([key, maxItems]) => [key, JSON.stringify(buildWidgetPayload(data, 'en', {
            systemColorScheme: 'light',
            maxItems: maxItems as number,
            listIds,
            includeSavedFilterLists: true,
        }))]));
        for (const [key, expected] of expectedFamilies) {
            expect(mockIosWidgetSetItem.mock.calls.find(([writtenKey]) => writtenKey === key)?.[1]).toBe(expected);
        }

        const snapshot = payloadByKey.get('mindwtr-ios-shortcuts-snapshot');
        expect(snapshot.lists.next.length).toBeGreaterThan(0);
        expect(snapshot.lists.inbox).toEqual([]);
        expect(typeof snapshot.generatedAt).toBe('string');
    });

    it('derives task selection once for an iOS family publication', async () => {
        mockPlatform.OS = 'ios';
        mockIosWidgetSetItem.mockResolvedValue(undefined);
        const data = buildData(60);

        expect(await updateMobileWidgetFromData(data)).toBe(true);

        expect(mockIosWidgetSetItem).toHaveBeenCalledTimes(6);
        expect(vi.mocked(resolveAreaFilterSelection)).toHaveBeenCalledTimes(1);

        mockIosWidgetSetItem.mockClear();
        vi.mocked(resolveAreaFilterSelection).mockClear();
        expect(await updateMobileWidgetFromData({
            ...data,
            tasks: data.tasks.map((task) => ({ ...task })),
        })).toBe(true);
        expect(mockIosWidgetSetItem).not.toHaveBeenCalled();
        expect(vi.mocked(resolveAreaFilterSelection)).toHaveBeenCalledTimes(1);
    });

    it('retries all iOS families after a failed family write without republishing Shortcuts', async () => {
        mockPlatform.OS = 'ios';
        mockIosWidgetSetItem.mockRejectedValueOnce(new Error('widget host busy'));
        const data = buildData(5);

        expect(await updateMobileWidgetFromData(data)).toBe(false);
        expect(mockIosWidgetSetItem.mock.calls.map(([key]) => key)).toEqual([
            'mindwtr-ios-widget-payload',
            'mindwtr-ios-shortcuts-snapshot',
        ]);
        expect(mockLogInfo).not.toHaveBeenCalledWith(
            'iOS widget family payloads published from one derivation',
            expect.anything(),
        );

        mockIosWidgetSetItem.mockClear();
        expect(await updateMobileWidgetFromData(data)).toBe(true);
        expect(mockIosWidgetSetItem).toHaveBeenCalledTimes(5);
        expect(mockIosWidgetSetItem.mock.calls.map(([key]) => key))
            .not.toContain('mindwtr-ios-shortcuts-snapshot');
        expect(mockLogInfo).toHaveBeenCalledWith('iOS widget family payloads published from one derivation', {
            scope: 'widget',
            extra: { releaseCheck: 'v1.3.0/widget-batch-derivation', count: 5 },
        });
    });

    it('invalidates the store-level iOS projection for language, day and Focus-filter changes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-12T12:00:00-04:00'));
        mockPlatform.OS = 'ios';
        let language = 'en';
        mockAsyncStorageGetItem.mockImplementation(async (key: string) => (
            key === 'mindwtr-language' ? language : null
        ));
        const data = buildData(5);
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

        try {
            expect(await updateMobileWidgetFromStore()).toBe(true);

            mockIosWidgetSetItem.mockClear();
            language = 'de';
            await loadTranslations('de');
            expect(await updateMobileWidgetFromStore()).toBe(true);
            expect(mockIosWidgetSetItem).toHaveBeenCalledTimes(5);

            mockIosWidgetSetItem.mockClear();
            vi.setSystemTime(new Date('2026-09-13T12:00:00-04:00'));
            expect(await updateMobileWidgetFromStore()).toBe(true);
            expect(mockIosWidgetSetItem).toHaveBeenCalledTimes(5);

            mockIosWidgetSetItem.mockClear();
            setFocusWidgetFilter({ criteria: { contexts: ['@office'] }, sortBy: 'default' });
            expect(await updateMobileWidgetFromStore()).toBe(true);
            expect(mockIosWidgetSetItem).toHaveBeenCalledTimes(5);
        } finally {
            resetFocusWidgetFilter();
            vi.useRealTimers();
        }
    });

    it('publishes bounded saved-filter lists for the iOS Edit Widget picker', async () => {
        mockPlatform.OS = 'ios';
        const data = buildData(10);
        data.settings.savedFilters = [{
            id: 'focused', name: 'My list', view: 'next', criteria: {},
            createdAt: '2026-09-11T12:00:00Z', updatedAt: '2026-09-11T12:00:00Z',
        }];
        expect(await updateMobileWidgetFromData(data)).toBe(true);
        const payload = JSON.parse(mockIosWidgetSetItem.mock.calls.find(([key]) => key === 'mindwtr-ios-widget-payload-small')![1]);
        expect(payload.savedFilters).toEqual([{ id: 'focused', name: 'My list' }]);
        expect(payload.lists['filter:focused'].items).toHaveLength(3);
        expect(payload.lists['filter:focused'].title).toBe('My list');
        expect(payload.lists['filter:focused'].items.every((item: { completionToken?: string }) => !!item.completionToken)).toBe(true);
    });

    it('refreshes only the iOS shortcuts snapshot when a change is invisible to the widget, skipping widget writes and reload (#980 correction)', async () => {
        mockPlatform.OS = 'ios';
        mockIosWidgetSetItem.mockResolvedValue(undefined);

        const data = buildData(2);
        await updateMobileWidgetFromData(data);
        mockIosWidgetSetItem.mockClear();
        mockIosWidgetReloadTimelines.mockClear();

        // A deferred, unstarred Next task is outside the curated widget lists,
        // but still rides the independently fingerprinted Shortcuts snapshot.
        const withDeferredTask: AppData = {
            ...data,
            tasks: [
                ...data.tasks,
                {
                    id: 'deferred-1',
                    title: 'Later task',
                    status: 'next',
                    tags: [],
                    contexts: [],
                    startTime: '2099-01-01',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
            ],
        };
        await updateMobileWidgetFromData(withDeferredTask);

        // Only the snapshot key was written -- the widget's own fingerprint
        // didn't change, so its five setItem calls and reloadTimelines must be
        // skipped (restoring the #766 skip the shared fingerprint broke).
        expect(mockIosWidgetSetItem).toHaveBeenCalledTimes(1);
        expect(mockIosWidgetReloadTimelines).not.toHaveBeenCalled();
        const [key, value] = mockIosWidgetSetItem.mock.calls[0] as [string, string];
        expect(key).toBe('mindwtr-ios-shortcuts-snapshot');
        expect(JSON.parse(value).lists.next).toHaveLength(3);
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
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(2);
        expect(mockAndroidWidgetSetPayload).toHaveBeenCalledTimes(1);

        // Repeated call, nothing changed: gate 0 must skip the payload build
        // entirely, before the JSON fingerprint gate even runs.
        expect(await updateMobileWidgetFromStore()).toBe(true);
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(2);
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
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(4);
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
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(2);

        // Retry with unchanged inputs (the immediate + 800ms pair callers
        // use): gate 0 must not have cached the failed render, so the
        // payload is built and the native call attempted again.
        mockAndroidWidgetSetPayload.mockReset();
        expect(await updateMobileWidgetFromStore()).toBe(true);
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(4);
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
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(2);

        // Same store state, but the system flips to dark mode: gate 0's key
        // must include the colour scheme so this is not treated as unchanged.
        mockGetSystemColorSchemeForWidget.mockReturnValue('dark');
        expect(await updateMobileWidgetFromStore()).toBe(true);
        expect(vi.mocked(buildWidgetPayload)).toHaveBeenCalledTimes(4);
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
