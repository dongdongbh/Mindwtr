import { describe, expect, it } from 'vitest';
import type { AppData, Attachment, Task } from './types';
import { formatActivationMissingAttachments, isAttachmentKeptWithoutFile, isUnreachableAttachment, rememberUnreachableAttachments, parseUnreachableAttachments, pruneUnreachableAttachments } from './unreachable-attachments';

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
    it('reads only well-formed entries', () => {
        expect(parseUnreachableAttachments('not json')).toEqual({});
        expect(parseUnreachableAttachments(JSON.stringify({ s: { a1: ['k', 3], a2: 'x' }, t: [] }))).toEqual({ s: { a1: ['k'] } });
    });

    it('matches a recorded id only while it carries a recorded key', () => {
        const record = { s: { a1: ['k-old'] } };
        expect(isUnreachableAttachment(record, file())).toBe(true);
        expect(isUnreachableAttachment(record, file({ cloudKey: 'k-new' }))).toBe(false);
        expect(isUnreachableAttachment(record, file({ cloudKey: undefined }))).toBe(false);
    });

    it('keeps an entry while its row is still missing and answers the same object', () => {
        const record = { s: { a1: ['k-old'] } };
        expect(pruneUnreachableAttachments(record, data([file()]), 's')).toBe(record);
    });

    it.each([
        ['the file is here again', data([file({ localStatus: 'available' })])],
        ['the row is deleted', data([file({ deletedAt: STAMP })])],
        ['the owner is deleted', data([file()], true)],
        ['the row is gone', data([])],
        ['a new key was uploaded at this location', data([file({ cloudKey: 'k-new' })])],
    ])('drops an entry when %s', (_case, current) => {
        expect(pruneUnreachableAttachments({ s: { a1: ['k-old'] } }, current, 's')).toEqual({});
    });

    it('judges a new key only for the active location', () => {
        const record = { other: { a1: ['k-old'] } };
        expect(pruneUnreachableAttachments(record, data([file({ cloudKey: 'k-new' })]), 's')).toBe(record);
    });

    it('lists the first files and counts the rest', () => {
        const files = ['a', 'b', 'c'].map((name, index) => ({
            id: `id-${index}`, ownerType: 'task' as const, ownerId: 't', title: `${name}.pdf`, ownerTitle: index === 0 ? 'Taxes' : '',
        }));
        expect(formatActivationMissingAttachments(files, (count) => `and ${count} more`, 2))
            .toBe('• a.pdf (Taxes)\n• b.pdf\nand 1 more');
    });

    it('labels a row from the record this process last saw', () => {
        rememberUnreachableAttachments({ s: { a1: ['k-old'] } });
        expect(isAttachmentKeptWithoutFile(file())).toBe(true);
        rememberUnreachableAttachments({});
        expect(isAttachmentKeptWithoutFile(file())).toBe(false);
    });
});
