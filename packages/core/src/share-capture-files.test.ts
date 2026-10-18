import { describe, expect, it, vi } from 'vitest';

import { buildShareIntentFileCaptureParams, type ShareIntentFileCaptureHost } from './share-capture-files';
import type { Attachment } from './types';

const MANAGED = 'file:///data/files/attachments/';

/** A host whose copy puts each file in the managed folder, revealing [sizes] (by name) a sizeless share had. */
const host = (sizes: Record<string, number> = {}, failing: string[] = []) => {
    let next = 0;
    const deleted: string[] = [];
    const warnings: string[] = [];
    const value: ShareIntentFileCaptureHost = {
        newId: () => `id-${next += 1}`,
        persistAttachmentLocallyDetailed: async (attachment: Attachment) => (failing.includes(attachment.title)
            ? { attachment, status: 'failed' as const }
            : { attachment: { ...attachment, uri: `${MANAGED}${attachment.id}`, size: attachment.size ?? sizes[attachment.title] }, status: 'copied' as const }),
        deleteFile: async (uri) => { deleted.push(uri); },
        logWarn: (message) => { warnings.push(message); },
        logError: vi.fn(),
    };
    return { value, deleted, warnings };
};
const file = (fileName: string, extra: { mimeType?: string; size?: number } = {}) => ({ fileName, path: `/cache/${fileName}`, mimeType: extra.mimeType ?? 'application/pdf', size: extra.size ?? 10 });
const props = (params: Record<string, string> | null) => JSON.parse(decodeURIComponent(params!.initialProps));

describe('buildShareIntentFileCaptureParams', () => {
    it('attaches managed copies, titled by the first file without its extension', async () => {
        const { value } = host();
        const result = await buildShareIntentFileCaptureParams({ files: [file('Report.final.pdf'), file('b.png', { mimeType: 'image/png' })] }, value);
        expect(result).toMatchObject({ candidateCount: 2, attachedCount: 2 });
        expect(decodeURIComponent(result.params!.initialValue)).toBe('Report.final');
        expect(props(result.params).attachments.map((attachment: Attachment) => attachment.uri)).toEqual([`${MANAGED}id-1`, `${MANAGED}id-2`]);
        expect(props(result.params).description).toBeUndefined();
    });

    it('takes the subject as the title and the text as the description only with a subject', async () => {
        const withSubject = await buildShareIntentFileCaptureParams({ files: [file('a.pdf')], shareSubject: ' Invoice ', shareText: 'Body' }, host().value);
        expect(decodeURIComponent(withSubject.params!.initialValue)).toBe('Invoice');
        expect(props(withSubject.params).description).toBe('Body');
        const textOnly = await buildShareIntentFileCaptureParams({ files: [file('a.pdf')], shareText: 'Note' }, host().value);
        expect(decodeURIComponent(textOnly.params!.initialValue)).toBe('Note');
        expect(props(textOnly.params).description).toBeUndefined();
    });

    it('takes the first six files only', async () => {
        const result = await buildShareIntentFileCaptureParams({ files: Array.from({ length: 8 }, (_, n) => file(`f${n}.pdf`)) }, host().value);
        expect(result).toMatchObject({ candidateCount: 6, attachedCount: 6 });
    });

    it('skips a blocked type, a failed copy, and a sizeless file the copy shows too large (deleting it)', async () => {
        const { value, deleted } = host({ 'big.pdf': 60 * 1024 * 1024 }, ['broken.pdf']);
        const result = await buildShareIntentFileCaptureParams({
            files: [file('ok.pdf'), file('run.exe', { mimeType: 'application/x-msdownload' }), file('broken.pdf'), { fileName: 'big.pdf', path: '/cache/big.pdf', mimeType: 'application/pdf' }],
        }, value);
        expect(result).toMatchObject({ candidateCount: 4, attachedCount: 1 });
        expect(deleted).toHaveLength(1);
    });

    it('answers no params when nothing could be attached', async () => {
        expect(await buildShareIntentFileCaptureParams({ files: [{ fileName: 'x', path: '  ' }] }, host().value)).toEqual({ params: null, candidateCount: 0, attachedCount: 0 });
        expect(await buildShareIntentFileCaptureParams({ files: [file('broken.pdf')] }, host({}, ['broken.pdf']).value)).toEqual({ params: null, candidateCount: 1, attachedCount: 0 });
    });
});
