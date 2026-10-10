import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CalendarOpenTaskModal, CalendarTaskComposerModal } from './CalendarModals';
import { LanguageProvider } from '../../../contexts/language-context';

const editTrigger = vi.fn();

vi.mock('../../TaskItem', () => ({
    TaskItem: ({ readOnly, interactionDisabled }: { readOnly: boolean; interactionDisabled: boolean }) => (
        <div data-task-id="task-1" data-read-only={String(readOnly)} data-interaction-disabled={String(interactionDisabled)}>
            <button type="button" data-task-edit-trigger onClick={editTrigger}>edit</button>
            <input aria-label="note" />
        </div>
    ),
}));

const controller = {
    closeOpenTask: vi.fn(),
    openProject: null,
    openTask: { id: 'task-1', title: 'Call bank', status: 'next' },
    t: (key: string) => key,
} as never;

describe('CalendarOpenTaskModal', () => {
    // #1241: the global list shortcuts are muted while a modal dialog is open, so the
    // pop-up must answer the edit key itself, and without a prior click on the row.
    it('opens the editor from the edit shortcut without selecting the row first', () => {
        editTrigger.mockClear();
        render(<CalendarOpenTaskModal controller={controller} />);

        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'e' });
        expect(editTrigger).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', shiftKey: true });
        expect(editTrigger).toHaveBeenCalledTimes(2);
    });

    it('passes read-only through and disables edit shortcuts for history', () => {
        editTrigger.mockClear();
        render(<CalendarOpenTaskModal controller={controller} readOnly />);
        expect(document.querySelector('[data-task-id="task-1"]')).toHaveAttribute('data-read-only', 'true');
        expect(document.querySelector('[data-task-id="task-1"]')).toHaveAttribute('data-interaction-disabled', 'true');
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'e' });
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', shiftKey: true });
        expect(editTrigger).not.toHaveBeenCalled();
    });

    it('leaves the key alone while typing in a field or with a modifier held', () => {
        editTrigger.mockClear();
        render(<CalendarOpenTaskModal controller={controller} />);

        fireEvent.keyDown(screen.getByLabelText('note'), { key: 'e' });
        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'e', ctrlKey: true });
        expect(editTrigger).not.toHaveBeenCalled();
    });
});

it('offers retained context history only after typing in the calendar composer', () => {
    render(<LanguageProvider><CalendarTaskComposerModal controller={{
        areas: [], projects: [], quickAddSuggestionTokens: ['@active-only'],
        quickAddContextHistory: ['@active-only', '@Seasonal Planning'],
        closeTaskComposer: vi.fn(), saveTaskComposer: vi.fn(), selectTaskComposerTask: vi.fn(),
        selectedComposerTask: null, taskComposerCandidates: [], taskComposerError: null,
        taskComposer: { mode: 'new', title: '', startDateValue: '2026-09-27', startTimeValue: '09:00', endTimeValue: '09:30', durationMinutes: 30 },
        resolveText: (_key: string, fallback: string) => fallback, t: (key: string) => key,
        updateTaskComposerDuration: vi.fn(), updateTaskComposerEndTime: vi.fn(), updateTaskComposerMode: vi.fn(),
        updateTaskComposerQuery: vi.fn(), updateTaskComposerStart: vi.fn(), updateTaskComposerTitle: vi.fn(),
    } as never} /></LanguageProvider>);
    const input = screen.getByLabelText('Task title');
    fireEvent.change(input, { target: { value: '@' } });
    expect(screen.queryByRole('option', { name: '@Seasonal Planning' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '@Seas' } });
    expect(screen.getByRole('option', { name: '@Seasonal Planning' })).toBeInTheDocument();
});
