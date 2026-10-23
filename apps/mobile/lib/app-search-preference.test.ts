import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const mockGetItem = vi.hoisted(() => vi.fn());
const mockSetItem = vi.hoisted(() => vi.fn());
const mockRemoveItem = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ OS: 'android', Version: 34 }));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: mockGetItem,
        setItem: mockSetItem,
        removeItem: mockRemoveItem,
    },
}));

vi.mock('react-native', () => ({
    Platform: platformState,
}));

import {
    clearAppSearchWipeOwed,
    isAppSearchSupported,
    readAppSearchIndexingEnabled,
    readAppSearchWipeOwed,
    writeAppSearchIndexingEnabled,
} from './app-search-preference';

describe('app-search-preference', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        platformState.OS = 'android';
        platformState.Version = 34;
        mockGetItem.mockResolvedValue(null);
    });

    it('is supported on Android 12+ (API 31) only', () => {
        expect(isAppSearchSupported()).toBe(true);

        platformState.Version = 30;
        expect(isAppSearchSupported()).toBe(false);

        platformState.Version = 34;
        platformState.OS = 'ios';
        expect(isAppSearchSupported()).toBe(false);
    });

    it('round-trips the device-local preference', async () => {
        await writeAppSearchIndexingEnabled(true);
        expect(mockSetItem).toHaveBeenCalledWith('mindwtr:appSearchIndexingEnabled', 'true');

        mockGetItem.mockResolvedValue('true');
        expect(await readAppSearchIndexingEnabled()).toBe(true);

        await writeAppSearchIndexingEnabled(false);
        expect(mockRemoveItem).toHaveBeenCalledWith('mindwtr:appSearchIndexingEnabled');
    });

    // A toggle-off whose wipe never lands (the app dies first, or the wipe fails) must not leave titles in system search:
    // the owed wipe is stored before the switch goes, so the next start can finish it.
    it('stores an owed wipe before it removes the switch, and clears it on request', async () => {
        await writeAppSearchIndexingEnabled(false);
        expect(mockSetItem).toHaveBeenCalledWith('mindwtr:appSearchWipeOwed', 'true');
        expect(mockSetItem.mock.invocationCallOrder[0]).toBeLessThan(mockRemoveItem.mock.invocationCallOrder[0]);
        mockGetItem.mockImplementation(async (key: string) => (key === 'mindwtr:appSearchWipeOwed' ? 'true' : null));
        expect(await readAppSearchWipeOwed()).toBe(true);
        await clearAppSearchWipeOwed();
        expect(mockRemoveItem).toHaveBeenCalledWith('mindwtr:appSearchWipeOwed');
    });

    it('is inert when unsupported (old Android, or non-Android)', async () => {
        platformState.Version = 30;
        await writeAppSearchIndexingEnabled(true);
        expect(mockSetItem).not.toHaveBeenCalled();
        expect(await readAppSearchIndexingEnabled()).toBe(false);

        platformState.Version = 34;
        platformState.OS = 'ios';
        await writeAppSearchIndexingEnabled(true);
        expect(mockSetItem).not.toHaveBeenCalled();
        expect(await readAppSearchIndexingEnabled()).toBe(false);
    });
});
