import { describe, expect, it } from 'vitest';
import { getFileSyncDir, isSyncFilePath, normalizeSyncBackend } from './sync-service-utils';

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
});
