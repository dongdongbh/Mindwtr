import React from 'react';
import { View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetLaunchContext, WidgetLaunchDestination, subscribeWidgetLaunch, useWidgetLaunch } from '@/hooks/use-widget-launch';
import { recordWidgetLaunchRouting } from '@/lib/widget-launch-routing';
import type { WidgetLaunchState } from '@/modules/android-widget';

const harness = vi.hoisted(() => ({
    state: null as WidgetLaunchState | null,
    focused: true,
    complete: vi.fn(), log: vi.fn(async () => undefined),
    listeners: new Set<() => void>(),
    paints: [] as { callback: () => void; cancelled: boolean }[],
}));
vi.mock('@/modules/android-widget', () => ({
    getWidgetLaunchState: () => harness.state,
    completeWidgetLaunch: harness.complete,
}));
vi.mock('@/lib/app-log', () => ({ logInfo: harness.log }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => harness.focused }));
vi.mock('react-native', () => ({ View: 'View', AppState: {
    addEventListener: (_: string, listener: () => void) => {
        harness.listeners.add(listener);
        return { remove: () => harness.listeners.delete(listener) };
    },
} }));
vi.mock('@mindwtr/core', () => ({ afterPaint: (callback: () => void) => {
    const paint = { callback, cancelled: false };
    harness.paints.push(paint);
    return () => { paint.cancelled = true; };
} }));

function Root({ path = '/focus', delivery = 0 }: { path?: string; delivery?: number }) {
    const launch = useWidgetLaunch(delivery);
    return <WidgetLaunchContext.Provider value={launch}><WidgetLaunchDestination path={path} /></WidgetLaunchContext.Provider>;
}
const pending = (token: number, path = '/focus'): WidgetLaunchState => ({ token, path, url: `mindwtr://${path}`, stage: 'pending' });
const paint = () => act(() => {
    for (const entry of harness.paints.splice(0)) if (!entry.cancelled) entry.callback();
});
const layout = (tree: ReactTestRenderer) => act(() => tree.root.findByType(View).props.onLayout());

describe('widget launch destination handoff', () => {
    beforeEach(() => {
        harness.state = null;
        harness.focused = true;
        harness.paints = [];
        harness.log.mockClear();
        harness.complete.mockReset().mockImplementation(async (token: number) => {
            if (harness.state?.token !== token || harness.state.stage !== 'pending') return false;
            harness.state = { ...harness.state, stage: 'acknowledged' };
            return true;
        });
    });

    it('waits for Router ownership, exact focused destination, native layout and paint; closes pristine editor first', async () => {
        harness.state = pending(101);
        const pristine = vi.fn(() => 'closed-clean' as const);
        const unsubscribe = subscribeWidgetLaunch(pristine);
        let tree!: ReactTestRenderer;
        await act(async () => { tree = create(<Root path="/inbox" />); });
        expect(pristine).toHaveBeenCalledOnce();
        expect(tree.toJSON()).toBeNull();
        act(() => recordWidgetLaunchRouting('mindwtr:///inbox'));
        expect(tree.toJSON()).toBeNull();
        act(() => recordWidgetLaunchRouting('mindwtr:///focus'));
        expect(tree.toJSON()).toBeNull();
        harness.focused = false;
        act(() => tree.update(<Root path="/focus" />));
        expect(tree.toJSON()).toBeNull();
        harness.focused = true;
        act(() => tree.update(<Root path="/focus" delivery={1} />));
        expect(harness.complete).not.toHaveBeenCalled();
        layout(tree);
        expect(harness.complete).not.toHaveBeenCalled();
        await act(async () => paint());
        expect(harness.complete).toHaveBeenCalledExactlyOnceWith(101);
        expect(harness.log).toHaveBeenCalledWith('Widget launch handoff finished', expect.objectContaining({
            extra: { releaseCheck: 'v1.3.8/widget-launch-destination', stage: 'acknowledged', outcome: 'closed-clean' },
        }));
        unsubscribe();
        act(() => tree.unmount());
    });

    it('requires the newest same-URL delivery and fresh layout; stale paint cannot release it', async () => {
        harness.state = pending(201);
        recordWidgetLaunchRouting('mindwtr:///focus');
        let tree!: ReactTestRenderer;
        await act(async () => { tree = create(<Root />); });
        layout(tree);
        harness.state = pending(202);
        act(() => { for (const listener of harness.listeners) listener(); });
        expect(tree.toJSON()).toBeNull();
        paint();
        expect(harness.complete).not.toHaveBeenCalled();
        // No useIncomingUrl key change: Router's independent repeated delivery wakes the hook.
        act(() => recordWidgetLaunchRouting('mindwtr:///focus'));
        layout(tree);
        await act(async () => paint());
        expect(harness.complete).toHaveBeenCalledExactlyOnceWith(202);
        act(() => tree.unmount());
    });

    it('matches decoded dynamic list ids and intentionally reveals a protected draft without saving or discarding it', async () => {
        harness.state = { ...pending(301, '/widget-list/context:Work/Home'), url: 'mindwtr:///widget-list/context%3AWork%2FHome' };
        recordWidgetLaunchRouting(harness.state.url);
        const protectedEditor = vi.fn(() => 'preserved-draft' as const);
        const unsubscribe = subscribeWidgetLaunch(protectedEditor);
        let tree!: ReactTestRenderer;
        await act(async () => { tree = create(<Root path="/widget-list/context:Work/Home" />); });
        layout(tree);
        await act(async () => paint());
        expect(protectedEditor).toHaveBeenCalledOnce();
        expect(harness.log).toHaveBeenCalledWith('Widget launch handoff finished', expect.objectContaining({
            extra: { releaseCheck: 'v1.3.8/widget-launch-destination', stage: 'acknowledged', outcome: 'preserved-draft' },
        }));
        expect(JSON.stringify(harness.log.mock.calls)).not.toMatch(/Work|Home|context:|mindwtr:/);
        unsubscribe();
        act(() => tree.unmount());
    });

    it('fails open for absent native support and reports native fallback/cancellation accurately', async () => {
        let tree!: ReactTestRenderer;
        await act(async () => { tree = create(<Root />); });
        expect(tree.toJSON()).toBeNull();
        for (const stage of ['fallback', 'cancelled'] as const) {
            harness.state = { ...pending(stage === 'fallback' ? 401 : 402), stage };
            act(() => { for (const listener of harness.listeners) listener(); });
            expect(tree.toJSON()).toBeNull();
            expect(harness.log).toHaveBeenCalledWith('Widget launch handoff finished', expect.objectContaining({ extra: expect.objectContaining({ stage }) }));
        }
        expect(harness.complete).not.toHaveBeenCalled();
        act(() => tree.unmount());
        expect(harness.listeners.size).toBe(0);
    });
});
