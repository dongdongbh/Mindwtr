import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    compareAppVersions, fetchAppStoreInfo, shouldCheckForAppUpdate,
    UPDATE_BADGE_AVAILABLE_KEY, UPDATE_BADGE_INTERVAL_MS, UPDATE_BADGE_LAST_CHECK_KEY, UPDATE_BADGE_LATEST_KEY,
} from './app-store-update';
import * as mobileConstants from '../../../apps/mobile/components/settings/settings.constants';

const bundle = 'tech.example.mindwtr.dev';
const listing = 'https://apps.apple.com/us/app/mindwtr/id123456789';
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const result = (version: unknown, trackViewUrl: unknown = listing) => ({ results: [{ version, trackViewUrl }] });

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('device-local update check expiry inherited from RN', () => {
    const day = 86_400_000;
    it.each([
        [null, day - 1, false], [undefined, day, true], ['', day, true],
        ['100', day + 99, false], ['100', day + 100, true],
        ['101', 100, false], ['invalid', 100, true], ['100ms', day + 100, true],
        ['-5', day, true],
    ])('last check %s at %i is due: %s', (raw, now, due) => {
        expect(shouldCheckForAppUpdate(raw, now)).toBe(due);
    });
    it('uses the current clock by default and retains the original RN key aliases', () => {
        vi.spyOn(Date, 'now').mockReturnValue(day);
        expect(shouldCheckForAppUpdate('0')).toBe(true);
        expect(UPDATE_BADGE_INTERVAL_MS).toBe(day);
        expect([UPDATE_BADGE_AVAILABLE_KEY, UPDATE_BADGE_LAST_CHECK_KEY, UPDATE_BADGE_LATEST_KEY]).toEqual([
            'mindwtr-update-available', 'mindwtr-update-last-check', 'mindwtr-update-latest',
        ]);
        for (const name of ['UPDATE_BADGE_AVAILABLE_KEY', 'UPDATE_BADGE_LAST_CHECK_KEY', 'UPDATE_BADGE_LATEST_KEY', 'UPDATE_BADGE_INTERVAL_MS'] as const) {
            expect(mobileConstants[name]).toBe({ UPDATE_BADGE_AVAILABLE_KEY, UPDATE_BADGE_LAST_CHECK_KEY, UPDATE_BADGE_LATEST_KEY, UPDATE_BADGE_INTERVAL_MS }[name]);
        }
    });
});

describe('compareAppVersions inherited numeric policy', () => {
    it.each([
        [' v1.2.3 ', '1.2.3', 0],
        ['V1.2.3', '1.2.2', 1],
        ['1.2.3-rc.7', '1.2.3', 0],
        ['1.2.3+build.9', '1.2.3', 0],
        ['1.2', '1.2.0', 0],
        ['1', '1.0.0', 0],
        ['1.2.0.1', '1.2', 1],
        ['1.9', '1.10', -1],
        ['release2.7x', '2.7', 0],
        ['unknown', '0.0', 0],
        ['', '0', 0],
    ])('%s compared with %s returns %s', (left, right, expected) => {
        expect(compareAppVersions(left, right)).toBe(expected);
    });
});

describe('fetchAppStoreInfo regional lookup', () => {
    it('tries default then US with a fresh cache-buster, inherited headers and no-store, choosing the newer version', async () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(1001).mockReturnValueOnce(1002);
        const newerListing = 'https://itunes.apple.com/app/id987654321?mt=8';
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response(result(' 1.2.0 ')))
            .mockResolvedValueOnce(response(result('1.3.0', newerListing)));
        expect(await fetchAppStoreInfo(bundle, fetcher)).toEqual({ version: '1.3.0', trackViewUrl: newerListing });
        expect(fetcher.mock.calls).toEqual([
            [`https://itunes.apple.com/lookup?bundleId=${bundle}&_=1001`, {
                cache: 'no-store', headers: { Accept: 'application/json', 'User-Agent': 'Mindwtr-App' },
            }],
            [`https://itunes.apple.com/lookup?bundleId=${bundle}&country=US&_=1002`, {
                cache: 'no-store', headers: { Accept: 'application/json', 'User-Agent': 'Mindwtr-App' },
            }],
        ]);
    });

    it.each(['1.0.0', '2.0.0-rc.1'])('retains the default region on a lower or numerically equal US version %s', async (usVersion) => {
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response(result('2.0.0', listing)))
            .mockResolvedValueOnce(response(result(usVersion, 'https://apps.apple.com/app/id987654321')));
        expect(await fetchAppStoreInfo(bundle, fetcher)).toEqual({ version: '2.0.0', trackViewUrl: listing });
    });

    it.each([
        ['HTTP failure', response({}, 503)],
        ['missing results', response({})],
        ['invalid results', response({ results: null })],
        ['empty results', response({ results: [] })],
        ['non-string version', response(result(123))],
        ['empty version', response(result('   '))],
    ])('continues after a default-region %s when US has a usable result', async (_, unusable) => {
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(unusable)
            .mockResolvedValueOnce(response(result('1.4.0')));
        expect(await fetchAppStoreInfo(bundle, fetcher)).toEqual({ version: '1.4.0', trackViewUrl: listing });
    });

    it('keeps a usable default region when US has an unusable payload', async () => {
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response(result('1.4.0')))
            .mockResolvedValueOnce(response({ results: [] }));
        expect(await fetchAppStoreInfo(bundle, fetcher)).toEqual({ version: '1.4.0', trackViewUrl: listing });
    });

    it('throws the final parse error when both regions are unusable', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1001);
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({}, 503))
            .mockResolvedValueOnce(response({ results: [] }));
        await expect(fetchAppStoreInfo(bundle, fetcher)).rejects.toThrow(
            `Unable to parse App Store version from https://itunes.apple.com/lookup?bundleId=${bundle}&country=US&_=1001`,
        );
    });

    it('throws the final HTTP error when both regions fail HTTP admission', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1001);
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({}, 404))
            .mockResolvedValueOnce(response({}, 503));
        await expect(fetchAppStoreInfo(bundle, fetcher)).rejects.toThrow(
            `App Store lookup failed (https://itunes.apple.com/lookup?bundleId=${bundle}&country=US&_=1001): 503`,
        );
    });

    it('only considers the first result, preserving the existing lookup behavior', async () => {
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({ results: [{ version: '1.0.0' }, { version: '99.0.0' }] }))
            .mockResolvedValueOnce(response(result('2.0.0')));
        expect((await fetchAppStoreInfo(bundle, fetcher)).version).toBe('2.0.0');
    });

    it('encodes the caller-supplied bundle identity without substituting a production identifier', async () => {
        const identifier = 'tech.example.dev &preview=1/中文';
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(result('1.0.0')));
        await fetchAppStoreInfo(identifier, fetcher);
        for (const [input] of fetcher.mock.calls) {
            const url = new URL(String(input));
            expect(url.origin).toBe('https://itunes.apple.com');
            expect(url.pathname).toBe('/lookup');
            expect(url.searchParams.get('bundleId')).toBe(identifier);
            expect(url.searchParams.has('preview')).toBe(false);
        }
    });

    it.each(['', ' \t\n '])('refuses an empty bundle identity before fetching', async (identifier) => {
        const fetcher = vi.fn<typeof fetch>();
        await expect(fetchAppStoreInfo(identifier, fetcher)).rejects.toThrow('App Store lookup requires a bundle identifier');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('uses the current global fetch by default', async () => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(result('1.0.0')));
        vi.stubGlobal('fetch', fetcher);
        expect((await fetchAppStoreInfo(bundle)).version).toBe('1.0.0');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each([false, true])('preserves immediate transport-error propagation (earlier usable result: %s)', async (earlierUsable) => {
        const failure = new Error('Mock transport refused');
        const fetcher = vi.fn<typeof fetch>();
        if (earlierUsable) fetcher.mockResolvedValueOnce(response(result('1.0.0')));
        fetcher.mockRejectedValueOnce(failure);
        await expect(fetchAppStoreInfo(bundle, fetcher)).rejects.toBe(failure);
        expect(fetcher).toHaveBeenCalledTimes(earlierUsable ? 2 : 1);
    });

    it('preserves immediate JSON decode-error propagation', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('invalid JSON'));
        await expect(fetchAppStoreInfo(bundle, fetcher)).rejects.toBeInstanceOf(SyntaxError);
        expect(fetcher).toHaveBeenCalledOnce();
    });
});

describe('App Store listing URLs from the response', () => {
    it.each([
        listing,
        'https://apps.apple.com/app/id123456789',
        'https://apps.apple.com:443/app/id123456789',
        'https://itunes.apple.com/us/app/mindwtr/id123456789?mt=8',
        'https://itunes.apple.com/app/id123456789?action=write-review',
    ])('accepts a bounded HTTPS Apple listing: %s', async (trackViewUrl) => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(result('1.2.0', ` ${trackViewUrl} `)));
        expect(await fetchAppStoreInfo(bundle, fetcher)).toEqual({ version: '1.2.0', trackViewUrl });
    });

    it.each([
        undefined, null, 123, '', '   ',
        'http://apps.apple.com/app/id123456789',
        'https://apps.apple.com.evil.example/app/id123456789',
        'https://evil.example/app/id123456789',
        'https://apps.apple.com@evil.example/app/id123456789',
        'https://name:secret@apps.apple.com/app/id123456789',
        'https://apps.apple.com:8443/app/id123456789',
        '//apps.apple.com/app/id123456789',
        'itms-apps://apps.apple.com/app/id123456789',
        'javascript:alert(1)',
        'https://apps.apple.com/app/mindwtr',
        'https://apps.apple.com/app/id123bad',
        'https://apps.apple.com/app/id123456789/other',
        'https://apps.apple.com/lookup?id=123456789',
        'https://apps.apple.com/app/\nid123456789',
        'https://apps.apple.com/app/\\id123456789',
        `https://apps.apple.com/app/${'a'.repeat(2_048)}/id123456789`,
    ])('discards an absent or unsafe listing while retaining version (case %#)', async (trackViewUrl) => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(result('1.2.0', trackViewUrl === undefined ? null : trackViewUrl)));
        expect(await fetchAppStoreInfo(bundle, fetcher)).toEqual({ version: '1.2.0', trackViewUrl: null });
    });

    it('retains a version when the listing field is omitted', async () => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ results: [{ version: '1.2.0' }] }));
        expect(await fetchAppStoreInfo(bundle, fetcher)).toEqual({ version: '1.2.0', trackViewUrl: null });
    });

    it('keeps the newer version when its unsafe listing is discarded rather than selecting an older safe listing', async () => {
        const fetcher = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response(result('1.0.0', listing)))
            .mockResolvedValueOnce(response(result('2.0.0', 'https://evil.example/app/id123')));
        expect(await fetchAppStoreInfo(bundle, fetcher)).toEqual({ version: '2.0.0', trackViewUrl: null });
    });
});
