import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DailyReviewScreen } from './daily-review-modal';

const { mockStorageGetItem, mockStorageRemoveItem, mockStorageSetItem } = vi.hoisted(() => ({
    mockStorageGetItem: vi.fn(),
    mockStorageRemoveItem: vi.fn(),
    mockStorageSetItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: mockStorageGetItem,
        removeItem: mockStorageRemoveItem,
        setItem: mockStorageSetItem,
    },
}));

const makeTask = (overrides: Record<string, unknown> = {}) => ({
    id: 'task-1',
    title: 'Today task',
    status: 'next',
    contexts: [],
    tags: [],
    createdAt: '2026-07-01T12:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
    ...overrides,
});

const flattenStyle = (style: unknown): Record<string, unknown> => {
    if (!style) return {};
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    return typeof style === 'object' ? style as Record<string, unknown> : {};
};

const storeState = {
    tasks: [makeTask({ dueDate: '2026-07-15' })],
    projects: [],
    settings: {
        appearance: {},
        gtd: {
            dailyReview: { includeFocusStep: false },
            focusTaskLimit: 3,
        },
        taskSortBy: 'default',
    },
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
};

vi.mock('react-native', async () => {
    const actual = await vi.importActual<any>('react-native');
    return {
        ...actual,
        FlatList: ({ data = [], renderItem, keyExtractor, ...props }: any) => {
            const renderComponent = (component: any) => {
                if (!component) return null;
                return React.isValidElement(component) ? component : React.createElement(component);
            };
            return React.createElement(
                'FlatList',
                props,
                renderComponent(props.ListHeaderComponent),
                data.length === 0 ? renderComponent(props.ListEmptyComponent) : null,
                data.map((item: any, index: number) => React.createElement(
                    React.Fragment,
                    { key: keyExtractor?.(item, index) ?? item.id ?? index },
                    renderItem?.({ item, index }),
                )),
            );
        },
    };
});

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return {
        ...actual,
        useTaskStore: Object.assign(() => storeState, { getState: () => storeState }),
    };
});

vi.mock('expo-router', () => ({
    router: { push: vi.fn() },
}));

vi.mock('../contexts/theme-context', () => ({
    useTheme: () => ({ isDark: true }),
}));

vi.mock('../contexts/language-context', () => ({
    useLanguage: () => ({
        t: (key: string) => ({
            'agenda.noTasks': 'No tasks',
            'calendar.allDay': 'All day',
            'calendar.events': 'Events',
            'calendar.noTasks': 'No events',
            'common.close': 'Close',
            'common.loading': 'Loading',
            'common.tasks': 'tasks',
            'dailyReview.completeDesc': 'Complete',
            'dailyReview.completeTitle': 'Complete',
            'dailyReview.followUpToday': 'Follow up today',
            'dailyReview.inboxDesc': 'Process inbox',
            'dailyReview.inboxStep': 'Inbox',
            'dailyReview.title': 'Daily Review',
            'dailyReview.todayDesc': 'Check today and your calendar',
            'dailyReview.todayStep': 'Today & Calendar',
            'dailyReview.waitingDesc': 'Follow up on anything due',
            'dailyReview.waitingStep': 'Waiting For',
            'review.back': 'Back',
            'review.finish': 'Finish',
            'review.inboxEmpty': 'Inbox empty',
            'review.nextStepBtn': 'Next Step',
            'review.of': 'of',
            'review.step': 'Step',
            'review.waitingEmpty': 'Nothing waiting',
        }[key] ?? key),
    }),
}));

vi.mock('../contexts/toast-context', () => ({
    ToastViewport: () => null,
}));

vi.mock('@/hooks/use-theme-colors', () => {
    // One object, like the real hook: rows compare `tc` by identity (#766).
    const themeColors = {
        bg: '#101214',
        border: '#334155',
        cardBg: '#1e293b',
        danger: '#ef4444',
        filterBg: '#273449',
        onTint: '#0f172a',
        secondaryText: '#94a3b8',
        taskItemBg: '#1e293b',
        text: '#f8fafc',
        tint: '#60a5fa',
    };
    return { useThemeColors: () => themeColors };
});

vi.mock('@/hooks/use-filled-button-colors', () => ({
    useFilledButtonColors: () => ({ backgroundColor: '#60a5fa', textColor: '#0f172a' }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
    openContextsScreen: vi.fn(),
    openProjectScreen: vi.fn(),
}));

vi.mock('../lib/external-calendar', () => ({
    fetchExternalCalendarEvents: vi.fn().mockResolvedValue({ events: [] }),
}));

vi.mock('./swipeable-task-item', () => ({
    SwipeableTaskItem: (props: any) => React.createElement(
        'SwipeableTaskItem',
        props,
        props.footerContent,
    ),
}));

vi.mock('./task-edit-modal', () => ({
    TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('./inbox-processing-modal', () => ({
    InboxProcessingModal: (props: any) => React.createElement('InboxProcessingModal', props),
}));

vi.mock('./ErrorBoundary', () => ({
    ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('react-native-gesture-handler', () => ({
    GestureHandlerRootView: (props: any) => React.createElement('GestureHandlerRootView', props, props.children),
}));

vi.mock('lucide-react-native', () => {
    const icon = (name: string) => {
        const MockIcon = (props: any) => React.createElement(name, props);
        MockIcon.displayName = `Mock${name}`;
        return MockIcon;
    };
    return {
        Calendar: icon('Calendar'),
        CheckCircle2: icon('CheckCircle2'),
        ChevronDown: icon('ChevronDown'),
        ChevronUp: icon('ChevronUp'),
        Clock: icon('Clock'),
        Play: icon('Play'),
        Sparkles: icon('Sparkles'),
        Star: icon('Star'),
        X: icon('X'),
    };
});

describe('DailyReviewScreen', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
        storeState.tasks = [makeTask({ dueDate: '2026-07-15' })];
        storeState.settings.gtd.dailyReview.includeFocusStep = false;
        storeState.updateTask.mockReset();
        storeState.deleteTask.mockReset();
        mockStorageGetItem.mockReset().mockResolvedValue(null);
        mockStorageRemoveItem.mockReset().mockResolvedValue(undefined);
        mockStorageSetItem.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps Today & Calendar guidance and tasks in one scroll surface above the fixed footer', async () => {
        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<DailyReviewScreen onClose={vi.fn()} />);
            await Promise.resolve();
        });

        const scroll = tree.root.findByProps({ testID: 'daily-review-step-scroll-today' });

        expect(tree.root.findAll((node) => (node.type as unknown) === 'FlatList')).toHaveLength(1);
        expect(scroll.findAllByProps({ accessibilityLabel: 'Events' }).length).toBeGreaterThan(0);
        expect(scroll.findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')).toHaveLength(1);
        expect(scroll.findAllByProps({ testID: 'daily-review-footer' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'daily-review-footer' }).length).toBeGreaterThan(0);
    });

    it.each([
        {
            step: 'today',
            testID: 'daily-review-step-scroll-today',
            task: { dueDate: '2026-07-15' },
        },
        {
            step: 'inbox',
            testID: 'daily-review-step-scroll-inbox',
            task: { dueDate: undefined, status: 'inbox' },
        },
        {
            step: 'waiting',
            testID: 'daily-review-step-scroll-waiting',
            task: { dueDate: undefined, status: 'waiting' },
        },
        {
            step: 'focus',
            testID: 'daily-review-step-scroll-focus',
            task: { dueDate: undefined, status: 'next' },
        },
    ])('shows every eligible task in the $step step', async ({ step, task, testID }) => {
        storeState.settings.gtd.dailyReview.includeFocusStep = step === 'focus';
        storeState.tasks = Array.from({ length: 9 }, (_, index) => makeTask({
            id: `${step}-${index + 1}`,
            title: `${step} task ${index + 1}`,
            ...task,
        }));
        mockStorageGetItem.mockResolvedValue(JSON.stringify({
            step,
            startedAt: new Date('2026-07-15T08:00:00.000Z').toISOString(),
        }));

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<DailyReviewScreen onClose={vi.fn()} />);
            await Promise.resolve();
        });

        const scroll = tree.root.findByProps({ testID });
        expect(scroll.findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')).toHaveLength(9);
    });

    it('resumes a valid checkpoint, disables Back on the first step, and clears only on Finish', async () => {
        storeState.tasks = [makeTask({
            id: 'waiting-1',
            title: 'Waiting task',
            status: 'waiting',
            dueDate: undefined,
        })];
        mockStorageGetItem.mockResolvedValue(JSON.stringify({
            step: 'waiting',
            startedAt: new Date('2026-07-15T08:00:00.000Z').toISOString(),
        }));
        const onClose = vi.fn();

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<DailyReviewScreen onClose={onClose} />);
            await Promise.resolve();
        });

        expect(tree.root.findAll((node) => node.props?.children === 'Waiting For').length).toBeGreaterThan(0);
        const backLabel = tree.root.find((node) => node.props?.children === 'Back');
        expect(backLabel.parent?.props.disabled).toBe(true);

        const closeButton = tree.root.findByProps({ accessibilityLabel: 'Close' });
        await act(async () => {
            closeButton.props.onPress();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(mockStorageRemoveItem).not.toHaveBeenCalled();

        const nextLabel = tree.root.find((node) => node.props?.children === 'Next Step');
        await act(async () => {
            nextLabel.parent?.props.onPress();
        });
        const finishLabel = tree.root.find((node) => node.props?.children === 'Finish');
        await act(async () => {
            await finishLabel.parent?.props.onPress();
        });
        expect(mockStorageRemoveItem).toHaveBeenCalledWith('mindwtr:dailyReview:currentStep');
    });

    it('restores a later active checkpoint after canonicalizing an empty initial step', async () => {
        storeState.tasks = [
            makeTask({ id: 'inbox-1', status: 'inbox', dueDate: undefined }),
            makeTask({ id: 'waiting-1', status: 'waiting', dueDate: undefined }),
        ];
        mockStorageGetItem.mockResolvedValue(JSON.stringify({
            step: 'waiting',
            startedAt: new Date('2026-07-15T08:00:00.000Z').toISOString(),
        }));

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<DailyReviewScreen onClose={vi.fn()} />);
            await Promise.resolve();
        });

        expect(tree.root.findAll((node) => node.props?.children === 'Waiting For').length).toBeGreaterThan(0);
    });

    it('does not let delayed resume hydration overwrite an immediate step choice', async () => {
        storeState.tasks = [
            makeTask({ id: 'today-1', dueDate: '2026-07-15' }),
            makeTask({ id: 'inbox-1', status: 'inbox', dueDate: undefined }),
            makeTask({ id: 'waiting-1', status: 'waiting', dueDate: undefined }),
        ];
        let resolveStored!: (value: string | null) => void;
        mockStorageGetItem.mockReturnValue(new Promise((resolve) => {
            resolveStored = resolve;
        }));

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<DailyReviewScreen onClose={vi.fn()} />);
        });
        const nextLabel = tree.root.find((node) => node.props?.children === 'Next Step');
        await act(async () => {
            nextLabel.parent?.props.onPress();
        });
        expect(tree.root.findAll((node) => node.props?.children === 'Inbox').length).toBeGreaterThan(0);

        await act(async () => {
            resolveStored(JSON.stringify({
                step: 'waiting',
                startedAt: new Date('2026-07-15T08:00:00.000Z').toISOString(),
            }));
            await Promise.resolve();
        });

        expect(tree.root.findAll((node) => node.props?.children === 'Inbox').length).toBeGreaterThan(0);
    });

    it('renders Follow up today as a compact action inside its waiting task card', async () => {
        storeState.tasks = [makeTask({
            id: 'waiting-1',
            title: 'Waiting task',
            status: 'waiting',
            dueDate: undefined,
        })];

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<DailyReviewScreen onClose={vi.fn()} />);
            await Promise.resolve();
        });

        const scroll = tree.root.findByProps({ testID: 'daily-review-step-scroll-waiting' });
        const taskRow = scroll.find((node) => (node.type as unknown) === 'SwipeableTaskItem');
        const followUp = taskRow.findByProps({ accessibilityLabel: 'Follow up today: Waiting task' });
        const style = flattenStyle(followUp.props.style);

        expect(style.minHeight).toBe(32);
        expect(style.borderRadius).toBe(8);
        expect(style.borderWidth).toBeUndefined();
    });

    // Rows here carry the #766 memo boundary too, so the review flow must hand
    // every row the same action object rather than a fresh set of arrows.
    it('hands rows one stable action object across re-renders', async () => {
        storeState.tasks = [
            makeTask({ id: 'due-1', title: 'Due one', dueDate: '2026-07-15' }),
            makeTask({ id: 'due-2', title: 'Due two', dueDate: '2026-07-15' }),
        ];
        const onClose = vi.fn();

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<DailyReviewScreen onClose={onClose} />);
            await Promise.resolve();
        });

        const rowProps = () => tree.root
            .findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')
            .map((node) => node.props);
        const before = rowProps();
        expect(before).toHaveLength(2);
        expect(before[0].actions).toBe(before[1].actions);

        await act(async () => {
            tree.update(<DailyReviewScreen onClose={onClose} />);
            await Promise.resolve();
        });

        expect(rowProps()[1].actions).toBe(before[1].actions);
    });

    // The waiting step is the only one that gives rows a footer; a fresh element
    // per render there would defeat the same memo boundary (#766).
    it('keeps the waiting-step footer element stable across re-renders', async () => {
        storeState.tasks = [
            makeTask({ id: 'waiting-1', title: 'Waiting one', status: 'waiting', dueDate: undefined }),
            makeTask({ id: 'waiting-2', title: 'Waiting two', status: 'waiting', dueDate: undefined }),
        ];
        const onClose = vi.fn();

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<DailyReviewScreen onClose={onClose} />);
            await Promise.resolve();
        });

        const rowProps = () => tree.root
            .findByProps({ testID: 'daily-review-step-scroll-waiting' })
            .findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')
            .map((node) => node.props);
        const before = rowProps();
        expect(before).toHaveLength(2);
        expect(before[1].footerContent).toBeTruthy();
        expect(before[0].footerContent).not.toBe(before[1].footerContent);

        await act(async () => {
            tree.update(<DailyReviewScreen onClose={onClose} />);
            await Promise.resolve();
        });

        expect(rowProps()[1].footerContent).toBe(before[1].footerContent);
    });
});
