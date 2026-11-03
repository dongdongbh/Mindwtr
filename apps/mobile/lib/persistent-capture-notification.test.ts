import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetItem = vi.hoisted(() => vi.fn());
const mockSetItem = vi.hoisted(() => vi.fn());
const mockRemoveItem = vi.hoisted(() => vi.fn());
const mockShow = vi.hoisted(() => vi.fn());
const mockHide = vi.hoisted(() => vi.fn());
const mockPermissionCheck = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ OS: 'android', Version: 34 }));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: mockGetItem,
        setItem: mockSetItem,
        removeItem: mockRemoveItem,
    },
}));

const appStateListeners = vi.hoisted(() => [] as Array<(state: string) => void>);
const mockAppStateRemove = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
    Platform: platformState,
    PermissionsAndroid: {
        check: mockPermissionCheck,
        PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
    },
    AppState: {
        addEventListener: (_event: string, listener: (state: string) => void) => {
            appStateListeners.push(listener);
            return { remove: mockAppStateRemove };
        },
    },
}));

vi.mock('@/modules/notification-open-intents', () => ({
    showPersistentCaptureNotification: mockShow,
    hidePersistentCaptureNotification: mockHide,
}));

import {
    applyPersistentCaptureNotification,
    keepPersistentCaptureNotificationArmed,
    readPersistentCaptureEnabled,
    restorePersistentCaptureNotificationOnStartup,
    writePersistentCaptureEnabled,
} from './persistent-capture-notification';

const flushAsync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const strings = { title: 'Quick add', text: 'Tap to capture', channelName: 'Quick capture' };

describe('persistent-capture-notification', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        appStateListeners.length = 0;
        platformState.OS = 'android';
        platformState.Version = 34;
        mockPermissionCheck.mockResolvedValue(true);
        mockGetItem.mockResolvedValue(null);
    });

    it('round-trips the device-local preference', async () => {
        await writePersistentCaptureEnabled(true);
        expect(mockSetItem).toHaveBeenCalledWith('mindwtr:persistentCaptureNotification', 'true');

        mockGetItem.mockResolvedValue('true');
        expect(await readPersistentCaptureEnabled()).toBe(true);

        await writePersistentCaptureEnabled(false);
        expect(mockRemoveItem).toHaveBeenCalledWith('mindwtr:persistentCaptureNotification');
    });

    it('shows and hides the notification to match the toggle', () => {
        applyPersistentCaptureNotification(true, strings);
        expect(mockShow).toHaveBeenCalledWith('Quick add', 'Tap to capture', 'Quick capture');

        applyPersistentCaptureNotification(false, strings);
        expect(mockHide).toHaveBeenCalled();
    });

    it('re-posts on startup only when enabled and permitted', async () => {
        mockGetItem.mockResolvedValue('true');
        await restorePersistentCaptureNotificationOnStartup(strings);
        expect(mockShow).toHaveBeenCalledTimes(1);

        mockShow.mockClear();
        mockGetItem.mockResolvedValue(null);
        await restorePersistentCaptureNotificationOnStartup(strings);
        expect(mockShow).not.toHaveBeenCalled();

        mockGetItem.mockResolvedValue('true');
        mockPermissionCheck.mockResolvedValue(false);
        await restorePersistentCaptureNotificationOnStartup(strings);
        expect(mockShow).not.toHaveBeenCalled();
    });

    it('removes a notification left pinned by an off the app stopped in the middle of', async () => {


        mockGetItem.mockResolvedValue(null);
        await restorePersistentCaptureNotificationOnStartup(strings);
        expect(mockHide).toHaveBeenCalledTimes(1);
        expect(mockShow).not.toHaveBeenCalled();


        mockHide.mockClear();
        mockGetItem.mockRejectedValue(new Error('storage unavailable'));
        await restorePersistentCaptureNotificationOnStartup(strings);
        expect(mockHide).not.toHaveBeenCalled();
        expect(mockShow).not.toHaveBeenCalled();
    });

    it('never acts on a read the switch overtook while it was pending', async () => {


        let resolveRead: (value: string | null) => void = () => undefined;
        mockGetItem.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
        const pending = restorePersistentCaptureNotificationOnStartup(strings);
        applyPersistentCaptureNotification(true, strings);
        resolveRead(null);
        await pending;
        expect(mockShow).toHaveBeenCalledTimes(1);
        expect(mockHide).not.toHaveBeenCalled();
    });

    it('re-arms on every return to the foreground while enabled (#819)', async () => {
        mockGetItem.mockResolvedValue('true');
        const unsubscribe = keepPersistentCaptureNotificationArmed(() => strings);
        await flushAsync();
        expect(mockShow).toHaveBeenCalledTimes(1);

        appStateListeners.forEach((listener) => listener('background'));
        await flushAsync();
        expect(mockShow).toHaveBeenCalledTimes(1);

        appStateListeners.forEach((listener) => listener('active'));
        await flushAsync();
        expect(mockShow).toHaveBeenCalledTimes(2);


        mockGetItem.mockResolvedValue(null);
        appStateListeners.forEach((listener) => listener('active'));
        await flushAsync();
        expect(mockShow).toHaveBeenCalledTimes(2);

        unsubscribe();
        expect(mockAppStateRemove).toHaveBeenCalled();
    });

    it('is inert off Android', async () => {
        platformState.OS = 'ios';
        await writePersistentCaptureEnabled(true);
        applyPersistentCaptureNotification(true, strings);
        await restorePersistentCaptureNotificationOnStartup(strings);
        expect(mockSetItem).not.toHaveBeenCalled();
        expect(mockShow).not.toHaveBeenCalled();
        expect(await readPersistentCaptureEnabled()).toBe(false);
    });
});
