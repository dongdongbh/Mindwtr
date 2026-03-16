import { useMemo } from 'react';
import type { Task } from '@mindwtr/core';
import { getFrequentTaskTokens, getUsedTaskTokens } from '@mindwtr/core';
import { QUICK_TOKEN_LIMIT } from './task-edit-modal.utils';
import { MAX_VISIBLE_SUGGESTIONS } from './recurrence-utils';
import { getActiveTokenQuery, parseTokenList } from './task-edit-token-utils';

type UseTaskTokenSuggestionsParams = {
    tasks: Task[];
    editedContexts?: string[];
    editedTags?: string[];
    contextInputDraft: string;
    tagInputDraft: string;
};

export const useTaskTokenSuggestions = ({
    tasks,
    editedContexts,
    editedTags,
    contextInputDraft,
    tagInputDraft,
}: UseTaskTokenSuggestionsParams) => {
    const contextSuggestionPool = useMemo(() => {
        const taskContexts = getUsedTaskTokens(tasks, (item) => item.contexts, { prefix: '@' });
        return Array.from(new Set([...(editedContexts ?? []), ...taskContexts]))
            .filter((item): item is string => Boolean(item?.startsWith('@')));
    }, [editedContexts, tasks]);

    const tagSuggestionPool = useMemo(() => {
        const taskTags = getUsedTaskTokens(tasks, (item) => item.tags, { prefix: '#' });
        return Array.from(new Set([...(editedTags ?? []), ...taskTags]))
            .filter((item): item is string => Boolean(item?.startsWith('#')));
    }, [editedTags, tasks]);

    const contextTokenQuery = useMemo(
        () => getActiveTokenQuery(contextInputDraft, '@'),
        [contextInputDraft]
    );
    const tagTokenQuery = useMemo(
        () => getActiveTokenQuery(tagInputDraft, '#'),
        [tagInputDraft]
    );

    const contextTokenSuggestions = useMemo(() => {
        if (!contextTokenQuery) return [];
        const selected = new Set(parseTokenList(contextInputDraft, '@'));
        return contextSuggestionPool
            .filter((token) => token.slice(1).toLowerCase().includes(contextTokenQuery))
            .filter((token) => !selected.has(token))
            .slice(0, MAX_VISIBLE_SUGGESTIONS);
    }, [contextInputDraft, contextSuggestionPool, contextTokenQuery]);

    const tagTokenSuggestions = useMemo(() => {
        if (!tagTokenQuery) return [];
        const selected = new Set(parseTokenList(tagInputDraft, '#'));
        return tagSuggestionPool
            .filter((token) => token.slice(1).toLowerCase().includes(tagTokenQuery))
            .filter((token) => !selected.has(token))
            .slice(0, MAX_VISIBLE_SUGGESTIONS);
    }, [tagInputDraft, tagSuggestionPool, tagTokenQuery]);

    const frequentContextSuggestions = useMemo(
        () => getFrequentTaskTokens(tasks, (item) => item.contexts, QUICK_TOKEN_LIMIT, { prefix: '@' }),
        [tasks]
    );

    const frequentTagSuggestions = useMemo(() => {
        return getFrequentTaskTokens(tasks, (item) => item.tags, QUICK_TOKEN_LIMIT, { prefix: '#' });
    }, [tasks]);

    const selectedContextTokens = useMemo(
        () => new Set(parseTokenList(contextInputDraft, '@')),
        [contextInputDraft]
    );
    const selectedTagTokens = useMemo(
        () => new Set(parseTokenList(tagInputDraft, '#')),
        [tagInputDraft]
    );

    return {
        contextSuggestionPool,
        tagSuggestionPool,
        contextTokenQuery,
        tagTokenQuery,
        contextTokenSuggestions,
        tagTokenSuggestions,
        frequentContextSuggestions,
        frequentTagSuggestions,
        selectedContextTokens,
        selectedTagTokens,
    };
};
