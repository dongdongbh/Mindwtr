import { AppData } from '@focus-gtd/core';

export interface ElectronAPI {
    getData: () => Promise<AppData>
    saveData: (data: AppData) => Promise<{ success: boolean }>;
    getDataPath: () => Promise<string>;
    selectDirectory: () => Promise<string | null>;
    getSyncPath: () => Promise<string>;
    setSyncPath: (path: string) => Promise<{ success: boolean; path: string }>;
    syncData: () => Promise<{ success: boolean; data: AppData }>;
}

declare global {
    interface Window {
        electronAPI: ElectronAPI
    }
}
