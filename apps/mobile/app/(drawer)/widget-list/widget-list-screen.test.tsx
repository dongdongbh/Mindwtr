import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData, Task } from '@mindwtr/core';
import WidgetListScreen from './[id]';

const state = vi.hoisted(() => ({
  data: { tasks: [], projects: [], sections: [], areas: [], settings: {} } as AppData,
  canonical: {} as { _allTasks?: AppData['tasks']; _allProjects?: AppData['projects'] },
  id: 'next' as string | string[],
  source: undefined as string | undefined,
  logInfo: vi.fn(),
  updateTask: vi.fn(), deleteTask: vi.fn(), fetchData: vi.fn(),
}));
vi.mock('@mindwtr/core', async (original) => ({
  ...await original<typeof import('@mindwtr/core')>(),
  useTaskStore: (selector: (store: unknown) => unknown) => selector({ ...state.data, ...state.canonical, updateTask: state.updateTask, deleteTask: state.deleteTask, fetchData: state.fetchData }),
}));
vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
  Stack: { Screen: (props: object) => React.createElement('StackScreen', props) },
  useLocalSearchParams: () => ({ id: state.id, source: state.source }),
}));
vi.mock('@/lib/app-log', () => ({ logInfo: state.logInfo }));
vi.mock('@/contexts/language-context', () => ({ useLanguage: () => ({ language: 'en', t: (id: string) => id }) }));
vi.mock('@/contexts/theme-context', () => ({ useTheme: () => ({ isDark: false }) }));
vi.mock('@/hooks/use-theme-colors', () => {
  const tc = { bg: '#fff', text: '#111', secondaryText: '#555' };
  return { useThemeColors: () => tc };
});
vi.mock('@/lib/task-meta-navigation', () => ({ openProjectScreen: vi.fn(), openContextsScreen: vi.fn() }));
vi.mock('@/components/swipeable-task-item', () => ({ SwipeableTaskItem: (props: object) => React.createElement('TaskRow', props) }));
vi.mock('@/components/task-edit-modal', () => ({ TaskEditModal: (props: object) => React.createElement('TaskModal', props) }));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  FlatList: (props: object) => React.createElement('TaskRows', props),
  RefreshControl: (props: object) => React.createElement('RefreshControl', props),
}));

const task = (id: string): Task => ({ id, title: id, status: 'next', tags: [], contexts: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });

describe('WidgetListScreen', () => {
  beforeEach(() => {
    state.data = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
    state.id = 'next';
    state.source = undefined;
    state.canonical = {};
    vi.clearAllMocks();
  });
  it('keeps the full live list and refreshes after completion', async () => {
    state.data.tasks = Array.from({ length: 90 }, (_, i) => task(`task-${i}`));
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<WidgetListScreen />); });
    const rows = () => tree.root.findByType('TaskRows' as never).props;
    expect(rows().data).toHaveLength(90);
    expect(tree.root.findByType('StackScreen' as never).props.options.title).toBe('Next Actions');
    state.data.tasks = state.data.tasks.map((item, i) => i === 0 ? { ...item, status: 'done' } : item);
    await act(async () => { tree.update(<WidgetListScreen />); });
    expect(rows().data).toHaveLength(89);
    await act(async () => { tree.unmount(); });
  });
  it('uses a saved filter by ID and becomes empty when that filter is deleted', async () => {
    state.id = 'filter:desk';
    state.source = 'shortcut';
    state.data.tasks = [task('Zebra'), task('Alpha')];
    state.data.settings.savedFilters = [{ id: 'desk', name: 'Desk', view: 'next', criteria: {}, sortBy: 'title', sortOrder: 'asc', createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<WidgetListScreen />); });
    const rows = () => tree.root.findByType('TaskRows' as never).props.data as Task[];
    expect(rows().map((item) => item.id)).toEqual(['Alpha', 'Zebra']);
    expect(tree.root.findByType('StackScreen' as never).props.options.title).toBe('Desk');
    expect(state.logInfo).toHaveBeenLastCalledWith('Saved list shortcut destination resolved', { scope: 'shortcuts', extra: { releaseCheck: 'v1.3.3/saved-list-shortcut', available: true } });
    state.data.settings.savedFilters![0].name = 'Renamed';
    state.data.settings = { ...state.data.settings };
    await act(async () => { tree.update(<WidgetListScreen />); });
    expect(tree.root.findByType('StackScreen' as never).props.options.title).toBe('Renamed');
    state.data.settings = { savedFilters: [] };
    await act(async () => { tree.update(<WidgetListScreen />); });
    expect(rows()).toEqual([]);
    expect(state.logInfo).toHaveBeenLastCalledWith('Saved list shortcut destination resolved', { scope: 'shortcuts', extra: { releaseCheck: 'v1.3.3/saved-list-shortcut', available: false } });
    await act(async () => { tree.unmount(); });
  });
  it('fails closed for ambiguous route parameters', async () => {
    state.id = ['next', 'filter:desk'];
    state.data.tasks = [task('hidden')];
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<WidgetListScreen />); });
    expect(tree.root.findByType('TaskRows' as never).props.data).toEqual([]);
    await act(async () => { tree.unmount(); });
  });
  it('retains canonical parent tombstones so the destination matches widget visibility', async () => {
    state.data.tasks = [task('visible'), { ...task('hidden-child'), projectId: 'deleted-project' }];
    state.canonical = {
      _allTasks: state.data.tasks,
      _allProjects: [{ id: 'deleted-project', title: 'Deleted', status: 'active', color: '#000000', order: 0, tagIds: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', deletedAt: '2026-01-02' }],
    };
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<WidgetListScreen />); });
    expect(tree.root.findByType('TaskRows' as never).props.data.map((item: Task) => item.id)).toEqual(['visible']);
    await act(async () => { tree.unmount(); });
  });
});
