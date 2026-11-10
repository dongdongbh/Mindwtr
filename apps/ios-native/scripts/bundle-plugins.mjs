import { build } from 'esbuild';
import { basename, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { lazyChrono } from '../../android-native/scripts/lazy-chrono.mjs';

const LAZY_FFLATE_EXPORTS = ['inflateSync', 'strFromU8', 'strToU8', 'zipSync'];

export const lazyFflate = {
    name: 'lazy-fflate',
    setup(builder) {
        builder.onResolve({ filter: /^fflate$/ }, async (args) => {
            if (args.pluginData === LAZY_FFLATE_EXPORTS) return undefined;
            const resolved = await builder.resolve('fflate', { resolveDir: args.resolveDir, kind: args.kind, pluginData: LAZY_FFLATE_EXPORTS });
            if (resolved.errors.length > 0) return { errors: resolved.errors };
            return { path: resolved.path, namespace: 'lazy-fflate' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'lazy-fflate' }, (args) => ({
            loader: 'js',
            resolveDir: dirname(args.path),
            contents: [
                'let loaded;',
                `const fflate = () => loaded ??= require(${JSON.stringify(args.path)});`,
                ...LAZY_FFLATE_EXPORTS.map((name) => `export const ${name} = (...args) => fflate().${name}(...args);`),
            ].join('\n'),
        }));
    },
};

const localeModule = async (path) => {
    const bundled = await build({ entryPoints: [path], bundle: true, write: false, format: 'iife', globalName: 'locale',
        tsconfigRaw: {}, logLevel: 'silent' });
    return runInNewContext(`${bundled.outputFiles[0].text};locale`);
};

export const jsonLocales = {
    name: 'json-locales',
    setup(builder) {
        builder.onLoad({ filter: /packages[\\/]core[\\/]src[\\/]i18n[\\/]locales[\\/][\w-]+\.ts$/ }, async (args) => {
            if (basename(args.path) === 'en.ts') return undefined;
            const exports = Object.entries(await localeModule(args.path));
            if (exports.length === 0) throw new Error(`json-locales: ${args.path} exports nothing`);
            const lines = exports.map(([name, table]) => {
                if (!table || typeof table !== 'object' || Array.isArray(table)
                    || !Object.values(table).every((text) => typeof text === 'string')) {
                    throw new Error(`json-locales: ${args.path} export ${name} is not a string table`);
                }
                return `export const ${name} = JSON.parse(${JSON.stringify(JSON.stringify(table))});`;
            });
            return { contents: lines.join('\n'), loader: 'js' };
        });
    },
};

export const iosBundlePlugins = [lazyChrono, lazyFflate, jsonLocales];
