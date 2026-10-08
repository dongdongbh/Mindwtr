import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compareAppVersions, fetchAppStoreInfo } from '@mindwtr/core';
import { compareVersions } from './settings-utils';

vi.mock('./app-log', () => ({ logError: vi.fn(), logWarn: vi.fn() }));

afterEach(() => { vi.unstubAllGlobals(); });

describe('settings version comparison shared policy', () => {
    it('keeps the existing RN name as the exact core function', () => {
        expect(compareVersions).toBe(compareAppVersions);
    });

    it.each([
        [' v1.3.5-rc.1 ', '1.3.5', 0],
        ['1.3', '1.3.0', 0],
        ['1.10.0', '1.9.9', 1],
    ])('preserves the RN comparison for %s and %s', (left, right, expected) => {
        expect(compareVersions(left, right)).toBe(expected);
    });
});

describe('App Store listings with the maintained RN fallback URL', () => {
    it.each([
        ['https://apps.apple.com/app/id123456789', true],
        ['https://itunes.apple.com:443/app/id123456789', true],
        ['https://apps.apple.com/app/id123456789?source=synthetic@example.test', true],
        ['https://name@apps.apple.com/app/id123456789', false],
        ['https://name:synthetic@apps.apple.com/app/id123456789', false],
        ['https://apps.apple.com:8443/app/id123456789', false],
    ])('keeps version lookup usable and admits only an allowed HTTPS Apple authority (case %#)', async (listing, admitted) => {
        const source = readFileSync(new NodeURL('../shims/url-polyfill.js', import.meta.url), 'utf8');
        const context = { module: { exports: {} as { URL: typeof URL } }, URL: undefined, URLSearchParams: undefined };
        runInNewContext(source, context);
        expect(context.module.exports.URL.name).toBe('FallbackURL');
        vi.stubGlobal('URL', context.module.exports.URL);
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
            results: [{ version: '1.2.0', trackViewUrl: listing }],
        })));
        expect(await fetchAppStoreInfo('tech.example.mindwtr.dev', fetcher)).toEqual({
            version: '1.2.0', trackViewUrl: admitted ? listing : null,
        });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
