import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('MWQJSBC1', 'ascii');

export function bundleKey(bundle) {
    const newline = bundle.indexOf(10);
    const key = /^\/\/mindwtr-bundle-sha256:([0-9a-f]{64})$/.exec(bundle.subarray(0, Math.max(newline, 0)).toString('utf8'))?.[1];
    if (!key || createHash('sha256').update(bundle.subarray(newline + 1)).digest('hex') !== key) return '';
    return key;
}

export function bytecodeContainer(bundleHash, engine, bytecode) {
    if (!/^[0-9a-f]{64}$/.test(bundleHash)) throw new Error(`not a SHA-256: ${bundleHash}`);
    if (!/^[\x01-\x7f]*$/.test(engine)) throw new Error(`engine name must be ASCII: ${engine}`);
    const engineField = Buffer.alloc(2 + engine.length);
    engineField.writeUInt16BE(engine.length);
    engineField.write(engine, 2, 'ascii');
    const size = Buffer.alloc(4);
    size.writeInt32BE(bytecode.length);
    return Buffer.concat([MAGIC, Buffer.from(bundleHash, 'hex'), engineField, size, createHash('sha256').update(bytecode).digest(), bytecode]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [compiler, bundlePath, outPath, engine] = process.argv.slice(2);
    if (!engine) {
        console.error('usage: build-bytecode.mjs <compile-bytecode> <core-host.js> <out.qjsc> <engine>');
        process.exit(2);
    }
    const key = bundleKey(readFileSync(bundlePath));
    if (!key) {
        console.error(`build-bytecode: ${bundlePath} has no valid hash line`);
        process.exit(1);
    }
    const raw = `${outPath}.${process.pid}.${randomBytes(6).toString('hex')}.raw`;
    const temporary = `${outPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        execFileSync(compiler, [bundlePath, 'core-host.js', raw], { stdio: 'inherit' });
        writeFileSync(temporary, bytecodeContainer(key, engine, readFileSync(raw)), { flag: 'wx' });
        renameSync(temporary, outPath);
    } finally {
        rmSync(raw, { force: true });
        rmSync(temporary, { force: true });
    }
}
