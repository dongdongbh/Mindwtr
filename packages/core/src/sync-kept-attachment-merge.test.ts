import { describe, expect, it } from 'vitest';
import type { AppData, Task } from './types';
import { mergeAppData } from './sync';
import { normalizeAppData } from './sync-normalization';
import { sanitizeAppDataForRemote } from './sync-helpers';

// A row kept without its file (unreachable-attachments.ts) at this location: once another device
// uploads the file here, the merge must take that device's key, whatever key format each location uses.
const STAMP = '2026-07-01T00:00:00.000Z';
const HASH = 'a'.repeat(64);
const doc = (cloudKey: string, extra: object = {}): AppData => normalizeAppData({
    tasks: [{
        id: 't1', title: 'T', status: 'inbox', createdAt: STAMP, updatedAt: STAMP,
        attachments: [{ id: 'att', kind: 'file', title: 'scan.pdf', uri: '', cloudKey, fileHash: HASH, localStatus: 'missing', createdAt: STAMP, updatedAt: STAMP, ...extra }],
    } as Task],
    projects: [], sections: [], areas: [], people: [], settings: {},
});
const keyOf = (data: AppData) => data.tasks[0]!.attachments![0]!.cloudKey;

describe('merge of an attachment kept without its file', () => {
    it.each([
        // The kept key sorts after the uploaded one, and before it.
        ['cloudkit:att', 'attachments/att.pdf'],
        ['attachments/att.pdf', `attachments/att.${'f'.repeat(64)}.pdf`],
    ])('takes the key another device uploaded here (kept %s, uploaded %s)', (keptKey, uploadedKey) => {
        const local = doc(keptKey);
        const incoming = sanitizeAppDataForRemote(doc(uploadedKey, { uri: '/b/scan.pdf', localStatus: 'available' })) as AppData;
        const kept = new Set(['att']);

        expect(keyOf(mergeAppData(local, incoming, { preferIncomingAttachmentCloudKeyIds: kept }))).toBe(uploadedKey);
        // Without the record the merge keeps its deterministic winner.
        expect(keyOf(mergeAppData(local, incoming))).toBe([keptKey, uploadedKey].sort().pop());
    });

    it('keeps the local key when the incoming row has none', () => {
        const kept = new Set(['att']);
        const local = doc('attachments/att.pdf');
        const keyless = doc('attachments/x.pdf');
        delete keyless.tasks[0]!.attachments![0]!.cloudKey;

        expect(keyOf(mergeAppData(local, keyless, { preferIncomingAttachmentCloudKeyIds: kept }))).toBe('attachments/att.pdf');
    });
});
