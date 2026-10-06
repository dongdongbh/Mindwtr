import { describe, expect, it, vi } from 'vitest';
import {
    isNativeAttachmentCleanupWitnessEligible as eligible,
    prepareNativeAttachmentCleanupWitness as prepare,
    NativeAttachmentCleanupUnconfirmedError,
    type NativeAttachmentCleanupProjection,
    type NativeAttachmentCleanupRawRow,
} from './native-attachment-cleanup';

const targetURI = 'file:///var/mobile/Containers/Data/Application/11111111-2222-4333-8444-555555555555/Library/attachment-files/selected.pdf';
const selected = { id: 'selected', kind: 'file', uri: targetURI, deletedAt: 'deleted', title: 'original', extra: { revision: 3 } };
const candidate = { attachmentID: selected.id, targetURI };
const row = (id = 'parent', attachments: unknown[] | null = [selected], purgedAt: string | null = null): NativeAttachmentCleanupRawRow => ({
    id, purgedAt, attachments: attachments === null ? null : JSON.stringify(attachments),
});
const projection = (tasks: NativeAttachmentCleanupRawRow[] = [row()], projects: NativeAttachmentCleanupRawRow[] = []): NativeAttachmentCleanupProjection => ({
    version: 1, tasks, projects,
});
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

describe('native bounded attachment cleanup witness', () => {
    it('provides a distinct fixed fatal error without input or cause', () => {
        const error = new NativeAttachmentCleanupUnconfirmedError();
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('NativeAttachmentCleanupUnconfirmedError');
        expect(error.message).toBe('Attachment cleanup could not be confirmed; retry the retained request');
        expect(error.cause).toBeUndefined();
        expect(new Error(error.message)).not.toBeInstanceOf(NativeAttachmentCleanupUnconfirmedError);
    });

    it.each(['task', 'project'] as const)('prepares and rechecks a %s attachment tombstone without changing input', (kind) => {
        const data = kind === 'task' ? projection() : projection([], [row()]);
        const before = JSON.stringify(data);
        Object.freeze(data.tasks); Object.freeze(data.projects); Object.freeze(data);
        const witness = prepare(data, Object.freeze({ ...candidate }));
        expect(witness).toEqual({
            version: 1, parentKind: kind, parentID: 'parent', parentPurgedAt: null,
            attachmentID: 'selected', targetURI, attachmentJSON: JSON.stringify(selected),
        });
        expect(eligible(data, witness)).toBe(true);
        expect(JSON.stringify(data)).toBe(before);
    });

    it.each(['task', 'project'] as const)('uses existing purged-parent eligibility for a live %s attachment', (kind) => {
        const live = { ...selected, deletedAt: null };
        const parent = row('parent', [live], 'purged');
        const data = kind === 'task' ? projection([parent]) : projection([], [parent]);
        const witness = prepare(data, candidate);
        expect(witness?.parentPurgedAt).toBe('purged');
        expect(eligible(data, witness)).toBe(true);
        expect(prepare(kind === 'task' ? projection([row('parent', [live])]) : projection([], [row('parent', [live])]), candidate)).toBeNull();
    });

    it.each(['task', 'project'] as const)('keeps processed %s tombstones even on purged parents, while allowing unprocessed orphans', (kind) => {
        const data = (entry: unknown, purgedAt: string | null) => kind === 'task'
            ? projection([row('parent', [entry], purgedAt)]) : projection([], [row('parent', [entry], purgedAt)]);
        for (const purgedAt of [null, 'purged']) {
            const processed = data({ ...selected, localStatus: 'missing' }, purgedAt);
            expect(prepare(processed, candidate)).toBeNull();
            expect(eligible(processed, prepare(data(selected, purgedAt), candidate))).toBe(false);
            expect(prepare(data({ ...selected, localStatus: 'available' }, purgedAt), candidate)).not.toBeNull();
            expect(prepare(data({ ...selected, localStatus: null }, purgedAt), candidate)).not.toBeNull();
        }
        expect(prepare(data({ ...selected, deletedAt: null, localStatus: 'missing' }, null), candidate)).toBeNull();
        expect(prepare(data({ ...selected, deletedAt: null, localStatus: 'missing' }, 'purged'), candidate)).not.toBeNull();
    });

    it('keeps live references on either parent kind, including restorable soft-deleted parents', () => {
        const live = { id: 'other', kind: 'file', uri: targetURI, cloudKey: 'attachments/other.pdf' };
        // The durable projection deliberately has no parent deletedAt: only purgedAt removes its references.
        expect(prepare(projection([row(), row('restorable-task', [live])]), candidate)).toBeNull();
        expect(prepare(projection([row()], [row('restorable-project', [live])]), candidate)).toBeNull();
        expect(prepare(projection([row()], [row('purged-project', [live], 'purged')]), candidate)).not.toBeNull();
        expect(prepare(projection([row()], [row('deleted-file', [{ ...live, deletedAt: 'deleted' }])]), candidate)).not.toBeNull();
    });

    it('keeps fixed same-container Apple aliases and decoded/encoded references without rewriting the target', () => {
        const alias = targetURI.replace('file:///var/', 'file:///private/var/');
        const live = { id: 'other', kind: 'link', uri: alias };
        expect(prepare(projection([row()], [row('alias', [live])]), candidate)).toBeNull();
        expect(prepare(projection([row('parent', [{ ...selected, uri: alias }])]), candidate)).toBeNull();
        const encoded = targetURI.replace('selected.pdf', 'selected%20file.pdf');
        expect(prepare(projection([row('parent', [{ ...selected, uri: encoded }])], [row('alias', [{ ...live, uri: encoded.replace('file://', '').replace('%20', ' ') }])]), {
            attachmentID: selected.id, targetURI: encoded,
        })).toBeNull();
        expect(prepare(projection(), candidate)?.targetURI).toBe(targetURI);
    });

    it('does not confuse a different container with the fixed alias', () => {
        const different = targetURI.replace('11111111-2222-4333-8444-555555555555', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect(prepare(projection([row()], [row('different', [{ id: 'other', kind: 'file', uri: different }])]), candidate)).not.toBeNull();
    });

    it.each([
        ['restored attachment', projection([row('parent', [{ ...selected, deletedAt: null }])])],
        ['new live reference', projection([row()], [row('new-ref', [{ id: 'other', kind: 'file', uri: targetURI }])])],
        ['moved parent', projection([row('replacement')])],
        ['moved kind', projection([], [row()])],
        ['changed parent purge marker', projection([row('parent', [selected], 'purged')])],
        ['changed metadata', projection([row('parent', [{ ...selected, extra: { revision: 4 } }])])],
        ['changed target', projection([row('parent', [{ ...selected, uri: targetURI + '.other' }])])],
        ['missing selected attachment', projection([row('parent', null)])],
    ])('retains after %s', (_reason, data) => {
        expect(eligible(data, prepare(projection(), candidate))).toBe(false);
    });

    it('retains on selected property-order changes while ignoring raw-cell whitespace and unrelated metadata', () => {
        const witness = prepare(projection(), candidate);
        const reordered = { title: selected.title, ...selected };
        expect(eligible(projection([row('parent', [reordered])]), witness)).toBe(false);
        const pretty = row(); pretty.attachments = JSON.stringify([selected], null, 2);
        expect(eligible(projection([pretty, row('unrelated', [{ id: 'unrelated', kind: 'link', uri: 'https://example.invalid', arbitrary: [1, null] }])]), witness)).toBe(true);
    });

    it('conservatively refuses every duplicate selected ID, independent of kind, eligibility or row order', () => {
        const duplicate = row('duplicate', [{ ...selected, uri: targetURI + '.different' }], 'purged');
        for (const data of [projection([row(), duplicate]), projection([duplicate, row()]), projection([row()], [duplicate]), projection([], [row(), duplicate]), projection([row('parent', [selected, selected])])]) {
            expect(prepare(data, candidate)).toBeNull();
            expect(eligible(data, prepare(projection(), candidate))).toBe(false);
        }
    });

    it('accepts arbitrary row order and the same parent ID in different kinds', () => {
        const data = projection([row('\u{10000}', null), row(), row('\ue000', null)], [row('parent', null)]);
        expect(prepare(data, candidate)).toEqual(prepare(projection(), candidate));
        expect(prepare(projection([...data.tasks].reverse(), data.projects), candidate)).toEqual(prepare(data, candidate));
    });

    it('returns no authority for a live file, link, missing ID or nonexact candidate URI', () => {
        expect(prepare(projection([row('parent', [{ ...selected, deletedAt: '' }])]), candidate)).toBeNull();
        expect(prepare(projection([row('parent', [{ ...selected, kind: 'link' }])]), candidate)).toBeNull();
        expect(prepare(projection(), { ...candidate, attachmentID: 'missing' })).toBeNull();
        expect(prepare(projection(), { ...candidate, targetURI: targetURI.replace('selected', '%73elected') })).toBeNull();
        expect(prepare(projection(), { ...candidate, targetURI: targetURI.replace('file:///var/', 'file:///private/var/') })).toBeNull();
    });

    it.each([
        null, {}, { version: 2, tasks: [], projects: [] }, { ...projection(), extra: 1 },
        { version: 1, tasks: {}, projects: [] }, { version: 1, tasks: [null], projects: [] },
        projection([{ ...row(), extra: 1 } as NativeAttachmentCleanupRawRow]),
        projection([{ ...row(), id: '' }]), projection([{ ...row(), id: 'x\0y' }]), projection([{ ...row(), id: 'x'.repeat(501) }]),
        projection([{ ...row(), purgedAt: '' }]), projection([{ ...row(), purgedAt: false } as unknown as NativeAttachmentCleanupRawRow]),
        projection([{ ...row(), attachments: [] } as unknown as NativeAttachmentCleanupRawRow]),
        projection([{ ...row(), attachments: '{' }]), projection([{ ...row(), attachments: '{}' }]),
        projection([row(), row()]), projection([], [row(), row()]),
    ])('rejects malformed projection %# with fixed redacted error', (data) => {
        expect(() => prepare(data, candidate)).toThrowError(/^INVALID_INPUT$/);
        expect(() => eligible(data, prepare(projection(), candidate))).toThrowError(/^INVALID_INPUT$/);
    });

    it.each([
        null, [], {}, { ...selected, id: '' }, { ...selected, id: 'x'.repeat(501) }, { ...selected, id: 'x\0y' },
        { ...selected, kind: 'image' }, { ...selected, uri: 3 }, { ...selected, uri: 'x\0y' },
        { ...selected, deletedAt: false }, { ...selected, cloudKey: {} },
        { ...selected, localStatus: false }, { ...selected, localStatus: 'unknown' },
    ])('rejects malformed policy-consumed attachment fields %#', (entry) => {
        expect(() => prepare(projection([row('parent', [entry])]), candidate)).toThrowError(/^INVALID_INPUT$/);
    });

    it('allows null optional durable fields and retains all unknown selected metadata', () => {
        const entry = { ...selected, deletedAt: null, cloudKey: null, unknown: ['é', { value: false }] };
        const data = projection([row('parent', [entry], 'purged')]);
        expect(prepare(data, candidate)?.attachmentJSON).toBe(JSON.stringify(entry));
    });

    it.each([null, {}, { ...candidate, extra: 1 }, { ...candidate, attachmentID: '' }, { ...candidate, targetURI: false }, { ...candidate, targetURI: '' }])('rejects malformed candidate %#', (input) => {
        expect(() => prepare(projection(), input)).toThrowError(/^INVALID_INPUT$/);
    });

    it.each([
        { version: 2 }, { extra: 1 }, { parentKind: 'area' }, { parentID: '' }, { parentPurgedAt: '' },
        { attachmentID: '' }, { targetURI: '' }, { targetURI: 'x\0y' }, { attachmentJSON: '{' },
        { attachmentJSON: JSON.stringify({ ...selected, id: 'different' }) },
        { attachmentJSON: JSON.stringify({ ...selected, kind: 'link' }) },
        { attachmentJSON: JSON.stringify({ ...selected, uri: 'different' }) },
        { attachmentJSON: JSON.stringify({ ...selected, cloudKey: 3 }) },
        { attachmentJSON: JSON.stringify({ ...selected, localStatus: 3 }) },
    ])('rejects malformed witness delta %#', (delta) => {
        expect(() => eligible(projection(), { ...prepare(projection(), candidate), ...delta })).toThrowError(/^INVALID_INPUT$/);
    });

    it('rejects accessors and hidden/symbol fields on the fixed wire without executing them', () => {
        const getter = vi.fn(() => []);
        const data = { ...projection() }; Object.defineProperty(data, 'tasks', { enumerable: true, get: getter });
        expect(() => prepare(data, candidate)).toThrowError(/^INVALID_INPUT$/);
        expect(getter).not.toHaveBeenCalled();
        const hidden = { ...candidate }; Object.defineProperty(hidden, 'hidden', { value: 1 });
        expect(() => prepare(projection(), hidden)).toThrowError(/^INVALID_INPUT$/);
        expect(() => prepare(projection(), { ...candidate, [Symbol('hidden')]: 1 })).toThrowError(/^INVALID_INPUT$/);
    });

    it('accepts the row-count boundary and refuses overflow rather than scanning a prefix', () => {
        const rows = Array.from({ length: 100_000 }, (_, index) => row(String(index), null));
        expect(prepare(projection(rows), candidate)).toBeNull();
        expect(() => prepare(projection([...rows, row('overflow', null)]), candidate)).toThrowError(/^INVALID_INPUT$/);
    });

    it('accepts 1000 attachments per row and refuses 1001 even when selected is first', () => {
        const entries = [selected, ...Array.from({ length: 999 }, (_, index) => ({ id: String(index), kind: 'link', uri: 'https://example.invalid' }))];
        expect(prepare(projection([row('parent', entries)]), candidate)).not.toBeNull();
        expect(() => prepare(projection([row('parent', [...entries, { id: 'overflow', kind: 'file', uri: 'other' }])]), candidate)).toThrowError(/^INVALID_INPUT$/);
    });

    it('counts URI UTF8 bytes independently of UTF16 length', () => {
        const uri = '😀'.repeat(4096);
        expect(bytes(uri)).toBe(16 * 1024);
        expect(prepare(projection([row('parent', [{ ...selected, uri }])]), { ...candidate, targetURI: uri })).not.toBeNull();
        expect(() => prepare(projection([row('parent', [{ ...selected, uri: uri + 'x' }])]), { ...candidate, targetURI: uri + 'x' })).toThrowError(/^INVALID_INPUT$/);
    });

    it('counts all raw scalar UTF8 bytes before any attachment parsing', () => {
        const limit = 8 * 1024 * 1024;
        const data = projection([{ id: 'x', purgedAt: '界'.repeat(Math.floor((limit - 1) / 3)), attachments: null }]);
        expect(prepare(data, candidate)).toBeNull();
        const overflowing = projection([{ ...data.tasks[0], purgedAt: data.tasks[0].purgedAt + '界', attachments: '{' }]);
        const parse = vi.spyOn(JSON, 'parse');
        try {
            expect(() => prepare(overflowing, candidate)).toThrowError(/^INVALID_INPUT$/);
            expect(parse).not.toHaveBeenCalled();
        } finally { parse.mockRestore(); }
    });

    it('enforces the serialized frame cap even when scalar bytes fit', () => {
        const data = projection([{ id: 'x', purgedAt: '\u0001'.repeat(2_800_000), attachments: '{' }]);
        expect(bytes(data.tasks[0].purgedAt!)).toBeLessThan(8 * 1024 * 1024);
        expect(bytes(JSON.stringify(data))).toBeGreaterThan(16 * 1024 * 1024);
        const parse = vi.spyOn(JSON, 'parse');
        try {
            expect(() => prepare(data, candidate)).toThrowError(/^INVALID_INPUT$/);
            expect(parse).not.toHaveBeenCalled();
        } finally { parse.mockRestore(); }
    });

    it('bounds the complete selected witness including Unicode unknown metadata', () => {
        const overhead = bytes(JSON.stringify({ ...selected, extra: '' }));
        const exact = { ...selected, extra: 'é'.repeat(Math.floor((64 * 1024 - overhead) / 2)) };
        if (bytes(JSON.stringify(exact)) < 64 * 1024) exact.extra += 'x';
        expect(bytes(JSON.stringify(exact))).toBe(64 * 1024);
        const data = projection([row('parent', [exact])]);
        const witness = prepare(data, candidate);
        expect(eligible(data, witness)).toBe(true);
        expect(() => prepare(projection([row('parent', [{ ...exact, extra: exact.extra + 'x' }])]), candidate)).toThrowError(/^INVALID_INPUT$/);
        expect(() => eligible(data, { ...witness, attachmentJSON: witness!.attachmentJSON + ' ' })).toThrowError(/^INVALID_INPUT$/);
    });

    it('bounds the full witness even when only the selected parent purge marker is large', () => {
        const initial = prepare(projection([row('parent', [selected], 'p')]), candidate)!;
        const overhead = bytes(JSON.stringify(initial)) - 1;
        const marker = 'p'.repeat(128 * 1024 - overhead);
        const data = projection([row('parent', [selected], marker)]);
        const witness = prepare(data, candidate)!;
        expect(bytes(witness.attachmentJSON)).toBeLessThan(64 * 1024);
        expect(bytes(JSON.stringify(witness))).toBe(128 * 1024);
        expect(eligible(data, witness)).toBe(true);
        expect(() => prepare(projection([row('parent', [selected], marker + 'p')]), candidate)).toThrowError(/^INVALID_INPUT$/);
        expect(() => eligible(data, { ...witness, parentPurgedAt: marker + 'p' })).toThrowError(/^INVALID_INPUT$/);
    });
});
