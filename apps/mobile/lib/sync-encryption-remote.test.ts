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
  SyncEncryptionRemoteVersionUnavailableError,
  SyncEncryptionTerminalError,
  runChangeSyncEncryptionPassphraseOverRemote,
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

const davResponseXml = (
  href: string,
  options: { collection?: boolean; status?: number } = {},
): string => {
  const status = options.status ?? 200;
  return '<d:response>'
    + `<d:href>${href}</d:href>`
    + '<d:propstat><d:prop><d:resourcetype>'
    + (options.collection ? '<d:collection/>' : '')
    + `</d:resourcetype></d:prop><d:status>HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}</d:status></d:propstat>`
    + '</d:response>';
};

const davMultistatusXml = (...responses: string[]): string =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`;

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

  it('accepts only managed blob attachment keys from untrusted remote metadata', () => {
    const entries = __syncEncryptionServiceTestUtils.buildTransitionEntries(appData([
      '../victim',
      'attachments/%2e%2e/victim',
      '/absolute',
      'https://evil.example/victim',
      'data.json',
      'cloudkit:asset',
      'attachments/valid.bin',
    ]));

    expect(entries.filter((entry) => entry.kind === 'attachment').map((entry) => entry.name)).toEqual([
      'attachments/valid.bin',
    ]);
  });
});

describe('WebDAV remote port error boundaries', () => {
  const createPort = async () => {
    asyncStorage.set('@mindwtr_webdav_url', 'https://dav.example.com/mindwtr');
    return __syncEncryptionServiceTestUtils.createWebdavRemotePort(null);
  };

  const baseUrl = 'https://dav.example.com/mindwtr';
  const collectionUrl = `${baseUrl}/attachments/`;

  it('requires the exact collection response and excludes child collections', () => {
    const xml = davMultistatusXml(
      davResponseXml(collectionUrl, { collection: true }),
      davResponseXml(`${collectionUrl}folder/`, { collection: true }),
      davResponseXml(`${collectionUrl}a.bin`),
    );

    expect(__syncEncryptionServiceTestUtils.parseWebdavAttachmentKeys(xml, collectionUrl))
      .toEqual(['attachments/a.bin']);
  });

  it.each([
    ['malformed XML', '<d:multistatus xmlns:d="DAV:"><d:response>'],
    ['missing collection response', davMultistatusXml(davResponseXml(`${collectionUrl}a.bin`))],
    ['unmatched href', davMultistatusXml(
      davResponseXml(collectionUrl, { collection: true }),
      davResponseXml('https://other.example/attachments/a.bin'),
    )],
    ['ambiguous href', davMultistatusXml(
      `<d:response><d:href>${collectionUrl}</d:href><d:href>${collectionUrl}a.bin</d:href>`
      + '<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>'
      + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
    )],
    ['failed propstat', davMultistatusXml(
      davResponseXml(collectionUrl, { collection: true }),
      davResponseXml(`${collectionUrl}a.bin`, { status: 403 }),
    )],
  ] as const)('fails closed on %s', (_case, xml) => {
    expect(() => __syncEncryptionServiceTestUtils.parseWebdavAttachmentKeys(xml, collectionUrl))
      .toThrow(/WebDAV attachment inventory/);
  });

  it.each([403, 404])('fails closed on an HTTP %s collection response', async (status) => {
    const fetcher = vi.fn(async () => new Response(null, { status }));
    await expect(__syncEncryptionServiceTestUtils.listWebdavAttachmentKeys(baseUrl, { fetcher }))
      .rejects.toThrow(`PROPFIND failed (${status})`);
  });

  it('does not write any transition artifact when collection validation fails', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PROPFIND') return new Response(null, { status: 403 });
      if (method !== 'GET') throw new Error('transition attempted a write');
      if (url.endsWith('/data.json')) {
        return new Response(new TextEncoder().encode(JSON.stringify(appData([]))), {
          status: 200,
          headers: { etag: '"v1"' },
        });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    const port = await createPort();

    await expect(runEnableSyncEncryptionOverRemote(
      PASSPHRASE,
      port,
      syncEncryptionKeyCache,
      syncEncryptionLocalState,
      undefined,
      mobileSyncCryptoPrimitives,
      FAST_PARAMS,
    )).rejects.toThrow('PROPFIND failed (403)');

    expect(fetcher.mock.calls.every(([, init]) => ['GET', 'PROPFIND'].includes((init?.method ?? 'GET').toUpperCase())))
      .toBe(true);
    expect(syncEncryptionLocalState.read()).toBeNull();
    await expect(syncEncryptionKeyCache.getKey()).resolves.toBeNull();
  });

  it('propagates a GET 401 instead of treating the artifact as absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const port = await createPort();

    await expect(port.read('data.json')).rejects.toThrow('WebDAV File GET failed (401)');
  });

  it('rejects unmanaged artifact names before issuing a request', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const port = await createPort();

    expect(() => port.read('../victim')).toThrow('Invalid sync encryption remote artifact name');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('propagates a GET timeout instead of treating the artifact as absent', async () => {
    const timeout = new Error('WebDAV request timed out');
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeout; }));
    const port = await createPort();

    await expect(port.read('data.json')).rejects.toBe(timeout);
  });

  it('treats an explicit GET 404 as absence but a conditional DELETE 404 as conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    const port = await createPort();

    await expect(port.read('data.json')).resolves.toEqual({ bytes: null, version: null });
    await expect(port.remove('data.json', '"v1"')).rejects.toThrow('WEBDAV_REMOTE_WRITE_CONFLICT');
  });

  it('propagates a DELETE 500 so the transition cannot commit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    const port = await createPort();

    await expect(port.remove('data.json', '"v1"')).rejects.toThrow('WebDAV DELETE failed (500)');
  });

  it('round-trips an unreferenced attachment from the authoritative collection inventory', async () => {
    const baseUrl = 'https://dav.example.com/mindwtr';
    const remote = new Map<string, Uint8Array>([
      ['data.json', new TextEncoder().encode(JSON.stringify(appData([])))],
      ['attachments/orphan.bin', new Uint8Array([3, 1, 4, 1, 5])],
    ]);
    const revisions = new Map<string, number>(Array.from(remote.keys()).map((name) => [name, 1]));
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const key = url.startsWith(`${baseUrl}/`) ? url.slice(baseUrl.length + 1) : url;
      if (method === 'PROPFIND') {
        const responses = [
          davResponseXml(`${baseUrl}/attachments/`, { collection: true }),
          ...Array.from(remote.keys())
            .filter((name) => name.startsWith('attachments/'))
            .map((name) => davResponseXml(`${baseUrl}/${name}`)),
        ];
        return new Response(
          davMultistatusXml(...responses),
          { status: 207, headers: { 'content-type': 'application/xml' } },
        );
      }
      if (method === 'GET') {
        const bytes = remote.get(key);
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(bytes.slice() as unknown as BodyInit, {
          status: 200,
          headers: { etag: `"v${revisions.get(key) ?? 1}"` },
        });
      }
      if (method === 'PUT') {
        const headers = new Headers(init?.headers);
        const current = remote.has(key) ? `"v${revisions.get(key) ?? 1}"` : null;
        if ((headers.get('if-none-match') === '*' && current)
          || (headers.has('if-match') && headers.get('if-match') !== current)) {
          return new Response(null, { status: 412 });
        }
        remote.set(key, new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
        revisions.set(key, (revisions.get(key) ?? 0) + 1);
        return new Response(null, { status: 201 });
      }
      if (method === 'DELETE') {
        const current = remote.has(key) ? `"v${revisions.get(key) ?? 1}"` : null;
        if (!current || new Headers(init?.headers).get('if-match') !== current) {
          return new Response(null, { status: 412 });
        }
        remote.delete(key);
        revisions.delete(key);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected WebDAV request ${method} ${url}`);
    }));
    const port = await createPort();

    await runEnableSyncEncryptionOverRemote(
      PASSPHRASE, port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives, FAST_PARAMS,
    );
    expect(inspectSyncArtifact(remote.get('attachments/orphan.bin')!).kind).toBe('encrypted');

    await runChangeSyncEncryptionPassphraseOverRemote(
      PASSPHRASE, 'next passphrase', port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives, FAST_PARAMS,
    );
    await runDisableSyncEncryptionOverRemote(
      port, syncEncryptionKeyCache, syncEncryptionLocalState, undefined, mobileSyncCryptoPrimitives,
    );
    expect(remote.get('attachments/orphan.bin')).toEqual(new Uint8Array([3, 1, 4, 1, 5]));
  }, 30_000);

  it.each([
    ['missing', undefined],
    ['weak', 'W/"v1"'],
  ] as const)('fails an end-to-end transition before writes for a %s ETag', async (_case, etag) => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PROPFIND') {
        return new Response(
          davMultistatusXml(davResponseXml(url, { collection: true })),
          { status: 207, headers: { 'content-type': 'application/xml' } },
        );
      }
      if ((init?.method ?? 'GET') !== 'GET') throw new Error('transition attempted an unsafe write');
      return new Response(new TextEncoder().encode('{"tasks":[]}'), {
        status: 200,
        headers: etag ? { etag } : undefined,
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const port = await createPort();

    await expect(runEnableSyncEncryptionOverRemote(
      PASSPHRASE,
      port,
      syncEncryptionKeyCache,
      syncEncryptionLocalState,
      undefined,
      mobileSyncCryptoPrimitives,
      FAST_PARAMS,
    )).rejects.toBeInstanceOf(SyncEncryptionRemoteVersionUnavailableError);

    expect(syncEncryptionLocalState.read()).toBeNull();
    await expect(syncEncryptionKeyCache.getKey()).resolves.toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => ['GET', 'PROPFIND'].includes(init?.method ?? 'GET'))).toBe(true);
  });
});

describe('Dropbox remote port + core transition round trip', () => {
  const remote = new Map<string, Uint8Array>();
  const revisions = new Map<string, number>();

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    remote.clear();
    revisions.clear();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/files/list_folder')) {
        const entries = Array.from(remote.keys())
          .filter((path) => path.startsWith('/attachments/'))
          .map((path) => ({
            '.tag': 'file',
            name: path.slice('/attachments/'.length),
            path_display: path,
            rev: `rev${revisions.get(path) ?? 1}`,
          }));
        return jsonResponse({ entries, cursor: 'done', has_more: false });
      }
      const arg = JSON.parse(String((init?.headers as Record<string, string>)?.['Dropbox-API-Arg'] ?? '{}'));
      const path = String(arg.path ?? '');
      if (url.includes('/files/download')) {
        const bytes = remote.get(path);
        if (!bytes) return jsonResponse({ error_summary: 'path/not_found/..' }, 409);
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'Dropbox-API-Result': JSON.stringify({ rev: `rev${revisions.get(path) ?? 1}` }) },
        });
      }
      if (url.includes('/files/upload')) {
        const currentRev = remote.has(path) ? `rev${revisions.get(path) ?? 1}` : null;
        const mode = arg.mode as { '.tag'?: string; update?: string } | undefined;
        if ((mode?.['.tag'] === 'add' && currentRev)
          || (mode?.['.tag'] === 'update' && mode.update !== currentRev)) {
          return jsonResponse({ error_summary: 'path/conflict/file/..' }, 409);
        }
        remote.set(path, new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
        const next = (revisions.get(path) ?? 0) + 1;
        revisions.set(path, next);
        return jsonResponse({ rev: `rev${next}` });
      }
      if (url.includes('/files/delete_v2')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const deletePath = String(body.path ?? '');
        const currentRev = remote.has(deletePath) ? `rev${revisions.get(deletePath) ?? 1}` : null;
        if (!currentRev || body.parent_rev !== currentRev) {
          return jsonResponse({ error_summary: 'path_lookup/conflict/..' }, 409);
        }
        remote.delete(deletePath);
        revisions.delete(deletePath);
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

  it('migrates a peer-only attachment from the authoritative remote document through every transition', async () => {
    const peerAttachmentName = 'attachments/peer-only.png';
    const peerAttachmentBytes = new Uint8Array([9, 8, 7, 6]);
    const remoteData = appData([peerAttachmentName]);
    const staleLocalData = appData([]);
    remote.set('/data.json', new TextEncoder().encode(JSON.stringify(remoteData)));
    remote.set(`/${peerAttachmentName}`, peerAttachmentBytes);

    const port = await __syncEncryptionServiceTestUtils.createDropboxRemotePort(staleLocalData);
    await runEnableSyncEncryptionOverRemote(
      PASSPHRASE, port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives, FAST_PARAMS,
    );
    expect(inspectSyncArtifact(remote.get(`/${peerAttachmentName}`)!).kind).toBe('encrypted');

    await runChangeSyncEncryptionPassphraseOverRemote(
      PASSPHRASE, 'the next passphrase', port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives, FAST_PARAMS,
    );
    const rotatedKey = await syncEncryptionKeyCache.getKey();
    expect(rotatedKey).not.toBeNull();
    await expect(decryptSyncArtifact(
      remote.get(`/${peerAttachmentName}`)!, rotatedKey!, mobileSyncCryptoPrimitives,
    )).resolves.toEqual(peerAttachmentBytes);

    await runDisableSyncEncryptionOverRemote(
      port, syncEncryptionKeyCache, syncEncryptionLocalState, undefined, mobileSyncCryptoPrimitives,
    );
    expect(remote.get(`/${peerAttachmentName}`)).toEqual(peerAttachmentBytes);
  }, 30_000);

  it('uses a backup-only document as the attachment authority through every transition', async () => {
    const attachmentName = 'attachments/backup-only.png';
    const attachmentBytes = new Uint8Array([2, 4, 6, 8]);
    const backupData = appData([attachmentName]);
    remote.set('/data.json.bak', new TextEncoder().encode(JSON.stringify(backupData)));
    remote.set(`/${attachmentName}`, attachmentBytes);

    const port = await __syncEncryptionServiceTestUtils.createDropboxRemotePort(appData([]));
    await runEnableSyncEncryptionOverRemote(
      PASSPHRASE, port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives, FAST_PARAMS,
    );
    expect(inspectSyncArtifact(remote.get('/data.json.enc.bak')!).kind).toBe('encrypted');
    expect(inspectSyncArtifact(remote.get(`/${attachmentName}`)!).kind).toBe('encrypted');

    await runChangeSyncEncryptionPassphraseOverRemote(
      PASSPHRASE, 'the next passphrase', port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives, FAST_PARAMS,
    );
    const changedKey = await syncEncryptionKeyCache.getKey();
    expect(changedKey).not.toBeNull();
    await expect(decryptSyncArtifact(
      remote.get(`/${attachmentName}`)!, changedKey!, mobileSyncCryptoPrimitives,
    )).resolves.toEqual(attachmentBytes);

    await runDisableSyncEncryptionOverRemote(
      port, syncEncryptionKeyCache, syncEncryptionLocalState, undefined, mobileSyncCryptoPrimitives,
    );
    expect(JSON.parse(new TextDecoder().decode(remote.get('/data.json.bak')!))).toEqual(backupData);
    expect(remote.get(`/${attachmentName}`)).toEqual(attachmentBytes);
  }, 30_000);

  it('migrates an unreferenced Dropbox attachment from the provider inventory', async () => {
    const orphanName = '/attachments/orphan.bin';
    const orphanBytes = new Uint8Array([8, 5, 3, 0, 9]);
    remote.set('/data.json', new TextEncoder().encode(JSON.stringify(appData([]))));
    remote.set(orphanName, orphanBytes);

    const port = await __syncEncryptionServiceTestUtils.createDropboxRemotePort(appData([]));
    await runEnableSyncEncryptionOverRemote(
      PASSPHRASE, port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives, FAST_PARAMS,
    );
    expect(inspectSyncArtifact(remote.get(orphanName)!).kind).toBe('encrypted');

    await runChangeSyncEncryptionPassphraseOverRemote(
      PASSPHRASE, 'next passphrase', port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives, FAST_PARAMS,
    );
    await runDisableSyncEncryptionOverRemote(
      port, syncEncryptionKeyCache, syncEncryptionLocalState, undefined, mobileSyncCryptoPrimitives,
    );
    expect(remote.get(orphanName)).toEqual(orphanBytes);
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

  it('aborts before committing key/state on a Dropbox delete failure and resumes cleanly', async () => {
    const data = appData([]);
    remote.set('/data.json', new TextEncoder().encode(JSON.stringify(data)));
    let failDelete = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/files/list_folder')) {
        const entries = Array.from(remote.keys())
          .filter((path) => path.startsWith('/attachments/'))
          .map((path) => ({
            '.tag': 'file',
            name: path.slice('/attachments/'.length),
            path_display: path,
            rev: `rev${revisions.get(path) ?? 1}`,
          }));
        return jsonResponse({ entries, cursor: 'done', has_more: false });
      }
      const arg = JSON.parse(String((init?.headers as Record<string, string>)?.['Dropbox-API-Arg'] ?? '{}'));
      const path = String(arg.path ?? '');
      if (url.includes('/files/download')) {
        const bytes = remote.get(path);
        if (!bytes) return jsonResponse({ error_summary: 'path/not_found/..' }, 409);
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'Dropbox-API-Result': JSON.stringify({ rev: `rev${revisions.get(path) ?? 1}` }) },
        });
      }
      if (url.includes('/files/upload')) {
        const currentRev = remote.has(path) ? `rev${revisions.get(path) ?? 1}` : null;
        const mode = arg.mode as { '.tag'?: string; update?: string } | undefined;
        if ((mode?.['.tag'] === 'add' && currentRev)
          || (mode?.['.tag'] === 'update' && mode.update !== currentRev)) {
          return jsonResponse({ error_summary: 'path/conflict/file/..' }, 409);
        }
        remote.set(path, new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer()));
        const next = (revisions.get(path) ?? 0) + 1;
        revisions.set(path, next);
        return jsonResponse({ rev: `rev${next}` });
      }
      if (url.includes('/files/delete_v2')) {
        if (failDelete) return jsonResponse({ error_summary: 'internal_error/..' }, 500);
        const body = JSON.parse(String(init?.body ?? '{}'));
        const deletePath = String(body.path ?? '');
        const currentRev = remote.has(deletePath) ? `rev${revisions.get(deletePath) ?? 1}` : null;
        if (!currentRev || body.parent_rev !== currentRev) {
          return jsonResponse({ error_summary: 'path_lookup/conflict/..' }, 409);
        }
        remote.delete(deletePath);
        revisions.delete(deletePath);
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch ${url}`);
    }));

    const port = await __syncEncryptionServiceTestUtils.createDropboxRemotePort(data);
    await expect(runEnableSyncEncryptionOverRemote(
      PASSPHRASE, port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives, FAST_PARAMS,
    )).rejects.toThrow('Dropbox file delete failed: HTTP 500');
    expect(syncEncryptionLocalState.read()).toEqual({
      state: 'off',
      incompleteTransition: 'enable',
    });
    await expect(syncEncryptionKeyCache.getKey()).resolves.toBeNull();
    expect(remote.has('/data.json')).toBe(true);
    expect(remote.has('/data.json.enc')).toBe(true);

    failDelete = false;
    await runEnableSyncEncryptionOverRemote(
      PASSPHRASE, port, syncEncryptionKeyCache, syncEncryptionLocalState,
      undefined, mobileSyncCryptoPrimitives, FAST_PARAMS,
    );
    expect(remote.has('/data.json')).toBe(false);
    expect(syncEncryptionLocalState.read()?.state).toBe('enabled');
    await expect(syncEncryptionKeyCache.getKey()).resolves.not.toBeNull();
  });

  it('treats explicit Dropbox not-found reads as absence and conditional deletes as conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/files/download')) {
        return jsonResponse({
          error: { '.tag': 'path', path: { '.tag': 'not_found' } },
        }, 409);
      }
      if (url.includes('/files/delete_v2')) {
        return jsonResponse({
          error: { '.tag': 'path_lookup', path_lookup: { '.tag': 'not_found' } },
        }, 409);
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    const port = await __syncEncryptionServiceTestUtils.createDropboxRemotePort(null);

    await expect(port.read('data.json')).resolves.toEqual({ bytes: null, version: null });
    await expect(port.remove('data.json', 'rev1')).rejects.toThrow('Dropbox artifact changed');
  });

  it('propagates a non-not-found Dropbox delete conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/files/delete_v2')) {
        return jsonResponse({ error: { '.tag': 'too_many_write_operations' } }, 409);
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
    const port = await __syncEncryptionServiceTestUtils.createDropboxRemotePort(null);

    await expect(port.remove('data.json', 'rev1')).rejects.toThrow('Dropbox artifact changed');
  });
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
