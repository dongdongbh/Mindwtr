import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Area, Project, Task } from '@mindwtr/core';

const addTaskMock = vi.hoisted(() => vi.fn());
const updateTaskMock = vi.hoisted(() => vi.fn());
const setHighlightTaskMock = vi.hoisted(() => vi.fn());
const taskEditModalPropsSpy = vi.hoisted(() => vi.fn());
const bulkOrganizeModalPropsSpy = vi.hoisted(() => vi.fn());
const taskListHeaderPropsSpy = vi.hoisted(() => vi.fn());
const flatListPropsSpy = vi.hoisted(() => vi.fn());
const flatListScrollToIndexMock = vi.hoisted(() => vi.fn());
const flatListScrollToOffsetMock = vi.hoisted(() => vi.fn());
const rowRenderSpy = vi.hoisted(() => vi.fn());
const mobileAreaFilterState = vi.hoisted(() => ({
  current: {
    areaById: new Map<string, Area>(),
    resolvedAreaFilter: { included: [] as string[], excluded: [] as string[] },
  },
}));
const taskListSelectionState = vi.hoisted(() => ({
  current: {
    bulkActionLabel: 'Move',
    bulkActionLoading: false,
    exitSelectionMode: vi.fn(),
    handleBatchAddTag: vi.fn(),
    handleBatchDelete: vi.fn(),
    handleBatchOrganize: vi.fn(),
    handleBatchMove: vi.fn(),
    handleBatchRemoveTags: vi.fn(),
    hasSelection: false,
    multiSelectedIds: new Set<string>(),
    rangeSelectMode: false,
    removableTagOptions: [] as string[],
    removeTagPickerVisible: false,
    selectedIdsArray: [] as string[],
    selectionMode: false,
    setRemoveTagPickerVisible: vi.fn(),
    setTagInput: vi.fn(),
    setTagModalVisible: vi.fn(),
    tagInput: '',
    tagModalVisible: false,
    toggleMultiSelect: vi.fn(),
    toggleRangeSelectMode: vi.fn(),
  },
}));

const projectFixture = vi.hoisted(() => ({
  id: 'project-1',
  title: 'Launch',
  color: '#2563eb',
  order: 0,
  status: 'active',
  tagIds: [],
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
}));

const project = projectFixture as Project;

const makeTask = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title,
  status: 'next',
  projectId: project.id,
  tags: [],
  contexts: [],
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...overrides,
});

const storeState = vi.hoisted(() => ({
  tasks: [] as Task[],
  _allTasks: [] as Task[],
  projects: [projectFixture as Project],
  sections: [],
  areas: [] as Area[],
  addTask: addTaskMock,
  updateTask: updateTaskMock,
  deleteTask: vi.fn(),
  restoreTask: vi.fn(),
  batchMoveTasks: vi.fn(),
  batchDeleteTasks: vi.fn(),
  batchUpdateTasks: vi.fn(),
  reorderProjectTasks: vi.fn(),
  reorderSections: vi.fn(),
  settings: {
    ai: { enabled: false },
    appearance: {},
    features: {},
  } as AppSettings,
  getDerivedState: vi.fn(() => ({
    focusedCount: storeState._allTasks.filter((task) => task.isFocusedToday).length,
  })),
  updateSettings: vi.fn(),
  highlightTaskId: null as string | null,
  setHighlightTask: setHighlightTaskMock,
}));

vi.mock('react-native', () => ({
  FlatList: React.forwardRef(function MockFlatList(allProps: any, ref: any) {
    const { data, ListEmptyComponent, ListHeaderComponent, renderItem } = allProps;
    flatListPropsSpy(allProps);
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: flatListScrollToIndexMock,
      scrollToOffset: flatListScrollToOffsetMock,
    }));
    return React.createElement(
      'FlatList',
      null,
      typeof ListHeaderComponent === 'function' ? React.createElement(ListHeaderComponent) : ListHeaderComponent,
      data?.length
        ? data.map((item: unknown, index: number) => renderItem?.({ item, index }))
        : (typeof ListEmptyComponent === 'function' ? React.createElement(ListEmptyComponent) : ListEmptyComponent),
    );
  }),
  Modal: ({ children, visible, ...props }: any) => (visible ? React.createElement('Modal', props, children) : null),
  // The save/add paths open a performance diagnostic, which reads Platform.OS.
  Platform: { OS: 'android', select: (options: any) => options.android ?? options.default },
  Pressable: ({ children, onPress, ...props }: any) => React.createElement('Pressable', { ...props, onPress }, children),
  RefreshControl: () => null,
  ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
  // TokenPickerModal's search field.
  TextInput: () => React.createElement('TextInput'),
  TouchableOpacity: ({ children, onPress, ...props }: any) => React.createElement('TouchableOpacity', { ...props, onPress }, children),
  View: ({ children, ...props }: any) => React.createElement('View', props, children),
  useWindowDimensions: () => ({ width: 390, height: 800 }),
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
}));

vi.mock('lucide-react-native', () => ({
  ArrowDown: () => null,
  ArrowUp: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  GripVertical: () => null,
  MoveVertical: () => null,
  X: () => null,
}));

vi.mock('react-native-draggable-flatlist', () => ({
  default: (props: any) => React.createElement('DraggableFlatList', props),
  NestableDraggableFlatList: (props: any) => React.createElement('NestableDraggableFlatList', props),
  ScaleDecorator: ({ children, ...props }: any) => React.createElement('ScaleDecorator', props, children),
}));

// Spread the real module and replace only the store hook (see
// test-support/mock-core.ts). The old hand-listed mock returned nothing else, so
// every core export the component tree grew afterwards arrived as undefined.
vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../test-support/mock-core');
  return mockCore(importOriginal as () => Promise<Record<string, unknown>>, () => storeState, {
    getTaskMetadataFilterVisibility: vi.fn(() => ({
      showEnergy: true,
      showLocation: true,
      showPriority: true,
      showTimeEstimate: true,
    })),
    getUsedTaskTokens: vi.fn(() => []),
    hasActiveFilterCriteria: vi.fn(() => false),
    matchesTask: vi.fn(() => true),
    parseSearchQuery: vi.fn(() => ({ filters: [], text: '' })),
    sortTasksBy: (tasks: Task[]) => tasks,
    splitCompletedTasks: (tasks: Task[]) => ({ activeTasks: tasks, completedTasks: [] }),
    taskMatchesFilterCriteria: vi.fn(() => true),
  });
});

vi.mock('./task-edit-modal', () => ({
  TaskEditModal: (props: any) => {
    taskEditModalPropsSpy(props);
    return React.createElement('TaskEditModal', { visible: props.visible, taskId: props.task?.id });
  },
}));

vi.mock('./ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => children,
}));

vi.mock('./list-empty-state', () => ({
  ListEmptyState: () => null,
}));

vi.mock('./swipeable-task-item', () => ({
  // The spy stands in for the real module's render counter (#766): it fires
  // exactly where `SwipeableTaskItem` increments `taskRowRenderCount`, so a row
  // that memoises away never reaches it.
  SwipeableTaskItem: (props: any) => {
    rowRenderSpy(props.task?.id);
    return React.createElement('SwipeableTaskItem', props);
  },
  readTaskRowRenderCount: () => 0,
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => ({
      'common.notice': 'Notice',
      'filters.clear': 'Clear',
      'filters.noMatch': 'No tasks match these filters.',
      'list.noTasks': 'No tasks',
      'quickAdd.invalidDateCommand': 'Invalid date command',
    }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => {
  // One object, like the real hook: resolveThemeTokens caches its result, so a
  // fresh literal per call would fake instability the app never sees (#766).
  const themeColors = {
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
  };
  return { useThemeColors: () => themeColors };
});

vi.mock('@/hooks/use-reduced-motion', () => ({
  useReducedMotion: () => false,
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => mobileAreaFilterState.current,
}));

vi.mock('@/contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@/components/PullSyncIndicator', () => ({
  PullSyncIndicator: () => null,
}));

vi.mock('@/hooks/use-manual-pull-sync', () => ({
  useManualPullSync: () => ({
    handleRefresh: vi.fn(),
    indicatorState: 'idle',
    refreshing: false,
  }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

vi.mock('../lib/app-log', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('./use-task-list-selection', () => ({
  useTaskListSelection: () => taskListSelectionState.current,
  usePruneSelectionToVisible: () => undefined,
}));

vi.mock('./task-list/TaskListBulkBar', () => ({
  TaskListBulkBar: (props: any) => React.createElement('TaskListBulkBar', props),
  getBulkMoveStatusOptions: (currentStatus?: string) => (
    ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'].filter((status) => status !== currentStatus)
  ),
}));

vi.mock('./task-list/TaskListBulkOrganizeModal', () => ({
  TaskListBulkOrganizeModal: (props: any) => {
    bulkOrganizeModalPropsSpy(props);
    return React.createElement('TaskListBulkOrganizeModal', props);
  },
}));

const resetTaskListSelectionState = () => {
  taskListSelectionState.current = {
    bulkActionLabel: 'Move',
    bulkActionLoading: false,
    exitSelectionMode: vi.fn(),
    handleBatchAddTag: vi.fn(),
    handleBatchDelete: vi.fn(),
    handleBatchOrganize: vi.fn(),
    handleBatchMove: vi.fn(),
    handleBatchRemoveTags: vi.fn(),
    hasSelection: false,
    multiSelectedIds: new Set(),
    rangeSelectMode: false,
    removableTagOptions: [],
    removeTagPickerVisible: false,
    selectedIdsArray: [],
    selectionMode: false,
    setRemoveTagPickerVisible: vi.fn(),
    setTagInput: vi.fn(),
    setTagModalVisible: vi.fn(),
    tagInput: '',
    tagModalVisible: false,
    toggleMultiSelect: vi.fn(),
    toggleRangeSelectMode: vi.fn(),
  };
};

vi.mock('./task-filter-sheet', () => ({
  TaskFilterSheet: () => null,
}));

vi.mock('./task-list/TaskListHeader', () => ({
  TaskListHeader: (props: any) => {
    taskListHeaderPropsSpy(props);
    return React.createElement('TaskListHeader', props);
  },
}));

vi.mock('./task-list/TaskListSortModal', () => ({
  TaskListSortModal: () => null,
}));

vi.mock('./task-list/TaskListTagModal', () => ({
  TaskListTagModal: () => null,
}));

import { TaskList } from './task-list';

const latestHeaderProps = () => taskListHeaderPropsSpy.mock.calls.at(-1)?.[0];

describe('TaskList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTaskListSelectionState();
    storeState.tasks = [];
    storeState._allTasks = [];
    storeState.areas = [];
    storeState.projects = [projectFixture as Project];
    storeState.highlightTaskId = null;
    mobileAreaFilterState.current = {
      areaById: new Map(),
      resolvedAreaFilter: { included: [], excluded: [] },
    };
    storeState.settings = {
      ai: { enabled: false },
      appearance: {},
      features: {},
    };
    // Entering project reorder mode schedules its entry scroll on a frame.
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a References pile below the project list, including tag-matched references (#1000)', async () => {
    const active = makeTask('task-1', 'Write intro');
    const ownReference = makeTask('ref-1', 'Style guide', { status: 'reference' });
    const tagReference = makeTask('ref-2', 'Shared bibliography', { status: 'reference', projectId: 'project-2', tags: ['#research'] });
    const unrelatedReference = makeTask('ref-3', 'Elsewhere', { status: 'reference', projectId: 'project-2' });
    storeState.tasks = [active, ownReference, tagReference, unrelatedReference];
    storeState.projects = [{ ...projectFixture, tagIds: ['#research'] } as Project];

    let tree!: ReturnType<typeof create>;
    try {
      await act(async () => {
        tree = create(
          <TaskList
            project={{ id: project.id }}
            showHeader={false}
            statusFilter="all"
            taskSource={[active, ownReference]}
            title={project.title}
          />,
        );
      });

      const data = flatListPropsSpy.mock.calls.at(-1)?.[0].data as Array<{ type: string; id?: string; count?: number; task?: Task }>;
      const sectionIndex = data.findIndex((item) => item.type === 'section' && item.id === 'project-reference-tasks');
      expect(sectionIndex).toBeGreaterThan(-1);
      expect(data[sectionIndex].count).toBe(2);
      const referenceIds = data.filter((item) => item.type === 'task' && item.task?.status === 'reference').map((item) => item.task!.id);
      expect(referenceIds).toEqual(['ref-1', 'ref-2']);
      // The main list stays reference-free: the active row sits above the pile.
      expect(data.findIndex((item) => item.type === 'task' && item.task?.id === 'task-1')).toBeLessThan(sectionIndex);

      act(() => {
        tree.unmount();
      });
    } finally {
      storeState.projects = [projectFixture as Project];
    }
  });

  it('passes a group control to non-reference list headers', async () => {
    const onChangeGroupBy = vi.fn();
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          groupBy="tag"
          onChangeGroupBy={onChangeGroupBy}
          showHeader={false}
          statusFilter="inbox"
          taskSource={[]}
          title="Inbox"
        />,
      );
    });

    expect(latestHeaderProps()).toEqual(expect.objectContaining({
      groupByLabel: 'Tags',
      onOpenGroup: expect.any(Function),
    }));

    act(() => {
      tree.unmount();
    });
  });

  it('shows a Someday task inside its Someday project under the project group', async () => {
    const workArea: Area = {
      id: 'area-work',
      name: 'Work',
      color: '#3b82f6',
      order: 0,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    };
    const somedayProject: Project = {
      ...project,
      id: 'project-someday',
      title: 'Someday ideas',
      status: 'someday',
      areaId: workArea.id,
    };
    const somedayTask = makeTask('someday-project-task', 'Try a pottery class', {
      status: 'someday',
      projectId: somedayProject.id,
    });
    storeState.areas = [workArea];
    storeState.projects = [somedayProject];
    mobileAreaFilterState.current = {
      areaById: new Map([[workArea.id, workArea]]),
      resolvedAreaFilter: { included: [workArea.id], excluded: [] },
    };

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <TaskList
          groupBy="project"
          onChangeGroupBy={vi.fn()}
          showHeader={false}
          statusFilter="someday"
          taskSource={[somedayTask]}
          title="Someday"
        />,
      );
    });

    const data = flatListPropsSpy.mock.calls.at(-1)?.[0].data as { type: string; title?: string; task?: Task }[];
    expect(data.some((item) => item.type === 'section' && item.title === 'Someday ideas')).toBe(true);
    expect(data.some((item) => item.type === 'task' && item.task?.id === somedayTask.id)).toBe(true);

    act(() => {
      tree.unmount();
    });
  });

  it('folds a grouping heading, dropping its rows from the list data', async () => {
    const tagged = makeTask('task-tagged', 'Book the venue', { status: 'inbox', projectId: undefined, tags: ['events'] });
    const untagged = makeTask('task-untagged', 'Fix the printer', { status: 'inbox', projectId: undefined });
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          groupBy="tag"
          onChangeGroupBy={vi.fn()}
          showHeader={false}
          statusFilter="inbox"
          taskSource={[tagged, untagged]}
          title="Inbox"
        />,
      );
    });

    const listData = () => flatListPropsSpy.mock.calls.at(-1)?.[0].data as any[];
    const header = listData().find((item) => item.type === 'section' && item.id === 'tag:events');
    expect(header).toMatchObject({ title: 'events', count: 1, collapsible: true, collapsed: false });
    expect(listData().some((item) => item.type === 'task' && item.task.id === 'task-tagged')).toBe(true);

    const renderItem = flatListPropsSpy.mock.calls.at(-1)?.[0].renderItem;
    await act(async () => {
      renderItem({ item: header }).props.onPress();
    });

    expect(listData().find((item) => item.type === 'section' && item.id === 'tag:events'))
      .toMatchObject({ count: 1, collapsed: true });
    // The row leaves the data, which is what orderedTaskIds and range select read.
    expect(listData().some((item) => item.type === 'task' && item.task.id === 'task-tagged')).toBe(false);
    expect(listData().some((item) => item.type === 'task' && item.task.id === 'task-untagged')).toBe(true);

    act(() => {
      tree.unmount();
    });
  });

  it('publishes project selection actions to an external bulk bar with organize available', async () => {
    taskListSelectionState.current = {
      ...taskListSelectionState.current,
      hasSelection: true,
      selectedIdsArray: ['task-1', 'task-2'],
      selectionMode: true,
    };
    const onBulkBarPropsChange = vi.fn();
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          bulkBarPlacement="external"
          onBulkBarPropsChange={onBulkBarPropsChange}
          project={{ id: project.id, enableBulkOrganize: true }}
          showHeader={false}
          statusFilter="all"
          taskSource={[]}
          title={project.title}
        />,
      );
    });

    const bulkBarProps = onBulkBarPropsChange.mock.calls.at(-1)?.[0];
    expect(bulkBarProps).toEqual(expect.objectContaining({
      hasSelection: true,
      selectedCount: 2,
    }));
    expect(typeof bulkBarProps.onOpenOrganize).toBe('function');
    expect(tree.root.findAll((node) => String(node.type) === 'TaskListBulkBar')).toHaveLength(0);

    act(() => {
      bulkBarProps.onOpenOrganize();
    });

    expect(bulkOrganizeModalPropsSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      selectedCount: 2,
      visible: true,
    }));
  });



  it('omits the current page status from bulk move options and orders Done before Reference', async () => {
    taskListSelectionState.current = {
      ...taskListSelectionState.current,
      hasSelection: true,
      selectedIdsArray: ['task-1'],
      selectionMode: true,
    };
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          showHeader={false}
          statusFilter="inbox"
          taskSource={[]}
          title="Inbox"
        />,
      );
    });

    const bulkBarProps = tree.root.findAll((node) => String(node.type) === 'TaskListBulkBar')[0]?.props;
    expect(bulkBarProps.statusOptions).toEqual(['next', 'waiting', 'someday', 'done', 'reference']);

    act(() => {
      tree.unmount();
    });
  });

  it('scrolls to a row flagged via the shared highlightTaskId, e.g. quick-capture (#916)', async () => {
    const captured = makeTask('capture-task', 'Captured into project', { status: 'inbox' });
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <TaskList
          project={{ id: project.id }}
          showHeader={false}
          statusFilter="all"
          taskSource={[captured]}
          title={project.title}
        />,
      );
    });

    // The quick-capture sheet sets highlightTaskId as it closes; the list scrolls
    // once the flagged row is present in the rendered data (no composer involved).
    storeState.highlightTaskId = 'capture-task';
    await act(async () => {
      tree.update(
        <TaskList
          project={{ id: project.id }}
          showHeader={false}
          statusFilter="all"
          taskSource={[captured]}
          title={project.title}
        />,
      );
    });

    expect(flatListScrollToIndexMock).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));

    // Variable row heights mean an unmeasured target throws; the fallback jumps
    // to an estimated offset (index * averageItemLength) before retrying.
    const flatListProps = flatListPropsSpy.mock.calls.at(-1)?.[0];
    act(() => {
      flatListProps.onScrollToIndexFailed({ index: 4, averageItemLength: 90 });
    });
    expect(flatListScrollToOffsetMock).toHaveBeenCalledWith({ offset: 360, animated: false });

    act(() => {
      tree.unmount();
    });
  });

  it('does not scroll a highlighted row while project reorder mode is active (#916)', async () => {
    const existing = makeTask('task-1', 'Existing task', { status: 'inbox' });
    storeState.highlightTaskId = existing.id;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <TaskList
          project={{ id: project.id, enableReorder: true, reorderMode: true }}
          showHeader={false}
          statusFilter="all"
          taskSource={[existing]}
          title={project.title}
        />,
      );
    });

    // Reorder mode swaps in the draggable list, so the highlight-scroll effect
    // has no FlatList to drive and must leave the drag list alone.
    expect(flatListScrollToIndexMock).not.toHaveBeenCalled();
    expect(tree.root.findAll((node) => String(node.type) === 'DraggableFlatList').length).toBeGreaterThan(0);

    act(() => {
      tree.unmount();
    });
  });

  // The editor closes the moment a save is handed off, so a swallowed
  // `{ success: false }` reads to the user as a task that saved. useTaskEditActions
  // only sees the result if the handler returns the store promise.
  it('hands the store result back to the editor so a failed save can surface', async () => {
    const visibleTask = makeTask('task-save', 'Review launch notes');
    updateTaskMock.mockResolvedValue({ success: false, error: 'Task is deleted' });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <TaskList
          showHeader={false}
          statusFilter="next"
          taskSource={[visibleTask]}
          title="Next"
        />,
      );
    });

    const onSave = taskEditModalPropsSpy.mock.calls.at(-1)?.[0].onSave;
    let saveResult: unknown;
    await act(async () => {
      saveResult = await onSave('task-save', { title: 'Review launch notes v2' });
    });

    expect(updateTaskMock).toHaveBeenCalledWith('task-save', { title: 'Review launch notes v2' });
    expect(saveResult).toEqual({ success: false, error: 'Task is deleted' });

    act(() => {
      tree.unmount();
    });
  });

  it('passes shared row context to task rows instead of making each row subscribe to the store', async () => {
    const visibleTask = makeTask('task-row-context', 'Review launch notes');
    storeState.tasks = [visibleTask];
    storeState._allTasks = [visibleTask];

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <TaskList
          showHeader={false}
          statusFilter="next"
          taskSource={[visibleTask]}
          title="Next"
        />,
      );
    });

    const row = tree.root.findByType('SwipeableTaskItem' as unknown as React.ElementType);
    expect(row.props.rowContext).toEqual(expect.objectContaining({
      areas: storeState.areas,
      focusedCount: 0,
      projects: storeState.projects,
      restoreTask: storeState.restoreTask,
      updateTask: updateTaskMock,
    }));
    expect(row.props.rowContext).toEqual(expect.objectContaining({
      focusTaskLimit: 3,
      showTaskAge: false,
      timeEstimatesEnabled: true,
    }));

    act(() => {
      tree.unmount();
    });
  });

  it('reads focusedCount from the memoized derived state, not a fresh scan of the rendered task list (#766)', async () => {
    const visibleTask = makeTask('task-row-context-derived', 'Review launch notes');
    // state.tasks intentionally disagrees with _allTasks here: if focusedCount
    // were computed by scanning state.tasks (the pre-fix regression) it would
    // report 5; the memoized getDerivedState() correctly counts _allTasks.
    storeState.tasks = Array.from(
      { length: 5 },
      (_, index) => makeTask(`misleading-focused-${index}`, `Misleading ${index}`, { isFocusedToday: true }),
    );
    storeState._allTasks = [visibleTask];

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <TaskList
          showHeader={false}
          statusFilter="next"
          taskSource={[visibleTask]}
          title="Next"
        />,
      );
    });

    const row = tree.root.findByType('SwipeableTaskItem' as unknown as React.ElementType);
    expect(row.props.rowContext.focusedCount).toBe(0);
    expect(storeState.getDerivedState).toHaveBeenCalled();

    act(() => {
      tree.unmount();
    });
  });

  // The memo boundary itself now lives in the row module and is pinned there,
  // against the real component, in swipeable-task-item.test.tsx. What this list
  // owes it is prop identity: after a single edit, every untouched row must get
  // back the props it already had, or the boundary cannot hold.
  it('leaves untouched rows their existing props after one task changes (#766)', async () => {
    const listProps = (taskSource: Task[]) => ({
      showHeader: false,
      statusFilter: 'next' as const,
      taskSource,
      title: 'Next',
    });
    const tasks = Array.from({ length: 30 }, (_, index) => makeTask(`row-${index}`, `Task ${index}`));
    storeState.tasks = tasks;
    storeState._allTasks = tasks;

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TaskList {...listProps(tasks)} />);
    });
    expect(new Set(rowRenderSpy.mock.calls.map(([id]) => id)).size).toBe(30);

    const rowPropsById = () => new Map(
      tree.root.findAllByType('SwipeableTaskItem' as never)
        .map((node) => [node.props.task.id as string, node.props]),
    );
    const before = rowPropsById();

    // What a single task edit looks like from the list's side: a fresh tasks
    // array in which exactly one task object was replaced.
    const editedTasks = tasks.map((task, index) => (
      index === 7 ? { ...task, title: 'Task 7 (edited)' } : task
    ));
    storeState.tasks = editedTasks;
    storeState._allTasks = editedTasks;

    await act(async () => {
      tree.update(<TaskList {...listProps(editedTasks)} />);
    });

    const after = rowPropsById();
    expect(after.get('row-7')?.task.title).toBe('Task 7 (edited)');
    const changed = [...after.entries()].filter(([id, props]) => (
      props.task !== before.get(id)?.task
      || props.actions !== before.get(id)?.actions
      || props.tc !== before.get(id)?.tc
      || props.rowContext !== before.get(id)?.rowContext
    ));
    expect(changed.map(([id]) => id)).toEqual(['row-7']);

    act(() => {
      tree.unmount();
    });
  });

  it('uses compact draggable rows without extra placeholder or scale overlays for long project reorder lists', async () => {
    const longTaskList = Array.from({ length: 130 }, (_, index) => makeTask(
      `task-${index}`,
      `Task ${index}`,
      { order: index },
    ));
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          project={{ id: project.id, enableReorder: true, reorderMode: true }}
          showHeader={false}
          statusFilter="all"
          taskSource={longTaskList}
          title={project.title}
        />,
      );
    });

    const draggableList = tree.root.findByType('DraggableFlatList' as unknown as React.ElementType);
    expect(draggableList.props.data).toHaveLength(longTaskList.length);
    expect(draggableList.props.renderPlaceholder).toBeUndefined();
    expect(draggableList.props.animationConfig).toEqual(expect.objectContaining({
      overshootClamping: true,
    }));

    let row!: ReturnType<typeof create>;
    await act(async () => {
      row = create(
        draggableList.props.renderItem({
          drag: vi.fn(),
          getIndex: () => 80,
          isActive: false,
          item: { type: 'task', key: longTaskList[80].id, task: longTaskList[80] },
        }),
      );
    });

    expect(row.root.findAllByType('SwipeableTaskItem' as unknown as React.ElementType)).toHaveLength(0);
    expect(row.root.findAllByType('ScaleDecorator' as unknown as React.ElementType)).toHaveLength(0);
    expect(row.root.findByProps({ testID: 'project-task-reorder-row-task-80' })).toBeTruthy();
    expect(row.root.findByProps({ testID: 'project-task-drag-handle-task-80' })).toBeTruthy();

    act(() => {
      row.unmount();
      tree.unmount();
    });
  });

  // #784: exiting Task order lands the normal list on the region the reorder
  // view was showing — not the pre-reorder offset, which yanked the viewport
  // away from where the dragged task had just been dropped.
  it('returns the normal list to the reorder viewport region on exit', async () => {
    const longTaskList = Array.from({ length: 30 }, (_, index) => makeTask(
      `task-${index}`,
      `Task ${index}`,
      { order: index },
    ));
    const propsFor = (reorderMode: boolean) => (
      <TaskList
        project={{ id: project.id, enableReorder: true, reorderMode }}
        showHeader={false}
        statusFilter="all"
        taskSource={longTaskList}
        title={project.title}
      />
    );
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(propsFor(true));
    });

    const draggableList = tree.root.findByType('DraggableFlatList' as unknown as React.ElementType);
    act(() => {
      draggableList.props.onScrollOffsetChange(800);
    });

    flatListScrollToIndexMock.mockClear();
    await act(async () => {
      tree.update(propsFor(false));
    });

    const call = flatListScrollToIndexMock.mock.calls.at(-1)?.[0];
    expect(call).toBeTruthy();
    expect(call.viewPosition).toBe(0);
    // 800px over 80px reorder rows = the task at reorder index 10.
    const data = flatListPropsSpy.mock.calls.at(-1)?.[0].data;
    expect(data[call.index]).toEqual(expect.objectContaining({ type: 'task' }));
    expect(data[call.index].task.id).toBe('task-10');

    act(() => {
      tree.unmount();
    });
  });

  it('uses the dropped order as the exit anchor before the store rerenders', async () => {
    const longTaskList = Array.from({ length: 30 }, (_, index) => makeTask(
      `task-${index}`,
      `Task ${index}`,
      { order: index },
    ));
    const propsFor = (reorderMode: boolean) => (
      <TaskList
        project={{ id: project.id, enableReorder: true, reorderMode }}
        showHeader={false}
        statusFilter="all"
        taskSource={longTaskList}
        title={project.title}
      />
    );
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(propsFor(true));
    });

    const draggableList = tree.root.findByType('DraggableFlatList' as unknown as React.ElementType);
    const droppedData = [...draggableList.props.data];
    const [moved] = droppedData.splice(0, 1);
    droppedData.splice(20, 0, moved);
    await act(async () => {
      draggableList.props.onDragEnd({ data: droppedData, from: 0, to: 20 });
      draggableList.props.onScrollOffsetChange(800);
    });

    flatListScrollToIndexMock.mockClear();
    await act(async () => {
      tree.update(propsFor(false));
    });

    const call = flatListScrollToIndexMock.mock.calls.at(-1)?.[0];
    expect(call).toBeTruthy();
    const normalData = flatListPropsSpy.mock.calls.at(-1)?.[0].data;
    // Moving task-0 below the viewport shifts task-11 into reorder index 10.
    expect(normalData[call.index].task.id).toBe('task-11');

    act(() => {
      tree.unmount();
    });
  });

  it('uses a single self-scrolling draggable list when a section-less project owns the scroll', async () => {
    const longTaskList = Array.from({ length: 130 }, (_, index) => makeTask(
      `task-${index}`,
      `Task ${index}`,
      { order: index },
    ));
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          project={{ id: project.id, enableReorder: true, reorderMode: true }}
          showHeader={false}
          statusFilter="all"
          taskSource={longTaskList}
          title={project.title}
        />,
      );
    });

    // The self-scrolling list owns scroll, so the nested (non-virtualizing) variant must be gone.
    expect(tree.root.findAllByType('NestableDraggableFlatList' as unknown as React.ElementType)).toHaveLength(0);

    const draggableList = tree.root.findByType('DraggableFlatList' as unknown as React.ElementType);
    expect(draggableList.props.data).toHaveLength(longTaskList.length);
    expect(draggableList.props.scrollEnabled).not.toBe(false);
    expect(draggableList.props.animationConfig).toEqual(expect.objectContaining({
      overshootClamping: true,
    }));

    act(() => {
      tree.unmount();
    });
  });
});
