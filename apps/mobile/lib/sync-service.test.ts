import { describe, expect, it } from 'vitest';
import {
  classifySyncFailure,
  getSyncConflictCount,
  getSyncMaxClockSkewMs,
  getSyncTimestampAdjustments,
  hasSameUserFacingSyncConflictSummary,
  formatSyncErrorMessage,
  getFileSyncBaseDir,
    isLikelyOfflineSyncError,
    isLikelyFilePath,
    normalizeFileSyncPath,
    isSyncFilePath,
    coerceSupportedBackend,
    resolveBackend,
} from './sync-service-utils';
import type { MergeStats } from '@mindwtr/core';

describe('mobile sync-service test utils', () => {
  const emptyEntityStats = {
    localTotal: 0,
    incomingTotal: 0,
    mergedTotal: 0,
    localOnly: 0,
    incomingOnly: 0,
    conflicts: 0,
    resolvedUsingLocal: 0,
    resolvedUsingIncoming: 0,
    deletionsWon: 0,
    conflictIds: [],
    maxClockSkewMs: 0,
    timestampAdjustments: 0,
    timestampAdjustmentIds: [],
    invalidTimestamps: 0,
    conflictReasonCounts: {},
    conflictSamples: [],
  };

  const emptyStats: MergeStats = {
    tasks: { ...emptyEntityStats },
    projects: { ...emptyEntityStats },
    sections: { ...emptyEntityStats },
    areas: { ...emptyEntityStats },
  };

  it('normalizes backend values', () => {
    expect(resolveBackend('file')).toBe('file');
    expect(resolveBackend('webdav')).toBe('webdav');
    expect(resolveBackend('cloud')).toBe('cloud');
    expect(resolveBackend('cloudkit')).toBe('cloudkit');
    expect(resolveBackend('off')).toBe('off');
    expect(resolveBackend('invalid')).toBe('off');
    expect(resolveBackend(null)).toBe('off');
  });

  it('coerces unsupported cloudkit backend to off', () => {
    expect(coerceSupportedBackend('cloudkit', false)).toBe('off');
    expect(coerceSupportedBackend('cloudkit', true)).toBe('cloudkit');
    expect(coerceSupportedBackend('webdav', false)).toBe('webdav');
  });

  it('formats WebDAV unauthorized errors with actionable text', () => {
    const error = Object.assign(new Error('HTTP 401'), { status: 401 });
    const message = formatSyncErrorMessage(error, 'webdav');
    expect(message).toContain('WebDAV unauthorized (401)');
  });

  it('formats WebDAV rate limit errors with actionable text', () => {
    const error = Object.assign(new Error('HTTP 429'), { status: 429 });
    const message = formatSyncErrorMessage(error, 'webdav');
    expect(message).toContain('WebDAV rate limited');
    expect(message).toContain('about a minute');
  });

  it('formats iOS temporary inbox file sync errors with provider guidance', () => {
    const error = new Error("Calling the 'writeAsStringAsync' function has failed -> File '/private/var/mobile/.../tmp/tech.dongdongbh.mindwtr-Inbox/data.json.tmp' is not writable");
    const message = formatSyncErrorMessage(error, 'file');
    expect(message).toContain('temporary Files copy');
    expect(message).toContain('iCloud Drive or WebDAV');
  });

  it('formats writable file sync errors with actionable text', () => {
    const error = new Error("File '/var/mobile/Containers/Data/Application/abc/Documents/MindWtr/data.json.tmp' is not writable");
    const message = formatSyncErrorMessage(error, 'file');
    expect(message).toContain('not writable');
    expect(message).toContain('Re-select the sync folder');
  });

  it('detects sync file paths and resolves base directory', () => {
    expect(isSyncFilePath('/storage/data.json')).toBe(true);
    expect(isSyncFilePath('/storage/mindwtr-sync.json')).toBe(true);
    expect(isSyncFilePath('/storage/folder')).toBe(false);
    expect(getFileSyncBaseDir('/storage/folder/data.json')).toBe('/storage/folder');
    expect(getFileSyncBaseDir('file:///var/mobile/Containers/Shared/AppGroup/mindwtr-backup-2026-02-25.json')).toBe('file:///var/mobile/Containers/Shared/AppGroup');
    expect(getFileSyncBaseDir('/storage/folder/')).toBe('/storage/folder');
  });

  it('detects likely file paths for custom sync filenames', () => {
    expect(isLikelyFilePath('/storage/folder/data.json')).toBe(true);
    expect(isLikelyFilePath('file:///var/mobile/Containers/Shared/AppGroup/mindwtr-backup-2026-02-25.json')).toBe(true);
    expect(isLikelyFilePath('/storage/folder')).toBe(false);
    expect(isLikelyFilePath('/storage/folder/')).toBe(false);
  });

  it('normalizes legacy iOS absolute sync paths to file uri', () => {
    expect(normalizeFileSyncPath('/var/mobile/Containers/Data/Application/abc/Documents/MindWtr/data.json', 'ios'))
      .toBe('file:///var/mobile/Containers/Data/Application/abc/Documents/MindWtr/data.json');
    expect(normalizeFileSyncPath('file:///var/mobile/Containers/Data/Application/abc/Documents/MindWtr/data.json', 'ios'))
      .toBe('file:///var/mobile/Containers/Data/Application/abc/Documents/MindWtr/data.json');
    expect(normalizeFileSyncPath('/storage/emulated/0/Download/data.json', 'android'))
      .toBe('/storage/emulated/0/Download/data.json');
  });

  it('detects likely offline sync errors', () => {
    expect(isLikelyOfflineSyncError('Sync paused: offline state detected')).toBe(true);
    expect(isLikelyOfflineSyncError('TypeError: Network request failed')).toBe(true);
    expect(isLikelyOfflineSyncError('java.net.UnknownHostException: Unable to resolve host')).toBe(true);
    expect(isLikelyOfflineSyncError('Software caused connection abort')).toBe(true);
    expect(isLikelyOfflineSyncError('request failed: ECONNRESET')).toBe(true);
    expect(isLikelyOfflineSyncError('AxiosError: connect ETIMEDOUT')).toBe(true);
    expect(isLikelyOfflineSyncError('WebDAV unauthorized (401). Check folder URL')).toBe(false);
  });

  it('classifies auth and permission sync failures for actionable messaging', () => {
    expect(classifySyncFailure('WebDAV unauthorized (401). Check folder URL, username, and app password.')).toBe('auth');
    expect(classifySyncFailure("Sync file is not writable. Re-select the sync folder in Settings -> Data & Sync, then sync again.")).toBe('permission');
  });

  it('classifies rate-limited, misconfigured, and conflict sync failures', () => {
    expect(classifySyncFailure('WebDAV rate limited. Sync paused briefly; try again in about a minute.')).toBe('rateLimited');
    expect(classifySyncFailure('WebDAV folder URL is not configured. Save WebDAV settings first.')).toBe('misconfigured');
    expect(classifySyncFailure('Sync conflict detected: stale remote state')).toBe('conflict');
  });

  it('summarizes merge stats across all synced entity types', () => {
    const stats: MergeStats = {
      ...emptyStats,
      tasks: { ...emptyStats.tasks, conflicts: 1, maxClockSkewMs: 1000, timestampAdjustments: 2, conflictIds: ['task-1'] },
      areas: { ...emptyStats.areas, conflicts: 2, maxClockSkewMs: 4000, timestampAdjustments: 3, conflictIds: ['area-1', 'area-2'] },
    };

    expect(getSyncConflictCount(stats)).toBe(3);
    expect(getSyncMaxClockSkewMs(stats)).toBe(4000);
    expect(getSyncTimestampAdjustments(stats)).toBe(5);
  });

  it('treats repeated merge summaries with the same conflicts as duplicates', () => {
    const previous: MergeStats = {
      ...emptyStats,
      tasks: { ...emptyStats.tasks, conflicts: 1, conflictIds: ['task-1'] },
      sections: { ...emptyStats.sections, conflicts: 1, conflictIds: ['section-1'] },
    };
    const current: MergeStats = {
      ...emptyStats,
      tasks: { ...emptyStats.tasks, conflicts: 1, conflictIds: ['task-1'] },
      sections: { ...emptyStats.sections, conflicts: 1, conflictIds: ['section-1'] },
    };

    expect(hasSameUserFacingSyncConflictSummary(current, previous)).toBe(true);
  });

  it('does not treat changed conflict ids as duplicate merge summaries', () => {
    const previous: MergeStats = {
      ...emptyStats,
      tasks: { ...emptyStats.tasks, conflicts: 1, conflictIds: ['task-1'] },
    };
    const current: MergeStats = {
      ...emptyStats,
      tasks: { ...emptyStats.tasks, conflicts: 1, conflictIds: ['task-2'] },
    };

    expect(hasSameUserFacingSyncConflictSummary(current, previous)).toBe(false);
  });
});
