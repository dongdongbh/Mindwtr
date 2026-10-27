import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { lazyChrono } from '../scripts/lazy-chrono.mjs';

// The native bundle loads chrono-node per locale on first parse (scripts/lazy-chrono.mjs): no chrono-node module may run while
// the bundle starts, and quick-add must parse core's frozen corpus exactly as the static import did.
const corpus = resolve(import.meta.dir, '../../../packages/core/src/quick-add-chrono-corpus.json');

describe('lazy chrono-node in the native bundle', () => {
    it('runs no chrono-node module at boot, then parses the frozen corpus unchanged', async () => {
        // Counts every chrono-node module's first run, as the module trace would.
        const countChrono = {
            name: 'count-chrono',
            setup(builder: Parameters<typeof lazyChrono.setup>[0]) {
                builder.onLoad({ filter: /[\\/]chrono-node[\\/]dist[\\/].*\.js$/ }, (args: { path: string }) => ({
                    contents: `globalThis.__chronoRuns = (globalThis.__chronoRuns || 0) + 1;\n${readFileSync(args.path, 'utf8')}`,
                    loader: 'js',
                }));
            },
        };
        const built = await build({
            stdin: { contents: `
                import './host-entry';
                import { runQuickAddCorpus } from '../../../packages/core/src/quick-add-chrono-corpus.fixture';
                globalThis.runQuickAddCorpus = runQuickAddCorpus;
            `, resolveDir: import.meta.dir, loader: 'ts' },
            bundle: true, write: false, format: 'iife', target: 'es2020', logLevel: 'silent',
            define: { 'globalThis.__mindwtrHostPlatform': '"android"' },
            plugins: [lazyChrono, countChrono],
        });
        const respond = () => '{}';
        const native = new Proxy({ trace: () => undefined }, { get: (target, key) => (key in target ? target[key as 'trace'] : key === 'then' ? undefined : respond) });
        const context = vm.createContext({ console: { ...console, log() {}, info() {}, warn() {} }, __mindwtrNative: native,
            setTimeout, clearTimeout, TextEncoder, TextDecoder, URL, URLSearchParams });
        vm.runInContext(built.outputFiles[0].text, context);
        expect(typeof context.MindwtrHost).toBe('object');
        expect(context.__chronoRuns).toBeUndefined();

        const zone = process.env.TZ;
        process.env.TZ = 'UTC';
        try {
            const cases = JSON.parse(JSON.stringify(context.runQuickAddCorpus()));
            expect(context.__chronoRuns).toBeGreaterThan(100);
            const frozen = JSON.parse(readFileSync(corpus, 'utf8'));
            expect(cases.length).toBe(frozen.length);
            for (let index = 0; index < cases.length; index += 1) expect(cases[index]).toEqual(frozen[index]);
        } finally {
            if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
        }
    }, 120_000);
});
