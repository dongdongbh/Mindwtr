import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import { SomedayView } from './someday-view';

const mocked = vi.hoisted(() => ({
  state: null as any,
  taskListProps: null as any,
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    shallow: vi.fn(),
    useTaskStore: (selector: (state: unknown) => unknown) => selector(mocked.state),
  };
});

vi.mock('@/contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => key === 'viewSections.noSection' ? 'No section' : key,
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
  Lightbulb: () => null,
}));

vi.mock('../task-edit-modal', () => ({
  TaskEditModal: () => null,
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
  useTaskListSelection: () => ({}),
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

const setState = (tasks: Task[], somedaySections: { id: string; title: string; order: number }[]) => {
  mocked.state = {
    tasks,
    projects: [],
    settings: { gtd: { viewSections: { someday: somedaySections } } },
    updateTask: vi.fn(),
    updateProject: vi.fn(),
    deleteTask: vi.fn(),
    restoreTask: vi.fn(),
    batchMoveTasks: vi.fn(),
    batchDeleteTasks: vi.fn(),
    batchUpdateTasks: vi.fn(),
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
});
