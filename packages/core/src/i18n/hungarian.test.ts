import { afterEach, describe, expect, it } from 'vitest';
import { configureDateFormatting, resolveDateLocaleTag, safeFormatDate, safeParseDate } from '../date';
import { parseQuickAdd } from '../quick-add';
import { loadTranslations } from './i18n-loader';
import { loadStoredLanguage, loadStoredLanguageSync } from './i18n-storage';
import { huOverrides } from './locales/hu';

afterEach(() => configureDateFormatting());

describe('Hungarian language support', () => {
    it('loads Hungarian strings on demand', async () => {
        const strings = await loadTranslations('hu');
        expect(strings['nav.settings']).toBe('Beállítások');
        expect(strings['settings.language']).toBe('Nyelv');
    });

    it('preserves a saved Hungarian selection over an English fallback', async () => {
        expect(loadStoredLanguageSync({ getItem: () => 'hu', setItem: () => undefined }, 'en')).toBe('hu');
        expect(await loadStoredLanguage({ getItem: async () => 'hu', setItem: async () => undefined }, 'en')).toBe('hu');
    });

    it.each(['hu', 'hu-HU', 'hu_HU'])('formats Hungarian dates for %s', (language) => {
        configureDateFormatting({ language, systemLocale: 'hu-HU' });
        expect(safeFormatDate('2026-09-13', 'MMMM')).toBe('szeptember');
        expect(resolveDateLocaleTag({ language, dateFormat: 'ymd' })).toBe('hu-HU');
    });

    it.each([
        ['quickAdd.example', false],
        ['quickAdd.inlineHint', true],
        ['starter.quickCapture.check2', false],
    ] as const)('parses the date taught by %s', (key, hasTime) => {
        configureDateFormatting({ language: 'hu', systemLocale: 'hu-HU' });
        const result = parseQuickAdd(huOverrides[key], [], new Date(2026, 8, 13, 12));
        expect(result.invalidDateCommands ?? []).toEqual([]);
        if (!hasTime) {
            expect(result.props.dueDate).toBe('2026-09-14');
        } else {
            const date = safeParseDate(result.props.dueDate);
            expect(date).not.toBeNull();
            expect(date?.getFullYear()).toBe(2026);
            expect(date?.getMonth()).toBe(8);
            expect(date?.getDate()).toBe(14);
            expect(date?.getHours()).toBe(17);
            expect(date?.getMinutes()).toBe(0);
        }
    });
});
