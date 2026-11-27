import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';

const polyfills = readFileSync(new URL('./host-polyfills.js', import.meta.url), 'utf8');
const core = new URL('../../../packages/core/src/', import.meta.url).pathname;

const nativeHost = async () => {
    const bundled = await build({
        stdin: {
            contents: `export { getWebPageTitleRequestUrl } from './web-page-title';
                export { getBareHttpUrl } from './attachment-link-utils';`,
            resolveDir: core, loader: 'ts',
        },
        bundle: true, write: false, format: 'iife', globalName: 'linkTitle', target: 'es2020', logLevel: 'silent',
    });
    const context: Record<string, unknown> = { URL: undefined, URLSearchParams: undefined };
    vm.createContext(context);
    vm.runInContext(polyfills, context);
    vm.runInContext(bundled.outputFiles[0].text, context);
    return context as {
        URL: new (input: string) => { href: string; hash: string };
        linkTitle: { getWebPageTitleRequestUrl(input: string): string | null; getBareHttpUrl(input: string): string | null };
    };
};

describe('native host URL polyfill', () => {
    it('serializes href like the platform URL, so the page title lookup gets its request URL', async () => {
        const host = await nativeHost();
        const url = new host.URL('https://news.mindwtr.app/story?id=7#top');
        expect(url.href).toBe('https://news.mindwtr.app/story?id=7#top');
        url.hash = '';
        expect(url.href).toBe('https://news.mindwtr.app/story?id=7');
        expect(new host.URL('https://news.mindwtr.app').href).toBe('https://news.mindwtr.app/');
        expect(host.linkTitle.getBareHttpUrl('https://news.mindwtr.app/story')).toBe('https://news.mindwtr.app/story');
        expect(host.linkTitle.getWebPageTitleRequestUrl('https://news.mindwtr.app/story#part')).toBe('https://news.mindwtr.app/story');
        for (const refused of ['http://127.0.0.1/x', 'https://news.mindwtr.app:8443/x', 'https://intranet.local/x', 'https://a@news.mindwtr.app/']) {
            expect(host.linkTitle.getWebPageTitleRequestUrl(refused)).toBeNull();
        }
    });
});
