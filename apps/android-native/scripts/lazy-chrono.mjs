


import { dirname } from 'node:path';

export const LAZY_CHRONO_LOCALES = ['de', 'en', 'es', 'fr', 'it', 'ja', 'nl', 'pt', 'ru', 'sv', 'zh'];

export const lazyChrono = {
    name: 'lazy-chrono',
    setup(build) {
        build.onLoad({ filter: /packages[\\/]core[\\/]src[\\/]quick-add-chrono\.ts$/ }, (args) => ({
            contents: `export const chronoLocale = { ${LAZY_CHRONO_LOCALES.map((locale) => `${locale}: () => require('chrono-node/${locale}')`).join(', ')} };\n`,
            loader: 'js',
            resolveDir: dirname(args.path),
        }));
    },
};
