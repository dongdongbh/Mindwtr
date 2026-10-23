import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStoreCommand, runSyncStoreSave, useTaskStore, type StoreActionResult, type Task } from '@mindwtr/core';
import { NavigationContext } from '@react-navigation/native';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  alert: vi.fn(),
  backListeners: [] as (() => boolean)[],
}));

// Android Back as RN runs it: newest listener first, stop at the first that returns true.
const pressBack = () => {
  let handled = false;
  renderer.act(() => {
    handled = [...mocks.backListeners].reverse().some((listener) => listener());
  });
  return handled;
};

vi.mock('react-native', async () => {
  const actual = await vi.importActual<any>('react-native');
  return {
    ...actual,
    Alert: { ...actual.Alert, alert: mocks.alert },
    BackHandler: {
      addEventListener: (_event: string, listener: () => boolean) => {
        mocks.backListeners.push(listener);
        return { remove: () => { mocks.backListeners = mocks.backListeners.filter((item) => item !== listener); } };
      },
    },
  };
});

vi.mock('../contexts/toast-context', () => ({
  useToast: () => ({ showToast: mocks.showToast, dismissToast: vi.fn() }),
}));

vi.mock('../lib/app-log', () => ({
  logError: vi.fn(),
}));

import { useTaskListSelection } from './use-task-list-selection';

type HookReturn = ReturnType<typeof useTaskListSelection>;
type HookParams = Parameters<typeof useTaskListSelection>[0];

const makeTask = (id: string): Task => ({
  id,
  title: id,
  status: 'next',
  contexts: [],
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

let hookRef: HookReturn;
function Harness(props: HookParams) {
  hookRef = useTaskListSelection(props);
  return null;
}

const baseParams = (overrides: Partial<HookParams> = {}): HookParams => ({
  batchDeleteTasks: vi.fn(async () => ({ success: true } as StoreActionResult)),
  batchMoveTasks: vi.fn(async () => ({ success: true } as StoreActionResult)),
  batchUpdateTasks: vi.fn(async () => ({ success: true } as StoreActionResult)),
  restoreTask: vi.fn(async () => undefined),
  t: (key: string) => ({ 'common.undo': 'Undo', 'list.countTaskSingular': 'task', 'common.tasks': 'tasks' }[key] ?? key),
  tasksById: { a: makeTask('a') },
  ...overrides,
});

const confirmDelete = async () => {
  renderer.act(() => {
    hookRef.handleBatchDelete();
  });
  const buttons = mocks.alert.mock.calls[0]?.[2] as { style?: string; onPress?: () => Promise<void> | void }[];
  const confirm = buttons.find((button) => button.style === 'destructive');
  await renderer.act(async () => {
    await confirm?.onPress?.();
  });
};

describe('useTaskListSelection handleBatchDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the error toast and keeps selection when batchDeleteTasks reports failure', async () => {
    const batchDeleteTasks = vi.fn(async () => ({ success: false, error: 'Tasks not found: a' } as StoreActionResult));
    renderer.act(() => {
      renderer.create(<Harness {...baseParams({ batchDeleteTasks })} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
    });
    expect(hookRef.selectionMode).toBe(true);

    await confirmDelete();

    expect(batchDeleteTasks).toHaveBeenCalledWith(['a']);
    // No false confirmation: no success/undo toast, selection is retained so the user can retry.
    const toasts = mocks.showToast.mock.calls.map((call) => call[0]);
    expect(toasts.some((toast) => toast.tone === 'success')).toBe(false);
    expect(toasts.some((toast) => toast.actionLabel === 'Restore')).toBe(false);
    expect(toasts.some((toast) => toast.tone === 'warning')).toBe(true);
    expect(hookRef.selectionMode).toBe(true);
    expect(hookRef.hasSelection).toBe(true);
  });

  it('shows the success/undo toast and exits selection when batchDeleteTasks succeeds', async () => {
    const batchDeleteTasks = vi.fn(async () => ({ success: true } as StoreActionResult));
    renderer.act(() => {
      renderer.create(<Harness {...baseParams({ batchDeleteTasks })} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
    });

    await confirmDelete();

    expect(batchDeleteTasks).toHaveBeenCalledWith(['a']);
    const toasts = mocks.showToast.mock.calls.map((call) => call[0]);
    const success = toasts.find((toast) => toast.tone === 'success');
    expect(success).toBeTruthy();
    expect(success?.message).toBe('1 task');
    expect(success?.actionLabel).toBe('Undo');
    expect(hookRef.selectionMode).toBe(false);
    expect(hookRef.hasSelection).toBe(false);
  });

  it('shows a warning when the Undo restore reports a fulfilled failure', async () => {
    const restoreTask = vi.fn(async () => ({ success: false, error: 'Task not found: a' } as StoreActionResult));
    renderer.act(() => {
      renderer.create(<Harness {...baseParams({ restoreTask })} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
    });

    await confirmDelete();
    const successToast = mocks.showToast.mock.calls
      .map((call) => call[0])
      .find((toast) => toast.tone === 'success');

    await renderer.act(async () => {
      successToast?.onAction?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(restoreTask).toHaveBeenCalledWith('a');
    const toasts = mocks.showToast.mock.calls.map((call) => call[0]);
    expect(toasts.some((toast) => toast.tone === 'warning')).toBe(true);
  });
});

// Tag writes build each list from the task as stored (the real core store), not the rows on screen.
const seedStore = (tasks: Record<string, Task>) => useTaskStore.setState({ _allTasks: Object.values(tasks) });

describe('useTaskListSelection handleBatchRemoveTags', () => {
  const taggedTasks = {
    a: { ...makeTask('a'), tags: ['#ops', '#urgent', '#keep'] },
    b: { ...makeTask('b'), tags: ['#urgent'] },
    c: { ...makeTask('c'), tags: ['#keep'] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    seedStore(taggedTasks);
  });

  afterEach(() => {
    seedStore({});
  });

  it('adds and removes a tag on the rows a sync save published while the write waited behind it', async () => {
    // batchUpdateTasks as the store runs it: a command behind the write gate (store-write-gate.ts).
    const batchUpdateTasks = vi.fn((updates: { id: string; updates: Partial<Task> }[]) => runStoreCommand(async () => {
      const byId = new Map(updates.map((entry) => [entry.id, entry.updates]));
      useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map((task) => ({ ...task, ...byId.get(task.id) })) });
      return { success: true } as StoreActionResult;
    }));
    renderer.act(() => {
      renderer.create(<Harness {...baseParams({ batchUpdateTasks, tasksById: taggedTasks })} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('b');
      hookRef.setTagInput('#new');
    });
    // The write is issued while a sync save holds the gate; the save then publishes another device's tag on b.
    const behindSyncSave = async (tag: string, write: () => Promise<void>) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const save = runSyncStoreSave(async () => {
        await held;
        const stored = useTaskStore.getState()._tasksById.get('b')!;
        useTaskStore.setState({ _allTasks: [{ ...stored, rev: (stored.rev ?? 1) + 1, tags: [...stored.tags, tag] }] });
      });
      let pending!: Promise<void>;
      renderer.act(() => { pending = write(); });
      release();
      await renderer.act(async () => { await save; await pending; });
    };

    await behindSyncSave('#remote', () => hookRef.handleBatchAddTag());
    expect(useTaskStore.getState()._tasksById.get('b')?.tags).toEqual(['#new', '#remote', '#urgent']);

    renderer.act(() => {
      hookRef.toggleMultiSelect('b');
    });
    await behindSyncSave('#later', () => hookRef.handleBatchRemoveTags(['#urgent']));
    expect(useTaskStore.getState()._tasksById.get('b')?.tags).toEqual(['#later', '#new', '#remote']);
  });

  it('offers only the tags the selection actually carries', () => {
    renderer.act(() => {
      renderer.create(<Harness {...baseParams({ tasksById: taggedTasks })} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('b');
    });

    expect(hookRef.removableTagOptions).toEqual(['#urgent']);
  });

  it('strips every picked tag in one write and skips tasks carrying none of them', async () => {
    const batchUpdateTasks = vi.fn(async () => ({ success: true } as StoreActionResult));
    renderer.act(() => {
      renderer.create(<Harness {...baseParams({ batchUpdateTasks, tasksById: taggedTasks })} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
      hookRef.toggleMultiSelect('b');
      hookRef.toggleMultiSelect('c');
    });

    await renderer.act(async () => {
      await hookRef.handleBatchRemoveTags(['#ops', '#urgent']);
    });

    // Task c keeps only #keep, so it is left out of the write entirely.
    expect(batchUpdateTasks).toHaveBeenCalledWith([
      { id: 'a', updates: { tags: ['#keep'] } },
      { id: 'b', updates: { tags: [] } },
    ]);
    expect(hookRef.selectionMode).toBe(false);
  });

  it('keeps the selection and warns when the write reports a failure', async () => {
    const batchUpdateTasks = vi.fn(async () => ({ success: false, error: 'nope' } as StoreActionResult));
    renderer.act(() => {
      renderer.create(<Harness {...baseParams({ batchUpdateTasks, tasksById: taggedTasks })} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
    });

    await renderer.act(async () => {
      await hookRef.handleBatchRemoveTags(['#ops']);
    });

    const toasts = mocks.showToast.mock.calls.map((call) => call[0]);
    expect(toasts.some((toast) => toast.tone === 'success')).toBe(false);
    expect(toasts.some((toast) => toast.tone === 'warning')).toBe(true);
    expect(hookRef.hasSelection).toBe(true);
  });

  it('keeps the typed tag when Add tag fails, and clears it once a write succeeds', async () => {
    let result: StoreActionResult = { success: false, error: 'nope' };
    const batchUpdateTasks = vi.fn(async () => result);
    renderer.act(() => {
      renderer.create(<Harness {...baseParams({ batchUpdateTasks, tasksById: taggedTasks })} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
      hookRef.setTagModalVisible(true);
      hookRef.setTagInput('#new');
    });

    await renderer.act(async () => {
      await hookRef.handleBatchAddTag();
    });
    // The dialog closes so the warning toast shows; reopening it shows the tag again.
    expect(hookRef.tagModalVisible).toBe(false);
    expect(hookRef.tagInput).toBe('#new');
    expect(hookRef.hasSelection).toBe(true);

    result = { success: true };
    await renderer.act(async () => {
      await hookRef.handleBatchAddTag();
    });
    expect(hookRef.tagInput).toBe('');
  });
});

describe('useTaskListSelection selection boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const selectableTasks = {
    a: makeTask('a'),
    archived: makeTask('archived'),
    b: makeTask('b'),
  };

  it('excludes denied tasks from direct and range selection', () => {
    renderer.act(() => {
      renderer.create(
        <Harness
          {...baseParams({
            tasksById: selectableTasks,
            canSelectTaskId: (taskId) => taskId !== 'archived',
          })}
        />,
      );
    });

    renderer.act(() => {
      hookRef.toggleMultiSelect('archived');
    });
    expect(hookRef.selectionMode).toBe(false);
    expect(hookRef.selectedIdsArray).toEqual([]);

    renderer.act(() => {
      hookRef.toggleMultiSelect('a', { visibleTaskIds: ['a', 'archived', 'b'] });
    });
    renderer.act(() => {
      hookRef.toggleRangeSelectMode();
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('b', { visibleTaskIds: ['a', 'archived', 'b'] });
    });

    expect(hookRef.selectedIdsArray).toEqual(['a', 'b']);
    expect(hookRef.multiSelectedIds.has('archived')).toBe(false);
  });

  it('drops a task that becomes denied before a bulk status write', async () => {
    const batchMoveTasks = vi.fn(async () => ({ success: true } as StoreActionResult));
    const params = baseParams({ batchMoveTasks, tasksById: selectableTasks });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Harness {...params} canSelectTaskId={() => true} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
      hookRef.toggleMultiSelect('archived');
    });
    renderer.act(() => {
      tree.update(<Harness {...params} canSelectTaskId={(taskId) => taskId !== 'archived'} />);
    });

    expect(hookRef.selectedIdsArray).toEqual(['a']);
    await renderer.act(async () => {
      await hookRef.handleBatchMove('next');
    });
    expect(batchMoveTasks).toHaveBeenCalledWith(['a'], 'next');
  });

  it('drops a task that becomes denied before a bulk tag write', async () => {
    seedStore(selectableTasks);
    const batchUpdateTasks = vi.fn(async () => ({ success: true } as StoreActionResult));
    const params = baseParams({ batchUpdateTasks, tasksById: selectableTasks });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Harness {...params} canSelectTaskId={() => true} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
      hookRef.toggleMultiSelect('archived');
      hookRef.setTagInput('#kept-safe');
    });
    renderer.act(() => {
      tree.update(<Harness {...params} canSelectTaskId={(taskId) => taskId !== 'archived'} />);
    });

    await renderer.act(async () => {
      await hookRef.handleBatchAddTag();
    });
    expect(batchUpdateTasks).toHaveBeenCalledWith([
      { id: 'a', updates: { tags: ['#kept-safe'] } },
    ]);
  });

  it('drops a task that becomes denied before a bulk delete', async () => {
    const batchDeleteTasks = vi.fn(async () => ({ success: true } as StoreActionResult));
    const params = baseParams({ batchDeleteTasks, tasksById: selectableTasks });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Harness {...params} canSelectTaskId={() => true} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
      hookRef.toggleMultiSelect('archived');
    });
    renderer.act(() => {
      tree.update(<Harness {...params} canSelectTaskId={(taskId) => taskId !== 'archived'} />);
    });

    await confirmDelete();
    expect(batchDeleteTasks).toHaveBeenCalledWith(['a']);
  });
});

describe('useTaskListSelection handleBatchOrganize', () => {
  it('keeps a tag a sync save published while the organize write waited', async () => {
    const tasks = { b: { ...makeTask('b'), tags: ['#urgent'] } };
    useTaskStore.setState({ _allTasks: Object.values(tasks) });
    const batchUpdateTasks = vi.fn((updates: { id: string; updates: Partial<Task> }[]) => runStoreCommand(async () => {
      const byId = new Map(updates.map((entry) => [entry.id, entry.updates]));
      useTaskStore.setState({ _allTasks: useTaskStore.getState()._allTasks.map((task) => ({ ...task, ...byId.get(task.id) })) });
      return { success: true } as StoreActionResult;
    }));
    renderer.act(() => { renderer.create(<Harness {...baseParams({ batchUpdateTasks, tasksById: tasks })} />); });
    renderer.act(() => { hookRef.toggleMultiSelect('b'); });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // Another device's tag, published by a sync save that holds the gate while Apply is pressed.
    const save = runSyncStoreSave(async () => {
      await held;
      const stored = useTaskStore.getState()._tasksById.get('b')!;
      useTaskStore.setState({ _allTasks: [{ ...stored, rev: (stored.rev ?? 1) + 1, tags: [...stored.tags, '#remote'] }] });
    });
    let pending!: Promise<void>;
    renderer.act(() => { pending = hookRef.handleBatchOrganize({ tags: ['#new'] }); });
    release();
    await renderer.act(async () => { await save; await pending; });
    expect(useTaskStore.getState()._tasksById.get('b')?.tags).toEqual(expect.arrayContaining(['#urgent', '#remote', '#new']));
  });
});

describe('useTaskListSelection Android Back (#1415)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backListeners = [];
  });

  it('leaves selection mode on Back and consumes the press', () => {
    renderer.act(() => {
      renderer.create(<Harness {...baseParams()} />);
    });
    expect(mocks.backListeners).toHaveLength(0);
    expect(pressBack()).toBe(false);

    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
    });
    expect(hookRef.selectionMode).toBe(true);

    expect(pressBack()).toBe(true);
    expect(hookRef.selectionMode).toBe(false);
    expect(hookRef.hasSelection).toBe(false);
    // Out of selection mode the next Back goes to navigation again.
    expect(mocks.backListeners).toHaveLength(0);
    expect(pressBack()).toBe(false);
  });

  it('leaves Back to the screen on top while its own screen is not focused', () => {
    const navigation = { isFocused: () => false };
    renderer.act(() => {
      renderer.create(
        <NavigationContext.Provider value={navigation as never}>
          <Harness {...baseParams()} />
        </NavigationContext.Provider>,
      );
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
    });
    expect(pressBack()).toBe(false);
    expect(hookRef.selectionMode).toBe(true);

    navigation.isFocused = () => true;
    expect(pressBack()).toBe(true);
    expect(hookRef.selectionMode).toBe(false);
  });

  it('leaves Back to the screen while it says a dialog is open, or while a tag dialog is open', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<Harness {...baseParams({ backExitsSelection: false })} />);
    });
    renderer.act(() => {
      hookRef.toggleMultiSelect('a');
    });
    expect(pressBack()).toBe(false);
    expect(hookRef.selectionMode).toBe(true);

    renderer.act(() => {
      tree.update(<Harness {...baseParams()} />);
    });
    renderer.act(() => {
      hookRef.setTagModalVisible(true);
    });
    expect(pressBack()).toBe(false);
    expect(hookRef.selectionMode).toBe(true);

    renderer.act(() => {
      hookRef.setTagModalVisible(false);
    });
    expect(pressBack()).toBe(true);
    expect(hookRef.selectionMode).toBe(false);
  });
});
