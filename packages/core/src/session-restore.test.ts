import { describe, expect, it } from 'vitest';

import frozen from './session-restore-parity.fixtures.json';
import {
    buildLastRouteSnapshot,
    isRestorableLastRoutePath,
    LAST_ROUTE_STORAGE_KEY,
    parseRestorableLastRoute,
    SESSION_RESTORE_WINDOW_MS,
    shouldRestoreLastView,
} from './session-restore';

describe('shouldRestoreLastView', () => {
    const now = Date.parse('2026-07-09T12:00:00.000Z');

    it('restores within the window and not after it', () => {
        expect(shouldRestoreLastView(now - 1000, now)).toBe(true);
        expect(shouldRestoreLastView(now - SESSION_RESTORE_WINDOW_MS, now)).toBe(true);
        expect(shouldRestoreLastView(now - SESSION_RESTORE_WINDOW_MS - 1, now)).toBe(false);
    });

    it('tolerates small clock skew but rejects far-future timestamps', () => {
        expect(shouldRestoreLastView(now + 30_000, now)).toBe(true);
        expect(shouldRestoreLastView(now + 5 * 60_000, now)).toBe(false);
    });

    it('rejects missing or malformed timestamps', () => {
        expect(shouldRestoreLastView(undefined, now)).toBe(false);
        expect(shouldRestoreLastView(null, now)).toBe(false);
        expect(shouldRestoreLastView('recent', now)).toBe(false);
        expect(shouldRestoreLastView(Number.NaN, now)).toBe(false);
    });
});


describe('last-screen snapshot (moved from React Native)', () => {
    const NOW = frozen.now;
    it('stores and reads exactly what React Native stored and read', () => {
        for (const write of frozen.writes) {
            expect(buildLastRouteSnapshot(write.pathname, write.params ?? undefined, write.openProjectId, NOW), write.pathname).toBe(write.stored);
        }
        for (const read of frozen.reads) expect(parseRestorableLastRoute(read.raw, read.nowMs), String(read.raw)).toEqual(read.result);
    });


    it('round-trips a restorable screen and stores nothing for a transient one', () => {
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/someday', undefined, null, NOW), NOW)).toEqual({ pathname: '/someday' });
        for (const transient of ['/capture-modal', '/settings', '/review-flow', '/global-search']) {
            expect(buildLastRouteSnapshot(transient, undefined, null, NOW)).toBeNull();
        }
    });


    it('carries the open project from the screen when the route has none', () => {
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/projects', undefined, 'p-open', NOW), NOW))
            .toEqual({ pathname: '/projects', params: { projectId: 'p-open' } });
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/projects-screen', { projectId: 'p-route' }, 'p-open', NOW), NOW))
            .toEqual({ pathname: '/projects-screen', params: { projectId: 'p-route' } });
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/inbox', undefined, 'p-open', NOW), NOW)).toEqual({ pathname: '/inbox' });
    });


    it('reopens History on its tab and drops other tab values', () => {
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/history', { tab: 'archived' }, null, NOW), NOW))
            .toEqual({ pathname: '/history', params: { tab: 'archived' } });
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/history', { tab: 'trash' }, null, NOW), NOW)).toEqual({ pathname: '/history' });
    });


    it('ages out after the restore window', () => {
        const stored = buildLastRouteSnapshot('/waiting', undefined, null, NOW);
        expect(parseRestorableLastRoute(stored, NOW + SESSION_RESTORE_WINDOW_MS)).toEqual({ pathname: '/waiting' });
        expect(parseRestorableLastRoute(stored, NOW + SESSION_RESTORE_WINDOW_MS + 1)).toBeNull();
    });

    it('restores saved searches by prefix and stores under the shared key', () => {
        expect(isRestorableLastRoutePath('/saved-search/abc')).toBe(true);
        expect(LAST_ROUTE_STORAGE_KEY).toBe('mindwtr:session:lastRoute');
    });
});
