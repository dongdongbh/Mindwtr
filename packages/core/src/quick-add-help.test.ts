import { describe, expect, it } from 'vitest';
import { formatQuickAddHelp } from './quick-add';
import { csOverrides } from './i18n/locales/cs';
import { deOverrides } from './i18n/locales/de';
import { en } from './i18n/locales/en';
import { esOverrides } from './i18n/locales/es';
import { faOverrides } from './i18n/locales/fa';
import { frOverrides } from './i18n/locales/fr';
import { itOverrides } from './i18n/locales/it';
import { jaOverrides } from './i18n/locales/ja';
import { koOverrides } from './i18n/locales/ko';
import { nlOverrides } from './i18n/locales/nl';
import { plOverrides } from './i18n/locales/pl';
import { ptOverrides } from './i18n/locales/pt';
import { svOverrides } from './i18n/locales/sv';
import { trOverrides } from './i18n/locales/tr';
import { viOverrides } from './i18n/locales/vi';
import { zhHans } from './i18n/locales/zh-Hans';
import { zhHant } from './i18n/locales/zh-Hant';

// Every locale that ships the frozen quickAdd.help sentence. The stripping is a
// literal-ish pattern, so it has to be proven against each translation rather
// than English alone.
const HELP_BY_LOCALE: Record<string, Record<string, string>> = {
    en, cs: csOverrides, de: deOverrides, es: esOverrides, fa: faOverrides, fr: frOverrides,
    it: itOverrides, ja: jaOverrides, ko: koOverrides, nl: nlOverrides, pl: plOverrides,
    pt: ptOverrides, sv: svOverrides, tr: trOverrides, vi: viOverrides,
    zh: zhHans, 'zh-Hant': zhHant,
};

describe('formatQuickAddHelp', () => {
    it('leaves the sentence untouched while Priorities is on', () => {
        expect(formatQuickAddHelp(en['quickAdd.help'], { priorities: true })).toBe(en['quickAdd.help']);
    });

    it('strips the token and its separator in every locale that ships the sentence', () => {
        for (const [locale, strings] of Object.entries(HELP_BY_LOCALE)) {
            const source = strings['quickAdd.help'];
            expect(source, locale).toBeTruthy();
            expect(source, locale).toContain('/priority:');
            const stripped = formatQuickAddHelp(source, { priorities: false });
            expect(stripped, locale).not.toContain('/priority:');
            // Only the token goes: neighbouring commands survive and no doubled
            // separator is left behind.
            expect(stripped, locale).toContain('/energy:');
            expect(stripped, locale).toContain('/next');
            expect(stripped, locale).not.toMatch(/[,،、]\s*[,،、]/u);
        }
    });

    it('leaves a locale that reworded the token alone rather than mangling it', () => {
        const reworded = 'Quick add supports /prioridad:<nivel>, /next.';
        expect(formatQuickAddHelp(reworded, { priorities: false })).toBe(reworded);
    });
});
