import { describe, expect, it, vi } from 'vitest';

import {
    isAttachmentPresenceRepairCandidate,
    repairMissingRemoteAttachments,
} from './attachment-presence-repair';
import { createDropboxAttachmentPresenceIndex } from './dropbox';
import type { Attachment } from './types';

const attachment = (overrides: Partial<Attachment> & Pick<Attachment, 'id'>): Attachment => ({
    kind: 'file',
    title: `${overrides.id}.txt`,
    uri: `/local/${overrides.id}.txt`,
    cloudKey: `attachments/${overrides.id}.txt`,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
});

describe('isAttachmentPresenceRepairCandidate', () => {
    it('accepts an uploaded, live file attachment', () => {
        expect(isAttachmentPresenceRepairCandidate(attachment({ id: 'a' }))).toBe(true);
    });

    it.each([
        ['never uploaded', { cloudKey: undefined }],
        ['deleted', { deletedAt: '2026-09-01T00:00:00.000Z' }],
        ['a link, not a file', { kind: 'link' as const }],
        ['already queued for a content upload', { pendingContentUpload: true }],
    ])('rejects an attachment that is %s', (_label, overrides) => {
        expect(isAttachmentPresenceRepairCandidate(attachment({ id: 'a', ...overrides }))).toBe(false);
    });
});

describe('repairMissingRemoteAttachments', () => {
    it('clears the cloud reference of a blob the remote definitively does not have', async () => {
        const gone = attachment({ id: 'gone' });
        const kept = attachment({ id: 'kept' });
        const clear = vi.fn((item: Attachment) => { item.cloudKey = undefined; });

        const result = await repairMissingRemoteAttachments({
            candidates: [gone, kept],
            probe: async (item) => item.id !== 'gone',
            clear,
        });

        expect(result).toEqual({ checked: 2, cleared: 1, complete: true });
        expect(gone.cloudKey).toBeUndefined();
        expect(kept.cloudKey).toBe('attachments/kept.txt');
        expect(clear).toHaveBeenCalledTimes(1);
    });

    it('leaves everything alone and stops when the probe cannot tell', async () => {
        const first = attachment({ id: 'first' });
        const second = attachment({ id: 'second' });
        const probe = vi.fn(async () => null);
        const clear = vi.fn();

        const result = await repairMissingRemoteAttachments({
            candidates: [first, second],
            probe,
            clear,
        });

        // One "don't know" ends the pass, and an incomplete pass must not advance the
        // caller's daily stamp.
        expect(result).toEqual({ checked: 1, cleared: 0, complete: false });
        expect(clear).not.toHaveBeenCalled();
        expect(first.cloudKey).toBe('attachments/first.txt');
        expect(second.cloudKey).toBe('attachments/second.txt');
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('a probe that throws is a failure, not an absence', async () => {
        const item = attachment({ id: 'boom' });
        await expect(repairMissingRemoteAttachments({
            candidates: [item],
            probe: async () => { throw new Error('network down'); },
            clear: () => { item.cloudKey = undefined; },
        })).rejects.toThrow('network down');
        expect(item.cloudKey).toBe('attachments/boom.txt');
    });

    it('stops at the per-pass ceiling but still counts as a completed pass', async () => {
        const candidates = ['a', 'b', 'c'].map((id) => attachment({ id }));
        const log = vi.fn();

        const result = await repairMissingRemoteAttachments({
            candidates,
            probe: async () => false,
            clear: (item) => { item.cloudKey = undefined; },
            maxChecks: 2,
            log,
        });

        expect(result).toEqual({ checked: 2, cleared: 2, complete: true });
        expect(candidates[2].cloudKey).toBe('attachments/c.txt');
        expect(log).toHaveBeenCalledWith(
            'Attachment presence pass reached the per-pass limit',
            { limit: '2' },
        );
    });

    it('never logs a field name containing "key", which the log sanitizer redacts', async () => {
        const log = vi.fn();
        await repairMissingRemoteAttachments({
            candidates: [attachment({ id: 'gone' })],
            probe: async () => false,
            clear: () => undefined,
            log,
        });

        for (const [, fields] of log.mock.calls) {
            for (const field of Object.keys(fields as Record<string, string>)) {
                expect(field.toLowerCase()).not.toContain('key');
            }
        }
    });
});

describe('createDropboxAttachmentPresenceIndex', () => {
    const index = createDropboxAttachmentPresenceIndex([
        { name: 'Kept.TXT', pathLower: '/attachments/kept.txt' },
    ]);

    it('matches a listed name case-insensitively, the way Dropbox paths work', () => {
        expect(index('attachments/kept.txt')).toBe(true);
        expect(index('attachments/KEPT.txt')).toBe(true);
    });

    it('reports a listed folder that does not hold the blob as definitively missing', () => {
        expect(index('attachments/gone.txt')).toBe(false);
    });

    it('refuses to judge a key that does not name a file in the attachments folder', () => {
        expect(index('cloudkit:attachment-1')).toBeNull();
        expect(index('attachments/nested/file.txt')).toBeNull();
        expect(index('attachments/')).toBeNull();
        expect(index('other/kept.txt')).toBeNull();
    });

    it('reports every blob missing when the folder itself came back empty', () => {
        // `listDropboxFolderFiles` returns [] both for an empty folder and for a folder that
        // no longer exists; either way Dropbox is not holding the blob.
        expect(createDropboxAttachmentPresenceIndex([])('attachments/kept.txt')).toBe(false);
    });
});
