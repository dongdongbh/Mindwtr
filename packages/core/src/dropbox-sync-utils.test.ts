import { describe, expect, it } from 'vitest';
import {
    isDropboxPathConflictTag,
    isDropboxPathNotFoundTag,
    parseDropboxApiErrorTag,
    parseDropboxMetadataRev,
    resolveDropboxPath,
} from './dropbox-sync-utils';

const buildJsonResponse = (payload: unknown): { json: () => Promise<unknown> } => ({
    json: async () => payload,
});

describe('dropbox-sync-utils', () => {
    it('parses rev from metadata header payload', () => {
        expect(parseDropboxMetadataRev('{"rev":"0153abc"}')).toEqual({ rev: '0153abc' });
        expect(parseDropboxMetadataRev('not-json')).toEqual({ rev: null });
    });

    it('parses nested Dropbox error tags', async () => {
        await expect(
            parseDropboxApiErrorTag(buildJsonResponse({ error: { '.tag': 'path', path: { '.tag': 'conflict' } } }))
        ).resolves.toBe('path/conflict');
        await expect(
            parseDropboxApiErrorTag(buildJsonResponse({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }))
        ).resolves.toBe('path/not_found');
        await expect(
            parseDropboxApiErrorTag(buildJsonResponse({ error: { '.tag': 'path_lookup', path_lookup: { '.tag': 'not_found' } } }))
        ).resolves.toBe('path_lookup/not_found');
        await expect(
            parseDropboxApiErrorTag(buildJsonResponse({ error_summary: 'path_lookup/not_found/..' }))
        ).resolves.toBe('path_lookup/not_found');
    });

    it('detects only path conflict tags as conflicts', () => {
        expect(isDropboxPathConflictTag('path')).toBe(true);
        expect(isDropboxPathConflictTag('path/conflict')).toBe(true);
        expect(isDropboxPathConflictTag('path/not_found')).toBe(false);
    });

    it('detects only explicit path-not-found tags as missing', () => {
        expect(isDropboxPathNotFoundTag('path/not_found')).toBe(true);
        expect(isDropboxPathNotFoundTag('path_lookup/not_found')).toBe(true);
        expect(isDropboxPathNotFoundTag('path')).toBe(false);
        expect(isDropboxPathNotFoundTag('too_many_write_operations')).toBe(false);
    });

    it('normalizes dropbox paths with a leading slash', () => {
        expect(resolveDropboxPath('attachments/a.bin')).toBe('/attachments/a.bin');
        expect(resolveDropboxPath('/attachments/a.bin')).toBe('/attachments/a.bin');
        expect(() => resolveDropboxPath('   ')).toThrow('Dropbox path is required');
    });
});
