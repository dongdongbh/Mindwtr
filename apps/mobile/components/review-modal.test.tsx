import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewModal } from './review-modal';

const { mockStorageGetItem, mockStorageRemoveItem, mockStorageSetItem } = vi.hoisted(() => ({
    mockStorageGetItem: vi.fn(),
    mockStorageRemoveItem: vi.fn(),
    mockStorageSetItem: vi.fn(),
}));

const defaultTasks = [
    {
        id: 'inbox-1',
        title: 'Inbox task',
        status: 'inbox',
        contexts: [],
        tags: [],
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    },
    {
        id: 'waiting-1',
        title: 'Waiting task',
        status: 'waiting',
        contexts: [],
        tags: [],
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    },
    {
        id: 'project-task-1',
        title: 'Project task',
        status: 'next',
        projectId: 'project-1',
        contexts: ['@home'],
        tags: [],
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    },
];

const defaultProjects = [
    {
        id: 'project-1',
        title: 'Project One',
        status: 'active',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    },
];

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

const mockLookBack = {
    completedCount: 0,
    projectsMovedCount: 0,
    estimatedTaskCount: 0,
    estimatedMinutes: 0,
    trackedMinutes: 0,
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

vi.mock('@mindwtr/core', async (importOriginal) => ({
    resolveReviewStepSession: (await importOriginal<typeof import('@mindwtr/core')>()).resolveReviewStepSession,
    parseStoredReviewStepSession: (await importOriginal<typeof import('@mindwtr/core')>()).parseStoredReviewStepSession,
    buildQuickAddParseOptions: (await importOriginal<typeof import('@mindwtr/core')>()).buildQuickAddParseOptions,
    useTaskStore: Object.assign(() => storeState, { getState: () => storeState }),
    shallow: vi.fn((a, b) => a === b),
    normalizeClockTimeInput: vi.fn(() => null),
    isNaturalLanguageDatesEnabled: vi.fn((settings?: { gtd?: { naturalLanguageDates?: boolean } } | null) =>
        settings?.gtd?.naturalLanguageDates !== false),
    parseProjectNextActionInput: vi.fn((input: string, context: { projectId: string }) => ({
        title: input,
        props: { projectId: context.projectId, status: 'next' },
    })),
    getMindSweepGroups: vi.fn(() => [
        {
            id: 'test-group',
            scope: 'personal',
            titleKey: 'mindSweep.group.test.title',
            promptKeys: ['mindSweep.group.test.p1'],
        },
    ]),
    createAIProvider: vi.fn(),
    formatI18nTemplate: vi.fn((template: string, values: Record<string, string | number>) =>
        template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => String(values[key] ?? match))),
    partitionByReviewDate: vi.fn((items: unknown[]) => ({ due: [], scheduled: [], unscheduled: items })),
    isTaskInActiveProject: vi.fn(() => true),
    safeFormatDate: vi.fn(() => '2026-03-15'),
    safeParseDate: vi.fn((value?: string) => (value ? new Date(value) : null)),
    safeParseDueDate: vi.fn(() => null),
    formatTimeSpentLabel: (await importOriginal<typeof import('@mindwtr/core')>()).formatTimeSpentLabel,
    // Real implementation on purpose: the look-back rows depend on its default
    // polarity (estimates ON when `features` is missing).
    resolveFeatureFlags: (await importOriginal<typeof import('@mindwtr/core')>()).resolveFeatureFlags,
    // Weekly Review candidate/bucket derivation moved to core (review-buckets
    // refactor); these fakes mirror the real functions closely enough for
    // this file's fixtures, composed from the primitives already mocked above.
    getWeeklyReviewBuckets: vi.fn((tasks: any[], projects: any[]) => {
        const inbox = tasks.filter((task: any) => task.status === 'inbox' && !task.deletedAt);
        const waiting = tasks.filter((task: any) => task.status === 'waiting' && !task.deletedAt);
        const someday = tasks.filter((task: any) => task.status === 'someday' && !task.deletedAt);
        const activeProjects = projects.filter((project: any) => project.status === 'active' && !project.deletedAt);
        const contextGroupsByName = new Map<string, any[]>();
        tasks.forEach((task: any) => {
            if (task.deletedAt || ['done', 'archived', 'reference'].includes(task.status)) return;
            (task.contexts ?? []).forEach((context: string) => {
                const list = contextGroupsByName.get(context) ?? [];
                list.push(task);
                contextGroupsByName.set(context, list);
            });
        });
        const projectEntries = activeProjects.map((project: any) => {
            const projectTasks = tasks.filter((task: any) => (
                task.projectId === project.id
                && !task.deletedAt
                && task.status !== 'done'
                && task.status !== 'reference'
            ));
            return {
                project,
                tasks: projectTasks,
                nextActionState: projectTasks.some((task: any) => task.status === 'next')
                    ? 'next'
                    : projectTasks.some((task: any) => task.status === 'waiting') ? 'waiting' : 'none',
            };
        });
        return {
            inbox,
            waitingGroups: { due: [], scheduled: [], unscheduled: waiting },
            somedayGroups: { due: [], scheduled: [], unscheduled: someday },
            projectEntries,
            staleItems: [],
            summary: {
                inboxCount: inbox.length,
                activeProjectCount: projectEntries.length,
                projectsWithoutNextAction: projectEntries.filter((entry: any) => !entry.hasNextAction).length,
                staleWaitingCount: 0,
            },
            lookBack: { ...mockLookBack },
            contextGroups: Array.from(contextGroupsByName.entries()).map(([context, contextTasks]) => ({ context, tasks: contextTasks })),
            calendarItems: [],
        };
    }),
    getExternalCalendarDaySummaries: vi.fn(() => []),
    buildReviewSteps: vi.fn((buckets: any, opts: any) => {
        if (opts?.kind === 'daily') {
            const dailySteps: Array<{ id: string; hasWork: boolean }> = [
                { id: 'today', hasWork: false },
                { id: 'inbox', hasWork: buckets.inbox.length > 0 },
                { id: 'waiting', hasWork: buckets.waiting.length > 0 },
            ];
            if (opts.includeFocusStep !== false) {
                dailySteps.push({ id: 'focus', hasWork: buckets.focusCandidates.length > 0 });
            }
            dailySteps.push({ id: 'completed', hasWork: true });
            return dailySteps;
        }
        const weeklySteps: Array<{ id: string; hasWork: boolean }> = [
            { id: 'inbox', hasWork: buckets.inbox.length > 0 },
            { id: 'stale', hasWork: buckets.staleItems.length > 0 },
            {
                id: 'calendar',
                hasWork: buckets.calendarItems.length > 0
                    || (opts.externalCalendarDayCount ?? 0) > 0
                    || Boolean(opts.externalCalendarHasError),
            },
            { id: 'waiting', hasWork: buckets.waitingGroups.due.length + buckets.waitingGroups.unscheduled.length > 0 },
        ];
        if (opts.includeContextStep !== false) {
            weeklySteps.push({ id: 'contexts', hasWork: buckets.contextGroups.length > 0 });
        }
        weeklySteps.push(
            { id: 'projects', hasWork: buckets.projectEntries.length > 0 },
            { id: 'someday', hasWork: buckets.somedayGroups.due.length + buckets.somedayGroups.unscheduled.length > 0 },
            { id: 'completed', hasWork: true },
        );
        return weeklySteps;
    }),
}));

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

describe('ReviewModal', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        storeState.tasks = defaultTasks.map((task) => ({ ...task }));
        storeState.projects = defaultProjects.map((project) => ({ ...project }));
        storeState.settings = { ...defaultSettings };
        Object.assign(mockLookBack, {
            completedCount: 0,
            projectsMovedCount: 0,
            estimatedTaskCount: 0,
            estimatedMinutes: 0,
            trackedMinutes: 0,
        });
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

        const hasText = (text: string) =>
            tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;

        expect(hasText('Inbox')).toBe(true);
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

        expect(hasText('Calendar')).toBe(true);

        const backLabel = tree.root.find((node) => flattenText(node.props?.children) === '← Back');
        const backButton = backLabel.parent;
        if (!backButton) {
            throw new Error('Back button not found');
        }

        await act(async () => {
            backButton.props.onPress();
        });

        expect(hasText('Inbox')).toBe(true);
    });

    it('resumes within the local review week, preserves Close, and clears on Finish', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 2, 4, 10, 0, 0));
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

        expect(tree.root.findAll((node) => flattenText(node.props?.children).includes('Waiting For')).length).toBeGreaterThan(0);
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

        expect(tree.root.findAll((node) => flattenText(node.props?.children).includes('Waiting For')).length).toBeGreaterThan(0);
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
        const hasWaitingTitle = () => tree.root
            .findAll((node) => flattenText(node.props?.children).includes('Waiting For')).length > 0;
        expect(hasWaitingTitle()).toBe(true);

        await act(async () => {
            resolveStored(JSON.stringify({
                step: 'projects',
                startedAt: new Date().toISOString(),
            }));
            await Promise.resolve();
        });

        expect(hasWaitingTitle()).toBe(true);
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
        storeState.tasks = [];
        storeState.projects = [];
        storeState.settings = {
            ...defaultSettings,
            features: { timeEstimates: true, pomodoro: true },
            gtd: {
                weeklyReview: { includeContextStep: false },
                pomodoro: { linkTask: true },
            },
        } as typeof storeState.settings;
        Object.assign(mockLookBack, {
            completedCount: 2,
            projectsMovedCount: 1,
            estimatedTaskCount: 1,
            estimatedMinutes: 60,
            trackedMinutes: 45,
        });
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
        storeState.tasks = [];
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
        Object.assign(mockLookBack, {
            completedCount: 1,
            estimatedTaskCount: 1,
            estimatedMinutes: 60,
            trackedMinutes: 45,
        });
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
        storeState.tasks = [];
        storeState.projects = [];
        storeState.settings = {
            ...defaultSettings,
            features: { timeEstimates: false, pomodoro: true },
            gtd: {
                weeklyReview: { includeContextStep: false },
                pomodoro: { linkTask: true },
            },
        } as typeof storeState.settings;
        Object.assign(mockLookBack, {
            completedCount: 1,
            estimatedTaskCount: 1,
            estimatedMinutes: 60,
            trackedMinutes: 45,
        });
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

        expect(storeState.addTask).toHaveBeenCalledWith('Buy cable @errands', {
            projectId: 'project-1',
            status: 'next',
        });

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
});
