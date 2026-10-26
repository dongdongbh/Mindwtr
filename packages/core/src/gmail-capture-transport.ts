import { base64ToBytes } from './base64-bytes';
import type { GmailCaptureBatch, GmailCaptureConfig, GmailCaptureTransport } from './gmail-capture';
import type { GmailReceiptStore } from './gmail-receipt-store';

// RN's Gmail transport and message parser (apps/mobile/lib/gmail-capture-service.ts), shared with the native hosts. Moved as
// is, with three seams: core-relative imports, the HTML parser passed in (xmldom's DOMParser; core bundles no XML parser),
// and no default receipt store or ID source (each host passes its own).
export type GmailHtmlParser = new (options: { errorHandler: { warning: () => void; error: () => void; fatalError: () => void } }) => {
    parseFromString: (source: string, mimeType: string) => unknown;
};

type NativeStatus = { available: boolean; connected: boolean; account: string | null; accountId: string | null };
export type GmailAuthorization = {
    status: () => Promise<NativeStatus>;
    connect: () => Promise<NativeStatus>;
    cancel: () => Promise<void>;
    disconnect: () => Promise<{ revoked: boolean }>;
    get: (path: string) => Promise<unknown>;
};
const fail = (kind: string): never => { throw { kind, message: 'Gmail capture failed.' }; };
const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('other');
    return value as Record<string, unknown>;
};
const identifier = (value: unknown): string => {
    // eslint-disable-next-line no-control-regex -- an identifier from Google never holds a control character or a space
    if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x20]/.test(value)) return fail('other');
    return value;
};
const unavailable: GmailCaptureConfig = { available: false, connected: false, account: null, accountId: null, labelId: null, enabled: false };
const boundedText = (text: string) => Array.from(text).slice(0, 16_000).join('');

function htmlText(html: string, DOMParser: GmailHtmlParser): string {
    const document = new DOMParser({ errorHandler: { warning: () => {}, error: () => fail('other'), fatalError: () => fail('other') } }).parseFromString(`<html><body>${html}</body></html>`, 'text/html');
    let nodes = 0;
    const visit = (node: Node, depth: number): string => {
        if (++nodes > 20_000 || depth > 64) return fail('other');
        if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue ?? '';
        const tag = node.nodeName.toLowerCase();
        if (['script', 'style', 'head'].includes(tag)) return '';
        let text = '';
        for (let child = node.firstChild; child; child = child.nextSibling) text += visit(child, depth + 1);
        return text + (/^(br|p|div|li|tr|h[1-6])$/.test(tag) ? '\n' : '');
    };
    return visit(document as unknown as Node, 0).replace(/\n{3,}/g, '\n\n').trim();
}

export function parseGmailMessage(value: unknown, DOMParser: GmailHtmlParser): GmailCaptureBatch['messages'][number] {
    const message = object(value);
    const payload = object(message.payload);
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const header = (name: string) => {
        const found = headers.map(object).find((item) => typeof item.name === 'string' && item.name.toLowerCase() === name);
        return typeof found?.value === 'string' ? boundedText(found.value) : '';
    };
    let parts = 0;
    const body = (part: Record<string, unknown>, depth: number): string | null => {
        if (++parts > 256 || depth > 32) return fail('other');
        if (typeof part.filename === 'string' && part.filename) return null;
        const partHeaders = Array.isArray(part.headers) ? part.headers.map(object) : [];
        if (partHeaders.some((item) => typeof item.name === 'string' && item.name.toLowerCase() === 'content-disposition'
            && typeof item.value === 'string' && /^attachment(?:\s|;|$)/i.test(item.value.trim()))) return null;
        const mime = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
        if (mime.startsWith('multipart/')) {
            if (!Array.isArray(part.parts)) return fail('other');
            const children = part.parts.map(object);
            if (mime === 'multipart/alternative') {
                const ordered = [...children.filter((item) => item.mimeType === 'text/plain'), ...children.filter((item) => item.mimeType !== 'text/plain')];
                for (const child of ordered) { const result = body(child, depth + 1); if (result !== null) return result; }
                return null;
            }
            const values = children.map((child) => body(child, depth + 1)).filter((text): text is string => text !== null);
            return values.length ? values.join('\n\n') : null;
        }
        if (mime !== 'text/plain' && mime !== 'text/html') return null;
        const data = object(part.body);
        if (data.attachmentId || !Number.isSafeInteger(data.size) || (data.size as number) < 0) return fail('other');
        if (typeof data.data !== 'string') {
            if (data.size === 0 && !data.attachmentId) return '';
            return fail('other'); // Never acknowledge a message whose body needs another fetch.
        }
        if (data.data.length > 2_800_000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(data.data) || data.data.replace(/=+$/, '').length % 4 === 1) return fail('other');
        const normalized = data.data.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
        const bytes = base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
        if (bytes.length !== data.size) return fail('other');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return mime === 'text/html' ? htmlText(text, DOMParser) : text;
    };
    const text = body(payload, 0);
    if (text === null) return fail('other');
    return { id: identifier(message.id), subject: header('subject'), from: header('from'), bodyText: boundedText(text.trim()) };
}

export function createGmailCaptureTransport(
    native: GmailAuthorization | null,
    getStore: () => GmailReceiptStore,
    newId: () => string,
    DOMParser: GmailHtmlParser,
): GmailCaptureTransport {
    let generation = 0;
    let blocked = false;
    let page: string | undefined;
    let pending: { batch: GmailCaptureBatch; generation: number; label: string; nextPage?: string } | null = null;
    let polling: Promise<GmailCaptureBatch> | null = null;
    const current = (expected: number) => { if (generation !== expected) fail('cancelled'); };
    const call = async <T>(work: () => Promise<T>): Promise<T> => {
        const admitted = generation;
        try { return await work(); } catch (error) {
            if (error && typeof error === 'object' && 'kind' in error) throw error;
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
            const kind = /^E_GMAIL_(AUTH|NETWORK|CONFIG|CANCELLED|STORAGE|OTHER)$/.test(code) ? code.slice(8).toLowerCase() : 'other';
            if (kind === 'auth' && generation === admitted) invalidate();
            return fail(kind);
        }
    };
    const auth = () => native ?? fail('config');
    const status = async (): Promise<GmailCaptureConfig> => {
        if (!native) return unavailable;
        const state = await call(() => native.status());
        if (!state.available) return unavailable;
        const config = getStore().config();
        return { ...state, labelId: state.accountId === config.account ? config.label : null,
            enabled: state.connected && state.accountId === config.account && config.enabled && !config.blocked && !blocked };
    };
    const invalidate = () => {
        const expected = ++generation;
        blocked = true;
        pending = null; page = undefined;
        const store = getStore();
        store.configure({ ...store.config(), enabled: false, blocked: true });
        return expected;
    };
    const active = async (expected: number) => {
        const config = await status(); current(expected);
        if (!config.connected || !config.enabled || !config.accountId || !config.labelId) return fail('config');
        return config as GmailCaptureConfig & { accountId: string; labelId: string };
    };
    const fetchBatch = async (): Promise<GmailCaptureBatch> => {
        const expected = generation;
        const config = await active(expected);
        if (pending) return pending.batch;
        const result = object(await call(() => auth().get(`messages?labelIds=${encodeURIComponent(config.labelId)}&maxResults=25${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`)));
        current(expected);
        const listed = result.messages === undefined ? [] : result.messages;
        if (!Array.isArray(listed) || listed.length > 25) return fail('other');
        const messages: GmailCaptureBatch['messages'] = [];
        for (const item of listed) {
            const id = identifier(object(item).id);
            if (getStore().seen(config.accountId, id)) continue;
            const raw = object(await call(() => auth().get(`messages/${encodeURIComponent(id)}?format=full`)));
            current(expected);
            if (raw.id !== id || !Array.isArray(raw.labelIds)) return fail('other');
            if (!raw.labelIds.includes(config.labelId)) continue;
            messages.push(parseGmailMessage(raw, DOMParser));
        }
        const after = await active(expected);
        if (after.accountId !== config.accountId || after.labelId !== config.labelId) return fail('cancelled');
        const nextPage = result.nextPageToken === undefined ? undefined : identifier(result.nextPageToken);
        if (nextPage && nextPage === page) return fail('other');
        const batch = { batchId: newId(), accountId: config.accountId, messages, hasMore: Boolean(nextPage) };
        pending = { batch, generation: expected, label: config.labelId, nextPage };
        return batch;
    };
    const validate = async (batchId: string) => {
        const candidate = pending;
        if (!candidate || candidate.batch.batchId !== batchId || candidate.generation !== generation) return false;
        const config = await status();
        return pending === candidate && candidate.generation === generation && config.enabled
            && config.accountId === candidate.batch.accountId && config.labelId === candidate.label;
    };
    return {
        status,
        connect: async () => {
            const expected = invalidate();
            const state = await call(() => auth().connect()); current(expected);
            if (!state.connected || !state.accountId) return fail('auth');
            getStore().configure({ account: state.accountId, label: null, enabled: false, blocked: false });
            blocked = false;
            return status();
        },
        cancel: async () => {
            let storageError: unknown;
            try { invalidate(); } catch (error) { storageError = error; }
            await call(() => auth().cancel());
            if (storageError) throw storageError;
        },
        disconnect: async () => {
            let storageError: unknown;
            try { invalidate(); } catch (error) { storageError = error; }
            const result = await call(() => auth().disconnect());
            if (storageError) throw storageError;
            return result;
        },
        labels: async () => {
            const expected = generation;
            const result = object(await call(() => auth().get('labels'))); current(expected);
            if (!Array.isArray(result.labels)) return fail('other');
            return result.labels.map((value) => {
                const label = object(value);
                if (typeof label.name !== 'string') return fail('other');
                return { id: identifier(label.id), name: boundedText(label.name) };
            });
        },
        configure: async (labelId, enabled) => {
            const expected = invalidate();
            const state = await call(() => auth().status()); current(expected);
            if (!state.connected || !state.accountId) return fail('auth');
            if (enabled) {
                const label = object(await call(() => auth().get(`labels/${encodeURIComponent(identifier(labelId))}`)));
                current(expected);
                if (label.id !== labelId) return fail('config');
            }
            getStore().configure({ account: state.accountId, label: labelId || null, enabled, blocked: false });
            blocked = false;
            return status();
        },
        poll: () => {
            if (!polling) polling = fetchBatch().finally(() => { polling = null; });
            return polling;
        },
        validate,
        commit: async (batchId) => {
            const candidate = pending;
            if (!await validate(batchId) || !candidate || pending !== candidate || candidate.generation !== generation) return fail('cancelled');
            getStore().acknowledge(candidate.batch.accountId, candidate.batch.messages.map((message) => message.id));
            page = candidate.nextPage;
            pending = null;
        },
    };
}
