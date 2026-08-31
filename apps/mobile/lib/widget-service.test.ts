import type { ReactElement } from 'react';
import type { AppData } from '@mindwtr/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMobileWidgetRenderCache, updateMobileWidgetFromData } from './widget-service';
import { setExpoGoProbeForTests } from './expo-go';

const {
    mockAsyncStorageGetItem,
    mockIosWidgetReloadTimelines,
    mockIosWidgetSetItem,
    mockPlatform,
    mockRequestWidgetUpdate,
} = vi.hoisted(() => ({
    mockAsyncStorageGetItem: vi.fn(),
    mockIosWidgetReloadTimelines: vi.fn(),
    mockIosWidgetSetItem: vi.fn(),
    mockPlatform: {
        OS: 'android',
    },
    mockRequestWidgetUpdate: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: mockPlatform,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: mockAsyncStorageGetItem,
    },
}));

vi.mock('react-native-android-widget', () => ({
    FlexWidget: 'FlexWidget',
    TextWidget: 'TextWidget',
    requestWidgetUpdate: mockRequestWidgetUpdate,
}));

vi.mock('react-native-widgetkit', () => ({
    reloadTimelines: mockIosWidgetReloadTimelines,
    setItem: mockIosWidgetSetItem,
}));

type WidgetElement = ReactElement<{
    children?: WidgetElement | WidgetElement[];
    text?: string;
}>;

const asWidgetChildren = (children: WidgetElement['props']['children']): WidgetElement[] => {
    if (!children) return [];
    return Array.isArray(children) ? children : [children];
};

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

const countRenderedTaskRows = (tree: WidgetElement): number => {
    const [content] = asWidgetChildren(tree.props.children);
    const contentChildren = content ? asWidgetChildren(content.props.children) : [];
    return contentChildren.filter((child) => {
        const text = child.props.text;
        return typeof text === 'string' && text.startsWith('• ');
    }).length;
};

describe('widget-service', () => {
    beforeEach(() => {
        mockPlatform.OS = 'android';
        mockAsyncStorageGetItem.mockReset();
        mockAsyncStorageGetItem.mockResolvedValue(null);
        mockIosWidgetReloadTimelines.mockReset();
        mockIosWidgetSetItem.mockReset();
        mockRequestWidgetUpdate.mockReset();
        resetMobileWidgetRenderCache();
    });

    it('never calls the Android widget bridge inside Expo Go, where the package cannot be linked', async () => {
        setExpoGoProbeForTests(() => true);
        try {
            await updateMobileWidgetFromData(buildData(3));
            expect(mockRequestWidgetUpdate).not.toHaveBeenCalled();
        } finally {
            setExpoGoProbeForTests(null);
        }
    });

    it('skips the native render when nothing any widget shows changed (#766)', async () => {
        const data = buildData(3);
        expect(await updateMobileWidgetFromData(data)).toBe(true);
        expect(mockRequestWidgetUpdate).toHaveBeenCalledTimes(1);

        expect(await updateMobileWidgetFromData({ ...data, tasks: data.tasks.map((task) => ({ ...task })) })).toBe(true);
        expect(mockRequestWidgetUpdate).toHaveBeenCalledTimes(1);

        const changed = {
            ...data,
            tasks: data.tasks.map((task, index) => (index === 0 ? { ...task, title: 'Renamed' } : task)),
        };
        expect(await updateMobileWidgetFromData(changed)).toBe(true);
        expect(mockRequestWidgetUpdate).toHaveBeenCalledTimes(2);
    });

    it('uses Android widget height to render more rows during app-driven updates', async () => {
        let renderedTree: WidgetElement | null = null;
        mockRequestWidgetUpdate.mockImplementation(async ({ renderWidget }) => {
            renderedTree = await renderWidget({
                widgetName: 'TasksWidget',
                widgetId: 1,
                height: 320,
                width: 250,
                screenInfo: {
                    screenHeightDp: 800,
                    screenWidthDp: 400,
                    density: 2,
                    densityDpi: 320,
                },
            });
        });

        const didUpdate = await updateMobileWidgetFromData(buildData());

        expect(didUpdate).toBe(true);
        expect(mockRequestWidgetUpdate).toHaveBeenCalledTimes(1);
        expect(renderedTree).not.toBeNull();
        if (!renderedTree) {
            throw new Error('Expected Android widget render tree');
        }
        expect(countRenderedTaskRows(renderedTree)).toBe(5);
    });

    it('fills more of a default-height Android widget before falling back to +N more', async () => {
        let renderedTree: WidgetElement | null = null;
        mockRequestWidgetUpdate.mockImplementation(async ({ renderWidget }) => {
            renderedTree = await renderWidget({
                widgetName: 'TasksWidget',
                widgetId: 1,
                height: 180,
                width: 250,
                screenInfo: {
                    screenHeightDp: 800,
                    screenWidthDp: 400,
                    density: 2,
                    densityDpi: 320,
                },
            });
        });

        const didUpdate = await updateMobileWidgetFromData(buildData(6));

        expect(didUpdate).toBe(true);
        expect(renderedTree).not.toBeNull();
        if (!renderedTree) {
            throw new Error('Expected Android widget render tree');
        }
        expect(countRenderedTaskRows(renderedTree)).toBe(5);
    });

    it('uses a compact Android widget layout for narrow 2x3 widgets', async () => {
        let renderedTree: WidgetElement | null = null;
        mockRequestWidgetUpdate.mockImplementation(async ({ renderWidget }) => {
            renderedTree = await renderWidget({
                widgetName: 'TasksWidget',
                widgetId: 1,
                height: 180,
                width: 180,
                screenInfo: {
                    screenHeightDp: 800,
                    screenWidthDp: 400,
                    density: 2,
                    densityDpi: 320,
                },
            });
        });

        const didUpdate = await updateMobileWidgetFromData(buildData(6));

        expect(didUpdate).toBe(true);
        expect(renderedTree).not.toBeNull();
        if (!renderedTree) {
            throw new Error('Expected Android widget render tree');
        }
        expect(countRenderedTaskRows(renderedTree)).toBe(4);
    });

    it('renders fewer rows for the shorter default 2x2 Android widget size', async () => {
        let renderedTree: WidgetElement | null = null;
        mockRequestWidgetUpdate.mockImplementation(async ({ renderWidget }) => {
            renderedTree = await renderWidget({
                widgetName: 'TasksWidget',
                widgetId: 1,
                height: 120,
                width: 180,
                screenInfo: {
                    screenHeightDp: 800,
                    screenWidthDp: 400,
                    density: 2,
                    densityDpi: 320,
                },
            });
        });

        const didUpdate = await updateMobileWidgetFromData(buildData(6));

        expect(didUpdate).toBe(true);
        expect(renderedTree).not.toBeNull();
        if (!renderedTree) {
            throw new Error('Expected Android widget render tree');
        }
        expect(countRenderedTaskRows(renderedTree)).toBe(2);
    });

    it('writes family-specific iOS payloads with per-size item budgets', async () => {
        mockPlatform.OS = 'ios';
        mockIosWidgetSetItem.mockResolvedValue(undefined);

        const didUpdate = await updateMobileWidgetFromData(buildData(30));

        expect(didUpdate).toBe(true);
        expect(mockRequestWidgetUpdate).not.toHaveBeenCalled();
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
});
