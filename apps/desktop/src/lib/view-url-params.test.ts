import { beforeEach, describe, expect, it } from 'vitest';

import { readViewFromUrl, VIEW_URL_PARAM, writeViewToUrl } from './view-url-params';

describe('view URL params (#931)', () => {
    beforeEach(() => {
        window.history.replaceState(null, '', '/');
    });

    describe('readViewFromUrl', () => {
        it('reads a known restorable view', () => {
            expect(readViewFromUrl('?view=projects')).toBe('projects');
        });

        it('reads settings and obsidian even though the localStorage snapshot excludes them', () => {
            expect(readViewFromUrl('?view=settings')).toBe('settings');
            expect(readViewFromUrl('?view=obsidian')).toBe('obsidian');
        });

        it('reads the timeline view (#1111)', () => {
            expect(readViewFromUrl('?view=timeline')).toBe('timeline');
        });

        it('reads a saved search by prefix', () => {
            expect(readViewFromUrl('?view=savedSearch:abc')).toBe('savedSearch:abc');
        });

        it('falls back to null for an unknown view rather than trusting it blindly', () => {
            expect(readViewFromUrl('?view=not-a-view')).toBeNull();
        });

        it('returns null when the param is absent', () => {
            expect(readViewFromUrl('')).toBeNull();
            expect(readViewFromUrl('?calendarView=week')).toBeNull();
        });

        it('reads the real window location when no search string is passed', () => {
            window.history.replaceState(null, '', `?${VIEW_URL_PARAM}=board`);
            expect(readViewFromUrl()).toBe('board');
        });
    });

    describe('writeViewToUrl', () => {
        it('sets the view param via replaceState', () => {
            writeViewToUrl('projects');
            expect(new URLSearchParams(window.location.search).get(VIEW_URL_PARAM)).toBe('projects');
        });

        it('preserves other existing query params, like the calendar ones', () => {
            window.history.replaceState(null, '', '?calendarView=week&calendarDate=2026-01-05');

            writeViewToUrl('settings');

            const params = new URLSearchParams(window.location.search);
            expect(params.get(VIEW_URL_PARAM)).toBe('settings');
            expect(params.get('calendarView')).toBe('week');
            expect(params.get('calendarDate')).toBe('2026-01-05');
        });

        it('does not write into the quick-add window', () => {
            window.history.replaceState(null, '', '?quickAddWindow=1');

            writeViewToUrl('settings');

            expect(new URLSearchParams(window.location.search).get(VIEW_URL_PARAM)).toBeNull();
        });
    });
});
