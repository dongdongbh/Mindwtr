import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Task } from '@mindwtr/core';

import {
    TaskItemFieldRenderer,
    type TaskItemFieldRendererData,
    type TaskItemFieldRendererHandlers,
} from './TaskItemFieldRenderer';
import { LanguageProvider } from '../../contexts/language-context';

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
        'task.aria.description': 'Description',
        'task.aria.recurrence': 'Recurrence',
        'taskEdit.descriptionLabel': 'Description',
        'taskEdit.descriptionPlaceholder': 'Add notes...',
        'taskEdit.recurrenceLabel': 'Recurrence',
        'recurrence.none': 'None',
        'recurrence.daily': 'Daily',
        'recurrence.weekly': 'Weekly',
        'recurrence.monthly': 'Monthly',
        'recurrence.yearly': 'Yearly',
        'recurrence.repeatEvery': 'Repeat every',
        'recurrence.repeatOn': 'Repeat on',
        'recurrence.dayUnit': 'day(s)',
        'recurrence.weekUnit': 'week(s)',
        'recurrence.afterCompletion': 'Repeat after completion',
        'recurrence.endsLabel': 'Ends',
        'recurrence.endsNever': 'Never',
        'recurrence.endsOnDate': 'On date',
        'recurrence.endsAfterCount': 'After',
        'recurrence.occurrenceUnit': 'occurrence(s)',
        'recurrence.monthlyOnDay': 'Monthly on same day',
        'recurrence.custom': 'Custom...',
        'markdown.preview': 'Preview',
        'markdown.edit': 'Edit',
        'markdown.expand': 'Expand',
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
    nativeDateInputLocale: 'en-US',
    defaultScheduleTime: '',
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

function DescriptionHarness() {
    const [editDescription, setEditDescription] = useState('');

    return (
        <TaskItemFieldRenderer
            fieldId="description"
            data={createData({ editDescription })}
            handlers={{
                ...createHandlers(),
                setEditDescription,
            }}
        />
    );
}

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

    it('applies the configured locale to native date and time inputs', () => {
        const handlers = createHandlers();

        const { getByLabelText } = render(
            <TaskItemFieldRenderer
                fieldId="dueDate"
                data={createData({
                    editDueDate: '2026-04-19T11:45',
                    nativeDateInputLocale: 'en-CA-u-hc-h23-fw-mon',
                })}
                handlers={handlers}
            />
        );

        expect(getByLabelText('Due date')).toHaveAttribute('lang', 'en-CA-u-hc-h23-fw-mon');
        expect(getByLabelText('Due time')).toHaveAttribute('lang', 'en-CA-u-hc-h23-fw-mon');
    });

    it('applies the default schedule time when a due date is selected without an existing time', () => {
        const handlers = createHandlers();

        const { getByLabelText } = render(
            <TaskItemFieldRenderer
                fieldId="dueDate"
                data={createData({ defaultScheduleTime: '09:00' })}
                handlers={handlers}
            />
        );

        fireEvent.change(getByLabelText('Due date'), { target: { value: '2026-04-19' } });

        expect(handlers.setEditDueDate).toHaveBeenCalledWith('2026-04-19T09:00');
    });

    it('updates weekly recurrence intervals without dropping selected weekdays', () => {
        const handlers = createHandlers();
        const { container, getByRole } = render(
            <LanguageProvider>
                <TaskItemFieldRenderer
                    fieldId="recurrence"
                    data={createData({
                        editRecurrence: 'weekly',
                        editRecurrenceRRule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
                    })}
                    handlers={handlers}
                />
            </LanguageProvider>
        );
        const input = container.querySelector('input[type="number"]') as HTMLInputElement | null;

        expect(input).toBeTruthy();
        fireEvent.change(input!, { target: { value: '4' } });

        expect(handlers.setEditRecurrenceRRule).toHaveBeenCalledWith('FREQ=WEEKLY;INTERVAL=4;BYDAY=TU');

        fireEvent.click(getByRole('button', { name: 'Wed' }));

        expect(handlers.setEditRecurrenceRRule).toHaveBeenCalledWith('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,WE');
    });

    it('updates monthly recurrence intervals from the monthly recurrence controls', () => {
        const handlers = createHandlers();
        const { container } = render(
            <LanguageProvider>
                <TaskItemFieldRenderer
                    fieldId="recurrence"
                    data={createData({
                        editRecurrence: 'monthly',
                        editRecurrenceRRule: 'FREQ=MONTHLY;BYMONTHDAY=15',
                    })}
                    handlers={handlers}
                />
            </LanguageProvider>
        );
        const input = container.querySelector('input[type="number"]') as HTMLInputElement | null;

        expect(input).toBeTruthy();
        fireEvent.change(input!, { target: { value: '3' } });

        expect(handlers.setEditRecurrenceRRule).toHaveBeenCalledWith('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15');
    });

    it('undoes markdown description edits with Ctrl+Z', async () => {
        const { getByRole } = render(<DescriptionHarness />);
        const textarea = getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;

        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        fireEvent.change(textarea, { target: { value: 'First draft' } });

        expect(textarea.value).toBe('First draft');

        fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true });

        await waitFor(() => {
            expect(textarea.value).toBe('');
        });
    });
});
