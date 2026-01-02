import { AppData } from './types';

export interface StorageAdapter {
    getData(): Promise<AppData>;
    saveData(data: AppData): Promise<void>;
}

// Default dummy adapter
export const noopStorage: StorageAdapter = {
    getData: async () => ({ tasks: [], projects: [], areas: [], settings: {} }),
    saveData: async () => { },
};
