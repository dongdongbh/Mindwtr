import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TaskItemRecurrenceModal } from './TaskItemRecurrenceModal';

const baseProps = {
    t: (key: string) => ({
        'common.cancel': 'Cancel',
        'common.save': 'Save',
        'recurrence.customTitle': 'Custom recurrence',
        'recurrence.repeatEvery': 'Repeat every',
        'recurrence.monthUnit': 'month(s)',
        'recurrence.onLabel': 'On',
        'recurrence.onDayOfMonth': 'Day {day}',
        'recurrence.onNthWeekday': 'The {ordinal} {weekday}',
        'recurrence.ordinal.first': 'First',
        'recurrence.ordinal.second': 'Second',
        'recurrence.ordinal.third': 'Third',
        'recurrence.ordinal.fourth': 'Fourth',
        'recurrence.ordinal.last': 'Last',
    }[key] ?? key),
    weekdayOrder: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'],
    weekdayLabels: {
        MO: 'Monday',
        TU: 'Tuesday',
        WE: 'Wednesday',
        TH: 'Thursday',
        FR: 'Friday',
        SA: 'Saturday',
        SU: 'Sunday',
    },
    customInterval: 1,
    customMode: 'date',
    customOrdinal: '1',
    customWeekday: 'MO',
    customMonthDays: [1],
    onIntervalChange: vi.fn(),
    onModeChange: vi.fn(),
    onOrdinalChange: vi.fn(),
    onWeekdayChange: vi.fn(),
    onMonthDayToggle: vi.fn(),
    onClose: vi.fn(),
    onApply: vi.fn(),
} satisfies React.ComponentProps<typeof TaskItemRecurrenceModal>;

describe('TaskItemRecurrenceModal', () => {
    it('exposes the recurrence editor as an accessible dialog', () => {
        render(<TaskItemRecurrenceModal {...baseProps} />);

        const dialog = screen.getByRole('dialog', { name: 'Custom recurrence' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByText('Custom recurrence').id).toBeTruthy();
    });

    it('offers the last day of the month as a sibling of the day-of-month choice', () => {
        const onModeChange = vi.fn();
        const { rerender } = render(
            <TaskItemRecurrenceModal {...baseProps} onModeChange={onModeChange} />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Last day' }));
        expect(onModeChange).toHaveBeenCalledWith('lastDay');

        rerender(<TaskItemRecurrenceModal {...baseProps} customMode="lastDay" onModeChange={onModeChange} />);

        expect(screen.getByRole('button', { name: 'Last day' }).className).toContain('bg-primary');
        // Only the interval input is left: the day grid belongs to the 'date' choice.
        expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: '16', pressed: false })).toBeNull();
    });

    it('marks every selected month day pressed and toggles the one that was clicked', () => {
        const onMonthDayToggle = vi.fn();
        render(
            <TaskItemRecurrenceModal
                {...baseProps}
                customMonthDays={[1, 16]}
                onMonthDayToggle={onMonthDayToggle}
            />,
        );

        expect(screen.getByRole('button', { name: '1', pressed: true })).toBeTruthy();
        expect(screen.getByRole('button', { name: '16', pressed: true })).toBeTruthy();
        expect(screen.getByRole('button', { name: '2', pressed: false })).toBeTruthy();
        // The mode chip reads back the whole list, not just the first day.
        expect(screen.getByRole('button', { name: 'Day 1, 16' })).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: '16', pressed: true }));
        expect(onMonthDayToggle).toHaveBeenCalledWith(16);
    });
});
