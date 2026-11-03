import { build } from 'esbuild';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidHostEntry } from './android-host-table.mjs';
import { lazyChrono } from './lazy-chrono.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');


const option = (name) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const traceModules = process.argv.includes('--trace-modules');
const mainAssets = resolve(app, 'android/app/src/main/assets');
const outfile = resolve(option('--out') ?? resolve(mainAssets, 'core-host.js'));

if (traceModules && (!option('--out') || !relative(mainAssets, outfile).startsWith('..'))) {
    console.error(`build-bundle: --trace-modules needs --out outside ${mainAssets}`);
    process.exit(1);
}
const repo = resolve(app, '../..');

const hostEntry = resolve(app, 'bundle/host-entry.ts');
const source = (path) => (path === hostEntry ? androidHostEntry(readFileSync(path, 'utf8')) : readFileSync(path, 'utf8'));
const androidHostTable = {
    name: 'android-host-table',
    setup(build) {
        build.onLoad({ filter: /bundle[\\/]host-entry\.ts$/ }, (args) => (args.path === hostEntry
            ? { contents: source(args.path), loader: 'ts', resolveDir: dirname(args.path) } : undefined));
    },
};
const moduleTrace = {
    name: 'module-trace',
    setup(build) {
        build.onLoad({ filter: /\.(ts|tsx|js|mjs|cjs)$/ }, (args) => {
            if (args.path.endsWith('host-polyfills.js')) return undefined;
            const name = relative(repo, args.path).replace(/^.*node_modules\//, 'npm:');
            const marker = `globalThis.__mwTraceModule && globalThis.__mwTraceModule(${JSON.stringify(`mod:${name}`.slice(0, 120))});\n`;
            const loader = args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js';

            const end = args.path.endsWith('bundle/host-entry.ts') ? "\nglobalThis.__mwTraceModule && globalThis.__mwTraceModule('');\n" : '';
            return { contents: marker + source(args.path) + end, loader, resolveDir: dirname(args.path) };
        });
    },
};
const traceBanner = `(function (g) {
    // Core's own startup phases (startup-profiler.ts) go to the log too, with their durations.
    g.__MINDWTR_STARTUP_PROFILING__ = true;
    var open = false;
    g.__mwTraceModule = function (name) {
        var bridge = g.__mindwtrNative;
        if (!bridge || typeof bridge.trace !== 'function') return;
        if (open) bridge.trace('');
        open = name !== '';
        if (open) bridge.trace(name); else g.__mwTraceModule = undefined;
    };
}(globalThis));
`;
const result = await build({
    entryPoints: [resolve(app, 'bundle/host-entry.ts')],
    outfile,
    write: false,
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    banner: { js: readFileSync(resolve(app, 'bundle/host-polyfills.js'), 'utf8') + (traceModules ? traceBanner : '') },

    define: { 'globalThis.__mindwtrHostPlatform': '"android"' },
    plugins: [lazyChrono, traceModules ? moduleTrace : androidHostTable],
    metafile: true,
});


const root = realpathSync(repo);
const foreign = Object.keys(result.metafile.inputs).map((input) => resolve(input)).filter((path) => existsSync(path))
    .map((path) => realpathSync(path)).filter((path) => !path.split(sep).includes('node_modules') && relative(root, path).startsWith('..'));
if (foreign.length) {
    console.error(`build-bundle: refused: ${foreign.length} source(s) from outside ${root}, first ${foreign[0]}. Is node_modules a symlink to another tree?`);
    process.exit(1);
}


const body = result.outputFiles[0].contents;
mkdirSync(dirname(outfile), { recursive: true });
const temporary = `${outfile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
writeFileSync(temporary, Buffer.concat([Buffer.from(`//mindwtr-bundle-sha256:${createHash('sha256').update(body).digest('hex')}\n`), body]), { flag: 'wx' });
renameSync(temporary, outfile);
rmSync(`${outfile}.sha256`, { force: true });
