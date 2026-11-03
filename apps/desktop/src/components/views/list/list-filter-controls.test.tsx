import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useListFilterControls } from './list-filter-controls';
import { useUiStore } from '../../../store/ui-store';

const criteria = () => useUiStore.getState().listFilters.criteria;

describe('useListFilterControls', () => {
    beforeEach(() => {
        useUiStore.getState().resetListFilters();
    });

    it('cycles a context chip neutral → included → excluded → neutral', () => {
        const { result } = renderHook(() => useListFilterControls());

        act(() => result.current.toggleToken('@computer'));
        expect(criteria().contexts).toEqual(['@computer']);
        expect(criteria().excludedContexts).toBeUndefined();
        expect(result.current.selectedTokens).toEqual(['@computer']);
        expect(result.current.excludedTokens).toEqual([]);

        act(() => result.current.toggleToken('@computer'));
        expect(criteria().excludedContexts).toEqual(['@computer']);
        expect(result.current.selectedTokens).toEqual([]);
        expect(result.current.excludedTokens).toEqual(['@computer']);

        act(() => result.current.toggleToken('@computer'));
        expect(result.current.selectedTokens).toEqual([]);
        expect(result.current.excludedTokens).toEqual([]);
    });

    it('drops the emptied key instead of leaving an empty array behind', () => {


        const { result } = renderHook(() => useListFilterControls());

        act(() => result.current.toggleToken('@computer'));
        act(() => result.current.toggleToken('@computer'));
        expect(criteria()).not.toHaveProperty('contexts');

        act(() => result.current.toggleToken('@computer'));
        expect(criteria()).not.toHaveProperty('excludedContexts');
        expect(criteria()).not.toHaveProperty('contexts');
    });

    it('routes tags to the excluded tag list and never holds a token on both sides', () => {
        const { result } = renderHook(() => useListFilterControls());

        act(() => result.current.toggleToken('#errand'));
        act(() => result.current.toggleToken('#errand'));

        expect(criteria().excludedTags).toEqual(['#errand']);
        expect(criteria()).not.toHaveProperty('tags');
        expect(criteria()).not.toHaveProperty('excludedContexts');
    });

    it('keeps other tokens on their own side while one cycles', () => {
        const { result } = renderHook(() => useListFilterControls());

        act(() => result.current.toggleToken('@home'));
        act(() => result.current.toggleToken('@computer'));
        act(() => result.current.toggleToken('@computer'));

        expect(criteria().contexts).toEqual(['@home']);
        expect(criteria().excludedContexts).toEqual(['@computer']);
    });
});
