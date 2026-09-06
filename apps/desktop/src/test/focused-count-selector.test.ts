import { performance } from 'node:perf_hooks';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

// Not re-exported from the core barrel; the relative path resolves to the same
// module instance store.ts instruments, so the profile is the real one
// (matches the mobile focused-count guard).
import { beginNotifyProfile, endNotifyProfile } from '../../../../packages/core/src/store-notify-profiler';
import { selectTaskItemStoreState } from '../components/Task/useTaskItemStoreState';

// Ported from apps/mobile/tests/focused-count-selector.test.ts,
// trimmed to what this guard needs. Transcribed rather than imported:
// importing a .test.tsx module re-runs its whole suite inside this one.
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
  });

  it('costs zero derived-state rebuilds on a write (real desktop hot-path selector)', async () => {
    seedStore();
    // Exercise the same selector the hook uses, with a project prop and closed
    // editor/menu, as StoreTaskItem does for each visible row.
    const unsubscribes = Array.from({ length: ROWS_ON_SCREEN }, (_, index) =>
      useTaskStore.subscribe(nameNotifyListener(
        `row-selector-fixed-${index}`,
        selectTaskItemStoreState({
          task: tasks[index],
          propProject: projects[index % projects.length],
          isEditing: false,
          hasQuickActionMenu: false,
        }),
      )),
    );

    beginNotifyProfile();
    let profile: ReturnType<typeof endNotifyProfile>;
    try {
      await useTaskStore.getState().updateTask('task-3333', { title: 'row-selector edit (fixed)' });
    } finally {
      profile = endNotifyProfile();
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    }

    console.log(`fixed-selector write: derivedRebuildCount=${profile?.derivedRebuildCount}`);
    expect(profile?.derivedRebuildCount).toBe(0);
  });

  it('rebuilds with the old selector shape (state.getDerivedState().focusedCount)', async () => {
    seedStore();
    // Keep the old read verbatim to prove the profiler detects the regression.
    const unsubscribes = Array.from({ length: ROWS_ON_SCREEN }, (_, index) =>
      useTaskStore.subscribe(
        nameNotifyListener(`row-selector-old-${index}`, (state: TaskStore) => state.getDerivedState().focusedCount),
      ),
    );

    beginNotifyProfile();
    const startedAt = performance.now();
    let profile: ReturnType<typeof endNotifyProfile>;
    try {
      await useTaskStore.getState().updateTask('task-4444', { title: 'row-selector edit (old)' });
    } finally {
      profile = endNotifyProfile();
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    }
    const elapsedMs = performance.now() - startedAt;

    console.log(
      `old-selector write: ${elapsedMs.toFixed(2)}ms; derivedRebuildCount=${profile?.derivedRebuildCount} `
      + `derivedRebuildMs=${profile?.derivedRebuildMs.toFixed(2)}`,
    );
    expect(profile?.derivedRebuildCount).toBeGreaterThan(0);
  });

  it('skips derived-state reads and preserves empty sentinel identities on the hot path', () => {
    seedStore();
    const state = useTaskStore.getState();
    const getDerivedState = vi.fn(state.getDerivedState);
    const selector = selectTaskItemStoreState({
      task: tasks[0], propProject: projects[0], isEditing: false, hasQuickActionMenu: false,
    });
    const first = selector({ ...state, getDerivedState });
    const second = selector({ ...state, getDerivedState });

    expect(getDerivedState).not.toHaveBeenCalled();
    expect(first.focusedCount).toBe(8);
    expect(first.project).toBe(projects[0]);
    expect(second.projects).toBe(first.projects);
    expect(second.sections).toBe(first.sections);
    expect(second.areas).toBe(first.areas);
    expect(second.projectMap).toBe(first.projectMap);
    expect(second.activeTasksByStatus).toBe(first.activeTasksByStatus);
    expect(second.sequentialProjectIds).toBe(first.sequentialProjectIds);
    expect(second.sequentialWithinSectionProjectIds).toBe(first.sequentialWithinSectionProjectIds);
  });

  it('uses the derived project map for the fallback and the full map for mutation', () => {
    seedStore();
    const state = useTaskStore.getState();
    const getDerivedState = vi.fn(state.getDerivedState);
    // Give the selector distinct map inputs so substituting the full mutation
    // map for derived.projectMap cannot silently pass this guard.
    const mutationProject = { ...projects[0], title: 'Mutation snapshot' };
    const hiddenProject = { ...projects[0], id: 'hidden-project' };
    const selectorState = {
      ...state,
      getDerivedState,
      _projectsById: new Map(state._projectsById)
        .set(mutationProject.id, mutationProject)
        .set(hiddenProject.id, hiddenProject),
    };
    const selected = selectTaskItemStoreState({ task: tasks[0], isEditing: false })(selectorState);

    expect(getDerivedState).toHaveBeenCalledOnce();
    expect(selected.project).toBe(state.getDerivedState().projectMap.get(tasks[0].projectId!));
    expect(selected.project).toBe(projects[0]);
    expect(selected.mutationProject).toBe(mutationProject);
    const hidden = selectTaskItemStoreState({
      task: { ...tasks[0], projectId: hiddenProject.id }, isEditing: false,
    })(selectorState);
    expect(hidden.project).toBeUndefined();
    expect(hidden.mutationProject).toBe(hiddenProject);
  });

  it('keeps quick-action maps and editing picker identities', () => {
    seedStore();
    const state = useTaskStore.getState();
    const derived = state.getDerivedState();
    const getDerivedState = vi.fn(state.getDerivedState);
    const selected = selectTaskItemStoreState({
      task: tasks[0], propProject: projects[0], isEditing: true, hasQuickActionMenu: true,
    })({ ...state, getDerivedState });

    expect(getDerivedState).toHaveBeenCalledOnce();
    expect(selected.projects).toBe(state.projects);
    expect(selected.sections).toBe(state.sections);
    expect(selected.areas).toBe(state.areas);
    expect(selected.projectMap).toBe(derived.projectMap);
    expect(selected.activeTasksByStatus).toBe(derived.activeTasksByStatus);
    expect(selected.sequentialProjectIds).toBe(derived.sequentialProjectIds);
    expect(selected.sequentialWithinSectionProjectIds).toBe(derived.sequentialWithinSectionProjectIds);
  });
});
