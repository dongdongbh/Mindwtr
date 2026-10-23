import * as LocalAuthentication from 'expo-local-authentication';

export type MobileAppLockAuthFailureReason = 'unavailable' | 'cancelled' | 'failed';

export type MobileAppLockAuthOutcome =
  | { success: true }
  | { success: false; reason: MobileAppLockAuthFailureReason; error?: string };

export type MobileAppLockAuthenticationGateInput = {
  appState: string;
  authenticating: boolean;
  enabled: boolean;
  locked: boolean;
  lockNonce: number;
  promptedNonce: number;
};

type AuthenticateWithDeviceLockOptions = {
  promptMessage: string;
  cancelLabel: string;
  fallbackLabel: string;
};

const UNAVAILABLE_ERRORS = new Set([
  'not_available',
  'not_enrolled',
  'passcode_not_set',
]);

const CANCELLED_ERRORS = new Set([
  'app_cancel',
  'system_cancel',
  'user_cancel',
  'user_fallback',
]);

export async function canUseDeviceAuthentication(): Promise<boolean> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  return level !== LocalAuthentication.SecurityLevel.NONE;
}

export async function authenticateWithDeviceLock({
  promptMessage,
  cancelLabel,
  fallbackLabel,
}: AuthenticateWithDeviceLockOptions): Promise<MobileAppLockAuthOutcome> {
  const available = await canUseDeviceAuthentication();
  if (!available) {
    return { success: false, reason: 'unavailable' };
  }

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel,
    fallbackLabel,
    disableDeviceFallback: false,
    biometricsSecurityLevel: 'weak',
    requireConfirmation: true,
  });

  if (result.success) return { success: true };
  if (UNAVAILABLE_ERRORS.has(result.error)) {
    return { success: false, reason: 'unavailable', error: result.error };
  }
  if (CANCELLED_ERRORS.has(result.error)) {
    return { success: false, reason: 'cancelled', error: result.error };
  }
  return { success: false, reason: 'failed', error: result.error };
}

export function shouldAttemptMobileAppLockAuthentication({
  appState,
  authenticating,
  enabled,
  locked,
  lockNonce,
  promptedNonce,
}: MobileAppLockAuthenticationGateInput): boolean {
  return (
    enabled
    && locked
    && !authenticating
    && appState === 'active'
    && promptedNonce !== lockNonce
  );
}

/**
 * Whether a return to the app may skip the prompt: only when the app was unlocked when it
 * left (`leftUnlockedAt`, null otherwise or on a cold start) and came back within the delay.
 * A clock that moved back reads as a negative time away and asks.
 */
export function isWithinMobileAppLockRelockDelay({
  delayMinutes,
  leftUnlockedAt,
  now,
}: { delayMinutes: number; leftUnlockedAt: number | null; now: number }): boolean {
  if (delayMinutes <= 0 || leftUnlockedAt === null) return false;
  const away = now - leftUnlockedAt;
  return Number.isFinite(away) && away >= 0 && away < delayMinutes * 60_000;
}

export function getMobileAppLockErrorKey(reason: MobileAppLockAuthFailureReason): string {
  if (reason === 'unavailable') return 'appLock.unavailable';
  if (reason === 'cancelled') return 'appLock.cancelled';
  return 'appLock.failed';
}
