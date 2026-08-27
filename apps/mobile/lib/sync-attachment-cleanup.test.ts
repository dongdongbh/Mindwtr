import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasFreshAttachmentCleanupWork, LocalSyncAbort, type AppData } from '@mindwtr/core';

import * as AttachmentSyncUtils from './attachment-sync-utils';
import * as FileSystem from './file-system';
import { runMobileAttachmentCleanup } from './sync-attachment-cleanup';

const now = '2026-01-01T00:00:00.000Z';
const h1 = '1'.repeat(64);
const h2 = '2'.repeat(64);
const h1CloudKey = `attachments/live-attachment.${h1}.pdf`;
const h2CloudKey = `attachments/live-attachment.${h2}.pdf`;
const safSyncPath = 'content://provider/tree/root/document/root%3Amindwtr/data.json';
const safAttachmentsDir = 'content://provider/tree/root/document/root%3Amindwtr%2Fattachments';
const h1SafUri = `${safAttachmentsDir}%2Flive-attachment.${h1}.pdf`;
const h2SafUri = `${safAttachmentsDir}%2Flive-attachment.${h2}.pdf`;

const buildData = (): AppData => ({
  tasks: [
    {
      id: 'deleted-task',
      title: 'Deleted task',
      status: 'done',
      contexts: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
      purgedAt: now,
      attachments: [
        {
          id: 'deleted-attachment',
          kind: 'file',
          title: 'shared.pdf',
          uri: '',
          cloudKey: 'attachments/shared.pdf',
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    {
      id: 'live-task',
      title: 'Live task',
      status: 'next',
      contexts: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
      attachments: [
        {
          id: 'live-attachment',
          kind: 'file',
          title: 'shared.pdf',
          uri: '',
          cloudKey: 'attachments/shared.pdf',
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  ],
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
});

const buildCleanupOptions = (appData: AppData) => ({
  appData,
  backend: 'file' as const,
  webdavConfig: null,
  cloudConfig: null,
  cloudProvider: 'selfhosted' as const,
  fileSyncPath: '/sync/mindwtr.json',
  fetcher: vi.fn() as unknown as typeof fetch,
  ensureLocalSnapshotFresh: vi.fn(),
  deleteDropboxAttachment: vi.fn(async () => undefined),
  isRemoteMissingError: vi.fn(() => false),
  logSyncInfo: vi.fn(),
  logSyncWarning: vi.fn(),
});

const buildOrphanOnlyData = (): AppData => {
  const data = buildData();
  data.tasks = [data.tasks[0]];
  return data;
};

const buildSafGenerationCleanupData = (): AppData => {
  const data = buildData();
  const liveTask = data.tasks[1];
  const liveAttachment = liveTask.attachments?.[0];
  if (!liveAttachment) throw new Error('Test attachment unavailable');
  liveAttachment.cloudKey = h2CloudKey;
  data.tasks = [liveTask];
  data.settings = {
    attachments: {
      pendingRemoteDeletes: [
        { cloudKey: h1CloudKey, title: 'shared.pdf', attempts: 0 },
        { cloudKey: h2CloudKey, title: 'shared.pdf', attempts: 0 },
      ],
    },
  };
  return data;
};

const mockSafAttachmentsDirectory = () => {
  vi.spyOn(AttachmentSyncUtils, 'resolveFileSyncDir').mockResolvedValue({
    type: 'saf',
    dirUri: 'content://provider/tree/root/document/root%3Amindwtr',
    attachmentsDirUri: safAttachmentsDir,
  });
};

describe('runMobileAttachmentCleanup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not delete a remote attachment still referenced by another live task', async () => {
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);

    const result = await runMobileAttachmentCleanup(buildCleanupOptions(buildData()));

    expect(deleteAsync).not.toHaveBeenCalled();
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
    expect(result.appData.tasks.find((task) => task.id === 'live-task')?.attachments).toEqual([
      expect.objectContaining({
        id: 'live-attachment',
        cloudKey: 'attachments/shared.pdf',
      }),
    ]);
  });

  it('drops a stale pending remote delete when the cloud key is live again', async () => {
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);
    const data = buildData();
    data.settings = {
      attachments: {
        pendingRemoteDeletes: [
          {
            cloudKey: 'attachments/shared.pdf',
            title: 'shared.pdf',
            attempts: 1,
            lastErrorAt: now,
          },
        ],
      },
    };

    const result = await runMobileAttachmentCleanup(buildCleanupOptions(data));

    expect(deleteAsync).not.toHaveBeenCalled();
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
  });

  it('aborts before a remote delete when the snapshot becomes stale after target selection', async () => {
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);
    const deleteDropboxAttachment = vi.fn(async () => undefined);
    let freshnessChecks = 0;
    const ensureLocalSnapshotFresh = vi.fn(() => {
      freshnessChecks += 1;
      if (freshnessChecks === 2) throw new LocalSyncAbort();
    });

    await expect(runMobileAttachmentCleanup({
      ...buildCleanupOptions(buildOrphanOnlyData()),
      backend: 'cloud',
      cloudProvider: 'dropbox',
      ensureLocalSnapshotFresh,
      deleteDropboxAttachment,
    })).rejects.toBeInstanceOf(LocalSyncAbort);

    expect(deleteDropboxAttachment).not.toHaveBeenCalled();
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('rechecks freshness after Dropbox credential resolution and before provider deletion', async () => {
    const data = buildOrphanOnlyData();
    let stale = false;
    const providerDelete = vi.fn(async () => undefined);
    const ensureLocalSnapshotFresh = vi.fn(() => {
      if (stale) throw new LocalSyncAbort();
    });
    const deleteDropboxAttachment = vi.fn(async (
      _cloudKey: string,
      ensureBeforeProviderDelete: () => void,
    ) => {
      await Promise.resolve();
      stale = true;
      ensureBeforeProviderDelete();
      await providerDelete();
    });

    await expect(runMobileAttachmentCleanup({
      ...buildCleanupOptions(data),
      backend: 'cloud',
      cloudProvider: 'dropbox',
      ensureLocalSnapshotFresh,
      deleteDropboxAttachment,
    })).rejects.toBeInstanceOf(LocalSyncAbort);

    expect(deleteDropboxAttachment).toHaveBeenCalled();
    expect(providerDelete).not.toHaveBeenCalled();
  });

  it('does not swallow a stale-snapshot abort at the final local-file guard', async () => {
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);
    const data = buildOrphanOnlyData();
    const attachment = data.tasks[0].attachments?.[0];
    const managedBase = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
    expect(managedBase).toBeTruthy();
    if (!attachment || !managedBase) throw new Error('Test attachment directory unavailable');
    attachment.cloudKey = undefined;
    attachment.uri = `${managedBase.endsWith('/') ? managedBase : `${managedBase}/`}attachments/orphan.pdf`;
    let freshnessChecks = 0;
    const ensureLocalSnapshotFresh = vi.fn(() => {
      freshnessChecks += 1;
      if (freshnessChecks === 2) throw new LocalSyncAbort();
    });

    await expect(runMobileAttachmentCleanup({
      ...buildCleanupOptions(data),
      backend: 'off',
      ensureLocalSnapshotFresh,
    })).rejects.toBeInstanceOf(LocalSyncAbort);

    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('deletes only the superseded H1 generation from a SAF File Sync directory', async () => {
    mockSafAttachmentsDirectory();
    vi.spyOn(AttachmentSyncUtils, 'inspectSafDirectoryEntriesByName').mockResolvedValue({
      status: 'available',
      entries: new Map([
        [`live-attachment.${h1}.pdf`, h1SafUri],
        [`live-attachment.${h2}.pdf`, h2SafUri],
      ]),
    });
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);

    const result = await runMobileAttachmentCleanup({
      ...buildCleanupOptions(buildSafGenerationCleanupData()),
      fileSyncPath: safSyncPath,
    });

    expect(deleteAsync).toHaveBeenCalledTimes(1);
    expect(deleteAsync).toHaveBeenCalledWith(h1SafUri, { idempotent: true });
    expect(deleteAsync).not.toHaveBeenCalledWith(h2SafUri, expect.anything());
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
  });

  it('treats a successfully enumerated missing SAF generation as cleaned', async () => {
    mockSafAttachmentsDirectory();
    vi.spyOn(AttachmentSyncUtils, 'inspectSafDirectoryEntriesByName').mockResolvedValue({
      status: 'available',
      entries: new Map([[`live-attachment.${h2}.pdf`, h2SafUri]]),
    });
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);

    const result = await runMobileAttachmentCleanup({
      ...buildCleanupOptions(buildSafGenerationCleanupData()),
      fileSyncPath: safSyncPath,
    });

    expect(deleteAsync).not.toHaveBeenCalled();
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
  });

  it('records an unreadable SAF inventory as a retry and leaves the next cycle backed off', async () => {
    mockSafAttachmentsDirectory();
    vi.spyOn(AttachmentSyncUtils, 'inspectSafDirectoryEntriesByName').mockResolvedValue({
      status: 'unreadable',
    });
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);

    const result = await runMobileAttachmentCleanup({
      ...buildCleanupOptions(buildSafGenerationCleanupData()),
      fileSyncPath: safSyncPath,
    });

    expect(deleteAsync).not.toHaveBeenCalled();
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toEqual([
      expect.objectContaining({
        cloudKey: h1CloudKey,
        attempts: 1,
        lastErrorAt: expect.any(String),
      }),
    ]);
    expect(hasFreshAttachmentCleanupWork(result.appData)).toBe(false);
  });

  it('records a SAF delete failure as a retry instead of hot-looping at attempt zero', async () => {
    mockSafAttachmentsDirectory();
    vi.spyOn(AttachmentSyncUtils, 'inspectSafDirectoryEntriesByName').mockResolvedValue({
      status: 'available',
      entries: new Map([[`live-attachment.${h1}.pdf`, h1SafUri]]),
    });
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockRejectedValue(new Error('provider denied delete'));

    const result = await runMobileAttachmentCleanup({
      ...buildCleanupOptions(buildSafGenerationCleanupData()),
      fileSyncPath: safSyncPath,
    });

    expect(deleteAsync).toHaveBeenCalledWith(h1SafUri, { idempotent: true });
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toEqual([
      expect.objectContaining({
        cloudKey: h1CloudKey,
        attempts: 1,
        lastErrorAt: expect.any(String),
      }),
    ]);
    expect(hasFreshAttachmentCleanupWork(result.appData)).toBe(false);
  });

  it('never enumerates or deletes a legacy non-generation SAF key', async () => {
    const data = buildSafGenerationCleanupData();
    data.settings.attachments!.pendingRemoteDeletes = [
      { cloudKey: 'attachments/live-attachment.pdf', title: 'shared.pdf', attempts: 0 },
    ];
    const resolveFileSyncDir = vi.spyOn(AttachmentSyncUtils, 'resolveFileSyncDir');
    const inspectDirectory = vi.spyOn(AttachmentSyncUtils, 'inspectSafDirectoryEntriesByName');
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);

    const result = await runMobileAttachmentCleanup({
      ...buildCleanupOptions(data),
      fileSyncPath: safSyncPath,
    });

    expect(resolveFileSyncDir).not.toHaveBeenCalled();
    expect(inspectDirectory).not.toHaveBeenCalled();
    expect(deleteAsync).not.toHaveBeenCalled();
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toEqual([
      expect.objectContaining({
        cloudKey: 'attachments/live-attachment.pdf',
        attempts: 1,
      }),
    ]);
  });
});
