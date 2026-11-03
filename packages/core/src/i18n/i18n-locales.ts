


export type LocaleMode = 'full' | 'overrides';

type LocaleDescriptorCommon = {


    loadSync: () => Record<string, unknown>;
    loadAsync: () => Promise<Record<string, unknown>>;


    file: string;

    export: string;
    native: string;


    nonLatin: boolean;
};


export const MIXED_ENGLISH_COVERAGE_CEILING = 90;


export type TranslationCommitment = number | 'all';

export type LocaleDescriptor =


    | (LocaleDescriptorCommon & { mode: 'full'; translatedKeyFloor: 'all' })


    | (LocaleDescriptorCommon & { mode: 'overrides'; translatedKeyFloor: TranslationCommitment });


export function isMixedEnglishChecked(descriptor: LocaleDescriptor, englishKeyCount: number): boolean {
    if (descriptor.mode !== 'overrides' || !descriptor.nonLatin) return false;
    if (descriptor.translatedKeyFloor === 'all') return false;
    return (descriptor.translatedKeyFloor / englishKeyCount) * 100 < MIXED_ENGLISH_COVERAGE_CEILING;
}


export function isEnglishResidueChecked(descriptor: LocaleDescriptor): boolean {
    return descriptor.mode === 'overrides' && !descriptor.nonLatin;
}

export const LOCALES = {
    vi: {
        loadSync: () => require('./locales/vi') as typeof import('./locales/vi'),
        loadAsync: () => import('./locales/vi'),
        file: 'vi',
        export: 'viOverrides',
        mode: 'overrides',
        native: 'Tiếng Việt',
        nonLatin: false,
        translatedKeyFloor: 2299,
    },
    zh: {
        loadSync: () => require('./locales/zh-Hans') as typeof import('./locales/zh-Hans'),
        loadAsync: () => import('./locales/zh-Hans'),
        file: 'zh-Hans',
        export: 'zhHans',
        mode: 'full',
        native: '中文（简体）',
        nonLatin: true,
        translatedKeyFloor: 'all',
    },
    'zh-Hant': {
        loadSync: () => require('./locales/zh-Hant') as typeof import('./locales/zh-Hant'),
        loadAsync: () => import('./locales/zh-Hant'),
        file: 'zh-Hant',
        export: 'zhHant',
        mode: 'full',
        native: '中文（繁體）',
        nonLatin: true,
        translatedKeyFloor: 'all',
    },
    es: {
        loadSync: () => require('./locales/es') as typeof import('./locales/es'),
        loadAsync: () => import('./locales/es'),
        file: 'es',
        export: 'esOverrides',
        mode: 'overrides',
        native: 'Español',
        nonLatin: false,


        translatedKeyFloor: 'all',
    },
    hu: {
        loadSync: () => require('./locales/hu') as typeof import('./locales/hu'),
        loadAsync: () => import('./locales/hu'),
        file: 'hu',
        export: 'huOverrides',
        mode: 'overrides',
        native: 'Magyar',
        nonLatin: false,


        translatedKeyFloor: 'all',
    },
    uk: {
        loadSync: () => require('./locales/uk') as typeof import('./locales/uk'),
        loadAsync: () => import('./locales/uk'),
        file: 'uk',
        export: 'ukOverrides',
        mode: 'overrides',
        native: 'Українська',
        nonLatin: true,
        translatedKeyFloor: 'all',
    },
    hi: {
        loadSync: () => require('./locales/hi') as typeof import('./locales/hi'),
        loadAsync: () => import('./locales/hi'),
        file: 'hi',
        export: 'hiOverrides',
        mode: 'overrides',
        native: 'हिन्दी',
        nonLatin: true,
        translatedKeyFloor: 1441,
    },
    ar: {
        loadSync: () => require('./locales/ar') as typeof import('./locales/ar'),
        loadAsync: () => import('./locales/ar'),
        file: 'ar',
        export: 'arOverrides',
        mode: 'overrides',
        native: 'العربية',
        nonLatin: true,
        translatedKeyFloor: 1468,
    },
    de: {
        loadSync: () => require('./locales/de') as typeof import('./locales/de'),
        loadAsync: () => import('./locales/de'),
        file: 'de',
        export: 'deOverrides',
        mode: 'overrides',
        native: 'Deutsch',
        nonLatin: false,
        translatedKeyFloor: 2480,
    },
    ru: {
        loadSync: () => require('./locales/ru') as typeof import('./locales/ru'),
        loadAsync: () => import('./locales/ru'),
        file: 'ru',
        export: 'ruOverrides',
        mode: 'overrides',
        native: 'Русский',
        nonLatin: true,
        translatedKeyFloor: 1441,
    },
    ja: {
        loadSync: () => require('./locales/ja') as typeof import('./locales/ja'),
        loadAsync: () => import('./locales/ja'),
        file: 'ja',
        export: 'jaOverrides',
        mode: 'overrides',
        native: '日本語',
        nonLatin: true,


        translatedKeyFloor: 'all',
    },
    fr: {
        loadSync: () => require('./locales/fr') as typeof import('./locales/fr'),
        loadAsync: () => import('./locales/fr'),
        file: 'fr',
        export: 'frOverrides',
        mode: 'overrides',
        native: 'Français',
        nonLatin: false,
        translatedKeyFloor: 1972,
    },
    pt: {
        loadSync: () => require('./locales/pt') as typeof import('./locales/pt'),
        loadAsync: () => import('./locales/pt'),
        file: 'pt',
        export: 'ptOverrides',
        mode: 'overrides',


        native: 'Português (Brasil)',
        nonLatin: false,
        translatedKeyFloor: 1485,
    },
    pl: {
        loadSync: () => require('./locales/pl') as typeof import('./locales/pl'),
        loadAsync: () => import('./locales/pl'),
        file: 'pl',
        export: 'plOverrides',
        mode: 'overrides',
        native: 'Polski',
        nonLatin: false,
        translatedKeyFloor: 1464,
    },
    cs: {
        loadSync: () => require('./locales/cs') as typeof import('./locales/cs'),
        loadAsync: () => import('./locales/cs'),
        file: 'cs',
        export: 'csOverrides',
        mode: 'overrides',
        native: 'Čeština',
        nonLatin: false,
        translatedKeyFloor: 2244,
    },
    ko: {
        loadSync: () => require('./locales/ko') as typeof import('./locales/ko'),
        loadAsync: () => import('./locales/ko'),
        file: 'ko',
        export: 'koOverrides',
        mode: 'overrides',
        native: '한국어',
        nonLatin: true,


        translatedKeyFloor: 2560,
    },
    it: {
        loadSync: () => require('./locales/it') as typeof import('./locales/it'),
        loadAsync: () => import('./locales/it'),
        file: 'it',
        export: 'itOverrides',
        mode: 'overrides',
        native: 'Italiano',
        nonLatin: false,
        translatedKeyFloor: 1581,
    },
    tr: {
        loadSync: () => require('./locales/tr') as typeof import('./locales/tr'),
        loadAsync: () => import('./locales/tr'),
        file: 'tr',
        export: 'trOverrides',
        mode: 'overrides',
        native: 'Türkçe',
        nonLatin: false,
        translatedKeyFloor: 1487,
    },
    nl: {
        loadSync: () => require('./locales/nl') as typeof import('./locales/nl'),
        loadAsync: () => import('./locales/nl'),
        file: 'nl',
        export: 'nlOverrides',
        mode: 'overrides',
        native: 'Nederlands',
        nonLatin: false,
        translatedKeyFloor: 580,
    },
    fa: {
        loadSync: () => require('./locales/fa') as typeof import('./locales/fa'),
        loadAsync: () => import('./locales/fa'),
        file: 'fa',
        export: 'faOverrides',
        mode: 'overrides',
        native: 'فارسی',
        nonLatin: true,


        translatedKeyFloor: 'all',
    },
    sv: {
        loadSync: () => require('./locales/sv') as typeof import('./locales/sv'),
        loadAsync: () => import('./locales/sv'),
        file: 'sv',
        export: 'svOverrides',
        mode: 'overrides',
        native: 'Svenska',
        nonLatin: false,


        translatedKeyFloor: 'all',
    },
    da: {
        loadSync: () => require('./locales/da') as typeof import('./locales/da'),
        loadAsync: () => import('./locales/da'),
        file: 'da',
        export: 'daOverrides',
        mode: 'overrides',
        native: 'Dansk',
        nonLatin: false,
        translatedKeyFloor: 'all',
    },
} as const satisfies Record<string, LocaleDescriptor>;


export type Locale = keyof typeof LOCALES;
