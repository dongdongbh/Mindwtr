import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const android = resolve(app, '../android-native/bundle');
const cryptoTest = process.argv.includes('--crypto-test');
const uploadTest = process.argv.includes('--attachment-upload-test');
if (cryptoTest && uploadTest) throw new Error('Private test bundle flags are mutually exclusive');
const output = resolve(app, cryptoTest ? '.build/crypto-test-host.js'
    : uploadTest ? '.build/attachment-upload-test-host.js' : 'Resources/core-host.js');
mkdirSync(dirname(output), { recursive: true });
await build({
    entryPoints: [cryptoTest ? resolve(app, 'bundle/crypto-test-entry.ts')
        : uploadTest ? resolve(app, 'bundle/attachment-upload-test-entry.ts') : resolve(android, 'host-entry.ts')],
    outfile: output,
    bundle: true,
    alias: { '@mindwtr/core': resolve(app, '../../packages/core/src/index.ts') },
    tsconfigRaw: {},
    format: 'iife',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    banner: { js: `globalThis.__mindwtrHostPlatform = 'ios';\n${readFileSync(resolve(app, 'bundle/jsc-preflight.js'), 'utf8')}\n${readFileSync(resolve(android, 'host-polyfills.js'), 'utf8')}` },
});
