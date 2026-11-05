import { describe, expect, it } from 'vitest';

import { joinDateTimeLocal, parseDateTimeLocalDate, splitDateTimeLocal } from './datetime-local-value';

describe('splitDateTimeLocal', () => {
    it('splits a datetime-local value into its halves', () => {
        expect(splitDateTimeLocal('2026-04-22T09:30')).toEqual({ date: '2026-04-22', time: '09:30' });
    });

    it('drops a seconds component the time input cannot edit', () => {
        expect(splitDateTimeLocal('2026-04-22T09:30:45')).toEqual({ date: '2026-04-22', time: '09:30' });
    });

    it('returns empty halves for missing or malformed input', () => {
        expect(splitDateTimeLocal('')).toEqual({ date: '', time: '' });
        expect(splitDateTimeLocal('not-a-date')).toEqual({ date: '', time: '' });
        expect(splitDateTimeLocal('2026-04-22')).toEqual({ date: '2026-04-22', time: '' });
        expect(splitDateTimeLocal('2026-4-2T9:3')).toEqual({ date: '', time: '' });
    });
});

describe('joinDateTimeLocal', () => {
    it('rejoins both halves', () => {
        expect(joinDateTimeLocal({ date: '2026-04-22', time: '09:30' })).toBe('2026-04-22T09:30');
    });

    it('defaults a missing time to midnight so a date-only pick still commits', () => {
        expect(joinDateTimeLocal({ date: '2026-04-22', time: '' })).toBe('2026-04-22T00:00');
    });

    it('yields nothing without a date, since a bare time is not a point in time', () => {
        expect(joinDateTimeLocal({ date: '', time: '09:30' })).toBe('');
    });

    it('round-trips a value unchanged', () => {
        const value = '2026-12-31T23:59';
        expect(joinDateTimeLocal(splitDateTimeLocal(value))).toBe(value);
    });
});

describe('parseDateTimeLocalDate', () => {
    it('returns the date half as a local Date', () => {
        const parsed = parseDateTimeLocalDate('2026-04-22T09:30');
        expect(parsed?.getFullYear()).toBe(2026);

        expect(parsed?.getMonth()).toBe(3);
        expect(parsed?.getDate()).toBe(22);
    });

    it('returns null when there is no usable date', () => {
        expect(parseDateTimeLocalDate('')).toBeNull();
        expect(parseDateTimeLocalDate('nonsense')).toBeNull();
    });
});
