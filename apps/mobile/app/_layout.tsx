import '../polyfills';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { Stack, usePathname, useRouter } from 'expo-router';
import 'react-native-reanimated';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useRef } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Platform, SafeAreaView, StatusBar, Text, View } from 'react-native';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { QuickCaptureProvider, type QuickCaptureOptions } from '../contexts/quick-capture-context';
import { ToastProvider, useToast } from '../contexts/toast-context';

import { ThemeProvider, useTheme } from '../contexts/theme-context';
import { LanguageProvider, useLanguage } from '../contexts/language-context';
import {
  addBreadcrumb,
  consoleLogger,
  configureDateFormatting,
  isSupportedLanguage,
  setStorageAdapter,
  setLogger,
  useTaskStore,
} from '@mindwtr/core';
import { mobileStorage } from '../lib/storage-adapter';
import { markStartupPhase } from '../lib/startup-profiler';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { logError, logInfo, logWarn, setupGlobalErrorLogging } from '../lib/app-log';
import { useMobileAreaFilter } from '../hooks/use-mobile-area-filter';
import { useThemeColors } from '../hooks/use-theme-colors';
import { useRootLayoutExternalCapture } from './_effects/use-root-layout-external-capture';
import { useRootLayoutNotificationOpenHandler } from './_effects/use-root-layout-notification-open-handler';
import { useRootLayoutStartup } from './_effects/use-root-layout-startup';
import { useRootLayoutSyncEffects } from './_effects/use-root-layout-sync-effects';

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

const parseBool = (value: unknown): boolean =>
  value === true || value === 1 || value === '1' || value === 'true';

const getDeviceLocale = (): string => {
  try {
    return String(Intl.DateTimeFormat().resolvedOptions().locale || '').trim();
  } catch {
    return '';
  }
};

const getViewBreadcrumb = (pathname: string | null): string | null => {
  const trimmed = String(pathname || '').trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/^\/+|\/+$/g, '');
  if (!normalized) return 'view:root';
  const segments = normalized.split('/').filter(Boolean);
  const view = segments[segments.length - 1] || 'root';
  return `view:${view}`;
};

// Initialize storage for mobile
let storageInitError: Error | null = null;

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
  const { language, setLanguage, isReady: languageReady } = useLanguage();
  const { showToast } = useToast();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
  const isFossBuild = parseBool(extraConfig?.isFossBuild);
  const analyticsHeartbeatUrl = String(extraConfig?.analyticsHeartbeatUrl || '').trim();
  const isExpoGo = Constants.appOwnership === 'expo';
  const appVersion = Constants.expoConfig?.version ?? '0.0.0';
  const settingsLanguage = useTaskStore((state) => state.settings?.language);
  const settingsDateFormat = useTaskStore((state) => state.settings?.dateFormat);
  const settingsTimeFormat = useTaskStore((state) => state.settings?.timeFormat);
  const firstRenderLogged = useRef(false);
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

  const openSyncSettings = useCallback(() => {
    router.push({ pathname: '/settings', params: { settingsScreen: 'sync' } } as never);
  }, [router]);

  const openNotificationsSettings = useCallback(() => {
    router.push({ pathname: '/settings', params: { settingsScreen: 'notifications' } } as never);
  }, [router]);

  const { requestSync } = useRootLayoutSyncEffects({
    localize,
    openNotificationsSettings,
    openSyncSettings,
    showToast,
  });
  const { dataReady } = useRootLayoutStartup({
    analyticsHeartbeatUrl,
    appVersion,
    isExpoGo,
    isFossBuild,
    requestSync,
    storageInitError,
  });

  useRootLayoutNotificationOpenHandler({ router });
  useRootLayoutExternalCapture({
    dataReady,
    hasShareIntent,
    incomingUrl,
    localize,
    resetShareIntent,
    router,
    shareText: shareIntent?.text,
    shareWebUrl: shareIntent?.webUrl,
    showToast,
  });

  if (!firstRenderLogged.current) {
    firstRenderLogged.current = true;
    markStartupPhase('js.root_layout.first_render');
  }

  useEffect(() => {
    markStartupPhase('js.root_layout.mounted');
  }, []);

  useEffect(() => {
    setupGlobalErrorLogging();
  }, []);

  useEffect(() => {
    const breadcrumb = getViewBreadcrumb(pathname);
    if (!breadcrumb) return;
    addBreadcrumb(breadcrumb);
  }, [pathname]);

  useEffect(() => {
    if (Platform.OS !== 'android' || isExpoGo) return;
    SplashScreen.setOptions({ duration: 0, fade: false });
  }, [isExpoGo]);

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
            name="weekly-review"
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
