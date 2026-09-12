import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RESTORE_WINDOW_MS } from '@mindwtr/core';

const memoryStore = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (key: string) => memoryStore.get(key) ?? null,
        setItem: async (key: string, value: string) => { memoryStore.set(key, value); },
        removeItem: async (key: string) => { memoryStore.delete(key); },
    },
}));

import {
    persistLastRoute,
    readRestorableRoute,
    sanitizeAndroidActivityNavigationState,
    setSessionRestoreOpenProject,
} from './session-restore';

describe('mobile session restore', () => {
    beforeEach(() => {
        memoryStore.clear();
        setSessionRestoreOpenProject(null);
    });

    it('round-trips a restorable route within the window', async () => {
        await persistLastRoute('/projects-screen', { projectId: 'project-1' });
        expect(await readRestorableRoute()).toEqual({
            pathname: '/projects-screen',
            params: { projectId: 'project-1' },
        });
    });

    it('drops params outside the project context and off the projects screen', async () => {
        await persistLastRoute('/projects-screen', { projectId: 'project-1', openToken: 'x' } as never);
        expect(await readRestorableRoute()).toEqual({
            pathname: '/projects-screen',
            params: { projectId: 'project-1' },
        });
        await persistLastRoute('/inbox', { projectId: 'project-1' });
        expect(await readRestorableRoute()).toEqual({ pathname: '/inbox' });
    });

    it('expires after the restore window', async () => {
        await persistLastRoute('/board');
        expect(await readRestorableRoute(Date.now() + SESSION_RESTORE_WINDOW_MS + 1000)).toBeNull();
    });

    it('keeps the previous snapshot when a transient route is persisted', async () => {
        await persistLastRoute('/contexts');
        await persistLastRoute('/capture-modal');
        expect(await readRestorableRoute()).toEqual({ pathname: '/contexts' });
        await persistLastRoute('/settings');
        expect(await readRestorableRoute()).toEqual({ pathname: '/contexts' });
    });

    it('carries the open project from the screen mirror when the route has no param', async () => {
        // Tapping a project row opens it via component state only (#842) —
        // the mirrored id must land in the snapshot without a route param.
        setSessionRestoreOpenProject('project-2');
        await persistLastRoute('/projects-screen');
        expect(await readRestorableRoute()).toEqual({
            pathname: '/projects-screen',
            params: { projectId: 'project-2' },
        });

        // Off the projects surfaces the mirror must not leak into snapshots.
        await persistLastRoute('/focus');
        expect(await readRestorableRoute()).toEqual({ pathname: '/focus' });

        // Closing the project clears the mirror.
        setSessionRestoreOpenProject(null);
        await persistLastRoute('/projects-screen');
        expect(await readRestorableRoute()).toEqual({ pathname: '/projects-screen' });
    });

    it('restores saved search routes by prefix', async () => {
        await persistLastRoute('/saved-search/abc');
        expect(await readRestorableRoute()).toEqual({ pathname: '/saved-search/abc' });
    });

    it('ignores unknown routes and malformed payloads', async () => {
        memoryStore.set('mindwtr:session:lastRoute', JSON.stringify({ pathname: '/nope', at: Date.now() }));
        expect(await readRestorableRoute()).toBeNull();
        memoryStore.set('mindwtr:session:lastRoute', 'not json');
        expect(await readRestorableRoute()).toBeNull();
    });

    it('preserves regular navigation history while excluding routed capture and one-shot params', () => {
        const sanitized = sanitizeAndroidActivityNavigationState({
            stale: false,
            type: 'stack',
            key: 'root',
            index: 2,
            routeNames: ['index', '(drawer)', 'capture-modal'],
            routes: [
                { key: 'index-1', name: 'index' },
                {
                    key: 'drawer-1',
                    name: '(drawer)',
                    state: {
                        stale: false,
                        type: 'drawer',
                        key: 'drawer',
                        index: 1,
                        routeNames: ['focus', 'projects-screen'],
                        routes: [
                            { key: 'focus-1', name: 'focus' },
                            {
                                key: 'projects-1',
                                name: 'projects-screen',
                                params: { projectId: 'p1', openToken: 'once' },
                            },
                        ],
                    },
                },
                {
                    key: 'capture-1',
                    name: 'capture-modal',
                    params: { initialValue: 'private draft', returnTo: '/projects' },
                },
            ],
        });

        expect(sanitized?.routes.map((route) => route.name)).toEqual(['(drawer)']);
        expect(sanitized?.index).toBe(0);
        expect(sanitized?.routes[0]?.state?.routes[1]?.params).toEqual({ projectId: 'p1' });
    });

    it('rejects malformed or unbounded navigation states', () => {
        expect(sanitizeAndroidActivityNavigationState(undefined)).toBeNull();
        expect(sanitizeAndroidActivityNavigationState({ routes: [] } as never)).toBeNull();
        expect(sanitizeAndroidActivityNavigationState({
            stale: false,
            type: 'stack',
            key: 'root',
            index: 0,
            routeNames: [],
            routes: Array.from({ length: 65 }, (_, index) => ({ key: `route-${index}`, name: 'screen' })),
        })).toBeNull();
    });
});
