import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TaskItemRecurrenceModal } from './TaskItemRecurrenceModal';

describe('TaskItemRecurrenceModal', () => {
    it('exposes the recurrence editor as an accessible dialog', () => {
        render(
            <TaskItemRecurrenceModal
                t={(key) => ({
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
                }[key] ?? key)}
                weekdayOrder={['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']}
                weekdayLabels={{
                    MO: 'Monday',
                    TU: 'Tuesday',
                    WE: 'Wednesday',
                    TH: 'Thursday',
                    FR: 'Friday',
                    SA: 'Saturday',
                    SU: 'Sunday',
                }}
                customInterval={1}
                customMode="date"
                customOrdinal="1"
                customWeekday="MO"
                customMonthDay={1}
                onIntervalChange={vi.fn()}
                onModeChange={vi.fn()}
                onOrdinalChange={vi.fn()}
                onWeekdayChange={vi.fn()}
                onMonthDayChange={vi.fn()}
                onClose={vi.fn()}
                onApply={vi.fn()}
            />,
        );

        const dialog = screen.getByRole('dialog', { name: 'Custom recurrence' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByText('Custom recurrence').id).toBeTruthy();
    });
});
