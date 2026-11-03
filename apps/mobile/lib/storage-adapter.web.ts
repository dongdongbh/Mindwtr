import { StorageAdapter, AppData } from '@mindwtr/core';
import { logError } from './app-log';

const DATA_KEY = 'mindwtr-data';
const LEGACY_DATA_KEYS = ['focus-gtd-data', 'gtd-todo-data', 'gtd-data'];


export const mobileStorage: StorageAdapter = {
    getData: async (): Promise<AppData> => {
        if (typeof window === 'undefined') {
            return { tasks: [], projects: [], sections: [], areas: [], settings: {} };
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
            return { tasks: [], projects: [], sections: [], areas: [], settings: {} };
        }
        try {
            const data = JSON.parse(jsonValue);

            if (!Array.isArray(data.tasks) || !Array.isArray(data.projects)) {
                throw new Error('Invalid data format');
            }
            data.areas = Array.isArray(data.areas) ? data.areas : [];
            data.sections = Array.isArray(data.sections) ? data.sections : [];
            return data;
        } catch (e) {
            void logError(e, { scope: 'storage', extra: { message: 'Failed to load data' } });
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
            void logError(e, { scope: 'storage', extra: { message: 'Failed to save data' } });
            throw new Error('Failed to save data: ' + (e as Error).message);
        }
    },
};
