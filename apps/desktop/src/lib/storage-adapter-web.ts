import { AppData, StorageAdapter } from '@mindwtr/core';

const DATA_KEY = 'mindwtr-data';

export const webStorage: StorageAdapter = {
    getData: async (): Promise<AppData> => {
        if (typeof window === 'undefined') return { tasks: [], projects: [], areas: [], settings: {} };
        const jsonValue = localStorage.getItem(DATA_KEY);
        if (jsonValue == null) return { tasks: [], projects: [], areas: [], settings: {} };

        try {
            const data = JSON.parse(jsonValue);
            if (!Array.isArray(data.tasks) || !Array.isArray(data.projects)) {
                throw new Error('Invalid data format');
            }
            data.areas = Array.isArray(data.areas) ? data.areas : [];
            return data;
        } catch (error) {
            console.error('[WebStorage] Failed to load data:', error);
            throw new Error('Data appears corrupted. Please restore from backup.');
        }
    },
    saveData: async (data: AppData): Promise<void> => {
        if (typeof window === 'undefined') return;
        try {
            localStorage.setItem(DATA_KEY, JSON.stringify(data));
        } catch (error) {
            console.error('[WebStorage] Failed to save data:', error);
            throw new Error('Failed to save data.');
        }
    },
};
