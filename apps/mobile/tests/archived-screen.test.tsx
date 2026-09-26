import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AsyncStorage from '@react-native-async-storage/async-storage';

import ArchivedScreen from '../app/(drawer)/archived';
import { CompletedAtPicker } from '@/components/completed-at-picker';

vi.mock('expo-router', () => ({
  Redirect: (props: Record<string, unknown>) => React.createElement('Redirect', props),
  usePathname: () => '/history',
}));

const mocks = vi.hoisted(() => {
  const alert = vi.fn();
  const batchDeleteTasks = vi.fn();
  const batchMoveTasks = vi.fn();
  const batchUpdateTasks = vi.fn(async () => undefined);
  const deleteTask = vi.fn();
  const updateTask = vi.fn();
  const restoreTask = vi.fn(async () => undefined);
  const purgeTask = vi.fn();
  const updateProject = vi.fn();
  const deleteProject = vi.fn();
  const setHighlightTask = vi.fn();
  const showToast = vi.fn();
  return {
    alert,
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    deleteTask,
    updateTask,
    restoreTask,
    purgeTask,
    updateProject,
    deleteProject,
    setHighlightTask,
    showToast,
    areaFilter: {
      areaById: new Map<string, any>(),
      resolvedAreaFilter: { included: [] as string[], excluded: [] as string[] },
    },
    storeState: {
      _allTasks: [] as any[],
      projects: [] as any[],
      areas: [] as any[],
      settings: {} as any,
      batchDeleteTasks,
      batchMoveTasks,
      batchUpdateTasks,
      deleteTask,
      updateTask,
      restoreTask,
      purgeTask,
      updateProject,
      deleteProject,
      highlightTaskId: null as string | null,
      setHighlightTask,
    },
  };
});

vi.mock('react-native', async () => {
  const actual = await vi.importActual<any>('react-native');
  return {
    ...actual,
    Alert: {
      ...actual.Alert,
      alert: mocks.alert,
    },
    Pressable: ({ children, ...props }: any) => React.createElement(
      'Pressable',
      props,
      typeof children === 'function' ? children({ pressed: false }) : children,
    ),
    FlatList: ({ data = [], renderItem, keyExtractor, ListEmptyComponent, ...props }: any) => {
      const children = data.length > 0
        ? data.map((item: any, index: number) => (
          <React.Fragment key={keyExtractor?.(item, index) ?? item.id ?? index}>
            {renderItem?.({ item, index })}
          </React.Fragment>
        ))
        : typeof ListEmptyComponent === 'function'
          ? <ListEmptyComponent />
          : ListEmptyComponent;

      return React.createElement('FlatList', props, children);
    },
  };
});

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    shallow: Object.is,
    // Run the real selector: the screen reads through
    // `useTaskStore((state) => ({…}), shallow)`, so a mock that ignores the
    // selector never executes the projection it is meant to cover.
    useTaskStore: (selector?: (state: unknown) => unknown) => (
      selector ? selector(mocks.storeState) : mocks.storeState
    ),
    getInlineMarkdownPreview: vi.fn((markdown: string) => (markdown || '').split('\n')[0] ?? ''),
    safeFormatDate: vi.fn(() => 'May 12, 2026, 8:30 AM'),
  };
});

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: mocks.showToast, dismissToast: vi.fn() }),
}));

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock('@/components/markdown-text', () => ({
  MarkdownInlineText: ({ markdown, ...props }: any) => React.createElement('MarkdownInlineText', props, markdown),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'archived.empty': 'No archived tasks',
      'archived.emptyHint': 'Archived tasks appear here',
      'bulk.confirmDeleteBody': 'Delete selected tasks?',
      'bulk.confirmDeleteTitle': 'Delete tasks',
      'bulk.select': 'Select',
      'bulk.selected': 'selected',
      'common.all': 'all',
      'common.back': 'Back',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.delete': 'Delete',
      'common.done': 'Done',
      'common.tasks': 'tasks',
      'common.viewOptions': 'View options',
      'filters.title': 'Filters',
      'list.groupBy': 'Group',
      'list.done': 'Completed',
      'sort.label': 'Sort',
      'taskEdit.moreOptions': 'More options',
      'task.deleteConfirmBody': 'Move this task to Trash?',
      'trash.restoreToInbox': 'Restore to Inbox',
      'projects.title': 'Projects',
      'projects.deleteConfirm': 'Delete this project? Tasks in this project will be kept and moved to unassigned.',
      'archived.emptyProjects': 'No archived projects',
      'archived.emptyProjectsHint': 'Projects you archive will appear here',
    }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#000000',
    taskItemBg: '#111111',
    text: '#ffffff',
    secondaryText: '#999999',
    tint: '#3b82f6',
    onTint: '#ffffff',
    filterBg: '#1a1a1a',
    border: '#333333',
    cardBg: '#0a0a0a',
  }),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => mocks.areaFilter,
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children, ...props }: any) => (
    React.createElement('GestureHandlerRootView', props, children)
  ),
  Swipeable: ({ children, renderLeftActions, renderRightActions }: any) => (
    React.createElement(
      'Swipeable',
      { renderLeftActions, renderRightActions },
      renderLeftActions?.(),
      renderRightActions?.(),
      children,
    )
  ),
}));

vi.mock('lucide-react-native', () => ({
  Archive: (props: any) => React.createElement('Archive', props),
  Check: (props: any) => React.createElement('Check', props),
  Trash2: (props: any) => React.createElement('Trash2', props),
  ArrowUpDown: (props: any) => React.createElement('ArrowUpDown', props),
  ChevronLeft: (props: any) => React.createElement('ChevronLeft', props),
  ChevronDown: (props: any) => React.createElement('ChevronDown', props),
  ChevronRight: (props: any) => React.createElement('ChevronRight', props),
  Folder: (props: any) => React.createElement('Folder', props),
  MoreHorizontal: (props: any) => React.createElement('MoreHorizontal', props),
  RotateCcw: (props: any) => React.createElement('RotateCcw', props),
  Settings2: (props: any) => React.createElement('Settings2', props),
  SlidersHorizontal: (props: any) => React.createElement('SlidersHorizontal', props),
  X: (props: any) => React.createElement('X', props),
}));

vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => false }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));

// The sheet's own rendering is covered by task-filter-sheet.test.tsx; here it is
// only a destination, so stub it rather than pull its whole icon/Modal tree in.
vi.mock('@/components/task-filter-sheet', () => ({
  TaskFilterSheet: (props: any) => React.createElement('TaskFilterSheet', props),
  FilterChip: (props: any) => React.createElement('FilterChip', props),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

describe('ArchivedScreen', () => {
  const taskEditModalType = 'TaskEditModal' as unknown as React.ElementType;
  const flattenText = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
    return '';
  };
  const hasText = (tree: renderer.ReactTestRenderer, text: string) =>
    tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;
  const flattenStyle = (style: unknown): Record<string, unknown> => (
    (Array.isArray(style) ? style : [style])
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .reduce((merged, entry) => ({ ...merged, ...entry }), {})
  );

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations, so restore the empty store or a test
    // that seeds persisted view state leaks it into the next one.
    vi.mocked(AsyncStorage.getItem).mockImplementation(async () => null);
    mocks.areaFilter.areaById = new Map();
    mocks.areaFilter.resolvedAreaFilter = { included: [], excluded: [] };
    mocks.storeState.projects = [];
    mocks.storeState.areas = [];
    mocks.storeState.settings = {};
    mocks.storeState.highlightTaskId = null;
    mocks.storeState._allTasks = [
      {
        id: 'task-1',
        title: 'Archived task',
        description: 'Full archived details',
        status: 'archived',
        completedAt: '2026-05-12T08:30:00.000Z',
        createdAt: '2026-05-10T08:30:00.000Z',
        updatedAt: '2026-05-12T08:30:00.000Z',
      },
    ];
  });

  it('opens archived task details from the row and saves through the task editor', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    let modal = tree.root.findByType(taskEditModalType);
    expect(modal.props.visible).toBe(false);
    expect(modal.props.defaultTab).toBe('view');
    expect(hasText(tree, 'Completed: May 12, 2026, 8:30 AM')).toBe(true);

    const row = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Open archived task details: Archived task',
    );

    renderer.act(() => {
      row.props.onPress();
    });

    modal = tree.root.findByType(taskEditModalType);
    expect(modal.props.visible).toBe(true);
    expect(modal.props.task).toMatchObject({
      id: 'task-1',
      title: 'Archived task',
      description: 'Full archived details',
    });

    renderer.act(() => {
      modal.props.onSave('task-1', { description: 'Updated archived details' });
    });

    expect(mocks.updateTask).toHaveBeenCalledWith('task-1', { description: 'Updated archived details' });
    modal = tree.root.findByType(taskEditModalType);
    expect(modal.props.visible).toBe(false);
  });

  it('keeps cancelled task and project titles unstruck', () => {
    mocks.storeState._allTasks = [{
      ...mocks.storeState._allTasks[0],
      id: 'cancelled-task',
      title: 'Cancelled task',
      completedAt: undefined,
      cancelledAt: '2026-05-12T08:30:00.000Z',
    }];
    mocks.storeState.projects = [{
      ...archivedProject,
      id: 'cancelled-project',
      title: 'Cancelled project',
      cancelledAt: '2026-05-11T08:30:00.000Z',
    }];
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    const taskTitle = tree.root.find((node) => node.props.children === 'Cancelled task');
    expect(flattenStyle(taskTitle.props.style).textDecorationLine).toBeUndefined();

    switchToProjects(tree);
    const projectTitle = tree.root.find((node) => node.props.children === 'Cancelled project');
    expect(flattenStyle(projectTitle.props.style).textDecorationLine).toBeUndefined();
  });

  it('moves an archived task to Trash instead of purging it', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    const swipeable = tree.root.findByType('Swipeable' as unknown as React.ElementType);
    const deleteAction = swipeable.props.renderRightActions();

    renderer.act(() => {
      deleteAction.props.onPress();
    });

    const alertButtons = mocks.alert.mock.calls[0]?.[2] as { style?: string; onPress?: () => void }[];
    const confirmButton = alertButtons.find((button) => button.style === 'destructive');
    renderer.act(() => {
      confirmButton?.onPress?.();
    });

    expect(mocks.deleteTask).toHaveBeenCalledWith('task-1');
    expect(mocks.purgeTask).not.toHaveBeenCalled();
  });

  it('bulk restores selected archived tasks to Inbox', async () => {
    mocks.storeState._allTasks = [
      ...mocks.storeState._allTasks,
      {
        ...mocks.storeState._allTasks[0],
        id: 'task-2',
        title: 'Second archived task',
      },
    ];
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Select').props.onPress();
    });
    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Select all').props.onPress();
    });
    await renderer.act(async () => {
      await tree.root.find((node) => node.props.accessibilityLabel === 'Restore to Inbox').props.onPress();
    });

    expect(mocks.batchMoveTasks).toHaveBeenCalledWith(['task-1', 'task-2'], 'inbox');
    expect(mocks.updateTask).not.toHaveBeenCalledWith('task-1', { status: 'inbox' });
  });

  // Restore and the completion-time edit were fire-and-forget, so a refused
  // write left the row where it was with nothing on screen — unlike the bulk
  // restore beside them, which warns.
  it('warns when restoring a single archived task is refused', async () => {
    mocks.updateTask.mockResolvedValueOnce({ success: false, error: 'Task not found' });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    await renderer.act(async () => {
      await tree.root.find((node) => typeof node.props.restoreLabel === 'string' && node.props.task?.id === 'task-1').props.onRestore();
    });

    expect(mocks.updateTask).toHaveBeenCalledWith('task-1', { status: 'inbox' });
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }));
  });

  it('warns when saving an edited completion time is refused', async () => {
    mocks.updateTask.mockResolvedValueOnce({ success: false, error: 'Task not found' });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Edit completion time')
        .props.onPress({ stopPropagation: () => undefined });
    });

    const picker = tree.root.findByType(CompletedAtPicker);
    await renderer.act(async () => {
      await picker.props.onConfirm('2026-09-01T10:00:00.000Z');
    });

    expect(mocks.updateTask).toHaveBeenCalledWith('task-1', { completedAt: '2026-09-01T10:00:00.000Z' });
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }));
  });

  it('keeps selection and warns when a bulk restore reports failure', async () => {
    mocks.batchMoveTasks.mockResolvedValueOnce({ success: false, error: 'Tasks not found: task-1' });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Select').props.onPress();
    });
    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Select Archived task').props.onPress();
    });
    await renderer.act(async () => {
      await tree.root.find((node) => node.props.accessibilityLabel === 'Restore to Inbox').props.onPress();
    });

    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' }));
    expect(tree.root.findAll((node) => node.props.accessibilityLabel === 'Restore to Inbox')).not.toHaveLength(0);
    expect(tree.root.findAll((node) => node.props.accessibilityLabel === 'Move to Done')).toHaveLength(0);
  });

  it('bulk moves selected archived tasks to Trash', async () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Select').props.onPress();
    });
    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Select Archived task').props.onPress();
    });
    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Delete').props.onPress();
    });

    const alertButtons = mocks.alert.mock.calls[0]?.[2] as { style?: string; onPress?: () => Promise<void> | void }[];
    const confirmButton = alertButtons.find((button) => button.style === 'destructive');
    await renderer.act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mocks.batchDeleteTasks).toHaveBeenCalledWith(['task-1']);
    expect(mocks.deleteTask).not.toHaveBeenCalled();
  });

  const archivedProject = {
    id: 'project-1',
    title: 'Archived project',
    status: 'archived',
    color: '#6B7280',
    order: 0,
    tagIds: [] as string[],
    createdAt: '2026-05-01T08:30:00.000Z',
    updatedAt: '2026-05-11T08:30:00.000Z',
  };

  const switchToProjects = (tree: renderer.ReactTestRenderer) => {
    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Projects').props.onPress();
    });
  };

  // findAll matches the composite element and the host element it renders, so a
  // plain count double-counts. Keep host nodes only.
  const countByLabel = (tree: renderer.ReactTestRenderer, label: string) => tree.root.findAll(
    (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label,
  ).length;

  const typeSearch = (tree: renderer.ReactTestRenderer, value: string) => {
    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Search').props.onChangeText(value);
    });
  };

  it('narrows the archived list by search and restores it when cleared', () => {
    mocks.storeState._allTasks = [
      { ...mocks.storeState._allTasks[0], id: 'task-1', title: 'Quarterly report' },
      { ...mocks.storeState._allTasks[0], id: 'task-2', title: 'Fix the printer' },
    ];
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    expect(hasText(tree, 'Quarterly report')).toBe(true);
    expect(hasText(tree, 'Fix the printer')).toBe(true);

    typeSearch(tree, 'printer');
    expect(hasText(tree, 'Quarterly report')).toBe(false);
    expect(hasText(tree, 'Fix the printer')).toBe(true);

    typeSearch(tree, '');
    expect(hasText(tree, 'Quarterly report')).toBe(true);
  });

  const workArea = { id: 'a1', name: 'Work', order: 0 };
  const homeArea = { id: 'a2', name: 'Home', order: 1 };

  const seedTwoAreaTasks = () => {
    mocks.areaFilter.areaById = new Map([[workArea.id, workArea], [homeArea.id, homeArea]]);
    mocks.storeState.areas = [workArea, homeArea];
    mocks.storeState._allTasks = [
      { ...mocks.storeState._allTasks[0], id: 'task-1', title: 'Quarterly report', areaId: 'a1' },
      { ...mocks.storeState._allTasks[0], id: 'task-2', title: 'Fix the printer', areaId: 'a2' },
    ];
  };

  it('shows only archived tasks the area filter includes', () => {
    seedTwoAreaTasks();
    mocks.areaFilter.resolvedAreaFilter = { included: ['a1'], excluded: [] };
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    expect(hasText(tree, 'Quarterly report')).toBe(true);
    expect(hasText(tree, 'Fix the printer')).toBe(false);
  });

  it('drops archived tasks whose area the filter excludes', () => {
    seedTwoAreaTasks();
    mocks.areaFilter.resolvedAreaFilter = { included: [], excluded: ['a1'] };
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    expect(hasText(tree, 'Quarterly report')).toBe(false);
    expect(hasText(tree, 'Fix the printer')).toBe(true);
  });

  it('folds a grouping heading, taking its rows off screen and out of Select all', async () => {
    mocks.storeState.areas = [{ id: 'a1', name: 'Work', order: 0 }];
    mocks.storeState._allTasks = [
      { ...mocks.storeState._allTasks[0], id: 'task-1', title: 'Quarterly report', areaId: 'a1' },
      { ...mocks.storeState._allTasks[0], id: 'task-2', title: 'Fix the printer' },
    ];
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => (
      key === 'mindwtr:view:archived:v1' ? JSON.stringify({ groupBy: 'area' }) : null
    ));

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ArchivedScreen />);
    });
    expect(hasText(tree, 'Quarterly report')).toBe(true);

    await renderer.act(async () => {
      tree.root.find((node) => node.props.testID === 'archived-group-header-a1').props.onPress();
    });

    // The heading and its count stay, so the group is still findable; the row does not.
    expect(hasText(tree, 'Work')).toBe(true);
    expect(hasText(tree, 'Quarterly report')).toBe(false);
    expect(hasText(tree, 'Fix the printer')).toBe(true);

    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Select').props.onPress();
    });
    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Select all').props.onPress();
    });
    await renderer.act(async () => {
      await tree.root.find((node) => node.props.accessibilityLabel === 'Restore to Inbox').props.onPress();
    });

    expect(mocks.batchMoveTasks).toHaveBeenCalledWith(['task-2'], 'inbox');
  });

  it('counts a multi-tag task once when deciding whether every visible task is selected', async () => {
    mocks.storeState._allTasks = [
      { ...mocks.storeState._allTasks[0], tags: ['Work', 'Urgent'] },
    ];
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => (
      key === 'mindwtr:view:archived:v1' ? JSON.stringify({ groupBy: 'tag' }) : null
    ));

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<ArchivedScreen />);
    });

    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'Select').props.onPress();
    });
    const findSelectAll = () => tree.root.find(
      (node) => node.props.accessibilityLabel === 'Select all',
    );
    expect(findSelectAll().props.disabled).toBe(false);

    renderer.act(() => {
      findSelectAll().props.onPress();
    });

    expect(findSelectAll().props.disabled).toBe(true);
  });

  it('counts only the tasks left after filtering, so bulk actions cannot reach a hidden row', () => {
    mocks.storeState._allTasks = [
      { ...mocks.storeState._allTasks[0], id: 'task-1', title: 'Quarterly report' },
      { ...mocks.storeState._allTasks[0], id: 'task-2', title: 'Fix the printer' },
    ];
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    expect(hasText(tree, '2 tasks')).toBe(true);
    typeSearch(tree, 'printer');
    expect(hasText(tree, '1 task')).toBe(true);
  });

  it('offers the search box while a filter is active even though nothing matches', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    typeSearch(tree, 'nothing matches this');
    // The empty state must not take the search box down with it, or the only way
    // back is to leave the screen.
    expect(countByLabel(tree, 'Search')).toBe(1);
    expect(hasText(tree, 'No tasks match these filters.')).toBe(true);
  });

  it('keeps Filters, Sort, and Group at the top level, then exposes an active count', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    expect(tree.root.findAllByProps({ testID: 'archived-active-filters-button' })).toHaveLength(0);
    const overflow = tree.root.findByProps({ testID: 'archived-overflow-button' });
    expect(overflow.props.accessibilityState).toEqual({ expanded: false });

    renderer.act(() => overflow.props.onPress());
    expect(tree.root.findByProps({ testID: 'archived-filter-action' })).toBeTruthy();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'View options' })).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'archived-sort-action' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'archived-group-action' })).toBeTruthy();
    renderer.act(() => tree.root.findByProps({ testID: 'archived-sort-action' }).props.onPress());
    expect(tree.root.findByProps({ testID: 'archived-sort-default' })).toBeTruthy();

    renderer.act(() => tree.root.findByProps({ accessibilityLabel: 'Back' }).props.onPress());
    renderer.act(() => tree.root.findByProps({ testID: 'archived-group-action' }).props.onPress());
    expect(tree.root.findByProps({ testID: 'archived-group-none' })).toBeTruthy();

    typeSearch(tree, 'printer');
    const activeFilters = tree.root.findByProps({ testID: 'archived-active-filters-button' });
    expect(activeFilters.props.accessibilityLabel).toBe('Filters · 1');
    expect(activeFilters.props.accessibilityState).toEqual({ selected: true });
  });

  it('keeps the Filters button out of the Projects segment, which it does not apply to', () => {
    mocks.storeState.projects = [archivedProject];
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    expect(countByLabel(tree, 'Filters')).toBe(1);
    switchToProjects(tree);
    expect(countByLabel(tree, 'Filters')).toBe(0);
  });

  it('renders archived projects when the Projects segment is selected', () => {
    mocks.storeState.projects = [archivedProject];
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    expect(hasText(tree, 'Archived project')).toBe(false);
    switchToProjects(tree);
    expect(hasText(tree, 'Archived project')).toBe(true);
  });

  it('hides an archived project whose area the filter excludes', () => {
    mocks.areaFilter.areaById = new Map([[workArea.id, workArea]]);
    mocks.storeState.projects = [{ ...archivedProject, areaId: 'a1' }];
    mocks.areaFilter.resolvedAreaFilter = { included: [], excluded: ['a1'] };
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });
    switchToProjects(tree);

    expect(hasText(tree, 'Archived project')).toBe(false);
  });

  it('restores an archived project through updateProject with active status', () => {
    mocks.storeState.projects = [archivedProject];
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });
    switchToProjects(tree);

    const swipeable = tree.root.findByType('Swipeable' as unknown as React.ElementType);
    const restoreAction = swipeable.props.renderLeftActions();
    renderer.act(() => {
      restoreAction.props.onPress();
    });

    expect(mocks.updateProject).toHaveBeenCalledWith('project-1', { status: 'active' });
    expect(mocks.deleteProject).not.toHaveBeenCalled();
  });

  it('deletes an archived project only after confirmation', () => {
    mocks.storeState.projects = [archivedProject];
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });
    switchToProjects(tree);

    const swipeable = tree.root.findByType('Swipeable' as unknown as React.ElementType);
    const deleteAction = swipeable.props.renderRightActions();
    renderer.act(() => {
      deleteAction.props.onPress();
    });

    expect(mocks.deleteProject).not.toHaveBeenCalled();
    const alertButtons = mocks.alert.mock.calls[0]?.[2] as { style?: string; onPress?: () => void }[];
    const confirmButton = alertButtons.find((button) => button.style === 'destructive');
    renderer.act(() => {
      confirmButton?.onPress?.();
    });

    expect(mocks.deleteProject).toHaveBeenCalledWith('project-1');
  });
});
