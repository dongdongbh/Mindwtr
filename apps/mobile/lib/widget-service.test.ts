import type { ReactElement } from 'react';
import type { AppData } from '@mindwtr/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { updateMobileWidgetFromData } from './widget-service';

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
        expect(countRenderedTaskRows(renderedTree)).toBe(4);
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
        expect(countRenderedTaskRows(renderedTree)).toBe(3);
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

    it('writes family-specific iOS payloads using adaptive task limits', async () => {
        mockPlatform.OS = 'ios';
        mockIosWidgetSetItem.mockResolvedValue(undefined);

        const didUpdate = await updateMobileWidgetFromData(buildData(9));

        expect(didUpdate).toBe(true);
        expect(mockRequestWidgetUpdate).not.toHaveBeenCalled();
        expect(mockIosWidgetSetItem).toHaveBeenCalledTimes(4);
        const payloadByKey = new Map(
            mockIosWidgetSetItem.mock.calls.map(([key, value]) => [key, JSON.parse(value as string)])
        );
        expect(payloadByKey.get('mindwtr-ios-widget-payload-small')?.items).toHaveLength(3);
        expect(payloadByKey.get('mindwtr-ios-widget-payload-medium')?.items).toHaveLength(5);
        expect(payloadByKey.get('mindwtr-ios-widget-payload-large')?.items).toHaveLength(8);
        expect(payloadByKey.get('mindwtr-ios-widget-payload')?.items).toHaveLength(5);
        expect(mockIosWidgetReloadTimelines).toHaveBeenCalledWith('MindwtrTasksWidget');
    });
});
