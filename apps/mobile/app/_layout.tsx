import '../polyfills';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState, useRef, useCallback } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Alert, AppState, AppStateStatus, SafeAreaView, Text, View } from 'react-native';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { QuickCaptureProvider, type QuickCaptureOptions } from '../contexts/quick-capture-context';

import { ThemeProvider, useTheme } from '../contexts/theme-context';
import { LanguageProvider, useLanguage } from '../contexts/language-context';
import { setStorageAdapter, useTaskStore, flushPendingSave } from '@mindwtr/core';
import { mobileStorage } from '../lib/storage-adapter';
import { startMobileNotifications, stopMobileNotifications } from '../lib/notification-service';
import { performMobileSync } from '../lib/sync-service';
import { updateAndroidWidgetFromStore } from '../lib/widget-service';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { verifyPolyfills } from '../utils/verify-polyfills';
import { logError, setupGlobalErrorLogging } from '../lib/app-log';

// Initialize storage for mobile
let storageInitError: Error | null = null;
try {
  setStorageAdapter(mobileStorage);
} catch (e) {
  storageInitError = e as Error;
  console.error('[Mobile] Failed to initialize storage adapter:', e);
}

// Keep splash visible until app is ready.
void SplashScreen.preventAutoHideAsync().catch(() => {});

function RootLayoutContent() {
  const router = useRouter();
  const { isDark, isReady: themeReady } = useTheme();
  const { isReady: languageReady } = useLanguage();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const [storageWarningShown, setStorageWarningShown] = useState(false);
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const appState = useRef(AppState.currentState);
  const lastAutoSyncAt = useRef(0);
  const syncDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const widgetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryLoadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncInFlight = useRef<Promise<void> | null>(null);
  const syncRequestVersion = useRef(0);
  const syncCompletedVersion = useRef(0);
  const isActive = useRef(true);
  const loadAttempts = useRef(0);
  const lastSyncErrorShown = useRef<string | null>(null);
  const lastSyncErrorAt = useRef(0);

  const runSync = useCallback((minIntervalMs = 5_000) => {
    if (!isActive.current) return;
    if (syncInFlight.current) {
      return;
    }
    const now = Date.now();
    if (now - lastAutoSyncAt.current < minIntervalMs) return;
    lastAutoSyncAt.current = now;
    const targetVersion = syncRequestVersion.current;

    syncInFlight.current = (async () => {
      await flushPendingSave().catch(console.error);
      const result = await performMobileSync().catch((error) => ({ success: false, error: String(error) }));
      if (!result.success && result.error) {
        const nowMs = Date.now();
        const shouldShow = result.error !== lastSyncErrorShown.current && nowMs - lastSyncErrorAt.current > 10 * 60 * 1000;
        if (shouldShow) {
          lastSyncErrorShown.current = result.error;
          lastSyncErrorAt.current = nowMs;
          Alert.alert('Sync failed', result.error);
        }
      }
    })().finally(() => {
      syncInFlight.current = null;
      syncCompletedVersion.current = targetVersion;
      if (syncRequestVersion.current > syncCompletedVersion.current && isActive.current) {
        runSync(0);
      }
    });
  }, []);

  const requestSync = useCallback((minIntervalMs = 5_000) => {
    syncRequestVersion.current += 1;
    runSync(minIntervalMs);
  }, [runSync]);

  // Auto-sync on data changes with debounce
  useEffect(() => {
    setupGlobalErrorLogging();
    const unsubscribe = useTaskStore.subscribe((state, prevState) => {
      if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
      // Debounce sync: wait 5 seconds after last change
      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current);
      }
      syncDebounceTimer.current = setTimeout(() => {
        if (!isActive.current) return;
        requestSync(5_000);
      }, 5000);
    });

    return () => {
      unsubscribe();
      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current);
      }
    };
  }, [requestSync]);

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
        pathname: '/capture',
        params: { text: encodeURIComponent(sharedText.trim()) },
      });
    } else {
      void logError(new Error('Share intent payload missing text'), { scope: 'share-intent' });
      router.replace('/capture');
    }
    resetShareIntent();
  }, [hasShareIntent, resetShareIntent, router, shareIntent?.text, shareIntent?.webUrl]);

  // Sync on foreground/background transitions
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (!isActive.current) return;
      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        // Coming back to foreground - sync to get latest data
        const now = Date.now();
        if (now - lastAutoSyncAt.current > 30_000) {
          requestSync(0);
        }
        updateAndroidWidgetFromStore().catch(console.error);
        if (widgetRefreshTimer.current) {
          clearTimeout(widgetRefreshTimer.current);
        }
        widgetRefreshTimer.current = setTimeout(() => {
          if (!isActive.current) return;
          updateAndroidWidgetFromStore().catch(console.error);
        }, 800);
      }
      if (appState.current === 'active' && nextAppState.match(/inactive|background/)) {
        // Going to background - flush saves and sync
        if (syncDebounceTimer.current) {
          clearTimeout(syncDebounceTimer.current);
          syncDebounceTimer.current = null;
        }
        requestSync(0);
      }
      appState.current = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription?.remove();
      isActive.current = false;
      if (widgetRefreshTimer.current) {
        clearTimeout(widgetRefreshTimer.current);
      }
      if (retryLoadTimer.current) {
        clearTimeout(retryLoadTimer.current);
      }
      syncInFlight.current = null;
      // Flush on unmount/reload as well
      flushPendingSave().catch(console.error);
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
    const loadData = async () => {
      try {
        loadAttempts.current += 1;
        if (retryLoadTimer.current) {
          clearTimeout(retryLoadTimer.current);
          retryLoadTimer.current = null;
        }
        if (storageInitError) {
          return;
        }
        // Verify critical polyfills
        verifyPolyfills();

        const store = useTaskStore.getState();
        await store.fetchData();
        if (store.settings.notificationsEnabled !== false) {
          startMobileNotifications().catch(console.error);
        }
        updateAndroidWidgetFromStore().catch(console.error);
        if (widgetRefreshTimer.current) {
          clearTimeout(widgetRefreshTimer.current);
        }
        widgetRefreshTimer.current = setTimeout(() => {
          if (!isActive.current) return;
          updateAndroidWidgetFromStore().catch(console.error);
        }, 800);
      } catch (e) {
        console.error('[Mobile] Failed to load data:', e);
        if (loadAttempts.current < 3 && isActive.current) {
          if (retryLoadTimer.current) {
            clearTimeout(retryLoadTimer.current);
          }
          retryLoadTimer.current = setTimeout(() => {
            if (isActive.current) {
              loadData();
            }
          }, 2000);
          return;
        }
        Alert.alert(
          '⚠️ Data Load Error',
          'Failed to load your data. Some tasks may be missing.\n\nError: ' + (e as Error).message,
          [{ text: 'OK' }]
        );
      } finally {
        setIsDataLoaded(true);
      }
    };

    if (storageInitError) {
      setIsDataLoaded(true);
      return;
    }
    loadData();
  }, [storageWarningShown]);

  useEffect(() => {
    let previousEnabled = useTaskStore.getState().settings.notificationsEnabled;
    const unsubscribe = useTaskStore.subscribe((state) => {
      const enabled = state.settings.notificationsEnabled;
      if (enabled === previousEnabled) return;
      previousEnabled = enabled;

      if (enabled === false) {
        stopMobileNotifications().catch(console.error);
      } else {
        startMobileNotifications().catch(console.error);
      }
    });

    return () => unsubscribe();
  }, []);

  const isAppReady = isDataLoaded && themeReady && languageReady;

  useEffect(() => {
    if (!isAppReady) return;
    if (typeof SplashScreen?.hideAsync === 'function') {
      SplashScreen.hideAsync().catch(console.warn);
    }
  }, [isAppReady]);

  if (storageInitError) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: isDark ? '#0f172a' : '#f8fafc' }}>
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

  if (!isAppReady) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QuickCaptureProvider
        value={{
          openQuickCapture: (options?: QuickCaptureOptions) => {
            const params = new URLSearchParams();
            if (options?.initialValue) {
              params.set('initialValue', options.initialValue);
            }
            if (options?.initialProps) {
              params.set('initialProps', encodeURIComponent(JSON.stringify(options.initialProps)));
            }
            const query = params.toString();
            router.push(query ? `/capture?${query}` : '/capture');
          },
        }}
      >
        <NavigationThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
          <Stack>
            <Stack.Screen name="(drawer)" options={{ headerShown: false }} />
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
              name="capture"
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
          <StatusBar style="auto" />
        </NavigationThemeProvider>
      </QuickCaptureProvider>
    </GestureHandlerRootView>
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
