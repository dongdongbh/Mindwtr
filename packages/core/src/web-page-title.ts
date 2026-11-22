import { getBareHttpUrl } from './attachment-link-utils';
import { fetchWithTimeoutAndConsume } from './http-utils';

const MAX_HTML_BYTES = 128 * 1024;
const MAX_TITLE_LENGTH = 200;
const TITLE_TIMEOUT_MS = 4_000;

const NAMED_ENTITIES = new Map([
    ['amp', '&'], ['apos', "'"], ['gt', '>'], ['lt', '<'], ['nbsp', ' '], ['quot', '"'],
    ['copy', '©'], ['reg', '®'], ['hellip', '…'], ['mdash', '—'], ['ndash', '–'],
    ['ldquo', '“'], ['lsquo', '‘'], ['rdquo', '”'], ['rsquo', '’'],
]);

export function getWebPageTitleRequestUrl(input: string): string | null {
    const bareUrl = getBareHttpUrl(input);
    if (!bareUrl) return null;
    const authority = bareUrl.match(/^https?:\/\/([^/?#]+)/i)?.[1];
    if (authority?.includes('@')) return null;
    const url = new URL(bareUrl);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.port || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(host)
        || /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|onion|arpa|test|example|invalid)$/.test(host)) return null;
    url.hash = '';
    return url.href;
}

export function normalizeWebPageTitle(value: string): string | null {
    const cleaned = value.replace(/\s+/g, ' ').replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, '').trim();
    if (!cleaned) return null;
    return Array.from(cleaned).slice(0, MAX_TITLE_LENGTH).join('');
}

export function extractWebPageTitle(html: string): string | null {
    const head = html.slice(0, MAX_HTML_BYTES)
        .replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|template|svg)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
        .split(/<(?:body|\/head)(?=[\s>])/i, 1)[0];
    const match = head?.match(/<title(?=[\s>])(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/title\s*>/i);
    if (!match) return null;
    return normalizeWebPageTitle(match[1].replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi, (raw, entity: string) => {
        if (!entity.startsWith('#')) return NAMED_ENTITIES.get(entity.toLowerCase()) ?? raw;
        const hex = /^#x/i.test(entity);
        const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!codePoint || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) return '';
        return String.fromCodePoint(codePoint);
    }));
}

type PageTitleFetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchWebPageTitle(input: string, fetcher: PageTitleFetcher = globalThis.fetch): Promise<string | null> {
    const url = getWebPageTitleRequestUrl(input);
    if (!url || typeof fetcher !== 'function' || typeof AbortController !== 'function' || typeof TextDecoder !== 'function') return null;
    try {
        return await fetchWithTimeoutAndConsume(url, {
            credentials: 'omit',
            redirect: 'error',
            referrer: '',
            referrerPolicy: 'no-referrer',
            headers: { Accept: 'text/html, application/xhtml+xml' },
        }, TITLE_TIMEOUT_MS, fetcher, 'Page title lookup timed out', async (response, signal) => {
            if (!response.ok || response.redirected
                || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) return null;
            const reader = response.body?.getReader();
            if (!reader) return null;
            const cancel = () => { void reader.cancel().catch(() => undefined); };
            signal?.addEventListener('abort', cancel, { once: true });
            const decoder = new TextDecoder();
            let html = '';
            let remaining = MAX_HTML_BYTES;
            try {
                while (remaining > 0 && !signal?.aborted) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const next = value.subarray(0, remaining);
                    html += decoder.decode(next, { stream: true });
                    remaining -= next.byteLength;
                }
                return extractWebPageTitle(html + decoder.decode());
            } finally {
                signal?.removeEventListener('abort', cancel);
                cancel();
                reader.releaseLock();
            }
        });
    } catch {
        return null;
    }
}
