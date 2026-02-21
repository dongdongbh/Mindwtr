import { describe, it, expect } from 'vitest';
import { safeFormatDate, safeParseDate, isDueForReview, normalizeDateFormatSetting, resolveDateLocaleTag } from './date';

describe('date utils', () => {
    it('parses date-only strings as local dates', () => {
        const parsed = safeParseDate('2025-01-02');
        expect(parsed).not.toBeNull();
        if (!parsed) return;
        expect(parsed.getFullYear()).toBe(2025);
        expect(parsed.getMonth()).toBe(0);
        expect(parsed.getDate()).toBe(2);
    });

    it('parses datetime strings without timezone', () => {
        const parsed = safeParseDate('2025-01-02T03:04:05');
        expect(parsed).not.toBeNull();
        if (!parsed) return;
        expect(parsed.getFullYear()).toBe(2025);
        expect(parsed.getMonth()).toBe(0);
        expect(parsed.getDate()).toBe(2);
        expect(parsed.getHours()).toBe(3);
        expect(parsed.getMinutes()).toBe(4);
    });

    it('formats valid dates and falls back on invalid input', () => {
        const formatted = safeFormatDate('2025-01-02', 'yyyy-MM-dd', 'fallback');
        expect(formatted).toBe('2025-01-02');
        const fallback = safeFormatDate('not-a-date', 'yyyy-MM-dd', 'fallback');
        expect(fallback).toBe('fallback');
    });

    it('normalizes date format settings safely', () => {
        expect(normalizeDateFormatSetting('dmy')).toBe('dmy');
        expect(normalizeDateFormatSetting('mdy')).toBe('mdy');
        expect(normalizeDateFormatSetting('yyyy-MM-dd')).toBe('ymd');
        expect(normalizeDateFormatSetting('unknown')).toBe('system');
    });

    it('resolves locale tags from language + format preferences', () => {
        expect(resolveDateLocaleTag({ language: 'en', dateFormat: 'dmy', systemLocale: 'en-US' })).toBe('en-GB');
        expect(resolveDateLocaleTag({ language: 'en', dateFormat: 'mdy', systemLocale: 'en-GB' })).toBe('en-US');
        expect(resolveDateLocaleTag({ language: 'de', dateFormat: 'ymd', systemLocale: 'de-DE' })).toBe('de-DE');
        expect(resolveDateLocaleTag({ language: 'de', dateFormat: 'system', systemLocale: 'de-DE' })).toBe('de-DE');
        expect(resolveDateLocaleTag({ language: 'pl', dateFormat: 'system' })).toBe('pl-PL');
    });

    it('detects when a review date is due', () => {
        const now = new Date('2025-01-10T10:00:00Z');
        expect(isDueForReview('2025-01-10T09:00:00Z', now)).toBe(true);
        expect(isDueForReview('2025-01-10T11:00:00Z', now)).toBe(false);
    });
});
