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

// The last-screen snapshot moved from React Native (pass O2a): its text and its parse stay byte-identical to RN's, frozen
// from RN's lib/session-restore.ts before the move (session-restore-parity.fixtures.json), and its fix history is pinned here.
describe('last-screen snapshot (moved from React Native)', () => {
    const NOW = frozen.now;
    it('stores and reads exactly what React Native stored and read', () => {
        for (const write of frozen.writes) {
            expect(buildLastRouteSnapshot(write.pathname, write.params ?? undefined, write.openProjectId, NOW), write.pathname).toBe(write.stored);
        }
        for (const read of frozen.reads) expect(parseRestorableLastRoute(read.raw, read.nowMs), String(read.raw)).toEqual(read.result);
    });

    // cad4bd6ed: a transient screen keeps the previous snapshot (nothing to store); a restorable one round-trips.
    it('round-trips a restorable screen and stores nothing for a transient one', () => {
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/someday', undefined, null, NOW), NOW)).toEqual({ pathname: '/someday' });
        for (const transient of ['/capture-modal', '/settings', '/review-flow', '/global-search']) {
            expect(buildLastRouteSnapshot(transient, undefined, null, NOW)).toBeNull();
        }
    });

    // 921c7c103: the open project comes back even when the route has no param; the route's own param wins.
    it('carries the open project from the screen when the route has none', () => {
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/projects', undefined, 'p-open', NOW), NOW))
            .toEqual({ pathname: '/projects', params: { projectId: 'p-open' } });
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/projects-screen', { projectId: 'p-route' }, 'p-open', NOW), NOW))
            .toEqual({ pathname: '/projects-screen', params: { projectId: 'p-route' } });
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/inbox', undefined, 'p-open', NOW), NOW)).toEqual({ pathname: '/inbox' });
    });

    // f1b1d6255: History reopens on its Done or Archived tab; any other value is dropped.
    it('reopens History on its tab and drops other tab values', () => {
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/history', { tab: 'archived' }, null, NOW), NOW))
            .toEqual({ pathname: '/history', params: { tab: 'archived' } });
        expect(parseRestorableLastRoute(buildLastRouteSnapshot('/history', { tab: 'trash' }, null, NOW), NOW)).toEqual({ pathname: '/history' });
    });

    // eaa1458b3 through the snapshot: the window is 25 minutes, measured from the stored time.
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
