import { afterEach, describe, expect, it } from 'vitest';
import type { AppData, Attachment, Task } from './types';
import { formatActivationMissingAttachments, isAttachmentKeptWithoutFile, rememberUnreachableAttachments, parseUnreachableAttachments, pruneUnreachableAttachments } from './unreachable-attachments';

const STAMP = '2026-07-01T00:00:00.000Z';
const file = (overrides: Partial<Attachment> = {}): Attachment => ({
    id: 'a1', kind: 'file', title: 'scan.pdf', uri: '', cloudKey: 'k-old', localStatus: 'missing',
    createdAt: STAMP, updatedAt: STAMP, ...overrides,
});
const data = (attachments: Attachment[], taskDeleted = false): AppData => ({
    tasks: [{
        id: 't1', title: 'Task', status: 'inbox', createdAt: STAMP, updatedAt: STAMP, attachments,
        ...(taskDeleted ? { deletedAt: STAMP } : {}),
    } as Task],
    projects: [], sections: [], areas: [], people: [], settings: {},
});

describe('unreachable attachment record', () => {
    afterEach(() => rememberUnreachableAttachments({}, null));

    it('reads only well-formed entries', () => {
        expect(parseUnreachableAttachments('not json')).toEqual({});
        expect(parseUnreachableAttachments(JSON.stringify({ s: ['a1', 3, ''], t: 'x', u: [] }))).toEqual({ s: ['a1'] });
    });

    it('keeps an id while its row is still missing, or has its file with an upload pending, and answers the same object', () => {
        const record = { s: ['a1'] };
        expect(pruneUnreachableAttachments(record, data([file()]), 's')).toBe(record);
        expect(pruneUnreachableAttachments(record, data([file({ localStatus: 'available', pendingContentUpload: true })]), 's')).toBe(record);
    });

    it.each([
        ['its file is here with nothing to upload', data([file({ uri: '/f', localStatus: 'available' })])],
        ['the row is deleted', data([file({ deletedAt: STAMP })])],
        ['the owner is deleted', data([file()], true)],
        ['the row is gone', data([])],
    ])('drops an id when %s', (_case, current) => {
        expect(pruneUnreachableAttachments({ s: ['a1'] }, current, 's')).toEqual({});
    });

    it('judges a file being here only for the active location', () => {
        const record = { other: ['a1'] };
        expect(pruneUnreachableAttachments(record, data([file({ uri: '/f', localStatus: 'available' })]), 's')).toBe(record);
        expect(pruneUnreachableAttachments(record, data([]), 's')).toEqual({});
    });

    it('lists the first files and counts the rest', () => {
        const files = ['a', 'b', 'c'].map((name, index) => ({
            id: `id-${index}`, ownerType: 'task' as const, ownerId: 't', title: `${name}.pdf`, ownerTitle: index === 0 ? 'Taxes' : '',
        }));
        expect(formatActivationMissingAttachments(files, (count) => `and ${count} more`, 2))
            .toBe('• a.pdf (Taxes)\n• b.pdf\nand 1 more');
    });

    it('labels a row from the record and location this process last saw', () => {
        rememberUnreachableAttachments({ s: ['a1'] });
        // The location is not known yet: any location counts.
        expect(isAttachmentKeptWithoutFile(file())).toBe(true);
        rememberUnreachableAttachments({ s: ['a1'] }, 'other');
        expect(isAttachmentKeptWithoutFile(file())).toBe(false);
        // The on-demand download refreshes the record and keeps the location.
        rememberUnreachableAttachments({ other: ['a1'] });
        expect(isAttachmentKeptWithoutFile(file())).toBe(true);
        rememberUnreachableAttachments({}, 'other');
        expect(isAttachmentKeptWithoutFile(file())).toBe(false);
    });
});
