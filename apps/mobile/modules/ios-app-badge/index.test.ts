import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ platform: { OS: 'ios' }, load: vi.fn() }));
vi.mock('react-native', () => ({ Platform: h.platform }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: h.load }));

describe('optional iOS app badge bridge', () => {
    beforeEach(() => { vi.resetModules(); h.load.mockReset(); h.platform.OS = 'ios'; });
    it.each(['android', 'web'])('does nothing on %s', async (platform) => {
        h.platform.OS = platform;
        const { getIosAppBadgeNative } = await import('./index');
        expect(getIosAppBadgeNative()).toBeNull();
        expect(h.load).not.toHaveBeenCalled();
    });
    it.each([null, {}, { isBadgeAuthorized: vi.fn() }])('declines unavailable or incomplete native modules: %j', async (value) => {
        h.load.mockReturnValue(value);
        const { getIosAppBadgeNative } = await import('./index');
        expect(getIosAppBadgeNative()).toBeNull();
    });
    it('does not crash if module loading throws', async () => {
        h.load.mockImplementation(() => { throw new Error('not linked'); });
        const { getIosAppBadgeNative } = await import('./index');
        expect(getIosAppBadgeNative()).toBeNull();
    });
    it('loads a complete bridge once without requesting permission', async () => {
        const native = { isBadgeAuthorized: vi.fn(), requestBadgeAuthorization: vi.fn(), setBadgeCount: vi.fn() };
        h.load.mockReturnValue(native);
        const { getIosAppBadgeNative } = await import('./index');
        expect(getIosAppBadgeNative()).toBe(native);
        expect(getIosAppBadgeNative()).toBe(native);
        expect(h.load).toHaveBeenCalledExactlyOnceWith('MindwtrIosAppBadge');
        expect(native.requestBadgeAuthorization).not.toHaveBeenCalled();
    });
});
