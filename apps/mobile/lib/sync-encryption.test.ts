import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import type { AppData } from '@mindwtr/core';

// ---------------------------------------------------------------------------
// In-memory filesystem shared by the `./file-system` (legacy + SAF) and
// `expo-file-system` (modern File/Directory) mocks, so a byte written through
// one API is visible through the other — exactly the mixed-API ladder
// storage-file.ts walks on a real device.
// ---------------------------------------------------------------------------
const fs = vi.hoisted(() => {
  const files = new Map<string, Uint8Array>();
  /** Providers that refuse to shrink a file: a shorter write leaves the tail behind.
   *  This is what padForNonTruncatingOverwrite exists for. */
  const nonTruncating = { enabled: false };
  const toBytes = (content: string, encoding?: string): Uint8Array =>
    new Uint8Array(Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8'));
  const write = (uri: string, bytes: Uint8Array) => {
    const previous = files.get(uri);
    if (nonTruncating.enabled && previous && previous.length > bytes.length) {
      const merged = new Uint8Array(previous);
      merged.set(bytes, 0);
      files.set(uri, merged);
      return;
    }
    files.set(uri, bytes);
  };
  return { files, nonTruncating, toBytes, write };
});

const dirOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/'));
const leafOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

vi.mock('./file-system', () => {
  const read = (uri: string, options?: { encoding?: string }) => {
    const bytes = fs.files.get(uri);
    if (!bytes) throw new Error(`ENOENT ${uri}`);
    return Buffer.from(bytes).toString(options?.encoding === 'base64' ? 'base64' : 'utf8');
  };
  const StorageAccessFramework = {
    readAsStringAsync: vi.fn(async (uri: string, options?: { encoding?: string }) => read(uri, options)),
    writeAsStringAsync: vi.fn(async (uri: string, content: string, options?: { encoding?: string }) => {
      fs.write(uri, fs.toBytes(content, options?.encoding));
    }),
    readDirectoryAsync: vi.fn(async (dir: string) =>
      [...fs.files.keys()].filter((uri) => dirOf(uri) === dir.replace(/\/+$/, ''))),
    createFileAsync: vi.fn(async (dir: string, name: string) => {
      const uri = `${dir.replace(/\/+$/, '')}/${name}`;
      if (!fs.files.has(uri)) fs.files.set(uri, new Uint8Array(0));
      return uri;
    }),
    deleteAsync: vi.fn(async (uri: string) => { fs.files.delete(uri); }),
    requestDirectoryPermissionsAsync: vi.fn(),
    makeDirectoryAsync: vi.fn(),
  };
  return {
    StorageAccessFramework,
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    getInfoAsync: vi.fn(async (uri: string) => ({ exists: fs.files.has(uri), size: fs.files.get(uri)?.length ?? 0 })),
    readAsStringAsync: vi.fn(async (uri: string, options?: { encoding?: string }) => read(uri, options)),
    writeAsStringAsync: vi.fn(async (uri: string, content: string, options?: { encoding?: string }) => {
      fs.write(uri, fs.toBytes(content, options?.encoding));
    }),
    readDirectoryAsync: vi.fn(async (dir: string) =>
      [...fs.files.keys()].filter((uri) => dirOf(uri) === dir.replace(/\/+$/, '')).map(leafOf)),
    deleteAsync: vi.fn(async (uri: string) => { fs.files.delete(uri); }),
    copyAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const bytes = fs.files.get(from);
      if (bytes) fs.files.set(to, bytes);
    }),
    moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
      const bytes = fs.files.get(from);
      if (bytes) { fs.files.set(to, bytes); fs.files.delete(from); }
    }),
    makeDirectoryAsync: vi.fn(async () => undefined),
    cacheDirectory: 'file://cache/',
    documentDirectory: 'file://document/',
  };
});

vi.mock('expo-file-system', () => {
  class File {
    constructor(public uri: string) {}
    get exists() { return fs.files.has(this.uri); }
    create() { if (!fs.files.has(this.uri)) fs.files.set(this.uri, new Uint8Array(0)); }
    write(content: string | Uint8Array) {
      fs.write(this.uri, typeof content === 'string' ? fs.toBytes(content) : content);
    }
    async bytes() { return fs.files.get(this.uri) ?? new Uint8Array(0); }
    async text() { return Buffer.from(fs.files.get(this.uri) ?? new Uint8Array(0)).toString('utf8'); }
    delete() { fs.files.delete(this.uri); }
    copy(target: { uri: string }) { fs.files.set(target.uri, fs.files.get(this.uri) ?? new Uint8Array(0)); }
  }
  class Directory {
    constructor(public uri: string) {}
    get exists() {
      const prefix = `${this.uri.replace(/\/+$/, '')}/`;
      return [...fs.files.keys()].some((uri) => uri.startsWith(prefix));
    }
    static pickDirectoryAsync = undefined;
  }
  return { File, Directory, Paths: { cache: 'cache', document: 'document' } };
});

vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock('./sync-path-bookmarks', () => ({
  createSyncPathBookmark: vi.fn(async () => null),
  readBookmarkedSyncFileText: vi.fn(async () => null),
  supportsBookmarkedSyncFileIO: () => false,
  isSyncPathBookmarksAvailable: () => false,
  resolveSyncPathBookmark: vi.fn(async () => null),
  writeBookmarkedSyncFileText: vi.fn(async () => undefined),
}));
vi.mock('./app-log', () => ({
  logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logSyncError: vi.fn(),
  sanitizeLogMessage: (value: string) => value,
}));

const asyncStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { asyncStorage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { asyncStorage.delete(key); }),
  },
}));

import {
  deriveSyncKeyMaterial,
  inspectSyncArtifact,
  SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
  SyncEncryptionRemotePlaintextError,
  SyncEncryptionTerminalError,
  encryptSyncArtifact,
  type SyncKeyMaterial,
} from '@mindwtr/core';
import { readSyncFile, writeSyncFile } from './storage-file';
import {
  padBytesForNonTruncatingOverwrite,
  readSyncArtifactBytes,
  writeSyncArtifactBytes,
} from './storage-file-encryption';
import {
  mobileSyncCryptoPrimitives,
  setSyncCryptoNativeModuleForTests,
  type SyncCryptoNativeModule,
} from './sync-crypto-native';
import {
  __resetSyncEncryptionStateForTests,
  flushSyncEncryptionLocalState,
  getMobileSyncEncryptionStatus,
  getSyncEncryptionMaterial,
  isSyncEncryptionBlocked,
  SyncEncryptionKeyMissingError,
  SyncEncryptionNoKeyError,
  syncEncryptionKeyCache,
  syncEncryptionLocalState,
} from './sync-encryption-state';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { runSerializedSyncDocumentOperation } from '@mindwtr/core';
import {
  changeSyncEncryptionPassphrase,
  disableSyncEncryption,
  enableSyncEncryption,
  isSyncEncryptionBackendPending,
  provideSyncEncryptionPassphrase,
} from './sync-encryption-service';
import { __resetSecureSecretStoreForTests } from './secure-secret-store';
import { SYNC_BACKEND_KEY, SYNC_ENCRYPTION_STATE_KEY, SYNC_PATH_KEY } from './sync-constants';

// Same node-backed stand-in for react-native-quick-crypto as sync-crypto-native.test.ts
// (its Node-compatible cipher surface plus quick-crypto's argon2 callback shape).
const nodeQuickCrypto: SyncCryptoNativeModule = {
  argon2: (_algorithm, params, callback) => {
    try {
      callback(null, argon2id(params.message, params.nonce, {
        m: params.memory, t: params.passes, p: params.parallelism, dkLen: params.tagLength,
      }));
    } catch (err) { callback(err as Error, new Uint8Array(0)); }
  },
  createCipheriv: (a, k, i) => nodeCrypto.createCipheriv(a, k, i) as never,
  createDecipheriv: (a, k, i) => nodeCrypto.createDecipheriv(a, k, i) as never,
  createHash: (a) => nodeCrypto.createHash(a) as never,
  randomBytes: (size) => new Uint8Array(nodeCrypto.randomBytes(size)),
};

const SYNC_DIR = 'file://sync';
const SYNC_URI = `${SYNC_DIR}/data.json`;
const ENC_URI = `${SYNC_DIR}/data.json.enc`;
const PASSPHRASE = 'correct horse battery staple';
// Cheap Argon2 params keep the suite fast; the real defaults are exercised by the
// transition tests below, which go through the production code path unchanged.
const FAST_PARAMS = { mKib: 64, t: 1, p: 1 };

const appData = (title: string): AppData => ({
  tasks: [{ id: 't1', title } as never],
  projects: [], sections: [], areas: [], settings: {},
} as unknown as AppData);

const textOf = (uri: string): string => Buffer.from(fs.files.get(uri) ?? new Uint8Array(0)).toString('utf8');

let material: SyncKeyMaterial;

beforeEach(async () => {
  fs.files.clear();
  fs.nonTruncating.enabled = false;
  asyncStorage.clear();
  __resetSyncEncryptionStateForTests();
  __resetSecureSecretStoreForTests();
  setSyncCryptoNativeModuleForTests(nodeQuickCrypto);
  material = await deriveSyncKeyMaterial(
    PASSPHRASE, new Uint8Array(16).fill(7), FAST_PARAMS, mobileSyncCryptoPrimitives,
  );
});

afterEach(() => { vi.clearAllMocks(); });

const seedEncrypted = async (data: AppData, key: SyncKeyMaterial = material, uri = ENC_URI) => {
  const sealed = await encryptSyncArtifact(
    new TextEncoder().encode(JSON.stringify(data, null, 2)), key, mobileSyncCryptoPrimitives,
  );
  fs.files.set(uri, sealed);
  return sealed;
};

describe('File Sync encryption — off state (backward-compat invariant #1)', () => {
  it('writes and reads plain data.json with no .enc artifact and no material', async () => {
    await writeSyncFile(SYNC_URI, appData('plain'));
    expect(fs.files.has(SYNC_URI)).toBe(true);
    expect(fs.files.has(ENC_URI)).toBe(false);
    expect(textOf(SYNC_URI)).toBe(JSON.stringify(appData('plain'), null, 2));
    await expect(readSyncFile(SYNC_URI)).resolves.toMatchObject({ tasks: [{ title: 'plain' }] });
  });

  it('produces byte-identical output whether material is absent or explicitly null', async () => {
    await writeSyncFile(SYNC_URI, appData('same'));
    const withoutOption = fs.files.get(SYNC_URI)!;
    fs.files.clear();
    await writeSyncFile(SYNC_URI, appData('same'), { material: null });
    expect(Buffer.from(fs.files.get(SYNC_URI)!)).toEqual(Buffer.from(withoutOption));
  });

  it('still returns null-and-repairs genuinely invalid JSON', async () => {
    fs.files.set(SYNC_URI, new TextEncoder().encode('not json at all'));
    await expect(readSyncFile(SYNC_URI)).resolves.toBeNull();
  });
});

describe('File Sync encryption — round trip', () => {
  it('writes data.json.enc, leaves data.json untouched, and reads back', async () => {
    await writeSyncFile(SYNC_URI, appData('secret'), { material });
    expect(fs.files.has(ENC_URI)).toBe(true);
    expect(fs.files.has(SYNC_URI)).toBe(false);
    expect(inspectSyncArtifact(fs.files.get(ENC_URI)!).kind).toBe('encrypted');
    expect(textOf(ENC_URI)).not.toContain('secret');
    await expect(readSyncFile(SYNC_URI, { material })).resolves.toMatchObject({
      tasks: [{ title: 'secret' }],
    });
  });

  it('rotates data.json.enc.bak only after the current artifact decrypts', async () => {
    await writeSyncFile(SYNC_URI, appData('first'), { material });
    await writeSyncFile(SYNC_URI, appData('second'), { material });
    const backup = fs.files.get(`${SYNC_DIR}/data.json.enc.bak`);
    expect(backup).toBeDefined();
    expect(inspectSyncArtifact(backup!).kind).toBe('encrypted');
    await expect(readSyncFile(SYNC_URI, { material })).resolves.toMatchObject({
      tasks: [{ title: 'second' }],
    });
  });
});

describe('File Sync encryption — fail closed (decision #4)', () => {
  it('throws a terminal error instead of null-and-repair for a wrong key', async () => {
    await seedEncrypted(appData('secret'));
    const wrong = await deriveSyncKeyMaterial(
      'wrong', new Uint8Array(16).fill(7), FAST_PARAMS, mobileSyncCryptoPrimitives,
    );
    await expect(readSyncFile(SYNC_URI, { material: wrong }))
      .rejects.toBeInstanceOf(SyncEncryptionTerminalError);
  });

  it('throws a terminal error for tampered ciphertext and leaves the bytes in place', async () => {
    const sealed = await seedEncrypted(appData('secret'));
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1] ^= 0xff;
    fs.files.set(ENC_URI, tampered);

    await expect(readSyncFile(SYNC_URI, { material }))
      .rejects.toBeInstanceOf(SyncEncryptionTerminalError);
    expect(Buffer.from(fs.files.get(ENC_URI)!)).toEqual(Buffer.from(tampered));
  });

  it('refuses to overwrite or rotate an artifact it cannot decrypt', async () => {
    const sealed = await seedEncrypted(appData('theirs'));
    const tampered = new Uint8Array(sealed);
    tampered[60] ^= 0xff;
    fs.files.set(ENC_URI, tampered);

    await expect(writeSyncFile(SYNC_URI, appData('mine'), { material }))
      .rejects.toBeInstanceOf(SyncEncryptionTerminalError);
    expect(Buffer.from(fs.files.get(ENC_URI)!)).toEqual(Buffer.from(tampered));
    expect(fs.files.has(`${SYNC_DIR}/data.json.enc.bak`)).toBe(false);
  });

  it('does not treat MWENC1 bytes stored under the plain name as invalid JSON', async () => {
    await seedEncrypted(appData('secret'), material, SYNC_URI);
    await expect(readSyncFile(SYNC_URI)).rejects.toBeInstanceOf(SyncEncryptionNoKeyError);
  });
});

describe('File Sync encryption — no-key discovery (decisions #2 and #5)', () => {
  it('discovers an encrypted folder, persists the state, and reports it', async () => {
    await seedEncrypted(appData('secret'));

    await expect(readSyncFile(SYNC_URI)).rejects.toBeInstanceOf(SyncEncryptionNoKeyError);

    // Persisted, so it survives a restart.
    expect(asyncStorage.get(SYNC_ENCRYPTION_STATE_KEY)).toBeDefined();
    __resetSyncEncryptionStateForTests();
    await expect(getMobileSyncEncryptionStatus()).resolves.toMatchObject({
      state: 'remote-encrypted-no-key',
      kdfParams: FAST_PARAMS,
    });
    // And there is still no key, so nothing downstream can encrypt/decrypt.
    await expect(getSyncEncryptionMaterial()).resolves.toBeNull();
  });

  it('never overwrites an already-enabled local state with the no-key state', async () => {
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: '00', discoveredParams: FAST_PARAMS });
    await seedEncrypted(appData('secret'));
    await expect(readSyncFile(SYNC_URI)).rejects.toBeInstanceOf(SyncEncryptionNoKeyError);
    expect(syncEncryptionLocalState.read()?.state).toBe('enabled');
  });

  it('does not probe for .enc when the plaintext read succeeds', async () => {
    await writeSyncFile(SYNC_URI, appData('plain'));
    const before = fs.files.size;
    await expect(readSyncFile(SYNC_URI)).resolves.toMatchObject({ tasks: [{ title: 'plain' }] });
    expect(fs.files.size).toBe(before);
    expect(asyncStorage.get(SYNC_ENCRYPTION_STATE_KEY)).toBeUndefined();
  });
});

describe('S3: enabled-but-key-missing fails closed, never falls back to "off"', () => {
  it('throws SyncEncryptionKeyMissingError instead of returning null when the key cache is empty', async () => {
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: '00'.repeat(16), discoveredParams: FAST_PARAMS });
    await expect(getSyncEncryptionMaterial()).rejects.toBeInstanceOf(SyncEncryptionKeyMissingError);
  });

  it('classifies as the encryption failure class, never a generic permission/auth toast', async () => {
    const { classifySyncFailure } = await import('./sync-service-utils');
    expect(classifySyncFailure(new SyncEncryptionKeyMissingError())).toBe('encryption');
  });

  it('a file-backend attachment fetch fails closed instead of copying the local file as plaintext', async () => {
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: '00'.repeat(16), discoveredParams: FAST_PARAMS });
    asyncStorage.set(SYNC_BACKEND_KEY, 'file');
    asyncStorage.set(SYNC_PATH_KEY, SYNC_URI);
    fs.files.set(`${SYNC_DIR}/attachments/missing.png`, new Uint8Array([1, 2, 3]));
    const { ensureAttachmentAvailable } = await import('./attachment-sync-availability');
    const result = await ensureAttachmentAvailable({
      id: 'a1', kind: 'file', title: 'missing.png', cloudKey: 'attachments/missing.png',
    } as never);
    expect(result?.localStatus).not.toBe('available');
  });
});

describe('non-truncating provider padding (decision #8)', () => {
  it('pads raw bytes with 0x20 before Base64, not after', () => {
    const padded = padBytesForNonTruncatingOverwrite(new Uint8Array([1, 2, 3]), 6);
    expect(Array.from(padded)).toEqual([1, 2, 3, 0x20, 0x20, 0x20]);
    expect(padBytesForNonTruncatingOverwrite(new Uint8Array([1, 2, 3]), 2)).toHaveLength(3);
  });

  it('S2: a shrinking PLAINTEXT write on a non-truncating (non-SAF) provider produces the exact new bytes, never a stale ciphertext tail', async () => {
    // Regression for the original bug: on a non-truncating provider, the disable
    // transition writes a shorter plaintext attachment over a longer ciphertext one.
    // The OLD code wrote the plaintext as-is with no shrink strategy, which left [new
    // plaintext][leftover OLD CIPHERTEXT bytes] on disk — silent, PERMANENT attachment
    // corruption that a later resume pass then misread as "already disabled" (no MWENC1
    // magic at offset 0) and skipped rewriting. Padding plaintext the way ciphertext is
    // padded would just move the corruption from "transient garbage tail" to "permanent
    // 0x20 tail nothing ever strips" — plaintext has no ciphertext_len field to make that
    // safe. Delete-then-recreate instead: this file path is not a SAF tree URI, so the
    // write can freely delete the old (longer) file and create a fresh, exactly-sized one.
    const uri = `${SYNC_DIR}/attachments/a1.png`;
    fs.files.set(uri, new Uint8Array(80).fill(1));
    fs.nonTruncating.enabled = true;
    await writeSyncArtifactBytes(uri, new Uint8Array([9, 8, 7, 6]));
    expect(Array.from(fs.files.get(uri)!)).toEqual([9, 8, 7, 6]);
  });

  it('survives a shrinking encrypted write on a SAF provider that never truncates', async () => {
    const safUri = 'content://provider/tree/sync/document/sync%2Fdata.json.enc';
    const big = await encryptSyncArtifact(
      new TextEncoder().encode(JSON.stringify(appData('x'.repeat(2000)))), material, mobileSyncCryptoPrimitives,
    );
    await writeSyncArtifactBytes(safUri, big);
    fs.nonTruncating.enabled = true;

    const small = await encryptSyncArtifact(
      new TextEncoder().encode(JSON.stringify(appData('tiny'))), material, mobileSyncCryptoPrimitives,
    );
    await writeSyncArtifactBytes(safUri, small);

    const readBack = await readSyncArtifactBytes(safUri);
    expect(readBack!.length).toBe(big.length); // the provider kept the old length
    const inspected = inspectSyncArtifact(readBack!);
    expect(inspected.kind).toBe('encrypted');
    // The trailing 0x20 padding is past 54 + ciphertext_len and is ignored on read.
    const { decryptSyncArtifact } = await import('@mindwtr/core');
    const plaintext = await decryptSyncArtifact(readBack!, material.key, mobileSyncCryptoPrimitives);
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toMatchObject({
      tasks: [{ title: 'tiny' }],
    });
  });
});

describe('local-only transitions with no configured backend (#1001)', () => {
  it('enable before the first sync persists key material without touching any folder', async () => {
    expect(await isSyncEncryptionBackendPending()).toBe(true);

    await enableSyncEncryption(PASSPHRASE);

    await expect(getMobileSyncEncryptionStatus()).resolves.toMatchObject({ state: 'enabled' });
    await expect(getSyncEncryptionMaterial()).resolves.not.toBeNull();
    expect(fs.files.size).toBe(0);
  }, 30_000);

  it('disable clears the local key and state; change/unlock refuse with the backend sentinel', async () => {
    await enableSyncEncryption(PASSPHRASE);

    await expect(changeSyncEncryptionPassphrase(PASSPHRASE, 'another phrase entirely'))
      .rejects.toThrow('SYNC_ENCRYPTION_BACKEND_REQUIRED');
    await expect(provideSyncEncryptionPassphrase(PASSPHRASE))
      .rejects.toThrow('SYNC_ENCRYPTION_BACKEND_REQUIRED');

    await disableSyncEncryption();
    await expect(getMobileSyncEncryptionStatus()).resolves.toEqual({ state: 'off' });
    await expect(syncEncryptionKeyCache.getKey()).resolves.toBeNull();
  }, 30_000);
});

describe('File Sync transitions through core orchestration', () => {
  beforeEach(() => {
    asyncStorage.set(SYNC_BACKEND_KEY, 'file');
    asyncStorage.set(SYNC_PATH_KEY, SYNC_URI);
  });

  const seedPlaintextFolder = () => {
    fs.files.set(SYNC_URI, new TextEncoder().encode(JSON.stringify(appData('before'), null, 2)));
    fs.files.set(`${SYNC_DIR}/data.json.bak`, new TextEncoder().encode(JSON.stringify(appData('backup'), null, 2)));
    fs.files.set(`${SYNC_DIR}/attachments/a1.png`, new Uint8Array([9, 8, 7, 6]));
  };

  it('enable encrypts documents and attachments, then removes only the plaintext documents', async () => {
    seedPlaintextFolder();
    await enableSyncEncryption(PASSPHRASE);

    expect(inspectSyncArtifact(fs.files.get(ENC_URI)!).kind).toBe('encrypted');
    expect(inspectSyncArtifact(fs.files.get(`${SYNC_DIR}/data.json.enc.bak`)!).kind).toBe('encrypted');
    // Attachments keep their exact name (cloudKey is identity-keyed) with sealed bytes.
    expect(inspectSyncArtifact(fs.files.get(`${SYNC_DIR}/attachments/a1.png`)!).kind).toBe('encrypted');
    expect(fs.files.has(SYNC_URI)).toBe(false);
    expect(fs.files.has(`${SYNC_DIR}/data.json.bak`)).toBe(false);

    await expect(getMobileSyncEncryptionStatus()).resolves.toMatchObject({
      state: 'enabled',
      kdfParams: SYNC_CRYPTO_DEFAULT_KDF_PARAMS,
    });
    const resolved = await getSyncEncryptionMaterial();
    expect(resolved).not.toBeNull();
    await expect(readSyncFile(SYNC_URI, { material: resolved })).resolves.toMatchObject({
      tasks: [{ title: 'before' }],
    });
  }, 30_000);

  it('resumes an interrupted enable without re-deriving a second salt', async () => {
    seedPlaintextFolder();
    // Simulate a crash right after the base document was sealed: both generations exist.
    await enableSyncEncryption(PASSPHRASE);
    const firstSalt = (await getMobileSyncEncryptionStatus());
    const encBefore = fs.files.get(ENC_URI)!;
    fs.files.set(SYNC_URI, new TextEncoder().encode(JSON.stringify(appData('before'), null, 2)));
    await syncEncryptionKeyCache.clearKey();
    __resetSyncEncryptionStateForTests();
    asyncStorage.delete(SYNC_ENCRYPTION_STATE_KEY);

    await enableSyncEncryption(PASSPHRASE);

    // Salt/params came from the existing header, so the already-sealed artifact still
    // opens under the resumed key, and the leftover plaintext is now gone.
    expect((await getMobileSyncEncryptionStatus()).kdfParams).toEqual(firstSalt.kdfParams);
    expect(fs.files.has(SYNC_URI)).toBe(false);
    const resumed = await getSyncEncryptionMaterial();
    const { decryptSyncArtifact } = await import('@mindwtr/core');
    await expect(decryptSyncArtifact(encBefore, resumed!.key, mobileSyncCryptoPrimitives)).resolves.toBeDefined();
  }, 30_000);

  it('disable restores plaintext artifacts and clears the cached key', async () => {
    seedPlaintextFolder();
    await enableSyncEncryption(PASSPHRASE);
    await disableSyncEncryption();

    expect(fs.files.has(ENC_URI)).toBe(false);
    expect(JSON.parse(textOf(SYNC_URI))).toMatchObject({ tasks: [{ title: 'before' }] });
    expect(inspectSyncArtifact(fs.files.get(`${SYNC_DIR}/attachments/a1.png`)!).kind).toBe('plaintext');
    expect(Array.from(fs.files.get(`${SYNC_DIR}/attachments/a1.png`)!)).toEqual([9, 8, 7, 6]);
    await expect(getMobileSyncEncryptionStatus()).resolves.toEqual({ state: 'off' });
    await expect(syncEncryptionKeyCache.getKey()).resolves.toBeNull();
  }, 30_000);

  it('S2: disable succeeds cleanly on a non-truncating provider instead of corrupting a shrinking attachment', async () => {
    seedPlaintextFolder();
    await enableSyncEncryption(PASSPHRASE);
    fs.nonTruncating.enabled = true; // the encrypted attachment is longer than its plaintext

    await disableSyncEncryption();

    // Delete-then-recreate produces the exact original bytes back — no padding, no
    // leftover ciphertext tail, and nothing for a resume pass to misclassify.
    expect(Array.from(fs.files.get(`${SYNC_DIR}/attachments/a1.png`)!)).toEqual([9, 8, 7, 6]);
    expect(inspectSyncArtifact(fs.files.get(ENC_URI) ?? new Uint8Array(0)).kind).not.toBe('encrypted');
    await expect(getMobileSyncEncryptionStatus()).resolves.toEqual({ state: 'off' });
  }, 30_000);

  it('a wrong passphrase never mutates the remote and never caches a key', async () => {
    seedPlaintextFolder();
    await enableSyncEncryption(PASSPHRASE);
    await syncEncryptionKeyCache.clearKey();
    syncEncryptionLocalState.write({ state: 'remote-encrypted-no-key' });
    const snapshot = new Map([...fs.files].map(([k, v]) => [k, Buffer.from(v).toString('base64')]));

    await expect(provideSyncEncryptionPassphrase('nope')).resolves.toBe('wrong-passphrase');

    expect(new Map([...fs.files].map(([k, v]) => [k, Buffer.from(v).toString('base64')]))).toEqual(snapshot);
    await expect(syncEncryptionKeyCache.getKey()).resolves.toBeNull();
    expect(syncEncryptionLocalState.read()?.state).toBe('remote-encrypted-no-key');

    await expect(provideSyncEncryptionPassphrase(PASSPHRASE)).resolves.toBe('ok');
    expect(syncEncryptionLocalState.read()?.state).toBe('enabled');
    await expect(getSyncEncryptionMaterial()).resolves.not.toBeNull();
  }, 30_000);

  it('B2: routes through the shared sync-document queue, so a racing cycle write can never coexist with a half-finished transition', async () => {
    seedPlaintextFolder();
    let cycleFinished = false;
    // Simulates a real sync cycle: it already resolved `encryptionMaterial = null`
    // (encryption looked off at that instant), does its normal network round-trip, then
    // reaches its write step. Enqueued on the SAME shared queue
    // `apps/mobile/lib/sync-service.ts`'s MobileSyncRun.run() uses.
    const fakeCycle = runSerializedSyncDocumentOperation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.files.set(SYNC_URI, new TextEncoder().encode(JSON.stringify(appData('cycle-write'), null, 2)));
      cycleFinished = true;
    });

    // Enqueued while the fake cycle is still mid-flight (its timer hasn't fired yet).
    // Without routing enableSyncEncryption through the same queue, this could run
    // concurrently, finish (encrypt + delete the plaintext) before the cycle's write
    // lands, and then the cycle's write would land AFTER — a fresh plaintext data.json
    // sitting right next to data.json.enc.
    const enablePromise = enableSyncEncryption(PASSPHRASE);

    await Promise.all([fakeCycle, enablePromise]);

    // FIFO queue: the cycle's write is guaranteed to have completed before enable's work
    // started, so enable saw and encrypted it — it can never be left as stray plaintext.
    expect(cycleFinished).toBe(true);
    expect(fs.files.has(SYNC_URI)).toBe(false);
    expect(inspectSyncArtifact(fs.files.get(ENC_URI)!).kind).toBe('encrypted');
    const resolved = await getSyncEncryptionMaterial();
    await expect(readSyncFile(SYNC_URI, { material: resolved })).resolves.toMatchObject({
      tasks: [{ title: 'cycle-write' }],
    });
  }, 30_000);
});

describe('local-state persistence and the remote-plaintext state', () => {
  /** A store whose write actually takes a tick — the real AsyncStorage shape, and the one a
   *  fire-and-forget `void persist` silently outruns. */
  const deferNextStoreWrite = () => {
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key: string, value: string) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      asyncStorage.set(key, value);
    });
  };

  it('B4: an awaited transition does not return before its persisted state has landed', async () => {
    asyncStorage.set(SYNC_BACKEND_KEY, 'file');
    asyncStorage.set(SYNC_PATH_KEY, SYNC_URI);
    fs.files.set(SYNC_URI, new TextEncoder().encode(JSON.stringify(appData('before'), null, 2)));
    deferNextStoreWrite();

    await enableSyncEncryption(PASSPHRASE);

    expect(JSON.parse(asyncStorage.get(SYNC_ENCRYPTION_STATE_KEY)!)).toMatchObject({ state: 'enabled' });
  }, 30_000);

  it('B4: flush awaits a write queued directly through the port', async () => {
    deferNextStoreWrite();
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: 'aabb', discoveredParams: FAST_PARAMS });
    expect(asyncStorage.get(SYNC_ENCRYPTION_STATE_KEY)).toBeUndefined();

    await flushSyncEncryptionLocalState();

    expect(JSON.parse(asyncStorage.get(SYNC_ENCRYPTION_STATE_KEY)!)).toMatchObject({ state: 'enabled' });
  });

  it('File Sync: a keyed device treats a peer-disabled folder as terminal, not as an empty folder', async () => {
    // The inverse of `discoverEncryptedSyncFolder`: a peer ran the disable transition, so the
    // `.enc` artifact is gone and the plaintext original is back.
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: 'aabb', discoveredParams: FAST_PARAMS });
    fs.files.set(SYNC_URI, new TextEncoder().encode(JSON.stringify(appData('peer'), null, 2)));

    await expect(readSyncFile(SYNC_URI, { material })).rejects.toBeInstanceOf(SyncEncryptionRemotePlaintextError);

    await flushSyncEncryptionLocalState();
    expect(syncEncryptionLocalState.read()?.state).toBe('remote-plaintext');
    // Nothing on the folder is touched on this path.
    expect(JSON.parse(new TextDecoder().decode(fs.files.get(SYNC_URI)!))).toMatchObject({ tasks: [{ title: 'peer' }] });
  });

  it('File Sync: a genuinely empty folder still reads as empty', async () => {
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: 'aabb', discoveredParams: FAST_PARAMS });
    await expect(readSyncFile(SYNC_URI, { material })).resolves.toBeNull();
  });

  it('remote-plaintext blocks auto-sync but keeps the key resolvable so disable can still run', async () => {
    await syncEncryptionKeyCache.setKey(material.key);
    syncEncryptionLocalState.write({
      state: 'remote-plaintext',
      discoveredSalt: Array.from(material.salt, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      discoveredParams: FAST_PARAMS,
    });
    await flushSyncEncryptionLocalState();
    __resetSyncEncryptionStateForTests(); // prove it survives a reload, not just the cache

    await expect(isSyncEncryptionBlocked()).resolves.toBe(true);
    await expect(getSyncEncryptionMaterial()).resolves.toMatchObject({ key: material.key });
    await expect(getMobileSyncEncryptionStatus()).resolves.toEqual({
      state: 'remote-plaintext',
      kdfParams: FAST_PARAMS,
    });
  });
});
