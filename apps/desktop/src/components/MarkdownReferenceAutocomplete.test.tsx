import { act, renderHook } from '@testing-library/react';
import { useTaskStore, type MarkdownToolbarResult, type Task } from '@mindwtr/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMarkdownReferenceAutocomplete } from './MarkdownReferenceAutocomplete';

const buyMilk: Task = {
    id: 'x',
    title: 'Buy milk',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('useMarkdownReferenceAutocomplete', () => {
    afterEach(() => {
        useTaskStore.setState({ _allTasks: [], projects: [], settings: {} });
    });

    it('replaces the auto-paired ]] closer when a suggestion is picked', () => {
        useTaskStore.setState({ _allTasks: [buyMilk], projects: [], settings: {} });
        const onApplyResult = vi.fn<(result: MarkdownToolbarResult) => void>();
        const caret = 'see [[Bu'.length;
        const { result } = renderHook(() => useMarkdownReferenceAutocomplete({
            value: 'see [[Bu]]',
            selection: { start: caret, end: caret },
            textareaRef: { current: document.createElement('textarea') },
            onApplyResult,
        }));

        act(() => result.current.applySuggestion(result.current.suggestions[0]));

        expect(onApplyResult).toHaveBeenCalledWith({
            value: 'see [[task:x|Buy milk]]',
            selection: { start: 23, end: 23 },
        });
    });
});
