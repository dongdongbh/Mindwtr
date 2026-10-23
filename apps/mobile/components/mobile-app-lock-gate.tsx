import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LockKeyhole } from 'lucide-react-native';
import { resolveMobileAppLockRelockDelayMinutes, translateWithFallback, useTaskStore } from '@mindwtr/core';

import { useLanguage } from '@/contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import {
  authenticateWithDeviceLock,
  getMobileAppLockErrorKey,
  isWithinMobileAppLockRelockDelay,
  shouldAttemptMobileAppLockAuthentication,
} from '@/lib/mobile-app-lock';

type MobileAppLockGateProps = {
  enabled: boolean;
  children: React.ReactNode;
};

const AUTHENTICATE_AFTER_ACTIVE_DELAY_MS = 250;

export function MobileAppLockGate({ enabled, children }: MobileAppLockGateProps) {
  // Minutes away before a return asks again; 0 asks every time. A cold start always asks.
  const relockDelayMinutes = useTaskStore((state) => (
    resolveMobileAppLockRelockDelayMinutes(state.settings?.security?.mobileAppLockRelockDelayMinutes)
  ));
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const { t } = useLanguage();
  const [locked, setLocked] = useState(enabled);
  const [authenticating, setAuthenticating] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [lockNonce, setLockNonce] = useState(0);
  const [promptedNonce, setPromptedNonce] = useState(-1);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const authInFlightRef = useRef(false);
  const wasEnabledRef = useRef(enabled);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // When the app last left 'active' while unlocked; null while locked or after a cold start.
  const leftUnlockedAtRef = useRef<number | null>(null);

  const resolveText = useCallback((key: string, fallback: string) => (
    translateWithFallback(t, key, fallback)
  ), [t]);

  const authenticate = useCallback(async () => {
    if (!enabled || authInFlightRef.current) return;
    authInFlightRef.current = true;
    setAuthenticating(true);
    setErrorKey(null);
    try {
      const result = await authenticateWithDeviceLock({
        promptMessage: resolveText('appLock.prompt', 'Unlock Mindwtr'),
        cancelLabel: resolveText('common.cancel', 'Cancel'),
        fallbackLabel: resolveText('appLock.useDevicePasscode', 'Use device passcode'),
      });
      if (result.success) {
        setLocked(false);
        setErrorKey(null);
        return;
      }
      setErrorKey(getMobileAppLockErrorKey(result.reason));
    } catch {
      setErrorKey('appLock.failed');
    } finally {
      authInFlightRef.current = false;
      setAuthenticating(false);
    }
  }, [enabled, resolveText]);

  useEffect(() => {
    if (!enabled) {
      wasEnabledRef.current = false;
      setLocked(false);
      setErrorKey(null);
      return;
    }

    if (!wasEnabledRef.current) {
      wasEnabledRef.current = true;
      setLocked(false);
      setErrorKey(null);
      return;
    }

    wasEnabledRef.current = true;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    const lockApp = () => {
      setLocked(true);
      setErrorKey(null);
      setLockNonce((value) => value + 1);
    };
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      setAppState(nextAppState);
      if (authInFlightRef.current) {
        appStateRef.current = nextAppState;
        return;
      }
      const previous = appStateRef.current;
      appStateRef.current = nextAppState;
      if (previous === 'active' && (nextAppState === 'inactive' || nextAppState === 'background')) {
        // The lock screen still covers the app while it is away; the delay only skips the prompt on return.
        leftUnlockedAtRef.current = lockedRef.current ? null : Date.now();
        lockApp();
      } else if (nextAppState === 'active') {
        const leftUnlockedAt = leftUnlockedAtRef.current;
        leftUnlockedAtRef.current = null;
        if (isWithinMobileAppLockRelockDelay({ delayMinutes: relockDelayMinutes, leftUnlockedAt, now: Date.now() })) {
          setLocked(false);
        }
      }
    });
    return () => subscription.remove();
  }, [enabled, relockDelayMinutes]);

  useEffect(() => {
    if (!shouldAttemptMobileAppLockAuthentication({
      appState,
      authenticating,
      enabled,
      locked,
      lockNonce,
      promptedNonce,
    })) {
      return undefined;
    }
    const timer = setTimeout(() => {
      if (appStateRef.current !== 'active') return;
      setPromptedNonce(lockNonce);
      void authenticate();
    }, AUTHENTICATE_AFTER_ACTIVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [appState, authenticate, authenticating, enabled, locked, lockNonce, promptedNonce]);

  if (!enabled) {
    return <>{children}</>;
  }

  const message = errorKey
    ? resolveText(errorKey, errorKey === 'appLock.unavailable'
      ? 'Set up a device passcode or biometrics to use app lock.'
      : errorKey === 'appLock.cancelled'
        ? 'Mindwtr is still locked.'
        : 'Authentication failed. Try again.')
    : resolveText('appLock.description', 'Use your device lock to open Mindwtr. This protects the app view, not the on-device database.');

  const lockScreen = (
    <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['top', 'right', 'bottom', 'left']}>
      <View style={styles.content}>
        <View style={[styles.iconWrap, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
          <LockKeyhole size={34} color={tc.tint} strokeWidth={2.2} />
        </View>
        <Text style={[styles.title, { color: tc.text }]} accessibilityRole="header">
          {resolveText('appLock.title', 'Mindwtr is locked')}
        </Text>
        {/* A live region, so TalkBack reads a failed or cancelled unlock. */}
        <Text style={[styles.description, { color: tc.secondaryText }]} accessibilityLiveRegion="polite">{message}</Text>
        <TouchableOpacity
          activeOpacity={0.85}
          disabled={authenticating}
          onPress={() => void authenticate()}
          style={[
            styles.unlockButton,
            { backgroundColor: filledButton.backgroundColor, opacity: authenticating ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.unlockText, { color: filledButton.textColor ?? tc.onTint }]}>
            {authenticating
              ? resolveText('appLock.authenticating', 'Authenticating...')
              : resolveText('appLock.unlock', 'Unlock')}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );

  // Android keeps the app mounted under the lock, so a return keeps the open task and screen and
  // shows at once (#1423). The lock is a Modal, a window added after the app's own dialogs, so it
  // also covers an open task editor. iOS cannot present it over an already presented modal, so
  // iOS still renders only the lock screen while locked.
  if (Platform.OS === 'android') {
    return (
      <>
        {children}
        <Modal
          visible={locked}
          animationType="none"
          statusBarTranslucent
          navigationBarTranslucent
          onRequestClose={() => {}}
        >
          {lockScreen}
        </Modal>
      </>
    );
  }

  return locked ? lockScreen : <>{children}</>;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 10,
  },
  description: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 320,
    marginBottom: 26,
  },
  unlockButton: {
    minWidth: 156,
    minHeight: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  unlockText: {
    fontSize: 16,
    fontWeight: '700',
  },
});
