import { describe, expect, test } from 'bun:test';

import { createService } from './service.js';

describe('mcp service', () => {
  test('delegates read operations through query deps', async () => {
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => undefined,
      listTasks: () => [{ id: 't1', title: 'Task', status: 'inbox', createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
      listProjects: () => [{ id: 'p1', title: 'Project' }],
      listAreas: () => [{ id: 'a1', name: 'Area' }],
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
          deleteProject: async () => ({ id: 'p1', title: 'Project', deletedAt: '2026-01-02' }),
          addArea: async () => ({ id: 'a1', name: 'Area' }),
          updateArea: async () => ({ id: 'a1', name: 'Area' }),
          deleteArea: async () => ({ id: 'a1', name: 'Area', deletedAt: '2026-01-02' }),
        }),
    };
    const service = createService({ readonly: true }, deps as any);

    const tasks = await service.listTasks({});
    const projects = await service.listProjects();
    const areas = await service.listAreas();
    const task = await service.getTask({ id: 't1' });
    const project = await service.getProject({ id: 'p1' });

    expect(tasks).toHaveLength(1);
    expect(projects).toHaveLength(1);
    expect(areas).toHaveLength(1);
    expect(task.id).toBe('t1');
    expect(project.id).toBe('p1');
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
      tags: [' #weekly '],
      contexts: [' @errands '],
    });

    expect(quickAddCalls).toBe(1);
    expect(receivedAddTaskInput.title).toBe('Buy milk');
    expect(receivedAddTaskInput.props.status).toBe('next');
    expect(receivedAddTaskInput.props.projectId).toBe('p1');
    expect(receivedAddTaskInput.props.contexts).toEqual(['@errands']);
    expect(receivedAddTaskInput.props.tags).toEqual(['#weekly']);
  });

  test('maps updateTask inputs and closes shared db handle', async () => {
    let closedDbCount = 0;
    let receivedUpdateInput: any = null;
    const fakeDb = {} as any;
    const deps = {
      openMindwtrDb: async () => ({ db: fakeDb }),
      closeDb: () => {
        closedDbCount += 1;
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
    } as any);
    await service.close();

    expect(receivedUpdateInput).toBeTruthy();
    expect(receivedUpdateInput.id).toBe('t1');
    expect(receivedUpdateInput.updates.status).toBe('next');
    expect(receivedUpdateInput.updates.contexts).toEqual(['@desk']);
    expect(receivedUpdateInput.updates.tags).toEqual(['#weekly']);
    expect(receivedUpdateInput.updates.projectId).toBeUndefined();
    expect(closedDbCount).toBe(1);
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
          updateProject: async () => ({ id: 'p1', title: 'Project' }),
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
    await service.updateArea({ id: 'a1', color: null, icon: 'briefcase' });

    expect(receivedProjectCreate.color).toBeTruthy();
    expect(receivedProjectCreate.props.areaId).toBeUndefined();
    expect(receivedAreaUpdate.updates.icon).toBe('briefcase');
    expect(receivedAreaUpdate.updates.color).toBeUndefined();
  });
});
