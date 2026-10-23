import { describe, expect, it } from 'vitest';
import { SAVED_FILTER_NO_PROJECT_ID } from '@mindwtr/core';
import type { FilterCriteria, Project } from '@mindwtr/core';

import {
    buildActiveFilterChips,
    buildAdvancedChips,
    buildSelectionChips,
    removeFilterChipFromCriteria,
    type ActiveFilterChipDeps,
} from './active-filter-chips';

const projects: Record<string, Pick<Project, 'title' | 'color' | 'colorOverride' | 'areaId'>> = {
    // A project with no colour of its own stores the empty string, not undefined.
    'p-plain': { title: 'Plain project', color: '' },
    'p-colored': { title: 'Coloured project', color: '#111111' },
    'p-override': { title: 'Override project', color: '#ff0000', colorOverride: '#ff0000', areaId: 'area-1' },
    'p-in-area': { title: 'Area project', color: '#111111', areaId: 'area-1' },
    'p-in-grey-area': { title: 'Grey area project', color: '#111111', areaId: 'area-none' },
};

const deps: ActiveFilterChipDeps = {
    t: (key) => key,
    resolveText: (_key, fallback) => fallback,
    getProject: (projectId) => projects[projectId],
    getAreaColor: (areaId) => (areaId === 'area-1' ? '#area1' : undefined),
    getAreaLabel: (areaId) => `Area ${areaId}`,
};

const ids = (chips: { id: string }[]) => chips.map((chip) => chip.id);

describe('buildSelectionChips', () => {
    it('orders tokens, excluded tokens, projects, priority, energy and time estimates', () => {
        const chips = buildSelectionChips({
            timeEstimates: ['30min'],
            energy: ['low'],
            priority: ['high'],
            projects: ['p-plain'],
            excludedTags: ['#later'],
            excludedContexts: ['@home'],
            tags: ['#deep'],
            contexts: ['@office'],
        }, deps);

        expect(ids(chips)).toEqual([
            'token:@office',
            'token:#deep',
            'excluded-token:@home',
            'excluded-token:#later',
            'project:p-plain',
            'priority:high',
            'energy:low',
            'time:30min',
        ]);
        expect(chips.every((chip) => chip.inactive === undefined)).toBe(true);
        expect(chips[2].excluded).toBe(true);
        expect(chips[0].excluded).toBeUndefined();
    });

    it('labels the no-priority selection and falls back to the raw project id', () => {
        const chips = buildSelectionChips({
            projects: [SAVED_FILTER_NO_PROJECT_ID, 'p-gone'],
            priority: ['none', 'urgent'],
        }, deps);

        expect(chips.map((chip) => chip.label)).toEqual([
            'No project',
            'p-gone',
            'focus.group.noPriority',
            'priority.urgent',
        ]);
    });

    it('uses explicit override, live Area, then only area-less legacy color', () => {
        const chips = buildSelectionChips({
            projects: ['p-override', 'p-in-area', 'p-in-grey-area', 'p-colored', 'p-plain', SAVED_FILTER_NO_PROJECT_ID],
        }, deps);

        expect(chips.map((chip) => chip.dotColor)).toEqual([
            '#ff0000',
            '#area1',
            undefined,
            '#111111',
            undefined,
            undefined,
        ]);
    });

    it('mutes a value the view does not apply and leaves the applied ones alone', () => {
        const criteria: FilterCriteria = {
            contexts: ['@office'],
            tags: ['#deep'],
            priority: ['high'],
            timeEstimates: ['30min'],
        };
        const chips = buildSelectionChips(criteria, deps, {
            appliedCriteria: { tags: ['#deep'] },
        });

        expect(chips.filter((chip) => chip.inactive).map((chip) => chip.id)).toEqual([
            'token:@office',
            'priority:high',
            'time:30min',
        ]);
        expect(chips.find((chip) => chip.id === 'token:#deep')?.inactive).toBeUndefined();
    });

    it('shows a due preset as a plain chip after the projects only when asked', () => {
        const criteria: FilterCriteria = { projects: ['p-plain'], dueDateRange: { preset: 'today' } };

        expect(ids(buildSelectionChips(criteria, deps))).toEqual(['project:p-plain']);
        expect(ids(buildSelectionChips(criteria, deps, { duePresetAsBasic: true }))).toEqual([
            'project:p-plain',
            'dueDateRange',
        ]);
        expect(buildSelectionChips(criteria, deps, { duePresetAsBasic: true })[1].label)
            .toBe('Due date: filters.datePreset.today');
        // A range with no preset is an advanced chip, never this one.
        expect(ids(buildSelectionChips({ dueDateRange: { from: '2026-01-01' } }, deps, { duePresetAsBasic: true })))
            .toEqual([]);
    });

    it('marks priority, energy and time as advanced only when asked', () => {
        const criteria: FilterCriteria = { priority: ['high'], energy: ['low'], timeEstimates: ['1hr'] };

        expect(buildSelectionChips(criteria, deps).every((chip) => chip.isAdvanced === undefined)).toBe(true);
        expect(buildSelectionChips(criteria, deps, { metadataAsAdvanced: true }).every((chip) => chip.isAdvanced))
            .toBe(true);
    });
});

describe('buildAdvancedChips', () => {
    it('prefixes core ids, marks them advanced and carries the area colour', () => {
        const chips = buildAdvancedChips({ areas: ['area-1'], isStarred: true }, deps);

        expect(ids(chips)).toEqual(['advanced:area:area-1', 'advanced:isStarred']);
        expect(chips[0].dotColor).toBe('#area1');
        expect(chips.every((chip) => chip.isAdvanced)).toBe(true);
    });

    it('mutes an advanced chip the view does not apply', () => {
        const criteria: FilterCriteria = { areas: ['area-1'], timeEstimateRange: { min: 30 } };
        const chips = buildAdvancedChips(criteria, deps, { appliedCriteria: { areas: ['area-1'] } });

        expect(chips.find((chip) => chip.id === 'advanced:timeEstimateRange')?.inactive).toBe(true);
        expect(chips.find((chip) => chip.id === 'advanced:area:area-1')?.inactive).toBeUndefined();
    });

    it('leaves the due range out when the selection chips already showed the preset', () => {
        const criteria: FilterCriteria = { dueDateRange: { preset: 'today' } };

        expect(ids(buildAdvancedChips(criteria, deps))).toEqual(['advanced:dueDateRange']);
        expect(ids(buildAdvancedChips(criteria, deps, { duePresetAsBasic: true }))).toEqual([]);
    });
});

describe('removeFilterChipFromCriteria', () => {
    const everything: FilterCriteria = {
        contexts: ['@office', '@phone'],
        tags: ['#deep'],
        excludedContexts: ['@home'],
        excludedTags: ['#later'],
        projects: ['p-plain', SAVED_FILTER_NO_PROJECT_ID],
        priority: ['high', 'none'],
        energy: ['low'],
        timeEstimates: ['30min'],
        areas: ['area-1'],
        statuses: ['next'],
        assignedTo: ['Ada'],
        locations: ['Desk'],
        dueDateRange: { preset: 'today' },
        startDateRange: { from: '2026-01-01' },
        timeEstimateRange: { min: 30 },
        hasDescription: true,
        isStarred: true,
    };

    it('drops every chip it built, and the key with the last value', () => {
        for (const chip of buildActiveFilterChips(everything, deps)) {
            const next = removeFilterChipFromCriteria(everything, chip.id);
            expect(ids(buildActiveFilterChips(next, deps))).not.toContain(chip.id);
        }

        // Last value of a list removed: the key goes with it, or the "filtered"
        // badge stays lit over an empty array.
        expect(removeFilterChipFromCriteria(everything, 'time:30min')).not.toHaveProperty('timeEstimates');
        expect(removeFilterChipFromCriteria(everything, 'token:@office').contexts).toEqual(['@phone']);
    });

    it('removes a Board due preset chip by its bare id', () => {
        expect(removeFilterChipFromCriteria(everything, 'dueDateRange')).not.toHaveProperty('dueDateRange');
    });

    it('returns the same object for an id it does not know', () => {
        expect(removeFilterChipFromCriteria(everything, 'search')).toBe(everything);
        expect(removeFilterChipFromCriteria(everything, 'location:Desk')).toBe(everything);
    });
});
