import { describe, expect, it } from 'vitest';
import { buildContextsFilterModel, CONTEXTS_FILTER_STATUSES, getContextsSaveCriteria, selectContextsFilterTasks } from './contexts-filter';
import { countActiveFilterCriteria, criteriaFromSelections, selectionsFromCriteria } from './filter-criteria';
import { applyListFilterEdit, EMPTY_LIST_FILTER_STATE, resolveListFilterState } from './list-filter-state';
import { applyFilter, normalizeFilterCriteria, SAVED_FILTER_NO_PROJECT_ID } from './saved-filters';
import { buildWidgetPayload } from './widget-payload';
import type { AppData, FilterCriteria, Project, SavedFilter, Task, TaskStatus } from './types';

const stamp = '2026-10-31T12:00:00.000Z';
const task = (id: string, status: TaskStatus = 'next', patch: Partial<Task> = {}): Task => ({
    id, title: id, status, contexts: ['@person/emma'], tags: [], createdAt: stamp, updatedAt: stamp, ...patch,
});
const project = (id: string, patch: Partial<Project> = {}): Project => ({ id, title: id, status: 'active', color: '#111111', order: 0, tagIds: [],
    createdAt: stamp, updatedAt: stamp, ...patch });
const visibility = { priority: true, location: true, energyLevel: true, timeEstimate: true };

describe('Context filters', () => {
    it('subtracts stable project IDs, including conflicts and No project, without requiring inclusions', () => {
        const tasks = [task('p1', 'next', { projectId: 'p1' }), task('p2', 'next', { projectId: 'p2' }), task('none')];
        expect(applyFilter(tasks, { excludedProjects: ['p1'] }).map((row) => row.id)).toEqual(['p2', 'none']);
        expect(applyFilter(tasks, { projects: ['p1', 'p2'], excludedProjects: ['p1'] }).map((row) => row.id)).toEqual(['p2']);
        expect(applyFilter(tasks, { projects: ['p1'], excludedProjects: ['p1'] })).toEqual([]);
        expect(applyFilter(tasks, { excludedProjects: [SAVED_FILTER_NO_PROJECT_ID] }).map((row) => row.id)).toEqual(['p1', 'p2']);
        const raw = { excludedProjects: [' p1 ', 'p1', '', 1], statuses: ['next', 'someday', 'next'] };
        const normalized = normalizeFilterCriteria(raw);
        expect(normalized).toEqual({ excludedProjects: ['p1'], statuses: ['next', 'someday'] });
        expect(normalizeFilterCriteria(normalized)).toEqual(normalized);
        expect(normalizeFilterCriteria({ contexts: ['@person/emma'] })).not.toHaveProperty('excludedProjects');
    });

    it('keeps exclusions/statuses in selections, counts and independently removable chips', () => {
        const criteria: FilterCriteria = { excludedProjects: ['p1'], statuses: ['next', 'someday'] };
        expect(criteriaFromSelections(selectionsFromCriteria(criteria))).toEqual(criteria);
        expect(countActiveFilterCriteria(criteria)).toBe(3);
        const included = applyListFilterEdit(EMPTY_LIST_FILTER_STATE, { type: 'cycleProject', value: 'p1' });
        const excluded = applyListFilterEdit(included, { type: 'cycleProject', value: 'p1' });
        expect(excluded.projects).toEqual([]);
        expect(excluded.excludedProjects).toEqual(['p1']);
        expect(applyListFilterEdit(excluded, { type: 'cycleProject', value: 'p1' }).excludedProjects).toEqual([]);
        const resolved = resolveListFilterState({ ...excluded, statuses: ['next', 'someday'] }, { visibility, t: (key) => key, getProjectLabel: () => 'Renamed' });
        expect(resolved.chips[0]).toMatchObject({ label: 'Renamed', excluded: true, edit: { type: 'removeProject', value: 'p1' } });
        const cleared = applyListFilterEdit(resolved.state, resolved.chips[0].edit);
        expect(cleared.excludedProjects).toEqual([]);
        expect(cleared.statuses).toEqual(['next', 'someday']);
    });

    it('selects Someday before matching contexts and keeps an empty result empty', () => {
        const tasks = [...CONTEXTS_FILTER_STATUSES, 'reference', 'done', 'archived'].map((status) => task(status, status as TaskStatus));
        const criteria: FilterCriteria = { contexts: ['@person'], statuses: ['waiting', 'someday'] };
        expect(selectContextsFilterTasks(tasks, criteria, []).map((row) => row.id)).toEqual(['waiting', 'someday']);
        expect(selectContextsFilterTasks(tasks, { ...criteria, excludedProjects: [SAVED_FILTER_NO_PROJECT_ID] }, [])).toEqual([]);
        expect(selectContextsFilterTasks(tasks, {}, []).map((row) => row.id)).toContain('reference');
        expect(selectContextsFilterTasks(tasks, {}, []).map((row) => row.id)).not.toContain('done');
    });

    it('saves only a representable unfinished scope and preserves future criteria through edits', () => {
        expect(getContextsSaveCriteria({}, ['@person/emma'], 'all')).toBeNull();
        expect(getContextsSaveCriteria({ statuses: ['next', 'reference'] }, ['@person/emma'], 'all')).toBeNull();
        expect(getContextsSaveCriteria({ statuses: ['next'] }, ['@person', '#work'], 'any')).toBeNull();
        expect(getContextsSaveCriteria({ statuses: ['next'] }, ['__no_context__'], 'all')).toBeNull();
        expect(getContextsSaveCriteria({ statuses: ['next'] }, ['@person/emma'], 'all', ['needle', ''])).toBeNull();
        expect(getContextsSaveCriteria({ statuses: ['next'] }, ['@person/emma'], 'all', ['', 'needle'])).toBeNull();
        const full = { statuses: ['next', 'someday'], excludedProjects: ['p1'], futureCriterion: { enabled: true } };
        const saved: SavedFilter = { id: 'emma', name: 'Emma', view: 'contexts', criteria: full as FilterCriteria, createdAt: stamp, updatedAt: stamp };
        const model = buildContextsFilterModel({ tasks: [task('next'), task('someday', 'someday')], projects: [project('p1')], settings: { savedFilters: [saved] },
            filters: EMPTY_LIST_FILTER_STATE, savedFilterId: saved.id, edit: { type: 'cycleProject', value: 'p2' }, t: (key) => key });
        expect(model.criteria).toMatchObject({ statuses: ['next', 'someday'], excludedProjects: ['p1'], projects: ['p2'], futureCriterion: { enabled: true } });
        expect(getContextsSaveCriteria(model.criteria, [], 'all')).toMatchObject({ futureCriterion: { enabled: true } });
    });

    it('reopens the same Context criteria in a widget and retains legacy Next-view narrowing', () => {
        const criteria: FilterCriteria = { contexts: ['@person/emma'], excludedProjects: ['p1'], statuses: ['next', 'someday'] };
        const filter: SavedFilter = { id: 'emma', name: 'Emma', view: 'contexts', criteria, createdAt: stamp, updatedAt: stamp };
        const tasks = [task('kept'), task('later', 'someday'), task('excluded', 'next', { projectId: 'p1' }),
            task('parked', 'someday', { projectId: 'parked' }), task('other', 'next', { contexts: ['@home'] }), task('reference', 'reference')];
        const data: AppData = { tasks, projects: [project('p1'), project('parked', { status: 'someday' })], areas: [], sections: [], settings: { savedFilters: [filter] } };
        const json = JSON.parse(JSON.stringify(data));
        const payload = buildWidgetPayload(json, 'en', { listIds: ['filter:emma'], maxItems: 200 });
        expect(payload.lists?.['filter:emma'].items.map((item) => item.id)).toEqual(['kept', 'later']);
        data.settings.savedFilters = [{ ...filter, view: 'next' }];
        expect(buildWidgetPayload(data, 'en', { listIds: ['filter:emma'], maxItems: 200 }).lists?.['filter:emma'].items.map((item) => item.id)).toEqual(['kept']);
        data.settings.savedFilters = [{ ...filter, criteria: { ...criteria, projects: ['p1'] } }];
        expect(buildWidgetPayload(data, 'en', { listIds: ['filter:emma'], maxItems: 200 }).lists?.['filter:emma'].items).toEqual([]);
    });
});
