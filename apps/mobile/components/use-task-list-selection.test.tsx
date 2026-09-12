import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreActionResult, Task } from '@mindwtr/core';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  alert: vi.fn(),
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<any>('react-native');
  return {
    ...actual,
    Alert: { ...actual.Alert, alert: mocks.alert },
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
  restoreActionLabel: 'Restore',
  restoreTask: vi.fn(async () => undefined),
  t: (key: string) => key,
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
    expect(success?.actionLabel).toBe('Restore');
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

describe('useTaskListSelection handleBatchRemoveTags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const taggedTasks = {
    a: { ...makeTask('a'), tags: ['#ops', '#urgent', '#keep'] },
    b: { ...makeTask('b'), tags: ['#urgent'] },
    c: { ...makeTask('c'), tags: ['#keep'] },
  };

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
