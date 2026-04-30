import React from 'react';
import { TextInput } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { TaskEditScheduleField } from './TaskEditScheduleField';

vi.mock('@react-native-community/datetimepicker', () => ({
    default: (props: Record<string, unknown>) => React.createElement('DateTimePicker', props),
}));

const styles = {
    formGroup: {},
    label: {},
    statusContainer: {},
    statusChip: {},
    statusText: {},
    customRow: {},
    modalLabel: {},
    customInput: {},
    weekdayRow: {},
    weekdayButton: {},
    weekdayButtonText: {},
};

const tc = {
    cardBg: '#111',
    border: '#333',
    filterBg: '#222',
    inputBg: '#111',
    secondaryText: '#aaa',
    text: '#fff',
    tint: '#3b82f6',
};

const t = (key: string) => ({
    'common.notSet': 'Not set',
    'taskEdit.recurrenceLabel': 'Recurrence',
    'recurrence.none': 'None',
    'recurrence.weekly': 'Weekly',
    'recurrence.monthly': 'Monthly',
    'recurrence.repeatEvery': 'Repeat every',
    'recurrence.weekUnit': 'week(s)',
    'recurrence.monthUnit': 'month(s)',
    'recurrence.endsLabel': 'Ends',
    'recurrence.endsNever': 'Never',
    'recurrence.endsOnDate': 'On date',
    'recurrence.endsAfterCount': 'After',
}[key] ?? key);

describe('TaskEditScheduleField', () => {
    it('updates monthly recurrence intervals without changing the monthly pattern', () => {
        const setEditedTask = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    editedTask: {},
                    fieldId: 'recurrence',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? '',
                    getSafePickerDateValue: () => new Date('2026-04-01T00:00:00.000Z'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [
                        { value: '', label: 'None' },
                        { value: 'monthly', label: 'Monthly' },
                    ],
                    recurrenceRRuleValue: 'FREQ=MONTHLY;BYMONTHDAY=15',
                    recurrenceRuleValue: 'monthly',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setEditedTask,
                    setShowDatePicker: vi.fn(),
                    showDatePicker: null,
                    styles,
                    t,
                    task: null,
                    tc,
                } as any)}
                />
            );
        });

        const intervalInput = tree.root
            .findAllByType(TextInput)
            .find((node) => node.props.accessibilityHint === 'month(s)');

        act(() => {
            intervalInput?.props.onChangeText('3');
        });

        const update = setEditedTask.mock.calls[0][0] as (previous: any) => any;
        const next = update({
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
            },
        });

        expect(next.recurrence).toMatchObject({
            rule: 'monthly',
            strategy: 'strict',
            rrule: 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15',
        });
    });

    it('updates weekly recurrence intervals without dropping selected weekdays', () => {
        const setEditedTask = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: ['TU'],
                    dailyInterval: 1,
                    editedTask: {
                        recurrence: {
                            rule: 'weekly',
                            strategy: 'strict',
                            byDay: ['TU'],
                            rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
                        },
                    },
                    fieldId: 'recurrence',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? '',
                    getSafePickerDateValue: () => new Date('2026-04-01T00:00:00.000Z'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [
                        { value: '', label: 'None' },
                        { value: 'weekly', label: 'Weekly' },
                    ],
                    recurrenceRRuleValue: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
                    recurrenceRuleValue: 'weekly',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [{ key: 'TU', label: 'T' }],
                    setCustomWeekdays: vi.fn(),
                    setEditedTask,
                    setShowDatePicker: vi.fn(),
                    showDatePicker: null,
                    styles,
                    t,
                    task: null,
                    tc,
                } as any)}
                />
            );
        });

        const intervalInput = tree.root
            .findAllByType(TextInput)
            .find((node) => node.props.accessibilityHint === 'week(s)');

        expect(intervalInput?.props.value).toBe('2');

        act(() => {
            intervalInput?.props.onChangeText('4');
        });

        const update = setEditedTask.mock.calls[0][0] as (previous: any) => any;
        const next = update({
            recurrence: {
                rule: 'weekly',
                strategy: 'strict',
                byDay: ['TU'],
                rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
            },
        });

        expect(next.recurrence).toMatchObject({
            rule: 'weekly',
            strategy: 'strict',
            byDay: ['TU'],
            rrule: 'FREQ=WEEKLY;INTERVAL=4;BYDAY=TU',
        });
    });
});
