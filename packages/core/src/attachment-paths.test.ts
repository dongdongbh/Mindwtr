import { describe, expect, it } from 'vitest';
import {
    ATTACHMENTS_DIR_NAME,
    buildCloudKey,
    buildFileSyncGenerationCloudKey,
    extractExtension,
    getBaseSyncUrl,
    getCloudBaseUrl,
    isFileSyncGenerationCloudKey,
} from './attachment-paths';
import type { Attachment } from './types';

const makeAttachment = (overrides: Partial<Attachment> = {}): Attachment => ({
    id: 'att-1',
    kind: 'file',
    title: 'photo.png',
    uri: 'file:///tmp/photo.png',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
} as Attachment);

describe('attachment-paths', () => {
    it('pins the cloud-key wire format desktop and mobile must agree on', () => {
        expect(buildCloudKey(makeAttachment())).toBe(`${ATTACHMENTS_DIR_NAME}/att-1.png`);
    });

    it('falls back to the uri extension when the title has none', () => {
        expect(buildCloudKey(makeAttachment({ title: 'photo', uri: 'https://example.com/x/photo.jpg?x=1' })))
            .toBe(`${ATTACHMENTS_DIR_NAME}/att-1.jpg`);
    });

    it('produces no extension when neither title nor uri has one', () => {
        expect(buildCloudKey(makeAttachment({ title: 'photo', uri: 'file:///tmp/photo' })))
            .toBe(`${ATTACHMENTS_DIR_NAME}/att-1`);
    });

    it('binds File Sync keys to an immutable lowercase content generation', () => {
        const hash = 'A'.repeat(64);
        const key = `${ATTACHMENTS_DIR_NAME}/att-1.${hash.toLowerCase()}.png`;
        expect(buildFileSyncGenerationCloudKey(makeAttachment(), hash)).toBe(key);
        expect(isFileSyncGenerationCloudKey(key)).toBe(true);
        expect(isFileSyncGenerationCloudKey(`${ATTACHMENTS_DIR_NAME}/att-1.${hash.toLowerCase()}`)).toBe(true);
        expect(isFileSyncGenerationCloudKey(`${ATTACHMENTS_DIR_NAME}/att-1.${hash}.png`)).toBe(false);
        expect(isFileSyncGenerationCloudKey(`${ATTACHMENTS_DIR_NAME}/att-1.png`)).toBe(false);
        expect(() => buildFileSyncGenerationCloudKey(makeAttachment(), 'not-a-hash'))
            .toThrow('requires a SHA-256 digest');
    });

    it('extractExtension ignores query strings and fragments', () => {
        expect(extractExtension('https://example.com/a/b.PDF?x=1#y')).toBe('.pdf');
        expect(extractExtension(undefined)).toBe('');
    });

    it('getBaseSyncUrl strips a trailing data.json filename', () => {
        expect(getBaseSyncUrl('https://dav.example.com/mindwtr/data.json')).toBe('https://dav.example.com/mindwtr');
        expect(getBaseSyncUrl('https://dav.example.com/mindwtr/')).toBe('https://dav.example.com/mindwtr');
    });

    it('getCloudBaseUrl strips a trailing /data endpoint', () => {
        expect(getCloudBaseUrl('https://cloud.example.com/v1/data')).toBe('https://cloud.example.com/v1');
        expect(getCloudBaseUrl('https://cloud.example.com/v1/data/')).toBe('https://cloud.example.com/v1');
    });

    // #781: a bare host URL syncs data fine (normalizeCloudUrl adds /v1/data) but
    // used to send attachments to /attachments/..., which the server 404s.
    it('getCloudBaseUrl keeps the API version the data endpoint uses', () => {
        expect(getCloudBaseUrl('https://cloud.example.com')).toBe('https://cloud.example.com/v1');
        expect(getCloudBaseUrl('https://cloud.example.com/')).toBe('https://cloud.example.com/v1');
        expect(getCloudBaseUrl('https://cloud.example.com/v1')).toBe('https://cloud.example.com/v1');
        expect(getCloudBaseUrl('https://cloud.example.com/v2')).toBe('https://cloud.example.com/v2');
        expect(getCloudBaseUrl('https://cloud.example.com/mindwtr/')).toBe('https://cloud.example.com/mindwtr/v1');
    });
});
