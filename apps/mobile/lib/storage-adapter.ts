import { StorageAdapter, AppData } from '@mindwtr/core';
import { Platform } from 'react-native';

import { WIDGET_DATA_KEY } from './widget-data';
import { updateAndroidWidgetFromData } from './widget-service';

const DATA_KEY = WIDGET_DATA_KEY;
const LEGACY_DATA_KEYS = ['focus-gtd-data', 'gtd-todo-data', 'gtd-data'];

// Platform-specific storage implementation
const createStorage = (): StorageAdapter => {
    // Web platform - use localStorage
    if (Platform.OS === 'web') {
        return {
            getData: async (): Promise<AppData> => {
                if (typeof window === 'undefined') {
                    return { tasks: [], projects: [], areas: [], settings: {} };
                }
                let jsonValue = localStorage.getItem(DATA_KEY);
                if (jsonValue == null) {
                    for (const legacyKey of LEGACY_DATA_KEYS) {
                        const legacyValue = localStorage.getItem(legacyKey);
                        if (legacyValue != null) {
                            localStorage.setItem(DATA_KEY, legacyValue);
                            jsonValue = legacyValue;
                            break;
                        }
                    }
                }
                if (jsonValue == null) {
                    return { tasks: [], projects: [], areas: [], settings: {} };
                }
                try {
                    const data = JSON.parse(jsonValue) as AppData;
                    data.areas = Array.isArray(data.areas) ? data.areas : [];
                    return data;
                } catch (e) {
                    // JSON parse error - data corrupted, throw so user is notified
                    console.error('Failed to parse stored data - may be corrupted', e);
                    throw new Error('Data appears corrupted. Please restore from backup.');
                }
            },
            saveData: async (data: AppData): Promise<void> => {
                try {
                    if (typeof window !== 'undefined') {
                        const jsonValue = JSON.stringify(data);
                        localStorage.setItem(DATA_KEY, jsonValue);
                    }
                } catch (e) {
                    console.error('Failed to save data', e);
                    throw new Error('Failed to save data: ' + (e as Error).message);
                }
            },
        };
    }

    // Native platforms - use AsyncStorage
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;

    return {
        getData: async (): Promise<AppData> => {
            let jsonValue = await AsyncStorage.getItem(DATA_KEY);
            if (jsonValue == null) {
                for (const legacyKey of LEGACY_DATA_KEYS) {
                    const legacyValue = await AsyncStorage.getItem(legacyKey);
                    if (legacyValue != null) {
                        await AsyncStorage.setItem(DATA_KEY, legacyValue);
                        jsonValue = legacyValue;
                        break;
                    }
                }
            }
            if (jsonValue == null) {
                return { tasks: [], projects: [], areas: [], settings: {} };
            }
            try {
                const data = JSON.parse(jsonValue) as AppData;
                data.areas = Array.isArray(data.areas) ? data.areas : [];
                updateAndroidWidgetFromData(data).catch((error) => {
                    console.warn('[Widgets] Failed to update Android widget from storage load', error);
                });
                return data;
            } catch (e) {
                // JSON parse error - data corrupted, throw so user is notified
                console.error('Failed to parse stored data - may be corrupted', e);
                throw new Error('Data appears corrupted. Please restore from backup.');
            }
        },
        saveData: async (data: AppData): Promise<void> => {
            try {
                const jsonValue = JSON.stringify(data);
                await AsyncStorage.setItem(DATA_KEY, jsonValue);
                await updateAndroidWidgetFromData(data);
            } catch (e) {
                console.error('Failed to save data', e);
                throw new Error('Failed to save data: ' + (e as Error).message);
            }
        },
    };
};

export const mobileStorage = createStorage();
