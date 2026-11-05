


import React from 'react';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import {
  flushPendingSave,
  loadTranslations,
  resetForTests,
  setStorageAdapter,
  useTaskStore,
  type AppSettings,
  type Project,
  type Task,
} from '@mindwtr/core';

import { SyncSettingsScreen } from './sync-settings-screen';

const FIXTURE_PATH = new URL('../../../../packages/core/src/sync-settings-parity.fixtures.json', import.meta.url).pathname;
const CAPTURE = process.env.MINDWTR_CAPTURE_SYNC_SETTINGS === '1';
const NOW = '2026-09-24T14:00:00.000Z';
const TINT = '#3b82f6';
const DANGER = '#ef4444';
const WARNING = '#f59e0b';

type EncryptionState = 'off' | 'enabled' | 'remote-encrypted-no-key' | 'remote-plaintext';

const harness = vi.hoisted(() => ({
  strings: {} as Record<string, Record<string, string>>,
  language: 'en',
  os: 'android',
  foss: false,
  dropboxAppKey: '',
  cloudKitAvailable: false,
  cloudKitStatus: 'available',
  storage: new Map<string, string>(),
  secrets: new Map<string, string>(),
  dropboxTokens: null as null | Record<string, unknown>,
  encryption: { state: 'off' as string, unavailable: false, pending: false, incomplete: null as string | null },
  queues: {} as Record<string, unknown[]>,
  held: [] as (() => void)[],
  device: [] as unknown[][],
  calls: [] as unknown[][],
  toasts: [] as unknown[][],
}));

const translate = (key: string) => harness.strings[harness.language]?.[key] || harness.strings.en?.[key] || key;


const next = (name: string, fallback: unknown) => {
  const queue = harness.queues[name];
  return queue && queue.length > 0 ? queue.shift() : fallback;
};


const answer = async (name: string, fallback: unknown): Promise<any> => {
  const entry = next(name, fallback);
  if (entry === 'hold') {
    await new Promise<void>((resolve) => { harness.held.push(resolve); });
    return answer(name, fallback);
  }
  if (entry && typeof entry === 'object' && 'encryption' in entry) harness.encryption.state = String((entry as { encryption: string }).encryption);
  if (entry && typeof entry === 'object' && 'error' in entry) throw new Error(String((entry as { error: string }).error));
  if (entry && typeof entry === 'object' && 'value' in entry) return (entry as { value: unknown }).value;
  return entry;
};

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    addBreadcrumb: (text: string) => { harness.calls.push(['breadcrumb', text]); },
    probeWebdavSyncCompatibility: async (url: string, options: Record<string, unknown>, policy?: { requireStrongEtag?: boolean }) => {
      harness.calls.push(['probeWebdav', url, {
        username: options.username, password: options.password, timeoutMs: options.timeoutMs,
        requireStrongEtag: policy?.requireStrongEtag ?? null,
      }]);
      return answer('probe', 'strong-etag');
    },
    cloudGetJson: async (url: string, options: Record<string, unknown>) => {
      harness.calls.push(['cloudGetJson', url, { token: options.token, timeoutMs: options.timeoutMs }]);
      return answer('cloudGet', {});
    },
  };
});
vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return { version: '1.3.2', extra: { isFossBuild: harness.foss, dropboxAppKey: harness.dropboxAppKey } };
    },
    appOwnership: null,
  },
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock('expo-router', () => {
  const router = { push: () => undefined, back: () => undefined, replace: () => undefined, canGoBack: () => true };
  return { useRouter: () => router, useLocalSearchParams: () => ({}), usePathname: () => '/settings' };
});
vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: any) => React.createElement('Icon', props),
}));
vi.mock('lucide-react-native', () => {
  const icons = new Map<string, unknown>();
  return new Proxy({ __esModule: true } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (!icons.has(prop)) icons.set(prop, (props: any) => React.createElement(`Icon:${prop}`, props));
      return icons.get(prop);
    },
    has: (target, prop) => prop in target || (typeof prop !== 'symbol' && prop !== 'then'),
  });
});
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => harness.storage.get(key) ?? null,
    multiGet: async (keys: string[]) => keys.map((key) => [key, harness.storage.get(key) ?? null]),
    setItem: async (key: string, value: string) => {
      harness.device.push(['setItem', key, value]);
      harness.storage.set(key, value);
    },
    multiSet: async (entries: [string, string][]) => {
      harness.device.push(['multiSet', entries]);
      for (const [key, value] of entries) harness.storage.set(key, value);
    },
    removeItem: async (key: string) => {
      harness.device.push(['removeItem', key]);
      harness.storage.delete(key);
    },
  },
}));
vi.mock('@/lib/secure-config', () => ({
  getSecureConfigValue: async (key: string) => harness.secrets.get(key) ?? null,
  setSecureConfigValue: async (key: string, value: string) => {
    harness.device.push(['setSecret', key, value]);
    harness.secrets.set(key, value);
  },
  deleteSecureConfigValue: async (key: string) => {
    harness.device.push(['deleteSecret', key]);
    harness.secrets.delete(key);
  },
}));
vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({ t: translate, language: harness.language, setLanguage: () => undefined, isReady: true }),
}));
vi.mock('@/hooks/use-theme-colors', () => {
  const colors = {
    bg: '#fff', cardBg: '#f8fafc', taskItemBg: '#fff', inputBg: '#fff', filterBg: '#f1f5f9', border: '#cbd5e1',
    text: '#0f172a', secondaryText: '#64748b', tint: '#3b82f6', onTint: '#fff', danger: '#ef4444', success: '#10b981', warning: '#f59e0b',
  };
  return { useThemeColors: () => colors };
});
vi.mock('@/hooks/use-mobile-sync-badge', () => ({
  useMobileSyncBadge: () => ({ refreshSyncBadgeConfig: async () => undefined }),
}));
vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({
    showToast: (toast: { title?: string; message: string; tone?: string; durationMs?: number }) => {
      harness.toasts.push([toast.title ?? null, toast.message, toast.tone ?? null, toast.durationMs ?? null]);
    },
    dismissToast: () => undefined,
  }),
}));
vi.mock('@/lib/app-log', () => ({
  logInfo: async (message: string, context?: { scope?: string; extra?: Record<string, string> }) => {
    harness.calls.push(['logInfo', message, context?.extra ?? null]);
  },
  logWarn: async () => undefined,
  logError: async () => undefined,
}));
vi.mock('@/lib/cloudkit-sync', () => ({
  isCloudKitAvailable: () => harness.cloudKitAvailable,
  getCloudKitAccountStatus: async () => {
    harness.calls.push(['getCloudKitAccountStatus']);
    return harness.cloudKitStatus;
  },
}));
vi.mock('@/lib/data-transfer', () => ({ listLocalDataSnapshots: async () => [], cleanupInterruptedBackupExport: async () => undefined }));
vi.mock('@/lib/analytics-heartbeat', () => ({
  isMobileAnalyticsHeartbeatConfigured: () => false,
  resetMobileAnalyticsOptOutMarker: async () => undefined,
  resolveMobileAnalyticsVersion: (version: string) => version,
  sendMobileAnalyticsOptOut: async () => true,
}));
vi.mock('@/lib/sandbox-workspace', () => ({ reloadIntoMobileSandbox: async () => undefined }));
vi.mock('./sandbox-entry-confirmation', () => ({ requestMobileSandboxEntry: () => undefined }));
vi.mock('./apple-reminders-import-section', () => ({ AppleRemindersImportSection: () => null }));

vi.mock('./use-sync-settings-backup-actions', () => {
  const noop = async () => undefined;
  return {
    useSyncSettingsBackupActions: () => ({
      formatRecoverySnapshotLabel: (name: string) => name,
      handleBackup: noop, handleExportCsv: noop, handleExportTaskNotes: noop, handleClearLog: noop,
      handleImportDgt: noop, handleImportMindwtrCsv: noop, handleImportOmniFocus: noop, handleImportTickTick: noop,
      handleImportTodoist: noop, handleMergeBackup: noop, handleRestoreBackup: noop, handleRestoreRecoverySnapshot: noop,
      handleShareLog: noop, toggleDebugLogging: noop,
    }),
  };
});
vi.mock('@/lib/storage-file', () => ({
  pickAndParseSyncFolder: async () => {
    harness.calls.push(['pickSyncFolder']);
    const picked = await answer('pick', null) as { uri: string; bookmark?: string } | null;
    return picked ? { __fileUri: picked.uri, __fileBookmark: picked.bookmark } : null;
  },
}));
vi.mock('@/lib/dropbox-oauth', () => ({
  getDropboxRedirectUri: () => 'mindwtr://redirect',
  authorizeDropbox: async (clientId: string) => {
    harness.calls.push(['authorizeDropbox', clientId]);
    return answer('authorize', { value: { accessToken: 'staged-access', refreshToken: 'staged-refresh', expiresAt: 4_102_444_800_000 } });
  },
}));
vi.mock('@/lib/dropbox-auth', () => ({
  isDropboxClientConfigured: (clientId: string) => clientId.trim().length > 0,
  isDropboxConnected: async () => harness.dropboxTokens !== null,
  getStoredDropboxTokens: async () => harness.dropboxTokens,
  saveDropboxTokens: async (tokens: Record<string, unknown>) => {
    harness.calls.push(['saveDropboxTokens', tokens]);
    harness.dropboxTokens = { ...tokens };
  },
  clearDropboxTokens: async () => {
    harness.calls.push(['clearDropboxTokens']);
    harness.dropboxTokens = null;
  },
  disconnectDropbox: async (clientId: string) => {
    harness.calls.push(['disconnectDropbox', clientId]);
    harness.dropboxTokens = null;
  },
  revokeDropboxTokens: async (clientId: string, tokens: Record<string, unknown>) => {
    harness.calls.push(['revokeDropboxTokens', clientId, tokens]);
  },
  getValidDropboxAccessToken: async (clientId: string) => {
    harness.calls.push(['getValidDropboxAccessToken', clientId]);
    return 'stored-access';
  },
  forceRefreshDropboxAccessToken: async (clientId: string) => {
    harness.calls.push(['forceRefreshDropboxAccessToken', clientId]);
    return 'refreshed-access';
  },
  getValidDropboxAccessTokenForTokens: async (clientId: string, tokens: Record<string, unknown>) => {
    harness.calls.push(['getValidDropboxAccessTokenForTokens', clientId, tokens]);
    return { accessToken: String(tokens.accessToken), tokens };
  },
  forceRefreshDropboxAccessTokenForTokens: async (clientId: string, tokens: Record<string, unknown>) => {
    harness.calls.push(['forceRefreshDropboxAccessTokenForTokens', clientId, tokens]);
    const refreshed = { ...tokens, accessToken: 'refreshed-access' };
    return { accessToken: 'refreshed-access', tokens: refreshed };
  },
}));
vi.mock('@/lib/dropbox-sync', () => ({
  testDropboxAccess: async (token: string) => {
    harness.calls.push(['testDropboxAccess', token]);
    return answer('dropboxTest', undefined);
  },
}));
vi.mock('@/lib/sync-service', () => ({
  clearMobileSyncConfigCache: () => { harness.calls.push(['clearSyncConfigCache']); },
  performMobileSync: async (syncPath: string | undefined, options: Record<string, unknown>) => {
    harness.calls.push(['performMobileSync', syncPath ?? null, options]);
    return answer('sync', { value: { success: true } });
  },
}));
vi.mock('@/lib/background-sync-task', () => ({
  syncMobileBackgroundSyncRegistration: async () => {
    harness.calls.push(['syncBackgroundRegistration']);
    return { action: 'unchanged' };
  },
}));
vi.mock('@/lib/webdav-capability-proof', () => ({
  rememberWebdavCapabilityProof: async (config: Record<string, unknown>) => {
    harness.calls.push(['rememberWebdavCapabilityProof', config]);
  },
}));
vi.mock('@/lib/sync-encryption-state', () => ({
  getMobileSyncEncryptionStatus: async () => ({ state: harness.encryption.state, incompleteTransition: harness.encryption.incomplete }),
  getIncompleteSyncEncryptionTransition: async () => harness.encryption.incomplete,
  getSyncEncryptionDiagnosticsLines: async () => [],
  logSyncEncryptionDiagnosticsBlock: async () => undefined,
}));
vi.mock('@/lib/sync-crypto-native', () => ({
  mobileSyncCryptoPrimitives: { randomBytes: (length: number) => new Uint8Array(length).fill(7) },
}));
vi.mock('@/lib/sync-encryption-service', () => {
  class SyncEncryptionCleanupDeferredError extends Error {
    constructor(readonly outcome: unknown, readonly cleanupKind: string) {
      super('cleanup deferred');
      this.name = 'SyncEncryptionCleanupDeferredError';
    }
  }

  const transition = async (name: string, after: string, onProgress?: (progress: unknown) => void) => {
    const entry = next(name, 'ok');
    if (entry === 'hold') {
      onProgress?.({ phase: 'attachments', completed: 2, total: 5 });
      await new Promise<void>((resolve) => { harness.held.push(resolve); });
      return transition(name, after, onProgress);
    }
    if (entry && typeof entry === 'object' && 'cleanup' in entry) {
      harness.encryption.state = after;
      throw new SyncEncryptionCleanupDeferredError(undefined, String((entry as { cleanup: string }).cleanup));
    }
    if (entry && typeof entry === 'object' && 'error' in entry) throw new Error(String((entry as { error: string }).error));
    harness.encryption.state = after;
  };
  return {
    isSyncEncryptionCleanupDeferredError: (error: unknown) => error instanceof SyncEncryptionCleanupDeferredError,
    getSyncEncryptionStatus: async () => {
      if (harness.encryption.unavailable) throw new Error('Sync encryption state is unavailable');
      return { state: harness.encryption.state, incompleteTransition: harness.encryption.incomplete };
    },
    isSyncEncryptionBackendPending: async () => harness.encryption.pending,
    enableSyncEncryption: async (passphrase: string, options: { appData?: unknown; onProgress?: (progress: unknown) => void }) => {
      harness.calls.push(['enableSyncEncryption', passphrase]);
      return transition('enable', 'enabled', options.onProgress);
    },
    changeSyncEncryptionPassphrase: async (current: string, nextPassphrase: string, options: { onProgress?: (progress: unknown) => void }) => {
      harness.calls.push(['changeSyncEncryptionPassphrase', current, nextPassphrase]);
      return transition('change', 'enabled', options.onProgress);
    },
    disableSyncEncryption: async (options: { onProgress?: (progress: unknown) => void }) => {
      harness.calls.push(['disableSyncEncryption']);
      return transition('disable', 'off', options.onProgress);
    },
    provideSyncEncryptionPassphrase: async (passphrase: string) => {
      harness.calls.push(['provideSyncEncryptionPassphrase', passphrase]);
      const outcome = await answer('provide', 'ok');
      if (outcome === 'ok') harness.encryption.state = 'enabled';
      if (outcome === 'no-encrypted-remote') harness.encryption.state = 'off';
      return outcome;
    },
    declineSyncEncryptionPassphrase: async () => {
      harness.calls.push(['declineSyncEncryptionPassphrase']);
    },
  };
});


const at = (day: string, time = '12:00:00') => `2026-${day}T${time}.000Z`;
const TASKS: Task[] = [
  { id: 't-report', title: 'Quarterly report', status: 'next', contexts: [], tags: [], createdAt: at('09-01'), updatedAt: at('09-01') },
];
const PROJECTS: Project[] = [
  { id: 'p-garden', title: 'Garden', status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: at('09-01'), updatedAt: at('09-01') },
];

const entityStats = (extra: Record<string, unknown> = {}) => ({
  localTotal: 1, incomingTotal: 1, mergedTotal: 1, localOnly: 0, incomingOnly: 0, conflicts: 0,
  resolvedUsingLocal: 0, resolvedUsingIncoming: 0, deletionsWon: 0, conflictIds: [], maxClockSkewMs: 0,
  invalidTimestamps: 0, timestampAdjustments: 0, timestampAdjustmentIds: [], futureTimestampClamps: 0,
  futureTimestampClampIds: [], ...extra,
});
const sample = (id: string, winner: 'local' | 'incoming', reasons: string[], diffKeys: string[]) => ({
  id, winner, reasons, hasRevision: true, timeDiffMs: 1000, localUpdatedAt: at('09-24'), incomingUpdatedAt: at('09-24'),
  localRev: 2, incomingRev: 3, localComparableHash: 'a', incomingComparableHash: 'b', diffKeys,
});
const CONFLICT_STATS = {
  tasks: entityStats({
    conflicts: 2, conflictIds: ['t-report', 't-missing'], maxClockSkewMs: 90_000, timestampAdjustments: 3,
    conflictSamples: [sample('t-report', 'incoming', ['content'], ['title', 'dueDate']), sample('t-missing', 'local', ['deleteState'], [])],
  }),
  projects: entityStats({ conflicts: 1, conflictIds: ['p-garden'], conflictSamples: [sample('p-garden', 'local', ['revision'], [])] }),
  sections: entityStats(),
  areas: entityStats({ conflicts: 6, conflictIds: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], conflictSamples: [
    sample('a1', 'local', ['revision'], []), sample('a2', 'local', ['revision'], []), sample('a3', 'local', ['revision'], []),
    sample('a4', 'local', ['revision'], []),
  ] }),
};
const IDS_ONLY_STATS = {
  tasks: entityStats({ conflicts: 1, conflictIds: ['t-report'] }),
  projects: entityStats(), sections: entityStats(), areas: entityStats(),
};
const HISTORY = [
  { at: at('09-24', '13:00:00'), status: 'conflict', backend: 'webdav', type: 'merge', conflicts: 3, conflictIds: [], maxClockSkewMs: 90_000, timestampAdjustments: 3, details: 'merged 4 changes' },
  { at: at('09-24', '11:00:00'), status: 'error', backend: 'webdav', conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0, error: 'HTTP 503' },
  { at: at('09-23', '09:30:00'), status: 'success', conflicts: 0, conflictIds: [], maxClockSkewMs: 400, timestampAdjustments: 0 },
  { at: at('09-22'), status: 'success', backend: 'webdav', type: 'push', conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  { at: at('09-21'), status: 'success', conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  { at: at('09-20'), status: 'success', conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
];

const SETTINGS: Record<string, AppSettings> = {
  base: {},
  synced: {
    lastSyncAt: at('09-24', '13:00:00'), lastSyncStatus: 'conflict', lastSyncStats: CONFLICT_STATS as never,
    lastSyncHistory: HISTORY as never,
    syncPreferences: { appearance: true, language: false, savedFilters: true, ai: true },
  },
  idsOnly: { lastSyncAt: at('09-24', '13:00:00'), lastSyncStatus: 'success', lastSyncStats: IDS_ONLY_STATS as never },
  failed: { lastSyncAt: at('09-24', '10:15:00'), lastSyncStatus: 'error', lastSyncError: 'HTTP 503: Service Unavailable' },
  lockFailed: { lastSyncAt: at('09-24', '10:15:00'), lastSyncStatus: 'error', lastSyncError: 'SYNC_FILE_LOCK_UNAVAILABLE: the lock could not be taken' },
  corruptFailed: { lastSyncStatus: 'error', lastSyncError: 'SYNC_FILE_GENERATION_CORRUPT: generation remains corrupt after bounded retries' },
  gtdGroup: { syncPreferences: { gtd: true, externalCalendars: true } },
};

const KEYS = {
  backend: '@mindwtr_sync_backend',
  path: '@mindwtr_sync_path',
  webdavUrl: '@mindwtr_webdav_url',
  webdavUser: '@mindwtr_webdav_username',
  webdavPassword: '@mindwtr_webdav_password',
  cloudUrl: '@mindwtr_cloud_url',
  cloudToken: '@mindwtr_cloud_token',
  cloudProvider: '@mindwtr_cloud_provider',
};
const WEBDAV_STORED = {
  storage: { [KEYS.backend]: 'webdav', [KEYS.webdavUrl]: 'https://dav.example.com/mindwtr', [KEYS.webdavUser]: 'alice' },
  secrets: { [KEYS.webdavPassword]: 'hunter22' },
};
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

type Device = {
  language?: string;
  os?: 'android' | 'ios';
  foss?: boolean;
  dropboxAppKey?: string;
  cloudKitStatus?: string;
  storage?: Record<string, string>;
  secrets?: Record<string, string>;
  dropboxConnected?: boolean;
  encryption?: { state?: EncryptionState; unavailable?: boolean; pending?: boolean; incomplete?: string | null };
  queues?: Record<string, unknown[]>;
};


type Scenario = { name: string; settings: string; data?: 'none' | 'titles'; device: Device; actions: [string, ...unknown[]][] };

const ok = { value: { success: true } };
const scenarios: Scenario[] = [
  {
    name: 'off: defaults',
    settings: 'base', device: {},
    actions: [
      ['press', 'k:settings.syncPreferences'], ['switch', 0], ['switch', 2], ['switch', 5], ['press', 'k:settings.syncPreferences'],
      ['press', 'k:settings.syncBackendWebdav'], ['press', 'k:settings.syncBackendOff'],
      ['press', 'k:settings.cloudProviderSelfHosted'], ['press', 'k:settings.syncBackendFile'],
      ['press', 'k:settings.recoverySnapshots'],
    ],
  },
  {
    name: 'off: stored preferences',
    settings: 'gtdGroup', device: {},
    actions: [['press', 'k:settings.syncPreferences'], ['switch', 2], ['switch', 4], ['switch', 1]],
  },
  {
    name: 'webdav: set up from scratch',
    settings: 'base', device: {},
    actions: [
      ['press', 'k:settings.syncBackendWebdav'],
      ['type', 0, 'dav.example.com'],
      ['type', 0, '  https://dav.example.com/mindwtr/  '], ['type', 1, '  alice  '], ['type', 2, 'hunter22'],
      ['press', 'k:settings.testConnection'],
      ['press', 'k:settings.webdavSave'],
    ],
  },
  {
    name: 'webdav: stored and synced',
    settings: 'synced', data: 'titles', device: { ...WEBDAV_STORED, queues: { sync: [ok, { value: { success: true, stats: CONFLICT_STATS } }] } },
    actions: [
      ['press', 'k:settings.syncHistory'],
      ['press', 'k:settings.syncNow'],
      ['press', 'k:settings.syncHistory'],
    ],
  },
  {
    name: 'webdav: conflict ids without samples',
    settings: 'idsOnly', device: { ...WEBDAV_STORED }, actions: [],
  },
  {
    name: 'webdav: a slow sync',
    settings: 'base', device: { ...WEBDAV_STORED, queues: { sync: ['hold', ok, { value: { success: true, remoteWriteDeferred: true } }] } },
    actions: [['press', 'k:settings.syncNow'], ['release']],
  },
  {
    name: 'webdav: failures',
    settings: 'failed',
    device: {
      ...WEBDAV_STORED,
      queues: {
        sync: [
          { value: { success: true, skipped: 'offline', offlineCause: 'request' } },
          { value: { success: true, skipped: 'offline', offlineCause: 'network' } },
          { value: { success: false, error: 'HTTP 401 Unauthorized' } },
          { value: { success: true, skipped: 'requeued' } },
        ],
        probe: ['strong-etag', 'strong-etag', 'strong-etag', 'strong-etag', { error: 'WebDAV GET failed (500)' }],
      },
    },
    actions: [
      ['press', 'k:settings.syncNow'], ['press', 'k:settings.syncNow'], ['press', 'k:settings.syncNow'], ['press', 'k:settings.syncNow'],
      ['press', 'k:settings.testConnection'],
      ['type', 0, 'http://dav.example.com'], ['press', 'k:settings.webdavSave'],
      ['switch', 0], ['press', 'k:settings.webdavSave'],
    ],
  },
  {
    name: 'webdav: encryption on and a legacy server',
    settings: 'base',
    device: { ...WEBDAV_STORED, encryption: { state: 'enabled' }, queues: { probe: ['legacy-plaintext', 'legacy-plaintext'] } },
    actions: [['press', 'k:settings.testConnection'], ['press', 'k:settings.syncNow']],
  },
  {
    name: 'webdav: an encrypted remote without the key',
    settings: 'base',
    device: {
      ...WEBDAV_STORED,
      storage: { [KEYS.webdavUrl]: 'https://dav.example.com/mindwtr', [KEYS.webdavUser]: 'alice' },

      queues: { sync: [{ value: { success: false, error: 'Sync paused: passphrase required', activationProof: 'remote-encrypted-no-key' }, encryption: 'remote-encrypted-no-key' }] },
    },
    actions: [['press', 'k:settings.syncBackendWebdav'], ['press', 'k:settings.syncBackendWebdav']],
  },
  {
    name: 'self-hosted: set up',
    settings: 'base', device: { queues: { cloudGet: [{ error: 'HTTP 403 Forbidden' }] } },
    actions: [
      ['press', 'k:settings.cloudProviderSelfHosted'],
      ['type', 0, 'https://cloud.example.com'], ['type', 1, 'abc'],
      ['type', 1, ''], ['press', 'k:settings.cloudSave'],
      ['type', 1, TOKEN], ['press', 'k:settings.testConnection'], ['press', 'k:settings.testConnection'],
      ['press', 'k:settings.cloudSave'],
    ],
  },
  {
    name: 'self-hosted: stored',
    settings: 'base',
    device: {
      storage: { [KEYS.backend]: 'cloud', [KEYS.cloudProvider]: 'selfhosted', [KEYS.cloudUrl]: 'https://cloud.example.com' },
      secrets: { [KEYS.cloudToken]: TOKEN },
      queues: { sync: [{ value: { success: true, remoteWriteDeferred: true } }, ok, { value: { success: true, attachmentWriteDeferred: true } }] },
    },
    actions: [['press', 'k:settings.syncNow'], ['press', 'k:settings.syncNow'], ['press', 'k:settings.syncBackendOff']],
  },
  {
    name: 'file: pick a folder',
    settings: 'base',
    device: { queues: { pick: [{ value: { uri: 'content://com.android.externalstorage.documents/tree/primary%3ASync/document/primary%3ASync%2Fdata.json' } }] } },
    actions: [['press', 'k:settings.syncBackendFile'], ['press', 'k:settings.selectFolder']],
  },
  {
    name: 'file: picker errors',
    settings: 'base',
    device: {
      queues: {
        pick: [
          null,
          { error: 'Selected JSON file is not a Mindwtr backup' },
          { error: 'The folder is read-only' },
          { error: 'Picked a temporary Inbox location' },
          { error: 'Picker crashed' },
        ],
      },
    },
    actions: [
      ['press', 'k:settings.syncBackendFile'],
      ['press', 'k:settings.selectFolder'], ['press', 'k:settings.selectFolder'], ['press', 'k:settings.selectFolder'],
      ['press', 'k:settings.selectFolder'], ['press', 'k:settings.selectFolder'],
    ],
  },
  {
    name: 'file: stored, lock busy and cleanup deferred',
    settings: 'lockFailed',
    device: {
      storage: { [KEYS.backend]: 'file', [KEYS.path]: 'content://tree/primary%3ASync/document/primary%3ASync%2Fdata.json' },
      queues: {
        sync: [
          { value: { success: true, fileSyncLockDeferred: 'busy' } },
          { value: { success: true, fileSyncLockDeferred: 'cleanup' } }, ok,
          { value: { success: false, fileGenerationCorrupt: true, error: 'corrupt' } },
          { value: { success: false, fileAttachmentUploadBlocked: 'too-large', error: 'too large' } },
          { value: { success: true, fileSyncLockUnavailable: true } },
        ],
      },
    },
    actions: [['press', 'k:settings.syncNow'], ['press', 'k:settings.syncNow'], ['press', 'k:settings.syncNow'], ['press', 'k:settings.syncNow'], ['press', 'k:settings.syncNow']],
  },
  {
    name: 'file: a corrupt generation',
    settings: 'corruptFailed',
    device: { storage: { [KEYS.backend]: 'file', [KEYS.path]: 'content://tree/primary%3ASync/document/primary%3ASync%2Fdata.json' } },
    actions: [],
  },
  {
    name: 'dropbox: connect, test and disconnect',
    settings: 'base',
    device: { dropboxAppKey: 'app-key' },
    actions: [
      ['press', 'k:settings.cloudProviderDropbox'],
      ['press', 'k:settings.dropboxConnect'],
      ['press', 'k:settings.testConnection'],
      ['press', 'k:settings.syncNow'],
      ['press', 'k:settings.dropboxDisconnect'],
    ],
  },
  {
    name: 'dropbox: a failed activation',
    settings: 'base',
    device: { dropboxAppKey: 'app-key', queues: { sync: [{ value: { success: false, error: 'Dropbox upload failed' } }] } },
    actions: [
      ['press', 'k:settings.cloudProviderDropbox'],
      ['press', 'k:settings.dropboxConnect'],
      ['press', 'k:settings.dropboxDisconnect'],
    ],
  },
  {
    name: 'dropbox: a revoked token',
    settings: 'base',
    device: {
      dropboxAppKey: 'app-key', dropboxConnected: true,
      storage: { [KEYS.backend]: 'cloud', [KEYS.cloudProvider]: 'dropbox' },
      queues: { dropboxTest: [{ error: 'HTTP 401 invalid_access_token' }, { error: 'HTTP 401 invalid_access_token' }] },
    },
    actions: [['press', 'k:settings.testConnection'], ['press', 'k:settings.syncNow']],
  },
  {
    name: 'dropbox: stored and connected',
    settings: 'base',
    device: {
      dropboxAppKey: 'app-key', dropboxConnected: true,
      storage: { [KEYS.backend]: 'cloud', [KEYS.cloudProvider]: 'dropbox' },
      queues: { authorize: [{ error: 'redirect_uri mismatch' }] },
    },
    actions: [
      ['press', 'k:settings.syncBackendWebdav'], ['press', 'k:settings.cloudProviderDropbox'],
      ['press', 'k:settings.dropboxDisconnect'], ['press', 'k:settings.cloudProviderDropbox'], ['press', 'k:settings.dropboxConnect'],
    ],
  },
  {
    name: 'dropbox: a build without an app key',
    settings: 'base',
    device: { storage: { [KEYS.backend]: 'cloud', [KEYS.cloudProvider]: 'dropbox' } },
    actions: [['press', 'k:settings.cloudProviderDropbox']],
  },
  {
    name: 'foss: a stored Dropbox backend',
    settings: 'base',
    device: { foss: true, dropboxAppKey: 'app-key', storage: { [KEYS.backend]: 'cloud', [KEYS.cloudProvider]: 'dropbox', [KEYS.cloudUrl]: 'https://cloud.example.com' } },
    actions: [],
  },
  {
    name: 'encryption: enable',
    settings: 'base',
    device: { ...WEBDAV_STORED, queues: { enable: ['hold', 'ok'] } },
    actions: [
      ['press', 'k:settings.syncEncryptionEnable'],
      ['type', 3, 'one'], ['type', 4, 'two'],
      ['press', 'k:settings.syncEncryptionEnable'],
      ['press', 'k:settings.syncEncryptionShowPassphrase'],
      ['press', 'k:settings.syncEncryptionGenerate'],
      ['press', 'k:settings.syncEncryptionEnable'],
      ['release'],
    ],
  },
  {
    name: 'encryption: enable before the first sync',
    settings: 'base',
    device: { encryption: { pending: true }, storage: { [KEYS.backend]: 'file', [KEYS.path]: 'content://tree/x/document/x%2Fdata.json' }, queues: { enable: [{ error: 'SYNC_ENCRYPTION_BACKEND_REQUIRED' }] } },
    actions: [
      ['press', 'k:settings.syncEncryptionEnable'],
      ['type', 0, 'pass'], ['type', 1, 'pass'],
      ['press', 'k:settings.syncEncryptionEnable'],
      ['press', 'k:common.cancel'],
    ],
  },
  {
    name: 'encryption: change and turn off',
    settings: 'base',
    device: {
      ...WEBDAV_STORED, encryption: { state: 'enabled' },
      queues: { change: [{ error: 'MWENC1: wrong passphrase' }, { cleanup: 'remote' }], disable: [{ error: 'SYNC_ENCRYPTION rotation pending' }, 'ok'] },
    },
    actions: [
      ['press', 'k:settings.syncEncryptionChange'],
      ['type', 3, 'old'], ['type', 4, 'new'], ['type', 5, 'new'],
      ['press', 'k:settings.syncEncryptionChange'],
      ['press', 'k:settings.syncEncryptionChange'],
      ['press', 'k:settings.syncEncryptionDisable'],
      ['press', 'k:settings.syncEncryptionDisable'],
      ['press', 'k:settings.syncEncryptionDisable'],
    ],
  },
  {
    name: 'encryption: unlock',
    settings: 'base',
    device: {
      ...WEBDAV_STORED, encryption: { state: 'remote-encrypted-no-key' },
      queues: { provide: ['wrong-passphrase', { error: 'SYNC_ENCRYPTION_TRANSITION_INCOMPLETE' }, 'ok'] },
    },
    actions: [
      ['press', 'k:settings.syncEncryptionUnlock'],
      ['type', 3, 'bad'], ['press', 'k:settings.syncEncryptionUnlock'],
      ['press', 'k:settings.syncEncryptionUnlock'],
      ['type', 3, 'good'], ['press', 'k:settings.syncEncryptionUnlock'],
    ],
  },
  {
    name: 'encryption: decline and a location left behind',
    settings: 'base',
    device: { ...WEBDAV_STORED, encryption: { state: 'remote-encrypted-no-key' }, queues: { provide: ['no-encrypted-remote'] } },
    actions: [
      ['press', 'k:settings.syncEncryptionUnlock'], ['press', 'k:settings.syncEncryptionDecline'],
      ['press', 'k:settings.syncEncryptionUnlock'], ['type', 3, 'any'], ['press', 'k:settings.syncEncryptionUnlock'],
    ],
  },
  {
    name: 'encryption: a peer turned it off, mid-transition',
    settings: 'base',
    device: { ...WEBDAV_STORED, encryption: { state: 'remote-plaintext', incomplete: 'disable' }, queues: { disable: [{ cleanup: 'file-lock' }] } },
    actions: [['press', 'k:settings.syncEncryptionDisable'], ['device', { encryption: { incomplete: null } }], ['press', 'k:settings.syncEncryptionDisable']],
  },
  {
    name: 'encryption: state unavailable',
    settings: 'base',
    device: { ...WEBDAV_STORED, encryption: { unavailable: true } },
    actions: [['device', { encryption: { unavailable: false } }], ['press', 'k:settings.syncEncryptionRetry']],
  },
  {
    name: 'webdav: in German',
    settings: 'synced', data: 'titles', device: { ...WEBDAV_STORED, language: 'de' },
    actions: [['press', 'k:settings.syncHistory'], ['press', 'k:settings.syncPreferences']],
  },
  {
    name: 'ios: iCloud and the file panel',
    settings: 'base',
    device: { os: 'ios', cloudKitStatus: 'noAccount' },
    actions: [
      ['press', 'iCloud'],
      ['device', { cloudKitStatus: 'available' }], ['press', 'k:settings.syncNow'],
      ['press', 'k:settings.syncBackendFile'],
    ],
  },
];


const writeLog: unknown[][] = [];
const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, entry) => (
  entry === undefined ? '<undefined>' : entry
)));

let realUpdateSettings: ((...args: any[]) => Promise<any>) | null = null;

async function seedStore(scenario: Scenario) {
  await flushPendingSave();
  resetForTests();
  realUpdateSettings ??= useTaskStore.getState().updateSettings;
  const real = realUpdateSettings;
  const titled = scenario.data === 'titles';
  const data = JSON.parse(JSON.stringify({
    tasks: titled ? TASKS : [], projects: titled ? PROJECTS : [], sections: [], areas: [], people: [], settings: SETTINGS[scenario.settings],
  }));
  setStorageAdapter({ getData: async () => data, saveData: async () => undefined });
  useTaskStore.setState({
    updateSettings: real,
    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
  } as never);
  await useTaskStore.getState().fetchData({ throwOnError: true });
  await flushPendingSave();
  useTaskStore.setState({
    updateSettings: async (...args: unknown[]) => {
      writeLog.push(['updateSettings', ...(normalize(args) as unknown[])]);
      return real(...args);
    },
  } as never);
}

function applyDevice(device: Device) {
  if (device.language !== undefined) harness.language = device.language;
  if (device.os !== undefined) harness.os = device.os;
  if (device.foss !== undefined) harness.foss = device.foss;
  if (device.dropboxAppKey !== undefined) harness.dropboxAppKey = device.dropboxAppKey;
  if (device.cloudKitStatus !== undefined) harness.cloudKitStatus = device.cloudKitStatus;
  if (device.encryption) Object.assign(harness.encryption, device.encryption);
  (Platform as { OS: string }).OS = harness.os;
  harness.cloudKitAvailable = harness.os === 'ios';
}

function setDevice(device: Device) {
  harness.language = 'en';
  harness.os = 'android';
  harness.foss = false;
  harness.dropboxAppKey = '';
  harness.cloudKitStatus = 'available';
  harness.encryption = { state: 'off', unavailable: false, pending: false, incomplete: null };
  applyDevice(device);
  harness.storage = new Map(Object.entries(device.storage ?? {}));
  harness.secrets = new Map(Object.entries(device.secrets ?? {}));
  harness.dropboxTokens = device.dropboxConnected
    ? { accessToken: 'stored-access', refreshToken: 'stored-refresh', expiresAt: 4_102_444_800_000 }
    : null;
  harness.queues = JSON.parse(JSON.stringify(device.queues ?? {}));
  harness.held.length = 0;
  harness.device.length = 0;
  harness.calls.length = 0;
  harness.toasts.length = 0;
  writeLog.length = 0;
}


const deepText = (node: ReactTestInstance | string | number | null | undefined | boolean): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map((child) => deepText(child as ReactTestInstance | string)).join('');
};

function hosts(root: ReactTestInstance, type: string): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === type) out.push(node);
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten))
  : style && typeof style === 'object' ? style as Record<string, unknown> : {});

const colorOf = (node: ReactTestInstance) => String(flatten(node.props.style).color ?? '').toLowerCase();


function textsIn(root: ReactTestInstance): unknown[] {
  const out: unknown[] = [];
  const walk = (node: ReactTestInstance) => {
    if (String(node.type) === 'Text') {
      const color = colorOf(node);
      const text = deepText(node);
      out.push(color === DANGER ? ['danger', text] : color === WARNING ? ['warning', text] : text);
      return;
    }
    node.children.forEach((child) => { if (typeof child !== 'string') walk(child); });
  };
  walk(root);
  return out;
}

const controlTexts = (node: ReactTestInstance) => hosts(node, 'Text').map((text) => deepText(text));
const controlLabel = (node: ReactTestInstance) => node.props.accessibilityLabel ?? controlTexts(node).join('|');

function readScreen(root: ReactTestInstance) {
  return {
    texts: textsIn(root),

    controls: hosts(root, 'TouchableOpacity').map((node) => {
      const first = hosts(node, 'Text')[0];
      return [controlLabel(node), first ? colorOf(first) === TINT : false, node.props.disabled === true, hosts(node, 'ActivityIndicator').length > 0];
    }),
    switches: hosts(root, 'Switch').map((node) => [node.props.value, node.props.disabled === true]),

    inputs: hosts(root, 'TextInput').map((node) => {
      const secure = node.props.secureTextEntry === true;
      const shown = String(node.props.value ?? '');
      return [node.props.accessibilityLabel ?? null, node.props.placeholder ?? null, secure ? '•'.repeat(shown.length) : shown, secure];
    }),
    links: root.findAll((node) => typeof node.type === 'function' && (node.type as { name?: string }).name === 'SettingsGuideLink')
      .map((node) => [node.props.testID ?? null, node.props.title, node.props.url]),
  };
}

function drain(seen: { writes: number; device: number; toasts: number; calls: number }) {
  const out = {
    writes: writeLog.slice(seen.writes),
    device: normalize(harness.device.slice(seen.device)),
    toasts: normalize(harness.toasts.slice(seen.toasts)),
    calls: normalize(harness.calls.slice(seen.calls)),
  };
  seen.writes = writeLog.length;
  seen.device = harness.device.length;
  seen.toasts = harness.toasts.length;
  seen.calls = harness.calls.length;
  return out;
}

type Seen = Parameters<typeof drain>[0];

const observe = (root: ReactTestInstance, seen: Seen) => normalize({ ...readScreen(root), ...drain(seen) });


async function run(what: string, fn: (() => unknown) | undefined) {
  if (!fn) throw new Error(`Nothing to do for ${what}`);
  await act(async () => { await fn(); });
}

const labelText = (label: string) => (label.startsWith('k:') ? translate(label.slice(2)) : label);
const matches = (node: ReactTestInstance, label: string) => {
  const text = controlLabel(node);
  return text === label || text.split('|')[0] === label || text.startsWith(`${label}. `) || text.startsWith(`${label} (`);
};

async function perform(renderer: ReactTestRenderer, action: [string, ...unknown[]]) {
  const root = renderer.root;
  const [kind, target, extra] = action;
  switch (kind) {
    case 'press': {
      const label = labelText(target as string);
      const control = hosts(root, 'TouchableOpacity').find((node) => matches(node, label));
      if (!control) throw new Error(`No control ${label}`);

      if (control.props.disabled) return undefined;
      return run(`press ${label}`, control.props.onPress);
    }
    case 'switch': {
      const control = hosts(root, 'Switch')[target as number];
      return run('switch', () => control.props.onValueChange(!control.props.value));
    }
    case 'type':
      return run('type', () => hosts(root, 'TextInput')[target as number].props.onChangeText(extra));
    case 'release':
      return run('release', () => harness.held.shift()?.());
    case 'device':
      return run('device', () => applyDevice(target as Device));
    default:
      throw new Error(`Unknown action ${String(kind)}`);
  }
}

const settle = async () => {
  await act(async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    await flushPendingSave();
  });
};

async function runScenario(scenario: Scenario) {
  await seedStore(scenario);
  setDevice(scenario.device);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<SyncSettingsScreen />);
  });
  await settle();
  const seen: Seen = { writes: 0, device: 0, toasts: 0, calls: 0 };
  const observations = [observe(renderer.root, seen)];
  for (const action of scenario.actions) {
    await perform(renderer, action);
    await settle();
    observations.push(observe(renderer.root, seen));
  }

  while (harness.held.length > 0) await act(async () => { harness.held.shift()?.(); });
  await settle();
  await act(async () => { renderer.unmount(); });
  await flushPendingSave();
  return observations;
}

const inputs = () => normalize({
  now: NOW, timeZone: 'UTC', deviceLocale: 'en-US', tasks: TASKS, projects: PROJECTS, settings: SETTINGS, scenarios,
}) as Record<string, unknown>;

function captureProvenance() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const harnessPath = 'apps/mobile/components/settings/sync-settings-screen.parity.test.tsx';
  const changed = git('status', '--porcelain', '--untracked-files=all', '--', '../../../../apps').split('\n').filter(Boolean)
    .map((line) => line.slice(3)).filter((path) => path !== harnessPath);
  if (changed.length > 0) throw new Error(`Capture needs HEAD's apps/ code; changed: ${changed.join(', ')}`);
  return {
    command: 'cd apps/mobile && MINDWTR_CAPTURE_SYNC_SETTINGS=1 TZ=UTC bunx vitest run components/settings/sync-settings-screen.parity.test.tsx',
    capturedAt: head,
    sourceState: 'Every file under apps/ was at HEAD except this harness. No React Native code imported core\'s sync settings model yet.',
    device: 'The device is stubbed: AsyncStorage and the secure store are the scenario\'s maps, the device locale is en-US (toLocaleString), and the sync run, the WebDAV probe, the self-hosted check, the folder picker, Dropbox and the encryption service answer from the scenario\'s queues. The Data screen\'s actions and the recovery snapshot list are stubs; the Sync screen only draws the folded recovery snapshots card from them.',
  };
}

describe('React Native Settings › Sync parity fixture', () => {
  const originalTz = process.env.TZ;
  const originalOs = Platform.OS;
  const originalToLocaleString = Date.prototype.toLocaleString;
  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));

    vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function toLocaleString(this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return originalToLocaleString.call(this, locales ?? 'en-US', options);
    });
    harness.strings = { en: await loadTranslations('en'), de: await loadTranslations('de') };
  });
  afterAll(() => {
    (Platform as { OS: string }).OS = originalOs;
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetForTests();
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('replays every scenario exactly as frozen', async () => {
    const captured: Record<string, unknown> = {};
    for (const scenario of scenarios) captured[scenario.name] = await runScenario(scenario);

    if (process.env.MINDWTR_DUMP_SYNC_SETTINGS) writeFileSync(process.env.MINDWTR_DUMP_SYNC_SETTINGS, JSON.stringify(captured));
    if (CAPTURE) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance: captureProvenance(), ...inputs(), observations: captured }, null, 1)}\n`);
    }
    const { observations, provenance: _provenance, ...frozenInputs } = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(frozenInputs).toEqual(inputs());
    for (const name of Object.keys(captured)) {
      expect({ [name]: captured[name] }).toEqual({ [name]: observations[name] });
    }
    expect(Object.keys(observations)).toEqual(Object.keys(captured));
  }, 300_000);
});
