#!/usr/bin/env node


import { argon2id } from '@noble/hashes/argon2.js';
import { createCipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve(import.meta.dirname, '../packages/core/src/__fixtures__/sync-crypto/primitive-vectors.json');
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const pattern = (length, seed) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff);
const utf8 = (text) => new TextEncoder().encode(text.normalize('NFC'));

const opensslArgon2id = (pass, salt, { m, t, p, dkLen }) => execFileSync('openssl', ['kdf', '-binary', '-keylen', String(dkLen),
    '-kdfopt', `hexpass:${hex(pass)}`, '-kdfopt', `hexsalt:${hex(salt)}`, '-kdfopt', `memcost:${m}`, '-kdfopt', `iter:${t}`,
    '-kdfopt', `lanes:${p}`, 'ARGON2ID']);

const argon2Cases = [

    ['correct horse battery staple', 1, 64, 1],
    ['hunter2', 2, 19456, 1],
    ['s3cr3t-passphrase', 1, 64, 1],
    ['café', 1, 64, 1],
    ['custom-params-passphrase', 3, 256, 2],
    ['', 1, 64, 1],
    ['パスワード 🔑', 2, 128, 4],
    ['acid tremble anchor velvet orbit', 2, 19456, 1],
].map(([passphrase, t, m, p], index) => {
    const pass = utf8(passphrase);
    const salt = pattern(16, index + 2);
    const params = { m, t, p, dkLen: 32 };
    const noble = hex(argon2id(pass, salt, params));
    const openssl = hex(opensslArgon2id(pass, salt, params));
    if (noble !== openssl) throw new Error(`Argon2id case ${index}: @noble/hashes ${noble} != OpenSSL ${openssl}`);
    return { passphrase, passHex: hex(pass), saltHex: hex(salt), mKib: m, t, p, dkLen: 32, keyHex: noble };
});

const aesGcmCases = [[0, 0], [1, 0], [15, 54], [16, 54], [17, 54], [1000, 54], [4096, 0]].map(([length, aadLength], index) => {
    const key = pattern(32, 100 + index);
    const nonce = pattern(12, 200 + index);
    const plaintext = pattern(length, 50 + index);
    const aad = pattern(aadLength, 150 + index);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { keyHex: hex(key), nonceHex: hex(nonce), plaintextHex: hex(plaintext), aadHex: hex(aad), sealedHex: hex(sealed) };
});

const sha256Cases = [new Uint8Array(0), new TextEncoder().encode('abc'), pattern(1000, 7)]
    .map((input) => ({ inputHex: hex(input), digestHex: createHash('sha256').update(input).digest('hex') }));

const opensslVersion = execFileSync('openssl', ['version'], { encoding: 'utf8' }).trim();
writeFileSync(out, `${JSON.stringify({ generatedBy: 'scripts/generate-sync-crypto-primitive-vectors.mjs', argon2idCheckedWith: opensslVersion,
    argon2id: argon2Cases, aesGcm: aesGcmCases, sha256: sha256Cases }, null, 2)}\n`);
console.log(`wrote ${out}: ${argon2Cases.length} Argon2id (noble = ${opensslVersion}), ${aesGcmCases.length} AES-GCM, ${sha256Cases.length} SHA-256`);
