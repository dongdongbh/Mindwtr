import AsyncStorage from '@react-native-async-storage/async-storage';
import { mergeAppDataWithStats, AppData, MergeStats, useTaskStore } from '@mindwtr/core';
import { mobileStorage } from './storage-adapter';
import { readSyncFile, writeSyncFile } from './storage-file';

export const SYNC_PATH_KEY = '@mindwtr_sync_path';

export async function performMobileSync(syncPathOverride?: string): Promise<{ success: boolean; stats?: MergeStats; error?: string }> {
  const syncPath = syncPathOverride || await AsyncStorage.getItem(SYNC_PATH_KEY);
  if (!syncPath) {
    return { success: false, error: 'No sync file configured' };
  }

  let wroteLocal = false;
  try {
    const incomingData = await readSyncFile(syncPath);
    if (!incomingData) {
      return { success: false, error: 'Sync file not found' };
    }

    const currentData = await mobileStorage.getData();
    const mergeResult = mergeAppDataWithStats(currentData, incomingData);
    const now = new Date().toISOString();

    const finalData: AppData = {
      ...mergeResult.data,
      settings: {
        ...mergeResult.data.settings,
        lastSyncAt: now,
        lastSyncStatus: 'success',
        lastSyncError: undefined,
        lastSyncStats: mergeResult.stats,
      },
    };

    await mobileStorage.saveData(finalData);
    wroteLocal = true;
    await writeSyncFile(syncPath, finalData);

    await useTaskStore.getState().fetchData();
    return { success: true, stats: mergeResult.stats };
  } catch (error) {
    const now = new Date().toISOString();
    try {
      if (wroteLocal) {
        await useTaskStore.getState().fetchData();
      }
      await useTaskStore.getState().updateSettings({
        lastSyncAt: now,
        lastSyncStatus: 'error',
        lastSyncError: String(error),
      });
    } catch (e) {
      console.error('[Mobile] Failed to persist sync error', e);
    }

    return { success: false, error: String(error) };
  }
}

