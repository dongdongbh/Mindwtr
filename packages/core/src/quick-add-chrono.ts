import * as chrono from 'chrono-node';

/**
 * chrono-node's locales quick-add parses with, each behind a call. The native bundles replace this file with a require per
 * locale subpath (apps/android-native/scripts/lazy-chrono.mjs), so a locale's parsers initialize on its first parse, not at
 * every start (about 18 ms for all of them on the S23). Elsewhere this is the one static import.
 */
export const chronoLocale = {
    de: (): typeof chrono.de => chrono.de,
    en: (): typeof chrono.en => chrono.en,
    es: (): typeof chrono.es => chrono.es,
    fr: (): typeof chrono.fr => chrono.fr,
    it: (): typeof chrono.it => chrono.it,
    ja: (): typeof chrono.ja => chrono.ja,
    nl: (): typeof chrono.nl => chrono.nl,
    pt: (): typeof chrono.pt => chrono.pt,
    ru: (): typeof chrono.ru => chrono.ru,
    sv: (): typeof chrono.sv => chrono.sv,
    zh: (): typeof chrono.zh => chrono.zh,
};
