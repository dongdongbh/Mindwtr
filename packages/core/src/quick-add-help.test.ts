import { describe, expect, it } from 'vitest';
import { formatQuickAddHelp } from './quick-add';
import { csOverrides } from './i18n/locales/cs';
import { daOverrides } from './i18n/locales/da';
import { deOverrides } from './i18n/locales/de';
import { en } from './i18n/locales/en';
import { esOverrides } from './i18n/locales/es';
import { faOverrides } from './i18n/locales/fa';
import { frOverrides } from './i18n/locales/fr';
import { huOverrides } from './i18n/locales/hu';
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


const HELP_BY_LOCALE: Record<string, Record<string, string>> = {
    en, cs: csOverrides, da: daOverrides, de: deOverrides, es: esOverrides, fa: faOverrides, fr: frOverrides,
    hu: huOverrides, it: itOverrides, ja: jaOverrides, ko: koOverrides, nl: nlOverrides, pl: plOverrides,
    pt: ptOverrides, sv: svOverrides, tr: trOverrides, vi: viOverrides,
    zh: zhHans, 'zh-Hant': zhHant,
};

describe('formatQuickAddHelp', () => {
    it('leaves the sentence untouched while Priorities is on', () => {
        expect(formatQuickAddHelp(en['quickAdd.help'], { priorities: true, timeEstimates: true })).toBe(en['quickAdd.help']);
    });

    it('strips the token and its separator in every locale that ships the sentence', () => {
        for (const [locale, strings] of Object.entries(HELP_BY_LOCALE)) {
            const source = strings['quickAdd.help'];
            expect(source, locale).toBeTruthy();
            expect(source, locale).toContain('/priority:');
            expect(source, locale).toContain('/estimate:45m');
            expect(source.match(/\/estimate:/g), locale).toHaveLength(1);
            const stripped = formatQuickAddHelp(source, { priorities: false, timeEstimates: true });
            expect(stripped, locale).not.toContain('/priority:');


            expect(stripped, locale).toContain('/energy:');
            expect(stripped, locale).toContain('/next');
            expect(stripped, locale).not.toMatch(/[,،、]\s*[,،、]/u);
        }
    });

    it('strips the estimate token in every locale while Time estimates is off', () => {
        for (const [locale, strings] of Object.entries(HELP_BY_LOCALE)) {
            const source = strings['quickAdd.help'];
            const stripped = formatQuickAddHelp(source, { priorities: true, timeEstimates: false });
            expect(stripped, locale).not.toContain('/estimate:');
            expect(stripped, locale).toContain('/priority:');
            expect(stripped, locale).toContain('/review:');
            expect(stripped, locale).toContain('/note:');
            expect(stripped, locale).not.toMatch(/[,،、]\s*[,،、]/u);
            const both = formatQuickAddHelp(source, { priorities: false, timeEstimates: false });
            expect(both, locale).not.toMatch(/\/(?:estimate|priority):/);
            expect(both, locale).not.toMatch(/[,،、]\s*[,،、]/u);
        }
    });

    it('leaves a locale that reworded the token alone rather than mangling it', () => {
        const reworded = 'Quick add supports /prioridad:<nivel>, /next.';
        expect(formatQuickAddHelp(reworded, { priorities: false, timeEstimates: false })).toBe(reworded);
    });
});
