import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSyncStoreSave, type Task } from '@mindwtr/core';

const mocked = vi.hoisted(() => ({
  state: null as any,
  flush: vi.fn(),
  showToast: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    flushPendingSave: mocked.flush,
    useTaskStore: { getState: () => mocked.state },
  };
});

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: mocked.showToast }),
}));

vi.mock('@/lib/app-log', () => ({ logInfo: mocked.logInfo }));

import { useSomedaySectionMove } from './use-someday-section-move';

const t = (key: string) => ({
  'viewSections.moveToSection': 'Move to section…',
  'viewSections.moved': 'Moved {count} tasks to {section}',
  'viewSections.noSection': 'No section',
  'common.undo': 'Undo',
} as Record<string, string>)[key] ?? key;

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  status: 'someday',
  tags: [],
  contexts: [],
  createdAt: '2026-09-15T12:00:00.000Z',
  updatedAt: '2026-09-15T12:00:00.000Z',
  ...overrides,
} as Task);

const exitSelectionMode = vi.fn();
let current: ReturnType<typeof useSomedaySectionMove>;
let renderer: ReactTestRenderer;

function Harness() {
  current = useSomedaySectionMove(t, { included: [], excluded: [] }, exitSelectionMode);
  return null;
}

const render = async () => {
  await act(async () => { renderer = create(<Harness />); });
};

const open = async (ids: string[]) => {
  await act(async () => { current.openForSelection(ids); });
};

const move = async (destination?: string) => {
  await act(async () => { await current.move(destination); });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.flush.mockResolvedValue(undefined);
  mocked.state = {
    tasks: [],
    projects: [],
    areas: [],
    settings: { gtd: { viewSections: { someday: [
      { id: 'books', title: 'Books to read', order: 0 },
      { id: 'future', title: 'Future ideas', order: 1 },
    ] } } },
    persistenceFailure: null,
    retryPersistence: vi.fn(async () => {
      mocked.state.persistenceFailure = null;
    }),
    batchUpdateTasks: vi.fn(async (updates: Array<{ id: string; updates: Partial<Task> }>) => {
      mocked.state.tasks = mocked.state.tasks.map((task: Task) => {
        const update = updates.find((candidate) => candidate.id === task.id);
        return update ? { ...task, ...update.updates } : task;
      });
      return { success: true };
    }),
  };
});

describe('Someday section move durability and Undo', () => {
  it('moves one task to an empty section, then Undo preserves later text and other scopes', async () => {
    mocked.state.tasks = [makeTask('one', { viewSectionIds: { waiting: 'delegate', otherScope: 'future' } as Task['viewSectionIds'] })];
    await render();
    await act(async () => { current.openForTask(mocked.state.tasks[0]); });
    await move('books');

    expect(mocked.state.batchUpdateTasks).toHaveBeenCalledOnce();
    expect(mocked.state.tasks[0].viewSectionIds).toEqual({ otherScope: 'future', someday: 'books', waiting: 'delegate' });
    expect(exitSelectionMode).toHaveBeenCalledOnce();
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Moved 1 tasks to Books to read', actionLabel: 'Undo',
    }));
    expect(mocked.logInfo).toHaveBeenCalledWith('Someday section assignment saved', expect.objectContaining({
      extra: { releaseCheck: 'v1.3.1/someday-section-move', count: 1, operation: 'move' },
    }));

    mocked.state.tasks[0] = { ...mocked.state.tasks[0], title: 'Edited later', viewSectionIds: {
      ...mocked.state.tasks[0].viewSectionIds, waiting: 'new delegate',
    } };
    const successToast = mocked.showToast.mock.calls.at(-1)![0];
    await act(async () => { await successToast.onAction(); });

    expect(mocked.state.tasks[0].title).toBe('Edited later');
    expect(mocked.state.tasks[0].viewSectionIds).toEqual({ otherScope: 'future', waiting: 'new delegate' });
    expect(mocked.logInfo).toHaveBeenCalledWith('Someday section assignment saved', expect.objectContaining({
      extra: { releaseCheck: 'v1.3.1/someday-section-move', count: 1, operation: 'undo' },
    }));
    renderer.unmount();
  });

  it('does not claim success after optimistic save failure and retries its queued write with the original Undo snapshot', async () => {
    mocked.state.tasks = [makeTask('one', { viewSectionIds: { someday: 'future', waiting: 'delegate' } })];
    mocked.flush.mockImplementationOnce(async () => {
      mocked.state.persistenceFailure = { message: 'disk full', failedAt: 'now', retrying: false };
      throw new Error('disk full');
    }).mockImplementation(async () => {
      if (mocked.state.persistenceFailure) throw new Error('empty queue cannot prove save');
    });
    await render();
    await open(['one']);
    await move('books');

    expect(mocked.state.tasks[0].viewSectionIds.someday).toBe('books');
    expect(current.moveTargetIds).toEqual(['one']);
    expect(exitSelectionMode).not.toHaveBeenCalled();
    expect(mocked.logInfo).not.toHaveBeenCalled();
    expect(mocked.showToast.mock.calls.at(-1)![0].tone).toBe('error');

    await move('books');
    expect(mocked.state.batchUpdateTasks).toHaveBeenCalledOnce();
    expect(mocked.state.retryPersistence).toHaveBeenCalledOnce();
    expect(mocked.flush).toHaveBeenCalledTimes(2);
    expect(mocked.showToast.mock.calls.at(-1)![0].tone).toBe('success');
    await act(async () => { await mocked.showToast.mock.calls.at(-1)![0].onAction(); });
    expect(mocked.state.tasks[0].viewSectionIds).toEqual({ someday: 'future', waiting: 'delegate' });
    renderer.unmount();
  });

  it('bulk clears only Someday assignments and skips a task changed again before Undo', async () => {
    mocked.state.tasks = [
      makeTask('one', { viewSectionIds: { someday: 'books', focus: 'review' } }),
      makeTask('two', { viewSectionIds: { someday: 'future', waiting: 'delegate' } }),
    ];
    await render();
    await open(['one', 'two']);
    await move(undefined);

    expect(mocked.state.tasks.map((task: Task) => task.viewSectionIds)).toEqual([
      { focus: 'review' }, { waiting: 'delegate' },
    ]);
    const successToast = mocked.showToast.mock.calls.at(-1)![0];
    mocked.state.tasks[1] = { ...mocked.state.tasks[1], viewSectionIds: { someday: 'books', waiting: 'delegate' } };
    await act(async () => { await successToast.onAction(); });
    expect(mocked.state.tasks.map((task: Task) => task.viewSectionIds)).toEqual([
      { focus: 'review', someday: 'books' }, { someday: 'books', waiting: 'delegate' },
    ]);
    renderer.unmount();
  });

  it('keeps selection and the picker when the destination was deleted before apply', async () => {
    mocked.state.tasks = [makeTask('one')];
    await render();
    await open(['one']);
    mocked.state.settings.gtd.viewSections.someday = [];
    await move('books');
    expect(mocked.state.batchUpdateTasks).not.toHaveBeenCalled();
    expect(current.moveTargetIds).toEqual(['one']);
    expect(exitSelectionMode).not.toHaveBeenCalled();
    expect(mocked.showToast.mock.calls.at(-1)![0].tone).toBe('error');
    renderer.unmount();
  });

  it('retains Undo after its optimistic write fails to flush, then retries without a second batch mutation', async () => {
    mocked.state.tasks = [makeTask('one')];
    mocked.flush.mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        mocked.state.persistenceFailure = { message: 'disk full', failedAt: 'now', retrying: false };
        throw new Error('disk full');
      })
      .mockResolvedValue(undefined);
    await render();
    await open(['one']);
    await move('books');
    const successToast = mocked.showToast.mock.calls.at(-1)![0];
    await act(async () => { await successToast.onAction(); });

    expect(mocked.state.tasks[0].viewSectionIds).toEqual({});
    expect(mocked.logInfo).toHaveBeenCalledTimes(1);
    const failedUndoToast = mocked.showToast.mock.calls.at(-1)![0];
    expect(failedUndoToast.tone).toBe('error');
    expect(failedUndoToast.actionLabel).toBe('Undo');

    await act(async () => { await failedUndoToast.onAction(); });
    expect(mocked.state.batchUpdateTasks).toHaveBeenCalledTimes(2);
    expect(mocked.state.retryPersistence).toHaveBeenCalledOnce();
    expect(mocked.flush).toHaveBeenCalledTimes(3);
    expect(mocked.logInfo).toHaveBeenCalledTimes(2);
    expect(mocked.logInfo.mock.calls.at(-1)![1].extra.operation).toBe('undo');
    renderer.unmount();
  });

  it('builds the move on the rows a sync save published while the move waited', async () => {
    mocked.state.tasks = [makeTask('one')];
    await render();
    await open(['one']);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const save = runSyncStoreSave(async () => {
      await held;
      mocked.state.tasks = [makeTask('one', { rev: 3, viewSectionIds: { waiting: 'remote' } })];
    });
    await act(async () => {
      const moved = current.move('books');
      release();
      await save;
      await moved;
    });

    expect(mocked.state.batchUpdateTasks).toHaveBeenCalledWith([
      { id: 'one', updates: { viewSectionIds: { someday: 'books', waiting: 'remote' } } },
    ]);
    renderer.unmount();
  });

  it('refuses a task that left the Someday list while its picker was open', async () => {
    mocked.state.tasks = [makeTask('one')];
    await render();
    await open(['one']);
    mocked.state.tasks[0] = { ...mocked.state.tasks[0], status: 'next' };
    await move('books');

    expect(mocked.state.batchUpdateTasks).not.toHaveBeenCalled();
    expect(current.moveTargetIds).toEqual(['one']);
    expect(mocked.showToast.mock.calls.at(-1)![0].tone).toBe('error');
    renderer.unmount();
  });
});
