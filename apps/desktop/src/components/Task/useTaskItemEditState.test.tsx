import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import { useTaskItemEditState } from './useTaskItemEditState';

const baseTask: Task = {
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
};

const renderEditState = (task: Task) => {
    const resetAttachmentState = vi.fn();
    return renderHook(
        ({ currentTask }: { currentTask: Task }) => useTaskItemEditState({
            task: currentTask,
            resetAttachmentState,
        }),
        { initialProps: { currentTask: task } },
    );
};

describe('useTaskItemEditState', () => {
    it('opens saved descriptions in preview mode by default', () => {
        const { result } = renderEditState({
            ...baseTask,
            description: '## Notes',
        });

        expect(result.current.showDescriptionPreview).toBe(true);
    });

    it('keeps empty descriptions in edit mode by default', () => {
        const { result } = renderEditState({
            ...baseTask,
            description: '   ',
        });

        expect(result.current.showDescriptionPreview).toBe(false);
    });

    it('resets the preview mode from the latest saved description', () => {
        const { result, rerender } = renderEditState({
            ...baseTask,
            description: '',
        });

        rerender({
            currentTask: {
                ...baseTask,
                description: '- Updated notes',
            },
        });

        expect(result.current.baselineTask.description).toBe('');

        act(() => {
            result.current.resetEditState();
        });

        expect(result.current.baselineTask.description).toBe('- Updated notes');
        expect(result.current.draft.description).toBe('- Updated notes');
        expect(result.current.showDescriptionPreview).toBe(true);
    });

    it('setField writes through the core reducer, cascades included', () => {
        const { result } = renderEditState({
            ...baseTask,
            isFocusedToday: true,
        });

        act(() => {
            result.current.setField('title', 'Renamed');
            result.current.setField('status', 'inbox');
        });

        expect(result.current.draft.title).toBe('Renamed');
        expect(result.current.draft.status).toBe('inbox');
        // Inbox drops the draft focus star (core cascade).
        expect(result.current.draft.focusedToday).toBe(false);
    });
});
