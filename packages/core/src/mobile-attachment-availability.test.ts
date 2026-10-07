import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from './types';
import { computeSha256Hex } from './attachment-hash';
import { createMobileAttachmentFiles } from './mobile-attachment-files';
import { createMobileAttachmentCommon, type MobileAttachmentCommonHost } from './mobile-attachment-common';
import { createMobileAttachmentAvailability, type MobileAttachmentAvailabilityCoreFunctions, type MobileAttachmentCloudKitPort } from './mobile-attachment-availability';
import { defaultSyncCryptoPrimitives, SYNC_CRYPTO_DEFAULT_KDF_PARAMS, type SyncKeyMaterial } from './sync-crypto';
import { globalProgressTracker } from './attachment-progress';
import { CLOUD_PROVIDER_KEY, CLOUD_URL_KEY, SYNC_BACKEND_KEY, SYNC_PATH_KEY, WEBDAV_PASSWORD_KEY, WEBDAV_URL_KEY, WEBDAV_USERNAME_KEY } from './sync-storage-keys';
import { DropboxFileNotFoundError } from './dropbox';
import { createMemoryFileSystem, createMemoryStorage, createRecordingLog, MANAGED } from './__fixtures__/mobile-attachment-fakes';

const now = '2026-09-28T00:00:00.000Z';
const REMOTE = new Uint8Array([9, 8, 7, 6]);
const toArrayBuffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;

const remoteAttachment = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: 'att-1',
  kind: 'file',
  title: 'att-1.txt',
  uri: '',
  cloudKey: 'attachments/att-1.txt',
  localStatus: 'missing',
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const setup = (options: {
  storage?: Record<string, string>;
  sandbox?: boolean;
  cloudKit?: MobileAttachmentCloudKitPort;
  preparePlaintextDownload?: MobileAttachmentCommonHost['preparePlaintextDownload'];
  material?: SyncKeyMaterial;
} = {}) => {
  const memory = createMemoryFileSystem();
  const { storage, values } = createMemoryStorage(options.storage);
  const { log, lines } = createRecordingLog();
  const secrets: Record<string, string> = { [WEBDAV_PASSWORD_KEY]: 'pw' };
  const files = createMobileAttachmentFiles({
    fs: memory.fs,
    storage,
    getSecureConfigValue: async (key) => secrets[key] ?? null,
    log,
    fetch: vi.fn() as unknown as typeof fetch,
    dropboxAuth: { getValidAccessToken: async () => 'token', forceRefreshAccessToken: async () => 'token' },
    core: { isSandboxMode: () => options.sandbox === true },
  });
  const installAttachmentFileGeneration = vi.fn(async (stagedPath: string, targetPath: string) => {
    await memory.fs.move(stagedPath, targetPath);
    return { status: 'installed' as const };
  });
  const common = createMobileAttachmentCommon({
    fs: memory.fs,
    files,
    crypto: defaultSyncCryptoPrimitives,
    encryption: { logSyncEncryptionEvent: async () => undefined },
    installer: { installAttachmentFileGeneration },
    installerMayBeMissing: () => false,
    timersPaused: () => false,
    uploads: { createUploadTask: () => null },
    preparePlaintextDownload: options.preparePlaintextDownload,
  });
  const webdavGetFile = vi.fn<MobileAttachmentAvailabilityCoreFunctions['webdavGetFile']>(async () => toArrayBuffer(REMOTE));
  const cloudGetFile = vi.fn(async () => toArrayBuffer(REMOTE));
  const downloadDropboxFile = vi.fn(async () => toArrayBuffer(REMOTE));
  const availability = createMobileAttachmentAvailability({
    files,
    common,
    storage,
    encryption: { getSyncEncryptionMaterial: async () => options.material ?? null },
    getDropboxClientId: async () => 'app-key',
    cloudKit: options.cloudKit,
    core: {
      isSandboxMode: () => options.sandbox === true,
      withRetry: (operation) => operation(),
      webdavGetFile,
      cloudGetFile,
      downloadDropboxFile,
    },
  });
  return { availability, common, files, storage, values, memory, lines, installAttachmentFileGeneration, webdavGetFile, cloudGetFile, downloadDropboxFile };
};

const webdav = {
  [SYNC_BACKEND_KEY]: 'webdav',
  [WEBDAV_URL_KEY]: 'https://dav.example/Mindwtr/data.json',
  [WEBDAV_USERNAME_KEY]: 'me',
};

const deletesOutsideScratch = (calls: string[]) => calls.filter((call) => (
  call.startsWith('delete ') && !call.includes('.mindwtr-download-')
));

const SOURCE_TOKEN = '27bc6994-c737-48ea-8e69-8c2f963858c5';
const SECOND_SOURCE_TOKEN = 'ab20c8d8-d42c-4f71-9a16-2d43bc6b51a6';
const sourceReply = () => ({ kind: 'prepared-source' as const, sourceToken: SOURCE_TOKEN });
const mutations = (calls: string[]) => calls.filter((call) => /^(makeDirectory|writeBytes|copy|move|delete) /.test(call));

describe('mobile attachment availability: private WebDAV preparation', () => {
  it('omits the selected method without an adapter', () => {
    expect(setup({ storage: webdav }).availability).not.toHaveProperty('prepareAttachmentAvailableDetailed');
  });

  it('returns only a prepared candidate with no file/config mutation or completed progress', async () => {
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, files, values, memory, webdavGetFile, installAttachmentFileGeneration } = setup({ storage: webdav, preparePlaintextDownload });
    const requested = Object.freeze(remoteAttachment({ title: 'Renamed title.txt', mimeType: 'text/plain', contentRev: 3, pendingContentUpload: false }));
    const before = { ...requested };
    const configBefore = [...values.entries()];
    const ensureLocal = vi.spyOn(files, 'ensureAttachmentStoredLocally');
    const statuses: string[] = [];
    globalProgressTracker.clear(requested.id);
    const unsubscribe = globalProgressTracker.subscribe(requested.id, (progress) => statuses.push(progress.status));
    webdavGetFile.mockImplementationOnce(async (_url, options) => {
      options.onProgress?.(REMOTE.length, REMOTE.length);
      return toArrayBuffer(REMOTE);
    });
    try {
      const outcome = await availability.prepareAttachmentAvailableDetailed!(requested);

      expect(outcome).toEqual({
        status: 'prepared', sourceToken: SOURCE_TOKEN, sha256: await computeSha256Hex(REMOTE), size: REMOTE.length,
        attachment: { ...requested, uri: `${MANAGED}att-1.txt`, localStatus: 'available', fileHash: await computeSha256Hex(REMOTE) },
      });
      expect(requested).toEqual(before);
      expect([...values.entries()]).toEqual(configBefore);
      expect(memory.files.size).toBe(0);
      expect(mutations(memory.calls)).toEqual([]);
      expect(ensureLocal).not.toHaveBeenCalled();
      expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
      expect(statuses).toEqual(['active']);
      expect(preparePlaintextDownload).toHaveBeenCalledWith(expect.objectContaining({
        attachmentId: requested.id, targetURI: `${MANAGED}att-1.txt`, expectation: { kind: 'absent' },
      }), REMOTE, undefined);
    } finally {
      unsubscribe();
      globalProgressTracker.clear(requested.id);
    }
  });

  it.each([
    ['Off', { storage: { ...webdav, [SYNC_BACKEND_KEY]: 'off' } }, {}],
    ['absent backend', { storage: { [WEBDAV_URL_KEY]: webdav[WEBDAV_URL_KEY] } }, {}],
    ['File Sync', { storage: { ...webdav, [SYNC_BACKEND_KEY]: 'file' } }, {}],
    ['CloudKit', { storage: { ...webdav, [SYNC_BACKEND_KEY]: 'cloudkit' } }, {}],
    ['cloud', { storage: { ...webdav, [SYNC_BACKEND_KEY]: 'cloud' } }, {}],
    ['sandbox', { storage: webdav, sandbox: true }, {}],
    ['non-file', { storage: webdav }, { kind: 'link' as const }],
    ['terminal attachment', { storage: webdav }, { deletedAt: now }],
  ])('refuses %s before any local/provider/source action', async (_name, options, overrides) => {
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, memory, files, webdavGetFile, cloudGetFile, downloadDropboxFile, installAttachmentFileGeneration } = setup({ ...options, preparePlaintextDownload });
    const repair = vi.spyOn(files, 'ensureAttachmentStoredLocally');
    const config = vi.spyOn(files, 'loadWebDavConfig');

    await expect(availability.prepareAttachmentAvailableDetailed!(remoteAttachment({ uri: `${MANAGED}att-1.txt`, ...overrides })))
      .resolves.toEqual({ status: 'unavailable' });
    expect(memory.calls).toEqual([]);
    expect(repair).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(webdavGetFile).not.toHaveBeenCalled();
    expect(cloudGetFile).not.toHaveBeenCalled();
    expect(downloadDropboxFile).not.toHaveBeenCalled();
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
    expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
  });

  it.each(['', `${MANAGED}att-1.txt`])('borrows only matching present bytes (%s) without copying or creating a directory', async (uri) => {
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, memory, files, webdavGetFile } = setup({ storage: webdav, preparePlaintextDownload });
    memory.put(`${MANAGED}att-1.txt`, REMOTE);
    const repair = vi.spyOn(files, 'ensureAttachmentStoredLocally');

    await expect(availability.prepareAttachmentAvailableDetailed!(remoteAttachment({ uri, fileHash: await computeSha256Hex(REMOTE) })))
      .resolves.toMatchObject({ status: 'available', attachment: { uri: `${MANAGED}att-1.txt` } });
    await expect(availability.prepareAttachmentAvailableDetailed!(remoteAttachment({ uri })))
      .resolves.toEqual({ status: 'generation-conflict' });
    await expect(availability.prepareAttachmentAvailableDetailed!(remoteAttachment({ uri, fileHash: 'a'.repeat(64) })))
      .resolves.toEqual({ status: 'generation-conflict' });
    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(REMOTE);
    expect(mutations(memory.calls)).toEqual([]);
    expect(repair).not.toHaveBeenCalled();
    expect(webdavGetFile).not.toHaveBeenCalled();
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
  });

  it.each(['matching', 'hashless', 'mismatch', 'missing'] as const)('prepares a cloudKeyless local selection only with matching present bytes (%s)', async (mode) => {
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, memory, files, webdavGetFile, installAttachmentFileGeneration } = setup({ storage: webdav, preparePlaintextDownload });
    const uri = `${MANAGED}att-1.txt`;
    if (mode !== 'missing') memory.put(uri, REMOTE);
    const requested = Object.freeze(remoteAttachment({
      uri, cloudKey: undefined, pendingContentUpload: false,
      fileHash: mode === 'hashless' ? undefined : mode === 'mismatch' ? 'a'.repeat(64) : await computeSha256Hex(REMOTE),
    }));
    const repair = vi.spyOn(files, 'ensureAttachmentStoredLocally');
    const config = vi.spyOn(files, 'loadWebDavConfig');

    await expect(availability.prepareAttachmentAvailableDetailed!(requested)).resolves.toEqual(
      mode === 'matching' ? { status: 'available', attachment: { ...requested, localStatus: 'available' } }
        : { status: mode === 'missing' ? 'unavailable' : 'generation-conflict' },
    );
    expect(mutations(memory.calls)).toEqual([]);
    expect(memory.read(uri)).toEqual(mode === 'missing' ? undefined : REMOTE);
    expect(repair).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(webdavGetFile).not.toHaveBeenCalled();
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
    expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
  });

  it('keeps terminal404 policy without a source and leaves the original metadata/bytes intact', async () => {
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, memory, webdavGetFile } = setup({ storage: webdav, preparePlaintextDownload });
    const requested = remoteAttachment({ fileHash: 'a'.repeat(64) });
    const before = { ...requested };
    memory.put(`${MANAGED}unrelated.txt`, REMOTE);
    webdavGetFile.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));

    const outcome = await availability.prepareAttachmentAvailableDetailed!(requested);

    expect(outcome).toMatchObject({ status: 'unrecoverable', attachment: { cloudKey: undefined, fileHash: undefined, deletedAt: expect.any(String) } });
    expect(requested).toEqual(before);
    expect(memory.read(`${MANAGED}unrelated.txt`)).toEqual(REMOTE);
    expect(mutations(memory.calls)).toEqual([]);
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
    if (outcome.status !== 'unrecoverable') throw new Error('Expected terminal outcome');
    await expect(availability.prepareAttachmentAvailableDetailed!(outcome.attachment)).resolves.toEqual({ status: 'unavailable' });
    expect(webdavGetFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a plaintext hash mismatch before preparing a source', async () => {
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, memory, installAttachmentFileGeneration } = setup({ storage: webdav, preparePlaintextDownload });

    await expect(availability.prepareAttachmentAvailableDetailed!(remoteAttachment({ fileHash: 'a'.repeat(64) })))
      .resolves.toEqual({ status: 'unavailable' });
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
    expect(mutations(memory.calls)).toEqual([]);
    expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
  });

  it('decrypts before the single plaintext hash/source handoff', async () => {
    const material: SyncKeyMaterial = { key: new Uint8Array(32).fill(7), salt: new Uint8Array(16).fill(1), params: SYNC_CRYPTO_DEFAULT_KDF_PARAMS };
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, common, memory, webdavGetFile } = setup({ storage: webdav, material, preparePlaintextDownload });
    const sealed = await common.sealAttachmentBytesForUpload(REMOTE, material);
    webdavGetFile.mockResolvedValueOnce(toArrayBuffer(sealed));
    const hash = (await computeSha256Hex(REMOTE))!;

    await expect(availability.prepareAttachmentAvailableDetailed!(remoteAttachment({ fileHash: hash })))
      .resolves.toMatchObject({ status: 'prepared', sha256: hash, size: REMOTE.length });
    expect(preparePlaintextDownload).toHaveBeenCalledOnce();
    expect(preparePlaintextDownload.mock.calls[0]?.[1]).toEqual(REMOTE);
    expect(sealed).not.toEqual(REMOTE);
    expect(mutations(memory.calls)).toEqual([]);
  });

  it('never prepares ciphertext when the encrypted location is locked', async () => {
    const material: SyncKeyMaterial = { key: new Uint8Array(32).fill(7), salt: new Uint8Array(16).fill(1), params: SYNC_CRYPTO_DEFAULT_KDF_PARAMS };
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, common, memory, webdavGetFile } = setup({ storage: webdav, preparePlaintextDownload });
    const sealed = await common.sealAttachmentBytesForUpload(REMOTE, material);
    webdavGetFile.mockResolvedValueOnce(toArrayBuffer(sealed));

    await expect(availability.prepareAttachmentAvailableDetailed!(remoteAttachment())).resolves.toEqual({ status: 'unavailable' });
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
    expect(mutations(memory.calls)).toEqual([]);
  });

  it.each(['malformed', 'rejected'])('keeps a %s adapter retryable without falling back to install', async (failure) => {
    const preparePlaintextDownload: NonNullable<MobileAttachmentCommonHost['preparePlaintextDownload']> = async () => {
      if (failure === 'rejected') throw new Error('Source refused');
      return { kind: 'installed', sourceToken: SOURCE_TOKEN } as never;
    };
    const { availability, memory, installAttachmentFileGeneration } = setup({ storage: webdav, preparePlaintextDownload });

    await expect(availability.prepareAttachmentAvailableDetailed!(remoteAttachment())).resolves.toEqual({ status: 'unavailable' });
    expect(mutations(memory.calls)).toEqual([]);
    expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
  });

  it('does not coalesce selected source tokens across concurrent invocations', async () => {
    const firstSignal = new AbortController().signal;
    const secondSignal = new AbortController().signal;
    const preparePlaintextDownload = vi.fn<NonNullable<MobileAttachmentCommonHost['preparePlaintextDownload']>>(async (_input, _bytes, signal) => ({
      kind: 'prepared-source' as const, sourceToken: signal === firstSignal ? SOURCE_TOKEN : SECOND_SOURCE_TOKEN,
    }));
    const { availability, memory, webdavGetFile } = setup({ storage: webdav, preparePlaintextDownload });
    const requested = remoteAttachment();
    let releaseFirst!: (bytes: ArrayBuffer) => void;
    const firstDownload = new Promise<ArrayBuffer>((resolve) => { releaseFirst = resolve; });
    webdavGetFile.mockImplementation(async (_url, options) => (
      options.signal === firstSignal ? firstDownload : toArrayBuffer(REMOTE)
    ));
    let firstSettled = false;
    const first = availability.prepareAttachmentAvailableDetailed!(requested, firstSignal).then((outcome) => {
      firstSettled = true;
      return outcome;
    });
    let secondSettled = false;
    const second = availability.prepareAttachmentAvailableDetailed!({ ...requested }, secondSignal).then((outcome) => {
      secondSettled = true;
      return outcome;
    });

    try {
      await vi.waitFor(() => expect(webdavGetFile).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(secondSettled).toBe(true));
      // Adapter arrival order is independent of invocation order (including awaited hashes).
      await expect(second).resolves.toMatchObject({ status: 'prepared', sourceToken: SECOND_SOURCE_TOKEN });
      expect(firstSettled).toBe(false);
      expect(preparePlaintextDownload).toHaveBeenCalledTimes(1);
      expect(preparePlaintextDownload).toHaveBeenNthCalledWith(1,
        expect.objectContaining({ attachmentId: requested.id }), REMOTE, secondSignal);
    } finally {
      releaseFirst(toArrayBuffer(REMOTE));
      await Promise.all([first, second]);
    }
    const outcomes = await Promise.all([first, second]);

    expect(outcomes.map((outcome) => outcome.status === 'prepared' ? outcome.sourceToken : null))
      .toEqual([SOURCE_TOKEN, SECOND_SOURCE_TOKEN]);
    expect(preparePlaintextDownload).toHaveBeenCalledTimes(2);
    expect(preparePlaintextDownload).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ attachmentId: requested.id }), REMOTE, firstSignal);
    expect(mutations(memory.calls)).toEqual([]);
  });

  it('keeps ordinary bound-adapter downloads installed/coalesced and Off fallback unchanged', async () => {
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, memory, webdavGetFile, installAttachmentFileGeneration } = setup({ storage: { ...webdav, [SYNC_BACKEND_KEY]: 'off' }, preparePlaintextDownload });
    const [first, second] = await Promise.all([
      availability.ensureAttachmentAvailableDetailed(remoteAttachment()),
      availability.ensureAttachmentAvailableDetailed(remoteAttachment()),
    ]);

    expect(first).toMatchObject({ status: 'available' });
    expect(second).toBe(first);
    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(REMOTE);
    expect(webdavGetFile).toHaveBeenCalledTimes(1);
    expect(installAttachmentFileGeneration).toHaveBeenCalledTimes(1);
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
  });

  it('checks post-fetch cancellation before decrypt/source handoff', async () => {
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, memory, webdavGetFile } = setup({ storage: webdav, preparePlaintextDownload });
    const controller = new AbortController();
    const reason = new Error('Canceled selected fetch');
    let release!: (bytes: ArrayBuffer) => void;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const reply = new Promise<ArrayBuffer>((resolve) => { release = resolve; });
    webdavGetFile.mockImplementationOnce(async (_url, options) => {
      expect(options.signal).toBe(controller.signal);
      reached();
      return reply;
    });
    const operation = availability.prepareAttachmentAvailableDetailed!(remoteAttachment(), controller.signal);
    await entered;
    controller.abort(reason);
    release(toArrayBuffer(REMOTE));

    await expect(operation).rejects.toBe(reason);
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
    expect(mutations(memory.calls)).toEqual([]);
    await expect(availability.prepareAttachmentAvailableDetailed!(remoteAttachment(), controller.signal)).rejects.toBe(reason);
    expect(webdavGetFile).toHaveBeenCalledTimes(1);
  });

  it('checks cancellation after the backend read before local/config/network work', async () => {
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, storage, files, memory, webdavGetFile } = setup({ storage: webdav, preparePlaintextDownload });
    const controller = new AbortController();
    const reason = new Error('Canceled selected config');
    vi.spyOn(storage, 'getItem').mockImplementationOnce(async () => {
      controller.abort(reason);
      return 'webdav';
    });
    const config = vi.spyOn(files, 'loadWebDavConfig');

    await expect(availability.prepareAttachmentAvailableDetailed!(remoteAttachment(), controller.signal)).rejects.toBe(reason);
    expect(config).not.toHaveBeenCalled();
    expect(memory.calls).toEqual([]);
    expect(webdavGetFile).not.toHaveBeenCalled();
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
  });

  it('keeps the invocation metadata captured before an awaited backend read', async () => {
    const preparePlaintextDownload = vi.fn(async () => sourceReply());
    const { availability, storage, webdavGetFile } = setup({ storage: webdav, preparePlaintextDownload });
    const requested = remoteAttachment({ title: 'Original title.txt', fileHash: (await computeSha256Hex(REMOTE))! });
    const captured = { ...requested };
    vi.spyOn(storage, 'getItem').mockImplementationOnce(async () => {
      Object.assign(requested, { cloudKey: 'attachments/later.txt', fileHash: 'a'.repeat(64), title: 'Later title.txt' });
      return 'webdav';
    });

    await expect(availability.prepareAttachmentAvailableDetailed!(requested)).resolves.toMatchObject({
      status: 'prepared', attachment: { ...captured, uri: `${MANAGED}att-1.txt`, localStatus: 'available' },
    });
    expect(webdavGetFile).toHaveBeenCalledWith('https://dav.example/Mindwtr/attachments/att-1.txt', expect.anything());
    expect(preparePlaintextDownload).toHaveBeenCalledOnce();
    // Current-owner freshness is separately checked by the future native353 lease.
    expect(requested.title).toBe('Later title.txt');
  });
});

describe('mobile attachment availability', () => {
  it('downloads a WebDAV attachment into <files>/attachments/ through the installer', async () => {
    const { availability, memory, webdavGetFile, installAttachmentFileGeneration } = setup({ storage: webdav });
    const requested = remoteAttachment({ fileHash: await computeSha256Hex(REMOTE) });

    const outcome = await availability.ensureAttachmentAvailableDetailed(requested);

    expect(outcome).toMatchObject({ status: 'available', attachment: { uri: `${MANAGED}att-1.txt`, localStatus: 'available' } });
    expect(webdavGetFile).toHaveBeenCalledWith(
      'https://dav.example/Mindwtr/attachments/att-1.txt',
      expect.objectContaining({ username: 'me', password: 'pw' }),
    );
    expect(installAttachmentFileGeneration.mock.calls[0]?.slice(1, 3)).toEqual([`${MANAGED}att-1.txt`, { kind: 'absent' }]);
    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(REMOTE);
  });

  it('rejects bytes that fail the recorded hash and writes nothing', async () => {
    const { availability, memory, installAttachmentFileGeneration } = setup({ storage: webdav });

    await expect(availability.ensureAttachmentAvailableDetailed(remoteAttachment({ fileHash: 'a'.repeat(64) })))
      .resolves.toEqual({ status: 'unavailable' });
    expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
    expect(memory.read(`${MANAGED}att-1.txt`)).toBeUndefined();
  });

  it('never deletes local bytes when a download fails', async () => {
    const { availability, memory, webdavGetFile } = setup({ storage: webdav });
    webdavGetFile.mockRejectedValueOnce(Object.assign(new Error('Server error'), { status: 500 }));

    await expect(availability.ensureAttachmentAvailableDetailed(remoteAttachment())).resolves.toEqual({ status: 'unavailable' });
    expect(deletesOutsideScratch(memory.calls)).toEqual([]);
  });

  it('treats a WebDAV 404 as terminal, as the sync pass does: no second request, no Download, local bytes kept', async () => {
    const { availability, memory, webdavGetFile, lines } = setup({ storage: webdav });
    webdavGetFile.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
    const requested = remoteAttachment({ fileHash: 'a'.repeat(64) });

    const outcome = await availability.ensureAttachmentAvailableDetailed(requested);

    expect(outcome).toMatchObject({
      status: 'unrecoverable',
      attachment: { cloudKey: undefined, fileHash: undefined, localStatus: 'missing', deletedAt: expect.any(String) },
    });
    expect(requested.cloudKey).toBe('attachments/att-1.txt');
    expect(deletesOutsideScratch(memory.calls)).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({
      level: 'warn', extra: expect.objectContaining({ releaseCheck: 'v1.3.4/webdav-download-not-found' }),
    }));
    if (outcome.status !== 'unrecoverable') throw new Error('Expected a terminal outcome');
    await expect(availability.ensureAttachmentAvailableDetailed(outcome.attachment)).resolves.toEqual({ status: 'unavailable' });
    expect(webdavGetFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['self-hosted cloud', { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_URL_KEY]: 'https://cloud.example/v1/data' }, 'cloudGetFile',
      Object.assign(new Error('Cloud File GET failed (404)'), { status: 404 }), 'Cloud attachment att-1 is no longer available', 'v1.3.4/cloud-download-not-found'],
    ['Dropbox', { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' }, 'downloadDropboxFile',
      new DropboxFileNotFoundError(), 'Dropbox attachment att-1 is no longer available', 'v1.3.4/dropbox-download-not-found'],
  ] as const)('treats a %s not-found as terminal, as WebDAV: no second request, no Download, local bytes kept', async (_name, storage, fetcher, failure, line, releaseCheck) => {
    const ports = setup({ storage });
    ports[fetcher].mockRejectedValueOnce(failure);
    const requested = remoteAttachment({ fileHash: 'a'.repeat(64) });

    const outcome = await ports.availability.ensureAttachmentAvailableDetailed(requested);

    expect(outcome).toMatchObject({
      status: 'unrecoverable',
      attachment: { cloudKey: undefined, fileHash: undefined, localStatus: 'missing', deletedAt: expect.any(String) },
    });
    expect(requested.cloudKey).toBe('attachments/att-1.txt');
    expect(deletesOutsideScratch(ports.memory.calls)).toEqual([]);
    expect(ports.lines).toContainEqual(expect.objectContaining({ level: 'warn', message: line, extra: expect.objectContaining({ releaseCheck }) }));
    if (outcome.status !== 'unrecoverable') throw new Error('Expected a terminal outcome');
    await expect(ports.availability.ensureAttachmentAvailableDetailed(outcome.attachment)).resolves.toEqual({ status: 'unavailable' });
    expect(ports[fetcher]).toHaveBeenCalledTimes(1);
  });

  it('keeps a self-hosted cloud failure other than 404 retryable', async () => {
    const { availability, cloudGetFile } = setup({ storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_URL_KEY]: 'https://cloud.example/v1/data' } });
    cloudGetFile.mockRejectedValueOnce(Object.assign(new Error('Cloud File GET failed (500)'), { status: 500 }));

    await expect(availability.ensureAttachmentAvailableDetailed(remoteAttachment())).resolves.toEqual({ status: 'unavailable' });
  });

  it('uses a managed file already on disk only when it matches the remote hash', async () => {
    const { availability, memory, webdavGetFile } = setup({ storage: webdav });
    memory.put(`${MANAGED}att-1.txt`, REMOTE);

    await expect(availability.ensureAttachmentAvailableDetailed(remoteAttachment({ fileHash: await computeSha256Hex(REMOTE) })))
      .resolves.toMatchObject({ status: 'available', attachment: { uri: `${MANAGED}att-1.txt` } });
    await expect(availability.ensureAttachmentAvailableDetailed(remoteAttachment({ fileHash: 'b'.repeat(64) })))
      .resolves.toEqual({ status: 'generation-conflict' });
    await expect(availability.ensureAttachmentAvailableDetailed(remoteAttachment()))
      .resolves.toEqual({ status: 'generation-conflict' });
    expect(webdavGetFile).not.toHaveBeenCalled();
    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(REMOTE);
  });

  it('shares one download between concurrent requests for the same generation', async () => {
    const { availability, webdavGetFile } = setup({ storage: webdav });
    const requested = remoteAttachment({ fileHash: await computeSha256Hex(REMOTE) });

    const [first, second] = await Promise.all([
      availability.ensureAttachmentAvailable(requested),
      availability.ensureAttachmentAvailable({ ...requested }),
    ]);

    expect(first?.uri).toBe(`${MANAGED}att-1.txt`);
    expect(second).toBe(first);
    expect(webdavGetFile).toHaveBeenCalledTimes(1);
  });

  it('reads Dropbox and self-hosted cloud attachments from their own transports', async () => {
    const dropbox = setup({ storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_PROVIDER_KEY]: 'dropbox' } });
    await expect(dropbox.availability.ensureAttachmentAvailableDetailed(remoteAttachment())).resolves.toMatchObject({ status: 'available' });
    expect(dropbox.downloadDropboxFile).toHaveBeenCalledWith('token', 'attachments/att-1.txt');

    const cloud = setup({ storage: { [SYNC_BACKEND_KEY]: 'cloud', [CLOUD_URL_KEY]: 'https://cloud.example/v1/data' } });
    await expect(cloud.availability.ensureAttachmentAvailableDetailed(remoteAttachment())).resolves.toMatchObject({ status: 'available' });
    expect(cloud.cloudGetFile).toHaveBeenCalledWith('https://cloud.example/v1/attachments/att-1.txt', expect.objectContaining({ token: '' }));
  });

  it('copies a File Sync attachment from the sync folder through a staged install', async () => {
    const { availability, memory } = setup({ storage: { [SYNC_BACKEND_KEY]: 'file', [SYNC_PATH_KEY]: 'file:///storage/Mindwtr/data.json' } });
    memory.put('file:///storage/Mindwtr/attachments/att-1.txt', REMOTE);

    await expect(availability.ensureAttachmentAvailableDetailed(remoteAttachment()))
      .resolves.toMatchObject({ status: 'available', attachment: { uri: `${MANAGED}att-1.txt` } });
    expect(memory.read('file:///storage/Mindwtr/attachments/att-1.txt')).toEqual(REMOTE);
    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(REMOTE);
  });

  it('treats a CloudKit not-found as terminal', async () => {
    const cloudKit = {
      fetchAttachmentAsset: vi.fn(async () => { throw new Error('asset gone'); }),
      isAttachmentNotFoundError: () => true,
    };
    const { availability } = setup({ storage: { [SYNC_BACKEND_KEY]: 'cloudkit' }, cloudKit });

    const outcome = await availability.ensureAttachmentAvailableDetailed(remoteAttachment({ cloudKey: 'cloudkit:att-1' }));

    expect(outcome.status).toBe('unrecoverable');
    expect(outcome.status === 'unrecoverable' && outcome.attachment.deletedAt).toBeTruthy();
  });

  it('reports CloudKit attachments unavailable on a host without CloudKit', async () => {
    const { availability, memory } = setup({ storage: { [SYNC_BACKEND_KEY]: 'cloudkit' } });

    await expect(availability.ensureAttachmentAvailableDetailed(remoteAttachment({ cloudKey: 'cloudkit:att-1' })))
      .resolves.toEqual({ status: 'unavailable' });
    expect(memory.calls).toEqual([]);
  });

  it('does nothing in sandbox mode', async () => {
    const { availability, memory } = setup({ storage: webdav, sandbox: true });

    await expect(availability.ensureAttachmentAvailableDetailed(remoteAttachment())).resolves.toEqual({ status: 'unavailable' });
    expect(memory.calls).toEqual([]);
  });
});
