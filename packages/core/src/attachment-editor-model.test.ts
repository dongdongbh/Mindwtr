import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    addPickedAttachment,
    describeAttachmentUriForLog,
    findTaskDraftAttachmentForIdentity,
    getAttachmentRowState,
    mergeTaskDraftAttachments,
    planAttachmentOpen,
    preparePickedAttachment,
    persistPreparedPickedAttachment,
    resolveAttachmentViewMimeType,
    type PickedAttachmentAsset,
} from './attachment-editor-model';
import { getAttachmentDownloadIdentity, hasAttachmentDownloadIdentity } from './mobile-attachment-availability';
import { rememberUnreachableAttachments } from './unreachable-attachments';
import type { Attachment } from './types';

const AT = '2026-09-01T00:00:00.000Z';
const file = (id: string, fields: Partial<Attachment> = {}): Attachment => ({
    id, kind: 'file', title: `${id}.pdf`, uri: `file:///a/${id}.pdf`, createdAt: AT, updatedAt: AT, ...fields,
});
const t = (key: string) => key;

describe('picked attachment preparation and persistence', () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    const cases: {
        name: string;
        source: 'file' | 'image';
        asset: PickedAttachmentAsset;
        metadata?: { title: string; mimeType?: string; size?: number };
        refusal?: string;
    }[] = [
        { name: 'file metadata', source: 'file', asset: { uri: 'content://picked/report', name: 'Report.PDF', mimeType: 'application/pdf', size: 4 }, metadata: { title: 'Report.PDF', mimeType: 'application/pdf', size: 4 } },
        { name: 'image fileName and fileSize precedence', source: 'image', asset: { uri: 'file:///pick/x.jpg', name: 'ignored', fileName: 'Photo.PNG', mimeType: 'image/png', size: 8, fileSize: 6 }, metadata: { title: 'Photo.PNG', mimeType: 'image/png', size: 6 } },
        { name: 'empty file title fallback', source: 'file', asset: { uri: 'file:///pick/source.pdf', name: '' }, metadata: { title: 'file' } },
        { name: 'image URI leaf fallback', source: 'image', asset: { uri: 'file:///pick/source.jpg', fileName: '' }, metadata: { title: 'source.jpg' } },
        { name: 'empty image leaf fallback', source: 'image', asset: { uri: 'file:///pick/' }, metadata: { title: 'image' } },
        { name: 'unknown file size', source: 'file', asset: { uri: 'file:///pick/source', name: 'Unknown' }, metadata: { title: 'Unknown' } },
        { name: 'null picker metadata', source: 'file', asset: { uri: 'file:///pick/source', name: null, mimeType: null, size: null }, metadata: { title: 'file' } },
        { name: 'image validates size fallback but stores only fileSize', source: 'image', asset: { uri: 'file:///pick/source.jpg', size: 7 }, metadata: { title: 'source.jpg' } },
        { name: 'null image fileSize validates fallback but remains absent', source: 'image', asset: { uri: 'file:///pick/source.jpg', size: 7, fileSize: null }, metadata: { title: 'source.jpg' } },
        { name: 'zero image fileSize takes precedence', source: 'image', asset: { uri: 'file:///pick/source.jpg', size: 7, fileSize: 0 }, metadata: { title: 'source.jpg', size: 0 } },
        { name: 'zero byte file', source: 'file', asset: { uri: 'file:///pick/empty', size: 0 }, metadata: { title: 'file', size: 0 } },
        { name: 'unknown size preserves existing MIME validation timing', source: 'file', asset: { uri: 'file:///pick/binary', mimeType: 'application/x-executable' }, metadata: { title: 'file', mimeType: 'application/x-executable' } },
        { name: 'blocked MIME with known size', source: 'file', asset: { uri: 'file:///pick/binary', mimeType: ' APPLICATION/X-EXECUTABLE ', size: 1 }, refusal: 'attachments.invalidFileType' },
        { name: 'oversized file', source: 'file', asset: { uri: 'file:///pick/large', size: 50 * 1024 * 1024 + 1 }, refusal: 'attachments.fileTooLarge' },
        { name: 'non-finite picker size', source: 'file', asset: { uri: 'file:///pick/source', size: Number.NaN }, refusal: 'attachments.fileNotSupported' },
        { name: 'infinite picker size', source: 'file', asset: { uri: 'file:///pick/source', size: Number.POSITIVE_INFINITY }, refusal: 'attachments.fileNotSupported' },
    ];

    it.each(cases)('preserves RN Add and split preparation policy: $name', async ({ source, asset, metadata, refusal }) => {
        vi.useFakeTimers(); vi.setSystemTime(AT);
        const directId = vi.fn(() => 'picked-id');
        const preparedId = vi.fn(() => 'picked-id');
        const persist = vi.fn(async (attachment: Attachment) => ({ ...attachment, uri: 'file:///managed/picked-id' }));
        const prepared = await preparePickedAttachment({ source, asset, newId: preparedId, t });
        expect(persist).not.toHaveBeenCalled();
        const direct = await addPickedAttachment({ source, asset, newId: directId, persist, t });
        if (refusal) {
            expect(prepared).toEqual({ kind: 'refused', message: refusal });
            expect(direct).toEqual(prepared);
            expect(directId).not.toHaveBeenCalled();
            expect(preparedId).not.toHaveBeenCalled();
            expect(persist).not.toHaveBeenCalled();
            return;
        }
        expect(prepared.kind).toBe('prepared');
        if (prepared.kind !== 'prepared') throw new Error('Expected prepared attachment');
        const expected: Attachment = {
            id: 'picked-id', kind: 'file', title: metadata!.title, uri: asset.uri,
            mimeType: metadata!.mimeType, size: metadata!.size,
            createdAt: AT, updatedAt: AT, localStatus: 'available',
        };
        expect(prepared.attachment).toEqual(expected);
        const split = await persistPreparedPickedAttachment({ prepared, persist, t });
        expect(direct).toEqual({ kind: 'added', attachment: { ...expected, uri: 'file:///managed/picked-id' } });
        expect(split).toEqual(direct);
        expect(directId).toHaveBeenCalledTimes(1);
        expect(preparedId).toHaveBeenCalledTimes(1);
        expect(persist).toHaveBeenCalledTimes(2);
    });

    it('reuses the complete retained preparation after clock advance, asset mutation and repeated persistence', async () => {
        vi.useFakeTimers(); vi.setSystemTime(AT);
        const asset: PickedAttachmentAsset = { uri: 'file:///pick/original', name: 'Original.PDF', mimeType: 'application/pdf', size: 3 };
        const newId = vi.fn(() => 'original-id');
        const prepared = await preparePickedAttachment({ source: 'file', asset, newId, t });
        if (prepared.kind !== 'prepared') throw new Error('Expected prepared attachment');
        const retained = { ...prepared, attachment: { ...prepared.attachment } };
        Object.assign(asset, { uri: 'file:///pick/replaced', name: 'Changed', mimeType: 'text/plain', size: 99 });
        vi.setSystemTime('2026-10-05T12:00:00.000Z');
        const observed: Attachment[] = [];
        const persist = vi.fn(async (attachment: Attachment) => {
            observed.push({ ...attachment });
            // Platform code remains free to mutate its argument.
            attachment.title = 'Platform mutation';
            return { ...observed.at(-1)!, uri: 'file:///managed/original-id.pdf' };
        });
        const first = await persistPreparedPickedAttachment({ prepared: retained, persist, t });
        const replay = await persistPreparedPickedAttachment({ prepared: retained, persist, t });
        expect(observed).toEqual([prepared.attachment, prepared.attachment]);
        expect(retained).toEqual(prepared);
        expect(first).toEqual(replay);
        expect(first).toMatchObject({ kind: 'added', attachment: { id: 'original-id', title: 'Original.PDF', size: 3, createdAt: AT, updatedAt: AT } });
        expect(newId).toHaveBeenCalledTimes(1);
    });

    it('refuses unchanged URIs in both entry points', async () => {
        const input = { source: 'file' as const, asset: { uri: 'file:///pick/unreadable' }, newId: () => 'id', t };
        const persist = vi.fn(async (attachment: Attachment) => ({ ...attachment }));
        const prepared = await preparePickedAttachment(input);
        if (prepared.kind !== 'prepared') throw new Error('Expected prepared attachment');
        const refused = { kind: 'refused', message: 'attachments.fileNotReadable' };
        await expect(persistPreparedPickedAttachment({ prepared, persist, t })).resolves.toEqual(refused);
        await expect(addPickedAttachment({ ...input, persist })).resolves.toEqual(refused);
    });

    it('preserves URI comparison when a mutable platform port returns its mutated argument', async () => {
        const prepared = await preparePickedAttachment({ source: 'file', asset: { uri: 'file:///pick/source' }, newId: () => 'id', t });
        if (prepared.kind !== 'prepared') throw new Error('Expected prepared attachment');
        const persist = async (attachment: Attachment) => { attachment.uri = 'file:///managed/id'; return attachment; };
        await expect(persistPreparedPickedAttachment({ prepared, persist, t })).resolves.toEqual({ kind: 'refused', message: 'attachments.fileNotReadable' });
        expect(prepared.attachment.uri).toBe('file:///pick/source');
    });

    it('propagates persistence errors without changing the retained preparation', async () => {
        const input = { source: 'file' as const, asset: { uri: 'file:///pick/source' }, newId: () => 'id', t };
        const prepared = await preparePickedAttachment(input);
        if (prepared.kind !== 'prepared') throw new Error('Expected prepared attachment');
        const expected = { ...prepared.attachment };
        const error = new Error('Injected persistence failure');
        const persist = async (attachment: Attachment): Promise<Attachment> => { attachment.title = 'Changed'; throw error; };
        await expect(persistPreparedPickedAttachment({ prepared, persist, t })).rejects.toBe(error);
        await expect(addPickedAttachment({ ...input, persist })).rejects.toBe(error);
        expect(prepared.attachment).toEqual(expected);
    });

    it('generates an ID only after known-size validation, and immediately for an unknown size', async () => {
        const knownId = vi.fn(() => 'known');
        const known = preparePickedAttachment({ source: 'file', asset: { uri: 'file:///pick/known', size: 1 }, newId: knownId, t });
        expect(knownId).not.toHaveBeenCalled();
        await known;
        expect(knownId).toHaveBeenCalledTimes(1);
        const unknownId = vi.fn(() => 'unknown');
        const unknown = preparePickedAttachment({ source: 'file', asset: { uri: 'file:///pick/unknown' }, newId: unknownId, t });
        expect(unknownId).toHaveBeenCalledTimes(1);
        await unknown;
    });

    it('keeps the existing post-validation clock read before ID generation', async () => {
        vi.useFakeTimers(); vi.setSystemTime(AT);
        const afterValidation = '2026-09-02T00:00:00.000Z';
        const afterId = '2026-09-03T00:00:00.000Z';
        const newId = vi.fn(() => { vi.setSystemTime(afterId); return 'id'; });
        const pending = preparePickedAttachment({ source: 'file', asset: { uri: 'file:///pick/source', size: 1 }, newId, t });
        vi.setSystemTime(afterValidation);
        const prepared = await pending;
        expect(prepared).toMatchObject({ kind: 'prepared', attachment: { id: 'id', createdAt: afterValidation, updatedAt: afterValidation } });
        expect(newId).toHaveBeenCalledTimes(1);
    });

    it('propagates ID generation errors before persistence', async () => {
        const error = new Error('Injected ID failure');
        const input = { source: 'file' as const, asset: { uri: 'file:///pick/source' }, newId: () => { throw error; }, t };
        const persist = vi.fn(async (attachment: Attachment) => attachment);
        await expect(preparePickedAttachment(input)).rejects.toBe(error);
        await expect(addPickedAttachment({ ...input, persist })).rejects.toBe(error);
        expect(persist).not.toHaveBeenCalled();
    });

    it('keeps the original Add input as the persistence callback receiver', async () => {
        const input = {
            source: 'file' as const, asset: { uri: 'file:///pick/source' }, newId: () => 'id', t,
            persist: async function (this: unknown, attachment: Attachment) {
                expect(this).toBe(input);
                return { ...attachment, uri: 'file:///managed/id' };
            },
        };
        await expect(addPickedAttachment(input)).resolves.toMatchObject({
            kind: 'added', attachment: { id: 'id', uri: 'file:///managed/id' },
        });
    });

    it('keeps the translator captured before awaiting picker validation', async () => {
        const newId = vi.fn(() => 'id');
        const original = vi.fn((key: string) => `original:${key}`);
        const replacement = vi.fn((key: string) => `replacement:${key}`);
        const input = {
            source: 'file' as const, asset: { uri: 'file:///pick/source', size: 1 }, newId, t: original,
            persist: async (attachment: Attachment) => attachment,
        };
        const pending = addPickedAttachment(input);
        expect(newId).not.toHaveBeenCalled(); // Real validation has yielded, before preparation completes.
        input.t = replacement;
        await expect(pending).resolves.toEqual({ kind: 'refused', message: 'original:attachments.fileNotReadable' });
        expect(original).toHaveBeenCalledWith('attachments.fileNotReadable');
        expect(replacement).not.toHaveBeenCalled();
    });

    it('keeps an unbound translator captured before held persistence', async () => {
        const prepared = await preparePickedAttachment({ source: 'file', asset: { uri: 'file:///pick/source' }, newId: () => 'id', t });
        if (prepared.kind !== 'prepared') throw new Error('Expected prepared attachment');
        let release!: (attachment: Attachment) => void;
        const held = new Promise<Attachment>((resolve) => { release = resolve; });
        const original = vi.fn(function (this: unknown, key: string) {
            expect(this).toBeUndefined();
            return `original:${key}`;
        });
        const replacement = vi.fn(() => 'replacement');
        const input = { prepared, persist: () => held, t: original };
        const pending = persistPreparedPickedAttachment(input);
        input.t = replacement;
        release({ ...prepared.attachment });
        await expect(pending).resolves.toEqual({ kind: 'refused', message: 'original:attachments.fileNotReadable' });
        expect(original).toHaveBeenCalledOnce();
        expect(replacement).not.toHaveBeenCalled();
    });
});

describe('attachment editor model', () => {
    it('saves only what the editor changed over the stored list', () => {
        const kept = file('kept');
        const edited = file('edited');
        const base = [kept, edited];
        const stored = [{ ...kept, cloudKey: 'attachments/kept.pdf' }, edited, file('from-sync')];
        const value = [{ ...kept }, { ...edited, deletedAt: AT }, file('added')];
        expect(mergeTaskDraftAttachments(stored, base, value)).toEqual([
            stored[0], { ...edited, deletedAt: AT }, stored[2], file('added'),
        ]);
        expect(mergeTaskDraftAttachments(stored, base, base)).toEqual(stored);
    });

    it('saves exactly the editor\'s list when nothing changed the stored task meanwhile, as React Native replaces it', () => {
        const base = [file('a'), file('b', { cloudKey: 'attachments/b.pdf' })];
        const value = [{ ...base[0], deletedAt: AT, updatedAt: AT }, { ...base[1], uri: 'file:///x/b.pdf', localStatus: 'available' as const }, file('new')];
        expect(mergeTaskDraftAttachments(base, base, value)).toEqual(value);
    });

    it('keeps a removal sync recorded after the editor opened, even when the editor downloaded that file', () => {
        const before = file('f', { cloudKey: 'attachments/f.pdf', uri: '', localStatus: 'missing' });
        const downloaded = { ...before, uri: 'file:///x/f.pdf', localStatus: 'available' as const };
        const tombstone = { ...before, deletedAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' };
        expect(mergeTaskDraftAttachments([tombstone], [before], [downloaded])).toEqual([tombstone]);
    });

    it('keeps a newer cloudKey, content revision and upload flag, and applies only the fields the editor changed', () => {
        const before = file('f', { pendingContentUpload: true });
        const uploaded = { ...before, cloudKey: 'attachments/f.pdf', contentRev: 2, pendingContentUpload: false };
        const removed = { ...before, deletedAt: AT, updatedAt: '2026-09-03T00:00:00.000Z' };
        expect(mergeTaskDraftAttachments([uploaded], [before], [removed])).toEqual([
            { ...uploaded, deletedAt: AT, updatedAt: '2026-09-03T00:00:00.000Z' },
        ]);
        const link: Attachment = { id: 'l', kind: 'link', title: 'Old', uri: 'https://a.example', createdAt: AT, updatedAt: AT };
        const elsewhere = { ...link, uri: 'https://b.example' };
        expect(mergeTaskDraftAttachments([elsewhere], [link], [{ ...link, title: 'New' }])).toEqual([{ ...elsewhere, title: 'New' }]);
    });

    it('drops a download made for content sync has since replaced: the bytes belong to the old content', () => {
        const before = file('f', { cloudKey: 'attachments/f.pdf', contentRev: 1, uri: '', localStatus: 'missing' });
        const downloaded = { ...before, uri: 'file:///x/f.pdf', localStatus: 'available' as const, fileHash: 'a'.repeat(64) };
        const replaced = { ...before, contentRev: 2, fileHash: 'b'.repeat(64) };
        expect(mergeTaskDraftAttachments([replaced], [before], [downloaded])).toEqual([replaced]);
        // A terminal mark for the old content (cloudKey cleared, removed) is dropped too.
        const unrecoverable = { ...before, cloudKey: undefined, deletedAt: AT };
        expect(mergeTaskDraftAttachments([replaced], [before], [unrecoverable])).toEqual([replaced]);
    });

    it('never re-adds a record storage no longer has, and appends only attachments new to the editor', () => {
        const gone = file('gone');
        expect(mergeTaskDraftAttachments([], [gone], [{ ...gone, title: 'renamed' }, file('new')])).toEqual([file('new')]);
    });

    it('names a URI in a log by its scheme and extension only', () => {
        expect(describeAttachmentUriForLog('https://user:hunter2@example.com/private/report.pdf?token=abc')).toBe('https:.pdf');
        expect(describeAttachmentUriForLog('content://com.android.providers/document/secret-name.docx')).toBe('content:.docx');
        expect(describeAttachmentUriForLog('/Users/me/Taxes 2026')).toBe('path:');
        expect(describeAttachmentUriForLog('')).toBe('none');
    });

    it('checks a synced draft attachment against the saved task only when the editor has one', () => {
        const synced = file('synced', { cloudKey: 'attachments/synced.pdf', contentRev: 1 });
        const identity = getAttachmentDownloadIdentity(synced);
        const find = (stored: () => Attachment | undefined | null) => findTaskDraftAttachmentForIdentity({
            draft: [synced], stored, attachmentId: 'synced', identity, has: hasAttachmentDownloadIdentity,
        });
        expect(find(() => null)).toBe(synced);
        expect(find(() => synced)).toBe(synced);
        expect(find(() => ({ ...synced, contentRev: 2 }))).toBeNull();
        expect(find(() => undefined)).toBeNull();
    });

    it('plans a file open with the MIME type Android\'s viewer needs, and audio only where a player exists', () => {
        expect(planAttachmentOpen(file('doc'), { audio: true, t })).toEqual({
            kind: 'file', uri: 'file:///a/doc.pdf', mimeType: null, viewMimeType: 'application/pdf',
        });
        const memo = file('memo', { title: 'memo.m4a', uri: 'file:///a/memo.m4a' });
        expect(planAttachmentOpen(memo, { audio: true, t })).toEqual({ kind: 'audio', attachment: memo });
        expect(planAttachmentOpen(memo, { audio: false, t })).toMatchObject({ kind: 'file', viewMimeType: '*/*' });
        expect(resolveAttachmentViewMimeType('file:///a/x.unknown', ' text/plain ')).toBe('text/plain');
    });

    it('offers no Download for a row kept without its file, as React Native and desktop show "Missing file"', () => {
        const kept = file('kept', { uri: '', cloudKey: 'attachments/kept.pdf', localStatus: 'missing' });
        expect(getAttachmentRowState(kept)).toMatchObject({ missing: true, canDownload: true });
        rememberUnreachableAttachments({ scope: { kept: ['attachments/kept.pdf'] } });
        try {
            expect(getAttachmentRowState(kept)).toMatchObject({ missing: true, canDownload: false });
        } finally {
            rememberUnreachableAttachments({});
        }
    });
});
