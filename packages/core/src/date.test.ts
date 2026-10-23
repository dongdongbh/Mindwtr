import { afterEach, describe, it, expect } from 'vitest';
import { isValid, parseISO } from 'date-fns';
import { buildCompletionDateSections } from './completion-grouping';
import { createTaskDraft, setTaskDraftField, taskDraftToChangedUpdatePatch, toTaskDraftDateTimeLocalValue } from './task-draft';
import type { Task } from './types';
import { parseQuickAdd } from './quick-add';
import {
    canUseJalaliCalendar,
    configureDateFormatting,
    createDateFormatter,
    getDateFormattingConfig,
    isActiveDateFormatDayFirst,
    isLocaleDateDayFirst,
    formatCalendarInputDate,
    getQuickDate,
    getWeekStartsOnIndex,
    isDueForReview,
    isQuickDatePresetSelected,
    normalizeClockTimeInput,
    normalizeCalendarSystemSetting,
    normalizeDateFormatSetting,
    normalizeTimeFormatSetting,
    getSystemWeekStart,
    setHostSystemLocale,
    getShortWeekdayLabels,
    normalizeWeekStartPreference,
    normalizeWeekStartSetting,
    parseCalendarInputDate,
    resolveCalendarSystemSetting,
    resolveDateLocaleTag,
    safeFormatDate,
    safeParseDate,
} from './date';

describe('date utils', () => {
    it.each(['system', 'ymd'])('falls back to the app language for invalid system locales with %s dates', (dateFormat) => {
        for (const systemLocale of ['C', 'C.UTF-8', 'en_US.UTF-8', '@invalid']) {
            const locale = resolveDateLocaleTag({ language: 'de', dateFormat, systemLocale });
            expect(locale).toBe('de-DE');
            expect(() => new Intl.DateTimeFormat(locale).format(new Date(2026, 3, 19))).not.toThrow();
        }
    });

    it('validates locales when the host has DateTimeFormat without getCanonicalLocales', () => {
        const canonicalLocales = Intl.getCanonicalLocales;
        Object.defineProperty(Intl, 'getCanonicalLocales', { value: undefined, configurable: true, writable: true });
        try {
            expect(resolveDateLocaleTag({ language: 'en', systemLocale: 'C' })).toBe('en-US');
            expect(resolveDateLocaleTag({ language: 'en', systemLocale: 'de_DE-u-hc-h23' })).toBe('de-DE-u-hc-h23');
        } finally {
            Object.defineProperty(Intl, 'getCanonicalLocales', { value: canonicalLocales });
        }
    });

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

    // #766: full ISO instants take a Date.parse fast path instead of parseISO.
    // It has to agree with parseISO exactly — including on the shapes it must
    // decline and hand back to the general path.
    it.each([
        '2025-01-02T03:04:05.678Z',
        '2025-01-02T03:04:05Z',
        '2025-01-02T03:04Z',
        '2025-01-02T03:04:05.678+05:30',
        '2025-01-02T03:04:05-08:00',
        '2024-02-29T23:59:59.999Z',
        '2025-03-30T01:30:00.000+01:00',
        '2025-01-02T03:04:05+0530',
        '2025-01-02 03:04:05Z',
        '2025-01-02T03:04:05.678901Z',
        '2025-13-02T03:04:05Z',
        '2025-02-30T10:00:00Z',
        '2025-04-31T10:00:00.5+02:00',
    ])('parses %s identically to parseISO', (value) => {
        const parsed = safeParseDate(value);
        const reference = parseISO(value);
        if (!isValid(reference)) {
            expect(parsed).toBeNull();
            return;
        }
        expect(parsed?.getTime()).toBe(reference.getTime());
    });

    // The instant fast path already rejects these; the date-only/local branch used
    // to let `new Date(y, m, d)` roll them into the next month instead.
    it.each([
        '2024-02-31',
        '2025-02-29',
        '2025-04-31',
        '2025-13-02',
        '2025-00-10',
        '2025-06-00',
        '2024-02-31T10:00',
    ])('rejects the calendar-invalid local value %s', (value) => {
        expect(safeParseDate(value)).toBeNull();
    });

    it('still accepts a real leap day as a date-only value', () => {
        const parsed = safeParseDate('2024-02-29');
        expect(parsed?.getMonth()).toBe(1);
        expect(parsed?.getDate()).toBe(29);
    });

    it('preserves years below 100 instead of coercing to 19xx', () => {
        const parsed = safeParseDate('0002-01-03');
        expect(parsed).not.toBeNull();
        if (!parsed) return;
        expect(parsed.getFullYear()).toBe(2);
        expect(parsed.getMonth()).toBe(0);
        expect(parsed.getDate()).toBe(3);
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

    it('gates Jalali calendar support to Persian locales', () => {
        expect(normalizeCalendarSystemSetting('solar-hijri')).toBe('jalali');
        expect(resolveCalendarSystemSetting('jalali', { language: 'en', systemLocale: 'en-US' })).toBe('gregorian');
        expect(resolveCalendarSystemSetting('jalali', { language: 'en', systemLocale: 'fa-IR' })).toBe('jalali');
        expect(resolveDateLocaleTag({
            language: 'en',
            dateFormat: 'system',
            calendarSystem: 'jalali',
            systemLocale: 'fa-IR',
        })).toBe('fa-IR-u-ca-persian');
    });

    // add-persian-20260730-14: pins that selecting Persian as the APP LANGUAGE
    // (not just an already-Persian system locale) flows through to Jalali date
    // resolution. System locale is deliberately English here so this fails if
    // 'fa' language support were ever dropped from isPersianLocaleTag/date
    // locale resolution while system-locale-driven detection kept working.
    it('flows the Persian app language into Jalali date-locale resolution', () => {
        expect(canUseJalaliCalendar({ language: 'fa', systemLocale: 'en-US' })).toBe(true);
        expect(resolveCalendarSystemSetting('jalali', { language: 'fa', systemLocale: 'en-US' })).toBe('jalali');
        expect(resolveDateLocaleTag({
            language: 'fa',
            dateFormat: 'system',
            calendarSystem: 'jalali',
            systemLocale: 'en-US',
        })).toBe('fa-IR-u-ca-persian');
    });

    it('normalizes time format settings safely', () => {
        expect(normalizeTimeFormatSetting('12h')).toBe('12h');
        expect(normalizeTimeFormatSetting('24-hour')).toBe('24h');
        expect(normalizeTimeFormatSetting('unknown')).toBe('system');
    });

    it('normalizes week start settings safely', () => {
        expect(normalizeWeekStartSetting('monday')).toBe('monday');
        expect(normalizeWeekStartSetting('saturday')).toBe('saturday');
        expect(normalizeWeekStartSetting('sunday')).toBe('sunday');
        // Absent, 'system', and invalid values follow the device locale.
        expect(normalizeWeekStartSetting('friday')).toBe(getSystemWeekStart());
        expect(normalizeWeekStartSetting('system')).toBe(getSystemWeekStart());
        expect(normalizeWeekStartSetting(undefined)).toBe(getSystemWeekStart());
        expect(getWeekStartsOnIndex('monday')).toBe(1);
        expect(getWeekStartsOnIndex('saturday')).toBe(6);
    });

    it('keeps the stored week start preference distinct from the resolved value', () => {
        expect(normalizeWeekStartPreference('monday')).toBe('monday');
        expect(normalizeWeekStartPreference('sunday')).toBe('sunday');
        expect(normalizeWeekStartPreference('system')).toBe('system');
        expect(normalizeWeekStartPreference(undefined)).toBe('system');
        expect(normalizeWeekStartPreference('friday')).toBe('system');
    });

    it('infers the week start from the locale', () => {
        expect(getSystemWeekStart('de-DE')).toBe('monday');
        expect(getSystemWeekStart('fr-FR')).toBe('monday');
        expect(getSystemWeekStart('en-US')).toBe('sunday');
        expect(getSystemWeekStart('ja-JP')).toBe('sunday');
        expect(getSystemWeekStart('pt-BR')).toBe('sunday');
        expect(getSystemWeekStart('ar-EG')).toBe('saturday');
        expect(getSystemWeekStart('fa-IR')).toBe('saturday');
        // No region and no week info still lands on a sane default.
        expect(['monday', 'sunday', 'saturday']).toContain(getSystemWeekStart('en'));
    });

    it('normalizes clock time inputs for stored schedule defaults', () => {
        expect(normalizeClockTimeInput('9:05')).toBe('09:05');
        expect(normalizeClockTimeInput('905')).toBe('09:05');
        expect(normalizeClockTimeInput(' 1730 ')).toBe('17:30');
        expect(normalizeClockTimeInput('')).toBe('');
        expect(normalizeClockTimeInput('24:00')).toBeNull();
        expect(normalizeClockTimeInput('9am')).toBeNull();
    });

    it('resolves locale tags from language + format preferences', () => {
        expect(resolveDateLocaleTag({ language: 'en', dateFormat: 'dmy', systemLocale: 'en-US' })).toBe('en-GB');
        expect(resolveDateLocaleTag({ language: 'en', dateFormat: 'mdy', systemLocale: 'en-GB' })).toBe('en-US');
        expect(resolveDateLocaleTag({ language: 'de', dateFormat: 'ymd', systemLocale: 'de-DE' })).toBe('de-DE');
        expect(resolveDateLocaleTag({ language: 'de', dateFormat: 'system', systemLocale: 'de-DE' })).toBe('de-DE');
        expect(resolveDateLocaleTag({ language: 'pl', dateFormat: 'system' })).toBe('pl-PL');
        expect(resolveDateLocaleTag({ language: 'nl', dateFormat: 'system' })).toBe('nl-NL');
    });

    it.each([
        ['zh', 'zh-Hans-CN'],
        ['zh-Hant', 'zh-Hant-TW'],
    ])('resolves explicit Chinese script tags for %s on language-based Intl paths', (language, tag) => {
        expect([
            resolveDateLocaleTag({ language, dateFormat: 'dmy', systemLocale: 'en-US' }),
            resolveDateLocaleTag({ language, dateFormat: 'ymd' }),
            resolveDateLocaleTag({ language, dateFormat: 'system' }),
        ]).toEqual([tag, tag, tag]);
    });

    // One rule for "does this locale write the day first", so a headless caller
    // (the widget payload, built with no app configured) cannot disagree with
    // the app. Note en-ZA: this repo calls it day-first, CLDR does not.
    it('answers day-first for a locale tag without any configured state', () => {
        expect(isLocaleDateDayFirst('en-GB')).toBe(true);
        expect(isLocaleDateDayFirst('en-ZA')).toBe(true);
        expect(isLocaleDateDayFirst('en-AU')).toBe(true);
        expect(isLocaleDateDayFirst('de-DE')).toBe(true);
        expect(isLocaleDateDayFirst('en-US')).toBe(false);
        expect(isLocaleDateDayFirst('ja-JP')).toBe(false);
        expect(isLocaleDateDayFirst('not a locale')).toBe(false);
        expect(isLocaleDateDayFirst(undefined)).toBe(false);
    });

    it('gives the System date format the same answer as the pure locale check', () => {
        for (const systemLocale of ['en-ZA', 'en-GB', 'en-US', 'de-DE', 'ja-JP']) {
            configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale });
            expect(isActiveDateFormatDayFirst()).toBe(isLocaleDateDayFirst(systemLocale));
        }
        configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
    });

    it('applies explicit time-format overrides to localized time tokens', () => {
        configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: '24h', systemLocale: 'en-US' });
        expect(safeFormatDate('2025-01-02T15:04:00', 'p')).toBe('15:04');

        configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: '12h', systemLocale: 'en-US' });
        expect(safeFormatDate('2025-01-02T15:04:00', 'p')).toBe('03:04 PM');

        configureDateFormatting({ language: 'en', dateFormat: 'ymd', timeFormat: '24h', systemLocale: 'en-US' });
        expect(safeFormatDate('2025-01-02T15:04:00', 'Pp')).toBe('2025-01-02 15:04');
    });

    it('preserves the native System short-date pattern on an English German device', () => {
        const config = { language: 'en', dateFormat: 'system', systemLocale: 'en-DE', systemDateFormat: 'dd.MM.yyyy' };
        const formatter = createDateFormatter(config);
        expect(formatter('2026-09-22', 'P')).toBe('22.09.2026');
        expect(formatter('2026-09-22T15:04', 'Pp')).toBe('22.09.2026, 3:04 PM');
        expect(formatter('2026-09-22', 'PP')).toBe('Sep 22, 2026');
        expect(formatter('2026-09-22', 'yyyy-MM-dd')).toBe('2026-09-22');
        expect(formatter('2026-09-22', "'P' yyyy-MM-dd")).toBe('P 2026-09-22');
        configureDateFormatting(config);
        expect(safeFormatDate('2026-09-22', 'P')).toBe('22.09.2026');
        expect(isActiveDateFormatDayFirst()).toBe(true);
        configureDateFormatting({ systemLocale: 'en-US' });
    });

    it.each(['dmy', 'mdy', 'ymd'])('keeps the explicit %s date choice ahead of the native pattern', (dateFormat) => {
        const formatter = createDateFormatter({ language: 'en', dateFormat, systemLocale: 'en-DE', systemDateFormat: 'dd.MM.yyyy' });
        expect(formatter('2026-09-22', 'P')).toBe({ dmy: '22/09/2026', mdy: '09/22/2026', ymd: '2026-09-22' }[dateFormat]);
    });

    it.each([null, '', 'not a pattern', 'yyyy-MM', 'yyyy-MM-dd HH:mm', 'yyyy-MM-dd-yyyy', 'yyyy-\'unterminated-MM-dd', 'yy/MM/dd', 'yy.MM.dd'])('falls back safely for unsupported native patterns: %s', (systemDateFormat) => {
        expect(createDateFormatter({ systemLocale: 'en-US', systemDateFormat })('2026-09-22', 'P')).toBe('09/22/2026');
    });

    it.each([
        ['d.M.yy', '2.1.25'],
        ["yyyy'年'M'月'd'日'", '2025年1月2日'],
        ['d\u200f/M\u200f/yyyy', '2\u200f/1\u200f/2025'],
        ['yyyy/MM/dd', '2025/01/02'],
    ])('preserves native field widths and literals in %s', (systemDateFormat, expected) => {
        expect(createDateFormatter({ systemLocale: 'en-DE', systemDateFormat })('2025-01-02', 'P')).toBe(expected);
    });

    it('keeps Jalali formatting ahead of the Gregorian native pattern', () => {
        const formatter = createDateFormatter({ language: 'fa', calendarSystem: 'jalali', systemDateFormat: 'dd.MM.yyyy' });
        expect(formatter('2025-03-21', 'P')).toBe('1404/01/01');
    });

    it.each(['dd.MM.yyyy', 'dd.MM.yy', 'yyyy/MM/dd', 'yy/MM/dd', 'yy.MM.dd'])('round-trips displayed System dates through quick-add for %s', (systemDateFormat) => {
        configureDateFormatting({ language: 'en', systemLocale: 'en-DE', systemDateFormat });
        const displayed = safeFormatDate('2026-08-10', 'P');
        expect(parseQuickAdd(`Task /due:${displayed}`, undefined, new Date(2026, 0, 1)).props.dueDate).toBe('2026-08-10');
        configureDateFormatting({ systemLocale: 'en-US' });
    });

    it('formats Jalali localized dates without changing stored ISO date output', () => {
        configureDateFormatting({
            language: 'en',
            dateFormat: 'system',
            calendarSystem: 'jalali',
            timeFormat: 'system',
            systemLocale: 'fa-IR',
        });
        expect(safeFormatDate('2025-03-21', 'P')).toBe('1404/01/01');
        expect(safeFormatDate('2025-03-21', 'yyyy-MM-dd')).toBe('2025-03-21');
        expect(safeFormatDate('2025-03-21T08:00:00', "yyyy-MM-dd'T'HH:mm")).toBe('2025-03-21T08:00');
        expect(safeFormatDate('2025-03-21T08:00:05', 'yyyyMMdd-HHmmss')).toBe('20250321-080005');
        expect(safeFormatDate('2025-03-21', 'LLLL yyyy')).toBe('مارس 2025');
        expect(buildCompletionDateSections({ tasks: [{ completedAt: '2025-03-21T08:00:00' }], t: (key) => key, now: new Date('2025-05-01') })[0].title).toBe('مارس 2025');
        const source: Task = { id: 'jalali-draft', title: 'Task', status: 'next', contexts: [], tags: [], createdAt: '', updatedAt: '', dueDate: '2025-03-21T08:00:00' };
        expect(toTaskDraftDateTimeLocalValue(source.dueDate)).toBe('2025-03-21T08:00');
        const draft = setTaskDraftField(createTaskDraft(source), 'dueDate', '2025-03-21T09:00');
        expect(taskDraftToChangedUpdatePatch(draft, source)?.dueDate).toBe('2025-03-21T09:00');
        expect(formatCalendarInputDate('2025-03-21', 'jalali')).toBe('1404-01-01');
        expect(parseCalendarInputDate('1404-01-01', 'jalali')).toBe('2025-03-21');

        configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
    });

    // Portuguese resolves to BRAZILIAN conventions in both formatting paths:
    // DATE_LOCALE_BY_LANGUAGE gives date-fns `ptBR`, LOCALE_TAG_BY_LANGUAGE gives Intl
    // `pt-BR`. That is a deliberate product choice, not an oversight to "fix" back to
    // pt-PT — the two paths render into the same screens, so they must agree, and
    // Brazilian serves by far the larger share of Portuguese speakers.
    it('keeps Portuguese on Brazilian conventions in both formatting paths', () => {
        expect(resolveDateLocaleTag({ language: 'pt', dateFormat: 'dmy' })).toBe('pt-BR');

        configureDateFormatting({ language: 'pt', dateFormat: 'dmy', timeFormat: 'system' });
        // ptBR: "8 ago 2026". European pt would be "8 de ago. de 2026".
        expect(safeFormatDate('2026-08-08', 'PP')).toBe('8 ago 2026');
        // ptBR drops the accent European Portuguese keeps. This pins the locale's
        // identity, not a rendered string: the app formats weekdays with 'EEEE'
        // (full name, accented in both) and takes short labels from CLDR, so
        // 'EEEEEE' never reaches a screen.
        expect(safeFormatDate('2026-08-08', 'EEEEEE')).toBe('sab');

        configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
    });

    it('formats Ukrainian dates with Ukrainian month forms and region tag', () => {
        expect(resolveDateLocaleTag({ language: 'uk', dateFormat: 'dmy', systemLocale: 'en-US' })).toBe('uk-UA');
        configureDateFormatting({ language: 'uk', dateFormat: 'dmy', timeFormat: 'system', systemLocale: 'uk-UA' });
        expect(safeFormatDate('2026-08-08', 'PP')).toBe('8 серп. 2026 р.');
        expect(safeFormatDate('2026-08-08', 'PPPP')).toContain('серпня');
        configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
    });

    it('formats with an explicit configuration without touching the configured one', () => {
        const german = { language: 'de', dateFormat: 'dmy', timeFormat: '24h', systemLocale: 'de-DE' };
        configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
        expect(createDateFormatter(german)('2026-08-08T14:05', 'Pp')).toBe('08.08.2026 14:05');
        expect(safeFormatDate('2026-08-08T14:05', 'Pp')).toBe('08/08/2026, 2:05 PM');
        expect(getDateFormattingConfig()).toEqual({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
        configureDateFormatting(german);
        expect(safeFormatDate('2026-08-08T14:05', 'Pp')).toBe(createDateFormatter(german)('2026-08-08T14:05', 'Pp'));
        expect(createDateFormatter({ language: 'fa', calendarSystem: 'jalali' })('2026-08-08', 'P')).toBe('1405/05/17');
        const jalali = createDateFormatter({ language: 'fa', calendarSystem: 'jalali' });
        expect(jalali('2025-03-21', 'LLLL yyyy')).toBe('مارس 2025');
        expect(createDateFormatter({ language: 'fa', calendarSystem: 'jalali' }, { jalaliMonthNames: true })('2025-03-21', 'LLLL yyyy')).toBe('فروردین 1404');
        expect(createDateFormatter({})(undefined, 'P', 'none')).toBe('none');
        configureDateFormatting({ language: 'en', dateFormat: 'system', timeFormat: 'system', systemLocale: 'en-US' });
    });

    it('detects when a review date is due', () => {
        const now = new Date('2025-01-10T10:00:00Z');
        expect(isDueForReview('2025-01-10T09:00:00Z', now)).toBe(true);
        expect(isDueForReview('2025-01-10T11:00:00Z', now)).toBe(false);
    });

    it('resolves quick date presets from the local start of today', () => {
        const now = new Date(2026, 4, 12, 15, 30);
        expect(getQuickDate('today', now)).toEqual(new Date(2026, 4, 12));
        expect(getQuickDate('tomorrow', now)).toEqual(new Date(2026, 4, 13));
        expect(getQuickDate('in_2_days', now)).toEqual(new Date(2026, 4, 14));
        expect(getQuickDate('in_3_days', now)).toEqual(new Date(2026, 4, 15));
        expect(getQuickDate('next_week', now)).toEqual(new Date(2026, 4, 18));
        expect(getQuickDate('next_month', now)).toEqual(new Date(2026, 5, 1));
        expect(getQuickDate('no_date', now)).toBeNull();
    });

    it('treats next week as the next Monday even when today is Monday', () => {
        const monday = new Date(2026, 4, 11, 8, 0);
        expect(getQuickDate('next_week', monday)).toEqual(new Date(2026, 4, 18));
    });

    it('matches selected dates against quick date presets', () => {
        const now = new Date(2026, 4, 12, 15, 30);
        expect(isQuickDatePresetSelected('tomorrow', new Date(2026, 4, 13, 21, 45), now)).toBe(true);
        expect(isQuickDatePresetSelected('tomorrow', new Date(2026, 4, 14), now)).toBe(false);
        expect(isQuickDatePresetSelected('no_date', null, now)).toBe(false);
    });
});

describe('getShortWeekdayLabels (#929)', () => {
    // Guard the environment first: if this fails, the test runner's ICU
    // lacks locale data and every expectation below would silently degrade
    // rather than genuinely pass.
    it('is byte-identical to today for English', () => {
        expect(getShortWeekdayLabels('en-US')).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    });

    it('starts on Sunday after the time zone changes (no load-time anchor date)', () => {
        const originalTz = process.env.TZ;
        try {
            // Fresh locales, so the per-locale cache cannot answer from an earlier zone.
            for (const [zone, locale] of [['Pacific/Kiritimati', 'en-AU'], ['Pacific/Pago_Pago', 'en-NZ']]) {
                process.env.TZ = zone;
                expect(getShortWeekdayLabels(locale)[0]).toBe('Sun');
            }
        } finally {
            if (originalTz === undefined) delete process.env.TZ;
            else process.env.TZ = originalTz;
        }
    });

    it('returns Sunday at index 0', () => {
        const labels = getShortWeekdayLabels('en-US');
        const sunday = new Date(2023, 0, 1); // Jan 1, 2023 was a Sunday
        expect(sunday.getDay()).toBe(0);
        expect(labels[sunday.getDay()]).toBe('Sun');
    });

    it.each([
        ['pt-PT', ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']], // full words truncate to three
        ['pt-BR', ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']], // already short, just loses the period
        ['fr-FR', ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam']], // trailing periods stripped
        ['pl', ['nie', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob']],
        ['hi', ['रवि', 'सोम', 'मंग', 'बुध', 'गुर', 'शुक', 'शनि']],
    ])('truncates %s to three graphemes without collisions', (locale, expected) => {
        expect(getShortWeekdayLabels(locale)).toEqual(expected);
    });

    it('falls back to narrow for Vietnamese, where truncation collides', () => {
        expect(getShortWeekdayLabels('vi')).toEqual(['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
    });

    it('falls back to narrow for Arabic, where truncation collides', () => {
        expect(getShortWeekdayLabels('ar')).toEqual(['ح', 'ن', 'ث', 'ر', 'خ', 'ج', 'س']);
    });
});

describe('host system locale for week start', () => {
    afterEach(() => setHostSystemLocale(null));

    it('uses the locale a native host passed when the runtime gives none', () => {
        // A native host (QuickJS) has no Intl locale; core must use the device locale the host sent.
        setHostSystemLocale('de-DE');
        expect(getSystemWeekStart()).toBe('monday');
        setHostSystemLocale('en-US');
        expect(getSystemWeekStart()).toBe('sunday');
        expect(getWeekStartsOnIndex('system')).toBe(0);
        setHostSystemLocale('ar-EG');
        expect(getSystemWeekStart()).toBe('saturday');
    });

    it('lets an explicit locale argument win over the host locale', () => {
        setHostSystemLocale('en-US');
        expect(getSystemWeekStart('de-DE')).toBe('monday');
    });
});
