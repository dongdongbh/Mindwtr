import '../polyfills';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { Stack, usePathname, useRouter } from 'expo-router';
import 'react-native-reanimated';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState, useRef, useCallback } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Alert, AppState, AppStateStatus, Platform, SafeAreaView, StatusBar, Text, View } from 'react-native';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QuickCaptureProvider, type QuickCaptureOptions } from '../contexts/quick-capture-context';
import { ToastProvider, useToast } from '../contexts/toast-context';

import { ThemeProvider, useTheme } from '../contexts/theme-context';
import { LanguageProvider, useLanguage } from '../contexts/language-context';
import {
  addBreadcrumb,
  consoleLogger,
  configureDateFormatting,
  DEFAULT_PROJECT_COLOR,
  setStorageAdapter,
  setLogger,
  SQLITE_SCHEMA_VERSION,
  useTaskStore,
  flushPendingSave,
  isSupportedLanguage,
  generateUUID,
  sendDailyHeartbeat,
} from '@mindwtr/core';
import { mobileStorage } from '../lib/storage-adapter';
import {
  getNotificationPermissionStatus,
  setNotificationOpenHandler,
  startMobileNotifications,
  stopMobileNotifications,
} from '../lib/notification-service';
import { abortMobileSync, performMobileSync } from '../lib/sync-service';
import { classifySyncFailure, coerceSupportedBackend, isLikelyOfflineSyncError, resolveBackend, type SyncBackend } from '../lib/sync-service-utils';
import { SYNC_BACKEND_KEY } from '../lib/sync-constants';
import { isCloudKitAvailable, subscribeToCloudKitChanges } from '../lib/cloudkit-sync';
import { updateMobileWidgetFromStore } from '../lib/widget-service';
import { markStartupPhase, measureStartupPhase } from '../lib/startup-profiler';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { verifyPolyfills } from '../utils/verify-polyfills';
import { logError, logInfo, logWarn, setupGlobalErrorLogging } from '../lib/app-log';
import { useMobileAreaFilter } from '../hooks/use-mobile-area-filter';
import { useThemeColors } from '../hooks/use-theme-colors';
import { isShortcutCaptureUrl, parseShortcutCaptureUrl, type ShortcutCapturePayload } from '../lib/capture-deeplink';

type AutoSyncCadence = {
  minIntervalMs: number;
  debounceFirstChangeMs: number;
  debounceContinuousChangeMs: number;
  foregroundMinIntervalMs: number;
};

const AUTO_SYNC_BACKEND_CACHE_TTL_MS = 5_000;
const AUTO_SYNC_CADENCE_FILE: AutoSyncCadence = {
  minIntervalMs: 30_000,
  debounceFirstChangeMs: 8_000,
  debounceContinuousChangeMs: 15_000,
  foregroundMinIntervalMs: 45_000,
};
const AUTO_SYNC_CADENCE_REMOTE: AutoSyncCadence = {
  minIntervalMs: 5_000,
  debounceFirstChangeMs: 2_000,
  debounceContinuousChangeMs: 5_000,
  foregroundMinIntervalMs: 30_000,
};
const AUTO_SYNC_CADENCE_OFF: AutoSyncCadence = {
  minIntervalMs: 60_000,
  debounceFirstChangeMs: 15_000,
  debounceContinuousChangeMs: 30_000,
  foregroundMinIntervalMs: 60_000,
};
const ANALYTICS_DISTINCT_ID_KEY = 'mindwtr-analytics-distinct-id';
let coreLoggerBridgeInstalled = false;

const buildCoreLogExtra = (payload: {
  category?: string;
  context?: Record<string, unknown>;
  error?: unknown;
}): Record<string, unknown> | undefined => {
  const extra: Record<string, unknown> = {
    ...(payload.context ?? {}),
  };
  if (payload.category) {
    extra.category = payload.category;
  }
  if (payload.error) {
    extra.error = payload.error instanceof Error ? payload.error.message : String(payload.error);
    if (payload.error instanceof Error && payload.error.name) {
      extra.errorName = payload.error.name;
    }
    if (payload.error instanceof Error && payload.error.stack) {
      extra.errorStack = payload.error.stack;
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
};

const installCoreLoggerBridge = () => {
  if (coreLoggerBridgeInstalled) return;
  coreLoggerBridgeInstalled = true;
  setLogger((payload) => {
    consoleLogger(payload);
    const scope = payload.scope ?? 'core';
    const extra = buildCoreLogExtra(payload);
    if (payload.level === 'error') {
      void logError(payload.error ?? payload.message, {
        scope,
        extra,
        message: payload.message,
      });
      return;
    }
    if (payload.level === 'warn') {
      void logWarn(payload.message, { scope, extra });
      return;
    }
    void logInfo(payload.message, { scope, extra });
  });
};

type MobileExtraConfig = {
  isFossBuild?: boolean | string;
  analyticsHeartbeatUrl?: string;
};

const getCadenceForBackend = (backend: SyncBackend): AutoSyncCadence => {
  if (backend === 'file') return AUTO_SYNC_CADENCE_FILE;
  if (backend === 'webdav' || backend === 'cloud' || backend === 'cloudkit') return AUTO_SYNC_CADENCE_REMOTE;
  return AUTO_SYNC_CADENCE_OFF;
};

const supportsNativeICloudSync = (): boolean =>
  Platform.OS === 'ios' && isCloudKitAvailable();

const parseBool = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 'true';

type PlatformExtras = typeof Platform & {
  isPad?: boolean;
  constants?: {
    Release?: string;
  };
};

const platformExtras = Platform as PlatformExtras;

const getMobileAnalyticsChannel = async (isFossBuild: boolean): Promise<string> => {
  if (Platform.OS === 'ios') return 'app-store';
  if (Platform.OS !== 'android') return Platform.OS || 'mobile';
  if (isFossBuild) return 'android-sideload';
  try {
    const referrer = await Application.getInstallReferrerAsync();
    return (referrer || '').trim() ? 'play-store' : 'android-sideload';
  } catch {
    return 'android-unknown';
  }
};

const getOrCreateAnalyticsDistinctId = async (): Promise<string> => {
  const existing = (await AsyncStorage.getItem(ANALYTICS_DISTINCT_ID_KEY) || '').trim();
  if (existing) return existing;
  const generated = generateUUID();
  await AsyncStorage.setItem(ANALYTICS_DISTINCT_ID_KEY, generated);
  return generated;
};

const getMobileDeviceClass = (): string => {
  if (Platform.OS === 'ios') return platformExtras.isPad === true ? 'tablet' : 'phone';
  if (Platform.OS === 'android') return 'phone';
  return 'desktop';
};

const getMobileOsMajor = (): string => {
  if (Platform.OS === 'ios') {
    const raw = String(Platform.Version ?? '');
    const major = raw.match(/\d+/)?.[0];
    return major ? `ios-${major}` : 'ios';
  }
  if (Platform.OS === 'android') {
    const raw = String(platformExtras.constants?.Release ?? Platform.Version ?? '');
    const major = raw.match(/\d+/)?.[0];
    return major ? `android-${major}` : 'android';
  }
  return Platform.OS || 'mobile';
};

const getDeviceLocale = (): string => {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim();
  } catch {
    return '';
  }
};

const getStartupLoggingReason = (loggingEnabled: boolean): string =>
  loggingEnabled ? 'user-enabled' : 'startup-force';

const getViewBreadcrumb = (pathname: string | null): string | null => {
  const trimmed = String(pathname || '').trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/^\/+|\/+$/g, '');
  if (!normalized) return 'view:root';
  const segments = normalized.split('/').filter(Boolean);
  const view = segments[segments.length - 1] || 'root';
  return `view:${view}`;
};

const normalizeShortcutTags = (tags: string[]): string[] => {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of tags) {
    const trimmed = String(rawTag || '').trim();
    if (!trimmed) continue;
    const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    const key = prefixed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(prefixed);
  }
  return normalized;
};

// Initialize storage for mobile
let storageInitError: Error | null = null;
const logAppError = (error: unknown) => {
  void logError(error, { scope: 'app' });
};

installCoreLoggerBridge();

try {
  setStorageAdapter(mobileStorage);
} catch (e) {
  storageInitError = e as Error;
  void logError(e, { scope: 'app', extra: { message: 'Failed to initialize storage adapter' } });
}

// Keep splash visible until app is ready.
void SplashScreen.preventAutoHideAsync().catch(() => {});
markStartupPhase('js.root_layout.module_loaded');

function RootLayoutContent() {
  const tc = useThemeColors();

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: tc.bg }}>
      <ToastProvider>
        <RootLayoutContentInner />
      </ToastProvider>
    </GestureHandlerRootView>
  );
}

function RootLayoutContentInner() {
  const router = useRouter();
  const pathname = usePathname();
  const incomingUrl = Linking.useURL();
  const { isDark, isReady: themeReady } = useTheme();
  const tc = useThemeColors();
  const { language, setLanguage, t, isReady: languageReady } = useLanguage();
  const { showToast } = useToast();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
  const isFossBuild = parseBool(extraConfig?.isFossBuild);
  const analyticsHeartbeatUrl = String(extraConfig?.analyticsHeartbeatUrl || '').trim();
  const isExpoGo = Constants.appOwnership === 'expo';
  const appVersion = Constants.expoConfig?.version ?? '0.0.0';
  const [storageWarningShown, setStorageWarningShown] = useState(false);
  const [dataReady, setDataReady] = useState(false);
  const settingsLanguage = useTaskStore((state) => state.settings?.language);
  const settingsDateFormat = useTaskStore((state) => state.settings?.dateFormat);
  const settingsTimeFormat = useTaskStore((state) => state.settings?.timeFormat);
  const appState = useRef(AppState.currentState);
  const lastAutoSyncAt = useRef(0);
  const syncDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncThrottleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const widgetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryLoadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRenderLogged = useRef(false);
  const syncInFlight = useRef<Promise<void> | null>(null);
  const syncPending = useRef(false);
  const backgroundSyncPending = useRef(false);
  const isActive = useRef(true);
  const loadAttempts = useRef(0);
  const lastHandledCaptureUrl = useRef<string | null>(null);
  const lastLoggedAutoSyncError = useRef<string | null>(null);
  const lastLoggedAutoSyncErrorAt = useRef(0);
  const notificationPermissionWarningShown = useRef(false);
  const startupContextLogged = useRef(false);
  const syncCadenceRef = useRef<AutoSyncCadence>(AUTO_SYNC_CADENCE_REMOTE);
  const syncBackendCacheRef = useRef<{ backend: SyncBackend; readAt: number }>({
    backend: 'off',
    readAt: 0,
  });
  const routerRef = useRef(router);
  const showToastRef = useRef(showToast);
  const mobileUiCopyRef = useRef({
    syncIssueTitle: 'Sync issue',
    syncIssueGenericMessage: 'Background sync failed. Open Data & Sync to review the connection and retry.',
    syncIssueAuthMessage: 'Background sync needs updated credentials. Open Data & Sync to re-authenticate and retry.',
    syncIssuePermissionMessage: 'Background sync cannot write to the selected file or folder. Re-select the sync location in Data & Sync.',
    syncIssueRateLimitedMessage: 'Background sync is being rate limited. Mindwtr will retry shortly; review Data & Sync if it keeps happening.',
    syncIssueMisconfiguredMessage: 'Background sync is missing required sync settings. Open Data & Sync to finish setup.',
    syncIssueConflictMessage: 'Background sync hit a sync conflict or stale remote state. Open Data & Sync to review and retry.',
    notificationsDisabledTitle: 'Notifications disabled',
    notificationsDisabledMessage: 'Mindwtr can no longer schedule reminders until notification access is restored.',
    shareUnavailableTitle: 'Share unavailable',
    shareUnavailableMessage: 'Mindwtr could not read text or a URL from the shared item.',
    shortcutUnavailableTitle: 'Capture shortcut unavailable',
    shortcutUnavailableMessage: 'Mindwtr could not read a task title from that shortcut link.',
    openActionLabel: 'Open',
  });
  const { selectedAreaIdForNewTasks } = useMobileAreaFilter();
  const localize = useCallback((english: string, chinese: string) => (
    language.startsWith('zh') ? chinese : english
  ), [language]);
  const buildQuickCaptureInitialProps = useCallback((initialProps?: QuickCaptureOptions['initialProps']) => {
    const nextInitialProps = initialProps ? { ...initialProps } : {};
    if (!nextInitialProps.projectId && !nextInitialProps.areaId && selectedAreaIdForNewTasks) {
      nextInitialProps.areaId = selectedAreaIdForNewTasks;
    }
    return Object.keys(nextInitialProps).length > 0 ? nextInitialProps : undefined;
  }, [selectedAreaIdForNewTasks]);
  if (!firstRenderLogged.current) {
    firstRenderLogged.current = true;
    markStartupPhase('js.root_layout.first_render');
  }

  useEffect(() => {
    markStartupPhase('js.root_layout.mounted');
  }, []);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);

  useEffect(() => {
    mobileUiCopyRef.current = {
      syncIssueTitle: localize('Sync issue', '同步异常'),
      syncIssueGenericMessage: localize(
        'Background sync failed. Open Data & Sync to review the connection and retry.',
        '后台同步失败。请打开“数据与同步”检查连接并重试。'
      ),
      syncIssueAuthMessage: localize(
        'Background sync needs updated credentials. Open Data & Sync to re-authenticate and retry.',
        '后台同步需要更新凭据。请打开“数据与同步”重新验证并重试。'
      ),
      syncIssuePermissionMessage: localize(
        'Background sync cannot write to the selected file or folder. Re-select the sync location in Data & Sync.',
        '后台同步无法写入当前选择的文件或文件夹。请在“数据与同步”中重新选择同步位置。'
      ),
      syncIssueRateLimitedMessage: localize(
        'Background sync is being rate limited. Mindwtr will retry shortly; review Data & Sync if it keeps happening.',
        '后台同步正在被限流。Mindwtr 将稍后重试；如果持续发生，请检查“数据与同步”。'
      ),
      syncIssueMisconfiguredMessage: localize(
        'Background sync is missing required sync settings. Open Data & Sync to finish setup.',
        '后台同步缺少必要的同步设置。请打开“数据与同步”完成配置。'
      ),
      syncIssueConflictMessage: localize(
        'Background sync hit a sync conflict or stale remote state. Open Data & Sync to review and retry.',
        '后台同步遇到冲突或远端状态已过期。请打开“数据与同步”检查后重试。'
      ),
      notificationsDisabledTitle: localize('Notifications disabled', '通知已禁用'),
      notificationsDisabledMessage: localize(
        'Mindwtr can no longer schedule reminders until notification access is restored.',
        '在恢复通知权限之前，Mindwtr 无法继续安排提醒。'
      ),
      shareUnavailableTitle: localize('Share unavailable', '分享不可用'),
      shareUnavailableMessage: localize(
        'Mindwtr could not read text or a URL from the shared item.',
        'Mindwtr 无法从分享内容中读取文本或链接。'
      ),
      shortcutUnavailableTitle: localize('Capture shortcut unavailable', '快捷捕获不可用'),
      shortcutUnavailableMessage: localize(
        'Mindwtr could not read a task title from that shortcut link.',
        'Mindwtr 无法从该快捷方式链接中读取任务标题。'
      ),
      openActionLabel: localize('Open', '打开'),
    };
  }, [localize, t]);

  useEffect(() => {
    const breadcrumb = getViewBreadcrumb(pathname);
    if (!breadcrumb) return;
    addBreadcrumb(breadcrumb);
  }, [pathname]);

  useEffect(() => {
    if (Platform.OS !== 'android' || isExpoGo) return;
    SplashScreen.setOptions({ duration: 0, fade: false });
  }, [isExpoGo]);

  const refreshSyncCadence = useCallback(async (): Promise<AutoSyncCadence> => {
    const now = Date.now();
    const cached = syncBackendCacheRef.current;
    if (now - cached.readAt <= AUTO_SYNC_BACKEND_CACHE_TTL_MS) {
      syncCadenceRef.current = getCadenceForBackend(cached.backend);
      return syncCadenceRef.current;
    }
    const rawBackend = await AsyncStorage.getItem(SYNC_BACKEND_KEY);
    const backend = coerceSupportedBackend(resolveBackend(rawBackend), supportsNativeICloudSync());
    syncBackendCacheRef.current = { backend, readAt: now };
    syncCadenceRef.current = getCadenceForBackend(backend);
    return syncCadenceRef.current;
  }, []);

  // Keep auto-sync stable across router/i18n updates so lifecycle listeners do not reinitialize.
  const runSync = useCallback((minIntervalMs?: number) => {
    const effectiveMinIntervalMs = typeof minIntervalMs === 'number'
      ? minIntervalMs
      : syncCadenceRef.current.minIntervalMs;
    if (!isActive.current) return;
    if (syncInFlight.current && appState.current !== 'active') {
      backgroundSyncPending.current = true;
      syncPending.current = true;
      return;
    }
    if (syncInFlight.current) {
      return;
    }
    const now = Date.now();
    if (now - lastAutoSyncAt.current < effectiveMinIntervalMs) {
      if (!syncThrottleTimer.current) {
        const waitMs = Math.max(0, effectiveMinIntervalMs - (now - lastAutoSyncAt.current));
        syncThrottleTimer.current = setTimeout(() => {
          syncThrottleTimer.current = null;
          runSync(0);
        }, waitMs);
      }
      return;
    }
    lastAutoSyncAt.current = now;
    syncPending.current = false;

    const appStateAtSyncStart = appState.current;
    syncInFlight.current = (async () => {
      await flushPendingSave().catch(logAppError);
      const result = await performMobileSync().catch((error) => ({ success: false, error: String(error) }));
      if (!result.success && result.error) {
        if (isLikelyOfflineSyncError(result.error)) {
          return;
        }
        const nowMs = Date.now();
        const shouldLog = result.error !== lastLoggedAutoSyncError.current
          || nowMs - lastLoggedAutoSyncErrorAt.current > 10 * 60 * 1000;
        if (shouldLog) {
          lastLoggedAutoSyncError.current = result.error;
          lastLoggedAutoSyncErrorAt.current = nowMs;
          void logWarn('Auto-sync failed', {
            scope: 'sync',
            extra: { error: result.error },
          });
          const uiCopy = mobileUiCopyRef.current;
          const syncIssueMessage = (() => {
            switch (classifySyncFailure(result.error)) {
              case 'auth':
                return uiCopy.syncIssueAuthMessage;
              case 'permission':
                return uiCopy.syncIssuePermissionMessage;
              case 'rateLimited':
                return uiCopy.syncIssueRateLimitedMessage;
              case 'misconfigured':
                return uiCopy.syncIssueMisconfiguredMessage;
              case 'conflict':
                return uiCopy.syncIssueConflictMessage;
              default:
                return uiCopy.syncIssueGenericMessage;
            }
          })();
          showToastRef.current({
            title: uiCopy.syncIssueTitle,
            message: syncIssueMessage,
            tone: 'warning',
            durationMs: 5200,
            actionLabel: uiCopy.openActionLabel,
            onAction: () => {
              routerRef.current.push({ pathname: '/settings', params: { settingsScreen: 'sync' } } as never);
            },
          });
        }
      }
    })().finally(() => {
      syncInFlight.current = null;
      if (appStateAtSyncStart !== 'active' && backgroundSyncPending.current) {
        backgroundSyncPending.current = false;
        syncPending.current = true;
        return;
      }
      if (syncPending.current && isActive.current) {
        // Avoid immediate back-to-back sync loops while user is actively editing.
        runSync(syncCadenceRef.current.minIntervalMs);
      }
    });
  }, []);

  useEffect(() => {
    setNotificationOpenHandler((payload) => {
      const taskId = typeof payload?.taskId === 'string' ? payload.taskId : undefined;
      const projectId = typeof payload?.projectId === 'string' ? payload.projectId : undefined;
      const kind = typeof payload?.kind === 'string' ? payload.kind : undefined;
      if (taskId) {
        useTaskStore.getState().setHighlightTask(taskId);
        const openToken = typeof payload?.notificationId === 'string' ? payload.notificationId : String(Date.now());
        router.push({ pathname: '/focus', params: { taskId, openToken } });
        return;
      }
      if (projectId) {
        router.push({ pathname: '/projects-screen', params: { projectId } });
        return;
      }
      if (kind === 'daily-digest' || kind === 'weekly-review') {
        router.push('/review');
      }
    });
    return () => {
      setNotificationOpenHandler(null);
    };
  }, [router]);

  const requestSync = useCallback((minIntervalMs?: number) => {
    syncPending.current = true;
    if (typeof minIntervalMs === 'number') {
      runSync(minIntervalMs);
      return;
    }
    void refreshSyncCadence()
      .then((cadence) => runSync(cadence.minIntervalMs))
      .catch(logAppError);
  }, [refreshSyncCadence, runSync]);

  const captureFromShortcut = useCallback(async (payload: ShortcutCapturePayload) => {
    const store = useTaskStore.getState();
    const requestedProject = String(payload.project || '').trim();
    let projectId: string | undefined;
    if (requestedProject) {
      const existing = store.projects.find(
        (project) =>
          !project.deletedAt &&
          project.status !== 'archived' &&
          project.title.trim().toLowerCase() === requestedProject.toLowerCase()
      );
      if (existing) {
        projectId = existing.id;
      } else {
        const created = await store.addProject(requestedProject, DEFAULT_PROJECT_COLOR);
        projectId = created?.id;
      }
    }

    const tags = normalizeShortcutTags(payload.tags);
    await store.addTask(payload.title, {
      status: 'inbox',
      ...(payload.note ? { description: payload.note } : {}),
      ...(projectId ? { projectId } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    });

    if (router.canGoBack()) {
      router.push('/inbox');
    } else {
      router.replace('/inbox');
    }
  }, [router]);

  // Auto-sync on data changes with debounce
  useEffect(() => {
    setupGlobalErrorLogging();
    void refreshSyncCadence().catch(logAppError);
    const unsubscribe = useTaskStore.subscribe((state, prevState) => {
      if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
      // Debounce sync to batch frequent edits and avoid UI jank from constant sync churn.
      const cadence = syncCadenceRef.current;
      const hadTimer = !!syncDebounceTimer.current;
      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current);
      }
      const debounceMs = hadTimer ? cadence.debounceContinuousChangeMs : cadence.debounceFirstChangeMs;
      syncDebounceTimer.current = setTimeout(() => {
        if (!isActive.current) return;
        requestSync();
      }, debounceMs);
    });

    return () => {
      unsubscribe();
      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current);
      }
      if (syncThrottleTimer.current) {
        clearTimeout(syncThrottleTimer.current);
      }
    };
  }, [requestSync]);

  useEffect(() => {
    if (!settingsLanguage || !isSupportedLanguage(settingsLanguage)) return;
    if (settingsLanguage === language) return;
    void setLanguage(settingsLanguage);
  }, [language, settingsLanguage, setLanguage]);

  useEffect(() => {
    configureDateFormatting({
      language: settingsLanguage || language,
      dateFormat: settingsDateFormat,
      timeFormat: settingsTimeFormat,
      systemLocale: getDeviceLocale(),
    });
  }, [language, settingsDateFormat, settingsLanguage, settingsTimeFormat]);

  useEffect(() => {
    if (!hasShareIntent) return;
    const sharedText =
      typeof shareIntent?.text === 'string'
        ? shareIntent.text
        : typeof shareIntent?.webUrl === 'string'
          ? shareIntent.webUrl
          : '';
    if (sharedText.trim()) {
      router.replace({
        pathname: '/capture-modal',
        params: { text: encodeURIComponent(sharedText.trim()) },
      } as never);
    } else {
      void logError(new Error('Share intent payload missing text'), { scope: 'share-intent' });
      const uiCopy = mobileUiCopyRef.current;
      showToast({
        title: uiCopy.shareUnavailableTitle,
        message: uiCopy.shareUnavailableMessage,
        tone: 'warning',
      });
    }
    resetShareIntent();
  }, [hasShareIntent, resetShareIntent, router, shareIntent?.text, shareIntent?.webUrl, showToast]);

  useEffect(() => {
    if (!dataReady) return;
    if (!incomingUrl) return;
    if (lastHandledCaptureUrl.current === incomingUrl) return;
    const payload = parseShortcutCaptureUrl(incomingUrl);
    if (!payload) {
      if (!isShortcutCaptureUrl(incomingUrl)) return;
      lastHandledCaptureUrl.current = incomingUrl;
      void logWarn('Invalid shortcut capture URL', {
        scope: 'shortcuts',
        extra: { url: incomingUrl },
      });
      const uiCopy = mobileUiCopyRef.current;
      showToast({
        title: uiCopy.shortcutUnavailableTitle,
        message: uiCopy.shortcutUnavailableMessage,
        tone: 'warning',
      });
      return;
    }

    lastHandledCaptureUrl.current = incomingUrl;
    void captureFromShortcut(payload).catch((error) => {
      lastHandledCaptureUrl.current = null;
      void logError(error, { scope: 'shortcuts', extra: { url: incomingUrl } });
    });
  }, [captureFromShortcut, dataReady, incomingUrl, showToast]);

  // Sync on foreground/background transitions
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (!isActive.current) return;
      const previousState = appState.current;
      const wasInactiveOrBackground = previousState === 'inactive' || previousState === 'background';
      const nextInactiveOrBackground = nextAppState === 'inactive' || nextAppState === 'background';
      if (wasInactiveOrBackground && nextAppState === 'active') {
        // Coming back to foreground - sync to get latest data
        if (backgroundSyncPending.current) {
          backgroundSyncPending.current = false;
          requestSync(0);
        } else {
          void refreshSyncCadence()
            .then((cadence) => {
              const now = Date.now();
              if (now - lastAutoSyncAt.current > cadence.foregroundMinIntervalMs) {
                requestSync(0);
              }
            })
            .catch(logAppError);
        }
        updateMobileWidgetFromStore().catch(logAppError);
        if (widgetRefreshTimer.current) {
          clearTimeout(widgetRefreshTimer.current);
        }
        widgetRefreshTimer.current = setTimeout(() => {
          if (!isActive.current) return;
          updateMobileWidgetFromStore().catch(logAppError);
        }, 800);
        if (Platform.OS === 'android' && useTaskStore.getState().settings.notificationsEnabled !== false) {
          getNotificationPermissionStatus()
            .then((permission) => {
              if (!isActive.current) return;
              if (!permission.granted) {
                stopMobileNotifications().catch(logAppError);
                if (!notificationPermissionWarningShown.current) {
                  notificationPermissionWarningShown.current = true;
                  const uiCopy = mobileUiCopyRef.current;
                  showToastRef.current({
                    title: uiCopy.notificationsDisabledTitle,
                    message: uiCopy.notificationsDisabledMessage,
                    tone: 'warning',
                    durationMs: 5200,
                    actionLabel: uiCopy.openActionLabel,
                    onAction: () => {
                      routerRef.current.push({ pathname: '/settings', params: { settingsScreen: 'notifications' } } as never);
                    },
                  });
                }
                return;
              }
              notificationPermissionWarningShown.current = false;
              startMobileNotifications().catch(logAppError);
            })
            .catch(logAppError);
        }
      }
      if (previousState === 'active' && nextInactiveOrBackground) {
        // Going to background - flush saves and sync
        if (syncDebounceTimer.current) {
          clearTimeout(syncDebounceTimer.current);
          syncDebounceTimer.current = null;
        }
        if (syncThrottleTimer.current) {
          clearTimeout(syncThrottleTimer.current);
          syncThrottleTimer.current = null;
        }
        abortMobileSync();
        requestSync(0);
      }
      appState.current = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    // Wire CloudKit push notifications → immediate sync when remote changes arrive.
    // subscribeToCloudKitChanges returns a no-op cleanup if CloudKit is unavailable.
    const unsubscribeCloudKit = subscribeToCloudKitChanges(() => {
      requestSync(0);
    });

    return () => {
      subscription?.remove();
      unsubscribeCloudKit();
      isActive.current = false;
      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current);
      }
      if (syncThrottleTimer.current) {
        clearTimeout(syncThrottleTimer.current);
      }
      if (widgetRefreshTimer.current) {
        clearTimeout(widgetRefreshTimer.current);
      }
      if (retryLoadTimer.current) {
        clearTimeout(retryLoadTimer.current);
      }
      syncInFlight.current = null;
      // Flush on unmount/reload as well
      flushPendingSave().catch(logAppError);
    };
  }, [requestSync]);

  useEffect(() => {
    // Show storage error alert if initialization failed
    if (storageInitError && !storageWarningShown) {
      setStorageWarningShown(true);
      Alert.alert(
        '⚠️ Storage Error',
        'Failed to initialize storage. Your data will NOT be saved. Please restart the app.\n\nError: ' + storageInitError.message,
        [{ text: 'OK' }]
      );
    }

    // Load data from storage
    let cancelled = false;
    const loadData = async () => {
      try {
        loadAttempts.current += 1;
        markStartupPhase('js.data_load.attempt_start', { attempt: loadAttempts.current });
        if (retryLoadTimer.current) {
          clearTimeout(retryLoadTimer.current);
          retryLoadTimer.current = null;
        }
        if (cancelled) return;
        if (storageInitError) {
          return;
        }
        // Keep expensive runtime checks in development only.
        if (__DEV__) {
          verifyPolyfills();
        }

        const store = useTaskStore.getState();
        await measureStartupPhase('js.store.fetch_data', async () => {
          await store.fetchData();
        });
        if (cancelled) return;
        setDataReady(true);
        markStartupPhase('js.store.fetch_data.applied');
        if (!startupContextLogged.current) {
          startupContextLogged.current = true;
          const rawBackend = await AsyncStorage.getItem(SYNC_BACKEND_KEY);
          const syncBackend = coerceSupportedBackend(resolveBackend(rawBackend), supportsNativeICloudSync());
          const channel = await getMobileAnalyticsChannel(isFossBuild).catch(() => Platform.OS || 'mobile');
          void logInfo('App started', {
            scope: 'startup',
            force: true,
            extra: {
              version: appVersion,
              platform: Platform.OS,
              osMajor: getMobileOsMajor(),
              locale: getDeviceLocale(),
              channel,
              syncBackend,
              schemaVersion: String(SQLITE_SCHEMA_VERSION),
              deviceClass: getMobileDeviceClass(),
              buildType: isFossBuild ? 'foss' : 'standard',
              loggingReason: getStartupLoggingReason(store.settings.diagnostics?.loggingEnabled === true),
            },
          });
        }
        if (!isFossBuild && !isExpoGo && !__DEV__ && analyticsHeartbeatUrl) {
          try {
            const [distinctId, channel] = await Promise.all([
              getOrCreateAnalyticsDistinctId(),
              getMobileAnalyticsChannel(isFossBuild),
            ]);
            await measureStartupPhase('js.analytics.heartbeat', async () => {
              await sendDailyHeartbeat({
                enabled: true,
                endpointUrl: analyticsHeartbeatUrl,
                distinctId,
                platform: Platform.OS,
                channel,
                appVersion,
                deviceClass: getMobileDeviceClass(),
                osMajor: getMobileOsMajor(),
                locale: getDeviceLocale(),
                storage: AsyncStorage,
              });
            });
          } catch {
            // Keep analytics heartbeat failures silent on mobile.
          }
        }
        if (store.settings.notificationsEnabled !== false) {
          startMobileNotifications().catch(logAppError);
        }
        updateMobileWidgetFromStore().catch(logAppError);
        if (widgetRefreshTimer.current) {
          clearTimeout(widgetRefreshTimer.current);
        }
        widgetRefreshTimer.current = setTimeout(() => {
          if (!isActive.current) return;
          updateMobileWidgetFromStore().catch(logAppError);
        }, 800);
        // Initial sync after cold start
        if (!cancelled && isActive.current) {
          requestSync(0);
        }
        markStartupPhase('js.data_load.attempt_success', { attempt: loadAttempts.current });
      } catch (e) {
        markStartupPhase('js.data_load.attempt_error', { attempt: loadAttempts.current });
        void logError(e, { scope: 'app', extra: { message: 'Failed to load data' } });
        if (cancelled) return;
        if (loadAttempts.current < 3 && isActive.current) {
          if (retryLoadTimer.current) {
            clearTimeout(retryLoadTimer.current);
          }
          retryLoadTimer.current = setTimeout(() => {
            if (isActive.current) {
              loadData();
            }
          }, 2000);
          markStartupPhase('js.data_load.retry_scheduled', { attempt: loadAttempts.current, delayMs: 2000 });
          return;
        }
        // Render the shell in degraded mode after final load failure.
        setDataReady(true);
        Alert.alert(
          '⚠️ Data Load Error',
          'Failed to load your data. Some tasks may be missing.\n\nError: ' + (e as Error).message,
          [{ text: 'OK' }]
        );
      } finally {
        if (!cancelled) {
          markStartupPhase('js.data_load.marked_ready');
        }
      }
    };

    if (storageInitError) {
      return;
    }
    loadData();
    return () => {
      cancelled = true;
      if (retryLoadTimer.current) {
        clearTimeout(retryLoadTimer.current);
        retryLoadTimer.current = null;
      }
      if (widgetRefreshTimer.current) {
        clearTimeout(widgetRefreshTimer.current);
        widgetRefreshTimer.current = null;
      }
    };
  }, [analyticsHeartbeatUrl, appVersion, isExpoGo, isFossBuild, storageWarningShown, storageInitError, requestSync]);

  useEffect(() => {
    let previousEnabled = useTaskStore.getState().settings.notificationsEnabled;
    const unsubscribe = useTaskStore.subscribe((state) => {
      const enabled = state.settings.notificationsEnabled;
      if (enabled === previousEnabled) return;
      previousEnabled = enabled;

      if (enabled === false) {
        stopMobileNotifications().catch(logAppError);
      } else {
        startMobileNotifications().catch(logAppError);
      }
    });

    return () => unsubscribe();
  }, []);

  const isShellReady = themeReady && languageReady;
  const isFirstPaintReady = isShellReady && (dataReady || Boolean(storageInitError));
  useEffect(() => {
    if (!isFirstPaintReady) return;
    markStartupPhase('js.shell_ready');
    markStartupPhase('js.app_ready');
    if (typeof SplashScreen?.hideAsync === 'function') {
      SplashScreen.hideAsync()
        .then(() => {
          markStartupPhase('js.splash_hidden');
        })
        .catch((error) => {
          markStartupPhase('js.splash_hide.failed');
          void logWarn('Failed to hide splash screen', {
            scope: 'app',
            extra: { error: error instanceof Error ? error.message : String(error) },
          });
        });
      return;
    }
    markStartupPhase('js.splash_hidden.noop');
  }, [isFirstPaintReady]);

  if (storageInitError) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: tc.bg }}>
        <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
          <Text style={{ fontSize: 20, fontWeight: '600', color: isDark ? '#e2e8f0' : '#0f172a', marginBottom: 12 }}>
            Storage unavailable
          </Text>
          <Text style={{ fontSize: 14, color: isDark ? '#94a3b8' : '#475569', lineHeight: 20 }}>
            Mindwtr could not initialize local storage, so changes won&apos;t be saved. Please restart the app or reinstall if the problem persists.
          </Text>
          <Text style={{ fontSize: 12, color: isDark ? '#64748b' : '#94a3b8', marginTop: 16 }}>
            {storageInitError.message}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // Avoid mounting task screens against the empty default store before local hydration finishes.
  if (!isFirstPaintReady) {
    return null;
  }

  return (
    <QuickCaptureProvider
      value={{
        openQuickCapture: (options?: QuickCaptureOptions) => {
          const params = new URLSearchParams();
          if (options?.initialValue) {
            params.set('initialValue', options.initialValue);
          }
          const initialProps = buildQuickCaptureInitialProps(options?.initialProps);
          if (initialProps) {
            params.set('initialProps', encodeURIComponent(JSON.stringify(initialProps)));
          }
          const query = params.toString();
          router.push((query ? `/capture-modal?${query}` : '/capture-modal') as never);
        },
      }}
    >
      <NavigationThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false, animation: 'none' }} />
          <Stack.Screen name="(drawer)" options={{ headerShown: false, animation: 'none' }} />
          <Stack.Screen
            name="daily-review"
            options={{
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="global-search"
            options={{
              headerShown: false,
              presentation: 'modal',
              animation: 'slide_from_bottom'
            }}
          />
          <Stack.Screen
            name="capture-modal"
            options={{
              headerShown: false,
              presentation: 'modal',
              animation: 'slide_from_bottom'
            }}
          />
          <Stack.Screen
            name="check-focus"
            options={{
              headerShown: false,
            }}
          />
        </Stack>
        <StatusBar
          barStyle={isDark ? 'light-content' : 'dark-content'}
        />
      </NavigationThemeProvider>
    </QuickCaptureProvider>
  );
}

export default function RootLayout() {
  return (
    <ShareIntentProvider>
      <ThemeProvider>
        <LanguageProvider>
          <ErrorBoundary>
            <RootLayoutContent />
          </ErrorBoundary>
        </LanguageProvider>
      </ThemeProvider>
    </ShareIntentProvider>
  );
}
