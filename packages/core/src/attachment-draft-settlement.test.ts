import { describe, expect, it } from 'vitest';
import type { Attachment } from './types';
import { planAttachmentDraftSettlement } from './attachment-draft-settlement';

const file = (id: string, uri = `file:///managed/${id}.txt`): Attachment => ({
    id,
    kind: 'file',
    title: `${id}.txt`,
    uri,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
});

const link = (id: string, uri = 'https://example.com'): Attachment => ({
    id,
    kind: 'link',
    title: uri,
    uri,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
});

describe('planAttachmentDraftSettlement', () => {
    it('cleans a draft-only file on discard but never treats a link as owned bytes', () => {
        const addedFile = file('added');
        expect(planAttachmentDraftSettlement({
            baselineAttachments: [],
            draftAttachments: [addedFile, link('link')],
            committedAttachments: [],
        })).toEqual([{ attachment: addedFile, reason: 'uncommitted-draft' }]);
    });

    it('keeps a newly committed file after save', () => {
        const added = file('added');
        expect(planAttachmentDraftSettlement({
            baselineAttachments: [],
            draftAttachments: [added],
            committedAttachments: [added],
        })).toEqual([]);
    });

    it('cleans a replaced baseline file only when the replacement commits', () => {
        const baseline = file('legacy');
        const pointer = link('legacy', 'file:///user/spec.txt');

        expect(planAttachmentDraftSettlement({
            baselineAttachments: [baseline],
            draftAttachments: [pointer],
            committedAttachments: [baseline],
        })).toEqual([]);
        expect(planAttachmentDraftSettlement({
            baselineAttachments: [baseline],
            draftAttachments: [pointer],
            committedAttachments: [pointer],
        })).toEqual([{ attachment: baseline, reason: 'replaced-baseline' }]);
    });

    it('cleans an abandoned replacement without deleting the baseline', () => {
        const baseline = file('same', 'file:///managed/same-old.txt');
        const replacement = file('same', 'file:///managed/same-new.txt');
        expect(planAttachmentDraftSettlement({
            baselineAttachments: [baseline],
            draftAttachments: [replacement],
            committedAttachments: [baseline],
        })).toEqual([{ attachment: replacement, reason: 'uncommitted-draft' }]);
    });

    it('cleans managed bytes after their soft-delete commits but keeps them on discard', () => {
        const baseline = file('removed');
        const deleted = { ...baseline, deletedAt: '2026-08-27T01:00:00.000Z' };

        expect(planAttachmentDraftSettlement({
            baselineAttachments: [baseline],
            draftAttachments: [deleted],
            committedAttachments: [baseline],
        })).toEqual([]);
        expect(planAttachmentDraftSettlement({
            baselineAttachments: [baseline],
            draftAttachments: [deleted],
            committedAttachments: [deleted],
        })).toEqual([{ attachment: baseline, reason: 'deleted-after-save' }]);
    });

    it('does not infer ownership loss from an omitted baseline record', () => {
        const baseline = file('existing');
        expect(planAttachmentDraftSettlement({
            baselineAttachments: [baseline],
            draftAttachments: [baseline],
            committedAttachments: [],
        })).toEqual([]);
    });
});
