

import { strict as assert } from 'node:assert';
import { buildEntityMap } from '../../packages/core/src/store-helpers';
import { consoleLogger, setLogger } from '../../packages/core/src/logger';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from '../../packages/core/src/store';
import type { AppData, Project, Section, Task } from '../../packages/core/src/types';

const CREATED_AT = '2026-09-08T08:00:00.000Z';
const ARCHIVED_AT = '2026-09-08T09:00:00.000Z';

async function run(size: number, archived: boolean, instrumented: boolean, measureTime = true) {
  const projectCount = Math.min(500, Math.max(40, Math.floor(size / 40)));
  const projects: Project[] = Array.from({ length: projectCount }, (_, index) => ({
    id: `project-${index}`, title: 'Synthetic project', status: archived ? 'archived' : 'active',
    color: '#2563EB', order: index, tagIds: [], createdAt: CREATED_AT,
    updatedAt: archived ? ARCHIVED_AT : CREATED_AT, rev: 2, revBy: 'synthetic-device',
  }));
  const sections: Section[] = projects.flatMap((project) => Array.from({ length: 4 }, (_, index) => ({
    id: `${project.id}-section-${index}`, projectId: project.id, title: 'Synthetic section',
    order: index, createdAt: CREATED_AT, updatedAt: archived ? ARCHIVED_AT : CREATED_AT,
    rev: 2, revBy: 'synthetic-device',
    ...(archived ? { deletedAt: ARCHIVED_AT, projectArchivedAt: ARCHIVED_AT } : {}),
  })));
  const tasks: Task[] = Array.from({ length: size }, (_, index) => ({
    id: `task-${index}`, title: 'Synthetic task', status: archived ? 'archived' : 'waiting',
    projectId: projects[index % projectCount].id,
    sectionId: `${projects[index % projectCount].id}-section-${index % 4}`,
    tags: [], contexts: [], pushCount: 0, createdAt: CREATED_AT,
    updatedAt: archived ? ARCHIVED_AT : CREATED_AT, rev: 2, revBy: 'synthetic-device',
    ...(archived ? { cancelledAt: ARCHIVED_AT, projectArchivedAt: ARCHIVED_AT, statusBeforeProjectArchive: 'next' as const } : {}),
  }));
  const data: AppData = { tasks, projects, sections, areas: [], people: [], settings: {} };
  let sectionMapCalls = 0;
  let sectionMapVisits = 0;
  if (instrumented) {
    Object.defineProperty(sections, 'map', { enumerable: false, value: function (callback: any, context?: any) {
      sectionMapCalls += 1;
      return Array.prototype.map.call(this, (value: Section, index: number, array: Section[]) => {
        sectionMapVisits += 1;
        return callback.call(context, value, index, array);
      });
    } });
  }
  resetForTests();
  let saved: AppData | undefined;
  setStorageAdapter({ getData: async () => data, saveData: async (snapshot) => { saved = snapshot; } });
  useTaskStore.setState({
    tasks, projects, sections, areas: [], people: [], settings: {}, isLoading: false,
    error: null, persistenceFailure: null, _allTasks: tasks, _allProjects: projects,
    _allSections: sections, _allAreas: [], _allPeople: [], _tasksById: buildEntityMap(tasks),
    _projectsById: buildEntityMap(projects), _sectionsById: buildEntityMap(sections),
    _areasById: new Map(), _peopleById: new Map(), lastDataChangeAt: 0,
  });
  const start = measureTime ? performance.now() : 0;
  const pending = useTaskStore.getState().batchMoveTasks(tasks.map(({ id }) => id), 'next');
  const synchronousMs = measureTime ? performance.now() - start : 0;
  const result = await pending;
  const actionMs = measureTime ? performance.now() - start : 0;
  await flushPendingSave();
  assert.equal(result.success, true);
  const final = useTaskStore.getState();
  assert.equal(final._allTasks.length, size);
  assert(final._allTasks.every((task, index) => task.status === 'next' && task.sectionId === tasks[index].sectionId));
  assert(final._allProjects.every((project) => project.status === 'active'));
  assert(final._allSections.every((section) => !section.deletedAt));
  assert(saved && saved.tasks.length === size);
  const resultData = { size, projectCount, sectionCount: sections.length, archived, instrumented,
    sectionMapCalls, sectionMapVisits, synchronousMs: +synchronousMs.toFixed(1), actionMs: +actionMs.toFixed(1),
    assertions: 'status/project/section placement/saved count passed' };
  resetForTests();
  return resultData;
}

setLogger(() => undefined);
try {
  const workCountOnly = process.env.WORKCOUNT_ONLY === '1';
  for (const size of [1_000, 10_000, 50_000]) {
    for (const archived of [false, true]) {
      const result = await run(size, archived, true, !workCountOnly);
      console.log(JSON.stringify(workCountOnly
        ? { size: result.size, sectionCount: result.sectionCount, archived,
            sectionMapCalls: result.sectionMapCalls, sectionMapVisits: result.sectionMapVisits,
            assertions: result.assertions }
        : result));
    }
  }
  if (!workCountOnly) {
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const archived of [false, true]) console.log(JSON.stringify({ attempt, ...await run(50_000, archived, false) }));
    }
  }
} finally { setLogger(consoleLogger); resetForTests(); }
