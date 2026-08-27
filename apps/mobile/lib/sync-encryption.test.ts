import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import type { AppData, SyncEncryptionRemotePort, SyncRemoteMutationFenceLease } from '@mindwtr/core';

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
const childUrisOf = (dir: string): string[] => {
  const normalized = dir.replace(/\/+$/, '');
  const prefix = `${normalized}/`;
  const children = new Set<string>();
  for (const uri of fs.files.keys()) {
    if (!uri.startsWith(prefix)) continue;
    const child = uri.slice(prefix.length).split('/')[0];
    if (child) children.add(`${prefix}${child}`);
  }
  return [...children];
};

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
    readDirectoryAsync: vi.fn(async (dir: string) => childUrisOf(dir)),
    createFileAsync: vi.fn(async (dir: string, name: string) => {
      const requested = `${dir.replace(/\/+$/, '')}/${name}`;
      const uri = fs.files.has(requested) ? `${requested}.provider-copy` : requested;
      fs.files.set(uri, new Uint8Array(0));
      return uri;
    }),
    deleteAsync: vi.fn(async (uri: string) => { fs.files.delete(uri); }),
    requestDirectoryPermissionsAsync: vi.fn(),
    makeDirectoryAsync: vi.fn(),
  };
  return {
    StorageAccessFramework,
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    getInfoAsync: vi.fn(async (uri: string) => ({
      exists: fs.files.has(uri) || childUrisOf(uri).length > 0,
      size: fs.files.get(uri)?.length ?? 0,
    })),
    readAsStringAsync: vi.fn(async (uri: string, options?: { encoding?: string }) => read(uri, options)),
    writeAsStringAsync: vi.fn(async (uri: string, content: string, options?: { encoding?: string }) => {
      fs.write(uri, fs.toBytes(content, options?.encoding));
    }),
    readDirectoryAsync: vi.fn(async (dir: string) => childUrisOf(dir).map(leafOf)),
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
    create(options?: { overwrite?: boolean }) {
      if (fs.files.has(this.uri) && !options?.overwrite) throw new Error(`EEXIST ${this.uri}`);
      fs.files.set(this.uri, new Uint8Array(0));
    }
    write(content: string | Uint8Array) {
      fs.write(this.uri, typeof content === 'string' ? fs.toBytes(content) : content);
    }
    async bytes() { return fs.files.get(this.uri) ?? new Uint8Array(0); }
    async text() { return Buffer.from(fs.files.get(this.uri) ?? new Uint8Array(0)).toString('utf8'); }
    delete() { fs.files.delete(this.uri); }
    copy(target: { uri: string }) { fs.files.set(target.uri, fs.files.get(this.uri) ?? new Uint8Array(0)); }
    rename(name: string) {
      const target = `${dirOf(this.uri)}/${name}`;
      if (fs.files.has(target)) throw new Error(`EEXIST ${target}`);
      const bytes = fs.files.get(this.uri);
      if (!bytes) throw new Error(`ENOENT ${this.uri}`);
      fs.files.set(target, bytes);
      fs.files.delete(this.uri);
      this.uri = target;
    }
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
vi.mock('./sync-file-transition-cas', () => ({
  renameSafTransitionDocument: vi.fn(async (uri: string, name: string) => {
    const target = `${dirOf(uri)}/${name}`;
    if (fs.files.has(target)) throw new Error(`EEXIST ${target}`);
    const bytes = fs.files.get(uri);
    if (!bytes) throw new Error(`ENOENT ${uri}`);
    fs.files.set(target, bytes);
    fs.files.delete(uri);
    return { uri: target, name };
  }),
}));
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
  SyncEncryptionRemoteConflictError,
  SyncEncryptionTerminalError,
  SyncRemoteMutationFenceBusyError,
  SyncRemoteMutationFenceLostError,
  encryptSyncArtifact,
  type SyncKeyMaterial,
} from '@mindwtr/core';
import {
  FILE_SYNC_ABSENT_FINGERPRINT,
  readSyncFile,
  readSyncFileVersioned,
  writeSyncFile,
} from './storage-file';
import {
  createFileSyncEncryptionRemotePort,
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
  SyncEncryptionStateUnavailableError,
  SyncEncryptionKeyMissingError,
  SyncEncryptionNoKeyError,
  syncEncryptionKeyCache,
  syncEncryptionLocalState,
} from './sync-encryption-state';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { runSerializedSyncDocumentOperation } from '@mindwtr/core';
import {
  __syncEncryptionServiceTestUtils,
  changeSyncEncryptionPassphrase,
  disableSyncEncryption,
  enableSyncEncryption,
  isSyncEncryptionBackendPending,
  provideSyncEncryptionPassphrase,
  SyncEncryptionCleanupDeferredError,
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
const SAF_SYNC_URI = 'content://provider/tree/root/document/root%2Fdata.json';
const SAF_ENC_URI = 'content://provider/tree/root/document/root%2Fdata.json.enc';
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
  const fileSystem = await import('./file-system');
  const readStored = async (uri: string, options?: { encoding?: string }): Promise<string> => {
    const bytes = fs.files.get(uri);
    if (!bytes) throw new Error(`ENOENT ${uri}`);
    return Buffer.from(bytes).toString(options?.encoding === 'base64' ? 'base64' : 'utf8');
  };
  vi.mocked(fileSystem.StorageAccessFramework!.readAsStringAsync!).mockImplementation(readStored);
  vi.mocked(fileSystem.StorageAccessFramework!.readDirectoryAsync!)
    .mockImplementation(async (dir: string) => childUrisOf(dir));
  vi.mocked(fileSystem.readAsStringAsync).mockImplementation(readStored);
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

  it('never overwrites an enabled local state whose salt matches the discovery', async () => {
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: '07'.repeat(16), discoveredParams: FAST_PARAMS });
    await seedEncrypted(appData('secret'));
    await expect(readSyncFile(SYNC_URI)).rejects.toBeInstanceOf(SyncEncryptionNoKeyError);
    expect(syncEncryptionLocalState.read()?.state).toBe('enabled');
  });

  it('downgrades an enabled state to no-key when the folder is sealed under a foreign salt', async () => {
    // A passphrase set before the first sync while a peer encrypted the folder (or a peer's
    // rotation): this device's key is provably for another generation, and only the no-key
    // state surfaces the unlock prompt that re-derives from the folder's own salt.
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: '00'.repeat(16), discoveredParams: FAST_PARAMS });
    await seedEncrypted(appData('secret'));
    await expect(readSyncFile(SYNC_URI)).rejects.toBeInstanceOf(SyncEncryptionNoKeyError);
    expect(syncEncryptionLocalState.read()?.state).toBe('remote-encrypted-no-key');
    expect(syncEncryptionLocalState.read()?.discoveredSalt).toBe('07'.repeat(16));
  });

  it('a keyed read of a foreign-salt folder downgrades to no-key instead of a dead-end auth failure', async () => {
    // The keyed shape of the case above: material resolves (state enabled + cached key), the
    // .enc artifact exists, but its header salt is not ours. Decrypting could only fail as
    // Auth, indistinguishable from a wrong passphrase — the read must persist the downgrade.
    await seedEncrypted(appData('secret'));
    const foreign = await deriveSyncKeyMaterial(
      PASSPHRASE, new Uint8Array(16).fill(9), FAST_PARAMS, mobileSyncCryptoPrimitives,
    );
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: '09'.repeat(16), discoveredParams: FAST_PARAMS });
    await expect(readSyncFile(SYNC_URI, { material: foreign })).rejects.toBeInstanceOf(SyncEncryptionNoKeyError);
    expect(syncEncryptionLocalState.read()?.state).toBe('remote-encrypted-no-key');
    expect(syncEncryptionLocalState.read()?.discoveredSalt).toBe('07'.repeat(16));
  });

  it('does not probe for .enc when the plaintext read succeeds', async () => {
    await writeSyncFile(SYNC_URI, appData('plain'));
    const before = fs.files.size;
    await expect(readSyncFile(SYNC_URI)).resolves.toMatchObject({ tasks: [{ title: 'plain' }] });
    expect(fs.files.size).toBe(before);
    expect(asyncStorage.get(SYNC_ENCRYPTION_STATE_KEY)).toBeUndefined();
  });

  it('fails closed without writes or local-state mutation when a listed encrypted sibling is unreadable', async () => {
    fs.files.set(SAF_SYNC_URI, new Uint8Array(0));
    const sealed = await seedEncrypted(appData('peer'), material, SAF_ENC_URI);
    const { StorageAccessFramework, readAsStringAsync, writeAsStringAsync } = await import('./file-system');
    const readStored = async (uri: string, options?: { encoding?: string }): Promise<string> => {
      if (uri === SAF_ENC_URI) throw new Error('provider encrypted sibling read denied');
      const bytes = fs.files.get(uri);
      if (!bytes) throw new Error(`ENOENT ${uri}`);
      return Buffer.from(bytes).toString(options?.encoding === 'base64' ? 'base64' : 'utf8');
    };
    vi.mocked(StorageAccessFramework!.readDirectoryAsync!).mockResolvedValue([SAF_SYNC_URI, SAF_ENC_URI]);
    vi.mocked(StorageAccessFramework!.readAsStringAsync!).mockImplementation(readStored);
    vi.mocked(readAsStringAsync).mockImplementation(readStored);

    await expect(readSyncFile(SAF_SYNC_URI)).rejects.toThrow('provider encrypted sibling read denied');

    expect(fs.files.get(SAF_SYNC_URI)).toEqual(new Uint8Array(0));
    expect(fs.files.get(SAF_ENC_URI)).toEqual(sealed);
    expect(StorageAccessFramework!.writeAsStringAsync).not.toHaveBeenCalled();
    expect(writeAsStringAsync).not.toHaveBeenCalled();
    expect(syncEncryptionLocalState.read()).toBeNull();
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

describe('ordinary File Sync document CAS', () => {
  it('preserves a newer path generation on replacement and first creation', async () => {
    fs.files.set(SYNC_URI, new TextEncoder().encode(JSON.stringify(appData('baseline'))));
    const baseline = await readSyncFileVersioned(SYNC_URI);
    const peer = new TextEncoder().encode(JSON.stringify(appData('peer')));
    fs.files.set(SYNC_URI, peer);

    await expect(writeSyncFile(SYNC_URI, appData('mine'), {
      expectedFingerprint: baseline.fingerprint,
    })).rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(SYNC_URI)).toEqual(peer);

    fs.files.clear();
    const absent = await readSyncFileVersioned(SYNC_URI);
    expect(absent.fingerprint).toBe(FILE_SYNC_ABSENT_FINGERPRINT);
    fs.files.set(SYNC_URI, peer);
    await expect(writeSyncFile(SYNC_URI, appData('mine'), {
      expectedFingerprint: absent.fingerprint,
    })).rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(SYNC_URI)).toEqual(peer);
  });

  it('preserves a newer encrypted path generation', async () => {
    await seedEncrypted(appData('baseline'));
    const baseline = await readSyncFileVersioned(SYNC_URI, { material });
    const peer = await seedEncrypted(appData('peer'));

    await expect(writeSyncFile(SYNC_URI, appData('mine'), {
      material,
      expectedFingerprint: baseline.fingerprint,
    })).rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(ENC_URI)).toEqual(peer);
    await expect(readSyncFile(SYNC_URI, { material })).resolves.toMatchObject({
      tasks: [{ title: 'peer' }],
    });
  });

  it('preserves a newer SAF generation', async () => {
    const configuredUri = 'content://provider/tree/root/document/root%2Fdata.json';
    const canonicalUri = 'content://provider/tree/root/document/root/data.json';
    fs.files.set(canonicalUri, new TextEncoder().encode(JSON.stringify(appData('baseline'))));
    const baseline = await readSyncFileVersioned(configuredUri);
    const peer = new TextEncoder().encode(JSON.stringify(appData('peer')));
    fs.files.set(canonicalUri, peer);

    await expect(writeSyncFile(configuredUri, appData('mine'), {
      expectedFingerprint: baseline.fingerprint,
    })).rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(canonicalUri)).toEqual(peer);
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

describe('remote mutation fence lifecycle', () => {
  it('holds the lease through the flushed local commit and releases it last', async () => {
    const events: string[] = [];
    const lease: SyncRemoteMutationFenceLease = {
      assertHeld: vi.fn(async () => { events.push('assert'); }),
      renew: vi.fn(async () => undefined),
      retryAfterMs: () => 0,
      release: vi.fn(async () => {
        events.push(`release:${asyncStorage.has(SYNC_ENCRYPTION_STATE_KEY) ? 'persisted' : 'missing'}`);
      }),
    };
    const remote: SyncEncryptionRemotePort & {
      acquireRemoteMutationFence: () => Promise<SyncRemoteMutationFenceLease>;
    } = {
      acquireRemoteMutationFence: async () => {
        events.push('acquire');
        return lease;
      },
      captureInventory: async () => {
        events.push('capture');
        return { entries: [], snapshot: new Map() };
      },
      list: async () => {
        events.push('list');
        return [];
      },
      read: async () => ({ bytes: null, version: null }),
      write: async () => undefined,
      remove: async () => undefined,
    };

    await __syncEncryptionServiceTestUtils.runWithRemoteMutationFence(
      remote,
      async (guardedRemote, _keyCache, localState) => {
        await guardedRemote.captureInventory!();
        await guardedRemote.list();
        await localState.write({ state: 'off', incompleteTransition: 'enable' });
      },
    );

    expect(events[0]).toBe('acquire');
    expect(events.indexOf('capture')).toBeGreaterThan(events.indexOf('assert'));
    expect(events.at(-1)).toBe('release:persisted');
    expect(vi.mocked(lease.assertHeld).mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('does not provision a provider key while a peer holds the fence', async () => {
    const encrypted = await encryptSyncArtifact(
      new TextEncoder().encode(JSON.stringify(appData('remote'))),
      material,
      mobileSyncCryptoPrimitives,
    );
    await syncEncryptionLocalState.write({ state: 'remote-encrypted-no-key' });
    await flushSyncEncryptionLocalState();
    const remote: SyncEncryptionRemotePort & {
      acquireRemoteMutationFence: () => Promise<SyncRemoteMutationFenceLease>;
    } = {
      acquireRemoteMutationFence: async () => { throw new SyncRemoteMutationFenceBusyError(30_000); },
      list: async () => [],
      read: async (name) => ({ bytes: name === 'data.json.enc' ? encrypted : null, version: 'v1' }),
      write: async () => undefined,
      remove: async () => undefined,
    };

    await expect(__syncEncryptionServiceTestUtils.runProvidePassphraseOverRemote(PASSPHRASE, remote))
      .rejects.toBeInstanceOf(SyncRemoteMutationFenceBusyError);
    await expect(syncEncryptionKeyCache.getKey()).resolves.toBeNull();
    expect(syncEncryptionLocalState.read()).toEqual({ state: 'remote-encrypted-no-key' });
  });

  it('rolls back provisioned provider material when the fence is lost before finalization', async () => {
    const encrypted = await encryptSyncArtifact(
      new TextEncoder().encode(JSON.stringify(appData('remote'))),
      material,
      mobileSyncCryptoPrimitives,
    );
    await syncEncryptionLocalState.write({ state: 'remote-encrypted-no-key' });
    await flushSyncEncryptionLocalState();
    let assertions = 0;
    const remote: SyncEncryptionRemotePort & {
      acquireRemoteMutationFence: () => Promise<SyncRemoteMutationFenceLease>;
    } = {
      acquireRemoteMutationFence: async () => ({
        assertHeld: async () => {
          assertions += 1;
          if (assertions === 4) throw new SyncRemoteMutationFenceLostError();
        },
        renew: async () => undefined,
        retryAfterMs: () => 0,
        release: async () => undefined,
      }),
      list: async () => [],
      read: async (name) => ({ bytes: name === 'data.json.enc' ? encrypted : null, version: 'v1' }),
      write: async () => undefined,
      remove: async () => undefined,
    };

    await expect(__syncEncryptionServiceTestUtils.runProvidePassphraseOverRemote(PASSPHRASE, remote))
      .rejects.toBeInstanceOf(SyncRemoteMutationFenceLostError);
    await expect(syncEncryptionKeyCache.getKey()).resolves.toBeNull();
    expect(syncEncryptionLocalState.read()).toEqual({ state: 'remote-encrypted-no-key' });
    expect(JSON.parse(asyncStorage.get(SYNC_ENCRYPTION_STATE_KEY)!)).toEqual({ state: 'remote-encrypted-no-key' });
  });

  it('preserves the primary transition error when conditional fence cleanup also fails', async () => {
    const primaryError = new Error('primary transition failure');
    const cleanupError = new Error('fence cleanup failure');
    const remote: SyncEncryptionRemotePort & {
      acquireRemoteMutationFence: () => Promise<SyncRemoteMutationFenceLease>;
    } = {
      acquireRemoteMutationFence: async () => ({
        assertHeld: async () => undefined,
        renew: async () => undefined,
        retryAfterMs: () => 12_000,
        release: async () => { throw cleanupError; },
      }),
      list: async () => [],
      read: async () => ({ bytes: null, version: null }),
      write: async () => undefined,
      remove: async () => undefined,
    };

    await expect(__syncEncryptionServiceTestUtils.runWithRemoteMutationFence(
      remote,
      async () => { throw primaryError; },
    )).rejects.toBe(primaryError);
    expect((primaryError as Error & { cleanupError?: unknown }).cleanupError).toBe(cleanupError);
  });

  it('reports a committed transition with cleanup deferred after a release failure', async () => {
    const cleanupError = new Error('fence cleanup failure');
    const events: string[] = [];
    const remote: SyncEncryptionRemotePort & {
      acquireRemoteMutationFence: () => Promise<SyncRemoteMutationFenceLease>;
    } = {
      acquireRemoteMutationFence: async () => ({
        assertHeld: async () => { events.push('assert'); },
        renew: async () => undefined,
        retryAfterMs: () => 12_000,
        release: async () => { events.push('release'); throw cleanupError; },
      }),
      list: async () => [],
      read: async () => ({ bytes: null, version: null }),
      write: async () => undefined,
      remove: async () => undefined,
    };

    const error = await __syncEncryptionServiceTestUtils.runWithRemoteMutationFence(
      remote,
      async () => { events.push('committed'); return 'done'; },
    ).then(() => null, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(SyncEncryptionCleanupDeferredError);
    expect(error).toMatchObject({ outcome: 'done', cleanupCause: cleanupError, retryAfterMs: 12_000 });
    expect(events).toEqual(['committed', 'assert', 'assert', 'release']);
  });
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

  it('fails closed when the SAF provider cannot enumerate the transition folder', async () => {
    const configuredUri = 'content://provider/tree/root/document/root%2Fdata.json';
    const { StorageAccessFramework } = await import('./file-system');
    vi.mocked(StorageAccessFramework!.readDirectoryAsync!)
      .mockRejectedValueOnce(new Error('provider listing denied'));

    await expect(createFileSyncEncryptionRemotePort(configuredUri))
      .rejects.toThrow('provider listing denied');
    expect([...fs.files.keys()].some((uri) => uri.includes('.mindwtr-et-'))).toBe(false);
  });

  it('captures confirmed-missing fixed document counterparts', async () => {
    seedPlaintextFolder();
    const port = await createFileSyncEncryptionRemotePort(SYNC_URI);
    const inventory = await port!.captureInventory!();

    expect(inventory.entries.filter((entry) => entry.kind === 'document').map((entry) => entry.name))
      .toEqual([
        'data.json',
        'data.json.bak',
        'data.json.bak.previous',
        'data.json.enc',
        'data.json.enc.bak',
        'data.json.enc.bak.previous',
        'data.json.enc.previous',
        'data.json.previous',
        'mindwtr-sync.json',
        'mindwtr-sync.json.enc',
      ]);
    expect(inventory.snapshot.get('data.json.enc')).toEqual({ bytes: null, version: null });
    expect(inventory.snapshot.get('mindwtr-sync.json')).toEqual({ bytes: null, version: null });
  });

  it('rejects a peer-created fixed counterpart after the missing generation was captured', async () => {
    seedPlaintextFolder();
    const peer = new Uint8Array([7, 1, 7, 1]);
    const port = await createFileSyncEncryptionRemotePort(SYNC_URI, {
      onInventoryPoint: (point) => {
        if (point === 'after-document-snapshot') fs.files.set(ENC_URI, peer);
      },
    });

    await expect(port!.captureInventory!())
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(ENC_URI)).toEqual(peer);
    expect([...fs.files.keys()].some((uri) => uri.includes('.mindwtr-et-'))).toBe(false);
  });

  it('binds attachment enumeration to one document generation and includes the peer generation on retry', async () => {
    seedPlaintextFolder();
    const peerAttachment = new Uint8Array([1, 3, 3, 7]);
    const peerData = {
      ...appData('peer'),
      tasks: [{
        id: 'peer-task',
        title: 'peer',
        attachments: [{ cloudKey: 'attachments/a2.png' }],
      } as never],
    };
    let injected = false;
    const port = await createFileSyncEncryptionRemotePort(SYNC_URI, {
      onInventoryPoint: (point) => {
        if (injected || point !== 'after-document-snapshot') return;
        injected = true;
        fs.files.set(SYNC_URI, new TextEncoder().encode(JSON.stringify(peerData, null, 2)));
        fs.files.set(`${SYNC_DIR}/attachments/a2.png`, peerAttachment);
      },
    });

    await expect(port!.captureInventory!())
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.has(SYNC_URI)).toBe(true);
    expect(fs.files.get(`${SYNC_DIR}/attachments/a2.png`)).toEqual(peerAttachment);
    expect([...fs.files.keys()].some((uri) => uri.includes('.mindwtr-et-'))).toBe(false);

    await enableSyncEncryption(PASSPHRASE);

    const resolved = await getSyncEncryptionMaterial();
    const { decryptSyncArtifact } = await import('@mindwtr/core');
    const migrated = fs.files.get(`${SYNC_DIR}/attachments/a2.png`)!;
    await expect(decryptSyncArtifact(migrated, resolved!.key, mobileSyncCryptoPrimitives))
      .resolves.toEqual(peerAttachment);
    expect(fs.files.has(SYNC_URI)).toBe(false);
    expect(inspectSyncArtifact(fs.files.get(ENC_URI)!).kind).toBe('encrypted');
  }, 30_000);

  it('enable encrypts documents and attachments, then removes only the plaintext documents', async () => {
    seedPlaintextFolder();
    await enableSyncEncryption(PASSPHRASE);

    expect(inspectSyncArtifact(fs.files.get(ENC_URI)!).kind).toBe('encrypted');
    expect(inspectSyncArtifact(fs.files.get(`${SYNC_DIR}/data.json.enc.bak`)!).kind).toBe('encrypted');
    // Attachments keep their exact name (cloudKey is identity-keyed) with sealed bytes.
    expect(inspectSyncArtifact(fs.files.get(`${SYNC_DIR}/attachments/a1.png`)!).kind).toBe('encrypted');
    expect(fs.files.has(SYNC_URI)).toBe(false);
    expect(fs.files.has(`${SYNC_DIR}/data.json.bak`)).toBe(false);
    expect([...fs.files.keys()].filter((uri) => uri.includes('.mindwtr-et-'))).toEqual([]);

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

  it('round-trips native seed backups through enable, passphrase change, and disable', async () => {
    seedPlaintextFolder();
    const seedNames = [
      'mindwtr-backup-2026-08-27.json',
      'data-backup-2026-08-26.json',
    ];
    const seedBytes = new Map(seedNames.map((name, index) => [
      name,
      new TextEncoder().encode(JSON.stringify(appData(`seed-${index}`), null, 2)),
    ]));
    for (const [name, bytes] of seedBytes) fs.files.set(`${SYNC_DIR}/${name}`, bytes);

    await enableSyncEncryption(PASSPHRASE);
    for (const name of seedNames) {
      expect(fs.files.has(`${SYNC_DIR}/${name}`)).toBe(false);
      expect(inspectSyncArtifact(fs.files.get(`${SYNC_DIR}/${name}.enc`)!).kind).toBe('encrypted');
    }

    const nextPassphrase = 'another correct horse battery';
    await changeSyncEncryptionPassphrase(PASSPHRASE, nextPassphrase);
    const rotated = await getSyncEncryptionMaterial();
    const { decryptSyncArtifact } = await import('@mindwtr/core');
    for (const name of seedNames) {
      await expect(decryptSyncArtifact(
        fs.files.get(`${SYNC_DIR}/${name}.enc`)!,
        rotated!.key,
        mobileSyncCryptoPrimitives,
      )).resolves.toEqual(seedBytes.get(name));
    }

    await disableSyncEncryption();
    for (const name of seedNames) {
      expect(fs.files.get(`${SYNC_DIR}/${name}`)).toEqual(seedBytes.get(name));
      expect(fs.files.has(`${SYNC_DIR}/${name}.enc`)).toBe(false);
    }
  }, 30_000);

  it('uses byte fingerprints for replacement and create-new semantics for missing artifacts', async () => {
    seedPlaintextFolder();
    const port = await createFileSyncEncryptionRemotePort(SYNC_URI);
    expect(port).not.toBeNull();

    const attachmentName = 'attachments/a1.png';
    const attachment = await port!.read(attachmentName);
    const peerAttachment = new Uint8Array([1, 1, 1]);
    fs.files.set(`${SYNC_DIR}/${attachmentName}`, peerAttachment);
    await expect(port!.write(attachmentName, new Uint8Array([2, 2]), attachment.version))
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(`${SYNC_DIR}/${attachmentName}`)).toEqual(peerAttachment);

    const missing = await port!.read('data.json.enc');
    expect(missing).toEqual({ bytes: null, version: null });
    const peerCreated = new Uint8Array([7, 7]);
    fs.files.set(ENC_URI, peerCreated);
    await expect(port!.write('data.json.enc', new Uint8Array([8, 8]), missing.version))
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(ENC_URI)).toEqual(peerCreated);
  });

  it('atomically quarantines the displaced path generation before replace and remove', async () => {
    seedPlaintextFolder();
    const attachmentName = 'attachments/a1.png';
    const attachmentUri = `${SYNC_DIR}/${attachmentName}`;
    const peerReplace = new Uint8Array([4, 4, 4]);
    let replaceInjected = false;
    const replacePort = await createFileSyncEncryptionRemotePort(SYNC_URI, {
      onMutationPoint: (point, name) => {
        if (!replaceInjected && point === 'before-quarantine' && name === attachmentName) {
          replaceInjected = true;
          fs.files.set(attachmentUri, peerReplace);
        }
      },
    });
    const replaceBaseline = await replacePort!.read(attachmentName);

    await expect(replacePort!.write(attachmentName, new Uint8Array([2, 2]), replaceBaseline.version))
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(attachmentUri)).toEqual(peerReplace);
    expect([...fs.files.entries()].find(([uri]) => uri.includes('.mindwtr-et-q-'))?.[1]).toEqual(peerReplace);
    expect([...fs.files.keys()].some((uri) => uri.includes('.mindwtr-et-s-'))).toBe(true);

    fs.files.clear();
    seedPlaintextFolder();
    const peerRemove = new Uint8Array([5, 5, 5]);
    let removeInjected = false;
    const removePort = await createFileSyncEncryptionRemotePort(SYNC_URI, {
      onMutationPoint: (point, name) => {
        if (!removeInjected && point === 'before-quarantine' && name === attachmentName) {
          removeInjected = true;
          fs.files.set(attachmentUri, peerRemove);
        }
      },
    });
    const removeBaseline = await removePort!.read(attachmentName);

    await expect(removePort!.remove(attachmentName, removeBaseline.version!))
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(attachmentUri)).toEqual(peerRemove);
    expect([...fs.files.entries()].find(([uri]) => uri.includes('.mindwtr-et-q-'))?.[1]).toEqual(peerRemove);

    fs.files.clear();
    seedPlaintextFolder();
    const peerRecreated = new Uint8Array([6, 6, 6]);
    let recreateInjected = false;
    const recreatePort = await createFileSyncEncryptionRemotePort(SYNC_URI, {
      onMutationPoint: (point, name) => {
        if (!recreateInjected && point === 'before-remove-commit' && name === attachmentName) {
          recreateInjected = true;
          fs.files.set(attachmentUri, peerRecreated);
        }
      },
    });
    const recreateBaseline = await recreatePort!.read(attachmentName);

    await expect(recreatePort!.remove(attachmentName, recreateBaseline.version!))
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(attachmentUri)).toEqual(peerRecreated);
    expect([...fs.files.keys()].some((uri) => uri.includes('.mindwtr-et-q-'))).toBe(true);

    fs.files.clear();
    seedPlaintextFolder();
    const changedQuarantine = new Uint8Array([8, 8, 8]);
    const changedPort = await createFileSyncEncryptionRemotePort(SYNC_URI, {
      onMutationPoint: (point, name) => {
        if (point === 'before-install' && name === attachmentName) {
          const quarantineUri = [...fs.files.keys()].find((uri) => uri.includes('.mindwtr-et-q-'));
          if (quarantineUri) fs.files.set(quarantineUri, changedQuarantine);
        }
      },
    });
    const changedBaseline = await changedPort!.read(attachmentName);

    await expect(changedPort!.write(attachmentName, new Uint8Array([9, 9]), changedBaseline.version))
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(attachmentUri)).toEqual(new Uint8Array([9, 9]));
    expect([...fs.files.entries()].find(([uri]) => uri.includes('.mindwtr-et-q-'))?.[1])
      .toEqual(changedQuarantine);

    fs.files.clear();
    seedPlaintextFolder();
    const changedRemoveQuarantine = new Uint8Array([10, 10, 10]);
    const changedRemovePort = await createFileSyncEncryptionRemotePort(SYNC_URI, {
      onMutationPoint: (point, name) => {
        if (point === 'before-remove-commit' && name === attachmentName) {
          const quarantineUri = [...fs.files.keys()].find((uri) => uri.includes('.mindwtr-et-q-'));
          if (quarantineUri) fs.files.set(quarantineUri, changedRemoveQuarantine);
        }
      },
    });
    const changedRemoveBaseline = await changedRemovePort!.read(attachmentName);

    await expect(changedRemovePort!.remove(attachmentName, changedRemoveBaseline.version!))
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.has(attachmentUri)).toBe(false);
    expect([...fs.files.entries()].find(([uri]) => uri.includes('.mindwtr-et-q-'))?.[1])
      .toEqual(changedRemoveQuarantine);
  });

  it('uses bounded exclusive create-new install and preserves a peer collision', async () => {
    const peer = new Uint8Array([7, 7, 7]);
    let injected = false;
    let stagedLeaf = '';
    const port = await createFileSyncEncryptionRemotePort(SYNC_URI, {
      onMutationPoint: (point, name) => {
        if (!injected && point === 'before-install' && name === 'data.json.enc') {
          injected = true;
          stagedLeaf = [...fs.files.keys()].map(leafOf).find((leaf) => leaf.startsWith('.mindwtr-et-s-')) ?? '';
          fs.files.set(ENC_URI, peer);
        }
      },
    });
    const missing = await port!.read('data.json.enc');

    await expect(port!.write('data.json.enc', new Uint8Array([8, 8]), missing.version))
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(ENC_URI)).toEqual(peer);
    expect(stagedLeaf).toMatch(/^\.mindwtr-et-s-/);
    expect(stagedLeaf).not.toContain('data.json.enc');
    expect(stagedLeaf.length).toBeLessThan(48);
    expect([...fs.files.keys()].some((uri) => uri.includes('.mindwtr-et-s-'))).toBe(true);
  });

  it('uses the SAF native atomic rename so a provider-side peer edit is preserved', async () => {
    const configuredUri = 'content://provider/tree/root/document/root%2Fdata.json';
    const canonicalUri = 'content://provider/tree/root/document/root/data.json';
    const original = new Uint8Array([1, 2, 3]);
    const peer = new Uint8Array([9, 9, 9]);
    fs.files.set(canonicalUri, original);
    let injected = false;
    const port = await createFileSyncEncryptionRemotePort(configuredUri, {
      onMutationPoint: (point, name) => {
        if (!injected && point === 'before-quarantine' && name === 'data.json') {
          injected = true;
          fs.files.set(canonicalUri, peer);
        }
      },
    });
    const baseline = await port!.read('data.json');

    await expect(port!.write('data.json', new Uint8Array([4, 5, 6]), baseline.version))
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    expect(fs.files.get(canonicalUri)).toEqual(peer);
    expect([...fs.files.entries()].find(([uri]) => uri.includes('.mindwtr-et-q-'))?.[1]).toEqual(peer);
    expect([...fs.files.keys()].some((uri) => uri.includes('.mindwtr-et-s-'))).toBe(true);
  });

  it('seals every retained plaintext transition generation before retry enable commits', async () => {
    seedPlaintextFolder();
    const attachmentName = 'attachments/a1.png';
    const attachmentUri = `${SYNC_DIR}/${attachmentName}`;
    const peer = new Uint8Array([4, 4, 4]);
    let injected = false;
    const port = await createFileSyncEncryptionRemotePort(SYNC_URI, {
      onMutationPoint: (point, name) => {
        if (!injected && point === 'before-quarantine' && name === attachmentName) {
          injected = true;
          fs.files.set(attachmentUri, peer);
        }
      },
    });
    const baseline = await port!.read(attachmentName);

    await expect(port!.write(attachmentName, new Uint8Array([2, 2]), baseline.version))
      .rejects.toBeInstanceOf(SyncEncryptionRemoteConflictError);
    const retained = [...fs.files.keys()].filter((uri) => uri.includes('.mindwtr-et-')).sort();
    expect(retained).toHaveLength(2);
    expect(retained.every((uri) => inspectSyncArtifact(fs.files.get(uri)!).kind === 'plaintext')).toBe(true);

    await enableSyncEncryption(PASSPHRASE);

    const material = await getSyncEncryptionMaterial();
    expect(material).not.toBeNull();
    expect([...fs.files.keys()].filter((uri) => uri.includes('.mindwtr-et-')).sort()).toEqual(retained);
    const { decryptSyncArtifact } = await import('@mindwtr/core');
    for (const uri of retained) {
      const sealed = fs.files.get(uri)!;
      expect(inspectSyncArtifact(sealed).kind).toBe('encrypted');
      await expect(decryptSyncArtifact(sealed, material!.key, mobileSyncCryptoPrimitives)).resolves.toBeDefined();
    }
    await expect(getMobileSyncEncryptionStatus()).resolves.toMatchObject({ state: 'enabled' });
  }, 30_000);

  it('seals desktop directory recovery generations in place before enable commits', async () => {
    seedPlaintextFolder();
    const retained = [
      `${SYNC_DIR}/.mindwtr-encryption-stage-desktop/data.json`,
      `${SYNC_DIR}/attachments/.mindwtr-encryption-quarantine-desktop/a1.png`,
    ];
    fs.files.set(retained[0], new TextEncoder().encode('desktop retained document generation'));
    fs.files.set(retained[1], new TextEncoder().encode('desktop retained attachment generation'));

    await enableSyncEncryption(PASSPHRASE);

    const material = await getSyncEncryptionMaterial();
    expect(material).not.toBeNull();
    const { decryptSyncArtifact } = await import('@mindwtr/core');
    for (const uri of retained) {
      const sealed = fs.files.get(uri)!;
      expect(inspectSyncArtifact(sealed).kind).toBe('encrypted');
      await expect(decryptSyncArtifact(sealed, material!.key, mobileSyncCryptoPrimitives))
        .resolves.toBeDefined();
    }
    expect(fs.files.has(retained[0])).toBe(true);
    expect(fs.files.has(retained[1])).toBe(true);
    await expect(getMobileSyncEncryptionStatus()).resolves.toMatchObject({ state: 'enabled' });
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

  it('restores the previous key when rotation state persistence fails, then retries after restart', async () => {
    seedPlaintextFolder();
    await enableSyncEncryption(PASSPHRASE);
    const previousKey = await syncEncryptionKeyCache.getKey();
    const previousState = JSON.parse(asyncStorage.get(SYNC_ENCRYPTION_STATE_KEY)!) as Record<string, unknown>;
    expect(previousKey).not.toBeNull();

    // Rotation first persists its retry journal, then commits the new enabled
    // material. Model the final AsyncStorage write failing after SecureStore has
    // already accepted the newly derived key.
    vi.mocked(AsyncStorage.setItem)
      .mockImplementationOnce(async (key: string, value: string) => {
        asyncStorage.set(key, value);
      })
      .mockRejectedValueOnce(new Error('state commit unavailable'));

    await expect(changeSyncEncryptionPassphrase(PASSPHRASE, 'replacement passphrase'))
      .rejects.toThrow('state commit unavailable');

    // A process restart must load the durable journal alongside the OLD key,
    // never the replacement key paired with the old salt.
    __resetSyncEncryptionStateForTests();
    await expect(syncEncryptionKeyCache.getKey()).resolves.toEqual(previousKey);
    expect(JSON.parse(asyncStorage.get(SYNC_ENCRYPTION_STATE_KEY)!)).toEqual({
      ...previousState,
      incompleteTransition: 'change-passphrase',
    });
    await expect(getMobileSyncEncryptionStatus()).resolves.toMatchObject({
      state: 'enabled',
      incompleteTransition: 'change-passphrase',
    });

    await expect(changeSyncEncryptionPassphrase(PASSPHRASE, 'replacement passphrase'))
      .resolves.toBeUndefined();

    __resetSyncEncryptionStateForTests();
    await expect(getMobileSyncEncryptionStatus()).resolves.toMatchObject({
      state: 'enabled',
      incompleteTransition: undefined,
    });
    await expect(syncEncryptionKeyCache.getKey()).resolves.not.toEqual(previousKey);
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

  it('reports a failed local-state write and lets the next queued write recover', async () => {
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('storage unavailable'));
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: 'aabb', discoveredParams: FAST_PARAMS });

    await expect(flushSyncEncryptionLocalState()).rejects.toThrow('storage unavailable');

    syncEncryptionLocalState.write({ state: 'remote-encrypted-no-key' });
    await expect(flushSyncEncryptionLocalState()).resolves.toBeUndefined();
    expect(JSON.parse(asyncStorage.get(SYNC_ENCRYPTION_STATE_KEY)!)).toMatchObject({
      state: 'remote-encrypted-no-key',
    });
  });

  it('fails closed when the encryption state is unreadable or invalid', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(getSyncEncryptionMaterial()).rejects.toBeInstanceOf(
      SyncEncryptionStateUnavailableError,
    );

    __resetSyncEncryptionStateForTests();
    asyncStorage.set(SYNC_ENCRYPTION_STATE_KEY, '{not-json');
    await expect(getSyncEncryptionMaterial()).rejects.toBeInstanceOf(
      SyncEncryptionStateUnavailableError,
    );
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

  it('File Sync: a keyed SAF device fails closed without writes or state mutation when plaintext discovery is unreadable', async () => {
    fs.files.set(SAF_SYNC_URI, new TextEncoder().encode(JSON.stringify(appData('peer'), null, 2)));
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: '07'.repeat(16), discoveredParams: FAST_PARAMS });
    await flushSyncEncryptionLocalState();
    vi.clearAllMocks();
    const stateBefore = syncEncryptionLocalState.read();
    const bytesBefore = new Uint8Array(fs.files.get(SAF_SYNC_URI)!);
    const { StorageAccessFramework, readAsStringAsync, writeAsStringAsync } = await import('./file-system');
    const readStored = async (uri: string, options?: { encoding?: string }): Promise<string> => {
      if (uri === SAF_SYNC_URI) throw new Error('provider plaintext sibling read denied');
      const bytes = fs.files.get(uri);
      if (!bytes) throw new Error(`ENOENT ${uri}`);
      return Buffer.from(bytes).toString(options?.encoding === 'base64' ? 'base64' : 'utf8');
    };
    vi.mocked(StorageAccessFramework!.readDirectoryAsync!).mockResolvedValue([SAF_SYNC_URI]);
    vi.mocked(StorageAccessFramework!.readAsStringAsync!).mockImplementation(readStored);
    vi.mocked(readAsStringAsync).mockImplementation(readStored);

    await expect(readSyncFile(SAF_SYNC_URI, { material }))
      .rejects.toThrow('provider plaintext sibling read denied');

    expect(fs.files.get(SAF_SYNC_URI)).toEqual(bytesBefore);
    expect(StorageAccessFramework!.writeAsStringAsync).not.toHaveBeenCalled();
    expect(writeAsStringAsync).not.toHaveBeenCalled();
    expect(syncEncryptionLocalState.read()).toEqual(stateBefore);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('File Sync: a keyed SAF device still treats confirmed absence of both generations as empty', async () => {
    syncEncryptionLocalState.write({ state: 'enabled', discoveredSalt: '07'.repeat(16), discoveredParams: FAST_PARAMS });
    const { StorageAccessFramework } = await import('./file-system');
    vi.mocked(StorageAccessFramework!.readDirectoryAsync!).mockResolvedValue([]);

    await expect(readSyncFile(SAF_SYNC_URI, { material })).resolves.toBeNull();
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

  it('reloads an incomplete transition journal and keeps ordinary sync blocked', async () => {
    await syncEncryptionLocalState.write({
      state: 'off',
      incompleteTransition: 'enable',
    });
    __resetSyncEncryptionStateForTests();

    await expect(getMobileSyncEncryptionStatus()).resolves.toEqual({
      state: 'off',
      incompleteTransition: 'enable',
    });
    await expect(isSyncEncryptionBlocked()).resolves.toBe(true);
  });
});
