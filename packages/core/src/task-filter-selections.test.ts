import { describe, expect, it } from 'vitest';
import {
    taskMatchesFilterSearchQuery,
    taskMatchesFilterSelections,
} from './task-filter-selections';
import type { FilterCriteria, Task } from './types';

const task: Task = {
    contexts: ['@work/deep'],
    createdAt: '2026-05-27T10:00:00.000Z',
    description: 'Draft launch notes',
    energyLevel: 'high',
    id: 'c5290e2c-1b77-4f77-8927-6d187e141891',
    location: 'Office',
    priority: 'urgent',
    status: 'next',
    tags: ['#client/acme'],
    timeEstimate: '30min',
    title: 'Prepare release checklist',
    updatedAt: '2026-05-27T10:00:00.000Z',
};

const matches = (criteria: FilterCriteria, searchQuery = '') => (
    taskMatchesFilterSelections(task, { criteria, searchQuery })
);

describe('taskMatchesFilterSearchQuery', () => {
    it('matches title and description, and lets an empty query through', () => {
        expect(taskMatchesFilterSearchQuery(task, '')).toBe(true);
        expect(taskMatchesFilterSearchQuery(task, '   ')).toBe(true);
        expect(taskMatchesFilterSearchQuery(task, 'release')).toBe(true);
        expect(taskMatchesFilterSearchQuery(task, 'launch notes')).toBe(true);
        expect(taskMatchesFilterSearchQuery(task, 'vacation')).toBe(false);
    });

    it('routes a fielded term through the search parser instead of substring matching', () => {
        expect(taskMatchesFilterSearchQuery(task, 'id:c5290e2c-1b77-4f77-8927-6d187e141891')).toBe(true);
        expect(taskMatchesFilterSearchQuery(task, 'id:6d187e141891')).toBe(true);
        expect(taskMatchesFilterSearchQuery(task, 'id:missing-task-id')).toBe(false);
        expect(taskMatchesFilterSearchQuery(task, 'status:next')).toBe(true);
        expect(taskMatchesFilterSearchQuery(task, 'status:waiting')).toBe(false);
    });
});

describe('taskMatchesFilterSelections', () => {
    it('passes a task no criteria and no search query ask anything of', () => {
        expect(matches({})).toBe(true);
    });

    it('fails the search box before it ever looks at the criteria', () => {
        expect(matches({ priority: ['urgent'] }, 'vacation')).toBe(false);
        expect(matches({ priority: ['urgent'] }, 'release')).toBe(true);
    });

    it('matches contexts and tags by hierarchy prefix, not by substring', () => {
        expect(matches({ contexts: ['@work'] })).toBe(true);
        expect(matches({ contexts: ['@workshop'] })).toBe(false);
        expect(matches({ tags: ['#client'] })).toBe(true);
        expect(matches({ tags: ['#clientele'] })).toBe(false);
    });

    it('subtracts an excluded token even when every include matches', () => {
        expect(matches({ contexts: ['@work'] })).toBe(true);

        expect(matches({ contexts: ['@work'], excludedTags: ['#client'] })).toBe(false);
    });

    it('demands every context by default and any of them in "any" mode', () => {
        expect(matches({ contexts: ['@work', '@home'] })).toBe(false);
        expect(matches({ contexts: ['@work', '@home'], contextMatchMode: 'any' })).toBe(true);
    });

    it('matches a custom time estimate by its coarse bucket', () => {
        const custom = { ...task, timeEstimate: 'custom:150' as const };
        expect(taskMatchesFilterSelections(custom, { criteria: { timeEstimates: ['3hr'] }, searchQuery: '' })).toBe(true);
        expect(taskMatchesFilterSelections(custom, { criteria: { timeEstimates: ['2hr'] }, searchQuery: '' })).toBe(false);
    });

    it('matches priority, energy, time estimate and location together', () => {
        expect(matches({
            energy: ['high'],
            locations: ['off'],
            priority: ['urgent'],
            timeEstimates: ['30min'],
        })).toBe(true);
        expect(matches({
            energy: ['high'],
            locations: ['home'],
            priority: ['urgent'],
            timeEstimates: ['30min'],
        })).toBe(false);
    });
});
