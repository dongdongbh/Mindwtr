import React from 'react';
import { FlatList, Text, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEntityMap, safeFormatDate, type Task } from '@mindwtr/core';

const routerPushMock = vi.hoisted(() => vi.fn());
const setHighlightTaskMock = vi.hoisted(() => vi.fn());
const taskEditModalPropsSpy = vi.hoisted(() => vi.fn());
const updateTaskMock = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ q: 'Launch' as string | undefined }));
const storageAdapterState = vi.hoisted(() => ({
    searchAll: undefined as undefined | ((query: string) => Promise<any>),
}));
const storeState = vi.hoisted(() => ({
    _allTasks: [] as Task[],
    // PERF-03: the component reads _tasksById straight from the store
    // instead of rebuilding a Map from _allTasks on every render. This mock
    // has no real store behind it, so mirror that field as a getter over
    // whichever tasks the test currently has assigned to _allTasks — every
    // `storeState._allTasks = tasks` assignment below keeps it correct with
    // no other test needing to change.
    get _tasksById() {
        return buildEntityMap(this._allTasks);
    },
    projects: [],
    areas: [],
    settings: {
        savedSearches: [],
    },
    updateSettings: vi.fn(),
    updateTask: updateTaskMock,
    setHighlightTask: setHighlightTaskMock,
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return {
        ...actual,
        getStorageAdapter: () => (storageAdapterState.searchAll ? { searchAll: storageAdapterState.searchAll } : {}),
        shallow: Object.is,
        useTaskStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
    };
});

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => routeParams,
    useRouter: () => ({ push: routerPushMock }),
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: any) => children,
}));

vi.mock('@/components/task-edit-modal', () => ({
    TaskEditModal: (props: any) => {
        taskEditModalPropsSpy(props);
        return React.createElement('TaskEditModal', {
            taskId: props.task?.id,
            visible: props.visible,
        });
    },
}));

vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({
        bg: '#ffffff',
        border: '#d1d5db',
        cardBg: '#ffffff',
        danger: '#dc2626',
        filterBg: '#f8fafc',
        icon: '#64748b',
        inputBg: '#ffffff',
        onTint: '#ffffff',
        secondaryText: '#64748b',
        success: '#16a34a',
        tabIconDefault: '#64748b',
        tabIconSelected: '#2563eb',
        taskItemBg: '#ffffff',
        text: '#0f172a',
        tint: '#2563eb',
        warning: '#f59e0b',
    }),
}));

vi.mock('../contexts/language-context', () => ({
    useLanguage: () => ({
        t: (key: string) => ({
            'common.cancel': 'Cancel',
            'common.clear': 'Clear',
            'common.close': 'Close',
            'common.save': 'Save',
            'common.search': 'Search',
            'filters.label': 'Filters',
            'search.helpOperators': 'Use operators',
            'search.inProjectSuffix': 'in project',
            'search.completedDate': 'Completed {{date}}',
            'search.dueDate': 'Due {{date}}',
            'search.hiddenCompletedMatches': '{{count}} more in Done & Archived',
            'search.noResults': 'No results',
            'search.placeholder': 'Search',
            'search.resultTask': 'Task',
            'search.saveSearch': 'Save search',
            'search.searching': 'Searching',
        }[key] ?? key),
    }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
    openContextsScreen: vi.fn(),
    openProjectScreen: vi.fn(),
}));

const showToastMock = vi.hoisted(() => vi.fn());
vi.mock('../contexts/toast-context', () => ({
    useToast: () => ({ showToast: showToastMock }),
    ToastViewport: () => null,
}));

const nowIso = '2026-06-01T12:00:00.000Z';

const makeTask = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
});

import SearchScreen from './global-search';

describe('SearchScreen task results', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        routeParams.q = 'Launch';
        storageAdapterState.searchAll = undefined;
        const tasks = [
            makeTask('task-1', 'Launch checklist'),
            makeTask('task-2', 'Home errands'),
        ];
        storeState._allTasks = tasks;
        storeState.projects = [];
        storeState.areas = [];
        storeState.settings = { savedSearches: [] };
        storeState.updateSettings = vi.fn();
        storeState.updateTask = updateTaskMock;
        storeState.setHighlightTask = setHighlightTaskMock;
    });

    it('opens the task editor when pressing a task search result', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<SearchScreen />);
        });

        const resultList = tree.root.findByType(FlatList);
        expect(resultList.props.data.map((result: any) => result.item.id)).toEqual(['task-1']);

        const resultRow = resultList.props.renderItem({
            item: resultList.props.data[0],
            index: 0,
        });

        act(() => {
            resultRow.props.onPress();
        });

        expect(setHighlightTaskMock).toHaveBeenCalledWith('task-1');
        expect(routerPushMock).not.toHaveBeenCalled();
        expect(taskEditModalPropsSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            visible: true,
            task: expect.objectContaining({ id: 'task-1' }),
        }));
    });

    it('completes a task from the search row check icon with an undo toast', async () => {
        // #1051: the check icon is a real completion toggle, not decoration.
        updateTaskMock.mockResolvedValue({ success: true });
        let tree!: ReturnType<typeof create>;
        act(() => {
            tree = create(<SearchScreen />);
        });

        const resultList = tree.root.findByType(FlatList);
        const resultRow = resultList.props.renderItem({
            item: resultList.props.data[0],
            index: 0,
        });
        let rowTree!: ReturnType<typeof create>;
        act(() => {
            rowTree = create(resultRow);
        });
        const checkButton = rowTree.root.findAllByType(TouchableOpacity).find(
            (node) => node.props.accessibilityLabel === 'Mark Done'
        );
        expect(checkButton).toBeDefined();

        await act(async () => {
            checkButton!.props.onPress();
            await Promise.resolve();
        });

        expect(updateTaskMock).toHaveBeenCalledWith('task-1', { status: 'done' });
        expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
            actionLabel: expect.any(String),
            onAction: expect.any(Function),
        }));
        // Completing from the icon must not open the editor.
        expect(taskEditModalPropsSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            visible: false,
        }));
    });

    it('shows matching tasks when only a tag filter is selected', () => {
        routeParams.q = '';
        storeState._allTasks = [
            makeTask('task-1', 'Client launch', { tags: ['#client'] }),
            makeTask('task-2', 'Home errands', { tags: ['#home'] }),
        ];

        let tree!: ReturnType<typeof create>;
        act(() => {
            tree = create(<SearchScreen />);
        });

        const filterButton = tree.root
            .findAllByType(TouchableOpacity)
            .find((node) => node.props.accessibilityLabel === 'Filters');
        expect(filterButton).toBeDefined();

        act(() => {
            filterButton!.props.onPress();
        });

        const tagChip = tree.root.findAllByType(TouchableOpacity).find((node) => (
            node.findAllByType(Text).some((textNode) => textNode.props.children === '#client')
        ));
        expect(tagChip).toBeDefined();

        act(() => {
            tagChip!.props.onPress();
        });

        const resultList = tree.root.findByType(FlatList);
        expect(resultList.props.data.map((result: any) => result.item.id)).toEqual(['task-1']);
    });

    it('refreshes hidden-future results at midnight and at an explicit start time', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-04-16T23:59:30'));
            routeParams.q = '';
            storeState._allTasks = [
                makeTask('tomorrow-date', 'Tomorrow date task', { startTime: '2026-04-17' }),
                makeTask('tomorrow-time', 'Tomorrow timed task', { startTime: '2026-04-17T00:01' }),
            ];

            let tree!: ReturnType<typeof create>;
            act(() => {
                tree = create(<SearchScreen />);
            });
            const filterButton = tree.root
                .findAllByType(TouchableOpacity)
                .find((node) => node.props.accessibilityLabel === 'Filters');
            act(() => {
                filterButton!.props.onPress();
            });
            const hideFutureChip = tree.root.findAllByType(TouchableOpacity).find((node) => (
                node.findAllByType(Text).some((textNode) => textNode.props.children === 'Hide future tasks')
            ));
            act(() => {
                hideFutureChip!.props.onPress();
            });
            const resultIds = () => tree.root.findByType(FlatList).props.data.map((result: any) => result.item.id);
            expect(resultIds()).toEqual([]);

            act(() => {
                vi.advanceTimersByTime(30_100);
            });
            expect(resultIds()).toEqual(['tomorrow-date']);

            act(() => {
                vi.advanceTimersByTime(60_100);
            });
            expect(resultIds()).toEqual(['tomorrow-date', 'tomorrow-time']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('offers to include hidden done and archived matches instead of hiding them silently', () => {
        storeState._allTasks = [
            makeTask('task-1', 'Launch checklist', { status: 'done' }),
            makeTask('task-2', 'Home errands'),
        ];

        let tree!: ReturnType<typeof create>;
        act(() => {
            tree = create(<SearchScreen />);
        });

        expect(tree.root.findByType(FlatList).props.data).toEqual([]);

        const hint = tree.root.findAllByType(TouchableOpacity).find((node) =>
            node.findAllByType(Text).some((textNode) =>
                String(textNode.props.children).includes('more in Done & Archived')
            )
        );
        expect(hint).toBeDefined();
        expect(hint!.findAllByType(Text).some((textNode) =>
            String(textNode.props.children).startsWith('1 more')
        )).toBe(true);

        act(() => {
            hint!.props.onPress();
        });

        expect(tree.root.findByType(FlatList).props.data.map((result: any) => result.item.id)).toEqual(['task-1']);
    });

    it('does not offer hidden matches when nothing matching is done or archived', () => {
        let tree!: ReturnType<typeof create>;
        act(() => {
            tree = create(<SearchScreen />);
        });

        const hint = tree.root.findAllByType(TouchableOpacity).find((node) =>
            node.findAllByType(Text).some((textNode) =>
                String(textNode.props.children).includes('more in Done & Archived')
            )
        );
        expect(hint).toBeUndefined();
    });

    it('returns a done task looked up by id even though done matches are hidden by default', () => {
        routeParams.q = 'id:task-1';
        storeState._allTasks = [
            makeTask('task-1', 'Launch checklist', { status: 'done' }),
            makeTask('task-2', 'Home errands'),
        ];

        let tree!: ReturnType<typeof create>;
        act(() => {
            tree = create(<SearchScreen />);
        });

        expect(tree.root.findByType(FlatList).props.data.map((result: any) => result.item.id)).toEqual(['task-1']);
    });

    // A bare date on a search row cannot say whether it is a deadline or a
    // record of when the work finished (#991).
    describe('result dates', () => {
        const completedAt = '2026-05-01T09:15:00.000Z';

        const renderWithDateTasks = () => {
            routeParams.q = 'Zeta';
            storeState._allTasks = [
                makeTask('t-done', 'Zeta done', { status: 'done', completedAt }),
                makeTask('t-archived', 'Zeta archived', { status: 'archived', completedAt }),
                makeTask('t-unstamped', 'Zeta unstamped', { status: 'archived' }),
                makeTask('t-due', 'Zeta due', { dueDate: '2099-01-01' }),
                makeTask('t-overdue', 'Zeta overdue', { dueDate: '2020-01-01' }),
                makeTask('t-plain', 'Zeta plain'),
            ];

            let tree!: ReturnType<typeof create>;
            act(() => {
                tree = create(<SearchScreen />);
            });

            // Done and Archived matches are hidden until asked for.
            const hint = tree.root.findAllByType(TouchableOpacity).find((node) =>
                node.findAllByType(Text).some((textNode) =>
                    String(textNode.props.children).includes('more in Done & Archived')
                )
            );
            act(() => {
                hint!.props.onPress();
            });
            return tree;
        };

        // FlatList is a host component in the shim, so the row has to be
        // rendered on its own to read what it puts on screen.
        const dateLineOf = (tree: ReturnType<typeof create>, taskId: string) => {
            const list = tree.root.findByType(FlatList);
            const index = list.props.data.findIndex((result: any) => result.item.id === taskId);
            expect(index, `search result for ${taskId}`).toBeGreaterThanOrEqual(0);
            const element = list.props.renderItem({ item: list.props.data[index], index });
            let rowTree!: ReturnType<typeof create>;
            act(() => {
                rowTree = create(element);
            });
            return rowTree.root
                .findAllByType(Text)
                .map((node) => ({
                    text: String(node.props.children),
                    color: Array.isArray(node.props.style) ? node.props.style[1]?.color : undefined,
                }))
                .find((line) => /^(Completed|Due) /.test(line.text)) ?? null;
        };

        it('labels a finished task with its completion date', () => {
            const tree = renderWithDateTasks();

            const label = `Completed ${safeFormatDate(completedAt, 'Pp')}`;
            expect(dateLineOf(tree, 't-done')?.text).toBe(label);
            // A status gate that only checks 'done' misses archived (#968).
            expect(dateLineOf(tree, 't-archived')?.text).toBe(label);
        });

        it('labels an unfinished task with its due date and reddens only the overdue one', () => {
            const tree = renderWithDateTasks();

            const due = dateLineOf(tree, 't-due');
            expect(due?.text).toBe(`Due ${safeFormatDate('2099-01-01', 'P')}`);
            expect(due?.color).toBe('#64748b');
            // Red is reserved for a date that has passed (#640).
            expect(dateLineOf(tree, 't-overdue')?.color).toBe('#dc2626');
        });

        it('shows no date at all rather than an ambiguous or empty one', () => {
            const tree = renderWithDateTasks();

            expect(dateLineOf(tree, 't-plain')).toBeNull();
            // Finished with nothing to report: no fallback to the due date.
            expect(dateLineOf(tree, 't-unstamped')).toBeNull();
        });
    });

    it('keeps literal CJK substring matches when SQLite search returns partial token matches', async () => {
        vi.useFakeTimers();
        try {
            routeParams.q = '搬家';
            const tasks = [
                makeTask('task-1', '準備搬家了'),
                makeTask('task-2', '列出需要處理的搬家物品'),
                makeTask('task-3', '搬家到新住處'),
            ];
            storeState._allTasks = tasks;
            storageAdapterState.searchAll = vi.fn(async () => ({
                tasks: [tasks[2]],
                projects: [],
            }));

            let tree!: ReturnType<typeof create>;
            await act(async () => {
                tree = create(<SearchScreen />);
            });

            await act(async () => {
                vi.advanceTimersByTime(250);
                await Promise.resolve();
            });

            const resultList = tree.root.findByType(FlatList);
            expect(resultList.props.data.map((result: any) => result.item.id)).toEqual([
                'task-3',
                'task-1',
                'task-2',
            ]);
            expect(storageAdapterState.searchAll).toHaveBeenCalledWith('搬家');
        } finally {
            vi.useRealTimers();
        }
    });
});
