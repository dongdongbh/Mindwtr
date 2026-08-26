import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import type { AppData } from '@mindwtr/core';

const asyncStorage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStorage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { asyncStorage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { asyncStorage.delete(key); }),
  },
}));

vi.mock('./app-log', () => ({
  logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn(), logSyncError: vi.fn(),
  sanitizeLogMessage: (value: string) => value,
}));
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { dropboxAppKey: 'test-app-key' } } },
}));
vi.mock('./dropbox-auth', () => ({
  getValidDropboxAccessToken: vi.fn(async () => 'token'),
  forceRefreshDropboxAccessToken: vi.fn(async () => 'token'),
}));

import {
  decryptSyncArtifact,
  deriveSyncKeyMaterial,
  encryptSyncArtifact,
  inspectSyncArtifact,
  SyncEncryptionTerminalError,
  runDisableSyncEncryptionOverRemote,
  runEnableSyncEncryptionOverRemote,
} from '@mindwtr/core';
import {
  openAttachmentBytesFromDownload,
  sealAttachmentBytesForUpload,
} from './attachment-sync-backends/common';
import {
  mobileSyncCryptoPrimitives,
  setSyncCryptoNativeModuleForTests,
  type SyncCryptoNativeModule,
} from './sync-crypto-native';
import {
  __resetSyncEncryptionStateForTests,
  syncEncryptionKeyCache,
  syncEncryptionLocalState,
} from './sync-encryption-state';
import { __syncEncryptionServiceTestUtils } from './sync-encryption-service';
import { __resetSecureSecretStoreForTests } from './secure-secret-store';
import { classifySyncFailure } from './sync-service-utils';
import { SyncEncryptionNoKeyError, SyncEncryptionStateUnavailableError } from './sync-encryption-state';

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

const FAST_PARAMS = { mKib: 64, t: 1, p: 1 };
const PASSPHRASE = 'correct horse battery staple';

const appData = (cloudKeys: string[]): AppData => ({
  tasks: [
    {
      id: 't1',
      title: 'has attachments',
      attachments: cloudKeys.map((cloudKey, index) => ({
        id: `a${index}`, kind: 'file', title: `a${index}.png`, cloudKey,
      })),
    },
  ],
  projects: [], sections: [], areas: [], settings: {},
} as unknown as AppData);

beforeEach(() => {
  asyncStorage.clear();
  __resetSyncEncryptionStateForTests();
  __resetSecureSecretStoreForTests();
  setSyncCryptoNativeModuleForTests(nodeQuickCrypto);
});

describe('attachment byte seam', () => {
  it('round-trips attachment bytes through seal/open', async () => {
    const material = await deriveSyncKeyMaterial(
      PASSPHRASE, new Uint8Array(16).fill(3), FAST_PARAMS, mobileSyncCryptoPrimitives,
    );
    const plaintext = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const sealed = await sealAttachmentBytesForUpload(plaintext, material);
    expect(inspectSyncArtifact(sealed).kind).toBe('encrypted');
    expect(sealed.length).toBe(plaintext.length + 70); // fixed MWENC1 overhead
    expect(Array.from(await openAttachmentBytesFromDownload(sealed, material)))
      .toEqual(Array.from(plaintext));
  });

  it('is a byte-for-byte no-op when encryption is off', async () => {
    const plaintext = new Uint8Array([1, 2, 3]);
    expect(await sealAttachmentBytesForUpload(plaintext, null)).toBe(plaintext);
    expect(await openAttachmentBytesFromDownload(plaintext, null)).toBe(plaintext);
  });

  it('passes an unmigrated plaintext attachment through (interrupted enable)', async () => {
    const material = await deriveSyncKeyMaterial(
      PASSPHRASE, new Uint8Array(16).fill(3), FAST_PARAMS, mobileSyncCryptoPrimitives,
    );
    const plaintext = new Uint8Array([7, 7, 7]);
    expect(Array.from(await openAttachmentBytesFromDownload(plaintext, material)))
      .toEqual([7, 7, 7]);
  });

  it('fails closed on a corrupt MWENC1 container rather than returning the raw bytes', async () => {
    const material = await deriveSyncKeyMaterial(
      PASSPHRASE, new Uint8Array(16).fill(3), FAST_PARAMS, mobileSyncCryptoPrimitives,
    );
    const sealed = await sealAttachmentBytesForUpload(new Uint8Array([1, 2, 3]), material);
    sealed[6] = 0x09; // unknown format_version -> 'unsupported'
    await expect(openAttachmentBytesFromDownload(sealed, material))
      .rejects.toBeInstanceOf(SyncEncryptionTerminalError);
  });

  it('fails closed on a wrong key', async () => {
    const material = await deriveSyncKeyMaterial(
      PASSPHRASE, new Uint8Array(16).fill(3), FAST_PARAMS, mobileSyncCryptoPrimitives,
    );
    const other = await deriveSyncKeyMaterial(
      'other', new Uint8Array(16).fill(3), FAST_PARAMS, mobileSyncCryptoPrimitives,
    );
    const sealed = await sealAttachmentBytesForUpload(new Uint8Array([1, 2, 3]), material);
    await expect(openAttachmentBytesFromDownload(sealed, other))
      .rejects.toBeInstanceOf(SyncEncryptionTerminalError);
  });
});

describe('transition entry derivation', () => {
  it('lists both generations of each document plus every referenced cloudKey', () => {
    const entries = __syncEncryptionServiceTestUtils.buildTransitionEntries(
      appData(['attachments/a0.png', 'attachments/a1.png', 'attachments/a0.png']),
    );
    expect(entries.filter((e) => e.kind === 'document').map((e) => e.name)).toEqual([
      'data.json', 'data.json.enc', 'data.json.bak', 'data.json.enc.bak',
    ]);
    // Deduplicated, and attachments keep their exact cloudKey name.
    expect(entries.filter((e) => e.kind === 'attachment').map((e) => e.name)).toEqual([
      'attachments/a0.png', 'attachments/a1.png',
    ]);
  });

  it('still lists the documents when there is no local app data', () => {
    const entries = __syncEncryptionServiceTestUtils.buildTransitionEntries(null);
    expect(entries).toHaveLength(4);
    expect(entries.every((e) => e.kind === 'document')).toBe(true);
  });
});

describe('Dropbox remote port + core transition round trip', () => {
  const remote = new Map<string, Uint8Array>();

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    remote.clear();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const arg = JSON.parse(String((init?.headers as Record<string, string>)?.['Dropbox-API-Arg'] ?? '{}'));
      const path = String(arg.path ?? '');
      if (url.includes('/files/download')) {
        const bytes = remote.get(path);
        if (!bytes) return new Response(null, { status: 409 });
        return new Response(new Uint8Array(bytes), { status: 200 });
      }
      if (url.includes('/files/upload')) {
        remote.set(path, new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
        return jsonResponse({ rev: 'rev1' });
      }
      if (url.includes('/files/delete_v2')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        remote.delete(String(body.path ?? ''));
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  });

  it('encrypts and then restores documents and attachments over the wire', async () => {
    const data = appData(['attachments/a0.png']);
    remote.set('/data.json', new TextEncoder().encode(JSON.stringify(data)));
    remote.set('/attachments/a0.png', new Uint8Array([4, 5, 6]));

    const port = await __syncEncryptionServiceTestUtils.createDropboxRemotePort(data);
    await runEnableSyncEncryptionOverRemote(
      PASSPHRASE, port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives,
    );

    expect(remote.has('/data.json')).toBe(false);
    expect(inspectSyncArtifact(remote.get('/data.json.enc')!).kind).toBe('encrypted');
    expect(inspectSyncArtifact(remote.get('/attachments/a0.png')!).kind).toBe('encrypted');

    const key = await syncEncryptionKeyCache.getKey();
    expect(key).not.toBeNull();
    const opened = await decryptSyncArtifact(remote.get('/data.json.enc')!, key!, mobileSyncCryptoPrimitives);
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual(data);

    await runDisableSyncEncryptionOverRemote(
      port, syncEncryptionKeyCache, syncEncryptionLocalState, undefined, mobileSyncCryptoPrimitives,
    );
    expect(remote.has('/data.json.enc')).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(remote.get('/data.json')!))).toEqual(data);
    expect(Array.from(remote.get('/attachments/a0.png')!)).toEqual([4, 5, 6]);
    await expect(syncEncryptionKeyCache.getKey()).resolves.toBeNull();
  }, 30_000);

  it('re-running an interrupted enable is a no-op on already-sealed artifacts', async () => {
    const data = appData(['attachments/a0.png']);
    remote.set('/data.json', new TextEncoder().encode(JSON.stringify(data)));
    remote.set('/attachments/a0.png', new Uint8Array([4, 5, 6]));

    const port = await __syncEncryptionServiceTestUtils.createDropboxRemotePort(data);
    await runEnableSyncEncryptionOverRemote(
      PASSPHRASE, port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives,
    );
    const sealedDoc = Buffer.from(remote.get('/data.json.enc')!).toString('base64');
    const sealedAttachment = Buffer.from(remote.get('/attachments/a0.png')!).toString('base64');

    await runEnableSyncEncryptionOverRemote(
      PASSPHRASE, port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives,
    );

    // Resume re-derives the SAME key from the existing header and skips artifacts whose
    // current bytes already decrypt — no double encryption, no orphaned second salt.
    expect(Buffer.from(remote.get('/data.json.enc')!).toString('base64')).toBe(sealedDoc);
    expect(Buffer.from(remote.get('/attachments/a0.png')!).toString('base64')).toBe(sealedAttachment);
  }, 30_000);
});

describe('classifySyncFailure', () => {
  it('gives encryption failures their own class, not "permission" or "auth"', () => {
    expect(classifySyncFailure(new SyncEncryptionNoKeyError())).toBe('encryption');
    expect(classifySyncFailure('SyncEncryptionTerminalError: wrong passphrase or corrupted data'))
      .toBe('encryption');
    expect(classifySyncFailure('unsupported MWENC1 format_version 9')).toBe('encryption');
    expect(classifySyncFailure(new SyncEncryptionStateUnavailableError())).toBe('encryptionState');
  });

  it('leaves the existing classifications alone', () => {
    expect(classifySyncFailure('WebDAV unauthorized (401)')).toBe('auth');
    expect(classifySyncFailure('Sync file is not writable.')).toBe('permission');
  });
});
