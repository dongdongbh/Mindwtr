import { afterAll, describe, expect, it } from 'vitest';

import type { NativeAttachmentsHost } from './native-host-contract-attachments';
import { requestRowId } from './native-request-receipts';
import { openScreenHost, requestId, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { Attachment } from './types';

/**
 * A file share on the native host (O3 review item 5): the host stages each shared file in its own folder, core runs React
 * Native's rule (share-capture-files.ts) over the host's attachment IO, and the capture screen shows and saves the managed
 * copies, as React Native's root layout and capture screen do.
 */
const MANAGED = 'file:///data/files/attachments/';
const STAGED = '/data/no_backup/shared-entries/e1/';

/** The host's attachment IO: a copy puts the staged file in the managed folder (its bytes [sizes] by name, when the share had none). */
const fileHost = (sizes: Record<string, number> = {}, unreadable: string[] = []) => {
    const log: unknown[][] = [];
    const host: NativeAttachmentsHost = {
        persistAttachmentLocally: async (attachment) => attachment,
        persistAttachmentLocallyDetailed: async (attachment) => {
            log.push(['persist', attachment.id, attachment.uri]);
            if (unreadable.includes(attachment.title)) return { attachment, status: 'failed' };
            const extension = /\.[a-z0-9]+$/i.exec(attachment.title)?.[0] ?? '';
            return { attachment: { ...attachment, uri: `${MANAGED}${attachment.id}${extension}`, size: attachment.size ?? sizes[attachment.title] }, status: 'copied' };
        },
        canUploadAttachmentFrom: (uri) => uri.startsWith(MANAGED) && !uri.slice(MANAGED.length).includes('/') && !uri.includes('..'),
        ensureAttachmentAvailableDetailed: async (attachment) => ({ status: 'available', attachment }),
        deleteManagedAttachmentFile: async (attachment) => { log.push(['delete', attachment.id, attachment.uri]); },
    };
    return { host, log };
};
const staged = (name: string, extra: { mimeType?: string; size?: number | null } = {}) => ({
    path: `${STAGED}${name}`, name, mimeType: extra.mimeType ?? 'application/pdf', size: extra.size === undefined ? 10 : extra.size,
});
const open = async (attachments: NativeAttachmentsHost | null) => openScreenHost({
    data: {}, record: { addTask: 1 }, log: [], bindings: attachments ? { attachments } : {},
});
const props = (params: Record<string, string> | undefined) => JSON.parse(decodeURIComponent(params!.initialProps));

afterAll(async () => { await flushPendingSave(); resetForTests(); });

describe('native host contract: prepareSharedFiles', () => {
    it('copies the staged files into the managed folder and opens the capture screen with them', async () => {
        const files = fileHost();
        const host = await open(files.host);
        const id = requestId();
        const answer = value(await host.prepareSharedFiles({ requestId: id, files: [staged('Report.pdf'), staged('photo.png', { mimeType: 'image/png' })], text: null, subject: null }));
        expect(answer.route).toBe('/inbox');
        expect(answer.notice).toBeNull();
        const params = answer.captureModal!.params;
        expect(decodeURIComponent(params.initialValue!)).toBe('Report');
        expect(props(params).attachments.map((attachment: Attachment) => attachment.id)).toEqual([requestRowId(id, 'share-file:0'), requestRowId(id, 'share-file:1')]);
        // The same entry again (a replay after a restart) names the same copies.
        const again = value(await host.prepareSharedFiles({ requestId: id, files: [staged('Report.pdf'), staged('photo.png', { mimeType: 'image/png' })], text: null, subject: null }));
        const named = (entry: { captureModal: { params: Record<string, string> } | null }) => props(entry.captureModal!.params).attachments.map((attachment: Attachment) => [attachment.id, attachment.uri]);
        expect(named(again)).toEqual(named(answer));
    });

    it('takes the subject as the title and the text as the description, as React Native does for an email', async () => {
        const host = await open(fileHost().host);
        const answer = value(await host.prepareSharedFiles({ requestId: requestId(), files: [staged('a.pdf')], text: 'Body', subject: 'Invoice' }));
        expect(decodeURIComponent(answer.captureModal!.params.initialValue!)).toBe('Invoice');
        expect(props(answer.captureModal!.params).description).toBe('Body');
    });

    it('counts the skipped files in one notice and opens the rest', async () => {
        const files = fileHost({ 'big.pdf': 60 * 1024 * 1024 });
        const host = await open(files.host);
        const answer = value(await host.prepareSharedFiles({
            requestId: requestId(),
            files: [staged('ok.pdf'), staged('run.exe', { mimeType: 'application/x-msdownload' }), staged('big.pdf', { size: null })],
            text: null, subject: null,
        }));
        expect(props(answer.captureModal!.params).attachments).toHaveLength(1);
        expect(answer.notice).toEqual({ tone: 'warning', title: 'Notice', message: '2 shared file(s) could not be attached (too large, blocked file type, or unreadable).' });
        expect(files.log.filter(([kind]) => kind === 'delete')).toHaveLength(1);
    });

    it('says the share could not be read when no file could be staged, and opens the text when every file was skipped', async () => {
        const host = await open(fileHost({}, ['broken.pdf']).host);
        const unreadable = value(await host.prepareSharedFiles({ requestId: requestId(), files: [{ path: null, name: 'gone.pdf', mimeType: null, size: null }], text: null, subject: null }));
        expect(unreadable.captureModal).toBeNull();
        expect(unreadable.notice).toMatchObject({ title: 'Share unavailable' });
        const textOnly = value(await host.prepareSharedFiles({ requestId: requestId(), files: [staged('broken.pdf')], text: 'Read this', subject: null }));
        expect(decodeURIComponent(textOnly.captureModal!.params.initialValue!)).toBe('Read this');
        expect(textOnly.notice).toMatchObject({ title: 'Notice' });
    });

    it('counts a staged file the system cleared before the entry opened as skipped: a notice, never a silent empty capture', async () => {
        // The cache copy is gone, so the host's copy into the attachments folder fails.
        const host = await open(fileHost({}, ['cleared.pdf']).host);
        const answer = value(await host.prepareSharedFiles({ requestId: requestId(), files: [staged('cleared.pdf')], text: null, subject: null }));
        expect(answer.captureModal).toBeNull();
        expect(answer.notice).toEqual({ tone: 'warning', title: 'Notice', message: '1 shared file(s) could not be attached (too large, blocked file type, or unreadable).' });
    });

    it('counts a file that could not be read beside attached ones as skipped, and says the share could not be read when none was attached', async () => {
        const host = await open(fileHost().host);
        const mixed = value(await host.prepareSharedFiles({ requestId: requestId(), files: [staged('a.png'), { path: null, name: 'b.png', mimeType: 'image/png', size: null }, staged('c.png')], text: null, subject: null }));
        expect(props(mixed.captureModal!.params).attachments).toHaveLength(2);
        expect(mixed.notice).toMatchObject({ title: 'Notice', message: '1 shared file(s) could not be attached (too large, blocked file type, or unreadable).' });
        const none = value(await host.prepareSharedFiles({ requestId: requestId(), files: [{ path: null, name: 'b.png', mimeType: null, size: null }, staged('run.exe', { mimeType: 'application/x-msdownload' })], text: null, subject: null }));
        expect(none.captureModal).toBeNull();
        expect(none.notice).toMatchObject({ title: 'Share unavailable' });
    });

    it('takes no files without the host\'s attachment IO, and refuses malformed input', async () => {
        const host = await open(null);
        // Without it, the share cannot be read: RN's notice, so the entry leaves instead of holding the queue.
        const unbound = value(await host.prepareSharedFiles({ requestId: requestId(), files: [staged('a.pdf')], text: null, subject: null }));
        expect(unbound).toMatchObject({ captureModal: null, notice: { title: 'Share unavailable' } });
        const bound = await open(fileHost().host);
        const refused = await Promise.all([
            bound.prepareSharedFiles({ requestId: 'nope', files: [], text: null, subject: null }),
            bound.prepareSharedFiles({ requestId: requestId(), files: Array.from({ length: 7 }, (_, n) => staged(`f${n}.pdf`)), text: null, subject: null }),
            bound.prepareSharedFiles({ requestId: requestId(), files: [{ path: 3 }] as never, text: null, subject: null }),
        ]);
        expect(refused.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['INVALID_INPUT', 'INVALID_INPUT', 'INVALID_INPUT']);
    });
});

describe('native host contract: the capture screen with shared files', () => {
    const attachment = (id: string, uri: string): Attachment => ({ id, kind: 'file', title: `${id}.pdf`, uri, createdAt: '2026-10-17T00:00:00.000Z' });
    const params = (attachments: Attachment[]) => ({ initialValue: 'Receipt', initialProps: encodeURIComponent(JSON.stringify({ attachments })) });

    it('shows and saves the managed copies only, as React Native\'s capture screen does', async () => {
        const host = await open(fileHost().host);
        const shared = params([
            attachment('a1', `${MANAGED}a1.pdf`),
            attachment('a2', `${MANAGED}../a2.pdf`),
            attachment('a3', 'file:///data/files/other/a3.pdf'),
        ]);
        const opened = value(host.openCaptureModal({ params: shared }));
        expect(opened.view.attachments).toEqual({ label: 'Attachments', titles: ['a1.pdf'] });
        const captureId = requestId();
        expect(value(await host.submitCaptureModal({ params: shared, draft: opened.draft, captureId }))).toMatchObject({ kind: 'saved', taskId: captureId });
        const task = useTaskStore.getState()._allTasks.find((entry) => entry.id === captureId);
        expect(task?.attachments?.map((entry) => entry.uri)).toEqual([`${MANAGED}a1.pdf`]);
    });
});
