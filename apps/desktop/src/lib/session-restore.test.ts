import { beforeEach, describe, expect, it } from 'vitest';
import { SESSION_RESTORE_WINDOW_MS } from '@mindwtr/core';

import { persistLastView, readRestorableLastView } from './session-restore';

describe('desktop session restore', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('round-trips a restorable view within the window', () => {
        persistLastView('projects', 'project-1');
        expect(readRestorableLastView()).toEqual({ view: 'projects', projectId: 'project-1' });
    });

    it('only keeps the project selection for the projects view', () => {
        persistLastView('agenda', 'project-1');
        expect(readRestorableLastView()).toEqual({ view: 'agenda' });
    });

    it('expires after the restore window', () => {
        persistLastView('board');
        expect(readRestorableLastView(Date.now() + SESSION_RESTORE_WINDOW_MS + 1000)).toBeNull();
    });

    it('keeps the previous snapshot when a transient view is persisted', () => {
        persistLastView('contexts');
        persistLastView('settings');
        expect(readRestorableLastView()).toEqual({ view: 'contexts' });
        persistLastView('obsidian');
        expect(readRestorableLastView()).toEqual({ view: 'contexts' });
    });

    it('restores the timeline view (#1111)', () => {
        persistLastView('timeline');
        expect(readRestorableLastView()).toEqual({ view: 'timeline' });
    });

    it('restores saved search views by prefix', () => {
        persistLastView('savedSearch:abc');
        expect(readRestorableLastView()).toEqual({ view: 'savedSearch:abc' });
    });

    it('ignores unknown views and malformed payloads', () => {
        window.localStorage.setItem('mindwtr-last-view', JSON.stringify({ view: 'not-a-view', at: Date.now() }));
        expect(readRestorableLastView()).toBeNull();
        window.localStorage.setItem('mindwtr-last-view', 'not json');
        expect(readRestorableLastView()).toBeNull();
    });
});
