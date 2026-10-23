import { afterEach, describe, expect, it } from 'bun:test';
import { resetForTests, useTaskStore } from '@mindwtr/core';
import { createWidgetPublisher, type WidgetBridge } from './host-widgets';

// The widget publication on leaving the app (ProcessCoreHost's "background"): RN flushes a refresh still waiting; it does not
// build the whole payload again when nothing changed. At 5,000 tasks that build held the engine about 300 ms on the S23, right
// when a leave-time sync starts its read.

const bridge = (stale = false) => {
    const calls = { builds: 0, published: [] as string[] };
    const value: WidgetBridge = {
        // publish() asks ready() once per build, before it reads the store.
        ready: () => { calls.builds += 1; return true; },
        inputs: () => ({ systemColorScheme: 'light', systemLocale: 'en-US', listSelections: [], stale }),
        publish: (payload) => { calls.published.push(payload); },
        storedLanguage: () => 'en',
        active: () => false,
    };
    return { value, calls };
};

describe('native Android widget publisher on leaving the app', () => {
    afterEach(() => resetForTests());

    it('builds nothing when no store change waits and the last publication reached the widgets', () => {
        resetForTests();
        const { value, calls } = bridge();
        const widgets = createWidgetPublisher(value);
        expect(widgets.publish()).toBe(true);
        const built = calls.builds;

        expect(widgets.flush()).toBe(false);
        expect(calls.builds).toBe(built);
        expect(calls.published).toHaveLength(1);
    });

    it('publishes a waiting store change at once', () => {
        resetForTests();
        const { value, calls } = bridge();
        const widgets = createWidgetPublisher(value);
        widgets.publish();
        useTaskStore.setState({ lastDataChangeAt: Date.now() + 1, tasks: [], _allTasks: [{
            id: 't-1', title: 'Changed', status: 'next', tags: [], contexts: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }] } as never);

        expect(widgets.flush()).toBe(true);
        expect(calls.published).toHaveLength(2);
        expect(calls.published[1]).toContain('Changed');
    });

    it('publishes a waiting Focus filter change, which only arms the timer', () => {
        resetForTests();
        const { value, calls } = bridge();
        const widgets = createWidgetPublisher(value);
        widgets.publish();
        widgets.focusFilter({ criteria: { priority: ['high'] }, sortBy: 'default', sortOrder: null });

        expect(widgets.flush()).toBe(true);
        expect(calls.builds).toBe(2);
    });

    it('sends the last publication again when Kotlin says it never reached the widgets', () => {
        resetForTests();
        const healthy = bridge();
        const widgets = createWidgetPublisher(healthy.value);
        widgets.publish();
        healthy.value.inputs = () => ({ systemColorScheme: 'light', systemLocale: 'en-US', listSelections: [], stale: true });

        expect(widgets.flush()).toBe(true);
        expect(healthy.calls.published).toHaveLength(2);
    });
});

describe('native Android widget publisher and the widget chooser', () => {
    afterEach(() => resetForTests());

    it('builds a list the chooser picked at the next publication, with no store change', () => {
        resetForTests();
        const now = new Date().toISOString();
        useTaskStore.setState({ _allTasks: [{ id: 't-desk', title: 'Desk', status: 'next', tags: [], contexts: ['@desk'], createdAt: now, updatedAt: now }] } as never);
        const { value, calls } = bridge();
        const widgets = createWidgetPublisher(value);
        widgets.publish();
        const first = JSON.parse(calls.published[0]);
        // The chooser offers every context by name; the list comes only for a placed choice (core's androidWidgetProjectionOptions).
        expect(first.contexts.map((option: { id: string }) => option.id)).toEqual(['context:@desk']);
        expect(first.lists['context:@desk']).toBeUndefined();

        value.inputs = () => ({ systemColorScheme: 'light', systemLocale: 'en-US', listSelections: ['context:@desk'] });
        expect(widgets.publish()).toBe(true);
        const next = JSON.parse(calls.published[1]);
        expect(next.lists['context:@desk'].items.map((item: { id: string }) => item.id)).toEqual(['t-desk']);
    });
});
