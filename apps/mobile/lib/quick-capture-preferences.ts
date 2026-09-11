import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';

// Device-local preference (P14): whether Quick Capture stays open after each
// save so Enter chains straight into the next capture. Per-device UX state,
// never part of the synced settings document.
const ADD_ANOTHER_STORAGE_KEY = 'mindwtr:quickCapture:addAnother';

export async function readQuickCaptureAddAnother(): Promise<boolean> {
    try {
        return (await AsyncStorage.getItem(ADD_ANOTHER_STORAGE_KEY)) === 'true';
    } catch {
        return false;
    }
}

export async function writeQuickCaptureAddAnother(enabled: boolean): Promise<void> {
    try {
        if (enabled) {
            await AsyncStorage.setItem(ADD_ANOTHER_STORAGE_KEY, 'true');
        } else {
            await AsyncStorage.removeItem(ADD_ANOTHER_STORAGE_KEY);
        }
    } catch {
        // storage unavailable — the toggle simply won't persist across opens
    }
}
