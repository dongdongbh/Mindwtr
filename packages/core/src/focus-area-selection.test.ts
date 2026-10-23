import { describe, expect, it } from 'vitest';
import { buildFocusControlsModel, DEFAULT_FOCUS_CONTROL_STATE, getFocusHiddenByAreaLabel } from './focus-controls';
import { buildFocusPools, buildFocusTaskSections } from './focus-sections';
import { isTaskCountedAsFocused } from './store-helpers';
import type { AppSettings, Area, Project, Task } from './types';

const now = new Date('2026-10-20T12:00:00');
const stamp = '2026-10-01T12:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: id, status: 'next',
    tags: [], contexts: [], isFocusedToday: true, createdAt: stamp, updatedAt: stamp, ...extra });
const areas: Area[] = ['work', 'home'].map((id, order) => ({ id, name: id, order, createdAt: stamp, updatedAt: stamp }));
const projects: Project[] = [{ id: 'p', title: 'project', status: 'active', order: 0, color: '#123456',
    tagIds: [], areaId: 'work', createdAt: stamp, updatedAt: stamp }];
const tasks = [task('direct', { areaId: 'work' }), task('inherited', { projectId: 'p' }),
    task('home', { areaId: 'home' }), task('unassigned'),
    task('future', { areaId: 'home', startTime: '2026-10-23' }),
    task('done', { areaId: 'home', status: 'done' }), task('deleted', { areaId: 'home', deletedAt: stamp }),
    task('candidate', { areaId: 'work', isFocusedToday: false })];
const model = (filters: AppSettings['filters'], state = DEFAULT_FOCUS_CONTROL_STATE) => buildFocusControlsModel({
    state, tasks, projects, areas, sections: [], settings: { filters }, now, t: (key) => key,
});

describe('Focus area selection', () => {
    it('does not confuse a parked project with an area exclusion or drop its existing star', () => {
        const result = buildFocusControlsModel({ state: DEFAULT_FOCUS_CONTROL_STATE,
            tasks: [task('parked', { projectId: 'p' })], projects: [{ ...projects[0], status: 'someday' }],
            areas, sections: [], settings: {}, now, t: (key) => key });
        expect(result.selection).toEqual({ globalCount: 1, hiddenByAreaCount: 0 });
        expect(result.lists.focusedTasks.map((row) => row.id)).toEqual(['parked']);
    });

    it.each([
        [{ areaIds: ['work'] }, ['direct', 'inherited'], 2],
        [{ areaIds: ['work', 'home'] }, ['direct', 'inherited', 'home'], 1],
        [{ excludedAreaIds: ['home'] }, ['direct', 'inherited', 'unassigned'], 1],
        [{}, ['direct', 'inherited', 'home', 'unassigned'], 0],
    ] as const)('uses direct and project area membership: %j', (filters, ids, hidden) => {
        const result = model(filters as AppSettings['filters']);
        expect(result.lists.focusedTasks.map((row) => row.id)).toEqual(ids);
        expect(result.selection).toEqual({ globalCount: 4, hiddenByAreaCount: hidden });
        expect(result.selection.globalCount).toBe(tasks.filter((row) => isTaskCountedAsFocused(row, now)).length);
        expect(result.globalFocusedTasks.map((row) => row.id)).toEqual(['direct', 'inherited', 'home', 'unassigned']);
    });

    it('does not attribute search or saved criteria to other areas, and keeps the occupied section', () => {
        const visibleTasks = [tasks[0], tasks[1], tasks[7]];
        const pools = buildFocusPools({ tasks, visibleTasks, projects, now,
            criteria: { contexts: ['@absent'] }, keep: () => false });
        expect(pools.focused).toEqual([]);
        expect(pools.selection).toEqual({ globalCount: 4, hiddenByAreaCount: 2 });
        const filtered = model({ areaIds: ['work'] }, { ...DEFAULT_FOCUS_CONTROL_STATE,
            preservedCriteria: { hasDescription: true } });
        expect(filtered.lists.focusedTasks).toEqual([]);
        expect(filtered.empty).toBeNull();
        expect(buildFocusTaskSections(filtered.lists, () => undefined, filtered.selection.globalCount)[0])
            .toMatchObject({ key: 'focus', items: [] });
        expect(getFocusHiddenByAreaLabel(filtered.selection, (key) => key)).toBe('2 selected in other areas');
        const all = model({});
        expect(getFocusHiddenByAreaLabel(all.selection, (key) => key)).toBeNull();
    });
});
