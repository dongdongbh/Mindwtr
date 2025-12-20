import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { AppData } from '@mindwtr/core';
import { Platform } from 'react-native';

// StorageAccessFramework is part of the legacy FileSystem module
const StorageAccessFramework = (FileSystem as any).StorageAccessFramework;

interface PickResult extends AppData {
    __fileUri?: string;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeJsonText(raw: string): string {
    // Strip BOM and trailing NULs which can appear with partial/unsafe writes.
    let text = raw.replace(/^\uFEFF/, '').trim();
    // eslint-disable-next-line no-control-regex
    text = text.replace(/\u0000+$/g, '').trim();
    return text;
}

function parseAppData(text: string): AppData {
    const sanitized = sanitizeJsonText(text);
    if (!sanitized) throw new Error('Sync file is empty');
    const tryParse = (value: string): AppData => {
        const data = JSON.parse(value) as AppData;
        if (!data.tasks || !data.projects) {
            throw new Error('Invalid data format');
        }
        return data;
    };

    try {
        return tryParse(sanitized);
    } catch (error) {
        const start = sanitized.indexOf('{');
        const end = sanitized.lastIndexOf('}');
        if (start !== -1 && end > start && (start > 0 || end < sanitized.length - 1)) {
            const sliced = sanitized.slice(start, end + 1);
            return tryParse(sliced);
        }
        if (!sanitized.startsWith('{')) {
            throw new Error(`Sync file is not JSON (starts with "${sanitized.slice(0, 20)}")`);
        }
        throw error;
    }
}

async function readFileText(fileUri: string): Promise<string | null> {
    if (fileUri.startsWith('content://')) {
        if (!StorageAccessFramework?.readAsStringAsync) {
            throw new Error('This Android build does not support Storage Access Framework (SAF).');
        }
        // Do not fall back to FileSystem.* for content:// URIs — it will throw Invalid URI.
        return await StorageAccessFramework.readAsStringAsync(fileUri);
    }

    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    if (!fileInfo.exists) {
        console.log('[Sync] File does not exist:', fileUri);
        return null;
    }
    return await FileSystem.readAsStringAsync(fileUri);
}

// Pick a sync file and return both the parsed data and the file URI
export const pickAndParseSyncFile = async (): Promise<PickResult | null> => {
    try {
        const result = await DocumentPicker.getDocumentAsync({
            type: 'application/json',
            copyToCacheDirectory: false, // Keep original path for persistent access
        });

        if (result.canceled) {
            return null;
        }

        const fileUri = result.assets[0].uri;
        const fileContent = await readFileText(fileUri);
        if (!fileContent) throw new Error('Sync file does not exist');
        const data = parseAppData(fileContent);

        // Return data with file URI attached
        return {
            ...data,
            __fileUri: fileUri,
        };
    } catch (error) {
        console.error('Failed to import data:', error);
        throw error;
    }
};

// Read sync file from a stored path
export const readSyncFile = async (fileUri: string): Promise<AppData | null> => {
    try {
        // Syncthing (or other tools) can replace files while we're reading. Retry a few times.
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                const fileContent = await readFileText(fileUri);
                if (!fileContent) return null;
                return parseAppData(fileContent);
            } catch (error) {
                lastError = error;
                // Small backoff to allow file writes to finish.
                await sleep(120 + attempt * 80);
            }
        }
        throw lastError;
    } catch (error) {
        const message = String(error);
        // Provide a clearer UX-oriented error.
        if (fileUri.startsWith('content://') && /Invalid URI|IllegalArgumentException/i.test(message)) {
            throw new Error('Cannot access the selected sync file. Please re-select it in Settings → Data & Sync.');
        }
        if (/JSON/i.test(message) || /Unexpected token|trailing characters/i.test(message)) {
            throw new Error('Sync file is not valid JSON. It may be mid-write (e.g., Syncthing). Please try again in a few seconds.');
        }
        console.error('Failed to read sync file:', error);
        throw error;
    }
};

// Write merged data back to sync file
export const writeSyncFile = async (fileUri: string, data: AppData): Promise<void> => {
    try {
        const content = JSON.stringify(data, null, 2);
        // SAF URIs (content://) require special handling on Android
        if (fileUri.startsWith('content://') && StorageAccessFramework) {
            await StorageAccessFramework.writeAsStringAsync(fileUri, content);
            console.log('[Sync] Written via SAF to:', fileUri);
        } else {
            const tempUri = `${fileUri}.tmp`;
            await FileSystem.writeAsStringAsync(tempUri, content);
            const existing = await FileSystem.getInfoAsync(fileUri);
            if (existing.exists) {
                await FileSystem.deleteAsync(fileUri, { idempotent: true });
            }
            await FileSystem.moveAsync({ from: tempUri, to: fileUri });
            console.log('[Sync] Written to sync file:', fileUri);
        }
    } catch (error) {
        console.error('Failed to write sync file:', error);
        throw error;
    }
};

// Export data for backup - allows saving to local directory on Android
export const exportData = async (data: AppData): Promise<void> => {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `mindwtr-backup-${timestamp}.json`;
        const jsonContent = JSON.stringify(data, null, 2);

        // On Android, try SAF to let user pick save location
        if (Platform.OS === 'android' && StorageAccessFramework) {
            try {
                console.log('[Export] Attempting SAF...');
                // Request permission to a directory
                const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
                console.log('[Export] SAF permissions:', permissions);

                if (permissions.granted) {
                    // Create the file in the selected directory
                    const fileUri = await StorageAccessFramework.createFileAsync(
                        permissions.directoryUri,
                        filename,
                        'application/json'
                    );

                    await StorageAccessFramework.writeAsStringAsync(fileUri, jsonContent);
                    console.log('[Export] Saved via SAF to:', fileUri);
                    return;
                }
            } catch (safError) {
                console.log('[Export] SAF not available (Expo Go?), using share:', safError);
            }
        } else {
            console.log('[Export] SAF not available, Platform:', Platform.OS, 'SAF:', !!StorageAccessFramework);
        }

        // Fallback: Use cache + share sheet
        const fileUri = FileSystem.cacheDirectory + filename;
        console.log('[Export] Writing to cache:', fileUri);
        await FileSystem.writeAsStringAsync(fileUri, jsonContent);

        const sharingAvailable = await Sharing.isAvailableAsync();
        if (sharingAvailable) {
            await Sharing.shareAsync(fileUri, {
                UTI: 'public.json',
                mimeType: 'application/json',
                dialogTitle: 'Export Mindwtr Data',
            });
        } else {
            throw new Error('Sharing is not available on this device');
        }
    } catch (error) {
        console.error('Failed to export data:', error);
        throw error;
    }
};
