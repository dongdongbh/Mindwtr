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
// Compared against coverageFloor (the ratcheted commitment) rather than measured coverage, so
// a locale can't fall back under the check the moment en.ts grows.
export const MIXED_ENGLISH_COVERAGE_CEILING = 90;

export type LocaleDescriptor =
    // A complete, standalone translation dictionary, checked for 100% key parity with
    // English. No coverage floor: it's expected to have every key, not a percentage of them.
    | (LocaleDescriptorCommon & { mode: 'full'; coverageFloor: null })
    // A partial dictionary merged onto the English base at load time; missing keys fall back
    // to English. coverageFloor is the minimum percentage of English keys this locale must
    // translate, ratcheted against silent regression — never lowered to match a regression,
    // only raised as real translation work lands, or re-pinned (down or up) when a real,
    // deliberate change to englishKeyCount shifts every locale's percentage denominator. The
    // 2026-07-24 settings-i18n migration moved 162 desktop-only settings strings into en.ts,
    // growing englishKeyCount from 1957 to 2119; every partial locale's numerator was
    // unchanged, so each floor below was re-pinned to that new denominator. cs and vi are
    // deliberately near-full-parity partial locales and were backfilled instead of relaxed,
    // so their floors stayed at 99 through that migration. The same-day core-schema-finish
    // batch then added 4 new `units.*` keys to en.ts (2119 -> 2123) without touching any
    // locale file but en/zh-Hans/zh-Hant (out of that batch's scope) — de, it, and vi's
    // measured coverage dipped fractionally below their prior floor purely from that
    // denominator growth (no translation regressed), so de/it/vi are re-pinned once more
    // (67->66, 72->71, 99->98) to the new measurement; vi's numerator is still unchanged and
    // still near-full-parity, its floor just no longer rounds up to 99 with 4 more English
    // keys outstanding.
    | (LocaleDescriptorCommon & { mode: 'overrides'; coverageFloor: number });

export const LOCALES = {
    vi: {
        loadSync: () => require('./locales/vi') as typeof import('./locales/vi'),
        loadAsync: () => import('./locales/vi'),
        export: 'viOverrides',
        mode: 'overrides',
        native: 'Tiếng Việt',
        nonLatin: false,
        coverageFloor: 98,
    },
    zh: {
        loadSync: () => require('./locales/zh-Hans') as typeof import('./locales/zh-Hans'),
        loadAsync: () => import('./locales/zh-Hans'),
        export: 'zhHans',
        mode: 'full',
        native: '中文（简体）',
        nonLatin: true,
        coverageFloor: null,
    },
    'zh-Hant': {
        loadSync: () => require('./locales/zh-Hant') as typeof import('./locales/zh-Hant'),
        loadAsync: () => import('./locales/zh-Hant'),
        export: 'zhHant',
        mode: 'full',
        native: '中文（繁體）',
        nonLatin: true,
        coverageFloor: null,
    },
    es: {
        loadSync: () => require('./locales/es') as typeof import('./locales/es'),
        loadAsync: () => import('./locales/es'),
        export: 'esOverrides',
        mode: 'overrides',
        native: 'Español',
        nonLatin: false,
        coverageFloor: 62,
    },
    hi: {
        loadSync: () => require('./locales/hi') as typeof import('./locales/hi'),
        loadAsync: () => import('./locales/hi'),
        export: 'hiOverrides',
        mode: 'overrides',
        native: 'हिन्दी',
        nonLatin: true,
        coverageFloor: 65,
    },
    ar: {
        loadSync: () => require('./locales/ar') as typeof import('./locales/ar'),
        loadAsync: () => import('./locales/ar'),
        export: 'arOverrides',
        mode: 'overrides',
        native: 'العربية',
        nonLatin: true,
        coverageFloor: 66,
    },
    de: {
        loadSync: () => require('./locales/de') as typeof import('./locales/de'),
        loadAsync: () => import('./locales/de'),
        export: 'deOverrides',
        mode: 'overrides',
        native: 'Deutsch',
        nonLatin: false,
        coverageFloor: 66,
    },
    ru: {
        loadSync: () => require('./locales/ru') as typeof import('./locales/ru'),
        loadAsync: () => import('./locales/ru'),
        export: 'ruOverrides',
        mode: 'overrides',
        native: 'Русский',
        nonLatin: true,
        coverageFloor: 65,
    },
    ja: {
        loadSync: () => require('./locales/ja') as typeof import('./locales/ja'),
        loadAsync: () => import('./locales/ja'),
        export: 'jaOverrides',
        mode: 'overrides',
        native: '日本語',
        nonLatin: true,
        coverageFloor: 65,
    },
    fr: {
        loadSync: () => require('./locales/fr') as typeof import('./locales/fr'),
        loadAsync: () => import('./locales/fr'),
        export: 'frOverrides',
        mode: 'overrides',
        native: 'Français',
        nonLatin: false,
        coverageFloor: 70,
    },
    pt: {
        loadSync: () => require('./locales/pt') as typeof import('./locales/pt'),
        loadAsync: () => import('./locales/pt'),
        export: 'ptOverrides',
        mode: 'overrides',
        native: 'Português',
        nonLatin: false,
        coverageFloor: 67,
    },
    pl: {
        loadSync: () => require('./locales/pl') as typeof import('./locales/pl'),
        loadAsync: () => import('./locales/pl'),
        export: 'plOverrides',
        mode: 'overrides',
        native: 'Polski',
        nonLatin: false,
        coverageFloor: 66,
    },
    cs: {
        loadSync: () => require('./locales/cs') as typeof import('./locales/cs'),
        loadAsync: () => import('./locales/cs'),
        export: 'csOverrides',
        mode: 'overrides',
        native: 'Čeština',
        nonLatin: false,
        coverageFloor: 99,
    },
    ko: {
        loadSync: () => require('./locales/ko') as typeof import('./locales/ko'),
        loadAsync: () => import('./locales/ko'),
        export: 'koOverrides',
        mode: 'overrides',
        native: '한국어',
        nonLatin: true,
        // Rewritten end to end by a native speaker in #934 (64 -> ~100%), replacing a machine
        // translation that rendered brand names as common nouns ('Gemini' as the constellation).
        coverageFloor: 98,
    },
    it: {
        loadSync: () => require('./locales/it') as typeof import('./locales/it'),
        loadAsync: () => import('./locales/it'),
        export: 'itOverrides',
        mode: 'overrides',
        native: 'Italiano',
        nonLatin: false,
        coverageFloor: 71,
    },
    tr: {
        loadSync: () => require('./locales/tr') as typeof import('./locales/tr'),
        loadAsync: () => import('./locales/tr'),
        export: 'trOverrides',
        mode: 'overrides',
        native: 'Türkçe',
        nonLatin: false,
        coverageFloor: 67,
    },
    nl: {
        loadSync: () => require('./locales/nl') as typeof import('./locales/nl'),
        loadAsync: () => import('./locales/nl'),
        export: 'nlOverrides',
        mode: 'overrides',
        native: 'Nederlands',
        nonLatin: false,
        coverageFloor: 22,
    },
} as const satisfies Record<string, LocaleDescriptor>;

/** Every locale code except 'en' (see the header comment for why English lives outside this table). */
export type Locale = keyof typeof LOCALES;
