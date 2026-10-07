import { describe, expect, it, vi } from 'vitest';
import type { Attachment } from './types';
import { computeSha256Hex } from './attachment-hash';
import { createMobileAttachmentFiles } from './mobile-attachment-files';
import { SyncEncryptionPartlyEncryptedError } from './sync-encryption';
import { createMobileAttachmentCommon, type MobileAttachmentCommonHost, type MobileAttachmentUploadTask } from './mobile-attachment-common';
import { AttachmentFileInstallerUnavailableError, type AttachmentFileInstallResult } from './mobile-attachment-installer';
import { defaultSyncCryptoPrimitives, SYNC_CRYPTO_DEFAULT_KDF_PARAMS, type SyncKeyMaterial } from './sync-crypto';
import { WebDavRemoteWriteConflictError } from './webdav';
import { AttachmentUploadTooLargeError } from './attachment-transfer';
import { CACHE, createMemoryFileSystem, createMemoryStorage, createRecordingLog, MANAGED } from './__fixtures__/mobile-attachment-fakes';

const now = '2026-09-28T00:00:00.000Z';
const bytes = (...values: number[]) => new Uint8Array(values);
const material: SyncKeyMaterial = { key: new Uint8Array(32).fill(7), salt: new Uint8Array(16).fill(1), params: SYNC_CRYPTO_DEFAULT_KDF_PARAMS };

const attachment = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: 'att-1',
  kind: 'file',
  title: 'notes.txt',
  uri: `${MANAGED}att-1.txt`,
  localStatus: 'available',
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const setup = (options: {
  sha256?: (bytes: Uint8Array) => Promise<string>;
  install?: (stagedPath: string, targetPath: string) => Promise<AttachmentFileInstallResult>;
  installerMayBeMissing?: boolean;
  timersPaused?: boolean;
  createUploadTask?: () => MobileAttachmentUploadTask | null;
  preparePlaintextDownload?: MobileAttachmentCommonHost['preparePlaintextDownload'];
} = {}) => {
  const memory = createMemoryFileSystem({ sha256: options.sha256 });
  const { log, lines } = createRecordingLog();
  const files = createMobileAttachmentFiles({
    fs: memory.fs,
    storage: createMemoryStorage().storage,
    getSecureConfigValue: async () => null,
    log,
    fetch: vi.fn() as unknown as typeof fetch,
    dropboxAuth: { getValidAccessToken: async () => '', forceRefreshAccessToken: async () => '' },
    core: { isSandboxMode: () => false },
  });
  const installAttachmentFileGeneration = vi.fn(async (
    stagedPath: string,
    targetPath: string,
    _expected: unknown,
    _sha256: string,
  ): Promise<AttachmentFileInstallResult> => {
    if (options.install) return options.install(stagedPath, targetPath);
    await memory.fs.move(stagedPath, targetPath);
    return { status: 'installed' };
  });
  const logSyncEncryptionEvent = vi.fn(async () => undefined);
  const createUploadTask = vi.fn(options.createUploadTask ?? (() => null));
  const common = createMobileAttachmentCommon({
    fs: memory.fs,
    files,
    crypto: defaultSyncCryptoPrimitives,
    encryption: { logSyncEncryptionEvent },
    installer: { installAttachmentFileGeneration },
    installerMayBeMissing: () => options.installerMayBeMissing === true,
    timersPaused: () => options.timersPaused === true,
    uploads: { createUploadTask },
    preparePlaintextDownload: options.preparePlaintextDownload,
  });
  return { common, files, memory, lines, installAttachmentFileGeneration, logSyncEncryptionEvent, createUploadTask };
};

const stagedFiles = (keys: Iterable<string>) => [...keys].filter((key) => key.includes('.mindwtr-download-'));
const SOURCE_TOKEN = '27bc6994-c737-48ea-8e69-8c2f963858c5';

describe('mobile attachment common: private plaintext preparation', () => {
  it('omits preparation when the host does not bind it', () => {
    expect(setup().common).not.toHaveProperty('prepareAttachmentDownloadBytes');
  });

  it('hands off verified plaintext without mutating metadata or touching files', async () => {
    const preparePlaintextDownload = vi.fn(async () => ({ kind: 'prepared-source' as const, sourceToken: SOURCE_TOKEN }));
    const { common, memory, installAttachmentFileGeneration } = setup({ preparePlaintextDownload });
    const payload = bytes(1, 2, 3);
    const hash = (await computeSha256Hex(payload))!;
    const target = Object.freeze(attachment({ fileHash: hash.toUpperCase() }));
    const before = { ...target };
    const controller = new AbortController();

    await expect(common.prepareAttachmentDownloadBytes!(target, target.uri!, payload, controller.signal))
      .resolves.toEqual({ kind: 'prepared-plaintext', sourceToken: SOURCE_TOKEN, sha256: hash, size: 3 });
    expect(preparePlaintextDownload).toHaveBeenCalledWith({
      attachmentId: target.id, targetURI: target.uri, expectation: { kind: 'absent' }, sha256: hash, size: 3,
    }, payload, controller.signal);
    expect(target).toEqual(before);
    expect(memory.calls).toEqual([]);
    expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
  });

  it('rejects a wrong plaintext hash before the source callback', async () => {
    const preparePlaintextDownload = vi.fn(async () => ({ kind: 'prepared-source' as const, sourceToken: SOURCE_TOKEN }));
    const { common, memory, installAttachmentFileGeneration } = setup({ preparePlaintextDownload });

    await expect(common.prepareAttachmentDownloadBytes!(attachment({ fileHash: 'a'.repeat(64) }), `${MANAGED}att-1.txt`, bytes(1)))
      .rejects.toThrow('Integrity validation failed');
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
    expect(memory.calls).toEqual([]);
    expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['missing kind', { sourceToken: SOURCE_TOKEN }],
    ['missing token', { kind: 'prepared-source' }],
    ['extra field', { kind: 'prepared-source', sourceToken: SOURCE_TOKEN, path: '/tmp/source' }],
    ['installed', { kind: 'installed', sourceToken: SOURCE_TOKEN }],
    ['uppercase UUID', { kind: 'prepared-source', sourceToken: SOURCE_TOKEN.toUpperCase() }],
    ['UUIDv1', { kind: 'prepared-source', sourceToken: SOURCE_TOKEN.replace('-48ea-', '-18ea-') }],
    ['wrong variant', { kind: 'prepared-source', sourceToken: SOURCE_TOKEN.replace('-8e69-', '-7e69-') }],
    ['path token', { kind: 'prepared-source', sourceToken: `${MANAGED}source` }],
  ])('rejects a %s source reply without an installer fallback', async (_name, reply) => {
    const { common, memory, installAttachmentFileGeneration } = setup({ preparePlaintextDownload: async () => reply as never });

    await expect(common.prepareAttachmentDownloadBytes!(attachment(), `${MANAGED}att-1.txt`, bytes(1)))
      .rejects.toThrow('Attachment download source is invalid');
    expect(memory.calls).toEqual([]);
    expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
  });

  it('propagates a source refusal without scratch writes or fallback', async () => {
    const failure = new Error('Source refused');
    const { common, memory, installAttachmentFileGeneration } = setup({ preparePlaintextDownload: async () => { throw failure; } });

    await expect(common.prepareAttachmentDownloadBytes!(attachment(), `${MANAGED}att-1.txt`, bytes(1))).rejects.toBe(failure);
    expect(memory.calls).toEqual([]);
    expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
  });

  it('checks cancellation before admission and after the source callback settles', async () => {
    const controller = new AbortController();
    const reason = new Error('Canceled selected download');
    const preparePlaintextDownload = vi.fn(async () => {
      controller.abort(reason);
      return { kind: 'prepared-source' as const, sourceToken: SOURCE_TOKEN };
    });
    const { common, memory } = setup({ preparePlaintextDownload });

    await expect(common.prepareAttachmentDownloadBytes!(attachment(), `${MANAGED}att-1.txt`, bytes(1), controller.signal))
      .rejects.toBe(reason);
    expect(preparePlaintextDownload).toHaveBeenCalledTimes(1);
    await expect(common.prepareAttachmentDownloadBytes!(attachment(), `${MANAGED}att-1.txt`, bytes(1), controller.signal))
      .rejects.toBe(reason);
    expect(preparePlaintextDownload).toHaveBeenCalledTimes(1);
    expect(memory.calls).toEqual([]);
  });

  it('keeps ordinary installation on the installer when a source adapter is bound', async () => {
    const preparePlaintextDownload = vi.fn(async () => ({ kind: 'prepared-source' as const, sourceToken: SOURCE_TOKEN }));
    const { common, memory, installAttachmentFileGeneration } = setup({ preparePlaintextDownload });
    const target = attachment();

    await expect(common.installAttachmentDownloadBytes(target, MANAGED, target.uri!, bytes(1), { kind: 'absent' })).resolves.toBe(true);
    expect(installAttachmentFileGeneration).toHaveBeenCalledTimes(1);
    expect(memory.read(target.uri!)).toEqual(bytes(1));
    expect(preparePlaintextDownload).not.toHaveBeenCalled();
  });
});

describe('mobile attachment common: download installation', () => {
  it('stages the bytes in the managed folder and installs that exact generation', async () => {
    const { common, memory, installAttachmentFileGeneration } = setup();
    const target = attachment();
    const payload = bytes(1, 2, 3);
    const sha256 = await computeSha256Hex(payload);

    await expect(common.installAttachmentDownloadBytes(target, MANAGED, target.uri!, payload, { kind: 'absent' })).resolves.toBe(true);

    const [stagedPath, targetPath, expectation, digest] = installAttachmentFileGeneration.mock.calls[0];
    expect(stagedPath).toMatch(/^file:\/\/\/data\/files\/attachments\/\.mindwtr-download-\d+-\d+-[0-9a-f]+-att-1\.staged$/);
    expect([targetPath, expectation, digest]).toEqual([`${MANAGED}att-1.txt`, { kind: 'absent' }, sha256]);
    expect(target.fileHash).toBe(sha256);
    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(payload);
    expect(stagedFiles(memory.files.keys())).toEqual([]);
  });

  it('keeps the staged generation when the installer reports a local conflict', async () => {
    const { common, memory } = setup({ install: async (stagedPath) => ({ status: 'conflict', preservedPath: stagedPath }) });
    const target = attachment();

    await expect(common.installAttachmentDownloadBytes(target, MANAGED, target.uri!, bytes(1), { kind: 'absent' })).resolves.toBe(false);

    expect(stagedFiles(memory.files.keys())).toHaveLength(1);
    expect(target.fileHash).toBeUndefined();
  });

  it('fails closed as a conflict where the native installer may be missing', async () => {
    const { common, memory } = setup({
      installerMayBeMissing: true,
      install: async () => { throw new AttachmentFileInstallerUnavailableError(); },
    });

    await expect(common.installAttachmentDownloadBytes(attachment(), MANAGED, `${MANAGED}att-1.txt`, bytes(1), { kind: 'absent' })).resolves.toBe(false);
    expect(stagedFiles(memory.files.keys())).toHaveLength(1);
    expect(memory.read(`${MANAGED}att-1.txt`)).toBeUndefined();
  });

  it('fails loudly and removes its stage when a production build has no installer', async () => {
    const { common, memory } = setup({ install: async () => { throw new AttachmentFileInstallerUnavailableError(); } });

    await expect(common.installAttachmentDownloadBytes(attachment(), MANAGED, `${MANAGED}att-1.txt`, bytes(1), { kind: 'absent' }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_FILE_INSTALLER_UNAVAILABLE' });
    expect(stagedFiles(memory.files.keys())).toEqual([]);
  });

  it('rejects bytes whose hash differs from the recorded one before any install', async () => {
    const { common, memory, installAttachmentFileGeneration } = setup();
    const target = attachment({ fileHash: 'a'.repeat(64) });
    memory.put(`${MANAGED}att-1.txt`, bytes(9));

    await expect(common.installAttachmentDownloadBytes(target, MANAGED, target.uri!, bytes(1, 2), { kind: 'absent' }))
      .rejects.toThrow('Integrity validation failed');
    expect(installAttachmentFileGeneration).not.toHaveBeenCalled();
    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(bytes(9));
    expect(stagedFiles(memory.files.keys())).toEqual([]);
  });

  it('reads a staged download in 64 KiB chunks', async () => {
    const { common, memory } = setup();
    const staged = `${MANAGED}.mindwtr-download-1-1-abc-att-1.staged`;
    const payload = new Uint8Array(150_000).map((_, index) => index % 251);
    memory.put(staged, payload);

    await expect(common.readAttachmentDownloadStageBytes(staged)).resolves.toEqual(payload);
    expect(memory.calls.filter((call) => call.startsWith('readBytesRange'))).toHaveLength(3);
  });
});

describe('mobile attachment common: encryption seam (#1056)', () => {
  it('seals on upload and opens on download; plaintext passes through', async () => {
    const { common, logSyncEncryptionEvent } = setup();
    const plaintext = bytes(1, 2, 3, 4);

    const sealed = await common.sealAttachmentBytesForUpload(plaintext, material, 'attachments/att-1.txt');
    expect(sealed).not.toEqual(plaintext);
    await expect(common.openAttachmentBytesFromDownload(sealed, material, 'attachments/att-1.txt')).resolves.toEqual(plaintext);
    await expect(common.openAttachmentBytesFromDownload(plaintext, material)).resolves.toBe(plaintext);
    await expect(common.sealAttachmentBytesForUpload(plaintext, null)).resolves.toBe(plaintext);
    expect(logSyncEncryptionEvent).toHaveBeenCalledWith('remote-read', expect.objectContaining({ decision: 'seal' }));
  });
});

describe('mobile attachment common: a partly encrypted location', () => {
  it('never takes ciphertext as an attachment\'s bytes when this device has no key', async () => {
    const { common } = setup();
    const sealed = await common.sealAttachmentBytesForUpload(bytes(1, 2, 3, 4), material, 'attachments/att-1.txt');
    await expect(common.openAttachmentBytesFromDownload(sealed, null, 'attachments/att-1.txt'))
      .rejects.toBeInstanceOf(SyncEncryptionPartlyEncryptedError);
  });
});

describe('mobile attachment common: upload snapshots', () => {
  it('rejects an oversized source before copying it', async () => {
    const { common, memory } = setup();
    memory.put(`${MANAGED}att-1.txt`, new Uint8Array(16));

    await expect(common.createMobileAttachmentUploadSnapshotWithLimit(`${MANAGED}att-1.txt`, attachment(), 15))
      .rejects.toBeInstanceOf(AttachmentUploadTooLargeError);
    expect(memory.calls.some((call) => call.startsWith('copy'))).toBe(false);
  });

  it('hashes an app-private copy in the cache and deletes it on dispose', async () => {
    const { common, memory } = setup();
    memory.put(`${MANAGED}att-1.txt`, bytes(5, 6));

    const snapshot = await common.createMobileAttachmentUploadSnapshot(`${MANAGED}att-1.txt`, attachment());

    expect(snapshot?.sourcePath.startsWith(`${CACHE}mindwtr-upload-`)).toBe(true);
    expect(snapshot?.fileHash).toBe(await computeSha256Hex(bytes(5, 6)));
    await snapshot?.dispose();
    expect([...memory.files.keys()]).toEqual([`${MANAGED}att-1.txt`]);
  });
});

describe('mobile attachment common: a host that hashes files itself', () => {
  const hex = async (bytes: Uint8Array) => (await computeSha256Hex(bytes))!;

  it('hashes the snapshot through the host and never reads its bytes into memory', async () => {
    const { common, memory } = setup({ sha256: hex });
    memory.put(`${MANAGED}att-1.txt`, bytes(5, 6, 7));

    const snapshot = await common.createMobileAttachmentUploadSnapshot(`${MANAGED}att-1.txt`, attachment());

    expect(snapshot?.fileHash).toBe(await hex(bytes(5, 6, 7)));
    expect(snapshot?.stat.size).toBe(3);
    expect(memory.calls.filter((call) => call.startsWith('readBytes'))).toEqual([]);
    expect(memory.calls.some((call) => call.startsWith(`sha256 ${CACHE}mindwtr-upload-`))).toBe(true);
  });

  it('hashes a managed file through the host', async () => {
    const { files, memory } = setup({ sha256: hex });
    memory.put(`${MANAGED}att-1.txt`, bytes(1, 2));

    expect(await files.computeAttachmentFileHash(`${MANAGED}att-1.txt`)).toBe(await hex(bytes(1, 2)));
    expect(memory.calls.filter((call) => call.startsWith('readBytes'))).toEqual([]);
  });
});

describe('mobile attachment common: streamed uploads', () => {
  const upload = (common: ReturnType<typeof setup>['common'], url: string, fileUri: string, {
    expectedEtag = null,
    signal,
  }: {
    expectedEtag?: string | null;
    signal?: AbortSignal;
  } = {}) => common.uploadWebdavFileWithFileSystem(
    url,
    fileUri,
    'text/plain',
    'me',
    'pw',
    false,
    undefined,
    undefined,
    signal,
    expectedEtag,
  );
  it('leaves a WebDAV overwrite to the buffered PUT, whose redirect core refuses', async () => {
    // The native uploader follows a redirect by itself. A 303 (iOS) or 301-303 (Android)
    // turns the PUT into a GET, and with If-Match that GET answers 200 from the old file.
    const task = { uploadAsync: vi.fn(async () => ({ status: 200 })), cancelAsync: vi.fn(async () => undefined) };
    const { common, createUploadTask } = setup({ createUploadTask: () => task });

    await expect(upload(common, 'https://dav.example.com/a.txt', `${MANAGED}att-1.txt`, { expectedEtag: '"v1"' }))
      .resolves.toBe(false);
    expect(createUploadTask).not.toHaveBeenCalled();
  });

  it('refuses cleartext to a public host before creating a task (SEC-10a)', async () => {
    const { common, createUploadTask } = setup();

    await expect(upload(common, 'http://dav.example.com/a.txt', `${MANAGED}att-1.txt`)).rejects.toThrow(/HTTPS/);
    expect(createUploadTask).not.toHaveBeenCalled();
  });

  it('falls back to the buffered PUT without a task or for a non-file uri', async () => {
    const { common, createUploadTask } = setup();

    await expect(upload(common, 'https://dav.example.com/a.txt', 'content://provider/x')).resolves.toBe(false);
    expect(createUploadTask).not.toHaveBeenCalled();
    await expect(upload(common, 'https://dav.example.com/a.txt', `${MANAGED}att-1.txt`)).resolves.toBe(false);
    expect(createUploadTask).toHaveBeenCalledTimes(1);
  });

  it('creates only a new file for a null ETag and maps 412 to a write conflict', async () => {
    const task = { uploadAsync: vi.fn(async () => ({ status: 412 })), cancelAsync: vi.fn(async () => undefined) };
    const { common, createUploadTask } = setup({ createUploadTask: () => task });

    await expect(upload(common, 'https://dav.example.com/a.txt', `${MANAGED}att-1.txt`, { expectedEtag: null }))
      .rejects.toBeInstanceOf(WebDavRemoteWriteConflictError);
    expect(createUploadTask).toHaveBeenCalledWith(
      'https://dav.example.com/a.txt',
      `${MANAGED}att-1.txt`,
      { httpMethod: 'PUT', headers: { 'Content-Type': 'text/plain', Authorization: 'Basic bWU6cHc=', 'If-None-Match': '*' } },
      expect.any(Function),
    );
  });

  it('rejects an aborted upload only after the native task confirms its cancellation', async () => {
    let finishUpload!: () => void;
    const task = {
      uploadAsync: vi.fn(() => new Promise<{ status: number }>((resolve) => { finishUpload = () => resolve({ status: 0 }); })),
      cancelAsync: vi.fn(async () => undefined),
    };
    const { common } = setup({ createUploadTask: () => task });
    const controller = new AbortController();
    let settled = false;

    const pending = upload(common, 'https://dav.example.com/a.txt', `${MANAGED}att-1.txt`, { signal: controller.signal })
      .finally(() => { settled = true; });
    await Promise.resolve();
    controller.abort(new Error('cycle aborted'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(task.cancelAsync).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    finishUpload();
    await expect(pending).rejects.toThrow('cycle aborted');
  });

  it('does not wait on a timer Android has paused in the background', async () => {
    const { common } = setup({ timersPaused: true });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await common.waitForAttachmentSyncDelay(60_000);

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});

describe('mobile attachment common: pre-passes', () => {
  it('migrates at most three outside files per pass and drops unreadable ones from the round', async () => {
    const { common, memory } = setup();
    const attachmentsById = new Map<string, Attachment>();
    for (const id of ['a', 'b', 'c', 'd']) {
      memory.put(`content://provider/${id}`, bytes(1));
      attachmentsById.set(id, attachment({ id, uri: `content://provider/${id}` }));
    }
    memory.fail('getInfo', new Error('Permission denied'), 'content://provider/a');

    const patches = await common.migrateAttachmentsLocallyBeforeSync(attachmentsById);

    expect([...patches.keys()]).toEqual(['b', 'c', 'd']);
    expect(attachmentsById.has('a')).toBe(false);
    expect(attachmentsById.get('b')?.uri).toBe(`${MANAGED}b.txt`);
  });

  it('clears a cloud key only on a definitive not-found; an unanswered probe keeps the pass incomplete', async () => {
    const { common, memory } = setup();
    memory.put(`${MANAGED}att-1.txt`, bytes(1));
    memory.put(`${MANAGED}att-2.txt`, bytes(1));
    const recordPatch = vi.fn();
    const attachmentsById = new Map([
      ['att-1', attachment({ cloudKey: 'attachments/att-1.txt' })],
      ['att-2', attachment({ id: 'att-2', uri: `${MANAGED}att-2.txt`, cloudKey: 'attachments/att-2.txt' })],
    ]);

    await expect(common.reconcileRemoteAttachmentPresence({
      label: 'Cloud',
      attachmentsById,
      createProbe: async () => async (candidate) => (candidate.id === 'att-1' ? false : null),
      recordPatch,
    })).resolves.toBe(false);
    expect(recordPatch).toHaveBeenCalledTimes(1);
    expect(recordPatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'att-1', cloudKey: undefined }));
  });

  it('asks the remote nothing when no attachment could be re-uploaded', async () => {
    const { common } = setup();
    const createProbe = vi.fn(async () => null);

    await expect(common.reconcileRemoteAttachmentPresence({
      label: 'Cloud',
      attachmentsById: new Map([['att-1', attachment({ cloudKey: 'attachments/att-1.txt' })]]),
      createProbe,
      recordPatch: vi.fn(),
    })).resolves.toBe(true);
    expect(createProbe).not.toHaveBeenCalled();
  });
});
