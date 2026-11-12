import { afterEach, describe, expect, it } from 'vitest';
import { resolveNativeRouteDestination } from './native-route-destination';
import { openScreenHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { SavedFilter } from './types';

const at = '2026-11-12T00:00:00.000Z';
const filter = (id: string, view: SavedFilter['view'], extra: Partial<SavedFilter> = {}): SavedFilter => ({
    id, name: `Filter ${id}`, view, criteria: { contexts: ['@phone'] }, createdAt: at, updatedAt: at, ...extra,
});
const savedFilters = [
    filter('calls', 'contexts'),
    filter('id:with/slash 漢', 'contexts'),
    filter('focus-only', 'focus'),
    filter('deleted', 'contexts', { deletedAt: at }),
    filter('x'.repeat(501), 'contexts'),
];

afterEach(async () => { await flushPendingSave(); resetForTests(); });

const resolve = async (url: string, scheme = 'mindwtr') => {
    const host = await openScreenHost({ data: { settings: { savedFilters } }, record: {}, log: [] });
    const target = value(host.resolveNativeEntryPoint({ kind: 'link', url, scheme }));
    return resolveNativeRouteDestination(target, useTaskStore.getState().settings.savedFilters);
};

describe('native route destinations for widget and system links', () => {
    it.each([
        ['widget header Focus', 'mindwtr:///focus', { type: 'focus' }],
        ['widget header Inbox', 'mindwtr:///inbox', { type: 'inbox' }],
        ['widget header Waiting', 'mindwtr:///waiting', { type: 'waiting' }],
        ['widget header Someday', 'mindwtr:///someday', { type: 'someday' }],
        ['widget quick capture', 'mindwtr:///capture-quick?mode=text', { type: 'capture' }],
        ['detailed quick capture', 'mindwtr:///capture-quick?mode=text&entry=details', { type: 'capture' }],
        ['open feature capture', 'mindwtr://open-feature?feature=capture', { type: 'capture' }],
        ['open feature Waiting', 'mindwtr://open-feature?feature=waiting-for', { type: 'waiting' }],
        ['host-form route', 'mindwtr://someday', { type: 'someday' }],
        ['Next list header', 'mindwtr:///widget-list/next', { type: 'focus' }],
        ['Upcoming list header', 'mindwtr:///widget-list/upcoming', { type: 'focus' }],
        ['Contexts saved filter', 'mindwtr:///widget-list/filter%3Acalls', { type: 'contexts', savedFilterId: 'calls' }],
        ['unencoded saved filter', 'mindwtr:///widget-list/filter:calls', { type: 'contexts', savedFilterId: 'calls' }],
        ['saved list shortcut', 'mindwtr:///widget-list/filter%3Acalls?source=shortcut', { type: 'contexts', savedFilterId: 'calls' }],
        ['encoded saved filter ID', `mindwtr:///widget-list/${encodeURIComponent('filter:id:with/slash 漢')}`,
            { type: 'contexts', savedFilterId: 'id:with/slash 漢' }],
        ['developer scheme', 'mindwtr-native-dev:///waiting', { type: 'waiting' }],
        ['context activation', 'mindwtr://activate-context?context=home', { type: 'contextAutomation' }],
        ['context deactivation', 'mindwtr://deactivate-context/home', { type: 'contextAutomation' }],
        ['context query action', 'mindwtr://context?name=home&action=on', { type: 'contextAutomation' }],
        ['developer context activation', 'mindwtr-native-dev://activate-context/%40home', { type: 'contextAutomation' }],
    ])('opens %s', async (_label, url, expected) => {
        const scheme = url.startsWith('mindwtr-native-dev:') ? 'mindwtr-native-dev' : 'mindwtr';
        expect(await resolve(url, scheme)).toEqual(expected);
    });

    it.each([
        ['non-Contexts saved filter', 'mindwtr:///widget-list/filter%3Afocus-only'],
        ['deleted saved filter', 'mindwtr:///widget-list/filter%3Adeleted'],
        ['missing saved filter', 'mindwtr:///widget-list/filter%3Amissing'],
        ['oversize saved filter ID', `mindwtr:///widget-list/filter%3A${'x'.repeat(501)}`],
        ['blank saved filter', 'mindwtr:///widget-list/filter%3A%20'],
        ['context token list', 'mindwtr:///widget-list/context%3A%40phone'],
        ['malformed list encoding', 'mindwtr:///widget-list/%E0%A4%A'],
        ['unknown list', 'mindwtr:///widget-list/someday'],
        ['empty list', 'mindwtr:///widget-list/'],
        ['unknown route', 'mindwtr:///not-a-route'],
        ['task route', 'mindwtr://open?task=missing'],
        ['prefilled shortcut capture', 'mindwtr://capture?title=PRIVATE'],
        ['search', 'mindwtr://global-search?q=PRIVATE'],
        ['context link without a known action', 'mindwtr://context?name=home&action=enter'],
        ['foreign scheme', 'https://example.com/focus'],
    ])('keeps %s a no-op', async (_label, url) => {
        expect(await resolve(url)).toEqual({ type: 'none' });
    });

    it('does not write while resolving', async () => {
        const host = await openScreenHost({ data: { settings: { savedFilters } }, record: {}, log: [] });
        const before = useTaskStore.getState();
        resolveNativeRouteDestination(value(host.resolveNativeEntryPoint({
            kind: 'link', url: 'mindwtr:///widget-list/filter%3Acalls', scheme: 'mindwtr',
        })), before.settings.savedFilters);
        await flushPendingSave();
        expect(useTaskStore.getState().settings).toBe(before.settings);
        expect(useTaskStore.getState()._allTasks).toBe(before._allTasks);
    });
});
