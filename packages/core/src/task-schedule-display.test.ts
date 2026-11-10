import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDateFormatter, safeParseDate, type DateFormattingConfig } from './date';
import { formatTaskScheduleDisplay } from './task-schedule-display';

const originalTimezone = process.env.TZ;
const dateFormatting: DateFormattingConfig = { language: 'en', dateFormat: 'ymd', timeFormat: '24h', calendarSystem: 'gregorian' };
const labels: Record<string, string> = { 'quickDate.today': 'Today', 'quickDate.tomorrow': 'Tomorrow' };
const t = (key: string) => labels[key] ?? key;
const display = (value: string | undefined, options: Partial<Parameters<typeof formatTaskScheduleDisplay>[0]> = {}) =>
    formatTaskScheduleDisplay({ value, kind: 'start', relative: true, now: new Date(2026, 10, 10, 12), dateFormatting, t, ...options });

beforeEach(() => { process.env.TZ = 'UTC'; });
afterEach(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
});

describe('Focus schedule date presentation', () => {
    it.each([
        ['2026-11-10', 'Today'], ['2026-11-11', 'Tomorrow'], ['2026-11-12', 'Thursday'],
        ['2026-11-16', 'Monday'], ['2026-11-17', '2026-11-17'], ['2026-11-09', '2026-11-09'],
    ])('formats %s without changing its exact date', (value, label) => {
        for (const kind of ['start', 'due'] as const) {
            expect(display(value, { kind })).toEqual({ label, exactLabel: value });
            expect(display(value, { kind, relative: false })).toEqual({ label: value, exactLabel: value });
        }
    });

    it('preserves explicit clock times and never adds one to a date-only value', () => {
        expect(display('2026-11-12T14:30:00')?.label).toBe('Thursday · 14:30');
        expect(display('2026-11-12T14:30:00', { kind: 'due' })?.exactLabel).toContain('14:30');
        expect(display('2026-11-12')?.label).toBe('Thursday');
        expect(display('2026-11-12', { kind: 'due' })?.label).not.toMatch(/·|00:00/);
        expect(display('2026-11-12T14:30:00', { relative: false })?.label).toBe(display('2026-11-12T14:30:00')?.exactLabel);
    });

    it.each([undefined, '', 'not a date'])('omits an unparseable value %s', (value) => {
        expect(display(value)).toBeNull();
        expect(display(value, { kind: 'due' })).toBeNull();
    });

    it('uses the nearest full weekday across week, month and year boundaries', () => {
        expect(display('2026-11-10', { now: new Date(2026, 10, 8, 12) })?.label).toBe('Tuesday');
        expect(display('2027-01-01', { now: new Date(2026, 11, 31, 12) })?.label).toBe('Tomorrow');
        expect(display('2027-01-02', { now: new Date(2026, 11, 31, 12) })?.label).toBe('Saturday');
    });

    it('uses existing weekday, calendar and time preferences', () => {
        expect(display('2026-11-12', { dateFormatting: { ...dateFormatting, language: 'ja' } })?.label).toBe('木曜日');
        expect(display('2026-11-12', { dateFormatting: { ...dateFormatting, language: 'ar' } })?.label).toBe('الخميس');
        const jalali = { ...dateFormatting, calendarSystem: 'jalali', systemLocale: 'fa-IR' };
        const value = '2026-11-17';
        const parsed = safeParseDate(value);
        if (!parsed) throw new Error('Fixture date must parse');
        expect(display(value, { dateFormatting: jalali })?.label).toBe(createDateFormatter(jalali)(parsed, 'P'));
        expect(display(value, { dateFormatting: jalali })?.label).not.toBe(value);
        expect(display('2026-11-12', { dateFormatting: jalali })?.label).toBe(createDateFormatter(jalali)(new Date(2026, 10, 12), 'EEEE'));
        expect(display('2026-11-12T14:30:00', { dateFormatting: { ...dateFormatting, timeFormat: '12h' } })?.label).toMatch(/Thursday · 02:30\s?PM/);
    });

    it.each(['America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Honolulu'])('uses written local dates and instant-local dates in %s', (zone) => {
        process.env.TZ = zone;
        const now = new Date(2026, 10, 9, 12);
        expect(display('2026-11-10', { now })?.label).toBe('Tomorrow');
        expect(display('2026-11-10T09:15:00', { now })?.label).toBe('Tomorrow · 09:15');
        const expected = zone === 'Pacific/Kiritimati' ? 'Tomorrow' : 'Today';
        expect(display('2026-11-10T01:30:00Z', { now })?.label).toMatch(new RegExp(`^${expected} · `));
    });

    it.each([[2026, 2, 7], [2026, 9, 31]])('keeps calendar-day boundaries across DST (%s/%s/%s)', (year, month, day) => {
        process.env.TZ = 'America/New_York';
        const now = new Date(year, month, day, 12);
        const dateOnly = (offset: number) => {
            const date = new Date(year, month, day + offset);
            return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        };
        expect(display(dateOnly(1), { now })?.label).toBe('Tomorrow');
        expect(display(dateOnly(6), { now })?.label).not.toBe(dateOnly(6));
        expect(display(dateOnly(7), { now })?.label).toBe(dateOnly(7));
    });
});
