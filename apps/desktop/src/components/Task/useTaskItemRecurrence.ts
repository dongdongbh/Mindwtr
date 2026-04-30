import { useCallback, useMemo, useState } from 'react';
import type { RecurrenceByDay, RecurrenceRule, RecurrenceWeekday, Task } from '@mindwtr/core';
import { buildRRuleString, parseRRuleString, safeParseDate } from '@mindwtr/core';
import { WEEKDAY_ORDER } from './recurrence-constants';

type UseTaskItemRecurrenceProps = {
    task: Task;
    editDueDate: string;
    editRecurrence: RecurrenceRule | '';
    editRecurrenceRRule: string;
    setEditRecurrence: (value: RecurrenceRule | '') => void;
    setEditRecurrenceRRule: (value: string) => void;
};

export function useTaskItemRecurrence({
    task,
    editDueDate,
    editRecurrence,
    editRecurrenceRRule,
    setEditRecurrence,
    setEditRecurrenceRRule,
}: UseTaskItemRecurrenceProps) {
    const monthlyAnchorDate = safeParseDate(editDueDate) ?? safeParseDate(task.dueDate) ?? new Date();
    const monthlyWeekdayCode = WEEKDAY_ORDER[monthlyAnchorDate.getDay()];

    const monthlyRecurrence = useMemo(() => {
        if (editRecurrence !== 'monthly') {
            return { pattern: 'date' as const, interval: 1 };
        }
        const parsed = parseRRuleString(editRecurrenceRRule);
        const hasLast = parsed.byDay?.some((day) => String(day).startsWith('-1'));
        const hasNth = parsed.byDay?.some((day) => /^[1-4]/.test(String(day)));
        const hasByMonthDay = parsed.byMonthDay && parsed.byMonthDay.length > 0;
        const interval = parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
        const isCustomDay = hasByMonthDay && parsed.byMonthDay?.[0] !== monthlyAnchorDate.getDate();
        const pattern: 'custom' | 'date' = hasNth || hasLast || isCustomDay ? 'custom' : 'date';
        return { pattern, interval };
    }, [editRecurrence, editRecurrenceRRule, monthlyAnchorDate]);

    const [showCustomRecurrence, setShowCustomRecurrence] = useState(false);
    const [customInterval, setCustomInterval] = useState(1);
    const [customMode, setCustomMode] = useState<'date' | 'nth'>('date');
    const [customOrdinal, setCustomOrdinal] = useState<'1' | '2' | '3' | '4' | '-1'>('1');
    const [customWeekday, setCustomWeekday] = useState<RecurrenceWeekday>(monthlyWeekdayCode);
    const [customMonthDay, setCustomMonthDay] = useState<number>(monthlyAnchorDate.getDate());

    const openCustomRecurrence = useCallback(() => {
        const parsed = parseRRuleString(editRecurrenceRRule);
        const interval = parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
        let mode: 'date' | 'nth' = 'date';
        let ordinal: '1' | '2' | '3' | '4' | '-1' = '1';
        let weekday: RecurrenceWeekday = monthlyWeekdayCode;
        const monthDay = parsed.byMonthDay?.[0];
        if (monthDay) {
            mode = 'date';
            setCustomMonthDay(Math.min(Math.max(monthDay, 1), 31));
        }
        const token = parsed.byDay?.find((day) => /^(-?1|2|3|4)/.test(String(day)));
        if (token) {
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
        if (!monthDay) {
            setCustomMonthDay(monthlyAnchorDate.getDate());
        }
        setShowCustomRecurrence(true);
    }, [editRecurrenceRRule, monthlyAnchorDate, monthlyWeekdayCode]);

    const applyCustomRecurrence = useCallback(() => {
        const parsed = parseRRuleString(editRecurrenceRRule);
        const intervalValue = Number(customInterval);
        const safeInterval = Number.isFinite(intervalValue) && intervalValue > 0 ? intervalValue : 1;
        const safeMonthDay = Math.min(Math.max(Math.round(customMonthDay || 1), 1), 31);
        const rrule = customMode === 'nth'
            ? buildRRuleString('monthly', [`${customOrdinal}${customWeekday}` as RecurrenceByDay], safeInterval, {
                count: parsed.count,
                until: parsed.until,
            })
            : buildRRuleString('monthly', undefined, safeInterval, {
                byMonthDay: [safeMonthDay],
                count: parsed.count,
                until: parsed.until,
            });
        setEditRecurrence('monthly');
        setEditRecurrenceRRule(rrule);
        setShowCustomRecurrence(false);
    }, [
        customInterval,
        customMode,
        customMonthDay,
        customOrdinal,
        customWeekday,
        editRecurrenceRRule,
        setEditRecurrence,
        setEditRecurrenceRRule,
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
        customMonthDay,
        setCustomMonthDay,
        openCustomRecurrence,
        applyCustomRecurrence,
    };
}
