import AsyncStorage from '@react-native-async-storage/async-storage';

import { getIosAppBadgeNative, type IosAppBadgeNative } from '@/modules/ios-app-badge';
import { logInfo, logWarn } from './app-log';

const STORAGE_KEY = 'mindwtr:iosAppBadgeEnabled';
export type IosAppBadgeToggleResult = 'enabled' | 'disabled' | 'denied' | 'unavailable';

type BadgePorts = {
    native: () => IosAppBadgeNative | null;
    read: () => Promise<string | null>;
    write: (enabled: boolean) => Promise<void>;
    report: (count: number, enabled: boolean, result: 'applied' | 'denied' | 'failed') => void;
};

/** One owner serializes preferences, authorization, and writes, including settings/lifecycle races. */
export function createIosAppBadgeController(ports: BadgePorts) {
    let queue: Promise<unknown> = Promise.resolve();
    let enabled: boolean | undefined;
    let intent: boolean | undefined;
    let generation = 0;
    let applied: { count: number; enabled: boolean; denied: boolean } | undefined;
    const listeners = new Set<() => void>();
    const emit = () => listeners.forEach((listener) => listener());
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = queue.catch(() => undefined).then(operation);
        queue = result;
        return result;
    };
    const load = async () => {
        if (enabled === undefined) enabled = (await ports.read()) === 'true';
        return enabled;
    };
    const apply = async (native: IosAppBadgeNative, count: number, active: boolean, force = false, denied = false) => {
        if (!force && applied?.count === count && applied.enabled === active && applied.denied === denied) return;
        try {
            await native.setBadgeCount(count);
            applied = { count, enabled: active, denied };
            ports.report(count, active, denied ? 'denied' : 'applied');
        } catch (error) {
            ports.report(count, active, 'failed');
            throw error;
        }
    };

    return {
        isSupported: () => ports.native() !== null,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        readEnabled: () => enqueue(async () => {
            const native = ports.native();
            // Read the saved opt-in so someone who revoked OS permission can still turn it off.
            return !!native && (await load()) && intent !== false;
        }),
        setEnabled(value: boolean): Promise<IosAppBadgeToggleResult> {
            // Invalidate an in-flight restore/permission request immediately, before its await returns.
            const revision = ++generation;
            intent = value;
            return enqueue(async () => {
                const native = ports.native();
                if (!native) return 'unavailable';
                if (revision !== generation) return intent ? 'enabled' : 'disabled';
                if (value) {
                    const allowed = await native.requestBadgeAuthorization();
                    if (revision !== generation) return intent ? 'enabled' : 'disabled';
                    if (!allowed) {
                        enabled = false;
                        intent = false;
                        await ports.write(false);
                        await apply(native, 0, false, true, true);
                        emit();
                        return 'denied';
                    }
                    await ports.write(true);
                    if (revision !== generation) return intent ? 'enabled' : 'disabled';
                    enabled = true;
                    emit();
                    return 'enabled';
                }
                enabled = false;
                // Clear even when durability fails; the rejected promise tells the settings UI to show the error.
                let persistenceError: unknown;
                try { await ports.write(false); } catch (error) { persistenceError = error; }
                try { await apply(native, 0, false, true); } finally { emit(); }
                if (persistenceError) throw persistenceError;
                return 'disabled';
            });
        },
        /** getCount is read AFTER authorization, so no stale task/workspace snapshot crosses an await. */
        refresh(getCount: () => number | null, options: { canWrite?: () => boolean; force?: boolean } = {}): Promise<void> {
            return enqueue(async () => {
                const native = ports.native();
                if (!native) return;
                const revision = generation;
                const active = await load();
                if (revision !== generation) return;
                if (!active || intent === false) {
                    // A disposed owner must not write over a newer workspace/root owner.
                    if (options.canWrite ? options.canWrite() : getCount() !== null) await apply(native, 0, false, options.force);
                    return;
                }
                const allowed = await native.isBadgeAuthorized();
                if (revision !== generation || options.canWrite?.() === false) return;
                const count = getCount();
                if (count === null) return;
                if (!allowed) {
                    await apply(native, 0, false, options.force, true);
                    return;
                }
                await apply(native, count, true, options.force);
            });
        },
    };
}

const controller = createIosAppBadgeController({
    native: getIosAppBadgeNative,
    read: () => AsyncStorage.getItem(STORAGE_KEY),
    write: (enabled) => AsyncStorage.setItem(STORAGE_KEY, String(enabled)),
    report: (count, enabled, result) => {
        const logger = result === 'failed' ? logWarn : logInfo;
        void logger('iOS task badge update', {
            scope: 'notifications',
            extra: { releaseCheck: 'v1.3.7/ios-task-badge', count, enabled, result },
        });
    },
});

export const isIosAppBadgeSupported = controller.isSupported;
export const readIosAppBadgeEnabled = controller.readEnabled;
export const setIosAppBadgeEnabled = controller.setEnabled;
export const subscribeIosAppBadgeEnabled = controller.subscribe;
export const refreshIosAppBadge = controller.refresh;
