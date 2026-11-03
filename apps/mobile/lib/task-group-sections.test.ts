import { describe, expect, it } from 'vitest';
import type { Area, Project, Task } from '@mindwtr/core';

import { buildTaskGroupSections, getTaskGroupByLabel, type TaskGroupItem } from './task-group-sections';


const t = (key: string) => key;

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'archived',
  tags: [],
  contexts: [],
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  ...overrides,
} as Task);

const project = (id: string, title: string, overrides: Partial<Project> = {}): Project => ({
  id,
  title,
  status: 'active',
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  ...overrides,
} as Project);

const area = (id: string, name: string, order: number): Area => ({
  id,
  name,
  order,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
} as Area);


const layout = (items: TaskGroupItem[]) => {
  const out: Array<{ section: string; count: number; ids: string[] }> = [];
  items.forEach((item) => {
    if (item.type === 'section') {
      out.push({ section: item.title, count: item.count, ids: [] });
    } else {
      out[out.length - 1]?.ids.push(item.task.id);
    }
  });
  return out;
};

describe('buildTaskGroupSections', () => {
  it('groups by project, ordering projects by order then title, unassigned last', () => {
    const items = buildTaskGroupSections({
      groupBy: 'project',
      tasks: [task('a', { projectId: 'p2' }), task('b'), task('c', { projectId: 'p1' })],
      areas: [],
      projectById: new Map([
        ['p1', project('p1', 'Zebra', { order: 0 })],
        ['p2', project('p2', 'Alpha', { order: 1 })],
      ]),
      t,
    });


    expect(layout(items)).toEqual([
      { section: 'Zebra', count: 1, ids: ['c'] },
      { section: 'Alpha', count: 1, ids: ['a'] },
      { section: 'No project', count: 1, ids: ['b'] },
    ]);
  });

  it('files a task whose project is missing under no-project rather than dropping it', () => {
    const items = buildTaskGroupSections({
      groupBy: 'project',
      tasks: [task('orphan', { projectId: 'deleted-project' })],
      areas: [],
      projectById: new Map(),
      t,
    });

    expect(layout(items)).toEqual([
      { section: 'No project', count: 1, ids: ['orphan'] },
    ]);
  });

  it('lists a multi-tag task under each of its tags', () => {
    const items = buildTaskGroupSections({
      groupBy: 'tag',
      tasks: [task('both', { tags: ['beta', 'alpha'] }), task('none')],
      areas: [],
      projectById: new Map(),
      t,
    });

    expect(layout(items)).toEqual([
      { section: 'alpha', count: 1, ids: ['both'] },
      { section: 'beta', count: 1, ids: ['both'] },
      { section: 'No tags', count: 1, ids: ['none'] },
    ]);
  });

  it('normalizes token memberships while collapsed headers keep the full count', () => {
    const items = buildTaskGroupSections({
      groupBy: 'tag',
      tasks: [
        task('first', { tags: [' #work ', '#deep', '#work', ''] }),
        task('second', { tags: ['#work'] }),
        task('none', { tags: [' ', ''] }),
      ],
      areas: [],
      projectById: new Map(),
      t,
      collapsedGroupIds: new Set(['tag:#work']),
    });

    expect(layout(items)).toEqual([
      { section: '#deep', count: 1, ids: ['first'] },
      { section: '#work', count: 2, ids: [] },
      { section: 'No tags', count: 1, ids: ['none'] },
    ]);
  });


  it('lists a multi-context task under each of its contexts', () => {
    const items = buildTaskGroupSections({
      groupBy: 'context',
      tasks: [task('both', { contexts: ['@office', '@calls'] }), task('none')],
      areas: [],
      projectById: new Map(),
      t,
    });

    expect(layout(items)).toEqual([
      { section: '@calls', count: 1, ids: ['both'] },
      { section: '@office', count: 1, ids: ['both'] },
      { section: 'No context', count: 1, ids: ['none'] },
    ]);
    expect(getTaskGroupByLabel('context', t)).toBe('Context');
  });

  it('groups by area, falling back to the project area and then to General', () => {
    const items = buildTaskGroupSections({
      groupBy: 'area',
      tasks: [
        task('direct', { areaId: 'a1' }),
        task('viaProject', { projectId: 'p1' }),
        task('loose'),
        task('staleArea', { areaId: 'deleted-area' }),
      ],
      areas: [area('a1', 'Work', 0)],
      projectById: new Map([['p1', project('p1', 'Proj', { areaId: 'a1' })]]),
      t,
    });


    expect(layout(items)).toEqual([
      { section: 'Work', count: 2, ids: ['direct', 'viaProject'] },
      { section: 'General', count: 2, ids: ['loose', 'staleArea'] },
    ]);
  });

  it('buckets by completion date against the supplied clock', () => {
    const now = new Date('2026-05-12T12:00:00.000Z');
    const items = buildTaskGroupSections({
      groupBy: 'completedDate',
      tasks: [
        task('today', { completedAt: '2026-05-12T09:00:00.000Z' }),
        task('old', { completedAt: '2026-01-02T09:00:00.000Z' }),
        task('never'),
      ],
      areas: [],
      projectById: new Map(),
      t,
      now,
    });

    const sections = layout(items);
    expect(sections.map((section) => section.section)).toContain('Today');
    expect(sections.find((section) => section.section === 'Today')?.ids).toEqual(['today']);

    expect(sections.find((section) => section.section === 'January 2026')?.ids).toEqual(['old']);
    expect(sections.some((section) => section.section === 'Earlier')).toBe(false);
    expect(sections.find((section) => section.section === 'Not completed')?.ids).toEqual(['never']);
  });

  it('drops empty groups so no header is ever left without rows', () => {
    const items = buildTaskGroupSections({
      groupBy: 'area',
      tasks: [task('only', { areaId: 'a1' })],
      areas: [area('a1', 'Work', 0), area('a2', 'Empty', 1)],
      projectById: new Map(),
      t,
    });

    expect(layout(items).map((section) => section.section)).toEqual(['Work']);
    expect(items.every((item) => item.type !== 'section' || item.count > 0)).toBe(true);
  });

  it('preserves the incoming task order within a group', () => {
    const items = buildTaskGroupSections({
      groupBy: 'area',
      tasks: [task('third'), task('first'), task('second')],
      areas: [],
      projectById: new Map(),
      t,
    });

    expect(layout(items)[0]?.ids).toEqual(['third', 'first', 'second']);
  });

  it('leaves headers plain when no collapsed set is passed', () => {
    const items = buildTaskGroupSections({
      groupBy: 'area',
      tasks: [task('t1', { areaId: 'a1' })],
      areas: [area('a1', 'Work', 0)],
      projectById: new Map(),
      t,
    });

    expect(items[0]).toMatchObject({ type: 'section', title: 'Work' });
    expect(items[0]).not.toHaveProperty('collapsible');
  });

  it('keeps a folded group header and its count while dropping its rows', () => {
    const items = buildTaskGroupSections({
      groupBy: 'area',
      tasks: [
        task('work-1', { areaId: 'a1' }),
        task('work-2', { areaId: 'a1' }),
        task('home-1', { areaId: 'a2' }),
      ],
      areas: [area('a1', 'Work', 0), area('a2', 'Home', 1)],
      projectById: new Map(),
      t,
      collapsedGroupIds: new Set(['a1']),
    });

    expect(layout(items)).toEqual([
      { section: 'Work', count: 2, ids: [] },
      { section: 'Home', count: 1, ids: ['home-1'] },
    ]);

    expect(items.filter((item) => item.type === 'section').map((item) => (
      item.type === 'section' ? [item.title, item.collapsible, item.collapsed] : null
    ))).toEqual([['Work', true, true], ['Home', true, false]]);
  });
});

describe('getTaskGroupByLabel', () => {
  it('labels every axis the group control offers', () => {
    expect(getTaskGroupByLabel('none', t)).toBe('No grouping');
    expect(getTaskGroupByLabel('area', t)).toBe('Area');
    expect(getTaskGroupByLabel('project', t)).toBe('Project');
    expect(getTaskGroupByLabel('tag', t)).toBe('Tags');
    expect(getTaskGroupByLabel('completedDate', t)).toBe('Completion date');
  });
});
