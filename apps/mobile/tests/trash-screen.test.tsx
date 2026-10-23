import React from 'react';
import { Alert } from 'react-native';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreActionResult } from '@mindwtr/core';

import TrashScreen from '../app/(drawer)/trash';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  backListeners: [] as (() => boolean)[],
  areaFilter: {
    areaById: new Map<string, any>(),
    resolvedAreaFilter: { included: [] as string[], excluded: [] as string[] },
  },
  storeState: {
    _allTasks: [] as any[],
    _allProjects: [] as any[],
    projects: [] as any[],
    restoreTask: vi.fn(),
    restoreTasks: vi.fn(async (): Promise<StoreActionResult> => ({ success: true })),
    restoreProject: vi.fn(async (): Promise<StoreActionResult> => ({ success: true })),
    purgeTask: vi.fn(),
    purgeTasks: vi.fn(async (): Promise<StoreActionResult> => ({ success: true })),
    purgeProject: vi.fn(async (): Promise<StoreActionResult> => ({ success: true })),
    purgeDeletedTasks: vi.fn(),
    purgeDeletedProjects: vi.fn(),
    highlightTaskId: null as string | null,
    setHighlightTask: vi.fn(),
  },
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<any>('react-native');
  return {
    ...actual,
    BackHandler: {
      addEventListener: (_event: string, listener: () => boolean) => {
        mocks.backListeners.push(listener);
        return { remove: () => { mocks.backListeners = mocks.backListeners.filter((item) => item !== listener); } };
      },
    },
    FlatList: ({ data = [], renderItem, keyExtractor, ListEmptyComponent, ...props }: any) => {
      const children = data.length > 0
        ? data.map((item: any, index: number) => (
          <React.Fragment key={keyExtractor?.(item, index) ?? index}>
            {renderItem?.({ item, index })}
          </React.Fragment>
        ))
        : typeof ListEmptyComponent === 'function'
          ? <ListEmptyComponent />
          : ListEmptyComponent;

      return React.createElement('FlatList', { ...props, data }, children);
    },
  };
});

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<any>('@mindwtr/core');
  return {
    ...actual,
    shallow: Object.is,
    // Run the real selector: the screen reads through
    // `useTaskStore((state) => ({…}), shallow)`, so a mock that ignores the
    // selector never executes the projection it is meant to cover.
    useTaskStore: (selector?: (state: unknown) => unknown) => (
      selector ? selector(mocks.storeState) : mocks.storeState
    ),
    getInlineMarkdownPreview: vi.fn((markdown: string) => markdown),
  };
});

vi.mock('@/components/markdown-text', () => ({
  MarkdownInlineText: ({ markdown, ...props }: any) => React.createElement('MarkdownInlineText', props, markdown),
}));

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: mocks.showToast, dismissToast: vi.fn() }),
}));

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(),
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: vi.fn(),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'common.tasks': 'tasks',
      'projects.title': 'Projects',
      'trash.deletedAt': 'Deleted',
      'trash.projectType': 'Project',
      'trash.taskType': 'Task',
    }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => mocks.areaFilter,
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#000000',
    border: '#222222',
    cardBg: '#111111',
    taskItemBg: '#111111',
    text: '#ffffff',
    secondaryText: '#999999',
    tint: '#3b82f6',
  }),
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children, ...props }: any) => (
    React.createElement('GestureHandlerRootView', props, children)
  ),
  Swipeable: ({ children }: any) => React.createElement('Swipeable', {}, children),
}));

describe('TrashScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.areaFilter.areaById = new Map();
    mocks.areaFilter.resolvedAreaFilter = { included: [], excluded: [] };
    mocks.storeState._allTasks = [{
      id: 'recent-task',
      title: 'Recently deleted task',
      status: 'inbox',
      tags: [],
      contexts: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-07-13T12:00:00.000Z',
      deletedAt: '2026-07-13T12:00:00.000Z',
    }];
    mocks.storeState._allProjects = [{
      id: 'older-project',
      title: 'Older deleted project',
      status: 'archived',
      color: '#64748b',
      order: 0,
      tagIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-07-01T12:00:00.000Z',
      deletedAt: '2026-07-01T12:00:00.000Z',
    }];
    mocks.storeState.projects = [];
  });

  it('passes one newest-deleted-first task and project timeline to FlatList', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TrashScreen />);
    });

    const flatList = tree.root.findByType('FlatList' as unknown as React.ElementType);
    const itemIds = flatList.props.data.map((item: any) => (
      item.type === 'task' ? item.task.id : item.project.id
    ));

    expect(itemIds).toEqual(['recent-task', 'older-project']);
  });

  it('uses the area accent instead of the placeholder for a trashed project dot', () => {
    mocks.areaFilter.areaById = new Map([['a-home', { id: 'a-home', color: '#16a34a' }]]);
    mocks.storeState._allProjects[0] = { ...mocks.storeState._allProjects[0], color: '#94a3b8', areaId: 'a-home' };
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<TrashScreen />); });
    const colors = tree.root.findAllByType('View' as unknown as React.ElementType)
      .flatMap((node) => Array.isArray(node.props.style) ? node.props.style : [node.props.style])
      .map((style) => style?.backgroundColor);
    expect(colors).toContain('#16a34a');
    expect(colors).not.toContain('#94a3b8');
  });

  const timelineIds = (tree: renderer.ReactTestRenderer) => tree.root
    .findByType('FlatList' as unknown as React.ElementType).props.data
    .map((item: any) => (item.type === 'task' ? item.task.id : item.project.id));

  it('narrows the trash timeline to the areas the filter includes', () => {
    mocks.areaFilter.areaById = new Map([['a1', { id: 'a1', name: 'Work', order: 0 }]]);
    mocks.storeState._allTasks[0].areaId = 'a1';
    mocks.areaFilter.resolvedAreaFilter = { included: ['a1'], excluded: [] };

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TrashScreen />);
    });

    // The project has no area, so including "Work" leaves only the task.
    expect(timelineIds(tree)).toEqual(['recent-task']);
  });

  it('drops trashed items whose area the filter excludes', () => {
    mocks.areaFilter.areaById = new Map([['a1', { id: 'a1', name: 'Work', order: 0 }]]);
    mocks.storeState._allTasks[0].areaId = 'a1';
    mocks.storeState._allProjects[0].areaId = 'a1';
    mocks.areaFilter.resolvedAreaFilter = { included: [], excluded: ['a1'] };

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TrashScreen />);
    });

    expect(timelineIds(tree)).toEqual([]);
  });

  const findPressableByLabel = (tree: renderer.ReactTestRenderer, label: string) => tree.root.findAll((node) => (
    node.props?.accessibilityLabel === label && typeof node.props?.onPress === 'function'
  ))[0];

  // The Clear Trash button carries no accessibility label, so it is found by the
  // text it renders. The last match is the innermost pressable holding that text.
  const instanceText = (node: renderer.ReactTestInstance) => [node, ...node.findAll(() => true)]
    .flatMap((child) => child.children)
    .filter((child): child is string => typeof child === 'string')
    .join('');

  const findPressableByText = (tree: renderer.ReactTestRenderer, text: string) => tree.root.findAll((node) => (
    typeof node.props?.onPress === 'function' && instanceText(node).includes(text)
  )).slice(-1)[0];

  // Purge cannot be undone, so Clear Trash may only delete what the screen lists.
  it('clears only the trashed items the area filter shows', async () => {
    mocks.areaFilter.areaById = new Map([['a1', { id: 'a1', name: 'Work', order: 0 }]]);
    mocks.storeState._allTasks.push({
      ...mocks.storeState._allTasks[0], id: 'work-task', title: 'Work deleted task', areaId: 'a1',
    });
    mocks.storeState._allProjects.push({
      ...mocks.storeState._allProjects[0], id: 'work-project', title: 'Work deleted project', areaId: 'a1',
    });
    mocks.areaFilter.resolvedAreaFilter = { included: [], excluded: ['a1'] };
    const alertSpy = vi.spyOn(Alert, 'alert');

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TrashScreen />);
    });
    renderer.act(() => { findPressableByText(tree, 'Clear Trash').props.onPress(); });

    // The counts sentence names the shown set, not "all trashed", and the counts
    // and the translated sentence are two lines — no hard-coded ". " join.
    expect(alertSpy.mock.calls[0]?.[1]).toBe('1 task · 1 project\nThis action cannot be undone.');
    const confirmButton = (alertSpy.mock.calls[0]?.[2] ?? []).find((button) => button.style === 'destructive');
    await renderer.act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mocks.storeState.purgeTasks).toHaveBeenCalledWith(['recent-task']);
    expect(mocks.storeState.purgeProject).toHaveBeenCalledWith('older-project');
    expect(mocks.storeState.purgeDeletedTasks).not.toHaveBeenCalled();
    expect(mocks.storeState.purgeDeletedProjects).not.toHaveBeenCalled();
  });

  // The confirmed set is the set the alert was opened for, whatever its wording.
  // An item that arrives while the alert is open was never shown, so it survives.
  it('clears exactly the items the alert was opened for', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert');
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TrashScreen />);
    });
    renderer.act(() => { findPressableByText(tree, 'Clear Trash').props.onPress(); });

    // Nothing is hidden, so the alert still claims the whole trash.
    expect(alertSpy.mock.calls[0]?.[1]).toBe('This will permanently delete all trashed tasks and projects.');

    // A sync merge lands another trashed task before the user confirms.
    mocks.storeState._allTasks.push({
      ...mocks.storeState._allTasks[0], id: 'arriving-task', title: 'Arriving deleted task',
    });

    const confirmButton = (alertSpy.mock.calls[0]?.[2] ?? []).find((button) => button.style === 'destructive');
    await renderer.act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mocks.storeState.purgeTasks).toHaveBeenCalledWith(['recent-task']);
    expect(mocks.storeState.purgeProject).toHaveBeenCalledWith('older-project');
    expect(mocks.storeState.purgeDeletedTasks).not.toHaveBeenCalled();
    expect(mocks.storeState.purgeDeletedProjects).not.toHaveBeenCalled();
  });

  it('bulk restores all selected tasks and projects', async () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TrashScreen />);
    });

    renderer.act(() => { findPressableByLabel(tree, 'Select').props.onPress(); });
    renderer.act(() => { findPressableByLabel(tree, 'Select all').props.onPress(); });
    await renderer.act(async () => {
      findPressableByLabel(tree, 'trash.restore').props.onPress();
      await Promise.resolve();
    });

    expect(mocks.storeState.restoreTasks).toHaveBeenCalledWith(['recent-task']);
    expect(mocks.storeState.restoreProject).toHaveBeenCalledWith('older-project');
  });

  it('keeps selection and warns when one bulk restore result fails', async () => {
    mocks.storeState.restoreProject.mockResolvedValueOnce({ success: false, error: 'Project not found' });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TrashScreen />);
    });

    renderer.act(() => { findPressableByLabel(tree, 'Select').props.onPress(); });
    renderer.act(() => { findPressableByLabel(tree, 'Select all').props.onPress(); });
    await renderer.act(async () => {
      await findPressableByLabel(tree, 'trash.restore').props.onPress();
    });

    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' }));
    expect(findPressableByLabel(tree, 'trash.deletePermanently')).toBeTruthy();
  });

  it('bulk purges selected items after confirming the alert', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert');
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TrashScreen />);
    });

    renderer.act(() => { findPressableByLabel(tree, 'Select').props.onPress(); });
    renderer.act(() => { findPressableByLabel(tree, 'Select all').props.onPress(); });
    renderer.act(() => { findPressableByLabel(tree, 'trash.deletePermanently').props.onPress(); });

    const buttons = alertSpy.mock.calls[0]?.[2] ?? [];
    const confirmButton = buttons.find((button) => button.style === 'destructive');
    expect(confirmButton).toBeTruthy();
    await renderer.act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mocks.storeState.purgeTasks).toHaveBeenCalledWith(['recent-task']);
    expect(mocks.storeState.purgeProject).toHaveBeenCalledWith('older-project');
  });

  it('keeps selection and warns when one bulk purge result fails', async () => {
    mocks.storeState.purgeTasks.mockResolvedValueOnce({ success: false, error: 'Tasks not found' });
    const alertSpy = vi.spyOn(Alert, 'alert');
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TrashScreen />);
    });

    renderer.act(() => { findPressableByLabel(tree, 'Select').props.onPress(); });
    renderer.act(() => { findPressableByLabel(tree, 'Select all').props.onPress(); });
    renderer.act(() => { findPressableByLabel(tree, 'trash.deletePermanently').props.onPress(); });
    const buttons = alertSpy.mock.calls[0]?.[2] ?? [];
    const confirmButton = buttons.find((button) => button.style === 'destructive');
    await renderer.act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' }));
    expect(findPressableByLabel(tree, 'trash.deletePermanently')).toBeTruthy();
  });

  it('leaves selection mode on Android Back (#1415)', () => {
    mocks.backListeners = [];
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TrashScreen />);
    });
    renderer.act(() => { findPressableByLabel(tree, 'Select').props.onPress(); });
    renderer.act(() => { findPressableByLabel(tree, 'Select all').props.onPress(); });
    expect(findPressableByLabel(tree, 'trash.restore')).toBeTruthy();

    let handled = false;
    renderer.act(() => {
      handled = [...mocks.backListeners].reverse().some((listener) => listener());
    });

    expect(handled).toBe(true);
    expect(findPressableByLabel(tree, 'trash.restore')).toBeUndefined();
    expect(findPressableByLabel(tree, 'Select')).toBeTruthy();
    expect(mocks.backListeners).toHaveLength(0);
  });
});
