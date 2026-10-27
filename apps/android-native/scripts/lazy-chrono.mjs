// Core's quick-add-chrono.ts in the native bundles: a require per chrono-node locale subpath instead of the static import. esbuild
// wraps a required module in a lazy initializer, so a locale's parsers (all of them about 18 ms on the S23) run on its first
// parse, not when the bundle starts. bundle/lazy-chrono.test.ts checks both halves: nothing of chrono-node runs at boot, and the
// parses equal core's frozen corpus (packages/core/src/quick-add-chrono-corpus.json).
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
