


import { performance } from 'node:perf_hooks';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildEntityMap,
  nameNotifyListener,
  setStorageAdapter,
  useTaskStore,
  type AppData,
  type Area,
  type Project,
  type Section,
  type StorageAdapter,
  type Task,
  type TaskStatus,
  type TaskStore,
} from '@mindwtr/core';


import { beginNotifyProfile, endNotifyProfile } from '../../../packages/core/src/store-notify-profiler';


const TASK_COUNT = 7_000;
const PROJECT_COUNT = 40;
const BASE_ISO = '2026-05-01T09:00:00.000Z';

const status = (index: number): TaskStatus => {
  if (index < 60) return 'next';
  if (index % 23 === 0) return 'reference';
  if (index % 11 === 0) return 'done';
  if (index % 7 === 0) return 'waiting';
  if (index % 5 === 0) return 'inbox';
  return 'next';
};

const areas: Area[] = Array.from({ length: 5 }, (_, index) => ({
  id: `area-${index}`,
  name: `Area ${index}`,
  color: '#2563EB',
  order: index,
  createdAt: BASE_ISO,
  updatedAt: BASE_ISO,
  rev: 1,
  revBy: 'perf-device',
}));

const projects: Project[] = Array.from({ length: PROJECT_COUNT }, (_, index) => ({
  id: `project-${index}`,
  title: `Project ${index}`,
  status: 'active',
  color: '#2563EB',
  order: index,
  tagIds: [],
  areaId: `area-${index % 5}`,
  createdAt: BASE_ISO,
  updatedAt: BASE_ISO,
  rev: 1,
  revBy: 'perf-device',
}));

const sections: Section[] = [];

const tasks: Task[] = Array.from({ length: TASK_COUNT }, (_, index) => {
  const project = projects[index % projects.length];
  const taskStatus = status(index);
  return {
    id: `task-${index}`,
    title: `Synthetic task ${index}`,
    status: taskStatus,
    projectId: project.id,
    areaId: project.areaId,
    contexts: [],
    tags: [],
    isFocusedToday: index < 8 && taskStatus !== 'done' && taskStatus !== 'reference' && taskStatus !== 'archived',
    order: index,
    orderNum: index,
    pushCount: 0,
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    rev: 1,
    revBy: 'perf-device',
  } as Task;
});

const settings: AppData['settings'] = {
  appearance: { showFutureStarts: false },
  ai: { enabled: false },
  deviceId: 'perf-device',
  features: { pomodoro: false, priorities: true, timeEstimates: true },
  gtd: { focusTaskLimit: 10, taskEditor: { hidden: [], order: [] } },
  notifications: { enabled: true, taskReminders: true, dueDateReminders: true, startDateReminders: true },
  savedFilters: [],
} as AppData['settings'];

const appData: AppData = { tasks, projects, sections, areas, people: [], settings };

const seedStore = () => {
  useTaskStore.setState({
    tasks,
    projects,
    sections,
    areas,
    settings,
    isLoading: false,
    error: null,
    editLockCount: 0,
    lastDataChangeAt: 0,
    _allTasks: tasks,
    _allProjects: projects,
    _allSections: sections,
    _allAreas: areas,
    _tasksById: buildEntityMap(tasks),
    _projectsById: buildEntityMap(projects),
    _sectionsById: buildEntityMap(sections),
    _areasById: buildEntityMap(areas),
  } as never);
};

const ROWS_ON_SCREEN = 15;

describe('focused-count row selector does not force a derived-state rebuild', () => {
  beforeAll(() => {
    const storage: StorageAdapter = {
      getData: async () => appData,
      saveData: async () => undefined,
    };
    setStorageAdapter(storage);
    seedStore();
  });

  it('costs zero derived-state rebuilds on a write (fixed selector, swipeable-task-item shape)', async () => {
    seedStore();


    const unsubscribes = Array.from({ length: ROWS_ON_SCREEN }, (_, index) =>
      useTaskStore.subscribe(
        nameNotifyListener(`row-selector-fixed-${index}`, (state: TaskStore) => state.getFocusedCount()),
      ),
    );

    beginNotifyProfile();
    await useTaskStore.getState().updateTask('task-3333', { title: 'row-selector edit (fixed)' });
    const profile = endNotifyProfile();
    unsubscribes.forEach((unsubscribe) => unsubscribe());

    expect(profile?.derivedRebuildCount).toBe(0);
  });

  it('FAILS this same assertion with the old selector shape (state.getDerivedState().focusedCount)', async () => {
    seedStore();


    const unsubscribes = Array.from({ length: ROWS_ON_SCREEN }, (_, index) =>
      useTaskStore.subscribe(
        nameNotifyListener(`row-selector-old-${index}`, (state: TaskStore) => state.getDerivedState().focusedCount),
      ),
    );

    beginNotifyProfile();
    const startedAt = performance.now();
    await useTaskStore.getState().updateTask('task-4444', { title: 'row-selector edit (old)' });
    const elapsedMs = performance.now() - startedAt;
    const profile = endNotifyProfile();
    unsubscribes.forEach((unsubscribe) => unsubscribe());

    console.log(
      `old-selector write: ${elapsedMs.toFixed(2)}ms; derivedRebuildCount=${profile?.derivedRebuildCount} `
      + `derivedRebuildMs=${profile?.derivedRebuildMs.toFixed(2)}`,
    );
    expect(profile?.derivedRebuildCount).toBeGreaterThan(0);
  });
});
