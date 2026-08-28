import { describe, expect, test } from 'bun:test';

import { createCorePersistenceService, type WriteTransactionRunner } from './core-adapter.js';

const iso = '2026-07-22T00:00:00.000Z';

const createHarness = (adapter: {
  saveTask: (task: Record<string, unknown>) => Promise<void>;
  saveData: () => Promise<void>;
}, runWriteTransaction?: WriteTransactionRunner) => {
  let trackedSaves: Set<Promise<void>> | null = null;
  const task = {
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: iso,
    updatedAt: iso,
  };
  const project = {
    id: 'project-1',
    title: 'Project',
    status: 'active',
    color: '#6B7280',
    order: 0,
    tagIds: [],
    createdAt: iso,
    updatedAt: iso,
  };
  const state: any = {
    _allTasks: [task],
    _allProjects: [project],
    _allSections: [],
    _allAreas: [],
    _allPeople: [],
    fetchData: async () => undefined,
    updateTask: async (id: string, updates: Record<string, unknown>) => {
      const updated = { ...state._allTasks.find((item: any) => item.id === id), ...updates };
      state._allTasks = [updated];
      const save = adapter.saveTask(updated);
      trackedSaves?.add(save);
      void save.catch(() => undefined);
      return { success: true };
    },
    deleteTask: async () => ({ success: true }),
    updateProject: async (id: string, updates: Record<string, unknown>) => {
      state._allProjects = [{ ...state._allProjects.find((item: any) => item.id === id), ...updates }];
      return { success: true };
    },
  };
  const core: any = {
    useTaskStore: { getState: () => state },
    flushPendingSave: () => adapter.saveData(),
    runWithImmediateSaveTracking: async (operation: () => Promise<unknown>) => {
      const saves = new Set<Promise<void>>();
      trackedSaves = saves;
      try {
        const result = await operation();
        await Promise.all(saves);
        return { result, saveCount: saves.size };
      } finally {
        trackedSaves = null;
      }
    },
  };
  return { service: createCorePersistenceService(core, runWriteTransaction), state };
};

describe('MCP core write persistence contract', () => {
  test('keeps reload, mutation, and flush inside the write transaction', async () => {
    const events: string[] = [];
    const runWriteTransaction: WriteTransactionRunner = async (operation) => {
      events.push('lock:enter');
      try {
        return await operation();
      } finally {
        events.push('lock:exit');
      }
    };
    const { service, state } = createHarness({
      saveTask: async () => { events.push('save:task'); },
      saveData: async () => { events.push('save:flush'); },
    }, runWriteTransaction);
    state.fetchData = async () => { events.push('reload'); };

    await service.updateTask({ id: 'task-1', updates: { title: 'Updated' } });

    expect(events).toEqual([
      'lock:enter',
      'reload',
      'save:task',
      'save:flush',
      'lock:exit',
    ]);
  });

  test('returns confirmed task writes with corruption guidance while project writes fail', async () => {
    const storageError = new Error('database disk image is malformed');
    const { service } = createHarness({
      saveTask: async () => undefined,
      saveData: async () => { throw storageError; },
    });

    const updated = await service.updateTask({ id: 'task-1', updates: { title: 'Updated' } });
    const completed = await service.completeTask('task-1');

    expect(updated.title).toBe('Updated');
    expect(completed.status).toBe('done');
    expect(updated.storageWarning).toContain('change was saved');
    expect(updated.storageWarning).toContain('database file appears damaged');
    expect(updated.storageWarning).toContain('PRAGMA integrity_check');
    expect(JSON.stringify({ task: updated })).toContain('storageWarning');
    await expect(service.updateProject({ id: 'project-1', updates: { title: 'Updated' } }))
      .rejects.toThrow('database file appears damaged');
  });

  test('rejects a task write when its incremental save fails', async () => {
    let fullSaveCalls = 0;
    const { service } = createHarness({
      saveTask: async () => { throw new Error('incremental save failed'); },
      saveData: async () => { fullSaveCalls += 1; },
    });

    await expect(service.updateTask({ id: 'task-1', updates: { title: 'Updated' } }))
      .rejects.toThrow('incremental save failed');
    expect(fullSaveCalls).toBe(0);
  });

  test('rejects a task write when no incremental save confirms persistence', async () => {
    const { service } = createHarness({
      saveTask: async () => undefined,
      saveData: async () => { throw new Error('disk full'); },
    });

    await expect(service.deleteTask('task-1')).rejects.toThrow('disk full');
  });
});
