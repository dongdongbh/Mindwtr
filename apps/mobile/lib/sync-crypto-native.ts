


import { SyncCryptoAuthError, type SyncCryptoPrimitives } from '@mindwtr/core';
import { sha256 as pureJsSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { isExpoGo as sharedIsExpoGo } from './expo-go';

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


export const setSyncCryptoNativeModuleForTests = (module: SyncCryptoNativeModule | null): void => {
    nativeModule = module;
    nativeModuleError = null;
};

let isExpoGo: () => boolean = sharedIsExpoGo;


export const setExpoGoProbeForTests = (probe: (() => boolean) | null): void => {
    isExpoGo = probe ?? sharedIsExpoGo;
};

const getNativeModule = (): SyncCryptoNativeModule => {
    if (nativeModule) return nativeModule;


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


            throw new SyncCryptoAuthError();
        }
        const decipher = getNativeModule().createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(ctAndTag.subarray(ctAndTag.length - AES_GCM_TAG_LEN));
        try {
            const head = toBytes(decipher.update(ctAndTag.subarray(0, ctAndTag.length - AES_GCM_TAG_LEN)));

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


export const mobileSha256Hex = (bytes: Uint8Array): string => {


    if (isExpoGo()) return bytesToHex(pureJsSha256(bytes));
    return getNativeModule().createHash('sha256').update(bytes).digest('hex');
};
