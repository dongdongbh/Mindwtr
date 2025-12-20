import AsyncStorage from '@react-native-async-storage/async-storage';
import { mergeAppDataWithStats, AppData, MergeStats, useTaskStore, cloudGetJson, cloudPutJson, webdavGetJson, webdavPutJson } from '@mindwtr/core';
import { mobileStorage } from './storage-adapter';
import { readSyncFile, writeSyncFile } from './storage-file';

export const SYNC_PATH_KEY = '@mindwtr_sync_path';
export const SYNC_BACKEND_KEY = '@mindwtr_sync_backend';
export const WEBDAV_URL_KEY = '@mindwtr_webdav_url';
export const WEBDAV_USERNAME_KEY = '@mindwtr_webdav_username';
export const WEBDAV_PASSWORD_KEY = '@mindwtr_webdav_password';
export const CLOUD_URL_KEY = '@mindwtr_cloud_url';
export const CLOUD_TOKEN_KEY = '@mindwtr_cloud_token';

let syncInFlight: Promise<{ success: boolean; stats?: MergeStats; error?: string }> | null = null;

export async function performMobileSync(syncPathOverride?: string): Promise<{ success: boolean; stats?: MergeStats; error?: string }> {
  if (syncInFlight) {
    return syncInFlight;
  }
  syncInFlight = (async () => {
    const rawBackend = await AsyncStorage.getItem(SYNC_BACKEND_KEY);
    const backend = rawBackend === 'webdav' ? 'webdav' : rawBackend === 'cloud' ? 'cloud' : 'file';

    let wroteLocal = false;
    try {
      let webdavConfig: { url: string; username: string; password: string } | null = null;
      let cloudConfig: { url: string; token: string } | null = null;
      let fileSyncPath: string | null = null;
      let incomingData: AppData | null;
      if (backend === 'webdav') {
        const url = await AsyncStorage.getItem(WEBDAV_URL_KEY);
        if (!url) return { success: false, error: 'WebDAV URL not configured' };
        const username = (await AsyncStorage.getItem(WEBDAV_USERNAME_KEY)) || '';
        const password = (await AsyncStorage.getItem(WEBDAV_PASSWORD_KEY)) || '';
        webdavConfig = { url, username, password };
        incomingData = await webdavGetJson<AppData>(url, { username, password });
      } else if (backend === 'cloud') {
        const url = await AsyncStorage.getItem(CLOUD_URL_KEY);
        const token = await AsyncStorage.getItem(CLOUD_TOKEN_KEY);
        if (!url || !token) return { success: false, error: 'Cloud sync not configured' };
        cloudConfig = { url, token };
        incomingData = await cloudGetJson<AppData>(url, { token });
      } else {
        fileSyncPath = syncPathOverride || await AsyncStorage.getItem(SYNC_PATH_KEY);
        if (!fileSyncPath) {
          return { success: false, error: 'No sync file configured' };
        }
        incomingData = await readSyncFile(fileSyncPath);
        if (!incomingData) {
          incomingData = { tasks: [], projects: [], settings: {} };
        }
      }

      const currentData = await mobileStorage.getData();
      const mergeResult = mergeAppDataWithStats(currentData, incomingData || { tasks: [], projects: [], settings: {} });
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
      if (backend === 'webdav') {
        if (!webdavConfig?.url) return { success: false, error: 'WebDAV URL not configured' };
        await webdavPutJson(webdavConfig.url, finalData, { username: webdavConfig.username, password: webdavConfig.password });
      } else if (backend === 'cloud') {
        if (!cloudConfig?.url || !cloudConfig.token) return { success: false, error: 'Cloud sync not configured' };
        await cloudPutJson(cloudConfig.url, finalData, { token: cloudConfig.token });
      } else {
        if (!fileSyncPath) return { success: false, error: 'No sync file configured' };
        await writeSyncFile(fileSyncPath, finalData);
      }

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
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}
