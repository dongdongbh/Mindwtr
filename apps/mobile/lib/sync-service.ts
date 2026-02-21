import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppData, Attachment, MergeStats, useTaskStore, webdavGetJson, webdavPutJson, cloudGetJson, cloudPutJson, flushPendingSave, performSyncCycle, findOrphanedAttachments, removeOrphanedAttachmentsFromData, webdavDeleteFile, cloudDeleteFile, CLOCK_SKEW_THRESHOLD_MS, appendSyncHistory, withRetry, normalizeWebdavUrl, normalizeCloudUrl, sanitizeAppDataForRemote, areSyncPayloadsEqual, assertNoPendingAttachmentUploads, injectExternalCalendars as injectExternalCalendarsForSync, persistExternalCalendars as persistExternalCalendarsForSync, mergeAppData, cloneAppData, LocalSyncAbort, getInMemoryAppDataSnapshot, shouldRunAttachmentCleanup } from '@mindwtr/core';
import { mobileStorage } from './storage-adapter';
import { logInfo, logSyncError, logWarn, sanitizeLogMessage } from './app-log';
import { readSyncFile, resolveSyncFileUri, writeSyncFile } from './storage-file';
import { getBaseSyncUrl, getCloudBaseUrl, syncCloudAttachments, syncFileAttachments, syncWebdavAttachments, cleanupAttachmentTempFiles } from './attachment-sync';
import { getExternalCalendars, saveExternalCalendars } from './external-calendar';
import * as FileSystem from 'expo-file-system/legacy';
import * as Network from 'expo-network';
import { formatSyncErrorMessage, getFileSyncBaseDir, isSyncFilePath, resolveBackend, type SyncBackend } from './sync-service-utils';
import {
  SYNC_PATH_KEY,
  SYNC_BACKEND_KEY,
  WEBDAV_URL_KEY,
  WEBDAV_USERNAME_KEY,
  WEBDAV_PASSWORD_KEY,
  CLOUD_URL_KEY,
  CLOUD_TOKEN_KEY,
} from './sync-constants';

const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
const WEBDAV_RETRY_OPTIONS = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 30_000 };
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_CLEANUP_BATCH_LIMIT = 25;
const SYNC_CONFIG_CACHE_TTL_MS = 30_000;
const SYNC_FILE_NAME = 'data.json';
const syncConfigCache = new Map<string, { value: string | null; readAt: number }>();
const IOS_TEMP_INBOX_PATH_PATTERN = /\/tmp\/[^/]*-Inbox\//i;

const decodeUriSafe = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const logSyncWarning = (message: string, error?: unknown) => {
  const extra = error ? { error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)) } : undefined;
  void logWarn(message, { scope: 'sync', extra });
};

const logSyncInfo = (message: string, extra?: Record<string, string>) => {
  void logInfo(message, { scope: 'sync', extra });
};

const externalCalendarProvider = {
  load: () => getExternalCalendars(),
  save: (calendars: AppData['settings']['externalCalendars'] | undefined) =>
    saveExternalCalendars(calendars ?? []),
  onWarn: (message: string, error?: unknown) => logSyncWarning(message, error),
};

const injectExternalCalendars = async (data: AppData): Promise<AppData> =>
  injectExternalCalendarsForSync(data, externalCalendarProvider);

const persistExternalCalendars = async (data: AppData): Promise<void> =>
  persistExternalCalendarsForSync(data, externalCalendarProvider);

const getCachedConfigValue = async (key: string): Promise<string | null> => {
  const now = Date.now();
  const cached = syncConfigCache.get(key);
  if (cached && now - cached.readAt <= SYNC_CONFIG_CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await AsyncStorage.getItem(key);
  syncConfigCache.set(key, { value, readAt: now });
  return value;
};

const getAttachmentsArray = (attachments: Attachment[] | undefined): Attachment[] => (
  Array.isArray(attachments) ? attachments : []
);

const shouldSkipSyncForOfflineState = async (backend: SyncBackend): Promise<boolean> => {
  if (backend !== 'webdav' && backend !== 'cloud') return false;
  try {
    const state = await Network.getNetworkStateAsync();
    const isConnected = state.isConnected ?? false;
    const isInternetReachable = state.isInternetReachable ?? isConnected;
    const isAirplaneModeEnabled = (() => {
      const value = (state as { isAirplaneModeEnabled?: unknown }).isAirplaneModeEnabled;
      return typeof value === 'boolean' ? value : false;
    })();

    if (isAirplaneModeEnabled || !isInternetReachable) {
      logSyncInfo('Sync skipped: offline/airplane mode', {
        backend,
        isConnected: String(isConnected),
        isInternetReachable: String(isInternetReachable),
        isAirplaneModeEnabled: String(isAirplaneModeEnabled),
      });
      return true;
    }
  } catch (error) {
    logSyncWarning('Failed to read network state before sync', error);
  }
  return false;
};

const findDeletedAttachmentsForFileCleanupLocal = (appData: AppData): Attachment[] => {
  const deleted = new Map<string, Attachment>();

  for (const task of appData.tasks) {
    for (const attachment of getAttachmentsArray(task.attachments)) {
      if (!attachment.deletedAt) continue;
      deleted.set(attachment.id, attachment);
    }
  }

  for (const project of appData.projects) {
    for (const attachment of getAttachmentsArray(project.attachments)) {
      if (!attachment.deletedAt) continue;
      deleted.set(attachment.id, attachment);
    }
  }

  return Array.from(deleted.values());
};

const deleteAttachmentFile = async (uri?: string): Promise<void> => {
  if (!uri) return;
  if (uri.startsWith('content://') || /^https?:\/\//i.test(uri)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (error) {
    logSyncWarning('Failed to delete attachment file', error);
  }
};

let syncInFlight: Promise<{ success: boolean; stats?: MergeStats; error?: string }> | null = null;
let syncQueued = false;

export async function performMobileSync(syncPathOverride?: string): Promise<{ success: boolean; stats?: MergeStats; error?: string }> {
  if (syncInFlight) {
    syncQueued = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    const rawBackend = await getCachedConfigValue(SYNC_BACKEND_KEY);
    const backend: SyncBackend = resolveBackend(rawBackend);

    if (backend === 'off') {
      return { success: true };
    }
    if (await shouldSkipSyncForOfflineState(backend)) {
      return { success: true };
    }

    logSyncInfo('Sync start', { backend });

    let step = 'init';
    let syncUrl: string | undefined;
    let wroteLocal = false;
    let localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
    let networkWentOffline = false;
    let networkSubscription: { remove?: () => void } | null = null;
    const requestAbortController = new AbortController();
    const fetchWithAbort: typeof fetch = (input, init) => {
      const baseSignal = requestAbortController.signal;
      const existingSignal = (init?.signal ?? undefined) as AbortSignal | undefined;
      if (!existingSignal) {
        return fetch(input, { ...(init || {}), signal: baseSignal });
      }
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
        return fetch(input, { ...(init || {}), signal: AbortSignal.any([baseSignal, existingSignal]) });
      }

      const mergedController = new AbortController();
      const abortMerged = () => mergedController.abort();
      if (baseSignal.aborted || existingSignal.aborted) {
        mergedController.abort();
      } else {
        baseSignal.addEventListener('abort', abortMerged, { once: true });
        existingSignal.addEventListener('abort', abortMerged, { once: true });
      }
      return fetch(input, { ...(init || {}), signal: mergedController.signal }).finally(() => {
        baseSignal.removeEventListener('abort', abortMerged);
        existingSignal.removeEventListener('abort', abortMerged);
      });
    };
    const ensureLocalSnapshotFresh = () => {
      if (useTaskStore.getState().lastDataChangeAt > localSnapshotChangeAt) {
        syncQueued = true;
        throw new LocalSyncAbort();
      }
    };
    const ensureNetworkStillAvailable = async () => {
      if (backend !== 'webdav' && backend !== 'cloud') return;
      if (networkWentOffline) {
        requestAbortController.abort();
        throw new Error('Sync paused: offline state detected');
      }
      if (await shouldSkipSyncForOfflineState(backend)) {
        networkWentOffline = true;
        requestAbortController.abort();
        throw new Error('Sync paused: offline state detected');
      }
    };
    try {
      if (backend === 'webdav' || backend === 'cloud') {
        try {
          networkSubscription = Network.addNetworkStateListener((state) => {
            const isConnected = state.isConnected ?? false;
            const isInternetReachable = state.isInternetReachable ?? isConnected;
            const isAirplaneModeEnabled = (() => {
              const value = (state as { isAirplaneModeEnabled?: unknown }).isAirplaneModeEnabled;
              return typeof value === 'boolean' ? value : false;
            })();
            if (isAirplaneModeEnabled || !isInternetReachable) {
              networkWentOffline = true;
              requestAbortController.abort();
            }
          });
        } catch (error) {
          logSyncWarning('Failed to subscribe to network state during sync', error);
        }
      }
      let webdavConfig: { url: string; username: string; password: string } | null = null;
      let cloudConfig: { url: string; token: string } | null = null;
      let fileSyncPath: string | null = null;
      let preSyncedLocalData: AppData | null = null;
      let remoteDataForCompare: AppData | null = null;
      step = 'flush';
      await flushPendingSave();
      localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
      if (backend === 'file') {
        fileSyncPath = syncPathOverride || await getCachedConfigValue(SYNC_PATH_KEY);
        if (!fileSyncPath) {
          return { success: true };
        }
        if (fileSyncPath.startsWith('file://') && IOS_TEMP_INBOX_PATH_PATTERN.test(decodeUriSafe(fileSyncPath))) {
          throw new Error('Selected iOS sync file is in a temporary Inbox location and is read-only. Re-select a folder in Settings -> Data & Sync.');
        }
        if (fileSyncPath.startsWith('content://')) {
          try {
            const resolvedPath = await resolveSyncFileUri(fileSyncPath, { createIfMissing: true });
            if (resolvedPath && resolvedPath !== fileSyncPath) {
              await AsyncStorage.setItem(SYNC_PATH_KEY, resolvedPath);
              syncConfigCache.set(SYNC_PATH_KEY, { value: resolvedPath, readAt: Date.now() });
              logSyncInfo('Normalized SAF sync path');
              fileSyncPath = resolvedPath;
            }
          } catch (error) {
            logSyncWarning('Failed to normalize SAF sync path', error);
          }
        } else if (!isSyncFilePath(fileSyncPath)) {
          const trimmed = fileSyncPath.replace(/\/+$/, '');
          fileSyncPath = `${trimmed}/${SYNC_FILE_NAME}`;
        }
      }
      if (backend === 'webdav') {
        const url = await getCachedConfigValue(WEBDAV_URL_KEY);
        if (!url) throw new Error('WebDAV URL not configured');
        syncUrl = normalizeWebdavUrl(url);
        const username = (await getCachedConfigValue(WEBDAV_USERNAME_KEY)) || '';
        const password = (await getCachedConfigValue(WEBDAV_PASSWORD_KEY)) || '';
        webdavConfig = { url: syncUrl, username, password };
      }
      if (backend === 'cloud') {
        const url = await getCachedConfigValue(CLOUD_URL_KEY);
        if (!url) throw new Error('Self-hosted URL not configured');
        syncUrl = normalizeCloudUrl(url);
        const token = (await getCachedConfigValue(CLOUD_TOKEN_KEY)) || '';
        cloudConfig = { url: syncUrl, token };
      }

      // Pre-sync local attachments so cloudKeys exist before writing remote data.
      step = 'attachments_prepare';
      logSyncInfo('Sync step', { step });
      try {
        const persistedData = await mobileStorage.getData();
        const localData = mergeAppData(persistedData, getInMemoryAppDataSnapshot());
        let preMutated = false;
        if (backend === 'webdav' && webdavConfig?.url) {
          const baseSyncUrl = getBaseSyncUrl(webdavConfig.url);
          preMutated = await syncWebdavAttachments(localData, webdavConfig, baseSyncUrl);
        } else if (backend === 'cloud' && cloudConfig?.url) {
          const baseSyncUrl = getCloudBaseUrl(cloudConfig.url);
          preMutated = await syncCloudAttachments(localData, cloudConfig, baseSyncUrl);
        } else if (backend === 'file' && fileSyncPath) {
          preMutated = await syncFileAttachments(localData, fileSyncPath);
        }
        if (preMutated) {
          ensureLocalSnapshotFresh();
          // Keep pre-sync attachment mutations in memory until the main merge/write succeeds.
          preSyncedLocalData = localData;
        }
      } catch (error) {
        if (error instanceof LocalSyncAbort) {
          throw error;
        }
        logSyncWarning('Attachment pre-sync warning', error);
      }
      const syncResult = await performSyncCycle({
        readLocal: async () => {
          const inMemorySnapshot = getInMemoryAppDataSnapshot();
          const baseData = preSyncedLocalData
            ? mergeAppData(preSyncedLocalData, inMemorySnapshot)
            : mergeAppData(await mobileStorage.getData(), inMemorySnapshot);
          const data = await injectExternalCalendars(baseData);
          localSnapshotChangeAt = useTaskStore.getState().lastDataChangeAt;
          return data;
        },
        readRemote: async () => {
          await ensureNetworkStillAvailable();
          if (backend === 'webdav' && webdavConfig?.url) {
            const data = await withRetry(
              () =>
                webdavGetJson<AppData>(webdavConfig.url, {
                  username: webdavConfig.username,
                  password: webdavConfig.password,
                  timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                  fetcher: fetchWithAbort,
                }),
              WEBDAV_RETRY_OPTIONS
            );
            remoteDataForCompare = data ?? null;
            return data;
          }
          if (backend === 'cloud' && cloudConfig?.url) {
            const data = await cloudGetJson<AppData>(cloudConfig.url, {
              token: cloudConfig.token,
              timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
              fetcher: fetchWithAbort,
            });
            remoteDataForCompare = data ?? null;
            return data;
          }
          if (!fileSyncPath) {
            throw new Error('No sync folder configured');
          }
          const data = await readSyncFile(fileSyncPath);
          remoteDataForCompare = data ?? null;
          return data;
        },
        writeLocal: async (data) => {
          ensureLocalSnapshotFresh();
          await mobileStorage.saveData(data);
          wroteLocal = true;
        },
        writeRemote: async (data) => {
          ensureLocalSnapshotFresh();
          await ensureNetworkStillAvailable();
          assertNoPendingAttachmentUploads(data);
          const sanitized = sanitizeAppDataForRemote(data);
          const remoteSanitized = remoteDataForCompare
            ? sanitizeAppDataForRemote(remoteDataForCompare)
            : null;
          if (remoteSanitized && areSyncPayloadsEqual(remoteSanitized, sanitized)) {
            return;
          }
          if (backend === 'webdav') {
            if (!webdavConfig?.url) throw new Error('WebDAV URL not configured');
            await withRetry(
              () =>
                webdavPutJson(webdavConfig.url, sanitized, {
                  username: webdavConfig.username,
                  password: webdavConfig.password,
                  timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                  fetcher: fetchWithAbort,
                }),
              WEBDAV_RETRY_OPTIONS
            );
            remoteDataForCompare = sanitized;
            return;
          }
          if (backend === 'cloud') {
            if (!cloudConfig?.url) throw new Error('Self-hosted URL not configured');
            await cloudPutJson(cloudConfig.url, sanitized, {
              token: cloudConfig.token,
              timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
              fetcher: fetchWithAbort,
            });
            remoteDataForCompare = sanitized;
            return;
          }
          if (!fileSyncPath) throw new Error('No sync folder configured');
          await writeSyncFile(fileSyncPath, sanitized);
          remoteDataForCompare = sanitized;
        },
        onStep: (next) => {
          step = next;
          logSyncInfo('Sync step', { step });
        },
      });

      const stats = syncResult.stats;
      const conflictCount = (stats.tasks.conflicts || 0)
        + (stats.projects.conflicts || 0)
        + (stats.sections.conflicts || 0)
        + (stats.areas.conflicts || 0);
      const maxClockSkewMs = Math.max(
        stats.tasks.maxClockSkewMs || 0,
        stats.projects.maxClockSkewMs || 0,
        stats.sections.maxClockSkewMs || 0,
        stats.areas.maxClockSkewMs || 0,
      );
      const timestampAdjustments = (stats.tasks.timestampAdjustments || 0)
        + (stats.projects.timestampAdjustments || 0)
        + (stats.sections.timestampAdjustments || 0)
        + (stats.areas.timestampAdjustments || 0);
      if (conflictCount > 0 || maxClockSkewMs > CLOCK_SKEW_THRESHOLD_MS || timestampAdjustments > 0) {
        const conflictSamples = [
          ...(stats.tasks.conflictIds || []),
          ...(stats.projects.conflictIds || []),
          ...(stats.sections.conflictIds || []),
          ...(stats.areas.conflictIds || []),
        ].slice(0, 6);
        void logInfo(
          `Sync merge summary: ${conflictCount} conflicts, max skew ${Math.round(maxClockSkewMs)}ms, ${timestampAdjustments} timestamp fixes.`,
          {
            scope: 'sync',
            extra: {
              conflicts: String(conflictCount),
              maxClockSkewMs: String(Math.round(maxClockSkewMs)),
              timestampFixes: String(timestampAdjustments),
              conflictSamples: conflictSamples.join(','),
            },
          }
        );
      }
      let mergedData = syncResult.data;
      ensureLocalSnapshotFresh();
      await persistExternalCalendars(mergedData);

      const webdavConfigValue = webdavConfig as { url: string; username: string; password: string } | null;
      const cloudConfigValue = cloudConfig as { url: string; token: string } | null;
      const applyAttachmentSyncMutation = async (
        syncAttachments: (candidateData: AppData) => Promise<boolean>
      ): Promise<void> => {
        const candidateData = cloneAppData(mergedData);
        const mutated = await syncAttachments(candidateData);
        if (!mutated) return;
        ensureLocalSnapshotFresh();
        mergedData = candidateData;
        await mobileStorage.saveData(mergedData);
        wroteLocal = true;
      };

      if (backend === 'webdav' && webdavConfigValue?.url) {
        step = 'attachments';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        await ensureNetworkStillAvailable();
        const baseSyncUrl = getBaseSyncUrl(webdavConfigValue.url);
        await applyAttachmentSyncMutation((candidateData) =>
          syncWebdavAttachments(candidateData, webdavConfigValue, baseSyncUrl)
        );
      }

      if (backend === 'cloud' && cloudConfigValue?.url) {
        step = 'attachments';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        await ensureNetworkStillAvailable();
        const baseSyncUrl = getCloudBaseUrl(cloudConfigValue.url);
        await applyAttachmentSyncMutation((candidateData) =>
          syncCloudAttachments(candidateData, cloudConfigValue, baseSyncUrl)
        );
      }

      if (backend === 'file' && fileSyncPath) {
        step = 'attachments';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        await applyAttachmentSyncMutation((candidateData) =>
          syncFileAttachments(candidateData, fileSyncPath)
        );
      }

      await cleanupAttachmentTempFiles();

      if (shouldRunAttachmentCleanup(mergedData.settings.attachments?.lastCleanupAt, CLEANUP_INTERVAL_MS)) {
        step = 'attachments_cleanup';
        logSyncInfo('Sync step', { step });
        ensureLocalSnapshotFresh();
        await ensureNetworkStillAvailable();
        const orphaned = findOrphanedAttachments(mergedData);
        const deletedAttachments = findDeletedAttachmentsForFileCleanupLocal(mergedData);
        const cleanupTargets = new Map<string, Attachment>();
        for (const attachment of orphaned) cleanupTargets.set(attachment.id, attachment);
        for (const attachment of deletedAttachments) cleanupTargets.set(attachment.id, attachment);
        if (cleanupTargets.size > 0) {
          const isFileBackend = backend === 'file';
          const isWebdavBackend = backend === 'webdav' && webdavConfigValue?.url;
          const isCloudBackend = backend === 'cloud' && cloudConfigValue?.url;
          const fileBaseDir = isFileBackend && fileSyncPath && !fileSyncPath.startsWith('content://')
            ? getFileSyncBaseDir(fileSyncPath)
            : null;
          let processedCount = 0;
          const reachedBatchLimit = cleanupTargets.size > ATTACHMENT_CLEANUP_BATCH_LIMIT;

          for (const attachment of cleanupTargets.values()) {
            if (processedCount >= ATTACHMENT_CLEANUP_BATCH_LIMIT) {
              break;
            }
            processedCount += 1;
            ensureLocalSnapshotFresh();
            await deleteAttachmentFile(attachment.uri);
            if (attachment.cloudKey) {
              try {
                if (isWebdavBackend && webdavConfigValue) {
                  const baseSyncUrl = getBaseSyncUrl(webdavConfigValue.url);
                  await webdavDeleteFile(`${baseSyncUrl}/${attachment.cloudKey}`, {
                    username: webdavConfigValue.username,
                    password: webdavConfigValue.password,
                    timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                    fetcher: fetchWithAbort,
                  });
                } else if (isCloudBackend && cloudConfigValue) {
                  const baseSyncUrl = getCloudBaseUrl(cloudConfigValue.url);
                  await cloudDeleteFile(`${baseSyncUrl}/${attachment.cloudKey}`, {
                    token: cloudConfigValue.token,
                    timeoutMs: DEFAULT_SYNC_TIMEOUT_MS,
                    fetcher: fetchWithAbort,
                  });
                } else if (fileBaseDir) {
                  const targetPath = `${fileBaseDir}/${attachment.cloudKey}`;
                  await FileSystem.deleteAsync(targetPath, { idempotent: true });
                }
              } catch (error) {
                logSyncWarning('Failed to delete remote attachment', error);
              }
            }
          }
          if (reachedBatchLimit) {
            logSyncInfo('Attachment cleanup batch limit reached', {
              limit: String(ATTACHMENT_CLEANUP_BATCH_LIMIT),
              total: String(cleanupTargets.size),
            });
          }
          if (orphaned.length > 0 && !reachedBatchLimit) {
            mergedData = removeOrphanedAttachmentsFromData(mergedData);
          }
        }
        mergedData.settings.attachments = {
          ...mergedData.settings.attachments,
          lastCleanupAt: new Date().toISOString(),
        };
        ensureLocalSnapshotFresh();
        await mobileStorage.saveData(mergedData);
        wroteLocal = true;
      }

      step = 'refresh';
      ensureLocalSnapshotFresh();
      await useTaskStore.getState().fetchData();
      const now = new Date().toISOString();
      try {
        await useTaskStore.getState().updateSettings({
          lastSyncAt: now,
          lastSyncStatus: syncResult.status,
          lastSyncError: undefined,
        });
      } catch (error) {
        logSyncWarning('[Mobile] Failed to persist sync status', error);
      }
      return { success: true, stats: syncResult.stats };
    } catch (error) {
      if (error instanceof LocalSyncAbort) {
        return { success: true };
      }
      const now = new Date().toISOString();
      const logPath = await logSyncError(error, { backend, step, url: syncUrl });
      const logHint = logPath ? ` (log: ${logPath})` : '';
      const safeMessage = formatSyncErrorMessage(error, backend);
      const nextHistory = appendSyncHistory(useTaskStore.getState().settings, {
        at: now,
        status: 'error',
        conflicts: 0,
        conflictIds: [],
        maxClockSkewMs: 0,
        timestampAdjustments: 0,
        error: `${safeMessage}${logHint}`,
      });
      try {
        if (wroteLocal) {
          await useTaskStore.getState().fetchData();
        }
        await useTaskStore.getState().updateSettings({
          lastSyncAt: now,
          lastSyncStatus: 'error',
          lastSyncError: `${safeMessage}${logHint}`,
          lastSyncHistory: nextHistory,
        });
      } catch (e) {
        logSyncWarning('[Mobile] Failed to persist sync error', e);
      }

      return { success: false, error: `${safeMessage}${logHint}` };
    } finally {
      try {
        networkSubscription?.remove?.();
      } catch (error) {
        logSyncWarning('Failed to unsubscribe network listener after sync', error);
      }
    }
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
    if (syncQueued) {
      syncQueued = false;
      void performMobileSync(syncPathOverride)
        .then((queuedResult) => {
          if (!queuedResult.success) {
            logSyncWarning('[Mobile] Queued sync failed', queuedResult.error);
          }
        })
        .catch((error) => {
          logSyncWarning('[Mobile] Queued sync crashed', error);
        });
    }
  }
}
