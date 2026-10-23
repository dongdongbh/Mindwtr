import AsyncStorage from '@react-native-async-storage/async-storage';
import { MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY } from '@mindwtr/core';
import { Platform } from 'react-native';

// Device-local preference (#1017): whether this device's task/project/area
// index is mirrored into Android's AppSearch PlatformStorage for system
// search. This is a device capability, not user data — it must never enter
// the synced settings document (a laptop or an iPhone has no such switch).
const STORAGE_KEY = 'mindwtr:appSearchIndexingEnabled';
// A toggle-off's wipe that has not landed yet (the app died first, or the wipe failed): the next start finishes it, so
// titles never stay in system search with the switch off.
const WIPE_OWED_KEY = MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY;

// PlatformStorage's system-search integration is only available from
// Android 12 (API 31); below that the setting is hidden entirely, per #1017.
const MIN_SUPPORTED_SDK = 31;

export function isAppSearchSupported(): boolean {
    return Platform.OS === 'android' && Number(Platform.Version) >= MIN_SUPPORTED_SDK;
}

export async function readAppSearchIndexingEnabled(): Promise<boolean> {
    if (!isAppSearchSupported()) return false;
    try {
        return (await AsyncStorage.getItem(STORAGE_KEY)) === 'true';
    } catch {
        return false;
    }
}

export async function writeAppSearchIndexingEnabled(enabled: boolean): Promise<void> {
    if (!isAppSearchSupported()) return;
    try {
        if (enabled) {
            await AsyncStorage.setItem(STORAGE_KEY, 'true');
        } else {
            // Owed first: a death between the two writes still leaves the wipe to finish. A failed owed write never keeps
            // the switch on.
            await markAppSearchWipeOwed();
            await AsyncStorage.removeItem(STORAGE_KEY);
        }
    } catch {
        // storage unavailable — the toggle simply won't persist across restarts
    }
}

export async function readAppSearchWipeOwed(): Promise<boolean> {
    if (!isAppSearchSupported()) return false;
    try {
        return (await AsyncStorage.getItem(WIPE_OWED_KEY)) === 'true';
    } catch {
        return false;
    }
}

/** Before a wipe is sent. */
export async function markAppSearchWipeOwed(): Promise<void> {
    if (!isAppSearchSupported()) return;
    try {
        await AsyncStorage.setItem(WIPE_OWED_KEY, 'true');
    } catch {
        // storage unavailable — the wipe still runs now; only its retry at the next start is lost
    }
}

/** After a wipe landed. */
export async function clearAppSearchWipeOwed(): Promise<void> {
    if (!isAppSearchSupported()) return;
    try {
        await AsyncStorage.removeItem(WIPE_OWED_KEY);
    } catch {
        // storage unavailable — the next start wipes once more, which is harmless
    }
}
