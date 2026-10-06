import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppData, Attachment } from './types';
import { computeSha256Hex } from './attachment-hash';
import { buildFileSyncGenerationCloudKey } from './attachment-paths';
import { DropboxConflictError, DropboxFileNotFoundError } from './dropbox';
import { WebDavRemoteWriteConflictError } from './webdav';
import { WebdavHostUploadLimitError } from './attachment-transfer';
import { ResponseTooLargeError } from './http-utils';
import { createMobileAttachmentFiles, type MobileAttachmentSafPort } from './mobile-attachment-files';
import { createMobileAttachmentCommon, type MobileAttachmentUploadTask } from './mobile-attachment-common';
import { createMobileAttachmentBackends, type MobileAttachmentBackendsCoreFunctions } from './mobile-attachment-backends';
import { createMemoryFileSystem, createMemoryStorage, createRecordingLog, MANAGED } from './__fixtures__/mobile-attachment-fakes';
import { consoleLogger, setLogger, type LogPayload } from './logger';

const now = '2026-09-28T00:00:00.000Z';
const LOCAL = new Uint8Array([1, 2, 3, 4]);
const REMOTE = new Uint8Array([9, 8, 7, 6]);
const LOCAL_URI = `${MANAGED}att-1.txt`;
const BASE_URL = 'https://dav.example.com/Mindwtr';
const toArrayBuffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

const fileAttachment = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: 'att-1',
  kind: 'file',
  title: 'att-1.txt',
  uri: LOCAL_URI,
  localStatus: 'available',
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const withAttachment = (attachment: Attachment): AppData => ({
  tasks: [{
    id: 'task-1',
    title: 'Task',
    status: 'inbox',
    tags: [],
    contexts: [],
    attachments: [attachment],
    createdAt: now,
    updatedAt: now,
  }],
  projects: [],
  sections: [],
  areas: [],
  settings: {},
});

const attachmentOf = (result: AppData | false) => (result === false ? undefined : result.tasks[0].attachments?.[0]);

const setup = (options: {
  saf?: MobileAttachmentSafPort;
  core?: Partial<MobileAttachmentBackendsCoreFunctions>;
  createUploadTask?: () => MobileAttachmentUploadTask | null;
  maxWebdavBufferedUploadBytes?: number;
} = {}) => {
  const memory = createMemoryFileSystem({ saf: options.saf });
  const { storage } = createMemoryStorage();
  const { log, lines } = createRecordingLog();
  const files = createMobileAttachmentFiles({
    fs: memory.fs,
    storage,
    getSecureConfigValue: async () => null,
    log,
    fetch: vi.fn() as unknown as typeof fetch,
    dropboxAuth: { getValidAccessToken: async () => 'token', forceRefreshAccessToken: async () => 'token' },
    core: { isSandboxMode: () => false },
  });
  const order: string[] = [];
  const installer = {
    installAttachmentFileGeneration: vi.fn(async (stagedPath: string, targetPath: string) => {
      await memory.fs.move(stagedPath, targetPath);
      return { status: 'installed' as const };
    }),
    recoverFileSyncAttachmentPublications: vi.fn(async () => undefined),
    reserveFileSyncAttachmentPublication: vi.fn(async (targetPath: string) => {
      order.push('reserve');
      return { operationId: 'op-1', stagedPath: `${targetPath}.stage`, targetPath };
    }),
    claimFileSyncAttachmentPublication: vi.fn(async () => { order.push('claim'); }),
    publishImmutableAttachmentFileGeneration: vi.fn(async (stagedPath: string, targetPath: string) => {
      order.push('publish');
      await memory.fs.move(stagedPath, targetPath);
      return { status: 'published' as const };
    }),
    completeFileSyncAttachmentPublication: vi.fn(async () => { order.push('complete'); }),
    abandonFileSyncAttachmentPublication: vi.fn(async () => undefined),
    retainFileSyncAttachmentPublicationForInvalidTarget: vi.fn(async () => undefined),
    clearFileSyncAttachmentPublicationRecovery: vi.fn(async () => undefined),
    hashAttachmentFileGeneration: vi.fn(async () => {
      throw new Error('native hash not configured');
    }),
  };
  const common = createMobileAttachmentCommon({
    fs: memory.fs,
    files,
    crypto: {} as never,
    encryption: { logSyncEncryptionEvent: async () => undefined },
    installer,
    installerMayBeMissing: () => false,
    // Skips the WebDAV request spacing; no test here waits on a timer.
    timersPaused: () => true,
    uploads: { createUploadTask: options.createUploadTask ?? (() => null) },
  });
  const backends = createMobileAttachmentBackends({
    fs: memory.fs,
    files,
    common,
    installer,
    log,
    maxWebdavBufferedUploadBytes: options.maxWebdavBufferedUploadBytes,
    core: { withRetry: (operation) => operation(), ...options.core },
  });
  return { backends, memory, lines, installer, order, files, common };
};

const webdavConfig = { url: `${BASE_URL}/data.json`, username: 'user', password: 'pw' };

describe('WebDAV attachment pass', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubWebdavServer = (putResponse: () => Response) => {
    const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      requests.push({ method, url, headers: { ...(init.headers as Record<string, string>) } });
      if (method === 'HEAD') return new Response(null, { status: 404 });
      if (method === 'MKCOL') return new Response(null, { status: 201 });
      if (method === 'PUT') return putResponse();
      return new Response(null, { status: 500 });
    }));
    return requests;
  };

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid optional host upload capability (%s) at construction', (limit) => {
      expect(() => setup({ maxWebdavBufferedUploadBytes: limit }))
        .toThrow('WebDAV buffered upload capability is invalid');
    },
  );

  it('accepts the exact plaintext cap using actual stat rather than stale attachment size', async () => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory, lines } = setup({ maxWebdavBufferedUploadBytes: LOCAL.byteLength });
    memory.put(LOCAL_URI, LOCAL);

    const result = await backends.syncWebdavAttachments(
      withAttachment(fileAttachment({ size: 1 })), webdavConfig, BASE_URL,
    );

    expect(attachmentOf(result)?.cloudKey).toBe('attachments/att-1.txt');
    expect(attachmentOf(result)?.contentSize).toBe(LOCAL.byteLength);
    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(lines.some((line) => line.extra?.releaseCheck === 'v1.3.5/webdav-host-upload-limit')).toBe(false);
  });

  it.each([
    ['first upload', {}, undefined],
    ['pending post-merge upload', { cloudKey: 'attachments/att-1.txt', fileHash: 'a'.repeat(64), pendingContentUpload: true }, 'post-merge'],
    ['pending prepare identity', { cloudKey: 'attachments/att-1.txt', pendingContentUpload: true }, 'prepare'],
    ['prepare content hash', { cloudKey: 'attachments/att-1.txt', fileHash: 'a'.repeat(64), contentSize: 1, contentMtimeMs: 0 }, 'prepare'],
  ] as const)('refuses a >16MiB source before reads/copies/writes for %s', async (_name, overrides, phase) => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory, lines, files } = setup({
      maxWebdavBufferedUploadBytes: 8 * 1024 * 1024,
      // Keep the remote generation selected so prepare really reaches content hashing.
      core: { webdavFileExists: async () => true },
    });
    memory.put(LOCAL_URI, LOCAL);
    const getInfo = memory.fs.getInfo;
    vi.spyOn(memory.fs, 'getInfo').mockImplementation(async (uri) => {
      const info = await getInfo(uri);
      return uri === LOCAL_URI ? { ...info, size: 16 * 1024 * 1024 + 1 } : info;
    });
    const hash = vi.spyOn(files, 'computeAttachmentFileHash');
    const input = withAttachment(fileAttachment({ ...overrides, size: 1 }));
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL, undefined, { phase }))
      .rejects.toBeInstanceOf(WebdavHostUploadLimitError);

    expect(input).toEqual(before);
    expect(memory.read(LOCAL_URI)).toEqual(LOCAL);
    expect(hash).not.toHaveBeenCalled();
    expect(memory.calls.filter((call) => /^(readBytes|readBytesRange|copy|sha256|writeBytes|move|delete) /.test(call))).toEqual([]);
    expect(requests.filter((request) => ['MKCOL', 'PUT', 'DELETE'].includes(request.method))).toEqual([]);
    expect(lines.filter((line) => line.extra?.releaseCheck === 'v1.3.5/webdav-host-upload-limit')).toEqual([{
      level: 'warn', message: 'WebDAV host upload admission refused',
      extra: { releaseCheck: 'v1.3.5/webdav-host-upload-limit', operation: 'upload', outcome: 'refused' },
    }]);
  });

  it.each([undefined, 'prepare'] as const)('refuses unavailable source size before reads in phase %s', async (phase) => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory, files } = setup({ maxWebdavBufferedUploadBytes: LOCAL.byteLength });
    memory.put(LOCAL_URI, LOCAL);
    vi.spyOn(files, 'statAttachmentFile').mockResolvedValue(null);
    const input = withAttachment(fileAttachment(phase ? { cloudKey: 'attachments/att-1.txt', pendingContentUpload: true } : {}));
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL, undefined, { phase }))
      .rejects.toThrow('WebDAV attachment upload cannot be admitted by this host transport');

    expect(input).toEqual(before);
    expect(memory.calls.filter((call) => /^(readBytes|copy|sha256) /.test(call))).toEqual([]);
    expect(requests.filter((request) => ['MKCOL', 'PUT'].includes(request.method))).toEqual([]);
  });

  it('refuses an oversized local migration before copying the source', async () => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory } = setup({ maxWebdavBufferedUploadBytes: 3 });
    const foreignUri = 'file:///data/files/provider-copy.txt';
    memory.put(foreignUri, LOCAL);
    const input = withAttachment(fileAttachment({ uri: foreignUri, size: 1 }));
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL))
      .rejects.toBeInstanceOf(WebdavHostUploadLimitError);

    expect(input).toEqual(before);
    expect(memory.calls.filter((call) => /^(readBytes|copy|sha256) /.test(call))).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('refuses a local migration with unavailable size before copying or reading', async () => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory, files } = setup({ maxWebdavBufferedUploadBytes: LOCAL.byteLength });
    const foreignUri = 'file:///data/files/provider-copy.txt';
    memory.put(foreignUri, LOCAL);
    vi.spyOn(files, 'statAttachmentFile').mockResolvedValue(null);
    const input = withAttachment(fileAttachment({ uri: foreignUri }));
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL))
      .rejects.toBeInstanceOf(WebdavHostUploadLimitError);

    expect(input).toEqual(before);
    expect(memory.calls.filter((call) => /^(readBytes|copy|sha256) /.test(call))).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('refuses snapshot growth before hashing or remote mutation and removes only its scratch copy', async () => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory, files } = setup({ maxWebdavBufferedUploadBytes: LOCAL.byteLength });
    memory.put(LOCAL_URI, LOCAL);
    const copy = memory.fs.copy;
    vi.spyOn(memory.fs, 'copy').mockImplementation(async (from, to) => {
      await copy(from, to);
      memory.put(to, new Uint8Array(LOCAL.byteLength + 1));
    });
    const hash = vi.spyOn(files, 'computeAttachmentFileHash');
    const input = withAttachment(fileAttachment());
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL))
      .rejects.toBeInstanceOf(WebdavHostUploadLimitError);

    expect(input).toEqual(before);
    expect(memory.read(LOCAL_URI)).toEqual(LOCAL);
    expect([...memory.files.keys()]).toEqual([LOCAL_URI]);
    expect(hash).not.toHaveBeenCalled();
    expect(memory.calls.filter((call) => /^(readBytes|readBytesRange|sha256) /.test(call))).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('aborts without returning earlier patches after a confirmed upload then an oversized source', async () => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory } = setup({ maxWebdavBufferedUploadBytes: LOCAL.byteLength });
    const secondUri = `${MANAGED}att-2.txt`;
    memory.put(LOCAL_URI, LOCAL);
    memory.put(secondUri, new Uint8Array(LOCAL.byteLength + 1));
    const input = withAttachment(fileAttachment());
    input.tasks[0].attachments!.push(fileAttachment({ id: 'att-2', uri: secondUri, title: 'second.txt' }));
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL))
      .rejects.toBeInstanceOf(WebdavHostUploadLimitError);

    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(input).toEqual(before);
    expect([...memory.files.keys()].sort()).toEqual([LOCAL_URI, secondUri].sort());
  });

  it('checks the bytes of a snapshot that grows after its stat before hashing/uploading', async () => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory } = setup({ maxWebdavBufferedUploadBytes: LOCAL.byteLength });
    memory.put(LOCAL_URI, LOCAL);
    const read = memory.fs.readBytes;
    vi.spyOn(memory.fs, 'readBytes').mockImplementation(async (uri) => {
      if (uri.includes('mindwtr-upload-')) return new Uint8Array(LOCAL.byteLength + 1);
      return read(uri);
    });
    const input = withAttachment(fileAttachment());
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL))
      .rejects.toBeInstanceOf(WebdavHostUploadLimitError);

    expect(input).toEqual(before);
    expect(memory.read(LOCAL_URI)).toEqual(LOCAL);
    expect([...memory.files.keys()]).toEqual([LOCAL_URI]);
    expect(requests).toEqual([]);
  });

  it('retains the existing uncapped RN upload behavior when capability is absent', async () => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory, lines } = setup();
    memory.put(LOCAL_URI, LOCAL);

    const result = await backends.syncWebdavAttachments(withAttachment(fileAttachment()), webdavConfig, BASE_URL);

    expect(attachmentOf(result)?.cloudKey).toBe('attachments/att-1.txt');
    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(lines.some((line) => line.extra?.releaseCheck === 'v1.3.5/webdav-host-upload-limit')).toBe(false);
  });

  it('keeps an unchanged cloud attachment above the host cap without hashing or uploading', async () => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory, files, lines } = setup({
      maxWebdavBufferedUploadBytes: 4,
      core: { webdavFileExists: async () => true },
    });
    memory.put(LOCAL_URI, LOCAL);
    const current = { mtimeMs: 1234, size: 16 * 1024 * 1024 + 1 };
    vi.spyOn(files, 'statAttachmentFile').mockResolvedValue(current);
    const hash = vi.spyOn(files, 'computeAttachmentFileHash');
    const input = withAttachment(fileAttachment({
      cloudKey: 'attachments/att-1.txt', fileHash: 'a'.repeat(64),
      contentMtimeMs: current.mtimeMs, contentSize: current.size,
    }));
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL, undefined, { phase: 'prepare' }))
      .resolves.toBe(false);

    expect(input).toEqual(before);
    expect(hash).not.toHaveBeenCalled();
    expect(memory.calls.filter((call) => /^(readBytes|copy|sha256) /.test(call))).toEqual([]);
    expect(requests).toEqual([]);
    expect(lines.some((line) => line.extra?.releaseCheck === 'v1.3.5/webdav-host-upload-limit')).toBe(false);
  });

  it('sends a new upload with If-None-Match: * and records the cloud key only after the PUT', async () => {
    const requests = stubWebdavServer(() => new Response(null, { status: 201 }));
    const { backends, memory } = setup();
    memory.put(LOCAL_URI, LOCAL);

    const result = await backends.syncWebdavAttachments(withAttachment(fileAttachment()), webdavConfig, BASE_URL);

    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.url).toBe(`${BASE_URL}/attachments/att-1.txt`);
    expect(put?.headers['If-None-Match']).toBe('*');
    expect(put?.headers['If-Match']).toBeUndefined();
    expect(attachmentOf(result)?.cloudKey).toBe('attachments/att-1.txt');
  });

  it('refuses a redirected PUT and records no cloud key', async () => {
    stubWebdavServer(() => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }));
    const { backends, memory, lines } = setup();
    memory.put(LOCAL_URI, LOCAL);

    const result = await backends.syncWebdavAttachments(withAttachment(fileAttachment()), webdavConfig, BASE_URL);

    expect(attachmentOf(result)?.cloudKey).toBeUndefined();
    expect(lines).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: 'Failed to upload attachment att-1',
      extra: { error: 'fetch failed: unexpected redirect' },
    }));
  });

  it('refuses to overwrite a remote copy that has no strong ETag', async () => {
    const webdavPutFileVersioned = vi.fn(async () => undefined);
    const { backends, memory } = setup({
      core: {
        webdavMakeDirectory: vi.fn(async () => undefined),
        webdavHeadFile: vi.fn(async () => ({
          exists: true,
          fingerprint: null,
          etag: 'W/"weak"',
          lastModified: null,
          contentLength: null,
        })),
        webdavPutFileVersioned,
      },
    });
    memory.put(LOCAL_URI, LOCAL);

    const result = await backends.syncWebdavAttachments(withAttachment(fileAttachment()), webdavConfig, BASE_URL);

    expect(webdavPutFileVersioned).not.toHaveBeenCalled();
    expect(attachmentOf(result)?.cloudKey).toBeUndefined();
  });

  it('streams a new upload but sends an overwrite through the checked byte PUT', async () => {
    const task = { uploadAsync: vi.fn(async () => ({ status: 201 })), cancelAsync: vi.fn(async () => undefined) };
    const createUploadTask = vi.fn(() => task);
    const webdavPutFileVersioned = vi.fn(async () => undefined);
    const remote = { exists: false, fingerprint: null, etag: null as string | null, lastModified: null, contentLength: null };
    const webdavConfirmUploadedFile = vi.fn(async () => ({ confirmed: true, redirected: false, status: 200 }));
    const { backends, memory } = setup({
      createUploadTask,
      core: {
        webdavMakeDirectory: vi.fn(async () => undefined),
        webdavHeadFile: vi.fn(async () => remote),
        webdavPutFileVersioned,
        webdavConfirmUploadedFile,
      },
    });
    memory.put(LOCAL_URI, LOCAL);

    const created = await backends.syncWebdavAttachments(withAttachment(fileAttachment()), webdavConfig, BASE_URL);
    expect(createUploadTask).toHaveBeenCalledTimes(1);
    expect(webdavConfirmUploadedFile).toHaveBeenCalledWith(
      `${BASE_URL}/attachments/att-1.txt`,
      LOCAL.byteLength,
      expect.objectContaining({ username: 'user', password: 'pw' }),
    );
    expect(webdavPutFileVersioned).not.toHaveBeenCalled();
    expect(attachmentOf(created)?.cloudKey).toBe('attachments/att-1.txt');

    Object.assign(remote, { exists: true, etag: '"v1"' });
    const replaced = await backends.syncWebdavAttachments(withAttachment(fileAttachment()), webdavConfig, BASE_URL);
    expect(createUploadTask).toHaveBeenCalledTimes(1);
    expect(webdavPutFileVersioned).toHaveBeenCalledWith(
      `${BASE_URL}/attachments/att-1.txt`,
      expect.any(ArrayBuffer),
      expect.any(String),
      '"v1"',
      expect.objectContaining({ username: 'user' }),
    );
    expect(attachmentOf(replaced)?.cloudKey).toBe('attachments/att-1.txt');
  });

  it('records a streamed upload only once a HEAD at the same URL finds its size', async () => {
    // The native uploader follows a redirect by itself: a 307 stores the file elsewhere and a
    // 303 stores nothing, yet the task answers 2xx.
    const task = { uploadAsync: vi.fn(async () => ({ status: 201 })), cancelAsync: vi.fn(async () => undefined) };
    const { backends, memory, lines } = setup({
      createUploadTask: () => task,
      core: {
        webdavMakeDirectory: vi.fn(async () => undefined),
        webdavHeadFile: vi.fn(async () => ({ exists: false, fingerprint: null, etag: null, lastModified: null, contentLength: null })),
        webdavPutFileVersioned: vi.fn(async () => undefined),
        webdavConfirmUploadedFile: vi.fn(async () => ({ confirmed: false, redirected: false, status: 404 })),
      },
    });
    memory.put(LOCAL_URI, LOCAL);
    const logs: LogPayload[] = [];
    setLogger((payload) => { logs.push(payload); });
    let result: AppData | false;
    try {
      result = await backends.syncWebdavAttachments(withAttachment(fileAttachment()), webdavConfig, BASE_URL);
    } finally {
      setLogger(consoleLogger);
    }

    expect(attachmentOf(result)?.cloudKey).toBeUndefined();
    expect(lines).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: 'Failed to upload attachment att-1',
      extra: { error: 'fetch failed: unexpected redirect' },
    }));
    expect(logs).toEqual([expect.objectContaining({
      level: 'warn',
      context: { releaseCheck: 'v1.3.4/fetch-redirect-refused-upload', method: 'PUT', status: 404 },
    })]);
  });

  describe('after a redirected HEAD (a CDN for downloads, or a write redirect)', () => {
    const redirectedHead = { confirmed: false, redirected: true, status: 200 };
    const run = async (
      putResult: () => Promise<undefined>,
      proofAfterConflict = redirectedHead,
    ) => {
      const task = { uploadAsync: vi.fn(async () => ({ status: 201 })), cancelAsync: vi.fn(async () => undefined) };
      const webdavPutFileVersioned = vi.fn(putResult);
      const webdavConfirmUploadedFile = vi.fn()
        .mockResolvedValueOnce(redirectedHead)
        .mockResolvedValue(proofAfterConflict);
      const { backends, memory, lines } = setup({
        createUploadTask: () => task,
        core: {
          webdavMakeDirectory: vi.fn(async () => undefined),
          webdavHeadFile: vi.fn(async () => ({ exists: false, fingerprint: null, etag: null, lastModified: null, contentLength: null })),
          webdavPutFileVersioned,
          webdavConfirmUploadedFile,
        },
      });
      memory.put(LOCAL_URI, LOCAL);
      const logs: LogPayload[] = [];
      setLogger((payload) => { logs.push(payload); });
      let result: AppData | false;
      try {
        result = await backends.syncWebdavAttachments(withAttachment(fileAttachment()), webdavConfig, BASE_URL);
      } finally {
        setLogger(consoleLogger);
      }
      return { result, lines, logs, task, webdavPutFileVersioned, webdavConfirmUploadedFile };
    };
    const conflict = async (): Promise<undefined> => {
      throw new WebDavRemoteWriteConflictError(412);
    };

    it('falls back once to the checked byte PUT and records it', async () => {
      const { result, lines, task, webdavPutFileVersioned } = await run(async () => undefined);

      expect(task.uploadAsync).toHaveBeenCalledTimes(1);
      expect(webdavPutFileVersioned).toHaveBeenCalledTimes(1);
      expect(webdavPutFileVersioned).toHaveBeenCalledWith(
        `${BASE_URL}/attachments/att-1.txt`,
        expect.any(ArrayBuffer),
        expect.any(String),
        null,
        expect.objectContaining({ username: 'user' }),
      );
      expect(attachmentOf(result)?.cloudKey).toBe('attachments/att-1.txt');
      expect(lines).toContainEqual(expect.objectContaining({
        message: 'WebDAV streamed upload unproven after a redirected HEAD; sending it through the checked PUT',
        extra: { id: 'att-1', releaseCheck: 'v1.3.4/streamed-upload-head-fallback' },
      }));
    });

    it('records a 412 from that create-only PUT once a HEAD at the same URL finds the file', async () => {
      const { result, webdavPutFileVersioned, webdavConfirmUploadedFile } = await run(
        conflict,
        { confirmed: true, redirected: false, status: 200 },
      );

      expect(webdavPutFileVersioned).toHaveBeenCalledTimes(1);
      expect(webdavConfirmUploadedFile).toHaveBeenCalledTimes(2);
      expect(webdavConfirmUploadedFile).toHaveBeenLastCalledWith(
        `${BASE_URL}/attachments/att-1.txt`,
        LOCAL.byteLength,
        expect.objectContaining({ username: 'user' }),
      );
      expect(attachmentOf(result)?.cloudKey).toBe('attachments/att-1.txt');
    });

    it.each([
      ['the HEAD is redirected again', redirectedHead],
      ['the HEAD finds another size (another writer created it)', { confirmed: false, redirected: false, status: 200 }],
      ['the HEAD finds no file', { confirmed: false, redirected: false, status: 404 }],
    ])('keeps a 412 unsynced for a retry when %s', async (_case, proof) => {
      // A 412 proves only that some file exists there, not that it holds these bytes.
      const { result, lines, logs } = await run(conflict, proof);

      expect(attachmentOf(result)?.cloudKey).toBeUndefined();
      expect(lines).toContainEqual(expect.objectContaining({
        message: 'Failed to upload attachment att-1',
        extra: { error: 'fetch failed: unexpected redirect' },
      }));
      expect(logs).toContainEqual(expect.objectContaining({
        level: 'warn',
        context: { releaseCheck: 'v1.3.4/fetch-redirect-refused-upload', method: 'PUT', status: proof.status },
      }));
    });

    it('fails the upload only when the byte PUT is refused', async () => {
      const { result, lines } = await run(async () => {
        throw new TypeError('fetch failed: unexpected redirect');
      });

      expect(attachmentOf(result)?.cloudKey).toBeUndefined();
      expect(lines).toContainEqual(expect.objectContaining({
        message: 'Failed to upload attachment att-1',
        extra: { error: 'fetch failed: unexpected redirect' },
      }));
    });
  });

  it.each([
    ['missing local', undefined], ['missing local', 404], ['missing local', 429],
    ['remote winner', undefined], ['remote winner', 404], ['remote winner', 429],
  ] as const)('aborts a host cap for %s without treating status %s as absence/backoff', async (target, status) => {
    const error = Object.assign(new TypeError('Response exceeds the 8 byte download limit'), {
      code: 'response-too-large', limitBytes: 8, status,
    });
    const webdavGetFile = vi.fn(async (): Promise<ArrayBuffer> => { throw error; });
    const { backends, memory, files, common, installer, lines } = setup({
      core: { webdavFileExists: async () => true, webdavGetFile },
    });
    if (target === 'remote winner') memory.put(LOCAL_URI, LOCAL);
    const input = withAttachment(fileAttachment({
      cloudKey: 'attachments/att-1.txt', fileHash: (await computeSha256Hex(REMOTE))!,
      contentMtimeMs: 1, contentSize: 1,
    }));
    const before = structuredClone(input);
    const open = vi.spyOn(common, 'openAttachmentBytesFromDownload');
    const install = vi.spyOn(common, 'installAttachmentDownloadBytes');
    const backoff = vi.spyOn(files, 'setWebdavDownloadBackoff');

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL, undefined, {
      phase: 'post-merge',
    })).rejects.toBe(error);

    expect(webdavGetFile).toHaveBeenCalledTimes(1);
    expect(input).toEqual(before);
    if (target === 'remote winner') expect(memory.read(LOCAL_URI)).toEqual(LOCAL);
    else expect(memory.files.has(LOCAL_URI)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(installer.installAttachmentFileGeneration).not.toHaveBeenCalled();
    expect(backoff).not.toHaveBeenCalled();
    expect(memory.calls.filter((call) => /^(writeBytes|copy|move|delete) /.test(call))).toEqual([]);
    expect(lines.filter((line) => line.extra?.releaseCheck === 'v1.3.5/webdav-host-download-limit')).toEqual([{
      level: 'warn', message: 'WebDAV host download limit refused',
      extra: { releaseCheck: 'v1.3.5/webdav-host-download-limit', operation: 'download', outcome: 'refused' },
    }]);
  });

  it('keeps ordinary RN reader oversize on the existing recoverable download path', async () => {
    const error = new ResponseTooLargeError(8);
    const { backends, files, lines } = setup({
      core: { webdavGetFile: async () => { throw error; } },
    });
    const backoff = vi.spyOn(files, 'setWebdavDownloadBackoff');
    const input = withAttachment(fileAttachment({ cloudKey: 'attachments/att-1.txt', localStatus: 'missing' }));
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL)).resolves.toBe(false);

    expect(input).toEqual(before);
    expect(backoff).toHaveBeenCalledWith('att-1', error);
    expect(lines.some((line) => line.extra?.releaseCheck === 'v1.3.5/webdav-host-download-limit')).toBe(false);
  });

  it.each(['MKCOL', 'upload HEAD', 'PUT'] as const)('does not swallow a capped %s reply inside upload handling', async (method) => {
    const error = Object.assign(new TypeError('network timeout'), { code: 'response-too-large', limitBytes: 8, status: 429 });
    const webdavMakeDirectory = vi.fn(async () => { if (method === 'MKCOL') throw error; });
    const webdavHeadFile = vi.fn(async () => {
      if (method === 'upload HEAD') throw error;
      return { exists: false, fingerprint: null, etag: null, lastModified: null, contentLength: null };
    });
    const webdavPutFileVersioned = vi.fn(async () => { throw error; });
    const { backends, memory } = setup({ core: { webdavMakeDirectory, webdavHeadFile, webdavPutFileVersioned } });
    memory.put(LOCAL_URI, LOCAL);
    const input = withAttachment(fileAttachment());
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL)).rejects.toBe(error);

    expect(input).toEqual(before);
    expect(memory.read(LOCAL_URI)).toEqual(LOCAL);
    expect(webdavPutFileVersioned).toHaveBeenCalledTimes(method === 'PUT' ? 1 : 0);
  });

  it('drops accumulated presence patches when a later probe hits the host cap', async () => {
    const error = Object.assign(new TypeError('refused'), { code: 'response-too-large', limitBytes: 8 });
    const probe = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(error);
    const { backends, memory } = setup({ core: { webdavFileExists: probe } });
    memory.put(LOCAL_URI, LOCAL);
    memory.put(`${MANAGED}att-2.txt`, LOCAL);
    const input = withAttachment(fileAttachment({ cloudKey: 'attachments/att-1.txt' }));
    input.tasks[0].attachments!.push(fileAttachment({ id: 'att-2', uri: `${MANAGED}att-2.txt`, cloudKey: 'attachments/att-2.txt' }));
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL)).rejects.toBe(error);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(input).toEqual(before);
    expect(memory.read(LOCAL_URI)).toEqual(LOCAL);
    expect(memory.read(`${MANAGED}att-2.txt`)).toEqual(LOCAL);
  });

  it('does not use the streamed 412 fallback after a coded PUT response cap', async () => {
    const error = Object.assign(new TypeError('refused'), { code: 'response-too-large', limitBytes: 8, status: 412 });
    const confirm = vi.fn(async () => ({ confirmed: false, redirected: true, status: 200 }));
    const { backends, memory } = setup({
      createUploadTask: () => ({ uploadAsync: async () => ({ status: 201 }), cancelAsync: async () => undefined }),
      core: {
        webdavMakeDirectory: async () => undefined,
        webdavHeadFile: async () => ({ exists: false, fingerprint: null, etag: null, lastModified: null, contentLength: null }),
        webdavConfirmUploadedFile: confirm,
        webdavPutFileVersioned: async () => { throw error; },
      },
    });
    memory.put(LOCAL_URI, LOCAL);
    const input = withAttachment(fileAttachment());
    const before = structuredClone(input);

    await expect(backends.syncWebdavAttachments(input, webdavConfig, BASE_URL)).rejects.toBe(error);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(input).toEqual(before);
    expect(memory.read(LOCAL_URI)).toEqual(LOCAL);
  });

  it('marks the attachment unrecoverable when the remote answers 404', async () => {
    const { backends } = setup({
      core: { webdavGetFile: vi.fn(async () => { throw httpError(404); }) },
    });

    const result = await backends.syncWebdavAttachments(
      withAttachment(fileAttachment({ cloudKey: 'attachments/att-1.txt', localStatus: 'missing' })),
      webdavConfig,
      BASE_URL,
    );

    const attachment = attachmentOf(result);
    expect(attachment?.cloudKey).toBeUndefined();
    expect(attachment?.localStatus).toBe('missing');
    expect(attachment?.deletedAt).toBeTruthy();
  });

  it('keeps the local bytes when a remote-winner download fails', async () => {
    const webdavGetFile = vi.fn(async (): Promise<ArrayBuffer> => { throw httpError(500); });
    const { backends, memory } = setup({
      core: { webdavFileExists: vi.fn(async () => true), webdavGetFile },
    });
    memory.put(LOCAL_URI, LOCAL);
    const attachment = fileAttachment({
      cloudKey: 'attachments/att-1.txt',
      fileHash: (await computeSha256Hex(REMOTE))!,
      contentMtimeMs: 1,
      contentSize: 1,
    });

    await backends.syncWebdavAttachments(withAttachment(attachment), webdavConfig, BASE_URL, undefined, {
      phase: 'post-merge',
    });

    expect(webdavGetFile).toHaveBeenCalledTimes(1);
    expect(memory.read(LOCAL_URI)).toEqual(LOCAL);
    expect(memory.calls.filter((call) => call.startsWith('delete') && call.includes('att-1.txt'))).toEqual([]);
  });
});

describe('self-hosted cloud attachment pass', () => {
  const cloudConfig = { url: 'https://cloud.example.com/v1/data', token: 'secret' };

  it('sends every upload through the checked byte PUT, never the native uploader', async () => {
    // The native uploader follows a redirect by itself (a 303 to /health answers the same
    // {"ok":true}), and servers before 1.2.7 have no HEAD to prove where the file landed.
    const task = { uploadAsync: vi.fn(async () => ({ status: 200, body: '{"ok":true}' })), cancelAsync: vi.fn(async () => undefined) };
    const createUploadTask = vi.fn(() => task);
    const cloudPutFile = vi.fn(async () => undefined);
    const { backends, memory } = setup({ createUploadTask, core: { cloudPutFile } });
    memory.put(LOCAL_URI, LOCAL);

    const result = await backends.syncCloudAttachments(withAttachment(fileAttachment()), cloudConfig, BASE_URL, { phase: 'post-merge' });

    expect(createUploadTask).not.toHaveBeenCalled();
    expect(cloudPutFile).toHaveBeenCalledWith(
      `${BASE_URL}/attachments/att-1.txt`,
      expect.any(ArrayBuffer),
      'application/octet-stream',
      expect.objectContaining({ token: 'secret' }),
    );
    expect(attachmentOf(result)?.cloudKey).toBe('attachments/att-1.txt');
  });

  it('clears pendingContentUpload only after the edited bytes are on the server', async () => {
    const cloudPutFile = vi.fn(async () => { throw httpError(500); });
    const { backends, memory } = setup({ core: { cloudPutFile, cloudAttachmentExists: vi.fn(async () => true) } });
    memory.put(LOCAL_URI, LOCAL);
    const data = withAttachment(fileAttachment({
      cloudKey: 'attachments/att-1.txt',
      fileHash: (await computeSha256Hex(LOCAL))!,
      pendingContentUpload: true,
    }));

    const failed = await backends.syncCloudAttachments(data, cloudConfig, BASE_URL, { phase: 'post-merge' });
    expect(cloudPutFile).toHaveBeenCalledTimes(1);
    expect(attachmentOf(failed === false ? data : failed)?.pendingContentUpload).toBe(true);

    cloudPutFile.mockImplementation(async () => undefined);
    const uploaded = await backends.syncCloudAttachments(data, cloudConfig, BASE_URL, { phase: 'post-merge' });

    expect(cloudPutFile).toHaveBeenLastCalledWith(
      `${BASE_URL}/attachments/att-1.txt`,
      expect.any(ArrayBuffer),
      'application/octet-stream',
      expect.objectContaining({ token: 'secret' }),
    );
    expect(attachmentOf(uploaded)).toMatchObject({ cloudKey: 'attachments/att-1.txt', pendingContentUpload: undefined });
  });

  it('keeps a pending replacement untouched while its local bytes are missing', async () => {
    const cloudGetFile = vi.fn(async () => toArrayBuffer(REMOTE));
    const cloudPutFile = vi.fn(async () => undefined);
    const { backends } = setup({ core: { cloudGetFile, cloudPutFile } });
    const data = withAttachment(fileAttachment({ cloudKey: 'attachments/att-1.txt', pendingContentUpload: true }));

    const result = await backends.syncCloudAttachments(data, cloudConfig, BASE_URL, { phase: 'post-merge' });

    expect(result).toBe(false);
    expect(cloudGetFile).not.toHaveBeenCalled();
    expect(cloudPutFile).not.toHaveBeenCalled();
  });
});

describe('Dropbox attachment pass', () => {
  const resolveAccessToken = async () => 'token';

  it('uploads against the current revision before recording the cloud key', async () => {
    const uploadDropboxFileVersioned = vi.fn(async () => ({ rev: 'rev-2' }));
    const { backends, memory } = setup({
      core: {
        getDropboxFileMetadata: vi.fn(async () => ({ rev: 'rev-1' })),
        uploadDropboxFileVersioned,
      },
    });
    memory.put(LOCAL_URI, LOCAL);

    const result = await backends.syncDropboxAttachments(
      withAttachment(fileAttachment()),
      'app-key',
      vi.fn() as unknown as typeof fetch,
      { resolveAccessToken },
    );

    expect(uploadDropboxFileVersioned).toHaveBeenCalledWith(
      'token',
      'attachments/att-1.txt',
      expect.any(ArrayBuffer),
      'rev-1',
      expect.any(Function),
      expect.anything(),
    );
    expect(attachmentOf(result)?.cloudKey).toBe('attachments/att-1.txt');
  });

  it('rethrows a revision conflict and records nothing', async () => {
    const { backends, memory } = setup({
      core: {
        getDropboxFileMetadata: vi.fn(async () => ({ rev: 'rev-1' })),
        uploadDropboxFileVersioned: vi.fn(async () => { throw new DropboxConflictError(); }),
      },
    });
    memory.put(LOCAL_URI, LOCAL);

    await expect(backends.syncDropboxAttachments(
      withAttachment(fileAttachment()),
      'app-key',
      vi.fn() as unknown as typeof fetch,
      { resolveAccessToken },
    )).rejects.toBeInstanceOf(DropboxConflictError);
  });

  it('marks a missing remote file unrecoverable but only flags other download failures', async () => {
    const downloadDropboxFile = vi.fn(async (): Promise<ArrayBuffer> => { throw new DropboxFileNotFoundError(); });
    const { backends } = setup({ core: { downloadDropboxFile } });
    const data = withAttachment(fileAttachment({ cloudKey: 'attachments/att-1.txt', localStatus: 'available' }));
    const fetcher = vi.fn() as unknown as typeof fetch;

    const missing = attachmentOf(await backends.syncDropboxAttachments(data, 'app-key', fetcher, { resolveAccessToken }));
    expect(missing).toMatchObject({ cloudKey: undefined, localStatus: 'missing' });
    expect(missing?.deletedAt).toBeTruthy();

    downloadDropboxFile.mockImplementation(async () => { throw httpError(500); });
    const failed = attachmentOf(await backends.syncDropboxAttachments(data, 'app-key', fetcher, { resolveAccessToken }));
    expect(failed).toMatchObject({ cloudKey: 'attachments/att-1.txt', localStatus: 'missing' });
    expect(failed?.deletedAt).toBeUndefined();
  });
});

describe('File Sync attachment pass', () => {
  const SYNC_DIR = 'file:///sdcard/Mindwtr/attachments/';

  it('publishes an immutable generation through the journaled installer, then records its key', async () => {
    const { backends, memory, installer, order } = setup();
    memory.put(LOCAL_URI, LOCAL);
    const cloudKey = buildFileSyncGenerationCloudKey(fileAttachment(), (await computeSha256Hex(LOCAL))!);
    const target = `${SYNC_DIR}${cloudKey.split('/').pop()}`;

    const result = await backends.syncFileAttachments(withAttachment(fileAttachment()), 'file:///sdcard/Mindwtr/data.json');

    expect(installer.recoverFileSyncAttachmentPublications).toHaveBeenCalledWith(SYNC_DIR);
    expect(order).toEqual(['reserve', 'claim', 'publish', 'complete']);
    expect(memory.read(target)).toEqual(LOCAL);
    expect(memory.read(`${target}.stage`)).toBeUndefined();
    expect(attachmentOf(result)?.cloudKey).toBe(cloudKey);
  });

  it('keeps a key the folder does not hold yet during activation and logs the proof line', async () => {
    const { backends, lines } = setup();
    const data = withAttachment(fileAttachment({ cloudKey: 'attachments/att-1.txt', localStatus: 'missing' }));

    const result = await backends.syncFileAttachments(data, 'file:///sdcard/Mindwtr/data.json', undefined, {
      activationProbe: true,
    });

    expect(attachmentOf(result === false ? data : result)?.cloudKey).toBe('attachments/att-1.txt');
    expect(lines).toContainEqual({
      level: 'warn',
      message: 'File Sync activation left an attachment the folder does not hold yet',
      extra: { releaseCheck: 'v1.3.0/mobile-file-activation-absent-blob' },
    });
  });

  describe('in a Storage Access Framework folder', () => {
    const TREE = 'content://com.example.docs/tree/primary%3AMindwtr';
    const FOLDER = `${TREE}/document/primary%3AMindwtr`;
    const ATTACHMENTS = `${FOLDER}%2Fattachments`;

    const createSaf = (put: (uri: string, bytes: Uint8Array) => void, writable: boolean) => {
      const entries: string[] = [];
      const saf: MobileAttachmentSafPort = {
        readDirectory: async (uri) => (uri === FOLDER ? [ATTACHMENTS] : uri === ATTACHMENTS ? [...entries] : []),
        makeDirectory: async () => ATTACHMENTS,
      };
      if (writable) {
        saf.createFile = vi.fn(async (parentUri: string, name: string) => {
          const uri = `${parentUri}%2F${name}`;
          entries.push(uri);
          return uri;
        });
        saf.writeBytes = vi.fn(async (uri: string, bytes: Uint8Array) => put(uri, bytes));
      }
      return saf;
    };

    it('creates and writes the generation through the SAF port', async () => {
      let put: (uri: string, bytes: Uint8Array) => void = () => undefined;
      const saf = createSaf((uri, bytes) => put(uri, bytes), true);
      const { backends, memory } = setup({ saf });
      put = memory.put;
      memory.put(LOCAL_URI, LOCAL);
      const cloudKey = buildFileSyncGenerationCloudKey(fileAttachment(), (await computeSha256Hex(LOCAL))!);
      const filename = cloudKey.split('/').pop()!;

      const result = await backends.syncFileAttachments(withAttachment(fileAttachment()), TREE);

      expect(saf.createFile).toHaveBeenCalledWith(ATTACHMENTS, filename, 'application/octet-stream');
      expect(memory.read(`${ATTACHMENTS}%2F${filename}`)).toEqual(LOCAL);
      expect(attachmentOf(result)?.cloudKey).toBe(cloudKey);
    });

    it('refuses the upload and records no key when the host cannot write SAF folders', async () => {
      const { backends, memory, lines } = setup({ saf: createSaf(() => undefined, false) });
      memory.put(LOCAL_URI, LOCAL);

      const result = await backends.syncFileAttachments(withAttachment(fileAttachment()), TREE);

      expect(attachmentOf(result)?.cloudKey).toBeUndefined();
      expect(lines).toContainEqual(expect.objectContaining({
        message: 'Failed to copy attachment att-1 to sync folder',
        extra: { error: 'SAF attachment writes are unavailable' },
      }));
    });
  });
});
