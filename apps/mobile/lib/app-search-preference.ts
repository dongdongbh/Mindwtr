import AsyncStorage from '@react-native-async-storage/async-storage';
import { MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY } from '@mindwtr/core';
import { Platform } from 'react-native';


const STORAGE_KEY = 'mindwtr:appSearchIndexingEnabled';


const WIPE_OWED_KEY = MOBILE_APP_SEARCH_WIPE_OWED_STORAGE_KEY;


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


            await markAppSearchWipeOwed();
            await AsyncStorage.removeItem(STORAGE_KEY);
        }
    } catch {

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


export async function markAppSearchWipeOwed(): Promise<void> {
    if (!isAppSearchSupported()) return;
    try {
        await AsyncStorage.setItem(WIPE_OWED_KEY, 'true');
    } catch {

    }
}


export async function clearAppSearchWipeOwed(): Promise<void> {
    if (!isAppSearchSupported()) return;
    try {
        await AsyncStorage.removeItem(WIPE_OWED_KEY);
    } catch {

    }
}
