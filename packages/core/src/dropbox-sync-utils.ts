type DropboxApiErrorPayload = {
    error_summary?: unknown;
    error?: {
        '.tag'?: unknown;
        path?: { '.tag'?: unknown };
        path_lookup?: { '.tag'?: unknown };
    };
};

export const parseDropboxMetadataRev = (raw: string | null): { rev: string | null } => {
    if (!raw) return { rev: null };
    try {
        const parsed = JSON.parse(raw) as { rev?: unknown };
        return { rev: typeof parsed.rev === 'string' ? parsed.rev : null };
    } catch {
        return { rev: null };
    }
};

export const parseDropboxApiErrorTag = async (
    response: { json: () => Promise<unknown>; text?: () => Promise<string> },
    signal?: AbortSignal,
): Promise<string> => {
    try {
        // Production responses expose text(); keep the body reader under the caller's
        // composed timeout/abort signal. The json()-only branch preserves compatibility
        // with lightweight consumers and test doubles that have no response stream.
        const payload = typeof response.text === 'function'
            ? JSON.parse(await readResponseText(response as Response, MAX_ERROR_BODY_BYTES, signal)) as DropboxApiErrorPayload
            : await response.json() as DropboxApiErrorPayload;
        const top = payload?.error?.['.tag'];
        if (typeof top === 'string') {
            if (top !== 'path' && top !== 'path_lookup') return top;
            const nested = payload.error?.[top]?.['.tag'];
            if (typeof nested === 'string') return `${top}/${nested}`;
            return top;
        }
        const summary = payload?.error_summary;
        if (typeof summary !== 'string') return '';
        const match = /^(path|path_lookup)\/([^/]+)/.exec(summary);
        return match ? `${match[1]}/${match[2]}` : '';
    } catch {
        return '';
    }
};

export const isDropboxPathConflictTag = (tag: string): boolean =>
    tag === 'path' || tag === 'path/conflict';

export const isDropboxPathNotFoundTag = (tag: string): boolean =>
    tag === 'path/not_found' || tag === 'path_lookup/not_found';

export const resolveDropboxPath = (path: string): string => {
    const trimmed = path.trim();
    if (!trimmed) throw new Error('Dropbox path is required');
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};
import { MAX_ERROR_BODY_BYTES, readResponseText } from './http-utils';
