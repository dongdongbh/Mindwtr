import React from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReviewSteps, getWeeklyReviewBuckets, type Project, type Section, type Task } from '@mindwtr/core';

import { Modal, Platform, ScrollView } from 'react-native';
import { CompactText } from './compact-text';
import { ReviewModal } from './review-modal';
import { styles } from './review-modal.styles';
import { logInfo } from '../lib/app-log';
import { fetchExternalCalendarEvents } from '../lib/external-calendar';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { useTaskEditPreview } from './task-edit/use-task-edit-preview';

const { mockStorageGetItem, mockStorageRemoveItem, mockStorageSetItem } = vi.hoisted(() => ({
    mockStorageGetItem: vi.fn(),
    mockStorageRemoveItem: vi.fn(),
    mockStorageSetItem: vi.fn(),
}));


const NOW = new Date(2026, 2, 4, 10, 0, 0);


const at = (day: number, hour = 9) => new Date(2026, 2, day, hour, 0, 0).toISOString();

const defaultTasks: Task[] = [
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

const defaultProjects: Project[] = [
    {
        id: 'project-1',
        title: 'Project One',
        status: 'active',
        color: '#3b82f6',
        order: 0,
        tagIds: [],
        createdAt: at(2),
        updatedAt: at(2),
    },
];


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

let hiddenTasks: Task[] = [];

const storeState = {
    get _allTasks() { return [...this.tasks, ...hiddenTasks]; },
    get _allProjects() { return this.projects; },
    _allSections: [] as Section[],
    sections: [] as Section[],
    updateProject: vi.fn(),
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

vi.mock('./share-card-modal', () => ({
    ShareCardModal: () => null,
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
    useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

vi.mock('@/hooks/use-theme-colors', () => {

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
    logInfo: vi.fn(),
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
        ChevronRight: icon('ChevronRight'),
        ChevronDown: icon('ChevronDown'),
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
        Share2: icon('Share2'),
        CheckCircle2: icon('CheckCircle2'),
        PartyPopper: icon('PartyPopper'),
    };
});

vi.mock('./swipeable-task-item', () => ({
    SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('./task-edit-modal', () => ({
    TaskEditModal: (props: any) => {
        const preview = useTaskEditPreview({ ...props, projects: [], tasks: [] });
        return React.createElement('TaskEditModal', { ...props, ...preview });
    },
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


const STEP_BODY_TEXT: Record<string, string> = {
    inbox: 'dailyReview.inboxDesc',
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


        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        vi.clearAllMocks();
        hiddenTasks = [];
        storeState._allSections = [];
        storeState.sections = [];
        storeState.updateProject.mockReset().mockImplementation(async (id: string, updates: Partial<Project>) => {
            storeState.projects = storeState.projects.map((project) => project.id === id ? { ...project, ...updates } : project);
            return { success: true };
        });
        storeState.tasks = defaultTasks.map((task) => ({ ...task }));
        storeState.projects = defaultProjects.map((project) => ({ ...project }));
        storeState.settings = { ...defaultSettings };
        mockStorageGetItem.mockReset().mockResolvedValue(null);
        mockStorageRemoveItem.mockReset().mockResolvedValue(undefined);
        mockStorageSetItem.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => {
        Platform.OS = 'web';
        vi.useRealTimers();
    });

    const openProjectCompletion = async () => {
        mockStorageGetItem.mockResolvedValue(JSON.stringify({ step: 'projects', startedAt: NOW.toISOString() }));
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<ReviewModal visible onClose={vi.fn()} />); });
        const card = tree.root.findAll((node) => typeof node.props.onPress === 'function' && node.props.accessibilityState?.expanded === false)[0];
        act(() => card.props.onPress());
        return tree;
    };

    it.each(['project', 'perSection'] as const)('expands a %s sequential tail into the existing task editor without writing on disclosure', async (flow) => {
        storeState.projects = [{ ...defaultProjects[0], isSequential: flow === 'project', perSectionFlow: flow === 'perSection' }];
        storeState.sections = [{ id: 'sequence-section', projectId: 'project-1', title: 'Sequence', order: 0, isSequential: true, createdAt: at(2), updatedAt: at(2) }];
        storeState.tasks = [
            { ...defaultTasks[2], id: 'head', title: 'Waiting head', status: 'waiting', sectionId: 'sequence-section', order: 0 },
            { ...defaultTasks[2], id: 'tail', title: 'Later tail', sectionId: 'sequence-section', order: 1 },
        ];
        const original = structuredClone(storeState.tasks);
        const tree = await openProjectCompletion();
        const rows = () => tree.root.findAll((node) => String(node.type) === 'SwipeableTaskItem');
        expect(rows().map((row) => row.props.task.id)).toEqual(['head']);
        const disclosure = () => tree.root.findAll((node) => node.props.accessibilityLabel === 'Later in sequence (1)' && typeof node.props.onPress === 'function').at(-1)!;
        expect(disclosure().props.accessibilityState).toEqual({ expanded: false });
        act(() => disclosure().props.onPress());
        expect(rows().map((row) => row.props.task.id)).toEqual(['head', 'tail']);
        expect(storeState.updateTask).not.toHaveBeenCalled();
        expect(storeState.tasks).toEqual(original);
        act(() => rows().find((row) => row.props.task.id === 'tail')!.props.actions.edit(storeState.tasks[1]));
        expect(tree.root.findByType('TaskEditModal' as React.ElementType).props.task.id).toBe('tail');
        await act(async () => tree.unmount());
    });

    it('completes an empty project and retains Projects until the review closes', async () => {
        storeState.tasks = [];
        const tree = await openProjectCompletion();
        await act(async () => { await tree.root.findByProps({ testID: 'review-complete-project-project-1' }).props.onPress(); });
        expect(storeState.updateProject).toHaveBeenCalledExactlyOnceWith('project-1', { status: 'archived' });
        expect(currentStepOf(tree)).toBe('projects');
        expect(tree.root.findAllByProps({ testID: 'review-confirm-complete-project' })).toHaveLength(0);
        expect(logInfo).toHaveBeenCalledWith('Weekly review project completed', {
            scope: 'review', force: true,
            extra: { releaseCheck: 'v1.3.8/weekly-review-complete-project', outcome: 'completed' },
        });
        await act(async () => tree.update(<ReviewModal visible={false} onClose={vi.fn()} />));
        await act(async () => tree.update(<ReviewModal visible onClose={vi.fn()} />));
        expect(currentStepOf(tree)).toBe('completed');
        await act(async () => tree.unmount());
    });

    it.each(['direct', 'section'] as const)('confirms unfinished %s tasks inside the sheet and cancel writes nothing', async (association) => {
        Platform.OS = association === 'direct' ? 'android' : 'ios';
        storeState.tasks = [];
        hiddenTasks = [{ ...defaultTasks[2], projectId: association === 'direct' ? 'project-1' : undefined, sectionId: association === 'section' ? 'section-1' : undefined }];
        storeState._allSections = [{ id: 'section-1', projectId: 'project-1', title: 'Section', order: 0, createdAt: at(2), updatedAt: at(2) }];
        const tree = await openProjectCompletion();
        await act(async () => tree.root.findByProps({ testID: 'review-complete-project-project-1' }).props.onPress());
        expect(tree.root.findAllByType(Modal)[0].props.allowSwipeDismissal).toBe(false);
        expect(tree.root.findByProps({ accessibilityViewIsModal: true }).props.onAccessibilityEscape).toBeTypeOf('function');
        expect(tree.root.findAllByType(Modal).some((modal) => modal.props.presentationStyle === 'pageSheet' && modal.findAllByProps({ testID: 'review-confirm-complete-project' }).length > 0)).toBe(true);
        expect(storeState.updateProject).not.toHaveBeenCalled();
        act(() => tree.root.findByProps({ accessibilityLabel: 'common.cancel' }).props.onPress());
        expect(tree.root.findAllByType(Modal)[0].props.allowSwipeDismissal).toBe(true);
        expect(tree.root.findAllByProps({ testID: 'review-confirm-complete-project' })).toHaveLength(0);
        expect(storeState.updateProject).not.toHaveBeenCalled();
        await act(async () => tree.root.findByProps({ testID: 'review-complete-project-project-1' }).props.onPress());
        await act(async () => tree.root.findByProps({ testID: 'review-confirm-complete-project' }).props.onPress());
        expect(storeState.updateProject).toHaveBeenCalledExactlyOnceWith('project-1', { status: 'archived' });
        expect(currentStepOf(tree)).toBe('projects');
        await act(async () => tree.unmount());
    });

    it('bounds long confirmation titles while keeping the full accessible name', async () => {
        const title = 'A very long project title\n'.repeat(100);
        storeState.projects = [{ ...defaultProjects[0], title }];
        const tree = await openProjectCompletion();
        await act(async () => tree.root.findByProps({ testID: 'review-complete-project-project-1' }).props.onPress());
        const heading = tree.root.findByProps({ accessibilityLabel: title });
        expect(heading.props.numberOfLines).toBe(2);
        expect(heading.props.children).toBe(title);
        expect(tree.root.findByProps({ testID: 'review-confirm-complete-project' }).props.disabled).toBe(false);
        await act(async () => tree.unmount());
    });

    it('does not confirm deleted, finished or reference tasks', async () => {
        storeState.tasks = [];
        hiddenTasks = [
            { ...defaultTasks[2], id: 'deleted', deletedAt: at(3) },
            { ...defaultTasks[2], id: 'done', status: 'done' },
            { ...defaultTasks[2], id: 'archived', status: 'archived' },
            { ...defaultTasks[2], id: 'reference', status: 'reference' },
        ];
        const tree = await openProjectCompletion();
        await act(async () => tree.root.findByProps({ testID: 'review-complete-project-project-1' }).props.onPress());
        expect(storeState.updateProject).toHaveBeenCalledOnce();
        expect(tree.root.findAllByProps({ testID: 'review-confirm-complete-project' })).toHaveLength(0);
        await act(async () => tree.unmount());
    });

    it.each(['archived', 'deleted'] as const)('does not complete a project made %s while confirmation was open', async (change) => {
        const tree = await openProjectCompletion();
        await act(async () => tree.root.findByProps({ testID: 'review-complete-project-project-1' }).props.onPress());
        storeState.projects = [{ ...defaultProjects[0], ...(change === 'deleted' ? { deletedAt: at(3) } : { status: 'archived' as const }) }];
        await act(async () => tree.root.findByProps({ testID: 'review-confirm-complete-project' }).props.onPress());
        expect(storeState.updateProject).not.toHaveBeenCalled();
        expect(tree.root.findAllByProps({ testID: 'review-confirm-complete-project' })).toHaveLength(0);
        await act(async () => tree.unmount());
    });

    it.each(['result', 'throw'] as const)('shows a translated failure for a rejected %s and prevents duplicate writes', async (failure) => {
        let rejectWrite!: () => void;
        storeState.updateProject.mockImplementation(() => new Promise((resolve, reject) => {
            rejectWrite = () => failure === 'throw' ? reject(new Error('Disk full')) : resolve({ success: false, error: 'Disk full' });
        }));
        const tree = await openProjectCompletion();
        await act(async () => tree.root.findByProps({ testID: 'review-complete-project-project-1' }).props.onPress());
        const confirm = tree.root.findByProps({ testID: 'review-confirm-complete-project' });
        act(() => { confirm.props.onPress(); confirm.props.onPress(); });
        expect(storeState.updateProject).toHaveBeenCalledOnce();
        expect(tree.root.findByProps({ testID: 'review-confirm-complete-project' }).props.disabled).toBe(true);
        await act(async () => rejectWrite());
        expect(tree.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe('projects.archiveFailed');
        expect(storeState.projects[0].status).toBe('active');
        expect(logInfo).not.toHaveBeenCalled();
        await act(async () => tree.unmount());
    });

    it.each([
        ['handlePreviewProjectPress', 'project-1', openProjectScreen],
        ['handlePreviewContextPress', '@home', openContextsScreen],
        ['handlePreviewTagPress', '#later', openContextsScreen],
    ] as const)('waits for both iOS sheets before %s navigates once', async (press, target, navigate) => {
        Platform.OS = 'ios';
        const onClose = vi.fn();
        let tree!: ReturnType<typeof create>;
        const Owner = () => {
            const [visible, setVisible] = React.useState(true);
            return <ReviewModal visible={visible} onClose={() => { onClose(); setVisible(false); }} />;
        };
        await act(async () => { tree = create(<Owner />); });
        const review = () => tree.root.findAllByType(Modal)[0];
        const editor = () => tree.root.findByType('TaskEditModal' as any);
        act(() => tree.root.findByType('SwipeableTaskItem' as any).props.actions.edit(defaultTasks[0]));
        act(() => editor().props[press](target));
        expect(editor().props.visible).toBe(false);
        expect(editor().props.task?.id).toBe(defaultTasks[0].id);
        expect(review().props.visible).toBe(true);
        expect(onClose).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        await act(async () => { editor().props.onDismiss(); });
        expect(review().props.visible).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        act(() => editor().props.onDismiss());
        await act(async () => { review().props.onDismiss(); });
        act(() => review().props.onDismiss());
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledExactlyOnceWith(target);
        await act(async () => tree.unmount());
    });

    it('dismisses both iOS sheets before closing an owner that unmounts the route', async () => {
        Platform.OS = 'ios';
        const onClose = vi.fn();
        let tree!: ReturnType<typeof create>;
        const Owner = () => {
            const [mounted, setMounted] = React.useState(true);
            return mounted ? <ReviewModal visible onClose={() => { onClose(); setMounted(false); }} /> : null;
        };
        await act(async () => { tree = create(<Owner />); });
        const editor = () => tree.root.findByType('TaskEditModal' as any);
        act(() => tree.root.findByType('SwipeableTaskItem' as any).props.actions.edit(defaultTasks[0]));
        act(() => editor().props.handlePreviewProjectPress('project-1'));
        await act(async () => { editor().props.onDismiss(); });
        expect(onClose).not.toHaveBeenCalled();
        expect(openProjectScreen).not.toHaveBeenCalled();
        await act(async () => { tree.root.findAllByType(Modal)[0].props.onDismiss(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(openProjectScreen).toHaveBeenCalledExactlyOnceWith('project-1');
        expect(tree.toJSON()).toBeNull();
        await act(async () => tree.unmount());
    });

    it.each(['ios', 'android'] as const)('opens a stale project to its tasks, then its screen, on %s (#1459)', async (os) => {
        Platform.OS = os;
        storeState.projects = [{ ...defaultProjects[0], updatedAt: '2025-12-01T09:00:00.000Z' }];
        storeState.tasks = [{ id: 'child', title: 'Call the vendor', status: 'next', projectId: 'project-1', contexts: [], tags: [], createdAt: at(3), updatedAt: at(3) }];
        mockStorageGetItem.mockResolvedValue(JSON.stringify({ step: 'stale', startedAt: NOW.toISOString() }));
        const onClose = vi.fn();
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<ReviewModal visible onClose={onClose} />); });
        expect(currentStepOf(tree)).toBe('stale');
        const rows = () => tree.root.findAll((node) => String(node.type) === 'SwipeableTaskItem');
        expect(rows()).toHaveLength(0);
        const hasText = (node: ReactTestInstance, text: string) => node.findAll((child) => child.props?.children === text).length > 0;
        const pressable = (text: string) => tree.root.findAll((node) => typeof node.props?.onPress === 'function' && hasText(node, text)).at(-1)!;
        const card = pressable('Project One');
        expect(card.props.accessibilityState).toEqual({ expanded: false });
        act(() => card.props.onPress());
        expect(rows().map((row) => row.props.task.id)).toEqual(['child']);
        const open = pressable('task.aria.openProject');
        act(() => open.props.onPress());
        if (os === 'ios') {
            expect(onClose).not.toHaveBeenCalled();
            expect(openProjectScreen).not.toHaveBeenCalled();
            await act(async () => { tree.root.findAllByType(Modal)[0].props.onDismiss(); });
        }
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(openProjectScreen).toHaveBeenCalledExactlyOnceWith('project-1');
        await act(async () => tree.unmount());
    });

    it('navigates on Android without waiting for the iOS-only dismissal events', async () => {
        Platform.OS = 'android';
        const onClose = vi.fn();
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<ReviewModal visible onClose={onClose} />); });
        act(() => tree.root.findByType('SwipeableTaskItem' as any).props.actions.edit(defaultTasks[0]));
        act(() => tree.root.findByType('TaskEditModal' as any).props.handlePreviewProjectPress('project-1'));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(openProjectScreen).toHaveBeenCalledExactlyOnceWith('project-1');
        await act(async () => tree.unmount());
    });

    it.each(['cancel', 'reopen', 'editor-reopen', 'external-close', 'unmount'] as const)('drops pending iOS navigation on %s', async (action) => {
        Platform.OS = 'ios';
        const onClose = vi.fn();
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<ReviewModal visible onClose={onClose} />); });
        const editor = () => tree.root.findByType('TaskEditModal' as any);
        act(() => tree.root.findByType('SwipeableTaskItem' as any).props.actions.edit(defaultTasks[0]));
        act(() => editor().props.handlePreviewProjectPress('project-1'));
        if (action === 'cancel') {
            act(() => tree.root.findAllByType(Modal)[0].props.onRequestClose());
        } else if (action === 'reopen') {
            await act(async () => tree.update(<ReviewModal visible={false} onClose={onClose} />));
            await act(async () => tree.update(<ReviewModal visible onClose={onClose} />));
        } else if (action === 'editor-reopen') {
            act(() => tree.root.findByType('SwipeableTaskItem' as any).props.actions.edit(defaultTasks[0]));
        } else if (action === 'external-close') {
            await act(async () => { editor().props.onDismiss(); });
            await act(async () => tree.update(<ReviewModal visible={false} onClose={onClose} />));
        } else {
            const dismissed = editor().props.onDismiss;
            await act(async () => tree.unmount());
            act(() => dismissed());
            expect(onClose).not.toHaveBeenCalled();
            expect(openProjectScreen).not.toHaveBeenCalled();
            return;
        }
        const closes = onClose.mock.calls.length;
        act(() => editor().props.onDismiss());
        act(() => tree.root.findAllByType(Modal)[0].props.onDismiss());
        expect(onClose).toHaveBeenCalledTimes(closes);
        expect(openProjectScreen).not.toHaveBeenCalled();
        await act(async () => tree.unmount());
    });

    it('waits on the calendar before saving an empty review as complete', async () => {
        storeState.tasks = [];
        storeState.projects = [];
        let settle!: (value: Awaited<ReturnType<typeof fetchExternalCalendarEvents>>) => void;
        vi.mocked(fetchExternalCalendarEvents).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
        let tree!: ReturnType<typeof create>;
        await act(async () => { tree = create(<ReviewModal visible onClose={vi.fn()} />); });
        expect(currentStepOf(tree)).toBe('calendar');
        expect(mockStorageSetItem).not.toHaveBeenCalledWith('mindwtr:weeklyReview:currentStep', expect.stringContaining('completed'));
        await act(async () => { settle({ events: [], calendars: [] }); });
        expect(currentStepOf(tree)).toBe('completed');
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
        expect(tree.root.findByProps({ accessibilityLabel: 'Back' }).props.disabled).toBe(true);
        expect(tree.root.findByProps({ accessibilityLabel: 'Next' }).props.accessibilityRole).toBe('button');
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
        const summary = tree.root.findByProps({ testID: 'review-completed-scroll' });
        expect(summary.type).toBe(ScrollView);
        expect(summary.props.contentContainerStyle).toEqual(expect.objectContaining({ flexGrow: 1 }));
        expect(summary.props.contentContainerStyle.flex).toBeUndefined();

        expect(summary.findAllByProps({ accessibilityLabel: 'Finish' })).toHaveLength(0);
        expect(tree.root.findByProps({ accessibilityLabel: 'Finish' })).toBeDefined();
        expect(tree.root.findByProps({ testID: 'review-share-card-button' })).toBeDefined();
    });

    it('shows this week\'s completion, project, estimate, and tracked totals', async () => {


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
        storeState.addTask.mockImplementation(async (title: string, props: Partial<Task>) => {
            storeState.tasks.push({
                id: 'new-task-1',
                title,
                status: 'inbox',
                contexts: [],
                tags: [],
                createdAt: '2026-03-15T00:00:00.000Z',
                updatedAt: '2026-03-15T00:00:00.000Z',
                ...props,
            });
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
