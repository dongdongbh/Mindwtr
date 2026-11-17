import { buildShareCaptureDraft } from '../../../packages/core/src/entry-points';
import { extractExtension } from '../../../packages/core/src/attachment-paths';
import { buildShareIntentFileCaptureParams, SHARE_INTENT_MAX_FILES } from '../../../packages/core/src/share-capture-files';
import type { Attachment } from '../../../packages/core/src/types';
import { logInfo } from '@mindwtr/core';

type SharedFile = { id: string; name: string; mimeType: string; size: number; sha256: string; uri: string | null };
type Draft = { title: string; note: string } | null;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length
    && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
const isInstant = (value: unknown): value is string => typeof value === 'string' && value.length <= 40
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

const readFile = (value: unknown): SharedFile | null => {
    if (!record(value) || !exact(value, ['id', 'name', 'mimeType', 'size', 'sha256', 'uri'])) return null;
    const { id, name, mimeType, size, sha256, uri } = value;
    if (typeof id !== 'string' || !UUID.test(id) || typeof name !== 'string' || !name || name.length > 1024
        || typeof mimeType !== 'string' || !mimeType || mimeType.length > 255
        || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
        || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)
        || (uri !== null && (typeof uri !== 'string' || uri.length > 16_384 || !uri.startsWith('file:///')
            || !uri.endsWith('/' + id + extractExtension(name))))) return null;
    return { id, name, mimeType, size, sha256, uri };
};

function readFileDraft(value: Record<string, unknown>, invalid: () => Error) {
    const { files: rawFiles, skippedFiles, receivedAt } = value;
    if (!Array.isArray(rawFiles) || rawFiles.length > SHARE_INTENT_MAX_FILES || !isInstant(receivedAt)
        || typeof skippedFiles !== 'number' || !Number.isSafeInteger(skippedFiles) || skippedFiles < 0 || skippedFiles > 64) throw invalid();
    const files = rawFiles.map(readFile);
    if (files.some(file => file === null) || new Set(files.map(file => file!.id)).size !== files.length) throw invalid();
    return buildFileDraft(files as SharedFile[], value, skippedFiles, receivedAt);
}

async function buildFileDraft(shared: SharedFile[], value: Record<string, unknown>, skippedFiles: number, receivedAt: string) {
    const byId = new Map(shared.map(file => [file.id, file]));
    let index = 0;
    const result = await buildShareIntentFileCaptureParams({
        files: shared.map(file => ({ path: file.uri ?? `unavailable:${file.id}`, fileName: file.name, mimeType: file.mimeType, size: file.size })),
        shareSubject: value.subject as string | null, shareText: value.text as string | null,
    }, {
        newId: () => shared[index++].id,
        persistAttachmentLocallyDetailed: async (attachment) => {
            const file = byId.get(attachment.id);
            if (!file?.uri) return { attachment, status: 'failed' };
            return { attachment: { ...attachment, uri: file.uri, size: file.size, fileHash: file.sha256, createdAt: receivedAt, updatedAt: receivedAt }, status: 'copied' };
        },
        deleteFile: async () => undefined,
        logWarn: () => undefined,
        logError: () => undefined,
    });
    const skipped = skippedFiles + result.candidateCount - result.attachedCount;
    let draft: Draft, attachments: Attachment[] = [];
    if (result.params) {
        const props = JSON.parse(decodeURIComponent(result.params.initialProps)) as { attachments: Attachment[]; description?: string };
        draft = { title: decodeURIComponent(result.params.initialValue), note: props.description ?? '' };
        attachments = props.attachments;
    } else {
        const fallback = buildShareCaptureDraft({ shareSubject: value.subject as string | null, shareText: value.text as string | null,
            shareWebUrl: value.webUrl as string | null });
        draft = fallback ? { title: fallback.title, note: fallback.description ?? '' } : null;
    }
    try {
        logInfo('Native iOS shared files prepared', { scope: 'native-ios', force: true, context: { releaseCheck: 'v1.3.9/ios-share-files',
            candidates: String(shared.length + skippedFiles), attached: String(attachments.length), skipped: String(skipped) } });
    } catch {}
    return { draft, attachments, skipped };
}

export function readIOSShareCaptureDraft(raw: string): { draft: Draft } | Promise<{ draft: Draft; attachments: Attachment[]; skipped: number }> {
    const invalid = () => new Error('INVALID_INPUT: Invalid iOS text share');
    if (typeof raw !== 'string' || raw.length > 256 * 1024) throw invalid();
    const input: unknown = JSON.parse(raw);
    if (!record(input)) throw invalid();
    const value = input;
    const withFiles = exact(value, ['subject', 'text', 'webUrl', 'files', 'skippedFiles', 'receivedAt']);
    if (!withFiles && !exact(value, ['subject', 'text', 'webUrl'])) throw invalid();
    const bounded = (field: unknown, maximum: number): field is string | null => field === null || typeof field === 'string' && field.length <= maximum;
    if (!bounded(value.subject, 10_000) || !bounded(value.text, 50_000) || !bounded(value.webUrl, 16_000)) throw invalid();
    if (value.webUrl !== null) {
        let url: URL;
        try { url = new URL(value.webUrl); } catch { throw invalid(); }
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw invalid();
    }
    if (withFiles) return readFileDraft(value, invalid);
    const draft = buildShareCaptureDraft({ shareSubject: value.subject, shareText: value.text, shareWebUrl: value.webUrl });
    return { draft: draft ? { title: draft.title, note: draft.description ?? '' } : null };
}
