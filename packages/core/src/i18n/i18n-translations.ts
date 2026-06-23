import type { Language } from './i18n-types';

import { en } from './locales/en';
import { zhHans } from './locales/zh-Hans';
import { zhHant } from './locales/zh-Hant';
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
import { nlOverrides } from './locales/nl';
import { csOverrides } from './locales/cs';
import { viOverrides } from './locales/vi';

const buildTranslations = (overrides: Record<string, string>) => {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(en)) {
        result[key] = overrides[key] ?? value;
    }
    return result;
};

const es = buildTranslations(esOverrides);
const hi = buildTranslations(hiOverrides);
const ar = buildTranslations(arOverrides);
const de = buildTranslations(deOverrides);
const ru = buildTranslations(ruOverrides);
const ja = buildTranslations(jaOverrides);
const fr = buildTranslations(frOverrides);
const pt = buildTranslations(ptOverrides);
const pl = buildTranslations(plOverrides);
const ko = buildTranslations(koOverrides);
const it = buildTranslations(itOverrides);
const tr = buildTranslations(trOverrides);
const nl = buildTranslations(nlOverrides);
const cs = buildTranslations(csOverrides);
const vi = buildTranslations(viOverrides);

export const translations: Record<Language, Record<string, string>> = {
    en,
    zh: zhHans,
    'zh-Hant': zhHant,
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
    nl,
    cs,
    vi,
};
