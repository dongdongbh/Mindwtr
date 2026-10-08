import React, { type ComponentProps } from 'react';
import { Platform, Text, TextInput, TouchableOpacity } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { configureDateFormatting, type Task } from '@mindwtr/core';
import { createTaskDraft, type TaskDraft } from '@mindwtr/core/task-draft';

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
    dateRow: {},
    dateBtn: {},
    dateIssueText: {},
    flex1: {},
    clearDateBtn: {},
    clearDateText: {},
    compactFieldRow: {},
    compactFieldLabel: {},
    compactFieldValue: {},
    pickerToolbar: {},
    pickerSpacer: {},
    pickerDone: {},
    pickerDoneText: {},
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
    onTint: '#102030',
    warning: '#f59e0b',
};

const t = (key: string) => ({
    'common.notSet': 'Not set',
    'common.done': 'Done',
    'taskEdit.dueDateLabel': 'Due Date',
    'taskEdit.startDateLabel': 'Start Date',
    'taskEdit.suppressMindwtrReminders': 'Skip reminders',
    'taskEdit.suppressMindwtrRemindersHint': 'Skip start and due reminders for this task. It still appears in Focus and your lists.',
    'taskEdit.repeatReminderLabel': 'Repeat reminder',
    'taskEdit.repeatReminderOff': 'Off',
    'taskEdit.repeatReminderEveryMinutes': 'Every {count} min',
    'taskEdit.repeatReminderMinutesShort': '{count} min',
    'task.dateIssue.startAfterDue': 'Starts after due date',
    'taskEdit.recurrenceLabel': 'Recurrence',
    'recurrence.none': 'None',
    'recurrence.weekly': 'Weekly',
    'recurrence.monthly': 'Monthly',
    'recurrence.yearly': 'Yearly',
    'recurrence.repeatEvery': 'Repeat every',
    'recurrence.weekUnit': 'week(s)',
    'recurrence.monthUnit': 'month(s)',
    'recurrence.yearUnit': 'year(s)',
    'recurrence.endsLabel': 'Ends',
    'recurrence.endsNever': 'Never',
    'recurrence.endsOnDate': 'On date',
    'recurrence.endsAfterCount': 'After',
}[key] ?? key);

const originalPlatformOS = Platform.OS;
const task: Task = {
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
};
const makeDraft = (overrides: Partial<Task> = {}) => createTaskDraft({ ...task, ...overrides });

afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatformOS, configurable: true });
    configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
});

describe('TaskEditScheduleField', () => {
    it('renders an unset due date as a compact action row', () => {
        const setShowDatePicker = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({}),
                    fieldId: 'dueDate',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? 'Not set',
                    getSafePickerDateValue: () => new Date('2026-04-28T09:20:00'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [],
                    recurrenceRRuleValue: '',
                    recurrenceRuleValue: '',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField: vi.fn(),
                    setShowDatePicker,
                    showDatePicker: null,
                    styles,
                    t,
                    task: null,
                    tc,
                } as any)}
                />
            );
        });

        const compactButton = tree.root.findByProps({ accessibilityLabel: 'Due Date: Not set' });
        expect(compactButton.props.accessibilityRole).toBe('button');

        act(() => {
            compactButton.props.onPress();
        });

        expect(setShowDatePicker).toHaveBeenCalledWith('due');
    });

    it('renders due-date suggestions whether or not the due picker is open', () => {
        let hiddenTree!: renderer.ReactTestRenderer;
        act(() => {
            hiddenTree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({}),
                    fieldId: 'dueDate',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? 'Not set',
                    getSafePickerDateValue: () => new Date('2026-04-28T09:20:00'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [],
                    recurrenceRRuleValue: '',
                    recurrenceRuleValue: '',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField: vi.fn(),
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

        // The picker being closed (showDatePicker null) must no longer hide the
        // chips: on Android that same state opens the native dialog on top of
        // the sheet, so gating chips on it made them unreachable (issue #901).
        expect(hiddenTree.root.findAllByProps({ testID: 'quick-date-chips-row' }).length).toBeGreaterThan(0);

        let activeTree!: renderer.ReactTestRenderer;
        act(() => {
            activeTree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({}),
                    fieldId: 'dueDate',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? 'Not set',
                    getSafePickerDateValue: () => new Date('2026-04-28T09:20:00'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [],
                    recurrenceRRuleValue: '',
                    recurrenceRuleValue: '',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField: vi.fn(),
                    setShowDatePicker: vi.fn(),
                    showDatePicker: 'due',
                    styles,
                    t,
                    task: null,
                    tc,
                } as any)}
                />
            );
        });

        expect(activeTree.root.findAllByProps({ testID: 'quick-date-chips-row' }).length).toBeGreaterThan(0);
    });

    it('formats start dates with the configured app date and time format', () => {
        configureDateFormatting({ language: 'en', dateFormat: 'ymd', timeFormat: '24h', systemLocale: 'en-US' });

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({ startTime: '2026-04-28T09:20:00' }),
                    fieldId: 'startTime',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? '',
                    getSafePickerDateValue: () => new Date('2026-04-28T09:20:00'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [],
                    recurrenceRRuleValue: '',
                    recurrenceRuleValue: '',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField: vi.fn(),
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

        const textValues = tree.root.findAllByType(Text).map((node) => node.props.children);
        expect(textValues).toContain('2026-04-28 09:20');
    });

    it('shows a date-coherence note for start dates after due dates', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({ startTime: '2026-04-25', dueDate: '2026-04-24' }),
                    fieldId: 'startTime',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? '',
                    getSafePickerDateValue: () => new Date('2026-04-25T09:20:00'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [],
                    recurrenceRRuleValue: '',
                    recurrenceRuleValue: '',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField: vi.fn(),
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

        const textValues = tree.root.findAllByType(Text).map((node) => node.props.children);
        expect(textValues).toContain('Starts after due date');
    });

    it('shows the calendar reminder handoff once on the due-date field for explicit reminder times', () => {
        const setDraftField = vi.fn();

        let dateOnlyTree!: renderer.ReactTestRenderer;
        act(() => {
            dateOnlyTree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({ dueDate: '2026-04-28' }),
                    fieldId: 'dueDate',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? '',
                    getSafePickerDateValue: () => new Date('2026-04-28T09:20:00'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [],
                    recurrenceRRuleValue: '',
                    recurrenceRuleValue: '',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField,
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

        expect(dateOnlyTree.root.findAllByProps({ accessibilityRole: 'switch' })).toHaveLength(0);

        let startFieldTree!: renderer.ReactTestRenderer;
        act(() => {
            startFieldTree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({ startTime: '2026-04-28T09:20:00' }),
                    fieldId: 'startTime',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? '',
                    getSafePickerDateValue: () => new Date('2026-04-28T09:20:00'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [],
                    recurrenceRRuleValue: '',
                    recurrenceRuleValue: '',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField,
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

        expect(startFieldTree.root.findAllByProps({ accessibilityRole: 'switch' })).toHaveLength(0);

        let timedTree!: renderer.ReactTestRenderer;
        act(() => {
            timedTree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({ dueDate: '2026-04-28T09:20:00' }),
                    fieldId: 'dueDate',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? '',
                    getSafePickerDateValue: () => new Date('2026-04-28T09:20:00'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [],
                    recurrenceRRuleValue: '',
                    recurrenceRuleValue: '',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField,
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

        const handoffSwitch = timedTree.root.findByProps({ accessibilityRole: 'switch' });
        expect(handoffSwitch.props.accessibilityState).toEqual({ checked: false });

        act(() => {
            handoffSwitch.props.onPress();
        });

        expect(setDraftField).toHaveBeenCalledWith('suppressMindwtrReminders', true);
    });

    it('collapses repeat reminder options until the compact row is pressed', () => {
        const setDraftField = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({ dueDate: '2026-04-28T09:20:00' }),
                    fieldId: 'dueDate',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? '',
                    getSafePickerDateValue: () => new Date('2026-04-28T09:20:00'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [],
                    recurrenceRRuleValue: '',
                    recurrenceRuleValue: '',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField,
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

        const collapsedRow = tree.root.findByProps({ accessibilityLabel: 'Repeat reminder: Off' });
        expect(collapsedRow.props.accessibilityRole).toBe('button');
        expect(tree.root.findAllByProps({ accessibilityLabel: '5 min' })).toHaveLength(0);

        act(() => {
            collapsedRow.props.onPress();
        });

        const fiveMinuteOption = tree.root.findByProps({ accessibilityLabel: '5 min' });
        act(() => {
            fiveMinuteOption.props.onPress();
        });

        expect(setDraftField).toHaveBeenCalledWith('repeatReminderMinutes', 5);
    });

    it.each(['due', 'due-time', 'start', 'start-time', 'review', 'recurrence-end'])('renders the iOS %s picker with a calendar for dates and a wheel for times', (pickerMode) => {
        Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({ dueDate: '2026-04-28T09:20:00' }),
                    fieldId: pickerMode.startsWith('start') ? 'startTime' : pickerMode === 'review' ? 'reviewAt' : pickerMode === 'recurrence-end' ? 'recurrence' : 'dueDate',
                    formatDate: (value?: string) => value ?? '',
                    formatDueDate: (value?: string) => value ?? '',
                    getSafePickerDateValue: () => new Date('2026-04-28T09:20:00'),
                    monthlyPattern: 'date',
                    onDateChange: vi.fn(),
                    openCustomRecurrence: vi.fn(),
                    pendingDueDate: null,
                    pendingStartDate: null,
                    recurrenceOptions: [],
                    recurrenceRRuleValue: pickerMode === 'recurrence-end' ? 'FREQ=DAILY;UNTIL=20260428' : '',
                    recurrenceRuleValue: pickerMode === 'recurrence-end' ? 'daily' : '',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField: vi.fn(),
                    setShowDatePicker: vi.fn(),
                    showDatePicker: pickerMode,
                    styles,
                    t,
                    task: null,
                    tc,
                } as any)}
                />
            );
        });

        const picker = tree.root.findByType('DateTimePicker' as any);
        expect(picker.props.mode).toBe(pickerMode.endsWith('-time') ? 'time' : 'date');
        expect(picker.props.display).toBe(pickerMode.endsWith('-time') ? 'spinner' : 'inline');
        expect(picker.props.textColor).toBe(tc.text);
    });

    it('lets a daily recurrence interval be cleared before entering a new digit', () => {
        const setDraftField = vi.fn();
        const dailyProps = {
            customWeekdays: [],
            dailyInterval: 1,
            draft: makeDraft({}),
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
                { value: 'daily', label: 'Daily' },
            ],
            recurrenceRRuleValue: 'FREQ=DAILY',
            recurrenceRuleValue: 'daily',
            recurrenceStrategyValue: 'strict',
            recurrenceWeekdayButtons: [],
            setCustomWeekdays: vi.fn(),
            setDraftField,
            setShowDatePicker: vi.fn(),
            showDatePicker: null,
            styles,
            t,
            task: null,
            tc,
        } as any;

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...dailyProps} />
            );
        });

        const findIntervalInput = () => tree.root
            .findAllByType(TextInput)
            .find((node) => node.props.accessibilityHint === 'recurrence.dayUnit');

        act(() => {
            findIntervalInput()?.props.onChangeText('');
        });
        expect(findIntervalInput()?.props.value).toBe('');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=DAILY');

        act(() => {
            findIntervalInput()?.props.onChangeText('3');
        });
        expect(findIntervalInput()?.props.value).toBe('3');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=DAILY;INTERVAL=3');

        setDraftField.mockClear();
        act(() => {
            findIntervalInput()?.props.onChangeText('');
        });
        expect(findIntervalInput()?.props.value).toBe('');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=DAILY');

        act(() => {
            findIntervalInput()?.props.onBlur();
        });
        expect(findIntervalInput()?.props.value).toBe('1');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=DAILY');

        setDraftField.mockClear();
        act(() => {
            findIntervalInput()?.props.onChangeText('0');
        });
        expect(findIntervalInput()?.props.value).toBe('0');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=DAILY');

        act(() => {
            findIntervalInput()?.props.onBlur();
        });
        expect(findIntervalInput()?.props.value).toBe('1');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=DAILY');

        act(() => {
            findIntervalInput()?.props.onChangeText('');
            tree.update(
                <TaskEditScheduleField
                    {...dailyProps}
                    dailyInterval={4}
                    recurrenceRRuleValue="FREQ=DAILY;INTERVAL=4"
                />
            );
        });
        expect(findIntervalInput()?.props.value).toBe('4');

        act(() => {
            tree.unmount();
            tree = renderer.create(
                <TaskEditScheduleField
                    {...dailyProps}
                    dailyInterval={4}
                    recurrenceRRuleValue="FREQ=DAILY;INTERVAL=4"
                />
            );
        });
        expect(findIntervalInput()?.props.value).toBe('4');
    });

    it('updates monthly recurrence intervals without changing the monthly pattern', () => {
        const setDraftField = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({}),
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
                    setDraftField,
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
            intervalInput?.props.onChangeText('');
        });
        expect(intervalInput?.props.value).toBe('');
        expect(setDraftField).toHaveBeenCalledWith(
            'recurrenceRRule',
            'FREQ=MONTHLY;BYMONTHDAY=15',
        );

        act(() => {
            intervalInput?.props.onChangeText('3');
        });

        expect(intervalInput?.props.value).toBe('3');

        expect(setDraftField).toHaveBeenCalledWith('recurrence', 'monthly');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceStrategy', 'strict');
        expect(setDraftField).toHaveBeenCalledWith(
            'recurrenceRRule',
            'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15',
        );
    });

    it('updates weekly recurrence intervals without dropping selected weekdays', () => {
        const setDraftField = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: ['TU'],
                    dailyInterval: 1,
                    draft: makeDraft({
                        recurrence: {
                            rule: 'weekly',
                            strategy: 'strict',
                            byDay: ['TU'],
                            rrule: 'FREQ=WEEKLY;BYDAY=TU;WKST=SU;X-CUSTOM=keep',
                        },
                    }),
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
                    recurrenceRRuleValue: 'FREQ=WEEKLY;BYDAY=TU;WKST=SU;X-CUSTOM=keep',
                    recurrenceRuleValue: 'weekly',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [{ key: 'TU', label: 'T' }],
                    setCustomWeekdays: vi.fn(),
                    setDraftField,
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

        expect(intervalInput?.props.value).toBe('1');

        act(() => {
            intervalInput?.props.onChangeText('');
        });
        expect(intervalInput?.props.value).toBe('');
        expect(setDraftField).toHaveBeenCalledWith(
            'recurrenceRRule',
            'FREQ=WEEKLY;BYDAY=TU;WKST=SU;X-CUSTOM=keep',
        );

        act(() => {
            intervalInput?.props.onChangeText('3');
        });
        expect(intervalInput?.props.value).toBe('3');
        expect(setDraftField).toHaveBeenCalledWith(
            'recurrenceRRule',
            'FREQ=WEEKLY;INTERVAL=3;BYDAY=TU;WKST=SU;X-CUSTOM=keep',
        );

        act(() => {
            intervalInput?.props.onChangeText('78');
        });

        expect(setDraftField).toHaveBeenCalledWith('recurrence', 'weekly');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceStrategy', 'strict');
        expect(setDraftField).toHaveBeenCalledWith(
            'recurrenceRRule',
            'FREQ=WEEKLY;INTERVAL=78;BYDAY=TU;WKST=SU;X-CUSTOM=keep',
        );
    });

    it('uses the primary selection color for selected weekly recurrence weekdays', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: ['TU'],
                    dailyInterval: 1,
                    draft: makeDraft({
                        recurrence: {
                            rule: 'weekly',
                            strategy: 'strict',
                            byDay: ['TU'],
                            rrule: 'FREQ=WEEKLY;BYDAY=TU',
                        },
                    }),
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
                    recurrenceRRuleValue: 'FREQ=WEEKLY;BYDAY=TU',
                    recurrenceRuleValue: 'weekly',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [
                        { key: 'TU', label: 'T' },
                        { key: 'WE', label: 'W' },
                    ],
                    setCustomWeekdays: vi.fn(),
                    setDraftField: vi.fn(),
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

        const selectedButton = tree.root
            .findAllByType(TouchableOpacity)
            .find((node) => node.findAllByType(Text).some((textNode) => textNode.props.children === 'T'));
        const selectedRecurrenceText = tree.root
            .findAllByType(Text)
            .find((node) => node.props.children === 'Weekly');

        expect(selectedButton?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({
                backgroundColor: tc.tint,
                borderColor: tc.tint,
            }),
        ]));
        expect(selectedRecurrenceText?.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ color: tc.onTint }),
        ]));
    });

    it('updates yearly recurrence intervals', () => {
        const setDraftField = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditScheduleField {...({
                    customWeekdays: [],
                    dailyInterval: 1,
                    draft: makeDraft({
                        recurrence: {
                            rule: 'yearly',
                            strategy: 'strict',
                            rrule: 'FREQ=YEARLY',
                        },
                    }),
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
                        { value: 'yearly', label: 'Yearly' },
                    ],
                    recurrenceRRuleValue: 'FREQ=YEARLY',
                    recurrenceRuleValue: 'yearly',
                    recurrenceStrategyValue: 'strict',
                    recurrenceWeekdayButtons: [],
                    setCustomWeekdays: vi.fn(),
                    setDraftField,
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
            .find((node) => node.props.accessibilityHint === 'year(s)');

        expect(intervalInput?.props.value).toBe('1');

        act(() => {
            intervalInput?.props.onChangeText('');
        });
        expect(intervalInput?.props.value).toBe('');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=YEARLY');

        act(() => {
            intervalInput?.props.onChangeText('2');
        });

        expect(intervalInput?.props.value).toBe('2');
        expect(setDraftField).toHaveBeenCalledWith('recurrence', 'yearly');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceStrategy', 'strict');
        expect(setDraftField).toHaveBeenCalledWith('recurrenceRRule', 'FREQ=YEARLY;INTERVAL=2');
    });

    it('turns the due-date time and clear chips into labelled icon buttons', () => {
        const props = {
            customWeekdays: [],
            dailyInterval: 1,
            draft: makeDraft({ dueDate: '2026-04-28' }),
            fieldId: 'dueDate' as const,
            formatDate: (value?: string) => value ?? '',
            formatDueDate: (value?: string) => value ?? '',
            getSafePickerDateValue: () => new Date('2026-04-28T09:20:00'),
            monthlyPattern: 'date',
            onDateChange: vi.fn(),
            openCustomRecurrence: vi.fn(),
            pendingDueDate: null,
            pendingStartDate: null,
            recurrenceOptions: [],
            recurrenceRRuleValue: '',
            recurrenceRuleValue: '',
            recurrenceStrategyValue: 'strict',
            recurrenceWeekdayButtons: [],
            setCustomWeekdays: vi.fn(),
            setDraftField: vi.fn(),
            setShowDatePicker: vi.fn(),
            showDatePicker: null,
            styles,
            t,
            task: null,
            tc,
        } as unknown as ComponentProps<typeof TaskEditScheduleField>;
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(<TaskEditScheduleField {...props} />);
        });

        const timeChip = tree.root.findByProps({ accessibilityLabel: 'Add time' });
        expect(timeChip.props.accessibilityRole).toBe('button');
        expect(timeChip.findAllByType(Text)).toHaveLength(0);
        expect(timeChip.findAll((node) => node.props?.size === 14).length).toBeGreaterThan(0);

        const clearChip = tree.root.findByProps({ accessibilityLabel: 'common.clear' });
        expect(clearChip.props.accessibilityRole).toBe('button');
        expect(clearChip.findAll((node) => node.props?.size === 14).length).toBeGreaterThan(0);
    });
});

// Frozen from the original RN caller at 2d62a09a, before preview extraction.
// Source hashes and exact oracle inputs/outputs: ios-recurrence-preview-20260927-19.
describe('RN recurrence calendar preview parity', () => {
    const originalTZ = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = 'America/New_York';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'));
    });
    afterAll(() => {
        vi.useRealTimers();
        if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    });
    const cases: Array<{ name: string; stored: Partial<Task>; edited?: Partial<TaskDraft>; hint: string }> = [
    { name: 'scheduled daily', stored: { recurrence: { rule: 'daily', strategy: 'strict' } }, hint: 'Next calendar preview: Oct 2, 2026.' },
    { name: 'custom monthly', stored: { dueDate: '2026-10-13', recurrence: { rule: 'monthly', strategy: 'strict', rrule: 'FREQ=MONTHLY;BYDAY=2TU' } }, hint: 'Next calendar preview: Nov 10, 2026.' },
    { name: 'no recurrence', stored: {}, hint: '' },
    { name: 'exhausted count', stored: { recurrence: { rule: 'daily', strategy: 'strict', count: 3, completedOccurrences: 2 } }, hint: '' },
    { name: 'exhausted until', stored: { recurrence: { rule: 'daily', strategy: 'strict', until: '2026-10-01' } }, hint: '' },
    { name: 'preview toggle off', stored: { recurrence: { rule: 'daily', strategy: 'strict' }, showFutureRecurrence: false }, hint: 'Next calendar preview: Oct 2, 2026.' },
    { name: 'cleared draft date', stored: { recurrence: { rule: 'daily', strategy: 'strict' } }, edited: { dueDate: '' }, hint: 'Next calendar preview: Sep 28, 2026.' },
    { name: 'stored completion progress', stored: { recurrence: { rule: 'daily', strategy: 'strict', count: 3, completedOccurrences: 1 } }, hint: 'Next calendar preview: Oct 2, 2026.' },
    { name: 'after completion', stored: { dueDate: '2026-09-25', recurrence: { rule: 'daily', strategy: 'fluid' } }, hint: 'Next calendar preview: Sep 28, 2026.' },
    { name: 'draft status done', stored: { recurrence: { rule: 'daily', strategy: 'strict' } }, edited: { status: 'done' }, hint: '' },
];
    it.each(cases)('keeps the original hint for $name', ({ stored, edited, hint }) => {
        configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
        const current = { ...task, dueDate: '2026-10-01', ...stored };
        const draft = { ...createTaskDraft(current), ...edited };
        const setDraftField = vi.fn();
        const before = JSON.stringify({ current, draft });
        const props = {
            customWeekdays: [], dailyInterval: 1, draft, fieldId: 'recurrence',
            formatDate: (value?: string) => value ?? '', formatDueDate: (value?: string) => value ?? '',
            getSafePickerDateValue: () => new Date(), monthlyPattern: 'date', onDateChange: vi.fn(),
            openCustomRecurrence: vi.fn(), pendingDueDate: null, pendingStartDate: null, recurrenceOptions: [],
            recurrenceRRuleValue: draft.recurrenceRRule, recurrenceRuleValue: draft.recurrence,
            recurrenceStrategyValue: draft.recurrenceStrategy, recurrenceWeekdayButtons: [],
            setCustomWeekdays: vi.fn(), setDraftField, setShowDatePicker: vi.fn(), showDatePicker: null,
            styles, t, task: current, tc,
        } as unknown as ComponentProps<typeof TaskEditScheduleField>;
        let tree!: renderer.ReactTestRenderer;
        act(() => { tree = renderer.create(<TaskEditScheduleField {...props} />); });
        const hints = tree.root.findAllByType(Text)
            .map((node) => [node.props.children].flat().join('').match(/Next calendar preview:.*$/)?.[0])
            .filter(Boolean);
        expect(hints).toEqual(hint ? [hint] : []);
        expect(setDraftField).not.toHaveBeenCalled();
        expect(JSON.stringify({ current, draft })).toBe(before);
        act(() => tree.unmount());
    });
});
