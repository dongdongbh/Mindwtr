import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
import { iosBundlePlugins } from '../scripts/bundle-plugins.mjs';
import { LOCALES } from '../../../packages/core/src/i18n/i18n-locales';

type Context = Record<string, unknown> & {
    MindwtrHost?: object;
    __moduleRuns?: Record<string, number>;
    __jsonParses?: number;
    readLocales?: () => Record<string, Record<string, string>>;
    roundTrip?: (text: string) => string;
};

const countModuleRuns = {
    name: 'count-module-runs',
    setup(builder: { onLoad: (options: { filter: RegExp }, load: (args: { path: string }) => { contents: string; loader: 'js' }) => void }) {
        builder.onLoad({ filter: /[\\/]node_modules[\\/](chrono-node|fflate)[\\/].*\.js$/ }, (args) => {
            const name = /[\\/]node_modules[\\/](chrono-node|fflate)[\\/]/.exec(args.path)![1];
            return {
                contents: `globalThis.__moduleRuns[${JSON.stringify(name)}] = (globalThis.__moduleRuns[${JSON.stringify(name)}] || 0) + 1;\n${readFileSync(args.path, 'utf8')}`,
                loader: 'js',
            };
        });
    },
};

let context: Context;

beforeAll(async () => {
    const built = await build({
        stdin: { contents: `
            import '../../android-native/bundle/host-entry';
            import { strFromU8, strToU8 } from 'fflate';
            import { LOCALES } from '../../../packages/core/src/i18n/i18n-locales';
            globalThis.readLocales = () => Object.fromEntries(Object.entries(LOCALES)
                .map(([code, descriptor]) => [code, descriptor.loadSync()[descriptor.export]]));
            globalThis.roundTrip = (text) => strFromU8(strToU8(text));
        `, resolveDir: import.meta.dir, loader: 'ts' },
        bundle: true, write: false, format: 'iife', target: 'es2020', minify: true, logLevel: 'silent',
        banner: { js: "globalThis.__mindwtrHostPlatform = 'ios';" },
        plugins: [...iosBundlePlugins, countModuleRuns],
    });
    const respond = () => '{}';
    const native = new Proxy({ trace: () => undefined }, { get: (target, key) => (key in target ? target[key as 'trace'] : key === 'then' ? undefined : respond) });
    context = {
        console: { ...console, log() {}, info() {}, warn() {} }, __mindwtrNative: native, __moduleRuns: {},
        setTimeout, clearTimeout, TextEncoder, TextDecoder, URL, URLSearchParams,
    };
    vm.createContext(context);
    const parse = vm.runInContext('JSON.parse', context) as typeof JSON.parse;
    vm.runInContext('JSON', context).parse = (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
        context.__jsonParses = (context.__jsonParses ?? 0) + 1;
        return parse(text, reviver);
    };
    vm.runInContext(built.outputFiles[0].text, context);
}, 120_000);

describe('iOS core bundle plugins', () => {
    it('evaluates the host without running chrono-node or fflate', () => {
        expect(typeof context.MindwtrHost).toBe('object');
        expect(context.__moduleRuns).toEqual({});
    });

    it('loads fflate on first use and keeps its results', () => {
        expect(context.roundTrip!('Grüße 📦 test')).toBe('Grüße 📦 test');
        expect(context.__moduleRuns!.fflate).toBeGreaterThan(0);
    });

    it('decodes every non-English locale from JSON to the source tables', async () => {
        const before = context.__jsonParses ?? 0;
        const bundled = JSON.parse(JSON.stringify(context.readLocales!()));
        expect((context.__jsonParses ?? 0) - before).toBeGreaterThanOrEqual(Object.keys(LOCALES).length);
        for (const [code, descriptor] of Object.entries(LOCALES)) {
            const source = (await descriptor.loadAsync())[descriptor.export];
            expect(JSON.stringify(bundled[code])).toBe(JSON.stringify(source));
        }
    }, 60_000);
});
