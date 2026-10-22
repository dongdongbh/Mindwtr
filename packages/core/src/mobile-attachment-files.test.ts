import { describe, expect, it, vi } from 'vitest';
import type { AppData, Attachment } from './types';
import { createMobileAttachmentFiles, getManagedAttachmentFileName, type MobileAttachmentFileSystemPort, type MobileAttachmentSafPort } from './mobile-attachment-files';
import { DropboxUnauthorizedError } from './dropbox';
import { CLOUD_ALLOW_INSECURE_HTTP_KEY, CLOUD_TOKEN_KEY, CLOUD_URL_KEY, SYNC_BACKEND_KEY, WEBDAV_PASSWORD_KEY, WEBDAV_URL_KEY, WEBDAV_USERNAME_KEY } from './sync-storage-keys';
import { CACHE, createMemoryFileSystem, createMemoryStorage, createRecordingLog, MANAGED } from './__fixtures__/mobile-attachment-fakes';

const now = '2026-09-28T00:00:00.000Z';
const bytes = (...values: number[]) => new Uint8Array(values);

const setup = (options: {
  storage?: Record<string, string>;
  secrets?: Record<string, string>;
  sandbox?: boolean;
  saf?: MobileAttachmentSafPort;
  fs?: (fs: MobileAttachmentFileSystemPort) => MobileAttachmentFileSystemPort;
} = {}) => {
  const memory = createMemoryFileSystem({ saf: options.saf });
  const { storage, values } = createMemoryStorage(options.storage);
  const { log, lines } = createRecordingLog();
  const fetcher = vi.fn() as unknown as typeof fetch;
  const dropboxAuth = {
    getValidAccessToken: vi.fn(async () => 'stored-token'),
    forceRefreshAccessToken: vi.fn(async () => 'refreshed-token'),
  };
  const files = createMobileAttachmentFiles({
    fs: options.fs ? options.fs(memory.fs) : memory.fs,
    storage,
    getSecureConfigValue: async (key) => options.secrets?.[key] ?? null,
    log,
    fetch: fetcher,
    dropboxAuth,
    core: { isSandboxMode: () => options.sandbox === true },
  });
  return { files, memory, values, lines, fetcher, dropboxAuth };
};

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

const documentWith = (attachments: Attachment[], settings: AppData['settings'] = {}): AppData => ({
  tasks: [{
    id: 'task-1',
    title: 'Task',
    status: 'inbox',
    tags: [],
    contexts: [],
    attachments,
    createdAt: now,
    updatedAt: now,
  }],
  projects: [],
  sections: [],
  areas: [],
  settings,
});

describe('mobile attachment files: storage home and safe writes', () => {
  const namingCases = [
    ['Report.PDF', 'file:///pick/photo.JPG', 'att-1.pdf'],
    ['No extension', 'file:///pick/photo.JPG', 'att-1.jpg'],
    ['', 'file:///pick/source', 'att-1'],
    ['Report.PDF?download=1#part', 'file:///pick/photo.jpg', 'att-1.pdf'],
    ['No extension', 'content://provider/source.TXT?download=1#part', 'att-1.txt'],
    ['Résumé.ÉXT', 'file:///pick/source.bin', 'att-1.bin'],
    ['照片.JpG', 'file:///pick/source.bin', 'att-1.jpg'],
    ['.hidden', 'file:///pick/source.bin', 'att-1.hidden'],
    ['file.', 'file:///pick/source', 'att-1'],
    ['file..TXT', 'file:///pick/source', 'att-1.txt'],
    ['file.12345678', 'file:///pick/source', 'att-1.12345678'],
    ['file.123456789', 'file:///pick/source.gz', 'att-1.gz'],
    ['folder.with.dot/name', 'file:///pick/source', 'att-1'],
    ['C:\\folder\\name.DOCX', 'file:///pick/source', 'att-1.docx'],
    ['file.PDF ', 'file:///pick/source.zip#fragment', 'att-1.zip'],
  ];

  it.each(namingCases)('uses the existing pure managed filename rule for %s and %s', (title, uri, expected) => {
    const { memory } = setup();
    expect(getManagedAttachmentFileName({ id: 'att-1', title, uri })).toBe(expected);
    expect(memory.calls).toEqual([]);
  });

  it.each(namingCases)('persists with the same managed filename for %s and %s', async (title, uri, expected) => {
    const { files, memory } = setup();
    memory.put(uri, bytes(1, 2));
    const picked = attachment({ title, uri });
    const result = await files.persistAttachmentLocallyDetailed(picked);
    expect(result.status).toBe('copied');
    expect(result.attachment.uri).toBe(`${MANAGED}${expected}`);
    expect(memory.read(`${MANAGED}${expected}`)).toEqual(bytes(1, 2));
  });

  it('keeps the source URI captured before directory setup while preserving later title and ID reads', async () => {
    const source = 'content://provider/original.PDF';
    const changed = 'content://provider/changed.JPG';
    const picked = attachment({ title: 'No extension', uri: source });
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { files, memory } = setup({ fs: (fs) => ({
      ...fs,
      makeDirectory: async (uri) => { entered(); await held; await fs.makeDirectory(uri); },
    }) });
    memory.put(source, bytes(1, 2));
    memory.put(changed, bytes(9));
    const pending = files.persistAttachmentLocallyDetailed(picked);
    await waiting;
    Object.assign(picked, { uri: changed, id: 'later-id', title: 'Later title' });
    release();
    const result = await pending;
    expect(result).toMatchObject({ status: 'copied', attachment: { id: 'later-id', title: 'Later title', uri: `${MANAGED}later-id.pdf` } });
    expect(memory.read(`${MANAGED}later-id.pdf`)).toEqual(bytes(1, 2));
    expect(memory.files.has(`${MANAGED}later-id.jpg`)).toBe(false);
    expect(memory.calls.find((call) => call.startsWith('copy'))).toContain(`copy ${source} -> `);
  });

  it('writes to a temp file beside the target and renames it into place', async () => {
    const { files, memory } = setup();

    await files.writeBytesSafely(`${MANAGED}att-1.txt`, bytes(1, 2, 3));

    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(bytes(1, 2, 3));
    const [write, move] = memory.calls;
    expect(write).toMatch(/^writeBytes file:\/\/\/data\/files\/attachments\/\.mindwtr-attachment-write-[0-9a-z]+-[0-9a-f]{12}\.tmp$/);
    expect(move).toBe(`move ${write.slice('writeBytes '.length)} -> ${MANAGED}att-1.txt`);
    expect([...memory.files.keys()]).toEqual([`${MANAGED}att-1.txt`]);
  });

  it('leaves the previous file intact when the temp write fails', async () => {
    const { files, memory } = setup();
    memory.put(`${MANAGED}att-1.txt`, bytes(9, 9));
    memory.fail('writeBytes', new Error('connection cut mid-download'));

    await expect(files.writeBytesSafely(`${MANAGED}att-1.txt`, bytes(1, 2, 3))).rejects.toThrow('connection cut');

    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(bytes(9, 9));
    expect(memory.calls.filter((call) => call.startsWith('move'))).toEqual([]);
  });

  it('re-homes a picked content:// file into <files>/attachments/ under its id', async () => {
    const { files, memory } = setup();
    const source = 'content://provider/document/picked';
    memory.put(source, bytes(4, 5, 6));

    const result = await files.persistAttachmentLocallyDetailed(attachment({ uri: source, localStatus: undefined }));

    expect(result.status).toBe('copied');
    expect(result.attachment).toMatchObject({ uri: `${MANAGED}att-1.txt`, size: 3, localStatus: 'available' });
    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(bytes(4, 5, 6));
    await expect(files.persistAttachmentLocallyDetailed(result.attachment)).resolves.toMatchObject({ status: 'already-local' });
  });

  // R-8: the picked file's name is the user's text (#854). Copy-fallback lines name the
  // source by shape only, and fs error text loses the paths it quotes.
  it('keeps the picked file name out of every copy-fallback log line', async () => {
    const source = 'file:///storage/emulated/0/Download/Secret%20Plan%20Q3.pdf';
    const decoded = '/storage/emulated/0/Download/Secret Plan Q3.pdf';
    const run = async (arrange: (memory: ReturnType<typeof createMemoryFileSystem>) => void) => {
      const { files, memory, lines } = setup();
      memory.put(source, bytes(7, 8));
      arrange(memory);
      const result = await files.persistAttachmentLocallyDetailed(attachment({ uri: source, localStatus: undefined }));
      expect(result.status).toBe('copied');
      expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(bytes(7, 8));
      return lines;
    };

    const tempCopyFailed = await run((memory) => {
      memory.fail('copy', new Error(`Unable to copy '${source}': java.io.FileNotFoundException: ${decoded} (Permission denied)`));
    });
    const directCopyFailed = await run((memory) => {
      memory.fail('move', new Error(`Unable to move ${CACHE}x to ${MANAGED}att-1.txt`));
      memory.fail('copy', new Error(`open failed: EACCES ${decoded} (Permission denied)`), `${source} -> ${MANAGED}att-1.txt`);
    });

    for (const lines of [tempCopyFailed, directCopyFailed]) {
      expect(lines.some((line) => line.message.includes('falling back to byte write'))).toBe(true);
      const logged = JSON.stringify(lines);
      expect(logged).not.toContain('Secret');
      expect(logged).not.toContain('Download');
      expect(logged).not.toContain('emulated');
    }
    expect(tempCopyFailed.find((line) => line.message === 'Attachment byte fallback copied file')?.extra)
      .toEqual({ sourceUri: 'file:external.pdf', targetUri: 'file:managed.txt' });
  });

  // C1-c: a provider error can name a path this code never saw, and a file name may hold
  // spaces. Nothing after an unknown path may reach the log.
  it('drops the whole unknown path from a provider copy error', async () => {
    const source = 'content://com.android.providers.downloads.documents/document/42';
    const { files, memory, lines } = setup();
    memory.put(source, bytes(7, 8));
    memory.fail('copy', new Error("Unable to copy '/storage/emulated/0/Download/Secret Plan Q3.pdf': open failed: EACCES (Permission denied)"));
    const result = await files.persistAttachmentLocallyDetailed(attachment({ uri: source, localStatus: undefined }));
    expect(result.status).toBe('copied');
    const logged = JSON.stringify(lines);
    expect(logged).toContain('falling back to byte write');
    expect(logged).not.toContain('Plan');
    expect(logged).not.toContain('Q3');
    expect(logged).toContain("Unable to copy [path] (EACCES)");
  });

  it('refuses to persist or delete anything in sandbox mode', async () => {
    const { files, memory } = setup({ sandbox: true });
    memory.put(`${MANAGED}att-1.txt`, bytes(1));

    await expect(files.persistAttachmentLocallyDetailed(attachment({ uri: 'content://provider/x' }))).rejects.toThrow('sandbox');
    await expect(files.deleteManagedAttachmentFile(attachment())).resolves.toBe(false);
    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(bytes(1));
  });

  it('uploads only flat files inside the managed directory (SEC-07)', () => {
    const { files } = setup();

    expect(files.canUploadAttachmentFrom(`${MANAGED}att-1.txt`)).toBe(true);
    expect(files.canUploadAttachmentFrom(`${MANAGED}../../databases/mindwtr.db`)).toBe(false);
    expect(files.canUploadAttachmentFrom(`${MANAGED}%2e%2e/%2e%2e/databases/mindwtr.db`)).toBe(false);
    expect(files.canUploadAttachmentFrom(`${MANAGED}sub/att-1.txt`)).toBe(false);
    expect(files.canUploadAttachmentFrom(MANAGED)).toBe(false);
    expect(files.canUploadAttachmentFrom(`${CACHE}att-1.txt`)).toBe(false);
    expect(files.attachmentNeedsManagedLocalCopy(attachment({ uri: `${MANAGED}../../databases/mindwtr.db` }))).toBe(false);
    expect(files.attachmentNeedsManagedLocalCopy(attachment({ uri: 'content://provider/document/picked' }))).toBe(true);
  });

  it('deletes only the id-named managed copy and only app scratch files', async () => {
    const { files, memory } = setup();
    memory.put(`${MANAGED}att-1.txt`, bytes(1));
    memory.put(`${MANAGED}other.txt`, bytes(2));
    memory.put(`${MANAGED}4b28a96e.tmp`, bytes(3));
    memory.put(`${MANAGED}.mindwtr-attachment-write-m7v0x9k2-012345abcdef.tmp`, bytes(4));

    await expect(files.deleteManagedAttachmentFile(attachment({ uri: `${MANAGED}other.txt` }))).resolves.toBe(false);
    await expect(files.deleteManagedAttachmentFile(attachment())).resolves.toBe(true);
    await files.cleanupAttachmentTempFiles();

    expect([...memory.files.keys()].sort()).toEqual([`${MANAGED}4b28a96e.tmp`, `${MANAGED}other.txt`]);
  });
});

describe('mobile attachment files: an owned file is never deleted', () => {
  it('asks keep() after the directory setup, immediately before the delete', async () => {
    let restored = false;
    const { files, memory } = setup({ fs: (fs) => ({
      ...fs,
      // An attachment is restored while the directory setup is awaited.
      makeDirectory: async (dir: string) => { await fs.makeDirectory(dir); restored = true; },
    }) });
    memory.put(`${MANAGED}att-1.txt`, bytes(1));

    await expect(files.deleteManagedAttachmentFile(attachment(), { keep: () => restored })).resolves.toBe(false);
    expect(memory.read(`${MANAGED}att-1.txt`)).toEqual(bytes(1));
    await expect(files.deleteManagedAttachmentFile(attachment(), { keep: () => false })).resolves.toBe(true);
  });
});

describe('mobile attachment files: presence and stat', () => {
  it('tells a missing file from an unreadable one', async () => {
    const { files, memory } = setup();
    memory.put(`${MANAGED}present.txt`, bytes(1));
    memory.fail('getInfo', Object.assign(new Error('gone'), { code: 'ENOENT' }));
    await expect(files.getLocalAttachmentPresence('content://provider/document/gone')).resolves.toBe('confirmed-not-found');
    memory.fail('getInfo', new Error('Permission denied'));
    await expect(files.getLocalAttachmentPresence('content://provider/document/locked')).resolves.toBe('unreadable');

    await expect(files.getLocalAttachmentPresence(`${MANAGED}present.txt`)).resolves.toBe('present');
    await expect(files.getLocalAttachmentPresence(`${MANAGED}absent.txt`)).resolves.toBe('confirmed-not-found');
  });

  it('treats an ambiguous exists flag as unreadable', async () => {
    const { files } = setup({ fs: (fs) => ({ ...fs, getInfo: async () => ({}) }) });

    await expect(files.getLocalAttachmentPresence(`${MANAGED}att-1.txt`)).resolves.toBe('unreadable');
  });

  it('reports mtime in milliseconds and skips content:// uris', async () => {
    const { files } = setup({
      fs: (fs) => ({ ...fs, getInfo: async () => ({ exists: true, size: 12, modificationTime: 1_700_000_000.4 }) }),
    });

    await expect(files.statAttachmentFile(`${MANAGED}att-1.txt`)).resolves.toEqual({ mtimeMs: 1_700_000_000_400, size: 12 });
    await expect(files.statAttachmentFile('content://provider/document/x')).resolves.toBeNull();
  });

  it('reads a content:// uri through a cache copy when the direct read fails', async () => {
    const { files, memory } = setup();
    memory.put('content://provider/document/x', bytes(7, 8));
    memory.fail('readBytes', new Error('provider refused'), 'content://provider/document/x');

    await expect(files.readFileAsBytes('content://provider/document/x')).resolves.toEqual(bytes(7, 8));
    expect([...memory.files.keys()]).toEqual(['content://provider/document/x']);
  });
});

describe('mobile attachment files: upload refusals and download backoff', () => {
  it('marks a first upload unrecoverable on the third refusal', () => {
    const { files } = setup();
    const refused = attachment();

    expect(files.handleAttachmentUploadRefusal(refused, 'server_rejected')).toMatchObject({ attempts: 1, reachedLimit: false });
    expect(files.handleAttachmentUploadRefusal(refused, 'server_rejected')).toMatchObject({ attempts: 2, reachedLimit: false });
    const third = files.handleAttachmentUploadRefusal(refused, 'server_rejected');

    expect(third).toMatchObject({ attempts: 3, reachedLimit: true, mutated: true });
    expect(third.message).not.toContain('notes.txt');
    expect(refused.deletedAt).toBeDefined();
    expect(refused.cloudKey).toBeUndefined();
  });

  it('keeps a refused replacement pending and the remote copy unchanged', () => {
    const { files } = setup();
    const replacement = attachment({ cloudKey: 'attachments/att-1.txt', fileHash: 'a'.repeat(64), pendingContentUpload: true });
    for (let i = 0; i < 3; i += 1) files.handleAttachmentUploadRefusal(replacement, 'server_rejected');

    expect(replacement).toMatchObject({ cloudKey: 'attachments/att-1.txt', pendingContentUpload: true });
    expect(replacement.deletedAt).toBeUndefined();
    expect(files.shouldAttemptAttachmentUpload(replacement)).toBe(false);
    replacement.fileHash = 'b'.repeat(64);
    expect(files.shouldAttemptAttachmentUpload(replacement)).toBe(true);
  });

  it('backs a missing remote file off for 15 minutes', () => {
    const { files } = setup();
    const start = Date.now();

    files.setWebdavDownloadBackoff('att-1', Object.assign(new Error('Not found'), { status: 404 }));

    expect(files.getWebdavDownloadBackoff('att-1')).toBeGreaterThanOrEqual(start + 15 * 60_000);
    files.clearWebdavDownloadBackoff('att-1');
    expect(files.getWebdavDownloadBackoff('att-1')).toBeNull();
  });
});

describe('mobile attachment files: stored configs and Dropbox', () => {
  it('reads the saved WebDAV and cloud locations, secrets from the keystore', async () => {
    const { files } = setup({
      storage: {
        [WEBDAV_URL_KEY]: 'https://dav.example/Mindwtr/data.json',
        [WEBDAV_USERNAME_KEY]: 'me',
        [CLOUD_URL_KEY]: 'https://cloud.example',
        [CLOUD_ALLOW_INSECURE_HTTP_KEY]: 'true',
      },
      secrets: { [WEBDAV_PASSWORD_KEY]: 'pw', [CLOUD_TOKEN_KEY]: 'tok' },
    });

    await expect(files.loadWebDavConfig()).resolves.toMatchObject({ url: 'https://dav.example/Mindwtr/data.json', username: 'me', password: 'pw' });
    await expect(files.loadCloudConfig()).resolves.toEqual({ url: 'https://cloud.example', token: 'tok', allowInsecureHttp: true });
  });

  it('retries a Dropbox operation once with a refreshed token, on the host fetch', async () => {
    const { files, dropboxAuth, fetcher } = setup();
    const operation = vi.fn(async (token: string) => {
      if (token === 'stored-token') throw new DropboxUnauthorizedError('expired');
      return 'ok';
    });

    await expect(files.runDropboxAuthorized('app-key', operation)).resolves.toBe('ok');

    expect(operation.mock.calls.map(([token]) => token)).toEqual(['stored-token', 'refreshed-token']);
    expect(dropboxAuth.getValidAccessToken).toHaveBeenCalledWith('app-key', fetcher);
    expect(dropboxAuth.forceRefreshAccessToken).toHaveBeenCalledWith('app-key', fetcher);
  });
});

describe('mobile attachment files: File Sync folders', () => {
  it('keeps a File Sync folder\'s attachments beside the data file', async () => {
    const { files, memory } = setup();

    await expect(files.resolveFileSyncDir('file:///storage/Mindwtr/data.json')).resolves.toEqual({
      type: 'file',
      dirUri: 'file:///storage/Mindwtr/',
      attachmentsDirUri: 'file:///storage/Mindwtr/attachments/',
    });
    expect(memory.calls).toContain('makeDirectory file:///storage/Mindwtr/attachments/');
  });

  it('never creates a SAF attachments folder when no folder listing could be read', async () => {
    const saf = {
      readDirectory: vi.fn(async () => { throw new Error('provider offline'); }),
      makeDirectory: vi.fn(async () => 'content://created'),
    };
    const { files } = setup({ saf });

    await expect(files.resolveFileSyncDir('content://com.provider/tree/primary%3AMindwtr')).resolves.toBeNull();
    expect(saf.makeDirectory).not.toHaveBeenCalled();
  });

  it('finds an existing SAF attachments folder by its leaf name', async () => {
    const saf = {
      readDirectory: vi.fn(async () => ['content://com.provider/tree/primary%3AMindwtr/document/primary%3AMindwtr%2Fattachments']),
      makeDirectory: vi.fn(async () => 'content://created'),
    };
    const { files } = setup({ saf });

    await expect(files.resolveFileSyncDir('content://com.provider/tree/primary%3AMindwtr')).resolves.toMatchObject({
      type: 'saf',
      attachmentsDirUri: 'content://com.provider/tree/primary%3AMindwtr/document/primary%3AMindwtr%2Fattachments',
    });
    expect(saf.makeDirectory).not.toHaveBeenCalled();
  });

  // Document IDs are opaque provider values (B7): a provider may name `attachments` with ID 9.
  it('finds a SAF attachments folder and its files by display name when document IDs are opaque', async () => {
    const root = 'content://op/tree/root/document/root';
    const saf = {
      readDirectory: vi.fn(async (uri: string) => (uri === root || uri === 'content://op/tree/root'
        ? ['content://op/tree/root/document/7', 'content://op/tree/root/document/9']
        : ['content://op/tree/root/document/12'])),
      listChildren: vi.fn(async (uri: string) => (uri === root || uri === 'content://op/tree/root'
        ? [{ uri: 'content://op/tree/root/document/7', name: 'data.json' }, { uri: 'content://op/tree/root/document/9', name: 'attachments' }]
        : [{ uri: 'content://op/tree/root/document/12', name: 'att-1.txt', size: 3 }])),
      makeDirectory: vi.fn(async () => 'content://created'),
    };
    const { files } = setup({ saf });

    await expect(files.resolveFileSyncDir('content://op/tree/root/document/7')).resolves.toMatchObject({
      type: 'saf',
      attachmentsDirUri: 'content://op/tree/root/document/9',
    });
    expect(saf.makeDirectory).not.toHaveBeenCalled();
    const inventory = await files.inspectSafDirectoryEntriesByName('content://op/tree/root/document/9');
    expect(inventory).toEqual({
      status: 'available',
      entries: new Map([['att-1.txt', 'content://op/tree/root/document/12']]),
      // The listing's own size, kept so the File pass judges a plaintext entry without reading it.
      sizes: new Map([['att-1.txt', 3]]),
      directories: new Set(),
    });
  });
});

describe('mobile attachment files: pending work and the presence stamp (#1119)', () => {
  const webdavLocation = { [SYNC_BACKEND_KEY]: 'webdav', [WEBDAV_URL_KEY]: 'https://dav.example/data.json' };
  const settled = attachment({ cloudKey: 'attachments/att-1.txt', contentMtimeMs: 1, contentSize: 1 });

  it('reports pending remote deletes and unsynced local files as work', async () => {
    const { files } = setup();

    await expect(files.hasPendingAttachmentSyncWork(documentWith([], {
      attachments: { pendingRemoteDeletes: [{ cloudKey: 'attachments/old.txt', attempts: 0 }] },
    }))).resolves.toBe(true);
    await expect(files.hasPendingAttachmentSyncWork(documentWith([attachment()]))).resolves.toBe(true);
  });

  it('runs the presence proof once a day per sync location', async () => {
    const { files, values } = setup({ storage: webdavLocation });
    const data = documentWith([settled]);

    await expect(files.hasPendingAttachmentSyncWork(data, { contentCheckEnabled: true })).resolves.toBe(true);
    await expect(files.hasCompletedAttachmentPresenceReconciliation()).resolves.toBe(false);
    await files.markAttachmentPresenceReconciled();
    await expect(files.hasPendingAttachmentSyncWork(data, { contentCheckEnabled: true })).resolves.toBe(false);
    await expect(files.hasCompletedAttachmentPresenceReconciliation()).resolves.toBe(true);

    values.set(WEBDAV_URL_KEY, 'https://other.example/data.json');
    await expect(files.isAttachmentPresenceReconciliationDue()).resolves.toBe(true);
    await expect(files.hasCompletedAttachmentPresenceReconciliation()).resolves.toBe(false);
  });
});
