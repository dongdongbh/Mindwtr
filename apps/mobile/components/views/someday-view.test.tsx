import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVED_FILTER_NO_PROJECT_ID, type Task } from '@mindwtr/core';

import { SomedayView } from './someday-view';

const mocked = vi.hoisted(() => ({
  state: null as any,
  taskListProps: null as any,
  taskFilterSheetProps: null as any,
  showToast: vi.fn(),
  flush: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    shallow: vi.fn(),
    flushPendingSave: mocked.flush,
    useTaskStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector(mocked.state),
      { getState: () => mocked.state },
    ),
  };
});

vi.mock('@/contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'common.back': 'Back',
      'common.close': 'Close',
      'common.viewOptions': 'View options',
      'filters.clear': 'Clear',
      'filters.title': 'Filters',
      'list.details': 'Details',
      'list.groupBy': 'Group',
      'list.groupByArea': 'Area',
      'list.groupByNone': 'No grouping',
      'list.groupByProject': 'Project',
      'list.hideDetails': 'Hide details',
      'list.showDetails': 'Show details',
      'sort.default': 'Default',
      'sort.label': 'Sort',
      'sort.title': 'Title',
      'taskEdit.moreOptions': 'More options',
      'taskEdit.noProjectOption': 'No project',
      'viewSections.new': 'New section',
      'viewSections.noSection': 'No section',
      'viewSections.somedaySection': 'Someday section',
    }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ bg: '#fff', border: '#ddd', cardBg: '#fff', secondaryText: '#666', text: '#111' }),
}));

vi.mock('@/hooks/use-visible-tasks', () => ({
  useVisibleTaskContext: () => ({
    areaById: new Map(),
    resolvedAreaFilter: { included: [], excluded: [] },
    visibleTasks: mocked.state.tasks,
  }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));

vi.mock('lucide-react-native', () => ({
  ArrowUpDown: () => null,
  ChevronLeft: () => null,
  ChevronRight: () => null,
  Eye: () => null,
  Folder: () => null,
  Lightbulb: () => null,
  MoreHorizontal: () => null,
  Plus: () => null,
  Settings2: () => null,
  SlidersHorizontal: () => null,
  X: () => null,
}));

vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => false }));

vi.mock('../task-edit-modal', () => ({
  TaskEditModal: () => null,
}));

vi.mock('../task-filter-sheet', () => ({
  FilterChip: (props: any) => React.createElement('FilterChip', props),
  TaskFilterSheet: (props: any) => {
    mocked.taskFilterSheetProps = props;
    return React.createElement('TaskFilterSheet', props);
  },
}));

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: mocked.showToast }),
}));

vi.mock('@/lib/app-log', () => ({ logError: vi.fn(), logInfo: vi.fn() }));

vi.mock('../someday-section-picker', () => ({
  SomedaySectionPicker: (props: any) => React.createElement('SomedaySectionPicker', props),
}));

vi.mock('@/lib/someday-section-actions', () => ({
  createSomedaySection: vi.fn(async () => 'new-section'),
}));

vi.mock('../task-list-view', () => ({
  TaskListView: (props: unknown) => {
    mocked.taskListProps = props;
    return null;
  },
}));

vi.mock('../task-list/TaskListBulkBar', () => ({
  getBulkMoveStatusOptions: () => [],
}));

vi.mock('../use-task-list-selection', () => ({
  usePruneSelectionToVisible: vi.fn(),
  useTaskListSelection: () => ({
    exitSelectionMode: vi.fn(),
    selectedIdsArray: [],
    setMultiSelectedIds: vi.fn(),
  }),
  assertBulkActionSucceeded: (result: { success?: boolean }) => {
    if (result?.success === false) throw new Error('save failed');
  },
}));

vi.mock('./deferred-projects-section', () => ({
  DeferredProjectsSection: () => null,
  selectDeferredProjects: () => [],
}));

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  status: 'someday',
  tags: [],
  contexts: [],
  createdAt: '2026-08-27T12:00:00.000Z',
  updatedAt: '2026-08-27T12:00:00.000Z',
  ...overrides,
} as Task);

const setState = (
  tasks: Task[],
  somedaySections: { id: string; title: string; order: number }[],
  projects: { id: string; title: string; status: string; order: number }[] = [],
) => {
  mocked.state = {
    tasks,
    projects,
    settings: { gtd: { viewSections: { someday: somedaySections } } },
    updateTask: vi.fn(),
    updateProject: vi.fn(),
    deleteTask: vi.fn(),
    restoreTask: vi.fn(),
    batchMoveTasks: vi.fn(),
    batchDeleteTasks: vi.fn(),
    batchUpdateTasks: vi.fn(),
    addTask: vi.fn(async () => ({ success: true, id: 'added' })),
    persistenceFailure: null,
    retryPersistence: vi.fn(async () => { mocked.state.persistenceFailure = null; }),
    highlightTaskId: null,
    setHighlightTask: vi.fn(),
  };
};

let renderer: ReactTestRenderer | null = null;

const renderSomedayView = () => {
  act(() => {
    renderer = create(<SomedayView />);
  });
};

describe('SomedayView section grouping', () => {
  beforeEach(() => {
    vi.stubGlobal('React', React);
    mocked.taskListProps = null;
    mocked.taskFilterSheetProps = null;
    mocked.flush.mockReset().mockResolvedValue(undefined);
    mocked.showToast.mockClear();
  });

  afterEach(() => {
    if (renderer) {
      act(() => renderer?.unmount());
    }
    renderer = null;
    vi.unstubAllGlobals();
  });

  it('keeps the list flat while no Someday sections are defined', () => {
    setState([makeTask('one'), makeTask('two')], []);

    renderSomedayView();

    expect(mocked.taskListProps.tasks.map((task: Task) => task.id)).toEqual(['one', 'two']);
    expect(mocked.taskListProps.taskGroups).toBeUndefined();
  });

  it('groups the list after the first Someday section is defined', () => {
    setState([
      makeTask('book', { viewSectionIds: { someday: 'books' } }),
      makeTask('unassigned'),
    ], [{ id: 'books', title: 'Books to read', order: 0 }]);

    renderSomedayView();

    expect(mocked.taskListProps.taskGroups.map((group: { title: string }) => group.title))
      .toEqual(['Books to read', 'No section']);
    expect(mocked.taskListProps.taskGroups[0].tasks[0].id).toBe('book');
  });

  it('filters with normalized legacy bare tags and contexts, shows an active count, and clears back to all rows', async () => {
    setState([
      makeTask('bare-tag', { contexts: ['home'], tags: ['ideas'] }),
      makeTask('other', { contexts: ['office'], tags: ['later'] }),
    ], []);
    renderSomedayView();

    const moreOptions = renderer!.root.findByProps({ testID: 'someday-overflow-button' });
    await act(async () => { moreOptions.props.onPress(); });
    const filtersAction = renderer!.root.findByProps({ testID: 'someday-filter-action' });
    await act(async () => { filtersAction.props.onPress(); });

    expect(mocked.taskFilterSheetProps.visible).toBe(true);
    expect(mocked.taskFilterSheetProps.options.tokens).toEqual(expect.arrayContaining(['@home', '#ideas']));
    await act(async () => { mocked.taskFilterSheetProps.selections.toggleToken('@home'); });

    expect(mocked.taskListProps.tasks.map((task: Task) => task.id)).toEqual(['bare-tag']);
    const activeChip = renderer!.root.findByType('FilterChip' as never);
    expect(activeChip.props.label).toBe('Filters · 1');
    await act(async () => { activeChip.props.onPress(); });
    expect(mocked.taskListProps.tasks.map((task: Task) => task.id)).toEqual(['bare-tag', 'other']);
  });

  it('offers and retains No project so unassigned Someday tasks can be filtered directly', async () => {
    setState([
      makeTask('unassigned'),
      makeTask('planned', { projectId: 'project-a' }),
    ], [], [
      { id: 'project-a', title: 'Alpha project', status: 'active', order: 0 },
    ]);
    renderSomedayView();

    expect(mocked.taskFilterSheetProps.options.projects).toEqual([
      { id: SAVED_FILTER_NO_PROJECT_ID, title: 'No project' },
      { id: 'project-a', title: 'Alpha project' },
    ]);
    await act(async () => {
      mocked.taskFilterSheetProps.selections.toggleProject(SAVED_FILTER_NO_PROJECT_ID);
    });

    expect(mocked.taskListProps.tasks.map((task: Task) => task.id)).toEqual(['unassigned']);
    expect(mocked.taskFilterSheetProps.selections.chips).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `project:${SAVED_FILTER_NO_PROJECT_ID}`, label: 'No project' }),
    ]));
  });

  it('applies Someday sort and project grouping before it derives headings', async () => {
    setState([
      makeTask('zulu', { title: 'Zulu', projectId: 'project-b', createdAt: '2026-08-28T12:00:00.000Z' }),
      makeTask('alpha', { title: 'Alpha', projectId: 'project-a', createdAt: '2026-08-27T12:00:00.000Z' }),
    ], [{ id: 'books', title: 'Books to read', order: 0 }], [
      { id: 'project-a', title: 'Alpha project', status: 'active', order: 0 },
      { id: 'project-b', title: 'Beta project', status: 'active', order: 1 },
    ]);
    renderSomedayView();
    expect(mocked.taskListProps.tasks.map((task: Task) => task.id)).toEqual(['zulu', 'alpha']);

    await act(async () => { renderer!.root.findByProps({ testID: 'someday-overflow-button' }).props.onPress(); });
    expect(renderer!.root.findAllByProps({ accessibilityLabel: 'View options' })).toHaveLength(0);
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Sort: Default' })).toBeTruthy();
    expect(renderer!.root.findByProps({ accessibilityLabel: 'Group: Someday section' })).toBeTruthy();
    await act(async () => { renderer!.root.findByProps({ testID: 'someday-sort-action' }).props.onPress(); });
    await act(async () => { renderer!.root.findByProps({ testID: 'someday-sort-title' }).props.onPress(); });
    expect(mocked.taskListProps.tasks.map((task: Task) => task.id)).toEqual(['alpha', 'zulu']);

    await act(async () => { renderer!.root.findByProps({ testID: 'someday-overflow-button' }).props.onPress(); });
    await act(async () => { renderer!.root.findByProps({ testID: 'someday-group-action' }).props.onPress(); });
    await act(async () => { renderer!.root.findByProps({ testID: 'someday-group-project' }).props.onPress(); });
    expect(mocked.taskListProps.taskGroups.map((group: { title: string }) => group.title))
      .toEqual(['Alpha project', 'Beta project']);
    expect(mocked.taskListProps.taskGroups[0].tasks.map((task: Task) => task.id)).toEqual(['alpha']);
    expect(mocked.taskListProps.onAddTaskToSection).toBeUndefined();
  });

  it('toggles rendered row details directly from the overflow without adding a persistent details control', async () => {
    setState([makeTask('one')], []);
    renderSomedayView();
    expect(mocked.taskListProps.showDetails).toBe(false);

    await act(async () => { renderer!.root.findByProps({ testID: 'someday-overflow-button' }).props.onPress(); });
    await act(async () => { renderer!.root.findByProps({ testID: 'someday-toggle-details' }).props.onPress(); });

    expect(mocked.taskListProps.showDetails).toBe(true);
    expect(renderer!.root.findAllByProps({ testID: 'someday-details-button' })).toHaveLength(0);
  });

  it('keeps an empty heading actionable and preassigns a task created there', async () => {
    setState([], [{ id: 'books', title: 'Books to read', order: 0 }]);
    renderSomedayView();
    expect(mocked.taskListProps.taskGroups).toEqual([
      expect.objectContaining({ title: 'Books to read', tasks: [] }),
    ]);

    await act(async () => {
      mocked.taskListProps.onAddTaskToSection('view-section:someday:books');
    });
    const input = renderer!.root.findByType('TextInput' as never);
    await act(async () => { input.props.onChangeText('Read Dune'); });
    const save = renderer!.root.findAllByProps({ accessibilityLabel: 'common.save' })[0];
    await act(async () => { await save.props.onPress(); });

    expect(mocked.state.addTask).toHaveBeenCalledWith('Read Dune', {
      status: 'someday', viewSectionIds: { someday: 'books' },
    });
    await vi.waitFor(() => expect(mocked.flush).toHaveBeenCalledOnce());
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
  });

  it('retries a failed heading task save without creating a duplicate', async () => {
    setState([], [{ id: 'books', title: 'Books to read', order: 0 }]);
    mocked.state.addTask.mockImplementationOnce(async (title: string, props: Partial<Task>) => {
      mocked.state.tasks = [makeTask('added', { title, ...props })];
      return { success: true, id: 'added' };
    });
    mocked.flush.mockImplementationOnce(async () => {
      mocked.state.persistenceFailure = { message: 'disk full', failedAt: 'now', retrying: false };
      throw new Error('disk full');
    }).mockResolvedValue(undefined);
    renderSomedayView();
    await act(async () => { mocked.taskListProps.onAddTaskToSection('view-section:someday:books'); });
    const input = renderer!.root.findByType('TextInput' as never);
    await act(async () => { input.props.onChangeText('Read Dune'); });
    const save = renderer!.root.findAllByProps({ accessibilityLabel: 'common.save' })[0];
    await act(async () => { save.props.onPress(); });
    await vi.waitFor(() => expect(mocked.flush).toHaveBeenCalledOnce());
    expect(mocked.showToast).not.toHaveBeenCalled();
    expect(renderer!.root.findByType('TextInput' as never).props.value).toBe('Read Dune');
    expect(renderer!.root.findByType('TextInput' as never).props.editable).toBe(false);

    const retry = renderer!.root.findAllByProps({ accessibilityLabel: 'Retry' })[0];
    await act(async () => { retry.props.onPress(); });
    await vi.waitFor(() => expect(mocked.state.retryPersistence).toHaveBeenCalledOnce());
    expect(mocked.state.addTask).toHaveBeenCalledOnce();
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
  });

  it('draws the stat labels in the theme\'s secondary text color', () => {
    setState([makeTask('one')], []);
    renderSomedayView();
    const flatten = (style: unknown): Record<string, unknown> => (
      Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : (style && typeof style === 'object' ? style as Record<string, unknown> : {})
    );
    const label = renderer!.root.findAll((node) => String(node.type) === 'Text' && node.props.children === 'someday.ideas')[0];
    expect(flatten(label.props.style).color).toBe('#666');
  });

  it('shows the error toast when reactivating a parked project fails', async () => {
    setState([makeTask('one')], []);
    mocked.state.updateProject = vi.fn(async () => ({ success: false, error: 'disk full' }));
    renderSomedayView();

    await act(async () => { mocked.taskListProps.ListHeaderComponent.props.onActivateProject('p-parked'); });

    expect(mocked.state.updateProject).toHaveBeenCalledWith('p-parked', { status: 'active' });
    await vi.waitFor(() => expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', message: 'disk full' })));
  });

  it('opens New section from the summary overflow without a separate list row', async () => {
    setState([makeTask('one')], [{ id: 'books', title: 'Books to read', order: 0 }]);
    renderSomedayView();
    expect(mocked.taskListProps.onMoveTaskToSection).toEqual(expect.any(Function));
    expect(mocked.taskListProps.onMoveSelectionToSection).toEqual(expect.any(Function));

    const moreOptions = renderer!.root.findByProps({ testID: 'someday-overflow-button' });
    expect(moreOptions.props.accessibilityState).toEqual({ expanded: false });
    await act(async () => { moreOptions.props.onPress(); });
    expect(renderer!.root.findByProps({ testID: 'someday-overflow-button' }).props.accessibilityState)
      .toEqual({ expanded: true });
    const newSection = renderer!.root.findByProps({ testID: 'someday-new-section-action' });
    expect(mocked.taskListProps.ListHeaderComponent.props).not.toHaveProperty('children');
    await act(async () => { newSection.props.onPress(); });
    const picker = renderer!.root.findAllByType('SomedaySectionPicker' as never)
      .find((node) => node.props.createOnly);
    expect(picker).toBeDefined();
    expect(picker?.props.sections).toEqual([{ id: 'books', title: 'Books to read', order: 0 }]);
  });
});
