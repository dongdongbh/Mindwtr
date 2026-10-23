import { describe, expect, it } from 'vitest';
import {
    CONTEXTS_NO_CONTEXT_TOKEN as NONE,
    buildContextsViewFilterSections,
    getContextsChipLabels,
    selectContextsToken,
    toggleContextsNoContext,
    toggleContextsToken,
} from './contexts-view-model';

// #1427: a plain chip press switches to that chip; the additive gesture still toggles.
describe('selectContextsToken', () => {
    it('clears the selection when the chip was the only one selected', () => {
        expect(selectContextsToken(['@home'], '@home')).toEqual([]);
        expect(selectContextsToken([NONE], NONE)).toEqual([]);
    });

    it('switches to the chip alone otherwise', () => {
        expect(selectContextsToken([], '@home')).toEqual(['@home']);
        expect(selectContextsToken(['@work'], '@home')).toEqual(['@home']);
        expect(selectContextsToken(['@home', '#a'], '@home')).toEqual(['@home']);
        expect(selectContextsToken(['@home', '#a'], '#b')).toEqual(['#b']);
    });

    it('keeps No context exclusive', () => {
        expect(selectContextsToken([NONE], '@home')).toEqual(['@home']);
        expect(selectContextsToken(['@home', '#a'], NONE)).toEqual([NONE]);
        expect(selectContextsToken([], NONE)).toEqual([NONE]);
    });

    it('leaves the additive toggle unchanged', () => {
        expect(toggleContextsToken(['@work'], '@home')).toEqual(['@work', '@home']);
        expect(toggleContextsToken(['@work', '@home'], '@home')).toEqual(['@work']);
        expect(toggleContextsToken([NONE], '@home')).toEqual(['@home']);
        expect(toggleContextsNoContext(['@home'])).toEqual([NONE]);
        expect(toggleContextsNoContext([NONE])).toEqual([]);
    });
});

// #1428: a nested chip that follows its parent chip shows only its last part.
describe('getContextsChipLabels', () => {
    const labels = (tokens: string[]) => getContextsChipLabels(tokens).map(({ label }) => label);

    it('shortens children that follow their parent and keeps other chips full', () => {
        expect(getContextsChipLabels(['@person', '@person/emma', '@person/todd', '@place/bank'])).toEqual([
            { label: '@person', depth: 0 },
            { label: '/emma', depth: 1 },
            { label: '/todd', depth: 1 },
            { label: '@place/bank', depth: 0 },
        ]);
    });

    it('nests deeper levels and returns to a shallower parent', () => {
        expect(getContextsChipLabels(['@place', '@place/us', '@place/us/vermont', '@place/zz'])).toEqual([
            { label: '@place', depth: 0 },
            { label: '/us', depth: 1 },
            { label: '/vermont', depth: 2 },
            { label: '/zz', depth: 1 },
        ]);
    });

    it('shows full tokens when the parent chip is not shown', () => {
        const sections = buildContextsViewFilterSections({
            contextTokens: ['@person', '@person/todd', '@place', '@place/us', '@place/us/vermont'],
            searchQuery: 'o',
            tagTokens: [],
        });
        expect(sections[0].tokens).toEqual(['@person', '@person/todd', '@place/us/vermont']);
        expect(labels(sections[0].tokens)).toEqual(['@person', '/todd', '@place/us/vermont']);
        expect(labels(['@person/todd'])).toEqual(['@person/todd']);
        // A grandparent alone is not the parent.
        expect(labels(['@place', '@place/us/vermont', '@place/us/vermont/barn'])).toEqual(['@place', '@place/us/vermont', '/barn']);
    });

    it('does not treat a shared prefix without "/" as a parent', () => {
        expect(labels(['@home', '@homework', '@homework/math'])).toEqual(['@home', '@homework', '/math']);
        expect(labels(['@a', '@a/'])).toEqual(['@a', '@a/']);
    });

    it('applies to tags', () => {
        expect(labels(['#errand', '#errand/bank', '#errand/post', '#work'])).toEqual(['#errand', '/bank', '/post', '#work']);
    });
});
