import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ api: {} as Record<string, unknown> | null }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => harness.api }));

describe('widget launch native compatibility', () => {
    beforeEach(() => { vi.resetModules(); harness.api = {}; });
    it.each([null, {}])('keeps ordinary navigation when the native module or new methods are absent', async (api) => {
        harness.api = api;
        const bridge = await import('./index');
        expect(bridge.getWidgetLaunchState()).toBeNull();
        expect(await bridge.completeWidgetLaunch(1)).toBe(false);
    });
    it('validates native state and treats unavailable bridge calls as a failed acknowledgement', async () => {
        const snapshot = vi.fn();
        harness.api = { getWidgetLaunchState: snapshot, completeWidgetLaunch: vi.fn(async () => { throw new Error('unavailable'); }) };
        const bridge = await import('./index');
        for (const state of [null, {}, { token: -1, path: '/focus', url: 'mindwtr:///focus', stage: 'pending' }, { token: 1, path: '/focus', url: 'mindwtr:///focus', stage: 'unexpected' }]) {
            snapshot.mockReturnValue(state);
            expect(bridge.getWidgetLaunchState()).toBeNull();
        }
        const valid = { token: 2, path: '/focus', url: 'mindwtr:///focus', stage: 'pending' };
        snapshot.mockReturnValue(valid);
        expect(bridge.getWidgetLaunchState()).toEqual(valid);
        expect(await bridge.completeWidgetLaunch(2)).toBe(false);
    });
});
