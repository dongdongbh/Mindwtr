import {
    Task,
    type Recurrence,
    type RecurrenceByDay,
    RecurrenceRule,
    type RecurrenceStrategy,
    type RecurrenceWeekday,
    getRecurrenceRRuleValue,
    parseRRuleString,
    WEEKDAY_ORDER,
} from '@mindwtr/core';

export const MAX_SUGGESTED_TAGS = 8;
export const MAX_VISIBLE_SUGGESTIONS = 4;
export { getRecurrenceRRuleValue, WEEKDAY_ORDER };

export const getRecurrenceRuleValue = (recurrence: Task['recurrence']): RecurrenceRule | '' => {
    if (!recurrence) return '';
    if (typeof recurrence === 'string') return recurrence as RecurrenceRule;
    return recurrence.rule;
};

export const getRecurrenceStrategyValue = (recurrence: Task['recurrence']): RecurrenceStrategy => {
    if (recurrence && typeof recurrence === 'object' && recurrence.strategy === 'fluid') {
        return 'fluid';
    }
    return 'strict';
};

export const buildRecurrenceValue = (
    rule: RecurrenceRule | '',
    strategy: RecurrenceStrategy,
    options: {
        byDay?: RecurrenceByDay[];
        byMonthDay?: number[];
        count?: number;
        until?: string;
        completedOccurrences?: number;
        rrule?: string;
    } = {}
): Task['recurrence'] | undefined => {
    if (!rule) return undefined;
    const recurrence: Recurrence = { rule, strategy };
    if (options.byDay?.length) {
        recurrence.byDay = options.byDay;
    }
    if (options.byMonthDay?.length) {
        recurrence.byMonthDay = options.byMonthDay;
    }
    if (options.count) {
        recurrence.count = options.count;
    }
    if (options.until) {
        recurrence.until = options.until;
    }
    if (typeof options.completedOccurrences === 'number') {
        recurrence.completedOccurrences = options.completedOccurrences;
    }
    if (options.rrule) {
        recurrence.rrule = options.rrule;
    }
    return recurrence;
};

export const getRecurrenceByDayValue = (recurrence: Task['recurrence']): RecurrenceWeekday[] => {
    if (!recurrence || typeof recurrence === 'string') return [];
    if (recurrence.byDay?.length) {
        return recurrence.byDay.filter((day) => WEEKDAY_ORDER.includes(day as RecurrenceWeekday)) as RecurrenceWeekday[];
    }
    if (recurrence.rrule) {
        const parsed = parseRRuleString(recurrence.rrule);
        return (parsed.byDay || []).filter((day) => WEEKDAY_ORDER.includes(day as RecurrenceWeekday)) as RecurrenceWeekday[];
    }
    return [];
};
