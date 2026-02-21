import type { Language } from './i18n-types';
import { autoTranslate } from './i18n-translate';

import { en } from './locales/en';
import { zh } from './locales/zh';
import { esOverrides } from './locales/es';
import { hiOverrides } from './locales/hi';
import { arOverrides } from './locales/ar';
import { deOverrides } from './locales/de';
import { ruOverrides } from './locales/ru';
import { jaOverrides } from './locales/ja';
import { frOverrides } from './locales/fr';
import { ptOverrides } from './locales/pt';
import { plOverrides } from './locales/pl';
import { koOverrides } from './locales/ko';
import { itOverrides } from './locales/it';
import { trOverrides } from './locales/tr';

const buildTranslations = (lang: Language, overrides: Record<string, string>) => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(en)) {
        result[key] = overrides[key] ?? autoTranslate(value, lang);
    }
    return result;
};

const es = buildTranslations('es', esOverrides);
const hi = buildTranslations('hi', hiOverrides);
const ar = buildTranslations('ar', arOverrides);
const de = buildTranslations('de', deOverrides);
const ru = buildTranslations('ru', ruOverrides);
const ja = buildTranslations('ja', jaOverrides);
const fr = buildTranslations('fr', frOverrides);
const pt = buildTranslations('pt', ptOverrides);
const pl = buildTranslations('pl', plOverrides);
const ko = buildTranslations('ko', koOverrides);
const it = buildTranslations('it', itOverrides);
const tr = buildTranslations('tr', trOverrides);

export const translations: Record<Language, Record<string, string>> = {
    en,
    zh,
    es,
    hi,
    ar,
    de,
    ru,
    ja,
    fr,
    pt,
    pl,
    ko,
    it,
    tr,
};
