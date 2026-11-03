import { describe, expect, it, afterEach } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { argon2id } from '@noble/hashes/argon2.js';
import {
  computeSha256Hex,
  decryptSyncArtifact,
  defaultSyncCryptoPrimitives,
  deriveSyncKeyMaterial,
  encryptSyncArtifact,
  setSha256HexProvider,
  SyncCryptoAuthError,
} from '@mindwtr/core';

import {
  mobileSha256Hex,
  mobileSyncCryptoPrimitives,
  setExpoGoProbeForTests,
  setSyncCryptoNativeModuleForTests,
  type SyncCryptoNativeModule,
} from './sync-crypto-native';

import vectors from '../../../packages/core/src/__fixtures__/sync-crypto/vectors.json';
import primitiveVectors from '../../../packages/core/src/__fixtures__/sync-crypto/primitive-vectors.json';


const nodeBackedQuickCrypto: SyncCryptoNativeModule = {
  argon2: (algorithm, params, callback) => {
    if (algorithm !== 'argon2id') {
      callback(new Error(`unexpected algorithm ${algorithm}`), new Uint8Array(0));
      return;
    }
    try {
      const out = argon2id(params.message, params.nonce, {
        m: params.memory,
        t: params.passes,
        p: params.parallelism,
        dkLen: params.tagLength,
      });
      callback(null, out);
    } catch (err) {
      callback(err as Error, new Uint8Array(0));
    }
  },
  createCipheriv: (algorithm, key, iv) => nodeCrypto.createCipheriv(algorithm, key, iv) as never,
  createDecipheriv: (algorithm, key, iv) => nodeCrypto.createDecipheriv(algorithm, key, iv) as never,
  createHash: (algorithm) => nodeCrypto.createHash(algorithm) as never,
  randomBytes: (size) => new Uint8Array(nodeCrypto.randomBytes(size)),
};

const fromBase64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));

type Vector = {
  name: string;
  passphrase: string;
  saltB64: string;
  params: { mKib: number; t: number; p: number };
  plaintextB64: string;
  encryptedB64: string;
};

describe('mobileSyncCryptoPrimitives', () => {
  setSyncCryptoNativeModuleForTests(nodeBackedQuickCrypto);
  afterEach(() => setSyncCryptoNativeModuleForTests(nodeBackedQuickCrypto));

  it('decrypts every phase-1 fixture vector produced by the reference implementation', async () => {
    for (const vector of vectors as Vector[]) {
      const material = await deriveSyncKeyMaterial(
        vector.passphrase,
        fromBase64(vector.saltB64),
        vector.params,
        mobileSyncCryptoPrimitives,
      );
      const plaintext = await decryptSyncArtifact(
        fromBase64(vector.encryptedB64),
        material.key,
        mobileSyncCryptoPrimitives,
      );
      expect(Buffer.from(plaintext).toString('base64'), vector.name).toBe(vector.plaintextB64);
    }
  }, 30_000);

  it('produces containers the reference (WebCrypto + noble) implementation can open', async () => {
    const vector = (vectors as Vector[])[1];
    const material = await deriveSyncKeyMaterial(
      vector.passphrase,
      fromBase64(vector.saltB64),
      vector.params,
      mobileSyncCryptoPrimitives,
    );
    const sealed = await encryptSyncArtifact(
      fromBase64(vector.plaintextB64),
      material,
      mobileSyncCryptoPrimitives,
    );
    const opened = await decryptSyncArtifact(sealed, material.key, defaultSyncCryptoPrimitives);
    expect(Buffer.from(opened).toString('base64')).toBe(vector.plaintextB64);
  }, 30_000);

  it('derives the same key as the reference implementation for the same passphrase/salt/params', async () => {
    const salt = fromBase64((vectors as Vector[])[0].saltB64);
    const params = { mKib: 64, t: 1, p: 1 };
    const mine = await deriveSyncKeyMaterial('shared', salt, params, mobileSyncCryptoPrimitives);
    const reference = await deriveSyncKeyMaterial('shared', salt, params, defaultSyncCryptoPrimitives);
    expect(Buffer.from(mine.key).toString('hex')).toBe(Buffer.from(reference.key).toString('hex'));
  });

  it('raises SyncCryptoAuthError for a tampered tag rather than returning garbage', async () => {
    const vector = (vectors as Vector[])[0];
    const material = await deriveSyncKeyMaterial(
      vector.passphrase,
      fromBase64(vector.saltB64),
      vector.params,
      mobileSyncCryptoPrimitives,
    );
    const tampered = fromBase64(vector.encryptedB64);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(
      decryptSyncArtifact(tampered, material.key, mobileSyncCryptoPrimitives),
    ).rejects.toBeInstanceOf(SyncCryptoAuthError);
  });

  it('raises SyncCryptoAuthError for the wrong key rather than returning garbage', async () => {
    const vector = (vectors as Vector[])[0];
    const wrong = await deriveSyncKeyMaterial(
      'not the passphrase',
      fromBase64(vector.saltB64),
      vector.params,
      mobileSyncCryptoPrimitives,
    );
    await expect(
      decryptSyncArtifact(fromBase64(vector.encryptedB64), wrong.key, mobileSyncCryptoPrimitives),
    ).rejects.toBeInstanceOf(SyncCryptoAuthError);
  });

  it('authenticates the header as AAD — a header edit invalidates the container', async () => {
    const vector = (vectors as Vector[])[0];
    const material = await deriveSyncKeyMaterial(
      vector.passphrase,
      fromBase64(vector.saltB64),
      vector.params,
      mobileSyncCryptoPrimitives,
    );
    const tampered = fromBase64(vector.encryptedB64);
    tampered[34] ^= 0x01;
    await expect(
      decryptSyncArtifact(tampered, material.key, mobileSyncCryptoPrimitives),
    ).rejects.toBeInstanceOf(SyncCryptoAuthError);
  });

  it('returns exactly the requested number of random bytes', () => {
    expect(mobileSyncCryptoPrimitives.randomBytes(12)).toHaveLength(12);
    expect(mobileSyncCryptoPrimitives.randomBytes(16)).toHaveLength(16);
  });

  it('rejects (never throws synchronously) when the native module reports a bad parameter', async () => {
    setSyncCryptoNativeModuleForTests({
      ...nodeBackedQuickCrypto,
      argon2: () => {
        throw new RangeError('Invalid Argon2 parallelism: 0');
      },
    });
    await expect(
      mobileSyncCryptoPrimitives.argon2id(new Uint8Array(1), new Uint8Array(16), { mKib: 8, t: 1, p: 0 }, 32),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe('mobileSha256Hex', () => {
  setSyncCryptoNativeModuleForTests(nodeBackedQuickCrypto);
  afterEach(() => setSyncCryptoNativeModuleForTests(nodeBackedQuickCrypto));

  it('produces the canonical sha256 digest of the bytes it is given', () => {
    expect(mobileSha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('satisfies core as an attachment digest provider', async () => {
    setSha256HexProvider(mobileSha256Hex);
    try {
      expect(await computeSha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    } finally {
      setSha256HexProvider(null);
    }
  });
});

describe('native module unavailability latch', () => {
  afterEach(() => {
    setExpoGoProbeForTests(null);
    setSyncCryptoNativeModuleForTests(nodeBackedQuickCrypto);
  });

  it('refuses encryption with one clean cached error in Expo Go instead of requiring the native module', () => {
    setExpoGoProbeForTests(() => true);
    setSyncCryptoNativeModuleForTests(null);

    const attempt = (): unknown => {
      try {
        return mobileSyncCryptoPrimitives.randomBytes(1);
      } catch (error) {
        return error;
      }
    };
    const first = attempt();
    expect(String(first)).toMatch(/Expo Go/);
    expect(String(first)).not.toMatch(/Invariant/);
    expect(attempt()).toBe(first);
  });

  it('outside Expo Go a missing native module still fails the digest instead of silently switching to JS', () => {
    setExpoGoProbeForTests(() => false);
    setSyncCryptoNativeModuleForTests(null);


    expect(() => mobileSha256Hex(new Uint8Array([1]))).toThrow(/rebuild the app/);
  });

  it('still digests attachments in Expo Go, in pure JS, so plaintext sync does not depend on the encryption module', () => {
    setExpoGoProbeForTests(() => true);
    setSyncCryptoNativeModuleForTests(null);

    expect(mobileSha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});


describe('mobileSyncCryptoPrimitives on OpenSSL against the shared primitive vectors', () => {
  const fromHex = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'));
  const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
  const opensslArgon2id: SyncCryptoNativeModule['argon2'] = (_algorithm, params, callback) => {
    try {
      const out = execFileSync('openssl', ['kdf', '-binary', '-keylen', String(params.tagLength),
        '-kdfopt', `hexpass:${toHex(params.message)}`, '-kdfopt', `hexsalt:${toHex(params.nonce)}`,
        '-kdfopt', `memcost:${params.memory}`, '-kdfopt', `iter:${params.passes}`, '-kdfopt', `lanes:${params.parallelism}`, 'ARGON2ID'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
      callback(null, new Uint8Array(out));
    } catch (err) {
      callback(err as Error, new Uint8Array(0));
    }
  };
  const hasOpensslArgon2id = (() => {
    try {
      execFileSync('openssl', ['kdf', '-keylen', '32', '-kdfopt', 'pass:x', '-kdfopt', 'salt:saltsalt', '-kdfopt', 'memcost:8',
        '-kdfopt', 'iter:1', 'ARGON2ID'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  afterEach(() => setSyncCryptoNativeModuleForTests(nodeBackedQuickCrypto));

  it.skipIf(!hasOpensslArgon2id)('derives every Argon2id key as OpenSSL does', async () => {
    setSyncCryptoNativeModuleForTests({ ...nodeBackedQuickCrypto, argon2: opensslArgon2id });
    for (const vector of primitiveVectors.argon2id) {
      const key = await mobileSyncCryptoPrimitives.argon2id(fromHex(vector.passHex), fromHex(vector.saltHex),
        { mKib: vector.mKib, t: vector.t, p: vector.p }, vector.dkLen);
      expect(toHex(key), vector.passphrase).toBe(vector.keyHex);
    }
  });

  it('seals, opens and hashes every case as OpenSSL does', async () => {
    setSyncCryptoNativeModuleForTests(nodeBackedQuickCrypto);
    for (const vector of primitiveVectors.aesGcm) {
      const [key, nonce, plaintext, aad] = [vector.keyHex, vector.nonceHex, vector.plaintextHex, vector.aadHex].map(fromHex);
      expect(toHex(await mobileSyncCryptoPrimitives.aesGcmSeal(key, nonce, plaintext, aad))).toBe(vector.sealedHex);
      expect(toHex(await mobileSyncCryptoPrimitives.aesGcmOpen(key, nonce, fromHex(vector.sealedHex), aad))).toBe(vector.plaintextHex);
    }
    for (const vector of primitiveVectors.sha256) {
      expect(mobileSha256Hex(fromHex(vector.inputHex))).toBe(vector.digestHex);
    }
  });
});
