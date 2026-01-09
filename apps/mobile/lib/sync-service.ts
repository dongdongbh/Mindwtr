import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppData, MergeStats, useTaskStore, webdavGetJson, webdavPutJson, cloudGetJson, cloudPutJson, flushPendingSave, performSyncCycle } from '@mindwtr/core';
import { mobileStorage } from './storage-adapter';
import { logSyncError, sanitizeLogMessage } from './app-log';
import { readSyncFile, writeSyncFile } from './storage-file';

export const SYNC_PATH_KEY = '@mindwtr_sync_path';
export const SYNC_BACKEND_KEY = '@mindwtr_sync_backend';
export const WEBDAV_URL_KEY = '@mindwtr_webdav_url';
export const WEBDAV_USERNAME_KEY = '@mindwtr_webdav_username';
export const WEBDAV_PASSWORD_KEY = '@mindwtr_webdav_password';
export const CLOUD_URL_KEY = '@mindwtr_cloud_url';
export const CLOUD_TOKEN_KEY = '@mindwtr_cloud_token';

const DEFAULT_SYNC_TIMEOUT_MS = 30_000;

let syncInFlight: Promise<{ success: boolean; stats?: MergeStats; error?: string }> | null = null;

export async function performMobileSync(syncPathOverride?: string): Promise<{ success: boolean; stats?: MergeStats; error?: string }> {
  if (syncInFlight) {
    return syncInFlight;
  }
  syncInFlight = (async () => {
    const rawBackend = await AsyncStorage.getItem(SYNC_BACKEND_KEY);
    const backend = rawBackend === 'webdav' || rawBackend === 'cloud' ? rawBackend : 'file';

    let step = 'init';
    let syncUrl: string | undefined;
    let wroteLocal = false;
    try {
      let webdavConfig: { url: string; username: string; password: string } | null = null;
      let cloudConfig: { url: string; token: string } | null = null;
      let fileSyncPath: string | null = null;
      step = 'flush';
      await flushPendingSave();
      const syncResult = await performSyncCycle({
        readLocal: async () => await mobileStorage.getData(),
        readRemote: async () => {
          if (backend === 'webdav') {
            const url = await AsyncStorage.getItem(WEBDAV_URL_KEY);
            if (!url) throw new Error('WebDAV URL not configured');
            syncUrl = url;
            const username = (await AsyncStorage.getItem(WEBDAV_USERNAME_KEY)) || '';
            const password = (await AsyncStorage.getItem(WEBDAV_PASSWORD_KEY)) || '';
            webdavConfig = { url, username, password };
            return await webdavGetJson<AppData>(url, { username, password, timeoutMs: DEFAULT_SYNC_TIMEOUT_MS });
          }
          if (backend === 'cloud') {
            const url = await AsyncStorage.getItem(CLOUD_URL_KEY);
            if (!url) throw new Error('Self-hosted URL not configured');
            syncUrl = url;
            const token = (await AsyncStorage.getItem(CLOUD_TOKEN_KEY)) || '';
            cloudConfig = { url, token };
            return await cloudGetJson<AppData>(url, { token, timeoutMs: DEFAULT_SYNC_TIMEOUT_MS });
          }
          fileSyncPath = syncPathOverride || await AsyncStorage.getItem(SYNC_PATH_KEY);
          if (!fileSyncPath) {
            throw new Error('No sync file configured');
          }
          return await readSyncFile(fileSyncPath);
        },
        writeLocal: async (data) => {
          await mobileStorage.saveData(data);
          wroteLocal = true;
        },
        writeRemote: async (data) => {
          if (backend === 'webdav') {
            if (!webdavConfig?.url) throw new Error('WebDAV URL not configured');
            await webdavPutJson(webdavConfig.url, data, { username: webdavConfig.username, password: webdavConfig.password, timeoutMs: DEFAULT_SYNC_TIMEOUT_MS });
            return;
          }
          if (backend === 'cloud') {
            if (!cloudConfig?.url) throw new Error('Self-hosted URL not configured');
            await cloudPutJson(cloudConfig.url, data, { token: cloudConfig.token, timeoutMs: DEFAULT_SYNC_TIMEOUT_MS });
            return;
          }
          if (!fileSyncPath) throw new Error('No sync file configured');
          await writeSyncFile(fileSyncPath, data);
        },
        onStep: (next) => {
          step = next;
        },
      });

      step = 'refresh';
      await useTaskStore.getState().fetchData();
      return { success: true, stats: syncResult.stats };
    } catch (error) {
      const now = new Date().toISOString();
      const logPath = await logSyncError(error, { backend, step, url: syncUrl });
      const logHint = logPath ? ` (log: ${logPath})` : '';
      const safeMessage = sanitizeLogMessage(String(error));
      try {
        if (wroteLocal) {
          await useTaskStore.getState().fetchData();
        }
        await useTaskStore.getState().updateSettings({
          lastSyncAt: now,
          lastSyncStatus: 'error',
          lastSyncError: `${safeMessage}${logHint}`,
        });
      } catch (e) {
        console.error('[Mobile] Failed to persist sync error', e);
      }

      return { success: false, error: `${safeMessage}${logHint}` };
    }
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}
