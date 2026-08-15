// Single descriptor table for every locale except English. English is bundled directly and
// loaded synchronously (see i18n-loader.ts) because it's both the base dictionary and the
// fallback every other locale merges onto — it isn't a member of this table.
//
// `Language`, `SUPPORTED_LANGUAGES`, i18n-loader.ts's dispatch, both apps' settings-screen
// language pickers, and locale-parity.test.ts's locale rosters all derive from this table, so
// adding a locale means adding one entry here instead of editing ~11 files in lockstep.
export type LocaleMode = 'full' | 'overrides';

type LocaleDescriptorCommon = {
    // Synchronous (require) and asynchronous (dynamic import) loaders for the same module.
    // Both stay literal `require('./locales/xx')` / `import('./locales/xx')` calls — not a
    // templated path built from the locale key — so bundlers that need a statically
    // analyzable module specifier (Metro, webpack) can still resolve and code-split each
    // locale file. loadWithFallback() in i18n-loader.ts tries loadSync first (works
    // synchronously under CJS/Node and Metro's require shim) and falls back to loadAsync.
    loadSync: () => Record<string, unknown>;
    loadAsync: () => Promise<Record<string, unknown>>;
    // Basename under ./locales, for tooling that reads the file rather than importing it
    // (scripts/i18n-locale-parity.ts). Usually the locale key, except zh -> 'zh-Hans'; that
    // one difference is the whole reason the script used to hand-mirror this table.
    file: string;
    // Export name to read off the loaded module (e.g. 'viOverrides', 'zhHans').
    export: string;
    native: string;
    // Non-Latin script: worth flagging separately when mixed-in English fragments leak
    // through in a partial ('overrides') locale — see locale-parity.test.ts.
    nonLatin: boolean;
};

// Coverage at which a non-Latin partial locale stops being checked for mixed-in English.
// Below it, Latin text in a value is almost always an untranslated leftover. At or above it
// the locale is essentially complete and the English still in it is deliberate — brand names,
// protocols, search operators, file extensions — so the check only yields false positives.
// Compared against translatedKeyFloor (the ratcheted commitment) rather than measured
// coverage, so a locale can't fall back under the check the moment en.ts grows.
export const MIXED_ENGLISH_COVERAGE_CEILING = 90;

// The translation commitment a locale is held to. Either the minimum NUMBER of English keys
// it must translate — ratcheted against silent regression, only ever raised as real
// translation work lands, never lowered — or 'all', meaning every key in en.ts, so a new
// English string has to be translated rather than merely counted around.
//
// It was a percentage of Object.keys(en).length until 2026-08-08, and a percentage is not a
// ratchet: adding an English string shrinks every locale's percentage with no locale
// regressing, and the recorded remedy was to lower the floor. This comment used to document
// re-pinning de 67->66, it 72->71, vi 99->98 for exactly that, and 8 more locales the batch
// before. en.ts grew ~480 lines in six weeks and 16 of 19 locales had under 45 keys of
// slack, so the gate broke on non-regressions roughly every other week — and each lowering
// opened headroom for a real regression to hide in. A count is strictly stronger: deleting a
// translation always fails it, whereas under percentages a simultaneously-growing en.ts
// could mask a deletion. 'all' carries the locales whose old floor was literally 100.
export type TranslationCommitment = number | 'all';

export type LocaleDescriptor =
    // A complete, standalone translation dictionary (not merged onto the English base at
    // load time), so it is always an 'all' commitment.
    | (LocaleDescriptorCommon & { mode: 'full'; translatedKeyFloor: 'all' })
    // A partial dictionary merged onto the English base at load time; missing keys fall back
    // to English. Usually a count, but fa and sv are maintained at full parity and are held
    // to it — 'mode' is about how the dictionary loads, the floor is about what we promise.
    | (LocaleDescriptorCommon & { mode: 'overrides'; translatedKeyFloor: TranslationCommitment });

// Whether a locale is still checked for mixed-in English fragments (see
// MIXED_ENGLISH_COVERAGE_CEILING). The one home for that derivation: locale-parity.test.ts
// and scripts/i18n-locale-parity.ts both read it, and the script used to hand-keep the
// resulting locale list. englishKeyCount is passed in so this table stays free of an import
// of en.ts.
export function isMixedEnglishChecked(descriptor: LocaleDescriptor, englishKeyCount: number): boolean {
    if (descriptor.mode !== 'overrides' || !descriptor.nonLatin) return false;
    if (descriptor.translatedKeyFloor === 'all') return false;
    return (descriptor.translatedKeyFloor / englishKeyCount) * 100 < MIXED_ENGLISH_COVERAGE_CEILING;
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
        translatedKeyFloor: 2213,
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
        translatedKeyFloor: 1374,
    },
    hi: {
        loadSync: () => require('./locales/hi') as typeof import('./locales/hi'),
        loadAsync: () => import('./locales/hi'),
        file: 'hi',
        export: 'hiOverrides',
        mode: 'overrides',
        native: 'हिन्दी',
        nonLatin: true,
        translatedKeyFloor: 1430,
    },
    ar: {
        loadSync: () => require('./locales/ar') as typeof import('./locales/ar'),
        loadAsync: () => import('./locales/ar'),
        file: 'ar',
        export: 'arOverrides',
        mode: 'overrides',
        native: 'العربية',
        nonLatin: true,
        translatedKeyFloor: 1457,
    },
    de: {
        loadSync: () => require('./locales/de') as typeof import('./locales/de'),
        loadAsync: () => import('./locales/de'),
        file: 'de',
        export: 'deOverrides',
        mode: 'overrides',
        native: 'Deutsch',
        nonLatin: false,
        translatedKeyFloor: 1468,
    },
    ru: {
        loadSync: () => require('./locales/ru') as typeof import('./locales/ru'),
        loadAsync: () => import('./locales/ru'),
        file: 'ru',
        export: 'ruOverrides',
        mode: 'overrides',
        native: 'Русский',
        nonLatin: true,
        translatedKeyFloor: 1430,
    },
    ja: {
        loadSync: () => require('./locales/ja') as typeof import('./locales/ja'),
        loadAsync: () => import('./locales/ja'),
        file: 'ja',
        export: 'jaOverrides',
        mode: 'overrides',
        native: '日本語',
        nonLatin: true,
        // Rewritten end to end with every English key translated. Keep this at full
        // parity so new English UI copy cannot silently fall back in Japanese.
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
        translatedKeyFloor: 1961,
    },
    pt: {
        loadSync: () => require('./locales/pt') as typeof import('./locales/pt'),
        loadAsync: () => import('./locales/pt'),
        file: 'pt',
        export: 'ptOverrides',
        mode: 'overrides',
        // Qualified because the app resolves Portuguese to Brazilian conventions in
        // both date paths (date-fns ptBR + Intl pt-BR), so a Portugal user should see
        // which variant they are choosing. Same reason zh/zh-Hant carry a script tag.
        native: 'Português (Brasil)',
        nonLatin: false,
        translatedKeyFloor: 1474,
    },
    pl: {
        loadSync: () => require('./locales/pl') as typeof import('./locales/pl'),
        loadAsync: () => import('./locales/pl'),
        file: 'pl',
        export: 'plOverrides',
        mode: 'overrides',
        native: 'Polski',
        nonLatin: false,
        translatedKeyFloor: 1453,
    },
    cs: {
        loadSync: () => require('./locales/cs') as typeof import('./locales/cs'),
        loadAsync: () => import('./locales/cs'),
        file: 'cs',
        export: 'csOverrides',
        mode: 'overrides',
        native: 'Čeština',
        nonLatin: false,
        translatedKeyFloor: 2233,
    },
    ko: {
        loadSync: () => require('./locales/ko') as typeof import('./locales/ko'),
        loadAsync: () => import('./locales/ko'),
        file: 'ko',
        export: 'koOverrides',
        mode: 'overrides',
        native: '한국어',
        nonLatin: true,
        // Rewritten end to end by a native speaker in #934 (64 -> ~100%), replacing a machine
        // translation that rendered brand names as common nouns ('Gemini' as the constellation).
        translatedKeyFloor: 2235,
    },
    it: {
        loadSync: () => require('./locales/it') as typeof import('./locales/it'),
        loadAsync: () => import('./locales/it'),
        file: 'it',
        export: 'itOverrides',
        mode: 'overrides',
        native: 'Italiano',
        nonLatin: false,
        translatedKeyFloor: 1570,
    },
    tr: {
        loadSync: () => require('./locales/tr') as typeof import('./locales/tr'),
        loadAsync: () => import('./locales/tr'),
        file: 'tr',
        export: 'trOverrides',
        mode: 'overrides',
        native: 'Türkçe',
        nonLatin: false,
        translatedKeyFloor: 1476,
    },
    nl: {
        loadSync: () => require('./locales/nl') as typeof import('./locales/nl'),
        loadAsync: () => import('./locales/nl'),
        file: 'nl',
        export: 'nlOverrides',
        mode: 'overrides',
        native: 'Nederlands',
        nonLatin: false,
        translatedKeyFloor: 569,
    },
    fa: {
        loadSync: () => require('./locales/fa') as typeof import('./locales/fa'),
        loadAsync: () => import('./locales/fa'),
        file: 'fa',
        export: 'faOverrides',
        mode: 'overrides',
        native: 'فارسی',
        nonLatin: true,
        // Complete translation. mode stays 'overrides' (not 'full') to mirror ar's shape
        // per the add-persian handoff; the commitment is full parity either way.
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
        // Complete translation. mode stays 'overrides' (not 'full') to mirror fa/ar's shape;
        // the commitment is full parity either way.
        translatedKeyFloor: 'all',
    },
} as const satisfies Record<string, LocaleDescriptor>;

/** Every locale code except 'en' (see the header comment for why English lives outside this table). */
export type Locale = keyof typeof LOCALES;
