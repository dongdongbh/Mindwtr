import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ os: 'android', fetch: vi.fn() }));

vi.mock('react-native', () => ({ Platform: { get OS() { return state.os; } } }));
vi.mock('expo/fetch', () => ({ fetch: state.fetch }));

import { fetchMobileLinkTitle } from './link-title';

const page = () => new Response('<html><head><title>Getting Things Done - Wikipedia</title></head></html>', {
    headers: { 'content-type': 'text/html; charset=UTF-8' },
});

describe('fetchMobileLinkTitle', () => {
    beforeEach(() => {
        state.fetch.mockReset();
        state.fetch.mockImplementation(async () => page());
    });

    it.each([
        ['android', 'Mindwtr (Android; +https://github.com/dongdongbh/Mindwtr)'],
        ['ios', 'Mindwtr (iOS; +https://github.com/dongdongbh/Mindwtr)'],
    ])('names Mindwtr in the User-Agent on %s so Wikipedia serves the page', async (os, userAgent) => {
        state.os = os;
        await expect(fetchMobileLinkTitle('https://en.wikipedia.org/wiki/Getting_Things_Done'))
            .resolves.toBe('Getting Things Done - Wikipedia');
        const init = state.fetch.mock.calls[0]?.[1] as { headers: Record<string, string> };
        expect(init.headers).toMatchObject({ Accept: 'text/html, application/xhtml+xml', 'User-Agent': userAgent });
    });
});
