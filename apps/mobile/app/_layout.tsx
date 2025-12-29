import '../polyfills';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState, useRef } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Alert, AppState, AppStateStatus } from 'react-native';

import { ThemeProvider, useTheme } from '../contexts/theme-context';
import { LanguageProvider } from '../contexts/language-context';
import { setStorageAdapter, useTaskStore, flushPendingSave } from '@mindwtr/core';
import { mobileStorage } from '../lib/storage-adapter';
import { startMobileNotifications, stopMobileNotifications } from '../lib/notification-service';
import { performMobileSync } from '../lib/sync-service';
import { updateAndroidWidgetFromStore } from '../lib/widget-service';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { verifyPolyfills } from '../utils/verify-polyfills';

// Initialize storage for mobile
let storageInitError: Error | null = null;
try {
  setStorageAdapter(mobileStorage);
} catch (e) {
  storageInitError = e as Error;
  console.error('[Mobile] Failed to initialize storage adapter:', e);
}

function RootLayoutContent() {
  const { isDark } = useTheme();
  const [storageWarningShown, setStorageWarningShown] = useState(false);
  const appState = useRef(AppState.currentState);
  const lastAutoSyncAt = useRef(0);
  const syncDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const widgetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryLoadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncInFlight = useRef<Promise<void> | null>(null);
  const syncQueued = useRef(false);
  const isActive = useRef(true);
  const loadAttempts = useRef(0);

  const queueSync = (minIntervalMs = 5_000) => {
    if (!isActive.current) return;
    if (syncInFlight.current) {
      syncQueued.current = true;
      return;
    }
    const now = Date.now();
    if (now - lastAutoSyncAt.current < minIntervalMs) return;
    lastAutoSyncAt.current = now;

    syncInFlight.current = (async () => {
      await flushPendingSave().catch(console.error);
      await performMobileSync().catch(console.error);
    })().finally(() => {
      syncInFlight.current = null;
      if (syncQueued.current && isActive.current) {
        syncQueued.current = false;
        queueSync(0);
      }
    });
  };

  // Auto-sync on data changes with debounce
  useEffect(() => {
    const unsubscribe = useTaskStore.subscribe((state, prevState) => {
      if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
      // Debounce sync: wait 5 seconds after last change
      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current);
      }
      syncDebounceTimer.current = setTimeout(() => {
        if (!isActive.current) return;
        queueSync(5_000);
      }, 5000);
    });

    return () => {
      unsubscribe();
      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current);
      }
    };
  }, []);

  // Sync on foreground/background transitions
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (!isActive.current) return;
      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        // Coming back to foreground - sync to get latest data
        const now = Date.now();
        if (now - lastAutoSyncAt.current > 30_000) {
          queueSync(0);
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
        queueSync(0);
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
      // Flush on unmount/reload as well
      flushPendingSave().catch(console.error);
    };
  }, []);

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
        // Hide splash screen (safe for web)
        if (typeof SplashScreen?.hideAsync === 'function') {
          SplashScreen.hideAsync().catch(console.warn);
        }
      }
    };

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

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
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
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <LanguageProvider>
          <RootLayoutContent />
        </LanguageProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
