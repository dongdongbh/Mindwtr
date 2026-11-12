import { afterEach, describe, expect, it } from 'vitest';
import { resolveNativeRouteDestination, resolveNativeShortcutCaptureDraft } from './native-route-destination';
import { openScreenHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { Project, SavedFilter } from './types';

const at = '2026-11-12T00:00:00.000Z';
const filter = (id: string, view: SavedFilter['view'], extra: Partial<SavedFilter> = {}): SavedFilter => ({
    id, name: `Filter ${id}`, view, criteria: { contexts: ['@phone'] }, createdAt: at, updatedAt: at, ...extra,
});
const savedFilters = [
    filter('calls', 'contexts'),
    filter('id:with/slash 漢', 'contexts'),
    filter('focus-only', 'focus'),
    filter('next-only', 'next'),
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
        ['Focus saved filter', 'mindwtr:///widget-list/filter%3Afocus-only?source=shortcut', { type: 'focusFilter', savedFilterId: 'focus-only' }],
        ['prefilled shortcut capture', 'mindwtr:///capture?title=Buy%20milk&requestId=x', { type: 'shortcutCapture' }],
        ['developer prefilled capture', 'mindwtr-native-dev:///capture?title=Buy', { type: 'shortcutCapture' }],
        ['open feature Projects', 'mindwtr://open-feature?feature=projects', { type: 'projects' }],
        ['open feature Review', 'mindwtr://open-feature?feature=weekly-review', { type: 'review' }],
        ['open feature Calendar', 'mindwtr://open-feature?feature=calendar', { type: 'calendar' }],
        ['open feature Inbox', 'mindwtr://open-feature?feature=inbox', { type: 'inbox' }],
        ['context activation', 'mindwtr://activate-context?context=home', { type: 'contextAutomation' }],
        ['context deactivation', 'mindwtr://deactivate-context/home', { type: 'contextAutomation' }],
        ['context query action', 'mindwtr://context?name=home&action=on', { type: 'contextAutomation' }],
        ['developer context activation', 'mindwtr-native-dev://activate-context/%40home', { type: 'contextAutomation' }],
    ])('opens %s', async (_label, url, expected) => {
        const scheme = url.startsWith('mindwtr-native-dev:') ? 'mindwtr-native-dev' : 'mindwtr';
        expect(await resolve(url, scheme)).toEqual(expected);
    });

    it.each([
        ['saved filter with a list view', 'mindwtr:///widget-list/filter%3Anext-only'],
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
        ['capture link without a title', 'mindwtr://capture?note=PRIVATE'],
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

describe('native shortcut capture drafts', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const project = (projectId: string, title: string, status: Project['status'] = 'active'): Project => ({
        id: projectId, title, status, color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at,
    });
    const data = { tasks: [{ id: 'existing' }], projects: [project('p-home', 'Home Base'), project('p-old', 'Old', 'archived')] };
    const draft = (query: string) => resolveNativeShortcutCaptureDraft(`mindwtr:///capture?${query}`, data);

    it('fills the RN capture fields and keeps the request ID as the capture ID', () => {
        expect(draft(`title=Buy%20milk&requestId=${id.toUpperCase()}&note=Two%20litres&tags=errand,%23home,errand&project=home%20base`))
            .toEqual({ type: 'draft', captureId: id, text: 'Buy milk #errand #home', note: 'Two litres', projectId: 'p-home' });
    });
    it('keeps a plus sign that Shortcuts sends as %2B', () => {
        expect(draft(`title=C%2B%2B%20notes&requestId=${id}`)).toMatchObject({ text: 'C++ notes' });
    });
    it('asks quick add to create a missing project, as RN does', () => {
        expect(draft('title=Plan&project=Garden')).toMatchObject({ text: 'Plan +Garden', projectId: '', captureId: '' });
        expect(draft('title=Plan&project=New%20Garden')).toMatchObject({ text: 'Plan +"New Garden"', projectId: '' });
    });
    it('drops a project that cannot take tasks, as RN does', () => {
        expect(draft('title=Plan&project=Old')).toMatchObject({ text: 'Plan', projectId: '' });
    });
    it('opens a request only once after its task exists', () => {
        expect(resolveNativeShortcutCaptureDraft(`mindwtr:///capture?title=Plan&requestId=${id}`,
            { ...data, tasks: [{ id }] })).toEqual({ type: 'none' });
    });
    it('ignores a request ID that is not a UUID', () => {
        expect(draft('title=Plan&requestId=existing')).toMatchObject({ type: 'draft', captureId: '' });
    });
    it('opens nothing without a title', () => {
        expect(draft('note=Only%20a%20note')).toEqual({ type: 'none' });
        expect(resolveNativeShortcutCaptureDraft('mindwtr:///focus', data)).toEqual({ type: 'none' });
    });
});
