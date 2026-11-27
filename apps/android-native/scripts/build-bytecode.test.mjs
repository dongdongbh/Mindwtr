import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bundleKey, bytecodeContainer } from './build-bytecode.mjs';

const golden = readFileSync(new URL('../android/app/src/test/resources/bytecode-container.golden', import.meta.url));

test('the build writes the container BytecodeCache reads and writes', () => {
    const bytecode = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
    assert.deepEqual(bytecodeContainer('a'.repeat(64), 'quickjs-2026-06-04', bytecode), golden);
});

test('the container refuses a key that is not a SHA-256', () => {
    assert.throws(() => bytecodeContainer('xyz', 'quickjs-2026-06-04', Buffer.alloc(1)));
});

test('only a bundle whose body matches its hash line gets a key', () => {
    const body = 'globalThis.x = 1;';
    const hash = createHash('sha256').update(body).digest('hex');
    assert.equal(bundleKey(Buffer.from(`//mindwtr-bundle-sha256:${hash}\n${body}`)), hash);
    assert.equal(bundleKey(Buffer.from(`//mindwtr-bundle-sha256:${hash}\nglobalThis.x = 2;`)), '');
    assert.equal(bundleKey(Buffer.from(body)), '');
});
