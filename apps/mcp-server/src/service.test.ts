import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createService } from './service.js';
import { parseQuickAdd } from '@mindwtr/core';
import { closeCoreAdapter, runCoreService } from './core-adapter.js';
import * as mcpDb from './db.js';
import * as mcpQueries from './queries.js';

const tempDirs: string[] = [];

// These tests bootstrap a real SQLite database from data.json. On a loaded shared CI
// runner that alone ran past bun's 5s default (5.3s on 2026-08-30), so give them the
// same explicit budget the cross-process lock tests carry; a timeout at 20s is real.
const REAL_SQLITE_TEST_TIMEOUT_MS = 20_000;

const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mindwtr-mcp-service-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('mcp service', () => {
  test('delegates read operations through query deps', async () => {
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [{ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
      listProjects: () => [{ id: 'p1', title: 'Project' }],
      listAreas: () => [{ id: 'a1', name: 'Area' }],
      listPeople: () => [{ id: 'person1', name: 'Alex' }],
      getTask: () => ({ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }),
      getProject: () => ({ id: 'p1', title: 'Project' }),
      getPerson: () => ({ id: 'person1', name: 'Alex' }),
      parseQuickAdd: () => ({ title: '', props: {} }),
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addTask: async () => ({ id: 't1' }),
          updateTask: async () => ({ id: 't1' }),
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async () => ({ id: 'p1', title: 'Project' }),
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
          deleteProject: async () => ({ id: 'p1', title: 'Project', deletedAt: '2026-01-02' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area', deletedAt: '2026-01-02' }),
          addPerson: async () => ({ id: 'person1', name: 'Alex' }),
          updatePerson: async () => ({ id: 'person1', name: 'Alex' }),
          renamePerson: async () => ({ id: 'person1', name: 'Alexandra' }),
          deletePerson: async () => ({ id: 'person1', name: 'Alex', deletedAt: '2026-01-02' }),
        }),
    };
    const service = createService({ readonly: true }, deps as any);

    const tasks = await service.listTasks({});
    const projects = await service.listProjects();
    const areas = await service.listAreas();
    const people = await service.listPeople();
    const task = await service.getTask({ id: 't1' });
    const project = await service.getProject({ id: 'p1' });
    const person = await service.getPerson({ id: 'person1' });

    expect(tasks).toHaveLength(1);
    expect(projects).toHaveLength(1);
    expect(areas).toHaveLength(1);
    expect(people).toHaveLength(1);
    expect(task.id).toBe('t1');
    expect(project.id).toBe('p1');
    expect(person.id).toBe('person1');
  });

  test('uses quick-add parser and forwards merged props to core addTask', async () => {
    let receivedAddTaskInput: any = null;
    let quickAddCalls = 0;
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [],
      listProjects: () => [{ id: 'p1', title: 'Home' }],
      listAreas: () => [],
      getTask: () => {
        throw new Error('not used');
      },
      getProject: () => {
        throw new Error('not used');
      },
      parseQuickAdd: () => {
        quickAddCalls += 1;
        return {
          title: 'Buy milk',
          props: { projectId: 'p1', contexts: ['@errands'] },
        };
      },
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addTask: async (input: any) => {
            receivedAddTaskInput = input;
            return {
              id: 'created',
              title: input.title,
              status: input.props?.status ?? 'inbox',
              createdAt: '2026-01-01',
              updatedAt: '2026-01-01',
            };
          },
          updateTask: async () => ({ id: 't1' }),
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async () => ({ id: 'p1', title: 'Project' }),
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
          deleteProject: async () => ({ id: 'p1', title: 'Project' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area' }),
        }),
    };
    const service = createService({ readonly: false }, deps as any);

    await service.addTask({
      quickAdd: 'Buy milk +Home',
      status: 'next',
      sectionId: 's1',
      tags: [' #weekly '],
      contexts: [' @errands '],
      energyLevel: 'high',
      assignedTo: 'Dana',
    });

    expect(quickAddCalls).toBe(1);
    expect(receivedAddTaskInput.title).toBe('Buy milk');
    expect(receivedAddTaskInput.props.status).toBe('next');
    expect(receivedAddTaskInput.props.projectId).toBe('p1');
    expect(receivedAddTaskInput.props.sectionId).toBe('s1');
    expect(receivedAddTaskInput.props.contexts).toEqual(['@errands']);
    expect(receivedAddTaskInput.props.tags).toEqual(['#weekly']);
    expect(receivedAddTaskInput.props.energyLevel).toBe('high');
    expect(receivedAddTaskInput.props.assignedTo).toBe('Dana');
  });

  test('creates an unknown quick-add project before adding the task', async () => {
    let receivedAddProjectInput: any = null;
    let receivedAddTaskInput: any = null;
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listProjects: () => [],
      parseQuickAdd: () => ({
        title: 'Buy milk',
        props: {},
        projectTitle: 'Errands',
      }),
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addProject: async (input: any) => {
            receivedAddProjectInput = input;
            return {
              id: 'p-new',
              title: input.title,
              status: 'active',
              color: input.color,
              order: 0,
              tagIds: [],
              createdAt: '2026-01-01',
              updatedAt: '2026-01-01',
            };
          },
          addTask: async (input: any) => {
            receivedAddTaskInput = input;
            return {
              id: 't-new',
              title: input.title,
              status: input.props?.status ?? 'inbox',
              projectId: input.props?.projectId,
              createdAt: '2026-01-01',
              updatedAt: '2026-01-01',
            };
          },
        }),
    };
    const service = createService({ readonly: false }, deps as any);

    const task = await service.addTask({ quickAdd: 'Buy milk +Errands' });

    expect(receivedAddProjectInput.title).toBe('Errands');
    expect(receivedAddTaskInput.props.projectId).toBe('p-new');
    expect(task.projectId).toBe('p-new');
  });

  test('retries transient sqlite write conflicts by rerunning the write operation', async () => {
    let runCoreCalls = 0;
    let addTaskCalls = 0;
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [],
      listProjects: () => [],
      listAreas: () => [],
      getTask: () => {
        throw new Error('not used');
      },
      getProject: () => {
        throw new Error('not used');
      },
      parseQuickAdd: () => ({ title: '', props: {} }),
      runCoreService: async (_options: any, fn: any) => {
        runCoreCalls += 1;
        if (runCoreCalls === 1) {
          throw new Error('SQLITE_BUSY: database is locked');
        }
        return fn({
          addTask: async (input: any) => {
            addTaskCalls += 1;
            return {
              id: 'created',
              title: input.title,
              status: input.props?.status ?? 'inbox',
              createdAt: '2026-01-01',
              updatedAt: '2026-01-01',
            };
          },
          updateTask: async () => ({ id: 't1' }),
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async () => ({ id: 'p1', title: 'Project' }),
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
          deleteProject: async () => ({ id: 'p1', title: 'Project' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area' }),
        });
      },
    };
    const service = createService({ readonly: false }, deps as any);

    const task = await service.addTask({ title: 'Retry me' });

    expect(task.title).toBe('Retry me');
    expect(runCoreCalls).toBe(2);
    expect(addTaskCalls).toBe(1);
  });

  test('forwards plain-title addTask metadata fields to core addTask', async () => {
    let receivedAddTaskInput: any = null;
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [],
      listProjects: () => [],
      listAreas: () => [],
      getTask: () => ({ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }),
      getProject: () => ({ id: 'p1', title: 'Project' }),
      getSection: () => ({ id: 's1', projectId: 'p1', title: 'Section', createdAt: '2026-01-01', updatedAt: '2026-01-01' }),
      parseQuickAdd: () => ({ title: '', props: {} }),
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addTask: async (input: any) => {
            receivedAddTaskInput = input;
            return {
              id: 'created',
              title: input.title,
              status: input.props?.status ?? 'inbox',
              createdAt: '2026-01-01',
              updatedAt: '2026-01-01',
            };
          },
          updateTask: async () => ({ id: 't1' }),
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async () => ({ id: 'p1', title: 'Project' }),
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
          deleteProject: async () => ({ id: 'p1', title: 'Project' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area' }),
        }),
    };
    const service = createService({ readonly: false }, deps as any);

    await service.addTask({
      title: 'Plain task',
      projectId: 'p1',
      sectionId: 's1',
      recurrence: 'FREQ=MONTHLY;BYMONTHDAY=10',
      energyLevel: 'medium',
      assignedTo: 'Taylor',
    });

    expect(receivedAddTaskInput.title).toBe('Plain task');
    expect(receivedAddTaskInput.props.projectId).toBe('p1');
    expect(receivedAddTaskInput.props.sectionId).toBe('s1');
    expect(receivedAddTaskInput.props.recurrence).toEqual({
      rule: 'monthly',
      byMonthDay: [10],
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=10',
    });
    expect(receivedAddTaskInput.props.energyLevel).toBe('medium');
    expect(receivedAddTaskInput.props.assignedTo).toBe('Taylor');
  });

  test('maps updateTask inputs and closes shared db handle', async () => {
    let closedDbCount = 0;
    let closedCoreAdapterCount = 0;
    let receivedUpdateInput: any = null;
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => {
        closedDbCount += 1;
      },
      closeCoreAdapter: async () => {
        closedCoreAdapterCount += 1;
      },
      listTasks: () => [],
      listProjects: () => [],
      listAreas: () => [],
      getTask: () => ({ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }),
      getProject: () => ({ id: 'p1', title: 'Project' }),
      parseQuickAdd: () => ({ title: '', props: {} }),
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addTask: async () => ({ id: 't1' }),
          updateTask: async (input: any) => {
            receivedUpdateInput = input;
            return {
              id: input.id,
              title: 'Updated',
              status: 'next',
              createdAt: '2026-01-01',
              updatedAt: '2026-01-02',
            };
          },
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async () => ({ id: 'p1', title: 'Project' }),
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
          deleteProject: async () => ({ id: 'p1', title: 'Project' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area' }),
        }),
    };
    const service = createService({ readonly: false }, deps as any);

    await service.listTasks({});
    await service.updateTask({
      id: 't1',
      status: 'next',
      contexts: [' @desk '],
      tags: [' #weekly '],
      projectId: null,
      dueDate: null,
      startTime: null,
      recurrence: null,
      energyLevel: 'low',
      assignedTo: null,
    } as any);
    await service.close();

    expect(receivedUpdateInput).toBeTruthy();
    expect(receivedUpdateInput.id).toBe('t1');
    expect(receivedUpdateInput.updates.status).toBe('next');
    expect(receivedUpdateInput.updates.contexts).toEqual(['@desk']);
    expect(receivedUpdateInput.updates.tags).toEqual(['#weekly']);
    expect(receivedUpdateInput.updates.projectId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(receivedUpdateInput.updates, 'recurrence')).toBe(true);
    expect(receivedUpdateInput.updates.recurrence).toBeUndefined();
    expect(receivedUpdateInput.updates.energyLevel).toBe('low');
    expect(receivedUpdateInput.updates.assignedTo).toBeUndefined();
    expect(closedDbCount).toBe(1);
    expect(closedCoreAdapterCount).toBe(1);
  });

  test('rejects addTask when token values are blank', async () => {
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [],
      listProjects: () => [],
      listAreas: () => [],
      getTask: () => ({ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }),
      getProject: () => ({ id: 'p1', title: 'Project' }),
      parseQuickAdd: () => ({ title: '', props: {} }),
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addTask: async () => ({ id: 't1' }),
          updateTask: async () => ({ id: 't1' }),
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async () => ({ id: 'p1', title: 'Project' }),
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
          deleteProject: async () => ({ id: 'p1', title: 'Project' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area' }),
        }),
    };
    const service = createService({ readonly: false }, deps as any);

    await expect(service.addTask({ title: 'Task', contexts: ['   '] } as any)).rejects.toThrow(
      'Context values must be non-empty strings'
    );
  });

  test('rejects updateTask when token values exceed max length', async () => {
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [],
      listProjects: () => [],
      listAreas: () => [],
      getTask: () => ({ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }),
      getProject: () => ({ id: 'p1', title: 'Project' }),
      parseQuickAdd: () => ({ title: '', props: {} }),
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addTask: async () => ({ id: 't1' }),
          updateTask: async () => ({ id: 't1' }),
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async () => ({ id: 'p1', title: 'Project' }),
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
          deleteProject: async () => ({ id: 'p1', title: 'Project' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area' }),
        }),
    };
    const service = createService({ readonly: false }, deps as any);
    const longTag = `#${'x'.repeat(500)}`;

    await expect(service.updateTask({ id: 't1', tags: [longTag] } as any)).rejects.toThrow(
      'Tag values must be at most 500 characters'
    );
  });

  test('rejects addTask input when both title and quickAdd are provided', async () => {
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [],
      listProjects: () => [],
      listAreas: () => [],
      getTask: () => ({ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }),
      getProject: () => ({ id: 'p1', title: 'Project' }),
      parseQuickAdd: () => ({ title: '', props: {} }),
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addTask: async () => ({ id: 't1' }),
          updateTask: async () => ({ id: 't1' }),
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async () => ({ id: 'p1', title: 'Project' }),
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
          deleteProject: async () => ({ id: 'p1', title: 'Project' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area' }),
        }),
    };
    const service = createService({ readonly: false }, deps as any);

    await expect(service.addTask({ title: 'Task', quickAdd: 'Task /next' } as any)).rejects.toThrow(
      'Provide either title or quickAdd, not both'
    );
  });

  test('rejects addTask title when length exceeds max bound', async () => {
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [],
      listProjects: () => [],
      listAreas: () => [],
      getTask: () => ({ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }),
      getProject: () => ({ id: 'p1', title: 'Project' }),
      parseQuickAdd: () => ({ title: '', props: {} }),
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addTask: async () => ({ id: 't1' }),
          updateTask: async () => ({ id: 't1' }),
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async () => ({ id: 'p1', title: 'Project' }),
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
          deleteProject: async () => ({ id: 'p1', title: 'Project' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area' }),
        }),
    };
    const service = createService({ readonly: false }, deps as any);
    const longTitle = 'x'.repeat(501);

    await expect(service.addTask({ title: longTitle } as any)).rejects.toThrow(
      'Task title too long (max 500 characters)'
    );
  });

  test('rejects addTask quickAdd when length exceeds max bound', async () => {
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [],
      listProjects: () => [],
      listAreas: () => [],
      getTask: () => ({ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }),
      getProject: () => ({ id: 'p1', title: 'Project' }),
      parseQuickAdd: () => ({ title: '', props: {} }),
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addTask: async () => ({ id: 't1' }),
          updateTask: async () => ({ id: 't1' }),
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async () => ({ id: 'p1', title: 'Project' }),
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
          deleteProject: async () => ({ id: 'p1', title: 'Project' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area' }),
        }),
    };
    const service = createService({ readonly: false }, deps as any);
    const longQuickAdd = `Task ${'x'.repeat(1997)}`;

    await expect(service.addTask({ quickAdd: longQuickAdd } as any)).rejects.toThrow(
      'Quick-add input too long (max 2000 characters)'
    );
  });

  test('delegates project and area writes through core deps', async () => {
    let receivedProjectCreate: any = null;
    let receivedProjectUpdate: any = null;
    let receivedAreaUpdate: any = null;
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [],
      listProjects: () => [],
      listAreas: () => [],
      getTask: () => ({ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }),
      getProject: () => ({ id: 'p1', title: 'Project' }),
      parseQuickAdd: () => ({ title: '', props: {} }),
      runCoreService: async (_options: any, fn: any) =>
        fn({
          addTask: async () => ({ id: 't1' }),
          updateTask: async () => ({ id: 't1' }),
          completeTask: async () => ({ id: 't1' }),
          deleteTask: async () => ({ id: 't1' }),
          restoreTask: async () => ({ id: 't1' }),
          addProject: async (input: any) => {
            receivedProjectCreate = input;
            return { id: 'p1', title: input.title, color: input.color };
          },
          updateProject: async (input: any) => {
            receivedProjectUpdate = input;
            return { id: input.id, title: 'Project', ...input.updates };
          },
          deleteProject: async () => ({ id: 'p1', title: 'Project' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async (input: any) => {
            receivedAreaUpdate = input;
            return { id: input.id, name: 'Updated Area' };
          },
          deleteArea: async () => ({ id: 'a1', name: 'Area' }),
        }),
    };
    const service = createService({ readonly: false }, deps as any);

    await service.addProject({ title: 'Project', areaId: null });
    await service.updateProject({
      id: 'p1',
      color: null,
      areaId: null,
      dueDate: null,
      reviewAt: null,
      supportNotes: null,
    });
    await service.updateArea({ id: 'a1', color: null, icon: 'briefcase' });

    expect(receivedProjectCreate.color).toBeTruthy();
    expect(receivedProjectCreate.props.areaId).toBeUndefined();
    expect(receivedProjectUpdate.updates).toEqual({
      color: undefined,
      areaId: undefined,
      dueDate: undefined,
      reviewAt: undefined,
      supportNotes: undefined,
    });
    expect(receivedAreaUpdate.updates.icon).toBe('briefcase');
    expect(Object.prototype.hasOwnProperty.call(receivedAreaUpdate.updates, 'color')).toBe(true);
    expect(receivedAreaUpdate.updates.color).toBeUndefined();
  });

  // R-08's executable guard for the invariants documented at runCoreWriteWithRetries: every
  // core write flushes before returning, and the retried callback re-reads storage. Together
  // they make a two-write quickAdd capture (addProject then addTask) safe to retry whole.
  //
  // Real database, real core adapter, real parser — only addTask is wrapped, to fail once
  // between the two writes. The project assertion doubles as the harness control: an earlier
  // attempt spread `...queries` into deps and silently swapped in queries.ts's same-named
  // parseQuickAdd (it drops projectTitle), so no project was created at all and the run looked
  // like a persistence bug. If the harness breaks capture again, projects is 0 and this fails.
  //
  // ONE case on purpose: core-adapter holds module-level singletons (coreService/coreQueue),
  // so a second case in this process runs against the previous case's store and reports
  // duplicates that are test-isolation artifacts, not product behaviour.
  test('a retried quickAdd capture leaves one project and one task', async () => {
    const dir = createTempDir();
    writeFileSync(
      join(dir, 'data.json'),
      JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} })
    );

    let addTaskAttempts = 0;
    const deps = {
      ...mcpDb,
      ...mcpQueries,
      closeCoreAdapter,
      // The core parser, NOT queries.ts's narrowing wrapper of the same name.
      parseQuickAdd,
      runCoreService: (options: any, fn: any) => runCoreService(options, (core: any) => fn(
        new Proxy(core, {
          get: (target, prop, receiver) => (prop === 'addTask'
            ? async (input: any) => {
              addTaskAttempts += 1;
              if (addTaskAttempts === 1) throw new Error('SQLITE_BUSY: database is locked');
              return (target as any).addTask(input);
            }
            : Reflect.get(target, prop, receiver)),
        }),
      )),
    };

    const service = createService({ dbPath: join(dir, 'mindwtr.db'), readonly: false }, deps as any);
    try {
      await service.addTask({ quickAdd: 'Ship it +Launch' });

      const projects = await service.listProjects();
      const tasks = await service.listTasks({});
      expect(addTaskAttempts).toBe(2);
      expect(projects.filter((project) => project.title === 'Launch')).toHaveLength(1);
      expect(tasks.filter((task) => task.title === 'Ship it')).toHaveLength(1);
      expect(tasks[0]?.projectId).toBe(projects[0]?.id);
    } finally {
      await service.close();
    }
  }, REAL_SQLITE_TEST_TIMEOUT_MS);

  test('persists write operations to a real sqlite database', async () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'mindwtr.db');
    const dataPath = join(dir, 'data.json');

    writeFileSync(
      dataPath,
      JSON.stringify(
        {
          tasks: [],
          projects: [],
          sections: [],
          areas: [],
          people: [],
          settings: {},
        },
        null,
        2
      )
    );

    const service = createService({ dbPath, readonly: false });
    try {
      const project = await service.addProject({
        title: 'Home',
        status: 'active',
      });

      const task = await service.addTask({
        quickAdd: 'Buy milk +Home @errands #weekly /due:2026-04-20 /next',
        recurrence: 'FREQ=WEEKLY;BYDAY=MO',
      });
      const updatedTask = await service.updateTask({
        id: task.id,
        status: 'waiting',
        contexts: ['@desk'],
        recurrence: {
          rule: 'monthly',
          byMonthDay: [10],
        },
      });
      const person = await service.addPerson({
        name: 'Alex',
        note: 'Design lead',
      });
      const waitingTask = await service.addTask({
        title: 'Waiting on draft',
        status: 'waiting',
        assignedTo: 'Alex',
      });
      const renamedPerson = await service.renamePerson({
        id: person.id,
        name: 'Alexandra',
        updateTasks: true,
      });
      const updatedPerson = await service.updatePerson({
        id: person.id,
        note: null,
        referenceLink: 'https://example.com/alexandra',
      });

      const updatedProject = await service.updateProject({
        id: project.id,
        title: 'Household',
        status: 'waiting',
        supportNotes: 'Track home-related work here.',
      });
      const section = await service.addSection({
        projectId: project.id,
        title: 'Errands',
      });
      const updatedSection = await service.updateSection({
        id: section.id,
        title: 'Home Errands',
        order: 2,
      });
      const deletedSection = await service.deleteSection(section.id);

      const tasks = await service.listTasks({ status: 'all' });
      const projects = await service.listProjects();
      const sections = await service.listSections({ projectId: project.id });
      const people = await service.listPeople();
      const persistedUpdatedTask = await service.getTask({ id: task.id });
      const persistedWaitingTask = await service.getTask({ id: waitingTask.id });
      const persistedPerson = await service.getPerson({ id: person.id });
      const persistedTask = tasks.find((item) => item.id === task.id);
      const persistedProject = projects.find((item) => item.id === project.id);

      expect(updatedTask.status).toBe('waiting');
      expect(updatedTask.contexts).toEqual(['@desk']);
      expect(updatedTask.recurrence).toMatchObject({
        rule: 'monthly',
        seriesId: task.id,
        byMonthDay: [10],
      });
      expect(updatedProject.title).toBe('Household');
      expect(updatedProject.status).toBe('waiting');
      expect(updatedProject.supportNotes).toBe('Track home-related work here.');
      expect(updatedSection.title).toBe('Home Errands');
      expect(updatedSection.order).toBe(2);
      expect(deletedSection.deletedAt).toBeTruthy();
      expect(renamedPerson.name).toBe('Alexandra');
      expect(updatedPerson.note).toBeUndefined();
      expect(updatedPerson.referenceLink).toBe('https://example.com/alexandra');

      expect(persistedTask).toBeTruthy();
      expect(persistedTask?.title).toBe('Buy milk');
      expect(persistedTask?.status).toBe('waiting');
      expect(persistedTask?.projectId).toBe(project.id);
      expect(persistedTask?.dueDate).toContain('2026-04-20');
      expect(persistedTask?.contexts).toEqual(['@desk']);
      expect(persistedTask?.tags).toEqual(['#weekly']);
      expect(persistedUpdatedTask.status).toBe('waiting');
      expect(persistedUpdatedTask.contexts).toEqual(['@desk']);
      expect(persistedUpdatedTask.recurrence).toMatchObject({
        rule: 'monthly',
        seriesId: task.id,
        byMonthDay: [10],
      });
      expect(
        typeof persistedUpdatedTask.recurrence === 'object'
          ? persistedUpdatedTask.recurrence.rrule
          : undefined
      ).toContain(`X-MINDWTR-SERIES-ID=${task.id}`);
      await service.updateTask({ id: task.id, recurrence: null });
      expect((await service.getTask({ id: task.id })).recurrence).toBeUndefined();
      expect(persistedWaitingTask.assignedTo).toBe('Alexandra');

      expect(persistedProject).toBeTruthy();
      expect(persistedProject?.title).toBe('Household');
      expect(persistedProject?.status).toBe('waiting');
      expect(persistedProject?.supportNotes).toBe('Track home-related work here.');
      expect(sections.find((item) => item.id === section.id)).toBeUndefined();
      expect(people).toHaveLength(1);
      expect(persistedPerson.name).toBe('Alexandra');
      expect(persistedPerson.note).toBeUndefined();
      expect(persistedPerson.referenceLink).toBe('https://example.com/alexandra');
    } finally {
      await service.close();
    }
  }, REAL_SQLITE_TEST_TIMEOUT_MS);
});

// core-adapter.ts's ensureActionSucceeded used to map EVERY core store failure to
// NotFoundError, so a plain input-validation problem (a bogus areaId reference, a focus-cap
// hit) reported code 'not_found' instead of 'validation_error' through the local adapter --
// while cloud-service.ts's mapCloudError already reported 'validation_error' for the same kind
// of mistake. These pin the fix: only a genuine "<Entity> not found" lookup miss (or a
// post-mutation findTask miss) is NotFoundError; everything else is ValidationError.
describe('mcp service error taxonomy (local core adapter)', () => {
  const seedRealService = (extraTasks: Record<string, unknown>[] = []) => {
    const dir = createTempDir();
    writeFileSync(
      join(dir, 'data.json'),
      JSON.stringify({
        tasks: extraTasks,
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      }),
    );
    return createService({ dbPath: join(dir, 'mindwtr.db'), readonly: false });
  };

  test('addTask with a bogus areaId is a validation error, not not_found', async () => {
    const service = seedRealService();
    try {
      await expect(service.addTask({ title: 'Task', areaId: 'does-not-exist' }))
        .rejects.toMatchObject({ code: 'validation_error', message: 'Area not found' });
    } finally {
      await service.close();
    }
  }, REAL_SQLITE_TEST_TIMEOUT_MS);

  test('updateTask hitting the focus-task cap is a validation error, not not_found', async () => {
    // Built up through live addTask/updateTask calls on one service session (like the "persists
    // write operations" test above), not a multi-task bootstrap-JSON seed: a bootstrap seed of
    // several already-focused tasks proved unreliable back-to-back with that other real-core-
    // backed test in this same file (core-adapter.ts's module-level store singleton doesn't
    // cleanly rehydrate between two independently-bootstrapped databases in one test process) --
    // a test-isolation quirk, not a bug in the fix under test here.
    // core-adapter.ts's store is a process-wide singleton, so earlier real-core-backed
    // test files can leave focused tasks in the in-memory store that this session still
    // counts toward the cap — and a listTasks-based cleanup can't see them, because SQL
    // reads hit this session's fresh database while store writes validate against the
    // stale memory. Don't assume a clean slate: drive TO the cap by focusing new tasks
    // until one rejects, and assert that first rejection is the validation error.
    const service = seedRealService();
    try {
      let capError: { code?: string; message?: string } | null = null;
      for (let i = 0; i < 6 && capError === null; i += 1) {
        const task = await service.addTask({ title: `t-${i}`, status: 'next' });
        try {
          await service.updateTask({ id: task.id, isFocusedToday: true });
        } catch (error) {
          capError = error as { code?: string; message?: string };
        }
      }
      expect(capError).toMatchObject({ code: 'validation_error', message: 'Focus limit of 3 reached' });
    } finally {
      await service.close();
    }
  }, REAL_SQLITE_TEST_TIMEOUT_MS);

  test('updateTask on a missing id is still not_found (regression pin)', async () => {
    const service = seedRealService();
    try {
      await expect(service.updateTask({ id: 'does-not-exist', title: 'x' }))
        .rejects.toMatchObject({ code: 'not_found', message: 'Task not found' });
    } finally {
      await service.close();
    }
  }, REAL_SQLITE_TEST_TIMEOUT_MS);
});
