import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LockKeyhole } from 'lucide-react-native';
import { resolveMobileAppLockRelockDelayMinutes, translateWithFallback, useTaskStore } from '@mindwtr/core';

import { useLanguage } from '@/contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { logInfo } from '@/lib/app-log';
import {
  authenticateWithDeviceLock,
  getMobileAppLockErrorKey,
  isWithinMobileAppLockRelockDelay,
  MobileAppLockEnableContext,
  shouldAttemptMobileAppLockAuthentication,
} from '@/lib/mobile-app-lock';

type MobileAppLockGateProps = {
  enabled: boolean;
  securityReady: boolean;
  startupLoadFailed?: boolean;
  onRetryStartup?: () => void;
  children: React.ReactNode;

  onLockedChange?: (locked: boolean) => void;
};

const AUTHENTICATE_AFTER_ACTIVE_DELAY_MS = 250;

export function MobileAppLockGate({ enabled, securityReady, startupLoadFailed = false, onRetryStartup, children, onLockedChange }: MobileAppLockGateProps) {

  const relockDelayMinutes = useTaskStore((state) => (
    resolveMobileAppLockRelockDelayMinutes(state.settings?.security?.mobileAppLockRelockDelayMinutes)
  ));
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const { t } = useLanguage();
  const [locked, setLocked] = useState(enabled);
  const [contentAuthorized, setContentAuthorized] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [lockNonce, setLockNonce] = useState(0);
  const [promptedNonce, setPromptedNonce] = useState(-1);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const authInFlightRef = useRef(false);
  const authEpochRef = useRef(0);
  const wasEnabledRef = useRef(enabled);
  const securityReadyRef = useRef(securityReady);
  securityReadyRef.current = securityReady;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const leftUnlockedAtRef = useRef<number | null>(null);

  const needsEnableAuthentication = enabled && !wasEnabledRef.current;
  const isLocked = locked || needsEnableAuthentication;
  const coversApp = !securityReady || (enabled && isLocked);
  useEffect(() => {
    onLockedChange?.(coversApp);
  }, [coversApp, onLockedChange]);

  useEffect(() => {
    if (securityReady) return;
    setContentAuthorized(false);
    setLocked(true);
    wasEnabledRef.current = false;
    setLockNonce((value) => value + 1);
    void logInfo('App lock waiting for canonical security settings', {
      scope: 'app-lock',
      extra: { releaseCheck: 'v1.3.9/app-lock-canonical-startup', outcome: 'held' },
      force: true,
    }).catch(() => undefined);
  }, [securityReady]);

  const confirmAuthenticatedEnable = useCallback(() => {
    if (!securityReadyRef.current || AppState.currentState !== 'active'
      || useTaskStore.getState().settings.security?.mobileAppLockEnabled !== true) return;
    wasEnabledRef.current = true;
    setLocked(false);
    setContentAuthorized(true);
    setErrorKey(null);
  }, []);

  useEffect(() => {
    authEpochRef.current += 1;
  }, [enabled, securityReady]);

  const resolveText = useCallback((key: string, fallback: string) => (
    translateWithFallback(t, key, fallback)
  ), [t]);

  const authenticate = useCallback(async () => {
    if (!securityReady || !enabled || authInFlightRef.current) return;
    authInFlightRef.current = true;
    const authEpoch = authEpochRef.current;
    setAuthenticating(true);
    setErrorKey(null);
    try {
      const result = await authenticateWithDeviceLock({
        promptMessage: resolveText('appLock.prompt', 'Unlock Mindwtr'),
        cancelLabel: resolveText('common.cancel', 'Cancel'),
        fallbackLabel: resolveText('appLock.useDevicePasscode', 'Use device passcode'),
      });
      if (authEpoch !== authEpochRef.current) return;
      if (result.success) {
        wasEnabledRef.current = true;
        setLocked(false);
        setContentAuthorized(true);
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
  }, [enabled, resolveText, securityReady]);

  useEffect(() => {
    if (!enabled) {
      wasEnabledRef.current = false;
      setLocked(false);
      setErrorKey(null);
      return;
    }

    if (!wasEnabledRef.current) {
      wasEnabledRef.current = true;
      setLocked(true);
      setLockNonce((value) => value + 1);
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

        leftUnlockedAtRef.current = lockedRef.current ? null : Date.now();
        lockApp();
      } else if (nextAppState === 'active') {
        const leftUnlockedAt = leftUnlockedAtRef.current;
        leftUnlockedAtRef.current = null;
        if (isWithinMobileAppLockRelockDelay({ delayMinutes: relockDelayMinutes, leftUnlockedAt, now: Date.now() })) {
          setLocked(false);
          if (Platform.OS === 'android') {
            void logInfo('App lock grace return cleared privacy cover', {
              scope: 'app-lock',
              extra: { releaseCheck: 'v1.3.9/app-lock-resume-cover', outcome: 'grace-return' },
              force: true,
            }).catch(() => undefined);
          }
        }
      }
    });
    return () => subscription.remove();
  }, [enabled, relockDelayMinutes]);

  useEffect(() => {
    if (!shouldAttemptMobileAppLockAuthentication({
      appState,
      authenticating,
      enabled: enabled && securityReady,
      locked: isLocked,
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
  }, [appState, authenticate, authenticating, enabled, isLocked, lockNonce, promptedNonce, securityReady]);

  if (!securityReady) {
    return (
      <SafeAreaView style={[styles.container, styles.content, { backgroundColor: tc.bg }]}>
        <Text style={[styles.description, { color: tc.text }]} accessibilityLiveRegion="polite">
          {startupLoadFailed
            ? resolveText('appLock.loadFailed', 'Mindwtr could not load your data. Try again.')
            : resolveText('common.loading', 'Loading...')}
        </Text>
        {startupLoadFailed && onRetryStartup && (
          <TouchableOpacity onPress={onRetryStartup} style={[styles.unlockButton, { backgroundColor: filledButton.backgroundColor }]}>
            <Text style={[styles.unlockText, { color: filledButton.textColor ?? tc.onTint }]}>
              {resolveText('common.retry', 'Try again')}
            </Text>
          </TouchableOpacity>
        )}
      </SafeAreaView>
    );
  }

  const content = (
    <MobileAppLockEnableContext.Provider value={confirmAuthenticatedEnable}>
      {children}
    </MobileAppLockEnableContext.Provider>
  );

  if (!enabled) {
    return content;
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
        {                                                                    }
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


  if (Platform.OS === 'android') {
    return (
      <>
        {contentAuthorized && content}
        <Modal
          visible={isLocked}
          animationType="none"
          statusBarTranslucent
          navigationBarTranslucent
          onRequestClose={() => {}}
        >
          {isLocked && (appState === 'active' ? lockScreen : (
            <View testID="app-lock-privacy-cover" style={{ flex: 1, backgroundColor: tc.bg }} />
          ))}
        </Modal>
      </>
    );
  }

  return isLocked ? lockScreen : content;
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
