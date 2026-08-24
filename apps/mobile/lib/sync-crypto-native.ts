// Mobile SyncCryptoPrimitives (#1056 phase 2). Hermes has no WebCrypto and no Node
// `crypto`, and core's default primitives (WebCrypto AES-GCM + @noble/hashes Argon2id)
// are FORBIDDEN here: pure-JS Argon2id at m=19 MiB blocks the JS thread for tens of
// seconds and pure-JS AES costs seconds per sync cycle. Everything below is native
// (react-native-quick-crypto -> Nitro/C++ -> OpenSSL 3.6):
//   - argon2id  -> QuickCrypto.argon2('argon2id', ...) — the *callback* form, which runs
//                  on a background thread (HybridArgon2::hash uses Promise::async), NOT
//                  argon2Sync, which would block the JS thread exactly like the pure-JS
//                  implementation we are avoiding.
//   - aesGcm*   -> QuickCrypto.createCipheriv/createDecipheriv('aes-256-gcm', ...), the
//                  Node-compatible surface, so this adapter can be exercised in the
//                  node-environment vitest suite against node's own `crypto` (see
//                  setSyncCryptoNativeModuleForTests) — same API, same semantics.
//   - randomBytes -> QuickCrypto.randomBytes (OpenSSL RAND_bytes).
//
// The module is `require`d lazily so that merely importing this file (which half of the
// sync stack does, transitively) never pulls a native TurboModule into a unit test.

import { SyncCryptoAuthError, type SyncCryptoPrimitives } from '@mindwtr/core';

const AES_GCM_TAG_LEN = 16;

type CipherLike = {
    update(data: Uint8Array): Uint8Array;
    final(): Uint8Array;
    setAAD(aad: Uint8Array, options?: { plaintextLength: number }): unknown;
    getAuthTag(): Uint8Array;
    setAuthTag(tag: Uint8Array): unknown;
};

type HashLike = {
    update(data: Uint8Array): HashLike;
    digest(encoding: 'hex'): string;
};

/** The slice of react-native-quick-crypto's surface this adapter uses. Deliberately
 *  structural and Node-`crypto`-shaped so tests can substitute node's implementation. */
export type SyncCryptoNativeModule = {
    argon2(
        algorithm: 'argon2id',
        params: {
            message: Uint8Array;
            nonce: Uint8Array;
            parallelism: number;
            tagLength: number;
            memory: number;
            passes: number;
        },
        callback: (err: Error | null, result: Uint8Array) => void,
    ): void;
    createCipheriv(algorithm: 'aes-256-gcm', key: Uint8Array, iv: Uint8Array): CipherLike;
    createDecipheriv(algorithm: 'aes-256-gcm', key: Uint8Array, iv: Uint8Array): CipherLike;
    createHash(algorithm: 'sha256'): HashLike;
    randomBytes(size: number): Uint8Array;
};

let nativeModule: SyncCryptoNativeModule | null = null;
let nativeModuleError: Error | null = null;

/** Test seam, mirroring storage-adapter.ts's `setSqliteInitializerForTests` convention.
 *  Pass `null` to fall back to the real native module. */
export const setSyncCryptoNativeModuleForTests = (module: SyncCryptoNativeModule | null): void => {
    nativeModule = module;
    nativeModuleError = null;
};

const defaultIsExpoGo = (): boolean => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const constants = require('expo-constants') as {
            default?: { appOwnership?: string | null };
            appOwnership?: string | null;
        };
        return (constants.default ?? constants).appOwnership === 'expo';
    } catch {
        return false;
    }
};

let isExpoGo: () => boolean = defaultIsExpoGo;

/** Test seam. Pass `null` to restore the real expo-constants probe. */
export const setExpoGoProbeForTests = (probe: (() => boolean) | null): void => {
    isExpoGo = probe ?? defaultIsExpoGo;
};

const getNativeModule = (): SyncCryptoNativeModule => {
    if (nativeModule) return nativeModule;
    // Latch failures: requiring quick-crypto in a binary that lacks it throws a loud
    // TurboModule Invariant Violation that LogBox red-boxes on every attempt (one per
    // attachment per sync cycle in Expo Go). Detect Expo Go before ever touching the
    // require, and cache the failure either way so callers get one clean, stable error.
    if (nativeModuleError) throw nativeModuleError;
    if (isExpoGo()) {
        nativeModuleError = new Error(
            'Sync encryption and attachment hashing need a development build; ' +
                'react-native-quick-crypto cannot load in Expo Go.',
        );
        throw nativeModuleError;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        nativeModule = require('react-native-quick-crypto') as SyncCryptoNativeModule;
    } catch (error) {
        nativeModuleError = new Error(
            'react-native-quick-crypto native module unavailable (rebuild the app): ' +
                (error instanceof Error ? error.message : String(error)),
        );
        throw nativeModuleError;
    }
    return nativeModule;
};

/** Copy into a standalone Uint8Array: quick-crypto hands back `Buffer` views over pooled
 *  backing stores, so retaining the view retains (and can alias) the pool. */
const toBytes = (value: Uint8Array): Uint8Array => {
    const out = new Uint8Array(value.byteLength);
    out.set(value);
    return out;
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
};

export const mobileSyncCryptoPrimitives: SyncCryptoPrimitives = {
    argon2id(pass, salt, params, dkLen) {
        return new Promise<Uint8Array>((resolve, reject) => {
            try {
                getNativeModule().argon2(
                    'argon2id',
                    {
                        message: pass,
                        nonce: salt,
                        parallelism: params.p,
                        tagLength: dkLen,
                        memory: params.mKib,
                        passes: params.t,
                    },
                    (err, result) => {
                        if (err) reject(err);
                        else resolve(toBytes(result));
                    },
                );
            } catch (err) {
                // quick-crypto validates params synchronously before dispatching to the
                // worker; deriveSyncKeyMaterial expects a rejected promise either way.
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    },

    async aesGcmSeal(key, nonce, plaintext, aad) {
        const cipher = getNativeModule().createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aad);
        const body = concat(toBytes(cipher.update(plaintext)), toBytes(cipher.final()));
        return concat(body, toBytes(cipher.getAuthTag()));
    },

    async aesGcmOpen(key, nonce, ctAndTag, aad) {
        if (ctAndTag.length < AES_GCM_TAG_LEN) {
            // Too short to even carry a tag — indistinguishable from a bad tag to the
            // caller by design, and OpenSSL would reject it anyway.
            throw new SyncCryptoAuthError();
        }
        const decipher = getNativeModule().createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(ctAndTag.subarray(ctAndTag.length - AES_GCM_TAG_LEN));
        try {
            const head = toBytes(decipher.update(ctAndTag.subarray(0, ctAndTag.length - AES_GCM_TAG_LEN)));
            // OpenSSL only reports the tag mismatch here, on final().
            return concat(head, toBytes(decipher.final()));
        } catch {
            throw new SyncCryptoAuthError();
        }
    },

    randomBytes(n) {
        const bytes = toBytes(getNativeModule().randomBytes(n));
        if (bytes.length !== n) {
            throw new Error(`randomBytes(${n}) returned ${bytes.length} bytes`);
        }
        return bytes;
    },
};

/**
 * Core's attachment integrity digest (#1057 / SEC-05). Hermes has no `crypto.subtle`, so
 * without this core computes nothing and every hash check on mobile is a no-op — which,
 * now that validation fails closed, would strand every downloaded attachment. Same native
 * module, same Node-shaped API, so the node-environment vitest suite exercises it against
 * node's own `crypto`.
 */
export const mobileSha256Hex = (bytes: Uint8Array): string =>
    getNativeModule().createHash('sha256').update(bytes).digest('hex');
