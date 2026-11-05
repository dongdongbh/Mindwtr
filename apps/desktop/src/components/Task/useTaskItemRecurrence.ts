import { useCallback, useMemo, useState } from 'react';
import type { RecurrenceByDay, RecurrenceWeekday, Task, TaskDraft, TaskDraftSetter } from '@mindwtr/core';
import { buildRRuleString, getTaskEditorMonthlyPattern, isMonthlyWeekdaySet, MONTHLY_WEEKDAYS, parseRRuleString, safeParseDate } from '@mindwtr/core';
import { WEEKDAY_ORDER } from './recurrence-constants';

type UseTaskItemRecurrenceProps = {
    task: Task;
    draft: TaskDraft;
    setField: TaskDraftSetter;
};

export function useTaskItemRecurrence({
    task,
    draft,
    setField,
}: UseTaskItemRecurrenceProps) {
    const {
        startTime: editStartTime,
        dueDate: editDueDate,
        recurrence: editRecurrence,
        recurrenceRRule: editRecurrenceRRule,
    } = draft;
    const monthlyAnchorDate = safeParseDate(editDueDate || editStartTime || task.dueDate || task.startTime) ?? new Date();
    const monthlyWeekdayCode = WEEKDAY_ORDER[monthlyAnchorDate.getDay()];

    const monthlyRecurrence = useMemo(() => {
        if (editRecurrence !== 'monthly') {
            return { pattern: 'date' as const, interval: 1 };
        }
        const parsed = parseRRuleString(editRecurrenceRRule);
        const interval = parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
        return { pattern: getTaskEditorMonthlyPattern(editRecurrence, editRecurrenceRRule, monthlyAnchorDate), interval };
    }, [editRecurrence, editRecurrenceRRule, monthlyAnchorDate]);

    const [showCustomRecurrence, setShowCustomRecurrence] = useState(false);
    const [customInterval, setCustomInterval] = useState(1);
    const [customMode, setCustomMode] = useState<'date' | 'nth' | 'lastDay'>('date');
    const [customOrdinal, setCustomOrdinal] = useState<'1' | '2' | '3' | '4' | '-1'>('1');
    const [customWeekday, setCustomWeekday] = useState<RecurrenceWeekday | 'WEEKDAY'>(monthlyWeekdayCode);
    const [customMonthDays, setCustomMonthDays] = useState<number[]>([monthlyAnchorDate.getDate()]);

    const toggleCustomMonthDay = useCallback((day: number) => {
        setCustomMonthDays((current) => {
            if (!current.includes(day)) return [...current, day].sort((a, b) => a - b);

            return current.length > 1 ? current.filter((value) => value !== day) : current;
        });
    }, []);

    const openCustomRecurrence = useCallback(() => {
        const parsed = parseRRuleString(editRecurrenceRRule);
        const interval = parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
        let mode: 'date' | 'nth' | 'lastDay' = 'date';
        let ordinal: '1' | '2' | '3' | '4' | '-1' = '1';
        let weekday: RecurrenceWeekday | 'WEEKDAY' = monthlyWeekdayCode;
        const monthDays = (parsed.byMonthDay ?? []).filter((day) => day === -1 || (day >= 1 && day <= 31));
        if (monthDays.length === 1 && monthDays[0] === -1) {
            mode = 'lastDay';
        } else if (monthDays.length > 0) {
            mode = 'date';
            setCustomMonthDays(monthDays);
        }
        const token = parsed.byDay?.find((day) => /^(-?1|2|3|4)/.test(String(day)));
        if (isMonthlyWeekdaySet(parsed.byDay) && [-1, 1, 2, 3, 4].includes(parsed.bySetPos ?? 0)) {
            mode = 'nth';
            ordinal = String(parsed.bySetPos) as typeof ordinal;
            weekday = 'WEEKDAY';
        } else if (token) {
            const match = String(token).match(/^(-1|1|2|3|4)?(SU|MO|TU|WE|TH|FR|SA)$/);
            if (match) {
                mode = 'nth';
                ordinal = (match[1] ?? '1') as '1' | '2' | '3' | '4' | '-1';
                weekday = match[2] as RecurrenceWeekday;
            }
        }
        setCustomInterval(interval);
        setCustomMode(mode);
        setCustomOrdinal(ordinal);
        setCustomWeekday(weekday);
        if (monthDays.length === 0 || (monthDays.length === 1 && monthDays[0] === -1)) {
            setCustomMonthDays([monthlyAnchorDate.getDate()]);
        }
        setShowCustomRecurrence(true);
    }, [editRecurrenceRRule, monthlyAnchorDate, monthlyWeekdayCode]);

    const applyCustomRecurrence = useCallback(() => {
        const parsed = parseRRuleString(editRecurrenceRRule);
        const intervalValue = Number(customInterval);
        const safeInterval = Number.isFinite(intervalValue) && intervalValue > 0 ? intervalValue : 1;

        const safeMonthDays = customMonthDays.length > 0 ? customMonthDays : [1];
        const rrule = customMode === 'nth'
            ? buildRRuleString('monthly', customWeekday === 'WEEKDAY'
                ? MONTHLY_WEEKDAYS
                : [`${customOrdinal}${customWeekday}` as RecurrenceByDay], safeInterval, {
                bySetPos: customWeekday === 'WEEKDAY' ? Number(customOrdinal) : undefined,
                count: parsed.count,
                until: parsed.until,
            })
            : buildRRuleString('monthly', undefined, safeInterval, {
                byMonthDay: customMode === 'lastDay' ? [-1] : safeMonthDays,
                count: parsed.count,
                until: parsed.until,
            });
        setField('recurrence', 'monthly');
        setField('recurrenceRRule', rrule);
        setShowCustomRecurrence(false);
    }, [
        customInterval,
        customMode,
        customMonthDays,
        customOrdinal,
        customWeekday,
        editRecurrenceRRule,
        setField,
    ]);

    return {
        monthlyRecurrence,
        showCustomRecurrence,
        setShowCustomRecurrence,
        customInterval,
        setCustomInterval,
        customMode,
        setCustomMode,
        customOrdinal,
        setCustomOrdinal,
        customWeekday,
        setCustomWeekday,
        customMonthDays,
        toggleCustomMonthDay,
        openCustomRecurrence,
        applyCustomRecurrence,
    };
}
