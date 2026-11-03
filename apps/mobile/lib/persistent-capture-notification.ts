import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, PermissionsAndroid, Platform } from 'react-native';

import {
    hidePersistentCaptureNotification,
    showPersistentCaptureNotification,
} from '@/modules/notification-open-intents';


const STORAGE_KEY = 'mindwtr:persistentCaptureNotification';

export type PersistentCaptureStrings = {
    title: string;
    text: string;
    channelName: string;
};

export function isPersistentCaptureSupported(): boolean {
    return Platform.OS === 'android';
}

export async function readPersistentCaptureEnabled(): Promise<boolean> {
    if (!isPersistentCaptureSupported()) return false;
    try {
        return (await AsyncStorage.getItem(STORAGE_KEY)) === 'true';
    } catch {
        return false;
    }
}

export async function writePersistentCaptureEnabled(enabled: boolean): Promise<void> {
    if (!isPersistentCaptureSupported()) return;
    try {
        if (enabled) {
            await AsyncStorage.setItem(STORAGE_KEY, 'true');
        } else {
            await AsyncStorage.removeItem(STORAGE_KEY);
        }
    } catch {

    }
}

async function hasNotificationPermission(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    if (Platform.Version < 33) return true;
    try {
        return await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    } catch {
        return false;
    }
}


let switchGeneration = 0;


export function applyPersistentCaptureNotification(enabled: boolean, strings: PersistentCaptureStrings): void {
    switchGeneration += 1;
    showOrHide(enabled, strings);
}

function showOrHide(enabled: boolean, strings: PersistentCaptureStrings): void {
    if (!isPersistentCaptureSupported()) return;
    if (enabled) {
        showPersistentCaptureNotification(strings.title, strings.text, strings.channelName);
    } else {
        hidePersistentCaptureNotification();
    }
}


export async function restorePersistentCaptureNotificationOnStartup(strings: PersistentCaptureStrings): Promise<void> {
    if (!isPersistentCaptureSupported()) return;
    const generation = switchGeneration;
    let stored: string | null;
    try {
        stored = await AsyncStorage.getItem(STORAGE_KEY);
    } catch {
        return;
    }

    if (generation !== switchGeneration) return;
    if (stored !== 'true') {


        showOrHide(false, strings);
        return;
    }
    if (!(await hasNotificationPermission())) return;
    if (generation !== switchGeneration) return;
    showOrHide(true, strings);
}


export function keepPersistentCaptureNotificationArmed(getStrings: () => PersistentCaptureStrings): () => void {
    if (!isPersistentCaptureSupported()) return () => {};
    void restorePersistentCaptureNotificationOnStartup(getStrings());
    const subscription = AppState.addEventListener('change', (state) => {
        if (state !== 'active') return;
        void restorePersistentCaptureNotificationOnStartup(getStrings());
    });
    return () => subscription.remove();
}
