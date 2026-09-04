import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReviewSteps, getWeeklyReviewBuckets, type Project, type Task } from '@mindwtr/core';

import { CompactText } from './compact-text';
import { ReviewModal } from './review-modal';
import { styles } from './review-modal.styles';

const { mockStorageGetItem, mockStorageRemoveItem, mockStorageSetItem } = vi.hoisted(() => ({
    mockStorageGetItem: vi.fn(),
    mockStorageRemoveItem: vi.fn(),
    mockStorageSetItem: vi.fn(),
}));

// The real core bucket builders run in this file, so "now" is pinned: stale
// items, the look-back week, and the calendar window are all measured against
// it. Wednesday 2026-03-04; the default (Sunday) review week starts 2026-03-01.
const NOW = new Date(2026, 2, 4, 10, 0, 0);
// Local-time fixture timestamps. UTC literals would land in the previous week
// (and outside the look-back window) for any test machine behind UTC.
const at = (day: number, hour = 9) => new Date(2026, 2, day, hour, 0, 0).toISOString();

const defaultTasks = [
    {
        id: 'inbox-1',
        title: 'Inbox task',
        status: 'inbox',
        contexts: [],
        tags: [],
        createdAt: at(2),
        updatedAt: at(2),
    },
    {
        id: 'waiting-1',
        title: 'Waiting task',
        status: 'waiting',
        contexts: [],
        tags: [],
        createdAt: at(2),
        updatedAt: at(2),
    },
    {
        id: 'project-task-1',
        title: 'Project task',
        status: 'next',
        projectId: 'project-1',
        contexts: ['@home'],
        tags: [],
        createdAt: at(2),
        updatedAt: at(2),
    },
    {
        // Inside the calendar step's 7-day window, so that step has work.
        id: 'due-1',
        title: 'Due soon',
        status: 'next',
        projectId: 'project-1',
        dueDate: '2026-03-05',
        contexts: [],
        tags: [],
        createdAt: at(2),
        updatedAt: at(2),
    },
];

const defaultProjects = [
    {
        id: 'project-1',
        title: 'Project One',
        status: 'active',
        createdAt: at(2),
        updatedAt: at(2),
    },
];

// A task completed inside the current review week. The look-back counts it, no
// bucket does, so the completed step stays the first step with work.
const doneTask = (overrides: Record<string, unknown> = {}) => ({
    id: 'done-1',
    title: 'Shipped the thing',
    status: 'done',
    contexts: [],
    tags: [],
    completedAt: at(2, 12),
    createdAt: at(1),
    updatedAt: at(2, 12),
    ...overrides,
});

// Finishing a task in a project counts as "moved forward" whatever the project's
// own status is; an archived one keeps `projectEntries` (and so the projects
// step) empty, which is what these look-back tests need.
const archivedProject = {
    id: 'project-archived',
    title: 'Wrapped up',
    status: 'archived',
    createdAt: at(1),
    updatedAt: at(3),
};

const defaultSettings = {
    ai: { enabled: false },
    gtd: { weeklyReview: { includeContextStep: false } },
};

const storeState = {
    tasks: defaultTasks.map((task) => ({ ...task })),
    projects: defaultProjects.map((project) => ({ ...project })),
    areas: [],
    settings: { ...defaultSettings },
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    batchUpdateTasks: vi.fn(),
    addTask: vi.fn(),
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
                data.map((item: any, index: number) =>
                    React.createElement(
                        React.Fragment,
                        { key: keyExtractor?.(item, index) ?? item.id ?? index },
                        renderItem?.({ item, index }),
                    ),
                ),
                renderComponent(props.ListFooterComponent),
            );
        },
    };
});

// Only the store is faked; every review rule (buckets, step order, quick-add
// parsing) runs for real, the way daily-review-modal.test.tsx does it.
vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return {
        ...actual,
        useTaskStore: Object.assign(() => storeState, { getState: () => storeState }),
    };
});

vi.mock('../contexts/theme-context', () => ({
    useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
    useLanguage: () => ({
        language: 'en',
        t: (key: string) => (key === 'common.close' ? 'Close' : key),
    }),
}));

vi.mock('../contexts/quick-capture-context', () => ({
    useQuickCapture: () => ({ openQuickCapture: vi.fn() }),
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
    useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

vi.mock('@/hooks/use-theme-colors', () => {
    // One object, like the real hook: rows compare `tc` by identity (#766).
    const themeColors = {
        bg: '#0f172a',
        cardBg: '#111827',
        taskItemBg: '#111827',
        inputBg: '#111827',
        filterBg: '#1f2937',
        border: '#334155',
        text: '#f8fafc',
        secondaryText: '#94a3b8',
        icon: '#94a3b8',
        tint: '#3b82f6',
        onTint: '#ffffff',
        tabIconDefault: '#94a3b8',
        tabIconSelected: '#3b82f6',
        danger: '#ef4444',
        success: '#10b981',
        warning: '#f59e0b',
    };
    return { useThemeColors: () => themeColors };
});

vi.mock('@/lib/task-meta-navigation', () => ({
    openContextsScreen: vi.fn(),
    openProjectScreen: vi.fn(),
}));

vi.mock('../lib/ai-config', () => ({
    buildAIConfig: vi.fn(() => ({})),
    isAIKeyRequired: vi.fn(() => false),
    loadAIKey: vi.fn().mockResolvedValue(''),
}));

vi.mock('../lib/app-log', () => ({
    logError: vi.fn(),
}));

vi.mock('../lib/external-calendar', () => ({
    fetchExternalCalendarEvents: vi.fn().mockResolvedValue({ events: [] }),
}));

vi.mock('../lib/store-review-prompt', () => ({
    maybeRequestStoreReviewAfterPositiveMoment: vi.fn().mockResolvedValue(false),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: mockStorageGetItem,
        removeItem: mockStorageRemoveItem,
        setItem: mockStorageSetItem,
    },
}));

vi.mock('lucide-react-native', () => {
    const icon = (name: string) => {
        const Icon = (props: any) => React.createElement(name, props);
        Icon.displayName = `${name}Icon`;
        return Icon;
    };
    return {
        Brain: icon('Brain'),
        X: icon('X'),
        History: icon('History'),
        Inbox: icon('Inbox'),
        Sparkles: icon('Sparkles'),
        Calendar: icon('Calendar'),
        Clock: icon('Clock'),
        Tag: icon('Tag'),
        FolderOpen: icon('FolderOpen'),
        Lightbulb: icon('Lightbulb'),
        Play: icon('Play'),
        CheckCircle2: icon('CheckCircle2'),
        PartyPopper: icon('PartyPopper'),
    };
});

vi.mock('./swipeable-task-item', () => ({
    SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('./task-edit-modal', () => ({
    TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('./inbox-processing-modal', () => ({
    InboxProcessingModal: (props: any) => React.createElement('InboxProcessingModal', props),
}));

vi.mock('./ErrorBoundary', () => ({
    ErrorBoundary: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
}));

vi.mock('react-native-gesture-handler', () => ({
    GestureHandlerRootView: (props: any) => React.createElement('GestureHandlerRootView', props, props.children),
}));

const flattenText = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
    return '';
};

// Step-rail titles are drawn for every step, present or skipped, so they cannot
// say which step is open. Each of these lines is rendered by exactly one step
// body.
const STEP_BODY_TEXT: Record<string, string> = {
    inbox: 'Clear Your Inbox',
    stale: 'No recent activity.',
    calendar: 'Review your hard landscape first',
    waiting: 'Follow Up on Waiting Items',
    contexts: 'Review your contexts and make sure',
    projects: 'Review Your Projects',
    someday: 'Revisit Someday/Maybe',
    completed: 'Review Complete!',
};

const STEP_RAIL_TITLE: Record<string, string> = {
    inbox: 'Inbox',
    stale: 'Stale items',
    calendar: 'Calendar',
    waiting: 'Waiting For',
    contexts: 'Contexts',
    projects: 'Projects',
    someday: 'Someday/Maybe',
    completed: 'Done!',
};

/** The open step, or the list of matches when the body is ambiguous. */
const currentStepOf = (tree: ReturnType<typeof create>): string | string[] => {
    const open = Object.entries(STEP_BODY_TEXT)
        .filter(([, text]) => tree.root
            .findAll((node) => flattenText(node.props?.children).includes(text)).length > 0)
        .map(([id]) => id);
    return open.length === 1 ? open[0] : open;
};

const railTitlesOf = (tree: ReturnType<typeof create>) => {
    const rail = tree.root
        .findAll((node) => node.props?.contentContainerStyle === styles.stepRailContent)[0];
    return rail.findAllByType(CompactText).map((node) => node.props.children);
};

describe('ReviewModal', () => {
    beforeEach(() => {
        // Pinned clock: the real bucket builders measure stale items, the
        // look-back week and the calendar window against it.
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        vi.clearAllMocks();
        storeState.tasks = defaultTasks.map((task) => ({ ...task }));
        storeState.projects = defaultProjects.map((project) => ({ ...project }));
        storeState.settings = { ...defaultSettings };
        mockStorageGetItem.mockReset().mockResolvedValue(null);
        mockStorageRemoveItem.mockReset().mockResolvedValue(undefined);
        mockStorageSetItem.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('advances and goes back through weekly review steps', async () => {
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        expect(currentStepOf(tree)).toBe('inbox');
        expect(
            tree.root.findAll((node) => node.props?.accessibilityLabel === 'inbox.processButton').length,
        ).toBeGreaterThan(0);

        const initialBackLabel = tree.root.find((node) => flattenText(node.props?.children) === '← Back');
        expect(initialBackLabel.parent?.props.disabled).toBe(true);

        const nextLabel = tree.root.find((node) => flattenText(node.props?.children) === 'Next →');
        const nextButton = nextLabel.parent;
        if (!nextButton) {
            throw new Error('Next button not found');
        }

        await act(async () => {
            nextButton.props.onPress();
        });

        // Stale is skipped (nothing is stale), so Next lands on Calendar.
        expect(currentStepOf(tree)).toBe('calendar');

        const backLabel = tree.root.find((node) => flattenText(node.props?.children) === '← Back');
        const backButton = backLabel.parent;
        if (!backButton) {
            throw new Error('Back button not found');
        }

        await act(async () => {
            backButton.props.onPress();
        });

        expect(currentStepOf(tree)).toBe('inbox');
    });

    it('resumes within the local review week, preserves Close, and clears on Finish', async () => {
        storeState.settings = {
            ...defaultSettings,
            weekStart: 'monday',
        } as typeof storeState.settings;
        mockStorageGetItem.mockResolvedValue(JSON.stringify({
            step: 'waiting',
            startedAt: new Date(2026, 2, 3, 9, 0, 0).toISOString(),
        }));
        const onClose = vi.fn();

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<ReviewModal visible onClose={onClose} />);
            await Promise.resolve();
        });

        expect(currentStepOf(tree)).toBe('waiting');
        const closeButton = tree.root.findByProps({ accessibilityLabel: 'Close' });
        await act(async () => {
            closeButton.props.onPress();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(mockStorageRemoveItem).not.toHaveBeenCalled();

        const nextLabel = tree.root.find((node) => flattenText(node.props?.children) === 'Next →');
        await act(async () => {
            nextLabel.parent?.props.onPress();
        });
        for (let index = 0; index < 8 && tree.root.findAll((node) => flattenText(node.props?.children) === 'Finish').length === 0; index += 1) {
            const next = tree.root.find((node) => flattenText(node.props?.children) === 'Next →');
            await act(async () => {
                next.parent?.props.onPress();
            });
        }
        const finishLabel = tree.root.find((node) => flattenText(node.props?.children) === 'Finish');
        await act(async () => {
            await finishLabel.parent?.props.onPress();
        });
        expect(mockStorageRemoveItem).toHaveBeenCalledWith('mindwtr:weeklyReview:currentStep');
    });

    it('restores a later active checkpoint after canonicalizing an empty initial step', async () => {
        storeState.tasks = defaultTasks
            .filter((task) => task.status !== 'inbox')
            .map((task) => ({ ...task }));
        mockStorageGetItem.mockResolvedValue(JSON.stringify({
            step: 'waiting',
            startedAt: new Date().toISOString(),
        }));

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
            await Promise.resolve();
        });

        // Inbox is empty, so the initial 'inbox' step canonicalizes to Calendar;
        // the stored checkpoint then wins.
        expect(currentStepOf(tree)).toBe('waiting');
    });

    it('does not let delayed resume hydration overwrite an immediate step choice', async () => {
        let resolveStored!: (value: string | null) => void;
        mockStorageGetItem.mockReturnValue(new Promise((resolve) => {
            resolveStored = resolve;
        }));

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });
        const nextLabel = tree.root.find((node) => flattenText(node.props?.children) === 'Next →');
        await act(async () => {
            nextLabel.parent?.props.onPress();
        });
        expect(currentStepOf(tree)).toBe('calendar');

        await act(async () => {
            resolveStored(JSON.stringify({
                step: 'projects',
                startedAt: new Date().toISOString(),
            }));
            await Promise.resolve();
        });

        expect(currentStepOf(tree)).toBe('calendar');
    });

    it('keeps the full Process Inbox step inside one vertical scroll surface', async () => {
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const stepList = tree.root.findByProps({ testID: 'review-step-scroll' });
        expect(stepList.props.ListHeaderComponent).toBeTruthy();
        expect(stepList.props.scrollEnabled).not.toBe(false);
        expect(stepList.props.contentContainerStyle).toEqual(
            expect.objectContaining({ paddingBottom: 16 }),
        );
    });

    it('does not let task chips navigate away mid-review', async () => {
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const rows = tree.root.findAll((node) => String(node.type) === 'SwipeableTaskItem');
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(typeof row.props.actions.edit).toBe('function');
            expect(row.props.onContextPress).toBeUndefined();
            expect(row.props.onTagPress).toBeUndefined();
            expect(row.props.onProjectPress).toBeUndefined();
        }
    });

    it('opens mind sweep from the weekly review nudge', async () => {
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const nudge = tree.root.findByProps({ testID: 'review-mind-sweep-button' });

        await act(async () => {
            nudge.props.onPress();
        });

        expect(tree.root.findByProps({ testID: 'mind-sweep-start' })).toBeDefined();
    });

    it('starts on all clear when every weekly review stage is empty', async () => {
        storeState.tasks = [];
        storeState.projects = [];
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const hasText = (text: string) =>
            tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;

        expect(hasText('Review Complete!')).toBe(true);
        expect(hasText('Inbox')).toBe(true);
        expect(hasText('Calendar')).toBe(true);
        expect(hasText('This week')).toBe(false);
    });

    it('shows this week\'s completion, project, estimate, and tracked totals', async () => {
        // Two tasks finished this week, one of them in a project and carrying a
        // 1h estimate with 45m tracked against it.
        storeState.tasks = [
            doneTask({
                projectId: archivedProject.id,
                timeEstimate: '1hr',
                timeSpentMinutes: 45,
            }),
            doneTask({ id: 'done-2', title: 'Small chore', completedAt: at(3, 14) }),
        ] as typeof storeState.tasks;
        storeState.projects = [archivedProject] as typeof storeState.projects;
        storeState.settings = {
            ...defaultSettings,
            features: { timeEstimates: true, pomodoro: true },
            gtd: {
                weeklyReview: { includeContextStep: false },
                pomodoro: { linkTask: true },
            },
        } as typeof storeState.settings;
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const hasText = (text: string) =>
            tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;
        expect(hasText('This week')).toBe(true);
        expect(hasText('2 action(s) completed this week')).toBe(true);
        expect(hasText('1 project(s) moved forward')).toBe(true);
        expect(hasText('1 completed task(s) had an estimate')).toBe(true);
        expect(hasText('Estimated: 1h')).toBe(true);
        expect(hasText('Tracked on those tasks: 45m')).toBe(true);
    });

    it('shows the estimate look-back at defaults, with no features block stored', async () => {
        storeState.tasks = [doneTask({ timeEstimate: '1hr', timeSpentMinutes: 45 })] as typeof storeState.tasks;
        storeState.projects = [];
        // No `features` key at all: time estimates default ON, so the look-back
        // must render. `features?.timeEstimates === true` read this as OFF and
        // hid the rows for everyone at defaults.
        storeState.settings = {
            ...defaultSettings,
            gtd: {
                weeklyReview: { includeContextStep: false },
                pomodoro: { linkTask: true },
            },
        } as typeof storeState.settings;
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const hasText = (text: string) =>
            tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;
        expect(hasText('1 completed task(s) had an estimate')).toBe(true);
        expect(hasText('Estimated: 1h')).toBe(true);
        // Pomodoro still defaults OFF, so the tracked line stays hidden.
        expect(hasText('Tracked on those tasks: 45m')).toBe(false);
    });

    it('keeps estimate lines hidden until time estimates are enabled', async () => {
        storeState.tasks = [doneTask({ timeEstimate: '1hr', timeSpentMinutes: 45 })] as typeof storeState.tasks;
        storeState.projects = [];
        storeState.settings = {
            ...defaultSettings,
            features: { timeEstimates: false, pomodoro: true },
            gtd: {
                weeklyReview: { includeContextStep: false },
                pomodoro: { linkTask: true },
            },
        } as typeof storeState.settings;
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const hasText = (text: string) =>
            tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;
        expect(hasText('1 action(s) completed this week')).toBe(true);
        expect(hasText('1 completed task(s) had an estimate')).toBe(false);
        expect(hasText('Estimated: 1h')).toBe(false);
        expect(hasText('Tracked on those tasks: 45m')).toBe(false);
    });

    it('parses the project-step prompt and Save & edit opens the created task in the editor', async () => {
        storeState.addTask.mockImplementation(async (title: string, props: Record<string, unknown>) => {
            storeState.tasks.push({
                id: 'new-task-1',
                title,
                contexts: [],
                tags: [],
                createdAt: '2026-03-15T00:00:00.000Z',
                updatedAt: '2026-03-15T00:00:00.000Z',
                ...props,
            } as (typeof storeState.tasks)[number]);
            return { success: true, id: 'new-task-1' };
        });
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const pressByText = async (text: string) => {
            const matches = tree.root.findAll((node) => flattenText(node.props?.children) === text);
            for (const label of matches) {
                let target = label.parent;
                while (target && typeof target.props?.onPress !== 'function') {
                    target = target.parent;
                }
                if (target) {
                    await act(async () => {
                        target!.props.onPress({ stopPropagation: () => {} });
                    });
                    return;
                }
            }
            throw new Error(`No pressable found for "${text}"`);
        };

        // Walk forward to the projects step (empty steps are skipped).
        for (let i = 0; i < 6; i += 1) {
            if (tree.root.findAll((node) => flattenText(node.props?.children).includes('Review Your Projects')).length > 0) break;
            await pressByText('Next →');
        }

        await pressByText('Add task');

        const input = tree.root.find((node) => node.props?.placeholder === 'Enter task title');
        await act(async () => {
            input.props.onChangeText('Buy cable @errands');
        });

        await pressByText('Save & edit');

        // The real quick-add grammar runs here: the `@errands` token leaves the
        // title and becomes a context on the new task.
        expect(storeState.addTask).toHaveBeenCalledTimes(1);
        const [savedTitle, savedProps] = storeState.addTask.mock.calls[0];
        expect(savedTitle).toBe('Buy cable');
        expect(savedProps).toMatchObject({ projectId: 'project-1', status: 'next' });
        expect(savedProps.contexts).toEqual(['@errands']);

        const editModal = tree.root.find((node) => (node.type as unknown) === 'TaskEditModal');
        expect(editModal.props.visible).toBe(true);
        expect(editModal.props.task?.id).toBe('new-task-1');
        expect(editModal.props.defaultTab).toBe('task');
    });

    // Rows carry the #766 memo boundary, which only holds while the modal hands
    // untouched rows the same references back.
    it('hands rows stable prop references across a re-render', async () => {
        storeState.tasks = [
            ...defaultTasks.map((task) => ({ ...task })),
            { ...defaultTasks[0], id: 'inbox-2', title: 'Second inbox task' },
        ];
        const onClose = vi.fn();

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<ReviewModal visible onClose={onClose} />);
        });

        const rowProps = () => tree.root
            .findAll((node) => (node.type as unknown) === 'SwipeableTaskItem')
            .map((node) => node.props);
        const before = rowProps();
        expect(before).toHaveLength(2);
        expect(before[0].actions).toBe(before[1].actions);

        await act(async () => {
            tree.update(<ReviewModal visible onClose={onClose} />);
        });

        const after = rowProps();
        expect(after[1].task).toBe(before[1].task);
        expect(after[1].actions).toBe(before[1].actions);
        expect(after[1].tc).toBe(before[1].tc);
    });

    // The rail is the mobile copy of core's step order. Pinned against
    // `buildReviewSteps` so the two cannot drift apart silently.
    it('renders the canonical core step order in the rail', async () => {
        const coreStepIds = (includeContextStep: boolean) => buildReviewSteps(
            getWeeklyReviewBuckets(
                storeState.tasks as unknown as Task[],
                storeState.projects as unknown as Project[],
            ),
            { kind: 'weekly', includeContextStep },
        ).map((step) => step.id);

        expect(coreStepIds(false)).toEqual([
            'inbox', 'stale', 'calendar', 'waiting', 'projects', 'someday', 'completed',
        ]);
        expect(coreStepIds(true)).toEqual([
            'inbox', 'stale', 'calendar', 'waiting', 'contexts', 'projects', 'someday', 'completed',
        ]);

        let tree!: ReturnType<typeof create>;
        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });
        expect(railTitlesOf(tree)).toEqual(coreStepIds(false).map((id) => STEP_RAIL_TITLE[id]));

        storeState.settings = {
            ...defaultSettings,
            gtd: { weeklyReview: { includeContextStep: true } },
        } as typeof storeState.settings;
        await act(async () => {
            tree.update(<ReviewModal visible onClose={vi.fn()} />);
        });
        expect(railTitlesOf(tree)).toEqual(coreStepIds(true).map((id) => STEP_RAIL_TITLE[id]));
    });
});
