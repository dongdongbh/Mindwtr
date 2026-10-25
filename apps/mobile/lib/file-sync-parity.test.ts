import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as nodeCrypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import type { AppData } from '@mindwtr/core';

// File Sync's parity fixture (S5): every call React Native's File Sync makes to expo-file-system
// and to its native modules, with each scenario's result and the folder it leaves, frozen from the
// corrected HEAD before the code moves into core. Payloads are SHA-256 digests, the cipher's
// randomness is seeded, and only timestamps and scratch names are normalized, so different bytes
// never trace alike. The move must replay this trace call for call. Regenerate only on purpose:
// FILE_SYNC_PARITY_UPDATE=1 bunx vitest run lib/file-sync-parity.test.ts

const fs = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), trace: [] as unknown[][] }));
/** Test faults: SAF reads with no reported length, an iOS bookmark, a failing modern text read,
 *  and a peer that changes the folder just before a matching call runs. */
const fault = vi.hoisted(() => ({
  listing: null as Error | null,
  readOnlyCreate: false,
  unverified: false,
  fileText: false,
  bookmark: null as null | (() => Promise<string | null>),
  peer: null as null | ((entry: unknown[]) => boolean),
}));
const record = vi.hoisted(() => (name: string, ...args: unknown[]) => {
  const entry = [name, ...args];
  fs.trace.push(entry);
  if (fault.peer?.(entry)) fault.peer = null;
});
const dirOf = vi.hoisted(() => (uri: string) => uri.slice(0, uri.lastIndexOf('/')));
const leafOf = vi.hoisted(() => (uri: string) => {
  const decoded = decodeURIComponent(uri);
  return decoded.slice(Math.max(decoded.lastIndexOf('/'), decoded.lastIndexOf(':')) + 1);
});
const childrenOf = vi.hoisted(() => (dir: string): string[] => {
  const prefix = `${dir.replace(/\/+$/, '')}/`;
  const children = new Set<string>();
  for (const uri of fs.files.keys()) {
    if (!uri.startsWith(prefix)) continue;
    const child = uri.slice(prefix.length).split('/')[0];
    if (child) children.add(`${prefix}${child}`);
  }
  return [...children];
});
const toBytes = vi.hoisted(() => (content: string, encoding?: string) => (
  new Uint8Array(Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8'))
));

vi.mock('expo-modules-core', () => ({
  requireNativeModule: vi.fn((name: string) => { throw new Error(`native module unavailable: ${name}`); }),
}));

vi.mock('./file-system', () => {
  const read = (uri: string, options?: { encoding?: string }) => {
    const bytes = fs.files.get(uri);
    if (!bytes) throw new Error(`ENOENT ${uri}`);
    return Buffer.from(bytes).toString(options?.encoding === 'base64' ? 'base64' : 'utf8');
  };
  const write = (uri: string, content: string, options?: { encoding?: string }) => {
    fs.files.set(uri, toBytes(content, options?.encoding));
  };
  return {
    StorageAccessFramework: {
      readAsStringAsync: async (uri: string, options?: { encoding?: string }) => {
        record('saf.read', uri, options ?? null);
        return read(uri, options);
      },
      writeAsStringAsync: async (uri: string, content: string, options?: { encoding?: string }) => {
        record('saf.write', uri, content, options ?? null);
        write(uri, content, options);
      },
      readDirectoryAsync: async (dir: string) => {
        record('saf.list', dir);
        if (fault.listing) throw fault.listing;
        return childrenOf(dir);
      },
      createFileAsync: async (dir: string, name: string, mime: string) => {
        record('saf.create', dir, name, mime);
        if (fault.readOnlyCreate) throw new Error(`Location '${dir}' isn't writable.`);
        const requested = `${dir.replace(/\/+$/, '')}/${name}`;
        const uri = fs.files.has(requested) ? `${requested}.provider-copy` : requested;
        fs.files.set(uri, new Uint8Array(0));
        return uri;
      },
      deleteAsync: async (uri: string) => { record('saf.delete', uri); fs.files.delete(uri); },
      requestDirectoryPermissionsAsync: async () => {
        record('saf.requestDirectoryPermissions');
        return { granted: true, directoryUri: 'content://provider/tree/root' };
      },
      makeDirectoryAsync: async (dir: string, name: string) => { record('saf.mkdir', dir, name); return `${dir}/${name}`; },
    },
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    getInfoAsync: async (uri: string) => {
      record('fs.info', uri);
      return { exists: fs.files.has(uri) || childrenOf(uri).length > 0, size: fs.files.get(uri)?.length ?? 0 };
    },
    readAsStringAsync: async (uri: string, options?: { encoding?: string }) => { record('fs.read', uri, options ?? null); return read(uri, options); },
    writeAsStringAsync: async (uri: string, content: string, options?: { encoding?: string }) => {
      record('fs.write', uri, content, options ?? null);
      write(uri, content, options);
    },
    readDirectoryAsync: async (dir: string) => { record('fs.list', dir); return childrenOf(dir).map(leafOf); },
    deleteAsync: async (uri: string) => { record('fs.delete', uri); fs.files.delete(uri); },
    copyAsync: async ({ from, to }: { from: string; to: string }) => {
      record('fs.copy', from, to);
      const bytes = fs.files.get(from);
      if (bytes) fs.files.set(to, bytes);
    },
    moveAsync: async ({ from, to }: { from: string; to: string }) => {
      record('fs.move', from, to);
      const bytes = fs.files.get(from);
      if (bytes) { fs.files.set(to, bytes); fs.files.delete(from); }
    },
    makeDirectoryAsync: async (uri: string) => { record('fs.mkdir', uri); },
    cacheDirectory: 'file://cache/',
    documentDirectory: 'file://document/',
  };
});

vi.mock('expo-file-system', () => {
  class File {
    constructor(public uri: string) {}
    get exists() { record('file.exists', this.uri); return fs.files.has(this.uri); }
    create(options?: { overwrite?: boolean }) {
      record('file.create', this.uri, options ?? null);
      if (fs.files.has(this.uri) && !options?.overwrite) throw new Error(`EEXIST ${this.uri}`);
      fs.files.set(this.uri, new Uint8Array(0));
    }
    write(content: string | Uint8Array) {
      record('file.write', this.uri, content);
      fs.files.set(this.uri, typeof content === 'string' ? toBytes(content) : content);
    }
    async bytes() { record('file.bytes', this.uri); return fs.files.get(this.uri) ?? new Uint8Array(0); }
    async text() {
      record('file.text', this.uri);
      if (fault.fileText) throw new Error('modern File API unavailable');
      return Buffer.from(fs.files.get(this.uri) ?? new Uint8Array(0)).toString('utf8'); }
    delete() { record('file.delete', this.uri); fs.files.delete(this.uri); }
    rename(name: string) {
      record('file.rename', this.uri, name);
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
    static pickDirectoryAsync = undefined;
  }
  return { File, Directory, Paths: { cache: 'cache', document: 'document' } };
});

vi.mock('./saf-documents', () => ({
  listSafChildren: async (dir: string) => {
    record('native.listChildren', dir);
    if (fault.listing) throw fault.listing;
    return childrenOf(dir).map((uri) => ({
      uri, name: leafOf(uri), mime: null, size: fault.unverified ? null : fs.files.get(uri)?.length ?? null, lastModified: null,
    }));
  },
  statSafDocument: async (uri: string) => {
    record('native.stat', uri);
    const bytes = fs.files.get(uri);
    if (!bytes) throw new Error('SAF_DOCUMENT_UNAVAILABLE: the provider gave no answer for the document');
    return { uri, name: leafOf(uri), mime: null, size: fault.unverified ? null : bytes.length, lastModified: null };
  },
  readSafDocument: async (uri: string) => {
    record('native.read', uri);
    const bytes = fs.files.get(uri);
    if (!bytes) throw new Error('SAF_DOCUMENT_UNAVAILABLE: the document is gone');
    return { bytes, lengthVerified: !fault.unverified };
  },
  writeSafDocument: async (uri: string, bytes: Uint8Array) => { record('native.write', uri, bytes); fs.files.set(uri, bytes); },
}));

vi.mock('./sync-file-transition-cas', () => ({
  renameSafTransitionDocument: async (uri: string, name: string) => {
    record('native.rename', uri, name);
    const target = `${dirOf(uri)}/${name}`;
    if (fs.files.has(target)) throw new Error(`EEXIST ${target}`);
    const bytes = fs.files.get(uri);
    if (!bytes) throw new Error(`ENOENT ${uri}`);
    fs.files.set(target, bytes);
    fs.files.delete(uri);
    return { uri: target, name };
  },
}));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock('./sync-path-bookmarks', () => ({
  createSyncPathBookmark: async () => null,
  readBookmarkedSyncFileText: async (bookmark: string) => {
    record('bookmark.read', bookmark);
    return fault.bookmark ? fault.bookmark() : null;
  },
  supportsBookmarkedSyncFileIO: () => { record('bookmark.supported'); return fault.bookmark !== null; },
  isSyncPathBookmarksAvailable: () => false,
  resolveSyncPathBookmark: async () => null,
}));
vi.mock('./app-log', () => ({
  logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logSyncError: vi.fn(),
  sanitizeLogMessage: (value: string) => value,
}));
const asyncStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => { asyncStorage.set(key, value); },
    removeItem: async (key: string) => { asyncStorage.delete(key); },
  },
}));

import { deriveSyncKeyMaterial, encryptSyncArtifact, type SyncKeyMaterial } from '@mindwtr/core';
import { pickAndParseSyncFolder, readSyncFile, readSyncFileVersioned, writeSyncFile } from './storage-file';
import { mobileSyncCryptoPrimitives, setSyncCryptoNativeModuleForTests, type SyncCryptoNativeModule } from './sync-crypto-native';
import { __resetSyncEncryptionStateForTests } from './sync-encryption-state';
import { changeSyncEncryptionPassphrase, disableSyncEncryption, enableSyncEncryption } from './sync-encryption-service';
import { __resetSecureSecretStoreForTests } from './secure-secret-store';
import {
  acquireMobileFileSyncLease,
  releaseMobileFileSyncLease,
  revalidateMobileFileSyncLease,
  setSyncFileLockNativeModuleForTests,
} from './sync-file-lock';
import { SYNC_BACKEND_KEY, SYNC_PATH_KEY } from './sync-constants';

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
  // Seeded, so ciphertext, salts and nonces repeat run to run and their digests can be frozen.
  randomBytes: (size) => {
    const out = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 32) {
      const block = createHash('sha256').update(`file-sync-parity:${seed.counter++}`).digest();
      out.set(block.subarray(0, Math.min(32, size - offset)), offset);
    }
    return out;
  },
};
const seed = { counter: 0 };

const SAF = 'content://provider/tree/root/document/root';
const SAF_SYNC_URI = 'content://provider/tree/root/document/root%2Fdata.json';
const PATH = 'file://sync';
const FAST_PARAMS = { mKib: 64, t: 1, p: 1 };
const appData = (title: string): AppData => ({
  tasks: [{ id: 't1', title } as never], projects: [], sections: [], areas: [], settings: {},
} as unknown as AppData);
const json = (title: string) => new TextEncoder().encode(JSON.stringify(appData(title), null, 2));

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** Values with nothing that changes between runs: scratch names (clock and Math.random) are
 *  numbered in order of first use, timestamps are masked, and byte payloads and long strings
 *  become their length plus a SHA-256 digest, so different payloads never normalize alike. */
const normalizer = () => {
  const names = new Map<string, string>();
  const text = (value: string): string => value
    .replace(/\.mindwtr-et-([sqbp])-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/g, (match, kind: string) => {
      if (!names.has(match)) names.set(match, `.mindwtr-et-${kind}-${names.size}`);
      return names.get(match)!;
    })
    .replace(/mindwtr-write-test-\d+/g, 'mindwtr-write-test-#')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>');
  const value = (item: unknown): unknown => {
    if (item instanceof Uint8Array) return `<bytes:${item.length}:${digest(item)}>`;
    if (typeof item === 'string') {
      const normalized = text(item);
      return normalized.length > 160 ? `<text:${normalized.length}:${digest(normalized)}>` : normalized;
    }
    if (Array.isArray(item)) return item.map(value);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([field, inner]) => [field, value(inner)]));
    }
    return item;
  };
  return { entry: (entry: unknown[]) => entry.map(value), value, name: text };
};

/** A scenario's result: its value, or the error's name and message. */
const settle = async (run: Promise<unknown>): Promise<unknown> => {
  try {
    return { value: (await run) ?? null };
  } catch (error) {
    return { error: `${(error as Error).name}: ${(error as Error).message}` };
  }
};

const setPlatform = async (os: 'android' | 'ios') => {
  const { Platform } = await import('react-native');
  (Platform as { OS: string }).OS = os;
};

/** A peer that changes the folder once, just before the first call `match` accepts. */
const peerBefore = (match: (entry: unknown[]) => boolean, change: () => void) => {
  fault.peer = (entry) => {
    if (!match(entry)) return false;
    change();
    return true;
  };
};
const callOn = (name: string, pattern: RegExp) => (entry: unknown[]) =>
  entry[0] === name && typeof entry[1] === 'string' && pattern.test(entry[1]);

/** The native lock as an Android build has it, recording each call. */
const recordingLock = () => {
  let tokens = 0;
  return {
    acquireAsync: async (uri: string) => { record('native.lock.acquire', uri); tokens += 1; return `token-${tokens}`; },
    revalidateAsync: async (token: string) => { record('native.lock.revalidate', token); },
    releaseAsync: async (token: string) => { record('native.lock.release', token); },
  };
};

const scenarios: Record<string, (material: SyncKeyMaterial) => Promise<unknown>> = {
  '01 first sync into an empty SAF folder': async () => {
    const remote = await readSyncFileVersioned(SAF_SYNC_URI);
    await writeSyncFile(SAF_SYNC_URI, appData('first'), { expectedFingerprint: remote.fingerprint });
  },
  '02 steady SAF write': async () => {
    fs.files.set(`${SAF}/data.json`, json('remote'));
    const remote = await readSyncFileVersioned(SAF_SYNC_URI);
    await writeSyncFile(SAF_SYNC_URI, appData('mine'), { expectedFingerprint: remote.fingerprint });
  },
  '03 encrypted SAF writes, twice': async (material) => {
    for (const title of ['one', 'two']) {
      const remote = await readSyncFileVersioned(SAF_SYNC_URI, { material });
      await writeSyncFile(SAF_SYNC_URI, appData(title), { material, expectedFingerprint: remote.fingerprint });
    }
  },
  '04 enable encryption on a path folder': async () => {
    fs.files.set(`${PATH}/data.json`, json('before'));
    await enableSyncEncryption('correct horse battery staple');
  },
  '05 change the passphrase': async () => {
    fs.files.set(`${PATH}/data.json`, json('before'));
    await enableSyncEncryption('correct horse battery staple');
    fs.trace.length = 0;
    await changeSyncEncryptionPassphrase('correct horse battery staple', 'another correct horse');
  },
  '06 disable encryption': async () => {
    fs.files.set(`${PATH}/data.json`, json('before'));
    await enableSyncEncryption('correct horse battery staple');
    fs.trace.length = 0;
    await disableSyncEncryption();
  },
  '07 pick a writable SAF folder': async () => pickAndParseSyncFolder(),
  '08 pick a read-only SAF folder': async () => {
    fault.readOnlyCreate = true;
    return pickAndParseSyncFolder().catch((error: Error) => error.message);
  },
  '09 no-key discovery': async (material) => {
    fs.files.set(`${SAF}/data.json.enc`, await encryptSyncArtifact(json('peer'), material, mobileSyncCryptoPrimitives));
    return readSyncFileVersioned(SAF_SYNC_URI).catch((error: Error) => error.name);
  },
  '10 peer-disabled discovery': async (material) => {
    fs.files.set(`${SAF}/data.json`, json('peer-disabled'));
    return readSyncFileVersioned(SAF_SYNC_URI, { material }).catch((error: Error) => error.name);
  },
  '11 unreadable listing': async () => {
    fault.listing = new Error('SAF_DOCUMENT_UNAVAILABLE: the provider could not list the folder');
    return readSyncFileVersioned(SAF_SYNC_URI).catch((error: Error) => error.message);
  },
  '12 lock busy': async () => {
    setSyncFileLockNativeModuleForTests({
      acquireAsync: async (uri: string) => { record('native.lock.acquire', uri); throw new Error('SYNC_FILE_LOCK_BUSY: another File Sync operation is active'); },
      revalidateAsync: async (token: string) => { record('native.lock.revalidate', token); },
      releaseAsync: async (token: string) => { record('native.lock.release', token); },
    }, 'android');
    return acquireMobileFileSyncLease(SAF_SYNC_URI).catch((error: Error) => error.name);
  },
  '13 lock identity lost on release': async () => {
    setSyncFileLockNativeModuleForTests({
      acquireAsync: async (uri: string) => { record('native.lock.acquire', uri); return 'token-1'; },
      revalidateAsync: async (token: string) => { record('native.lock.revalidate', token); },
      releaseAsync: async (token: string) => {
        record('native.lock.release', token);
        throw new Error('SYNC_FILE_LOCK_IDENTITY_LOST: private SAF authority changed');
      },
    }, 'android');
    const lease = await acquireMobileFileSyncLease(SAF_SYNC_URI);
    await revalidateMobileFileSyncLease(lease);
    return releaseMobileFileSyncLease(lease).catch((error: Error) => error.name);
  },
  '14 interrupted-write guard': async () => {
    fs.files.set(`${SAF}/.mindwtr-et-q-abc-1-x`, json('remote-only'));
    return readSyncFileVersioned(SAF_SYNC_URI).catch((error: Error) => error.name);
  },
  '15 steady path writes rotate the backup': async () => {
    fs.files.set(`${PATH}/data.json`, json('remote'));
    for (const title of ['one', 'two']) {
      const remote = await readSyncFileVersioned(`${PATH}/data.json`);
      await writeSyncFile(`${PATH}/data.json`, appData(title), { expectedFingerprint: remote.fingerprint });
    }
  },
  '16 enable encryption on a SAF folder with attachments': async () => {
    asyncStorage.set(SYNC_PATH_KEY, SAF_SYNC_URI);
    fs.files.set(`${SAF}/data.json`, json('before'));
    fs.files.set(`${SAF}/attachments/a1.png`, new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    fs.files.set(`${SAF}/attachments/a2.txt`, new TextEncoder().encode('attachment two'));
    await enableSyncEncryption('correct horse battery staple');
  },
  '17 enable then disable encryption on a path folder with attachments': async () => {
    fs.files.set(`${PATH}/data.json`, json('before'));
    fs.files.set(`${PATH}/attachments/a1.png`, new Uint8Array([137, 80, 78, 71, 4, 5, 6]));
    await enableSyncEncryption('correct horse battery staple');
    await disableSyncEncryption();
  },
  '18 unverified SAF read that parses': async () => {
    fs.files.set(`${SAF}/data.json`, json('unverified'));
    fault.unverified = true;
    return readSyncFileVersioned(SAF_SYNC_URI);
  },
  '19 unverified SAF read that is cut off': async () => {
    fs.files.set(`${SAF}/data.json`, json('cut').slice(0, 20));
    fault.unverified = true;
    return readSyncFileVersioned(SAF_SYNC_URI);
  },
  '20 unverified empty SAF read': async () => {
    fs.files.set(`${SAF}/data.json`, new Uint8Array(0));
    fault.unverified = true;
    return readSyncFileVersioned(SAF_SYNC_URI);
  },
  '21 unverified encrypted SAF read that is cut off': async (material) => {
    const sealed = await encryptSyncArtifact(json('sealed'), material, mobileSyncCryptoPrimitives);
    fs.files.set(`${SAF}/data.json.enc`, sealed.slice(0, sealed.length - 9));
    fault.unverified = true;
    return readSyncFileVersioned(SAF_SYNC_URI, { material });
  },
  '22 unverified headerless .enc beside an empty plaintext folder': async () => {
    fs.files.set(`${SAF}/data.json.enc`, new Uint8Array([1, 2, 3]));
    fault.unverified = true;
    return readSyncFileVersioned(SAF_SYNC_URI);
  },
  '23 SAF write after a peer replaced the read generation': async () => {
    fs.files.set(`${SAF}/data.json`, json('remote'));
    const remote = await readSyncFileVersioned(SAF_SYNC_URI);
    fs.files.set(`${SAF}/data.json`, json('peer'));
    await writeSyncFile(SAF_SYNC_URI, appData('mine'), { expectedFingerprint: remote.fingerprint });
  },
  '24 SAF write while a peer replaces the generation after staging': async () => {
    fs.files.set(`${SAF}/data.json`, json('remote'));
    const remote = await readSyncFileVersioned(SAF_SYNC_URI);
    peerBefore(callOn('native.read', /\.mindwtr-et-s-/), () => fs.files.set(`${SAF}/data.json`, json('peer')));
    await writeSyncFile(SAF_SYNC_URI, appData('mine'), { expectedFingerprint: remote.fingerprint });
  },
  '25 SAF write while a peer creates the document after quarantine': async () => {
    fs.files.set(`${SAF}/data.json`, json('remote'));
    const remote = await readSyncFileVersioned(SAF_SYNC_URI);
    peerBefore(callOn('native.read', /\.mindwtr-et-q-/), () => fs.files.set(`${SAF}/data.json`, json('peer')));
    await writeSyncFile(SAF_SYNC_URI, appData('mine'), { expectedFingerprint: remote.fingerprint });
  },
  '26 SAF first write while a peer creates the document': async () => {
    const remote = await readSyncFileVersioned(SAF_SYNC_URI);
    peerBefore(callOn('native.read', /\.mindwtr-et-s-/), () => fs.files.set(`${SAF}/data.json`, json('peer')));
    await writeSyncFile(SAF_SYNC_URI, appData('first'), { expectedFingerprint: remote.fingerprint });
  },
  '27 path write while a peer creates the document after quarantine': async () => {
    fs.files.set(`${PATH}/data.json`, json('remote'));
    const remote = await readSyncFileVersioned(`${PATH}/data.json`);
    peerBefore(callOn('file.bytes', /\.mindwtr-et-q-/), () => fs.files.set(`${PATH}/data.json`, json('peer')));
    await writeSyncFile(`${PATH}/data.json`, appData('mine'), { expectedFingerprint: remote.fingerprint });
  },
  '28 encrypted SAF write after a peer replaced the read generation': async (material) => {
    fs.files.set(`${SAF}/data.json.enc`, await encryptSyncArtifact(json('remote'), material, mobileSyncCryptoPrimitives));
    const remote = await readSyncFileVersioned(SAF_SYNC_URI, { material });
    fs.files.set(`${SAF}/data.json.enc`, await encryptSyncArtifact(json('peer'), material, mobileSyncCryptoPrimitives));
    await writeSyncFile(SAF_SYNC_URI, appData('mine'), { material, expectedFingerprint: remote.fingerprint });
  },
  '29 iOS bookmarked read': async () => {
    await setPlatform('ios');
    fault.bookmark = async () => JSON.stringify(appData('bookmarked'));
    return readSyncFile(`${PATH}/data.json`, { bookmark: 'bookmark-1' });
  },
  '30 iOS bookmarked read fails, then the file': async () => {
    await setPlatform('ios');
    fs.files.set(`${PATH}/data.json`, json('direct'));
    fault.bookmark = async () => { throw new Error('bookmark is stale'); };
    return readSyncFile(`${PATH}/data.json`, { bookmark: 'bookmark-1' });
  },
  '31 iOS bookmarked read returns nothing, then the file': async () => {
    await setPlatform('ios');
    fs.files.set(`${PATH}/data.json`, json('direct'));
    fault.bookmark = async () => null;
    return readSyncFile(`${PATH}/data.json`, { bookmark: 'bookmark-1' });
  },
  '32 iOS bookmarked read of an empty file': async () => {
    await setPlatform('ios');
    fs.files.set(`${PATH}/data.json`, json('direct'));
    fault.bookmark = async () => '';
    return readSyncFile(`${PATH}/data.json`, { bookmark: 'bookmark-1' });
  },
  '33 iOS text read falls back to the legacy API': async () => {
    await setPlatform('ios');
    fs.files.set(`${PATH}/data.json`, json('legacy'));
    fault.fileText = true;
    return readSyncFile(`${PATH}/data.json`);
  },
  '34 iOS damaged sync file recovers through the bookmark': async () => {
    await setPlatform('ios');
    fs.files.set(`${PATH}/data.json`, new TextEncoder().encode('{"tasks": ['));
    fault.bookmark = async () => JSON.stringify(appData('bookmarked'));
    return readSyncFileVersioned(`${PATH}/data.json`, { bookmark: 'bookmark-1' });
  },
  '35 iOS evicted sync file reads the backup': async () => {
    await setPlatform('ios');
    fs.files.set(`${PATH}/.data.json.icloud`, new Uint8Array([0]));
    fs.files.set(`${PATH}/data.json.bak`, json('backup'));
    return readSyncFile(`${PATH}/data.json`);
  },
  '36 iOS versioned writes on a path folder': async () => {
    await setPlatform('ios');
    fs.files.set(`${PATH}/data.json`, json('remote'));
    for (const title of ['one', 'two']) {
      const remote = await readSyncFileVersioned(`${PATH}/data.json`);
      await writeSyncFile(`${PATH}/data.json`, appData(title), { expectedFingerprint: remote.fingerprint });
    }
  },
};

const FIXTURE = resolve(__dirname, '__fixtures__/file-sync-parity.json');

describe('File Sync parity fixture (S5)', () => {
  beforeEach(() => {
    fs.files.clear();
    fs.trace.length = 0;
    asyncStorage.clear();
    asyncStorage.set(SYNC_BACKEND_KEY, 'file');
    asyncStorage.set(SYNC_PATH_KEY, `${PATH}/data.json`);
    __resetSyncEncryptionStateForTests();
    __resetSecureSecretStoreForTests();
    setSyncCryptoNativeModuleForTests(nodeQuickCrypto);
    setSyncFileLockNativeModuleForTests(undefined);
  });

  it('replays every scenario call for call', async () => {
    const material = await deriveSyncKeyMaterial('pass', new Uint8Array(16).fill(7), FAST_PARAMS, mobileSyncCryptoPrimitives);
    const traces: Record<string, { outcome: unknown; folder: Record<string, string>; calls: unknown[][] }> = {};
    for (const [name, run] of Object.entries(scenarios)) {
      await setPlatform('android');
      fs.files.clear();
      fs.trace.length = 0;
      Object.assign(fault, { listing: null, readOnlyCreate: false, unverified: false, fileText: false, bookmark: null, peer: null });
      seed.counter = 0;
      asyncStorage.clear();
      asyncStorage.set(SYNC_BACKEND_KEY, 'file');
      asyncStorage.set(SYNC_PATH_KEY, `${PATH}/data.json`);
      __resetSyncEncryptionStateForTests();
      __resetSecureSecretStoreForTests();
      setSyncFileLockNativeModuleForTests(recordingLock(), 'android');
      const outcome = await settle(run(material));
      const normalize = normalizer();
      const calls = fs.trace.map(normalize.entry);
      const folder = Object.fromEntries([...fs.files.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([uri, bytes]) => [normalize.name(uri), `<bytes:${bytes.length}:${digest(bytes)}>`]));
      traces[name] = { outcome: normalize.value(outcome), folder, calls };
    }
    await setPlatform('android');
    if (process.env.FILE_SYNC_PARITY_UPDATE === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(traces, null, 1)}\n`);
    }
    expect(traces).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  }, 120_000);
});
