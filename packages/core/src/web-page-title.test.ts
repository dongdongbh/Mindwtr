import { describe, expect, it, vi } from 'vitest';
import { getBareHttpUrl } from './attachment-link-utils';
import { extractWebPageTitle, fetchWebPageTitle } from './web-page-title';

describe('web page titles', () => {
    it('recognizes one HTTP URL without changing its original spelling', () => {
        const url = 'HTTPS://Example.COM/tomorrow?encode=a%2Fb#top';
        expect(getBareHttpUrl(`  ${url}\n`)).toBe(url);
        for (const title of ['https://example.com discussed later', '[Example](https://example.com)', 'Example | https://example.com', 'file:///example']) {
            expect(getBareHttpUrl(title)).toBeNull();
        }
    });

    it('reads title text and ignores misleading markup outside the title', () => {
        const html = `<!-- <title>Comment</title> --><script>const sample="<title>Script</title>"</script>
            <TITLE data-example="a > b"> Café &amp; Tea \n &mdash; &#x1F375;&#0; &#xD800; </TITLE><body><title>Body</title></body>`;
        expect(extractWebPageTitle(html)).toBe('Café & Tea — 🍵');
        expect(extractWebPageTitle('<body><title>Body</title></body>')).toBeNull();
        expect(extractWebPageTitle('<head></head><title>Late title</title>')).toBeNull();
        expect(extractWebPageTitle(`<title>${'a'.repeat(199)}🍵x</title>`)).toBe(`${'a'.repeat(199)}🍵`);
    });

    it('requests a title anonymously and cancels a response at the byte budget', async () => {
        const bytes = new TextEncoder().encode('<head><title>Long page &amp; Café</title></head>' + 'a'.repeat(150_000));
        const cancel = vi.fn();
        const response = new Response(new ReadableStream({ start: (controller) => controller.enqueue(bytes), cancel }), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
        const fetcher = vi.fn(async () => response);
        await expect(fetchWebPageTitle('https://example.com/article?q=one#private', fetcher)).resolves.toBe('Long page & Café');
        expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://example.com/article?q=one', expect.objectContaining({
            credentials: 'omit', redirect: 'error', referrer: '', referrerPolicy: 'no-referrer', signal: expect.any(AbortSignal),
        }));
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('declines network access for credentials and addresses outside public web hosts', async () => {
        const fetcher = vi.fn();
        for (const url of [
            'https://name:secret@example.com', 'https://@example.com', 'http://localhost/',
            'https://service.local./', 'https://192.168.0.1/', 'https://[::1]/', 'https://example.com:8443/',
        ]) await expect(fetchWebPageTitle(url, fetcher)).resolves.toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('ignores redirects, non-HTML content, and a title beyond the response budget', async () => {
        await expect(fetchWebPageTitle('https://example.com/redirect', async () => new Response('', {
            status: 302, headers: { Location: 'https://example.org' },
        }))).resolves.toBeNull();
        await expect(fetchWebPageTitle('https://example.com/text', async () => new Response('<title>Looks like HTML</title>')))
            .resolves.toBeNull();
        await expect(fetchWebPageTitle('https://example.com/long', async () => new Response(
            `${' '.repeat(128 * 1024)}<title>Past the limit</title>`, { headers: { 'Content-Type': 'text/html' } },
        ))).resolves.toBeNull();
    });

    it('times out even when the transport never resolves', async () => {
        vi.useFakeTimers();
        try {
            const pending = fetchWebPageTitle('https://example.com/timeout', () => new Promise(() => {}));
            await vi.advanceTimersByTimeAsync(4_000);
            await expect(pending).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
