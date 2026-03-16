import { describe, expect, it } from 'vitest';
import {
  formatSyncErrorMessage,
  getFileSyncBaseDir,
  isLikelyOfflineSyncError,
  isLikelyFilePath,
  normalizeFileSyncPath,
  isSyncFilePath,
  resolveBackend,
} from './sync-service-utils';

describe('mobile sync-service test utils', () => {
  it('normalizes backend values', () => {
    expect(resolveBackend('file')).toBe('file');
    expect(resolveBackend('webdav')).toBe('webdav');
    expect(resolveBackend('cloud')).toBe('cloud');
    expect(resolveBackend('cloudkit')).toBe('cloudkit');
    expect(resolveBackend('off')).toBe('off');
    expect(resolveBackend('invalid')).toBe('off');
    expect(resolveBackend(null)).toBe('off');
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
});
