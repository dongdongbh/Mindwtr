


import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
let bundle;
try { bundle = readFileSync(file); } catch (error) { console.error(`verify-bundle: cannot read ${file}: ${error.message}`); process.exit(1); }
const newline = bundle.indexOf(10);
const key = /^\/\/mindwtr-bundle-sha256:([0-9a-f]{64})$/.exec(bundle.subarray(0, Math.max(newline, 0)).toString('utf8'))?.[1];
const body = createHash('sha256').update(bundle.subarray(newline + 1)).digest('hex');
if (!key || key !== body) {
    console.error(`verify-bundle: ${file} ${key ? `carries hash ${key} but its body hashes to ${body}` : 'has no hash line'}`);
    process.exit(1);
}
if (!process.argv.includes('--allow-module-trace') && bundle.includes('__mwTraceModule')) {
    console.error(`verify-bundle: ${file} has module trace hooks, which only the benchmarkTrace build may carry`);
    process.exit(1);
}
