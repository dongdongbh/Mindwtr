
import { invoke } from '@tauri-apps/api/core';
import { mergeAppDataWithStats, AppData, useTaskStore, MergeStats } from '@mindwtr/core';

export class SyncService {
    /**
     * Get the currently configured sync path from the backend
     */
    static async getSyncPath(): Promise<string> {
        try {
            return await invoke<string>('get_sync_path');
        } catch (error) {
            console.error('Failed to get sync path:', error);
            return '';
        }
    }

    /**
     * Set the sync path in the backend
     */
    static async setSyncPath(path: string): Promise<{ success: boolean; path: string }> {
        try {
            return await invoke<{ success: boolean; path: string }>('set_sync_path', { syncPath: path });
        } catch (error) {
            console.error('Failed to set sync path:', error);
            return { success: false, path: '' };
        }
    }

    /**
     * Perform a full sync cycle:
     * 1. Read Local & Remote Data
     * 2. Merge (Last-Write-Wins)
     * 3. Write merged data back to both Local & Remote
     * 4. Refresh Core Store
     */
    static async performSync(): Promise<{ success: boolean; stats?: MergeStats; error?: string }> {
        try {
            // 1. Read Local Data
            const localData = await invoke<AppData>('get_data');

            // 2. Read Sync Data
            const syncData = await invoke<AppData>('read_sync_file');

            // 3. Merge Strategies
            // mergeAppData uses Last-Write-Wins (LWW) based on updatedAt
            // Note: For web builds, `invoke` calls are shims that return mock data.
            // This means `localData` and `syncData` might be identical if the mock
            // data is static, leading to no actual merge changes.
            const mergeResult = mergeAppDataWithStats(localData, syncData);
            const mergedData = mergeResult.data;
            const stats = mergeResult.stats;

            const now = new Date().toISOString();
            const finalData: AppData = {
                ...mergedData,
                settings: {
                    ...mergedData.settings,
                    lastSyncAt: now,
                    lastSyncStatus: 'success',
                    lastSyncError: undefined,
                    lastSyncStats: stats,
                },
            };

            // 4. Write back to Local
            await invoke('save_data', { data: finalData });

            // 5. Write back to Sync
            await invoke('write_sync_file', { data: finalData });

            // 6. Refresh UI Store
            await useTaskStore.getState().fetchData();

            return { success: true, stats };
        } catch (error) {
            console.error('Sync failed', error);
            const now = new Date().toISOString();
            try {
                await useTaskStore.getState().fetchData();
                await useTaskStore.getState().updateSettings({
                    lastSyncAt: now,
                    lastSyncStatus: 'error',
                    lastSyncError: String(error),
                });
            } catch (e) {
                console.error('Failed to persist sync error', e);
            }
            return { success: false, error: String(error) };
        }
    }
}
