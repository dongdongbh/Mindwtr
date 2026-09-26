import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import { WaitingView } from './waiting-view';

const mocked = vi.hoisted(() => ({
  state: null as any,
  taskListProps: null as any,
  showToast: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    shallow: vi.fn(),
    useTaskStore: Object.assign(
      (selector: (state: unknown) => unknown) => selector(mocked.state),
      { getState: () => mocked.state },
    ),
  };
});

vi.mock('../../contexts/theme-context', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('../../contexts/language-context', () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock('@/contexts/toast-context', () => ({ useToast: () => ({ showToast: mocked.showToast }) }));
vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#fff', border: '#ddd', cardBg: '#fff', filterBg: '#eee', secondaryText: '#666', text: '#111', tint: '#06c', onTint: '#fff',
  }),
}));
vi.mock('@/hooks/use-visible-tasks', () => ({
  useVisibleTaskContext: () => ({
    areaById: new Map(),
    resolvedAreaFilter: { included: [], excluded: [] },
    visibleTasks: mocked.state.tasks,
  }),
}));
vi.mock('@/lib/task-meta-navigation', () => ({ openContextsScreen: vi.fn(), openProjectScreen: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('lucide-react-native', () => ({ PauseCircle: () => null }));
vi.mock('../task-edit-modal', () => ({ TaskEditModal: () => null }));
vi.mock('../task-list/TaskListBulkBar', () => ({ getBulkMoveStatusOptions: () => [] }));
vi.mock('../use-task-list-selection', () => ({ useTaskListSelection: () => ({}) }));
vi.mock('../task-list-view', () => ({
  TaskListView: (props: unknown) => {
    mocked.taskListProps = props;
    return null;
  },
}));
vi.mock('./deferred-projects-section', () => ({ DeferredProjectsSection: () => null }));

const waiting = (id: string): Task => ({
  id, title: `Task ${id}`, status: 'waiting', tags: [], contexts: [],
  createdAt: '2026-08-27T12:00:00.000Z', updatedAt: '2026-08-27T12:00:00.000Z',
});

const flatten = (style: unknown): Record<string, unknown> => (
  Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : (style && typeof style === 'object' ? style as Record<string, unknown> : {})
);

let renderer: ReactTestRenderer | null = null;

describe('WaitingView', () => {
  beforeEach(() => {
    // waiting-view.tsx relies on the automatic JSX runtime the app bundler provides.
    vi.stubGlobal('React', React);
    mocked.showToast.mockClear();
    mocked.state = {
      tasks: [waiting('one')],
      projects: [],
      settings: {},
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
    act(() => { renderer = create(<WaitingView />); });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    vi.unstubAllGlobals();
  });

  it('draws the stat labels in the theme\'s secondary text color', () => {
    const labels = renderer!.root.findAll((node) => String(node.type) === 'Text' && flatten(node.props.style).fontSize === 12
      && flatten(node.props.style).marginTop === 4);
    expect(labels).toHaveLength(2);
    expect(labels.map((label) => flatten(label.props.style).color)).toEqual(['#666', '#666']);
  });

  it('shows the error toast when reactivating a parked project fails', async () => {
    mocked.state.updateProject = vi.fn(async () => ({ success: false, error: 'disk full' }));
    act(() => { renderer!.update(<WaitingView />); });

    await act(async () => { mocked.taskListProps.ListHeaderComponent.props.onActivateProject('p-parked'); });

    expect(mocked.state.updateProject).toHaveBeenCalledWith('p-parked', { status: 'active' });
    await vi.waitFor(() => expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', message: 'disk full' })));
  });
});
