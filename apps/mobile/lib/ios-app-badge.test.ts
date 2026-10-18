import { describe, expect, it, vi } from 'vitest';
import { createIosAppBadgeController } from './ios-app-badge';

vi.mock('@/modules/ios-app-badge', () => ({ getIosAppBadgeNative: () => null }));
vi.mock('./app-log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));


const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
const harness = (stored: string | null = null) => {
    const native = {
        requestBadgeAuthorization: vi.fn(async () => true), isBadgeAuthorized: vi.fn(async () => true),
        setBadgeCount: vi.fn(async (_count: number): Promise<void> => undefined),
    };
    const read = vi.fn(async () => stored);
    const write = vi.fn(async (_enabled: boolean): Promise<void> => undefined);
    const report = vi.fn();
    return { native, read, write, report, controller: createIosAppBadgeController({ native: () => native, read, write, report }) };
};

describe('iOS app badge controller', () => {
    it('defaults off and clears an old count without prompting', async () => {
        const h = harness();
        expect(await h.controller.readEnabled()).toBe(false);
        await h.controller.refresh(() => 8);
        expect(h.native.setBadgeCount).toHaveBeenCalledWith(0);
        expect(h.native.requestBadgeAuthorization).not.toHaveBeenCalled();
        expect(h.write).not.toHaveBeenCalled();
    });
    it('asks only on explicit enable, persists before announcing, and counts independently of reminder settings', async () => {
        const h = harness();
        const saved = deferred<void>();
        h.write.mockReturnValueOnce(saved.promise);
        const listener = vi.fn();
        h.controller.subscribe(listener);
        const enable = h.controller.setEnabled(true);
        await flush();
        expect(listener).not.toHaveBeenCalled();
        saved.resolve();
        expect(await enable).toBe('enabled');
        expect(h.write).toHaveBeenCalledWith(true);
        expect(listener).toHaveBeenCalledOnce();
        await h.controller.refresh(() => 5);
        expect(h.native.setBadgeCount).toHaveBeenLastCalledWith(5);
        expect(h.native.requestBadgeAuthorization).toHaveBeenCalledOnce();
        expect(await h.controller.readEnabled()).toBe(true);
    });
    it('denial leaves preference off and clears the count', async () => {
        const h = harness();
        h.native.requestBadgeAuthorization.mockResolvedValue(false);
        expect(await h.controller.setEnabled(true)).toBe('denied');
        expect(h.write).toHaveBeenCalledWith(false);
        expect(await h.controller.readEnabled()).toBe(false);
        expect(h.native.setBadgeCount).toHaveBeenLastCalledWith(0);
    });
    it('permission revoke clears without prompting; saved opt-in remains available to explicitly disable', async () => {
        const h = harness('true');
        h.native.isBadgeAuthorized.mockResolvedValue(false);
        await h.controller.refresh(() => 20);
        expect(h.native.setBadgeCount).toHaveBeenLastCalledWith(0);
        expect(await h.controller.readEnabled()).toBe(true);
        await h.controller.setEnabled(false);
        expect(h.write).toHaveBeenLastCalledWith(false);
        expect(await h.controller.readEnabled()).toBe(false);
        expect(h.native.requestBadgeAuthorization).not.toHaveBeenCalled();
    });
    it('uses fresh data and rechecks the owner after awaited authorization', async () => {
        const h = harness('true');
        const auth = deferred<boolean>();
        h.native.isBadgeAuthorized.mockReturnValueOnce(auth.promise);
        let count: number | null = 2;
        const refreshing = h.controller.refresh(() => count);
        await flush();
        count = 9;
        auth.resolve(true);
        await refreshing;
        expect(h.native.setBadgeCount).toHaveBeenLastCalledWith(9);
        h.native.isBadgeAuthorized.mockReturnValueOnce(auth.promise);
        count = null;
        await h.controller.refresh(() => count);
        expect(h.native.setBadgeCount).toHaveBeenCalledTimes(1);
    });
    it('late restore cannot override disable', async () => {
        const h = harness('true');
        const restored = deferred<string | null>();
        h.read.mockReturnValueOnce(restored.promise);
        const refreshing = h.controller.refresh(() => 12);
        await flush();
        const disable = h.controller.setEnabled(false);
        restored.resolve('true');
        await Promise.all([refreshing, disable]);
        expect(h.native.setBadgeCount.mock.calls).toEqual([[0]]);
        expect(await h.controller.readEnabled()).toBe(false);
    });
    it('late permission grant cannot enable after a newer disable', async () => {
        const h = harness();
        const auth = deferred<boolean>();
        h.native.requestBadgeAuthorization.mockReturnValueOnce(auth.promise);
        const enable = h.controller.setEnabled(true);
        await flush();
        const disable = h.controller.setEnabled(false);
        auth.resolve(true);
        expect(await enable).toBe('disabled');
        expect(await disable).toBe('disabled');
        expect(h.write.mock.calls).toEqual([[false]]);
        expect(h.native.setBadgeCount.mock.calls).toEqual([[0]]);
    });
    it('serializes an already-started native count ahead of the final disable clear', async () => {
        const h = harness('true');
        const applied = deferred<void>();
        h.native.setBadgeCount.mockReturnValueOnce(applied.promise);
        const refreshing = h.controller.refresh(() => 12);
        await flush();
        const disable = h.controller.setEnabled(false);
        await flush();
        expect(h.native.setBadgeCount.mock.calls).toEqual([[12]]);
        applied.resolve();
        await Promise.all([refreshing, disable]);
        expect(h.native.setBadgeCount.mock.calls).toEqual([[12], [0]]);
    });
    it('surfaces preference errors, still clears on failed disable and recovers queue', async () => {
        const h = harness('true');
        const failure = new Error('storage unavailable');
        h.write.mockRejectedValueOnce(failure);
        await expect(h.controller.setEnabled(false)).rejects.toBe(failure);
        expect(h.native.setBadgeCount).toHaveBeenLastCalledWith(0);
        expect(await h.controller.readEnabled()).toBe(false);
        expect(await h.controller.setEnabled(true)).toBe('enabled');
    });
    it('rejects enable persistence failure without announcing enabled', async () => {
        const h = harness();
        const listener = vi.fn();
        h.controller.subscribe(listener);
        h.write.mockRejectedValueOnce(new Error('storage unavailable'));
        await expect(h.controller.setEnabled(true)).rejects.toThrow('storage unavailable');
        expect(listener).not.toHaveBeenCalled();
        expect(await h.controller.readEnabled()).toBe(false);
    });
    it('optional native absence is nonfatal and never reads/writes storage or asks permission', async () => {
        const read = vi.fn(); const write = vi.fn();
        const controller = createIosAppBadgeController({ native: () => null, read, write, report: vi.fn() });
        expect(controller.isSupported()).toBe(false);
        expect(await controller.setEnabled(true)).toBe('unavailable');
        expect(await controller.readEnabled()).toBe(false);
        await controller.refresh(() => 1);
        expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    });
    it('unsubscribes preference listeners and logs only fixed count/enabled/result fields', async () => {
        const h = harness('true'); const listener = vi.fn();
        h.controller.subscribe(listener)();
        await h.controller.setEnabled(false);
        expect(listener).not.toHaveBeenCalled();
        expect(h.report).toHaveBeenLastCalledWith(0, false, 'applied');
    });
    it('deduplicates successful counts and denied diagnostics, but reasserts on startup/resume force', async () => {
        const h = harness('true');
        await h.controller.refresh(() => 4);
        await h.controller.refresh(() => 4);
        expect(h.native.setBadgeCount).toHaveBeenCalledTimes(1);
        expect(h.report).toHaveBeenCalledTimes(1);
        await h.controller.refresh(() => 4, { force: true });
        expect(h.native.setBadgeCount).toHaveBeenCalledTimes(2);
        h.native.isBadgeAuthorized.mockResolvedValue(false);
        await h.controller.refresh(() => 4);
        await h.controller.refresh(() => 4);
        expect(h.native.setBadgeCount).toHaveBeenCalledTimes(3);
        expect(h.report).toHaveBeenLastCalledWith(0, false, 'denied');
        await h.controller.refresh(() => 4, { force: true });
        expect(h.native.setBadgeCount).toHaveBeenCalledTimes(4);
    });
    it('does not count tasks while off and rejects a disposed off owner before clearing', async () => {
        const h = harness(); const getCount = vi.fn(() => 4);
        await h.controller.refresh(getCount, { canWrite: () => true });
        expect(getCount).not.toHaveBeenCalled();
        await h.controller.refresh(getCount, { canWrite: () => false, force: true });
        expect(h.native.setBadgeCount).toHaveBeenCalledTimes(1);
    });
});
