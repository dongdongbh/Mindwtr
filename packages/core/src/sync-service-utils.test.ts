import { describe, expect, it } from 'vitest';
import {
    canAutoSync,
    coerceSupportedSyncBackend,
    formatSyncErrorMessage,
    getFileSyncDir,
    isLikelyOfflineSyncError,
    isRemoteSyncBackend,
    isSyncFilePath,
    normalizeSyncBackend,
    resolveSyncBackend,
    sanitizeSyncErrorMessage,
} from './sync-service-utils';

describe('sync-service-utils', () => {
    it('normalizes sync backend values', () => {
        expect(normalizeSyncBackend('file')).toBe('file');
        expect(normalizeSyncBackend('webdav')).toBe('webdav');
        expect(normalizeSyncBackend('cloud')).toBe('cloud');
        expect(normalizeSyncBackend('cloudkit')).toBe('cloudkit');
        expect(normalizeSyncBackend('off')).toBe('off');
        expect(normalizeSyncBackend('invalid')).toBe('off');
        expect(normalizeSyncBackend(null)).toBe('off');
    });

    it('resolves supported backend capabilities', () => {
        expect(resolveSyncBackend('cloudkit')).toBe('cloudkit');
        expect(resolveSyncBackend('invalid')).toBe('off');
        expect(coerceSupportedSyncBackend('cloudkit', { allowCloudKit: false })).toBe('off');
        expect(coerceSupportedSyncBackend('cloudkit', { allowCloudKit: true })).toBe('cloudkit');
        expect(isRemoteSyncBackend('webdav')).toBe(true);
        expect(isRemoteSyncBackend('cloud')).toBe(true);
        expect(isRemoteSyncBackend('cloudkit')).toBe(true);
        expect(isRemoteSyncBackend('file')).toBe(false);
        expect(isRemoteSyncBackend('off')).toBe(false);
    });

    it('detects sync file paths using default names', () => {
        expect(isSyncFilePath('/storage/data.json')).toBe(true);
        expect(isSyncFilePath('/storage/mindwtr-sync.json')).toBe(true);
        expect(isSyncFilePath('/storage/other.json')).toBe(false);
    });

    it('resolves file sync base directory from file or folder paths', () => {
        expect(getFileSyncDir('/storage/folder/data.json')).toBe('/storage/folder');
        expect(getFileSyncDir('/storage/folder/mindwtr-sync.json')).toBe('/storage/folder');
        expect(getFileSyncDir('/storage/folder/')).toBe('/storage/folder');
    });

    it('evaluates autosync eligibility from normalized backend config', () => {
        expect(canAutoSync({ backend: 'off' })).toBe(false);
        expect(canAutoSync({ backend: 'cloudkit' })).toBe(true);
        expect(canAutoSync({ backend: 'file', filePath: '' })).toBe(false);
        expect(canAutoSync({ backend: 'file', filePath: '/tmp/data.json' })).toBe(true);
        expect(canAutoSync({ backend: 'webdav', webdavUrl: 'https://sync.example.com' })).toBe(true);
        expect(canAutoSync({ backend: 'cloud', cloudProvider: 'selfhosted', cloudUrl: '' })).toBe(false);
        expect(canAutoSync({ backend: 'cloud', cloudProvider: 'selfhosted', cloudUrl: 'https://sync.example.com' })).toBe(true);
        expect(canAutoSync({ backend: 'cloud', cloudProvider: 'dropbox', dropboxAppKey: 'key', isDropboxConnected: false })).toBe(false);
        expect(canAutoSync({ backend: 'cloud', cloudProvider: 'dropbox', dropboxAppKey: 'key', isDropboxConnected: true })).toBe(true);
    });

    it('redacts credentials from sync error messages', () => {
        const sanitized = sanitizeSyncErrorMessage('Authorization: Bearer abc123 password=hunter2 sk-test-1234567890');

        expect(sanitized).not.toContain('abc123');
        expect(sanitized).not.toContain('hunter2');
        expect(sanitized).not.toContain('sk-test-1234567890');
        expect(sanitized).toContain('[redacted]');
    });

    it('formats readonly file sync errors with actionable guidance', () => {
        const message = formatSyncErrorMessage(new Error("File '/tmp/data.json' is not writable"), 'file');

        expect(message).toContain('Sync file is not writable');
        expect(message).toContain('Re-select the sync folder');
    });

    it('formats webdav auth and rate limit errors', () => {
        const unauthorized = formatSyncErrorMessage(Object.assign(new Error('HTTP 401'), { status: 401 }), 'webdav');
        const rateLimited = formatSyncErrorMessage(Object.assign(new Error('HTTP 429'), { status: 429 }), 'webdav');

        expect(unauthorized).toContain('WebDAV unauthorized (401)');
        expect(rateLimited).toContain('WebDAV rate limited');
    });

    it('detects likely offline sync errors', () => {
        expect(isLikelyOfflineSyncError('Sync paused: offline state detected')).toBe(true);
        expect(isLikelyOfflineSyncError('TypeError: Network request failed')).toBe(true);
        expect(isLikelyOfflineSyncError('WebDAV unauthorized (401)')).toBe(false);
    });
});
