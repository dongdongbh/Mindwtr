import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEnrolledLevelAsyncMock = vi.hoisted(() => vi.fn());
const authenticateAsyncMock = vi.hoisted(() => vi.fn());

vi.mock('expo-local-authentication', () => ({
  SecurityLevel: {
    NONE: 0,
    SECRET: 1,
    BIOMETRIC_WEAK: 2,
    BIOMETRIC_STRONG: 3,
  },
  getEnrolledLevelAsync: getEnrolledLevelAsyncMock,
  authenticateAsync: authenticateAsyncMock,
}));

import {
  authenticateWithDeviceLock,
  getMobileAppLockErrorKey,
  isWithinMobileAppLockRelockDelay,
  shouldAttemptMobileAppLockAuthentication,
} from './mobile-app-lock';

describe('mobile app lock authentication', () => {
  beforeEach(() => {
    getEnrolledLevelAsyncMock.mockReset();
    authenticateAsyncMock.mockReset();
  });

  it('does not prompt when no device authentication is enrolled', async () => {
    getEnrolledLevelAsyncMock.mockResolvedValue(0);

    const result = await authenticateWithDeviceLock({
      promptMessage: 'Unlock Mindwtr',
      cancelLabel: 'Cancel',
      fallbackLabel: 'Use passcode',
    });

    expect(result).toEqual({ success: false, reason: 'unavailable' });
    expect(authenticateAsyncMock).not.toHaveBeenCalled();
  });

  it('authenticates with OS device fallback enabled', async () => {
    getEnrolledLevelAsyncMock.mockResolvedValue(2);
    authenticateAsyncMock.mockResolvedValue({ success: true });

    const result = await authenticateWithDeviceLock({
      promptMessage: 'Unlock Mindwtr',
      cancelLabel: 'Cancel',
      fallbackLabel: 'Use passcode',
    });

    expect(result).toEqual({ success: true });
    expect(authenticateAsyncMock).toHaveBeenCalledWith({
      promptMessage: 'Unlock Mindwtr',
      cancelLabel: 'Cancel',
      fallbackLabel: 'Use passcode',
      disableDeviceFallback: false,
      biometricsSecurityLevel: 'weak',
      requireConfirmation: true,
    });
  });

  it('maps user cancellation separately from failed authentication', async () => {
    getEnrolledLevelAsyncMock.mockResolvedValue(3);
    authenticateAsyncMock.mockResolvedValue({ success: false, error: 'user_cancel' });

    const result = await authenticateWithDeviceLock({
      promptMessage: 'Unlock Mindwtr',
      cancelLabel: 'Cancel',
      fallbackLabel: 'Use passcode',
    });

    expect(result).toEqual({ success: false, reason: 'cancelled', error: 'user_cancel' });
    expect(getMobileAppLockErrorKey(result.success ? 'failed' : result.reason)).toBe('appLock.cancelled');
  });

  it('only auto-prompts the lock while the app is active', () => {
    expect(shouldAttemptMobileAppLockAuthentication({
      appState: 'background',
      authenticating: false,
      enabled: true,
      locked: true,
      lockNonce: 1,
      promptedNonce: 0,
    })).toBe(false);

    expect(shouldAttemptMobileAppLockAuthentication({
      appState: 'inactive',
      authenticating: false,
      enabled: true,
      locked: true,
      lockNonce: 1,
      promptedNonce: 0,
    })).toBe(false);

    expect(shouldAttemptMobileAppLockAuthentication({
      appState: 'active',
      authenticating: false,
      enabled: true,
      locked: true,
      lockNonce: 1,
      promptedNonce: 0,
    })).toBe(true);
  });

  it('does not auto-prompt while unlocked, already authenticating, or already prompted for that lock', () => {
    expect(shouldAttemptMobileAppLockAuthentication({
      appState: 'active',
      authenticating: false,
      enabled: false,
      locked: true,
      lockNonce: 1,
      promptedNonce: 0,
    })).toBe(false);

    expect(shouldAttemptMobileAppLockAuthentication({
      appState: 'active',
      authenticating: false,
      enabled: true,
      locked: false,
      lockNonce: 1,
      promptedNonce: 0,
    })).toBe(false);

    expect(shouldAttemptMobileAppLockAuthentication({
      appState: 'active',
      authenticating: true,
      enabled: true,
      locked: true,
      lockNonce: 1,
      promptedNonce: 0,
    })).toBe(false);

    expect(shouldAttemptMobileAppLockAuthentication({
      appState: 'active',
      authenticating: false,
      enabled: true,
      locked: true,
      lockNonce: 1,
      promptedNonce: 1,
    })).toBe(false);
  });

  it('skips the prompt only within the relock delay after leaving unlocked (#1423)', () => {
    const leftUnlockedAt = 1_000_000;
    const at = (delayMinutes: number, awayMs: number, left: number | null = leftUnlockedAt) => (
      isWithinMobileAppLockRelockDelay({ delayMinutes, leftUnlockedAt: left, now: leftUnlockedAt + awayMs })
    );
    expect(at(1, 59_999)).toBe(true);
    expect(at(5, 4 * 60_000)).toBe(true);
    expect(at(1, 60_000)).toBe(false);
    expect(at(15, 16 * 60_000)).toBe(false);
    // Immediately, a cold start or a lock left locked, and a clock moved back all ask.
    expect(at(0, 0)).toBe(false);
    expect(at(15, 1_000, null)).toBe(false);
    expect(at(15, -1)).toBe(false);
    expect(at(15, Number.NaN)).toBe(false);
  });
});
