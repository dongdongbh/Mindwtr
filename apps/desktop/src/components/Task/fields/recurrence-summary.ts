import {
    formatI18nTemplate,
    formatRecurrenceCountLabel,
    getLocalizedWeekdayLabels,
    safeFormatDate,
    type RecurrenceByDay,
    type RecurrenceRule,
    type RecurrenceStrategy,
    type RecurrenceWeekday,
} from '@mindwtr/core';

const RULE_LABEL_KEY: Record<RecurrenceRule, string> = {
    daily: 'recurrence.daily',
    weekly: 'recurrence.weekly',
    monthly: 'recurrence.monthly',
    yearly: 'recurrence.yearly',
};

const RULE_UNIT_KEY: Record<RecurrenceRule, string> = {
    daily: 'recurrence.dayUnit',
    weekly: 'recurrence.weekUnit',
    monthly: 'recurrence.monthUnit',
    yearly: 'recurrence.yearUnit',
};

const ORDINAL_LABEL_KEY: Record<string, string> = {
    '1': 'recurrence.ordinal.first',
    '2': 'recurrence.ordinal.second',
    '3': 'recurrence.ordinal.third',
    '4': 'recurrence.ordinal.fourth',
    '-1': 'recurrence.ordinal.last',
};

export type RecurrenceSummaryInput = {
    rule: RecurrenceRule;
    strategy: RecurrenceStrategy;
    interval?: number;
    byDay?: RecurrenceByDay[];
    byMonthDay?: number[];
    count?: number;
    completedOccurrences?: number;
    until?: string;
};

const splitByDay = (token: RecurrenceByDay): { ordinal?: string; weekday: RecurrenceWeekday } => {
    const match = /^(-?\d+)?([A-Z]{2})$/.exec(token);
    if (!match) return { weekday: token as RecurrenceWeekday };
    return { ordinal: match[1], weekday: match[2] as RecurrenceWeekday };
};

/**
 * One-sentence resting-state description of a recurrence rule, built from the
 * parsed rule values rather than the RRULE string.
 */
export function formatRecurrenceSummary(
    input: RecurrenceSummaryInput,
    t: (key: string) => string,
    language: string,
): string {
    const interval = Math.max(Math.round(input.interval ?? 1), 1);
    const shortWeekdays = getLocalizedWeekdayLabels(language, 'short');
    const longWeekdays = getLocalizedWeekdayLabels(language, 'long');
    const parsedByDay = (input.byDay ?? []).map(splitByDay);
    const ordinalDays = parsedByDay.filter((day) => day.ordinal);

    let frequency = interval > 1
        ? `${t('recurrence.repeatEvery')} ${interval} ${t(RULE_UNIT_KEY[input.rule])}`
        : t(RULE_LABEL_KEY[input.rule]);
    if (parsedByDay.length > 0 && ordinalDays.length === 0) {
        const days = parsedByDay.map((day) => shortWeekdays[day.weekday] ?? day.weekday).join(', ');
        frequency = `${frequency} ${formatI18nTemplate(t('recurrence.summaryOnDays'), { days })}`;
    }

    const segments = [frequency];

    if (ordinalDays.length > 0) {
        segments.push(ordinalDays.map((day) => formatI18nTemplate(t('recurrence.onNthWeekday'), {
            ordinal: t(ORDINAL_LABEL_KEY[day.ordinal ?? ''] ?? ''),
            weekday: longWeekdays[day.weekday] ?? day.weekday,
        })).join(', '));
    } else if ((input.byMonthDay ?? []).length > 0) {
        const monthDays = input.byMonthDay ?? [];
        // A list of plain days reads better collapsed ("on 1, 16") than repeated
        // ("Day 1, Day 16"); -1 keeps its own phrasing.
        segments.push(monthDays.length > 1 && !monthDays.includes(-1)
            ? formatI18nTemplate(t('recurrence.summaryOnDays'), { days: monthDays.join(', ') })
            : monthDays
                .map((day) => (day === -1
                    ? t('recurrence.lastDayOfMonth')
                    : formatI18nTemplate(t('recurrence.onDayOfMonth'), { day })))
                .join(', '));
    }

    const endsValue = input.count
        ? formatRecurrenceCountLabel(input.count, input.completedOccurrences, t)
        : input.until
            ? safeFormatDate(input.until, 'PP', input.until)
            : t('recurrence.endsNever');
    segments.push(`${t('recurrence.endsLabel')}: ${endsValue}`);

    if (input.strategy === 'fluid') {
        segments.push(t('recurrence.afterCompletionShort'));
    }

    return segments.join(' · ');
}
