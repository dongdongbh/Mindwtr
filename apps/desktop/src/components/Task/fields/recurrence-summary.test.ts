import { describe, expect, it } from 'vitest';

import { formatRecurrenceSummary } from './recurrence-summary';

const labels: Record<string, string> = {
    'recurrence.daily': 'Daily',
    'recurrence.weekly': 'Weekly',
    'recurrence.monthly': 'Monthly',
    'recurrence.yearly': 'Yearly',
    'recurrence.repeatEvery': 'Repeat every',
    'recurrence.dayUnit': 'day(s)',
    'recurrence.weekUnit': 'week(s)',
    'recurrence.monthUnit': 'month(s)',
    'recurrence.yearUnit': 'year(s)',
    'recurrence.summaryOnDays': 'on {{days}}',
    'recurrence.onDayOfMonth': 'Day {day}',
    'recurrence.lastDayOfMonth': 'Last day of the month',
    'recurrence.onNthWeekday': 'The {ordinal} {weekday}',
    'recurrence.ordinal.first': 'first',
    'recurrence.ordinal.last': 'last',
    'recurrence.endsLabel': 'Ends',
    'recurrence.endsNever': 'Never',
    'recurrence.endsAfterCount': 'After',
    'recurrence.occurrenceUnit': 'occurrence(s)',
    'recurrence.occurrenceProgressOf': 'of',
    'recurrence.afterCompletionShort': 'after completion',
};

const t = (key: string) => labels[key] ?? key;
const summarize = (input: Parameters<typeof formatRecurrenceSummary>[0]) =>
    formatRecurrenceSummary(input, t, 'en-US');

describe('formatRecurrenceSummary', () => {
    it('names the weekdays of a weekly BYDAY rule', () => {
        expect(summarize({ rule: 'weekly', strategy: 'strict', byDay: ['MO', 'TU'] }))
            .toBe('Weekly on Mon, Tue · Ends: Never');
    });

    it('spells out an interval greater than one', () => {
        expect(summarize({ rule: 'weekly', strategy: 'strict', interval: 2, byDay: ['WE'] }))
            .toBe('Repeat every 2 week(s) on Wed · Ends: Never');
    });

    it('summarizes a plain monthly rule', () => {
        expect(summarize({ rule: 'monthly', strategy: 'strict' })).toBe('Monthly · Ends: Never');
    });

    it('names the month day of a BYMONTHDAY rule', () => {
        expect(summarize({ rule: 'monthly', strategy: 'strict', byMonthDay: [15] }))
            .toBe('Monthly · Day 15 · Ends: Never');
    });

    it('reads a BYMONTHDAY of -1 as the last day of the month', () => {
        expect(summarize({ rule: 'monthly', strategy: 'strict', byMonthDay: [-1] }))
            .toBe('Monthly · Last day of the month · Ends: Never');
    });

    it('names the ordinal weekday of a monthly BYDAY rule', () => {
        expect(summarize({ rule: 'monthly', strategy: 'strict', byDay: ['-1FR'] }))
            .toBe('Monthly · The last Friday · Ends: Never');
    });

    it('shows the end date of an UNTIL rule', () => {
        expect(summarize({ rule: 'daily', strategy: 'strict', until: '2026-08-15' }))
            .toBe('Daily · Ends: Aug 15, 2026');
    });

    it('shows the occurrence count of a COUNT rule', () => {
        expect(summarize({ rule: 'daily', strategy: 'strict', count: 5 }))
            .toBe('Daily · Ends: After 5 occurrence(s)');
    });

    it('shows progress against the count once occurrences are completed', () => {
        expect(summarize({ rule: 'daily', strategy: 'strict', count: 10, completedOccurrences: 6 }))
            .toBe('Daily · Ends: After 6 of 10 occurrence(s)');
        expect(summarize({ rule: 'daily', strategy: 'strict', count: 10, completedOccurrences: 0 }))
            .toBe('Daily · Ends: After 10 occurrence(s)');
    });

    it('flags the after-completion strategy', () => {
        expect(summarize({ rule: 'daily', strategy: 'fluid' }))
            .toBe('Daily · Ends: Never · after completion');
    });
});
