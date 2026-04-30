import { describe, expect, it } from 'vitest';
import { arOverrides } from './locales/ar';
import { deOverrides } from './locales/de';
import { en } from './locales/en';
import { esOverrides } from './locales/es';
import { frOverrides } from './locales/fr';
import { hiOverrides } from './locales/hi';
import { itOverrides } from './locales/it';
import { jaOverrides } from './locales/ja';
import { koOverrides } from './locales/ko';
import { nlOverrides } from './locales/nl';
import { plOverrides } from './locales/pl';
import { ptOverrides } from './locales/pt';
import { ruOverrides } from './locales/ru';
import { trOverrides } from './locales/tr';
import { zhHans } from './locales/zh-Hans';
import { zhHant } from './locales/zh-Hant';

const requiredOverrideKeys = [
    'recurrence.endsLabel',
    'recurrence.endsNever',
    'recurrence.endsOnDate',
    'recurrence.endsAfterCount',
    'recurrence.occurrenceUnit',
    'settings.pomodoroCustomPreset',
    'settings.pomodoroCustomPresetDesc',
    'settings.pomodoroFocusMinutes',
    'settings.pomodoroBreakMinutes',
    'inbox.whoShouldDoIt',
] as const;

const fullParityLocales: Record<string, Record<string, string>> = {
    zh: zhHans,
    'zh-Hant': zhHant,
};

const overrideLocales: Record<string, Record<string, string>> = {
    ar: arOverrides,
    de: deOverrides,
    es: esOverrides,
    fr: frOverrides,
    hi: hiOverrides,
    it: itOverrides,
    ja: jaOverrides,
    ko: koOverrides,
    nl: nlOverrides,
    pl: plOverrides,
    pt: ptOverrides,
    ru: ruOverrides,
    tr: trOverrides,
};

describe('locale parity', () => {
    it('keeps full locale files in key parity with English', () => {
        for (const [language, translations] of Object.entries(fullParityLocales)) {
            for (const key of Object.keys(en)) {
                expect(
                    translations[key],
                    `Missing ${key} in ${language}`
                ).toBeTruthy();
            }
        }
    });

    it('defines required workflow copy for every shipped language', () => {
        for (const [language, translations] of Object.entries({
            en,
            ...fullParityLocales,
            ...overrideLocales,
        })) {
            for (const key of requiredOverrideKeys) {
                expect(
                    translations[key],
                    `Missing ${key} in ${language}`
                ).toBeTruthy();
            }
        }
    });
});
