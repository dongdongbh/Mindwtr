import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import type { TasksWidgetPayload } from '../lib/widget-data';
vi.mock('react-native-android-widget', () => ({
    FlexWidget: 'FlexWidget',
    TextWidget: 'TextWidget',
}));

import { buildTasksWidgetTree } from './TasksWidget';

type WidgetElement = ReactElement<{
    children?: WidgetElement | WidgetElement[];
    text?: string;
    style?: {
        flex?: number;
        fontSize?: number;
    };
}>;

const asWidgetChildren = (children: WidgetElement['props']['children']): WidgetElement[] => {
    if (!children) return [];
    return Array.isArray(children) ? children : [children];
};

const basePayload: TasksWidgetPayload = {
    headerTitle: 'Today',
    subtitle: 'Inbox: 1',
    inboxLabel: 'Inbox',
    inboxCount: 1,
    items: [
        {
            id: 'task-1',
            title: 'Review waiting item',
            statusLabel: 'Next',
        },
    ],
    emptyMessage: 'No tasks',
    captureLabel: 'Quick capture',
    focusUri: 'mindwtr:///focus',
    quickCaptureUri: 'mindwtr:///capture-quick?mode=text',
    palette: {
        background: '#F8FAFC',
        card: '#FFFFFF',
        border: '#CBD5E1',
        text: '#0F172A',
        mutedText: '#475569',
        accent: '#2563EB',
        onAccent: '#FFFFFF',
    },
};

describe('TasksWidget', () => {
    it('uses the larger task title font size in widget rows', () => {
        const tree = buildTasksWidgetTree(basePayload) as WidgetElement;
        const [content] = asWidgetChildren(tree.props.children);
        const contentChildren = content ? asWidgetChildren(content.props.children) : [];
        const taskItem = contentChildren.find(
            (child) => (child as ReactElement<{ text?: string }>).props.text === '• Review waiting item'
        ) as ReactElement<{ style: { fontSize: number } }> | undefined;

        expect(taskItem).toBeDefined();
        expect(taskItem?.props.style.fontSize).toBe(13);
    });

    it('uses a compact layout for narrow Android widgets', () => {
        const tree = buildTasksWidgetTree(basePayload, { layoutMode: 'compact' }) as WidgetElement;
        const children = asWidgetChildren(tree.props.children);
        const [content, spacer, button] = children;
        const contentChildren = content ? asWidgetChildren(content.props.children) : [];
        const taskItem = contentChildren.find(
            (child) => (child as ReactElement<{ text?: string }>).props.text === '• Review waiting item'
        ) as ReactElement<{ style: { fontSize: number } }> | undefined;

        expect(children).toHaveLength(3);
        expect(spacer?.props.style?.flex).toBe(1);
        expect(taskItem?.props.style.fontSize).toBe(12);
        expect(button?.props.style?.fontSize).toBe(10);
    });
});
