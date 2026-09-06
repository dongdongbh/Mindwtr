import { beforeAll, describe, expect, it } from 'vitest';
import { formatI18nTemplate, getEnglishI18nValue, getI18nKeyForEnglishText, getLocaleCoverageTier, getTranslator, resolveI18nText } from './index';
import { loadTranslations } from './i18n-loader';

describe('formatI18nTemplate', () => {
    it('replaces repeated named placeholders wherever translators place them', () => {
        expect(formatI18nTemplate('{{name}} löschen? {{ name }}', { name: 'Inbox' })).toBe('Inbox löschen? Inbox');
        expect(formatI18nTemplate('Plan for {date}', { date: 'Thu, Jul 30' })).toBe('Plan for Thu, Jul 30');
    });

    it('leaves unknown placeholders intact', () => {
        expect(formatI18nTemplate('Delete {{name}} from {{list}}?', { name: 'Inbox' })).toBe('Delete Inbox from {{list}}?');
    });
});

describe('getI18nKeyForEnglishText', () => {
    it('maps existing English locale text back to its typed key', () => {
        expect(getI18nKeyForEnglishText('Pomodoro timer')).toBe('settings.featurePomodoro');
        expect(getI18nKeyForEnglishText('Focus minutes')).toBe('settings.pomodoroFocusMinutes');
    });

    it('returns undefined for dynamic text that is not in the locale table', () => {
        expect(getI18nKeyForEnglishText('Backup date: 2026-01-01')).toBeUndefined();
    });
});

describe('getLocaleCoverageTier', () => {
    it('calls a locale held to every English key full', () => {
        // 'all' commitment, both load modes.
        expect(getLocaleCoverageTier('zh')).toBe('full');
        expect(getLocaleCoverageTier('sv')).toBe('full');
    });

    it('calls a locale with a low key floor partial', () => {
        // nl is the worst of them (~26% of en at time of writing).
        expect(getLocaleCoverageTier('nl')).toBe('partial');
    });

    it('treats English and unknown codes as full', () => {
        // en is not in LOCALES — it is the base dictionary, never a partial one.
        expect(getLocaleCoverageTier('en')).toBe('full');
        expect(getLocaleCoverageTier('kl')).toBe('full');
    });

    it('tracks the floor rather than a hand-kept list', () => {
        // vi sits just under 'all' but far above the ceiling; if this ever flips,
        // a floor moved and the label follows it automatically.
        expect(getLocaleCoverageTier('vi')).toBe('full');
        // de reached full key parity via override translations without an 'all' commitment.
        expect(getLocaleCoverageTier('de')).toBe('full');
    });
});

describe('getEnglishI18nValue', () => {
    it('returns English copy for a locale key', () => {
        expect(getEnglishI18nValue('settings.featurePomodoro')).toBe('Pomodoro timer');
        expect(getEnglishI18nValue('settings.missing')).toBeUndefined();
    });
});

describe('resolveI18nText', () => {
    // Both platforms' `t` returns the key itself when the locale has no entry.
    const miss = (key: string) => key;

    it('returns the translation when the locale has one', () => {
        const t = (key: string) => (key === 'settings.featurePomodoro' ? 'Pomodoro-Timer' : key);
        expect(resolveI18nText(t, 'settings.featurePomodoro')).toBe('Pomodoro-Timer');
    });

    it('prefers an explicit fallback over the English copy on a miss', () => {
        expect(resolveI18nText(miss, 'settings.featurePomodoro', { fallback: 'Timer' })).toBe('Timer');
    });

    it('falls back to the English copy, untouched, when no fallback is given', () => {
        expect(resolveI18nText(miss, 'settings.featurePomodoro')).toBe('Pomodoro timer');
    });

    it('returns the key itself when neither the locale nor en.ts knows it', () => {
        expect(resolveI18nText(miss, 'settings.missing')).toBe('settings.missing');
    });

    it('treats an empty translation as a miss', () => {
        expect(resolveI18nText(() => '', 'settings.featurePomodoro')).toBe('Pomodoro timer');
    });

    it('fills template values in both the translation and the fallback', () => {
        const t = (key: string) => (key === 'bulk.applied' ? '{{count}} ausgewählt' : key);
        expect(resolveI18nText(t, 'bulk.applied', { values: { count: 3 } })).toBe('3 ausgewählt');
        expect(resolveI18nText(miss, 'bulk.applied', { fallback: '{{count}} selected', values: { count: 3 } }))
            .toBe('3 selected');
    });
});

describe('getTranslator', () => {
    // getTranslationsSync serves from the loader cache and falls back to English until the
    // locale is loaded, so warm it the way every real caller does.
    beforeAll(async () => {
        await loadTranslations('nl');
    });

    // digest.focus is deliberately absent from nl and it — its translation equals English, and
    // copying it in trips the mirrored-English gate. A raw dict[key] read renders that as
    // "undefined" in a notification title; through the seam it must be the English string.
    it('falls back to English for a key an override locale omits', () => {
        expect(getTranslator('nl')('digest.focus')).toBe('Focus');
        expect(resolveI18nText(getTranslator('nl'), 'digest.focus', { fallback: 'Focus' })).toBe('Focus');
    });

    it('uses the locale translation when it has one', () => {
        expect(getTranslator('nl')('digest.overdue')).toBe('Te laat');
    });

    it('never returns undefined, for any key or any language', () => {
        expect(getTranslator('nl')('totally.unknown.key')).toBe('totally.unknown.key');
        expect(getTranslator('not-a-language')('digest.overdue')).toBe('Overdue');
    });
});
