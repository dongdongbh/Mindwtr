// Sync encryption container format "MWENC1" (issue #1056, phase 1 of 3). The byte layout below
// is pinned in the task handoff and mirrored byte-for-byte by the Rust implementation in
// apps/desktop/src-tauri/src/sync_crypto.rs; the two are proven interoperable by the shared
// fixtures in ./__fixtures__/sync-crypto/vectors.json. This module implements ONLY the format —
// no sync wiring, no settings, no UI. Later phases build storage-seam and UI on top of this API.
//
// Container layout, all integers little-endian:
//   0   6  magic "MWENC1"
//   6   1  format_version = 0x01
//   7   1  kdf_id = 0x01 (Argon2id v1.3)
//   8   4  argon2 m_cost in KiB, u32
//   12  4  argon2 t_cost, u32
//   16  1  argon2 parallelism, u8
//   17  1  cipher_id = 0x01 (AES-256-GCM, 16-byte tag)
//   18  16 KDF salt
//   34  12 AES-GCM nonce
//   46  8  ciphertext_len, u64 (INCLUDES the 16-byte GCM tag)
//   54  .. ciphertext || tag
// AAD is the full 54-byte header. Bytes past 54+ciphertext_len are ignored on read (non-truncating
// sync providers pad files). Magic missing means "plaintext", not an error — callers use
// inspectSyncArtifact to tell unencrypted files from encrypted ones before deciding what to do.

import { argon2idAsync } from '@noble/hashes/argon2.js';

const MAGIC = new Uint8Array([0x4d, 0x57, 0x45, 0x4e, 0x43, 0x31]); // ASCII "MWENC1"
const HEADER_LEN = 54;
const FORMAT_VERSION = 0x01;
const KDF_ID_ARGON2ID = 0x01;
const CIPHER_ID_AES_256_GCM = 0x01;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const GCM_TAG_LEN = 16;
const KEY_LEN = 32;

// Sanity ceiling on header-declared Argon2id cost. A reader has no choice but to run Argon2 at
// the header's cost before the GCM tag can even be checked (the key is needed to authenticate),
// so an attacker-controlled or merely corrupt header could otherwise wedge or OOM the app before
// any authentication happens. This does not change the pinned byte layout, only which headers a
// reader accepts. Writer defaults (SYNC_CRYPTO_DEFAULT_KDF_PARAMS) are far below this ceiling.
const KDF_COST_CEILING_M_KIB = 262144; // 256 MiB
const KDF_COST_CEILING_T = 16;
const KDF_COST_CEILING_P = 8;

export type SyncCryptoKdfParams = { mKib: number; t: number; p: number };

/** Writer-default Argon2id cost. Readers always use the params recorded in the file's header. */
export const SYNC_CRYPTO_DEFAULT_KDF_PARAMS: SyncCryptoKdfParams = { mKib: 19456, t: 2, p: 1 };

export type SyncCryptoPrimitives = {
    argon2id(pass: Uint8Array, salt: Uint8Array, params: SyncCryptoKdfParams, dkLen: number): Promise<Uint8Array>;
    /** Returns ciphertext with the 16-byte GCM tag appended. */
    aesGcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
    /** Throws SyncCryptoAuthError on tag/AAD mismatch. */
    aesGcmOpen(key: Uint8Array, nonce: Uint8Array, ctAndTag: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
    randomBytes(n: number): Uint8Array;
};

/** Thrown when GCM authentication fails. Wrong passphrase and corrupted data are indistinguishable
 * by design at the cipher layer — never claim which one it was. */
export class SyncCryptoAuthError extends Error {
    constructor(message = 'wrong passphrase or corrupted data') {
        super(message);
        this.name = 'SyncCryptoAuthError';
    }
}

/** Thrown when a header is present but its version/kdf/cipher ids are unknown, or the header is
 * truncated/inconsistent. Never offer a "repair" or "partial read" affordance for this — fail closed. */
export class SyncCryptoUnsupportedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SyncCryptoUnsupportedError';
    }
}

// TS's DOM lib types WebCrypto's BufferSource params as ArrayBuffer-backed views only; a plain
// `new Uint8Array(n)` (or one sliced from it) types as `Uint8Array<ArrayBufferLike>`, which also
// covers SharedArrayBuffer, so it doesn't satisfy that. Copy into a fresh ArrayBuffer-backed view.
function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const buffer = new ArrayBuffer(bytes.byteLength);
    const view = new Uint8Array(buffer);
    view.set(bytes);
    return view;
}

export const defaultSyncCryptoPrimitives: SyncCryptoPrimitives = {
    async argon2id(pass, salt, params, dkLen) {
        return argon2idAsync(pass, salt, { m: params.mKib, t: params.t, p: params.p, dkLen });
    },
    async aesGcmSeal(key, nonce, plaintext, aad) {
        const cryptoKey = await globalThis.crypto.subtle.importKey('raw', toArrayBufferView(key), 'AES-GCM', false, ['encrypt']);
        const sealed = await globalThis.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: toArrayBufferView(nonce), additionalData: toArrayBufferView(aad) },
            cryptoKey,
            toArrayBufferView(plaintext),
        );
        return new Uint8Array(sealed);
    },
    async aesGcmOpen(key, nonce, ctAndTag, aad) {
        const cryptoKey = await globalThis.crypto.subtle.importKey('raw', toArrayBufferView(key), 'AES-GCM', false, ['decrypt']);
        try {
            const opened = await globalThis.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: toArrayBufferView(nonce), additionalData: toArrayBufferView(aad) },
                cryptoKey,
                toArrayBufferView(ctAndTag),
            );
            return new Uint8Array(opened);
        } catch {
            throw new SyncCryptoAuthError();
        }
    },
    randomBytes(n) {
        const bytes = new Uint8Array(n);
        globalThis.crypto.getRandomValues(bytes);
        return bytes;
    },
};

export type SyncKeyMaterial = { key: Uint8Array; salt: Uint8Array; params: SyncCryptoKdfParams };

export async function deriveSyncKeyMaterial(
    passphrase: string,
    salt: Uint8Array,
    params: SyncCryptoKdfParams = SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
): Promise<SyncKeyMaterial> {
    // NFC normalization ensures the same passphrase typed with a precomposed accent (é) or a
    // decomposed one (e + combining acute) derives the identical key.
    const passBytes = new TextEncoder().encode(passphrase.normalize('NFC'));
    let key: Uint8Array;
    try {
        key = await prims.argon2id(passBytes, salt, params, KEY_LEN);
    } catch (err) {
        // params can come straight from an attacker-influenceable file header (via
        // inspectSyncArtifact), so an out-of-range Argon2id param must not escape as a raw Error.
        throw new SyncCryptoUnsupportedError(
            `invalid Argon2id parameters: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    return { key, salt, params };
}

function readU32LE(bytes: Uint8Array, offset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
    new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value, true);
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
}

function writeU64LE(bytes: Uint8Array, offset: number, value: bigint): void {
    new DataView(bytes.buffer, bytes.byteOffset + offset, 8).setBigUint64(0, value, true);
}

const U32_MAX = 0xffffffff;

/** Wire-format fit for the header's fixed-width fields — m_kib/t are u32, p is a u8 that must be
 * at least 1 (Argon2id requires >=1 lane). This is deliberately separate from the KDF cost
 * ceiling above: this only asks "can the header even represent these params losslessly." */
function isValidKdfParams(params: SyncCryptoKdfParams): boolean {
    return (
        Number.isInteger(params.mKib) &&
        params.mKib >= 0 &&
        params.mKib <= U32_MAX &&
        Number.isInteger(params.t) &&
        params.t >= 0 &&
        params.t <= U32_MAX &&
        Number.isInteger(params.p) &&
        params.p >= 1 &&
        params.p <= 0xff
    );
}

/** The artifact magic as text: a strict UTF-8 body that does not start with it is plaintext ({@link inspectSyncArtifact}). */
export const SYNC_ARTIFACT_MAGIC_TEXT = String.fromCharCode(...MAGIC);

function hasMagic(bytes: Uint8Array): boolean {
    if (bytes.length < MAGIC.length) return false;
    for (let i = 0; i < MAGIC.length; i += 1) {
        if (bytes[i] !== MAGIC[i]) return false;
    }
    return true;
}

export type ParsedHeaderFields = {
    formatVersion: number;
    kdfId: number;
    params: SyncCryptoKdfParams;
    cipherId: number;
    salt: Uint8Array;
    nonce: Uint8Array;
    ciphertextLen: number;
};

/** Assumes the magic has already been checked by the caller. Throws SyncCryptoUnsupportedError
 * for anything wrong with the header itself (never for a missing magic — that's "plaintext"). */
function parseHeader(bytes: Uint8Array): ParsedHeaderFields {
    if (bytes.length < HEADER_LEN) {
        throw new SyncCryptoUnsupportedError('MWENC1 header truncated');
    }
    const formatVersion = bytes[6];
    const kdfId = bytes[7];
    const cipherId = bytes[17];
    if (formatVersion !== FORMAT_VERSION) {
        throw new SyncCryptoUnsupportedError(`unsupported MWENC1 format_version ${formatVersion}`);
    }
    if (kdfId !== KDF_ID_ARGON2ID) {
        throw new SyncCryptoUnsupportedError(`unsupported MWENC1 kdf_id ${kdfId}`);
    }
    if (cipherId !== CIPHER_ID_AES_256_GCM) {
        throw new SyncCryptoUnsupportedError(`unsupported MWENC1 cipher_id ${cipherId}`);
    }
    const mKib = readU32LE(bytes, 8);
    const t = readU32LE(bytes, 12);
    const p = bytes[16];
    if (mKib > KDF_COST_CEILING_M_KIB || t > KDF_COST_CEILING_T || p > KDF_COST_CEILING_P) {
        throw new SyncCryptoUnsupportedError(
            `MWENC1 KDF cost exceeds accepted ceiling (m_kib<=${KDF_COST_CEILING_M_KIB}, t<=${KDF_COST_CEILING_T}, p<=${KDF_COST_CEILING_P})`,
        );
    }
    const salt = bytes.slice(18, 34);
    const nonce = bytes.slice(34, 46);
    const ciphertextLenBig = readU64LE(bytes, 46);
    if (ciphertextLenBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new SyncCryptoUnsupportedError('MWENC1 ciphertext_len exceeds supported range');
    }
    const ciphertextLen = Number(ciphertextLenBig);
    if (HEADER_LEN + ciphertextLen > bytes.length) {
        throw new SyncCryptoUnsupportedError('MWENC1 ciphertext_len exceeds available bytes');
    }
    return { formatVersion, kdfId, params: { mKib, t, p }, cipherId, salt, nonce, ciphertextLen };
}

export type SyncArtifactInspection =
    | ({ kind: 'encrypted' } & ParsedHeaderFields)
    | { kind: 'unsupported'; reason: string }
    | { kind: 'plaintext' };

/** Pure, synchronous, never throws — callers use this to tell an unencrypted file from an
 * encrypted one, and an encrypted-but-unreadable one from either, before deciding what to do. */
export function inspectSyncArtifact(bytes: Uint8Array): SyncArtifactInspection {
    if (!hasMagic(bytes)) return { kind: 'plaintext' };
    try {
        const header = parseHeader(bytes);
        return { kind: 'encrypted', ...header };
    } catch (err) {
        return { kind: 'unsupported', reason: err instanceof Error ? err.message : String(err) };
    }
}

export async function encryptSyncArtifact(
    plaintext: Uint8Array,
    material: SyncKeyMaterial,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
): Promise<Uint8Array> {
    if (material.key.length !== KEY_LEN) {
        // WebCrypto happily imports a 16- or 24-byte key as AES-128/192-GCM, which would silently
        // write a container whose header claims cipher_id 0x01 (AES-256-GCM) but whose body isn't.
        throw new SyncCryptoUnsupportedError(`sync key material key must be ${KEY_LEN} bytes`);
    }
    if (material.salt.length !== SALT_LEN) {
        throw new SyncCryptoUnsupportedError(`sync key material salt must be ${SALT_LEN} bytes`);
    }
    if (!isValidKdfParams(material.params)) {
        // Writing out-of-range params would truncate into the fixed-width header fields (e.g. p=256
        // wraps to 0 mod 256) while the key was derived from the un-truncated values, producing a
        // file that can never reproduce its own key.
        throw new SyncCryptoUnsupportedError('sync key material params do not fit the MWENC1 header fields');
    }
    const nonce = prims.randomBytes(NONCE_LEN);
    if (nonce.length !== NONCE_LEN) {
        throw new SyncCryptoUnsupportedError(`randomBytes(${NONCE_LEN}) returned ${nonce.length} bytes`);
    }
    const ciphertextLen = plaintext.length + GCM_TAG_LEN;
    const header = new Uint8Array(HEADER_LEN);
    header.set(MAGIC, 0);
    header[6] = FORMAT_VERSION;
    header[7] = KDF_ID_ARGON2ID;
    writeU32LE(header, 8, material.params.mKib);
    writeU32LE(header, 12, material.params.t);
    header[16] = material.params.p;
    header[17] = CIPHER_ID_AES_256_GCM;
    header.set(material.salt, 18);
    header.set(nonce, 34);
    writeU64LE(header, 46, BigInt(ciphertextLen));

    const ctAndTag = await prims.aesGcmSeal(material.key, nonce, plaintext, header);
    const out = new Uint8Array(HEADER_LEN + ctAndTag.length);
    out.set(header, 0);
    out.set(ctAndTag, HEADER_LEN);
    return out;
}

export async function decryptSyncArtifact(
    bytes: Uint8Array,
    key: Uint8Array,
    prims: SyncCryptoPrimitives = defaultSyncCryptoPrimitives,
): Promise<Uint8Array> {
    if (key.length !== KEY_LEN) {
        throw new SyncCryptoUnsupportedError(`sync key must be ${KEY_LEN} bytes`);
    }
    if (!hasMagic(bytes)) {
        throw new SyncCryptoUnsupportedError('missing MWENC1 magic');
    }
    const header = parseHeader(bytes);
    const aad = bytes.slice(0, HEADER_LEN);
    const ctAndTag = bytes.slice(HEADER_LEN, HEADER_LEN + header.ciphertextLen);
    return prims.aesGcmOpen(key, header.nonce, ctAndTag, aad);
}
