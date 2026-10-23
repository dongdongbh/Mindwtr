import { describe, expect, it } from 'vitest';

import {
    countActiveFilterCriteria,
    criteriaFromSelections,
    selectionsFromCriteria,
} from './filter-criteria';

describe('filter-criteria', () => {
    it('splits mixed tokens into contexts and tags and omits empty groups', () => {
        expect(criteriaFromSelections({ tokens: ['@office', '#deep', '@phone'] })).toEqual({
            contexts: ['@office', '@phone'],
            tags: ['#deep'],
        });
        expect(criteriaFromSelections({})).toEqual({});
    });

    it('includes contextMatchMode only when several contexts compete', () => {
        expect(criteriaFromSelections({ tokens: ['@office'], contextMatchMode: 'all' }))
            .not.toHaveProperty('contextMatchMode');
        expect(criteriaFromSelections({ tokens: ['@office', '@phone'], contextMatchMode: 'all' }))
            .toMatchObject({ contextMatchMode: 'all' });
    });

    it('includes tagMatchMode only when several tags compete', () => {
        expect(criteriaFromSelections({ tokens: ['#deep'], tagMatchMode: 'all' }))
            .not.toHaveProperty('tagMatchMode');
        expect(criteriaFromSelections({ tokens: ['#deep', '#quick'], tagMatchMode: 'all' }))
            .toMatchObject({ tagMatchMode: 'all' });
    });

    it('maps the remaining selection groups onto their criteria keys', () => {
        expect(criteriaFromSelections({
            projects: ['p1'],
            locations: ['Office'],
            priorities: ['high'],
            energyLevels: ['low'],
            timeEstimates: ['30min'],
        })).toEqual({
            projects: ['p1'],
            locations: ['Office'],
            priority: ['high'],
            energy: ['low'],
            timeEstimates: ['30min'],
        });
    });

    it('round-trips selections through criteria', () => {
        const selections = {
            tokens: ['@office', '@phone', '#deep', '#quick'],
            excludedTokens: ['@home', '#waiting'],
            projects: ['p1'],
            locations: ['Office'],
            priorities: ['high' as const],
            energyLevels: ['low' as const],
            timeEstimates: ['30min' as const],
            contextMatchMode: 'any' as const,
            tagMatchMode: 'any' as const,
        };
        expect(selectionsFromCriteria(criteriaFromSelections(selections))).toEqual(selections);
    });

    it('splits excluded tokens into excludedContexts and excludedTags', () => {
        expect(criteriaFromSelections({ excludedTokens: ['@home', '#waiting', '@errands'] })).toEqual({
            excludedContexts: ['@home', '@errands'],
            excludedTags: ['#waiting'],
        });
    });

    it('drops an excluded token that is also included (include wins)', () => {
        // criteriaFromSelections keeps both sides verbatim; normalization (used
        // when the criteria is read back) is where include wins.
        const criteria = criteriaFromSelections({ tokens: ['@office'], excludedTokens: ['@office'] });
        expect(selectionsFromCriteria(criteria)).toMatchObject({
            tokens: ['@office'],
            excludedTokens: [],
        });
    });

    it('validates saved criteria when deriving selections', () => {
        const selections = selectionsFromCriteria({
            contexts: ['office'],
            tags: ['deep'],
            priority: ['none', 'high', 'bogus' as never],
            energy: ['low', 'bogus' as never],
            timeEstimates: ['30min', { minutes: 45 } as never],
        });
        // Bare tokens gain their prefix so rebuilding criteria keeps them.
        expect(selections.tokens).toEqual(['@office', '#deep']);
        // 'none' and unknown enum values never reach the pickers.
        expect(selections.priorities).toEqual(['high']);
        expect(selections.energyLevels).toEqual(['low']);
        // Custom estimates have no picker option and are dropped.
        expect(selections.timeEstimates).toEqual(['30min']);
        expect(selections.contextMatchMode).toBe('all');
        expect(selections.tagMatchMode).toBe('all');
    });

    it('round-trips and counts a rolling task date selection', () => {
        const anyDateRange = { preset: 'next_14_days' as const };
        const criteria = criteriaFromSelections({ anyDateRange });
        expect(criteria).toEqual({ anyDateRange });
        expect(selectionsFromCriteria(criteria).anyDateRange).toEqual(anyDateRange);
        expect(countActiveFilterCriteria(criteria)).toBe(1);
        expect(criteriaFromSelections({ anyDateRange: undefined })).toEqual({});
    });

    it('handles absent criteria' , () => {
        expect(selectionsFromCriteria(undefined)).toEqual({
            tokens: [],
            excludedTokens: [],
            projects: [],
            locations: [],
            priorities: [],
            energyLevels: [],
            timeEstimates: [],
            contextMatchMode: 'all',
            tagMatchMode: 'all',
        });
    });

    it('counts one per selected value and one per range or flag', () => {
        expect(countActiveFilterCriteria(undefined)).toBe(0);
        expect(countActiveFilterCriteria({})).toBe(0);
        expect(countActiveFilterCriteria({
            contexts: ['@office', '@phone'],
            tags: ['#deep'],
            projects: ['p1'],
            priority: ['high'],
            energy: ['low'],
            locations: ['Office'],
            timeEstimates: ['30min'],
            dueDateRange: { preset: 'today' },
            startDateRange: { from: '2026-07-01' },
            hasDescription: true,
            isStarred: false,
        })).toBe(12);
    });

    it('counts excluded tokens as active criteria', () => {
        expect(countActiveFilterCriteria({
            contexts: ['@office'],
            excludedContexts: ['@home'],
            excludedTags: ['#waiting', '#blocked'],
        })).toBe(4);
    });
});
