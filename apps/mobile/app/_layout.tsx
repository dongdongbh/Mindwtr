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

  // Flush pending saves when app goes to background
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        const now = Date.now();
        if (now - lastAutoSyncAt.current > 30_000) {
          lastAutoSyncAt.current = now;
          performMobileSync().catch(console.error);
        }
      }
      if (appState.current === 'active' && nextAppState.match(/inactive|background/)) {
        // App is going to background - flush any pending saves
        flushPendingSave().catch(console.error);
      }
      appState.current = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription?.remove();
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
        // Verify critical polyfills
        verifyPolyfills();

        const store = useTaskStore.getState();
        await store.fetchData();
        if (store.settings.notificationsEnabled !== false) {
          startMobileNotifications().catch(console.error);
        }
      } catch (e) {
        console.error('[Mobile] Failed to load data:', e);
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
    const unsubscribe = useTaskStore.subscribe(
      (state) => state.settings.notificationsEnabled,
      (enabled) => {
        if (enabled === false) {
          stopMobileNotifications().catch(console.error);
        } else {
          startMobileNotifications().catch(console.error);
        }
      }
    );

    return () => unsubscribe();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NavigationThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="(drawer)" options={{ headerShown: false }} />
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
