import {
    createCompactLinkTitle,
    enrichAttachmentLinkTitle,
    enrichCapturedTaskLinkTitle,
    fetchWebPageTitle,
    getBareHttpUrl,
    isSandboxMode,
    type Attachment,
} from '@mindwtr/core';

const MAX_HTML_BYTES = 128 * 1024;

type BodyReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void };
type BridgeResponse = Response & { mindwtrDecodedTextBytes?: unknown };

const utf8Prefix = (text: string): Uint8Array => {
    const bytes = new TextEncoder().encode(text.slice(0, MAX_HTML_BYTES));
    if (bytes.length <= MAX_HTML_BYTES) return bytes;
    let end = MAX_HTML_BYTES;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    return bytes.subarray(0, end);
};

const pageStart = async (response: BridgeResponse): Promise<string> => typeof response.mindwtrDecodedTextBytes === 'number'
    ? response.text()
    : new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(await response.arrayBuffer()).subarray(0, MAX_HTML_BYTES));

const withBodyReader = (response: Response): Response => {
    if (response.body) return response;
    let consumed = false;
    const reader: BodyReader = {
        read: async () => {
            if (consumed) return { done: true };
            consumed = true;
            return { done: false, value: utf8Prefix(await pageStart(response)) };
        },
        cancel: async () => undefined,
        releaseLock: () => undefined,
    };
    return Object.assign(response, { body: { getReader: () => reader } });
};

export const fetchAndroidLinkTitle = (url: string, fetcher: typeof fetch = globalThis.fetch): Promise<string | null> =>
    fetchWebPageTitle(url, (address, init) => fetcher(address, init).then(withBodyReader));

type HostEvents = { __mindwtrNative?: { hostEvent?: (json: string) => unknown } };

const announceAppliedTitle = (applied: boolean) => {
    if (!applied) return;
    try {
        (globalThis as HostEvents).__mindwtrNative?.hostEvent?.(JSON.stringify({ type: 'linkTitle' }));
    } catch {
        return;
    }
};

const isAndroidHost = () => (globalThis as { __mindwtrHostPlatform?: unknown }).__mindwtrHostPlatform === 'android';

export function enrichAndroidCaptureTitle(taskId: string | null | undefined, text: string, loadTitle = fetchAndroidLinkTitle): void {
    try {
        if (!isAndroidHost() || !taskId || isSandboxMode()) return;
        const url = getBareHttpUrl(text);
        if (url) void enrichCapturedTaskLinkTitle(taskId, url, loadTitle).then(announceAppliedTitle);
    } catch {
        return;
    }
}

export function enrichAndroidEditorLinkTitles(input: { taskId: string; baseline: Attachment[]; committed: Attachment[] },
    loadTitle = fetchAndroidLinkTitle): void {
    try {
        if (!isAndroidHost() || isSandboxMode()) return;
        const before = new Set(input.baseline.map((attachment) => attachment.id));
        for (const attachment of input.committed) {
            if (attachment.kind === 'link' && !attachment.deletedAt && !before.has(attachment.id)
                && getBareHttpUrl(attachment.uri) && attachment.title === createCompactLinkTitle(attachment.uri)) {
                void enrichAttachmentLinkTitle({ kind: 'task', id: input.taskId }, attachment, loadTitle).then(announceAppliedTitle);
            }
        }
    } catch {
        return;
    }
}
