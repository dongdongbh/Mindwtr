import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Task } from '@mindwtr/core';

import {
    TaskItemFieldRenderer,
    type TaskItemFieldRendererData,
    type TaskItemFieldRendererHandlers,
} from './TaskItemFieldRenderer';

const baseTask: Task = {
    id: 'task-1',
    title: 'Test task',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: '2026-04-13T00:00:00.000Z',
    updatedAt: '2026-04-13T00:00:00.000Z',
};

const t = (key: string) => {
    const labels: Record<string, string> = {
        'common.clear': 'Clear',
        'taskEdit.startDateLabel': 'Start Date',
        'taskEdit.dueDateLabel': 'Due Date',
        'taskEdit.reviewDateLabel': 'Review Date',
        'task.aria.startDate': 'Start date',
        'task.aria.startTime': 'Start time',
        'task.aria.dueDate': 'Due date',
        'task.aria.dueTime': 'Due time',
        'task.aria.reviewDate': 'Review date',
        'task.aria.reviewTime': 'Review time',
    };
    return labels[key] ?? key;
};

const createData = (overrides: Partial<TaskItemFieldRendererData> = {}): TaskItemFieldRendererData => ({
    t,
    task: baseTask,
    taskId: baseTask.id,
    showDescriptionPreview: false,
    editDescription: '',
    attachmentError: null,
    visibleEditAttachments: [],
    editStartTime: '',
    editDueDate: '',
    editReviewAt: '',
    editStatus: 'inbox',
    editPriority: '',
    editEnergyLevel: '',
    editAssignedTo: '',
    editRecurrence: '',
    editRecurrenceStrategy: 'strict',
    editRecurrenceRRule: '',
    monthlyRecurrence: { pattern: 'date', interval: 1 },
    editTimeEstimate: '',
    editContexts: '',
    editTags: '',
    language: 'en',
    popularContextOptions: [],
    popularTagOptions: [],
    ...overrides,
});

const createHandlers = (): TaskItemFieldRendererHandlers => ({
    toggleDescriptionPreview: vi.fn(),
    setEditDescription: vi.fn(),
    addFileAttachment: vi.fn(),
    addLinkAttachment: vi.fn(),
    openAttachment: vi.fn(),
    removeAttachment: vi.fn(),
    setEditStartTime: vi.fn(),
    setEditDueDate: vi.fn(),
    setEditReviewAt: vi.fn(),
    setEditStatus: vi.fn(),
    setEditPriority: vi.fn(),
    setEditEnergyLevel: vi.fn(),
    setEditAssignedTo: vi.fn(),
    setEditRecurrence: vi.fn(),
    setEditRecurrenceStrategy: vi.fn(),
    setEditRecurrenceRRule: vi.fn(),
    openCustomRecurrence: vi.fn(),
    setEditTimeEstimate: vi.fn(),
    setEditContexts: vi.fn(),
    setEditTags: vi.fn(),
    updateTask: vi.fn(),
    resetTaskChecklist: vi.fn(),
});

describe('TaskItemFieldRenderer date clear buttons', () => {
    afterEach(() => {
        cleanup();
    });

    it.each([
        {
            fieldId: 'startTime' as const,
            editValue: { editStartTime: '2026-04-18T09:30' },
            clearLabel: 'Clear Start Date',
            handlerKey: 'setEditStartTime' as const,
        },
        {
            fieldId: 'dueDate' as const,
            editValue: { editDueDate: '2026-04-19T11:45' },
            clearLabel: 'Clear Due Date',
            handlerKey: 'setEditDueDate' as const,
        },
        {
            fieldId: 'reviewAt' as const,
            editValue: { editReviewAt: '2026-04-20T14:15' },
            clearLabel: 'Clear Review Date',
            handlerKey: 'setEditReviewAt' as const,
        },
    ])('clears $fieldId when the clear button is clicked', ({ fieldId, editValue, clearLabel, handlerKey }) => {
        const handlers = createHandlers();

        const { getByRole } = render(
            <TaskItemFieldRenderer
                fieldId={fieldId}
                data={createData(editValue)}
                handlers={handlers}
            />
        );

        fireEvent.click(getByRole('button', { name: clearLabel }));

        expect(handlers[handlerKey]).toHaveBeenCalledWith('');
    });

    it('hides the clear button when the date field is empty', () => {
        const handlers = createHandlers();

        const { queryByRole } = render(
            <TaskItemFieldRenderer
                fieldId="dueDate"
                data={createData()}
                handlers={handlers}
            />
        );

        expect(queryByRole('button', { name: 'Clear Due Date' })).toBeNull();
    });
});
