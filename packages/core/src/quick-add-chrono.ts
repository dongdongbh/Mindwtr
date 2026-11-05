import * as chrono from 'chrono-node';


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
