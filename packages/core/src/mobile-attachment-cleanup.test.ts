import { describe, expect, it, vi } from 'vitest';
import type { AppData, Attachment } from './types';
import { runMobileAttachmentCleanup } from './mobile-attachment-cleanup';
import type { MobileSyncAttachmentCleanupOptions } from './mobile-sync-service';
import { DropboxConflictError } from './dropbox';
import { createMemoryFileSystem, MANAGED } from './__fixtures__/mobile-attachment-fakes';

const now = '2026-09-28T00:00:00.000Z';

const purgedTaskWith = (attachment: Partial<Attachment>): AppData => ({
  tasks: [{
    id: 'purged',
    title: 'Purged',
    status: 'done',
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: now,
    purgedAt: now,
    attachments: [{
      id: 'orphan',
      kind: 'file',
      title: 'orphan.pdf',
      uri: '',
      createdAt: now,
      updatedAt: now,
      ...attachment,
    }],
  }],
  projects: [],
  sections: [],
  areas: [],
  settings: {},
});

const setup = (data: AppData, overrides: Partial<MobileSyncAttachmentCleanupOptions> = {}) => {
  const memory = createMemoryFileSystem();
  const webdavHeadFile = vi.fn(async () => ({ exists: true, etag: '"v1"', fingerprint: null, lastModified: null, contentLength: null }));
  const webdavDeleteFileVersioned = vi.fn(async () => undefined);
  const cloudDeleteFile = vi.fn(async () => undefined);
  const options: MobileSyncAttachmentCleanupOptions = {
    appData: data,
    backend: 'webdav',
    webdavConfig: { url: 'https://dav.example/Mindwtr/data.json', username: 'me', password: 'pw' },
    cloudConfig: null,
    cloudProvider: 'selfhosted',
    fetcher: vi.fn() as unknown as typeof fetch,
    ensureLocalSnapshotFresh: vi.fn(),
    assertRemoteMutationFenceHeld: vi.fn(async () => undefined),
    deleteDropboxAttachment: vi.fn(async () => undefined),
    isRemoteMissingError: () => false,
    logSyncInfo: vi.fn(),
    logSyncWarning: vi.fn(),
    ...overrides,
  };
  const run = () => runMobileAttachmentCleanup(options, {
    fs: memory.fs,
    core: { webdavHeadFile, webdavDeleteFileVersioned, cloudDeleteFile },
  });
  return { memory, options, run, webdavHeadFile, webdavDeleteFileVersioned, cloudDeleteFile };
};

describe('mobile attachment cleanup', () => {
  it('deletes an orphaned WebDAV attachment only against its strong ETag, under the fence', async () => {
    const { run, options, webdavHeadFile, webdavDeleteFileVersioned } = setup(purgedTaskWith({ cloudKey: 'attachments/orphan.pdf' }));

    const result = await run();

    expect(webdavHeadFile).toHaveBeenCalledWith('https://dav.example/Mindwtr/attachments/orphan.pdf', expect.objectContaining({ username: 'me' }));
    expect(options.assertRemoteMutationFenceHeld).toHaveBeenCalledWith(35_000);
    expect(webdavDeleteFileVersioned).toHaveBeenCalledWith('https://dav.example/Mindwtr/attachments/orphan.pdf', '"v1"', expect.anything());
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
  });

  it('keeps the delete pending when the server offers only a weak ETag', async () => {
    const { run, webdavHeadFile, webdavDeleteFileVersioned } = setup(purgedTaskWith({ cloudKey: 'attachments/orphan.pdf' }));
    webdavHeadFile.mockResolvedValueOnce({ exists: true, etag: 'W/"v1"', fingerprint: null, lastModified: null, contentLength: null });

    const result = await run();

    expect(webdavDeleteFileVersioned).not.toHaveBeenCalled();
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toEqual([
      expect.objectContaining({ cloudKey: 'attachments/orphan.pdf', attempts: 1 }),
    ]);
  });

  it('deletes local bytes only inside the managed attachment folders', async () => {
    const inside = setup(purgedTaskWith({ uri: `${MANAGED}orphan.pdf` }), { backend: 'off' });
    inside.memory.put(`${MANAGED}orphan.pdf`, new Uint8Array([1]));
    await inside.run();
    expect(inside.memory.read(`${MANAGED}orphan.pdf`)).toBeUndefined();
    expect(inside.options.logSyncInfo).not.toHaveBeenCalled();

    const outside = setup(purgedTaskWith({ uri: 'file:///storage/Download/orphan.pdf' }), { backend: 'off' });
    outside.memory.put('file:///storage/Download/orphan.pdf', new Uint8Array([1]));
    await outside.run();
    expect(outside.memory.read('file:///storage/Download/orphan.pdf')).toEqual(new Uint8Array([1]));
  });

  it('aborts after a native file barrier changes the snapshot, without deleting or processing the target', async () => {
    const uri = `${MANAGED}orphan.pdf`;
    const data = purgedTaskWith({ uri });
    const before = structuredClone(data);
    const abort = Object.assign(new Error('Snapshot changed'), { name: 'LocalSyncAbort' });
    let fresh = true;
    let finalGuardReached = false;
    const ensureLocalSnapshotFresh = vi.fn(() => { if (!fresh) throw abort; });
    const { run, memory, options } = setup(data, { backend: 'off', ensureLocalSnapshotFresh });
    memory.put(uri, new Uint8Array([1, 2, 3]));
    memory.fs.deleteUnlessKept = vi.fn(async (target, keep) => {
      await Promise.resolve();
      fresh = false;
      finalGuardReached = true;
      if (keep()) return false;
      await memory.fs.delete(target);
      return true;
    });

    await expect(run()).rejects.toBe(abort);

    expect(finalGuardReached).toBe(true);
    expect(memory.read(uri)).toEqual(new Uint8Array([1, 2, 3]));
    expect(memory.calls).not.toContain(`delete ${uri}`);
    expect(data).toEqual(before);
    expect(options.logSyncInfo).not.toHaveBeenCalled();
    expect(options.logSyncWarning).not.toHaveBeenCalled();
  });

  it.each([true, false])('acknowledges the guarded primitive result removed=%s using the original URI', async (removed) => {
    const uri = `${MANAGED}encoded%20name.pdf`;
    const { run, memory, options } = setup(purgedTaskWith({ uri }), { backend: 'off' });
    memory.put(uri, new Uint8Array([1]));
    const guardedDelete = vi.fn(async (target: string, keep: () => boolean) => {
      await Promise.resolve();
      expect(keep()).toBe(false);
      if (removed) await memory.fs.delete(target);
      return removed;
    });
    memory.fs.deleteUnlessKept = guardedDelete;

    const result = await run();

    expect(guardedDelete).toHaveBeenCalledWith(uri, expect.any(Function));
    expect(memory.read(uri)).toEqual(removed ? undefined : new Uint8Array([1]));
    expect(result.appData.tasks[0].attachments).toEqual([]);
    expect(options.logSyncInfo).toHaveBeenCalledWith('Attachment cleanup freshness guarded', {
      releaseCheck: 'v1.3.5/native-cleanup-freshness', outcome: removed ? 'removed' : 'retained',
    });
  });

  it('preserves successful guarded deletion when diagnostic logging throws', async () => {
    const uri = `${MANAGED}orphan.pdf`;
    const { run, memory, options } = setup(purgedTaskWith({ uri }), {
      backend: 'off', logSyncInfo: vi.fn(() => { throw new Error('Synthetic logging failure'); }),
    });
    memory.put(uri, new Uint8Array([1]));
    memory.fs.deleteUnlessKept = async (target, keep) => {
      if (keep()) return false;
      await memory.fs.delete(target);
      return true;
    };

    const result = await run();

    expect(memory.read(uri)).toBeUndefined();
    expect(result.appData.tasks[0].attachments).toEqual([]);
    expect(options.logSyncWarning).not.toHaveBeenCalled();
  });

  it('keeps File Sync bytes: another peer may still reselect that generation', async () => {
    const { run, webdavHeadFile, cloudDeleteFile } = setup(purgedTaskWith({ cloudKey: 'attachments/orphan.pdf' }), { backend: 'file' });

    const result = await run();

    expect(webdavHeadFile).not.toHaveBeenCalled();
    expect(cloudDeleteFile).not.toHaveBeenCalled();
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
  });

  it('ends the cycle on a Dropbox write conflict instead of logging it', async () => {
    const deleteDropboxAttachment = vi.fn(async () => { throw new DropboxConflictError(); });
    const { run } = setup(purgedTaskWith({ cloudKey: 'attachments/orphan.pdf' }), {
      backend: 'cloud',
      cloudProvider: 'dropbox',
      deleteDropboxAttachment,
    });

    await expect(run()).rejects.toBeInstanceOf(DropboxConflictError);
  });
});
