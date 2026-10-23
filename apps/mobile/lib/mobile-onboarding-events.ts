import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  readMobileOnboardingDismissed as readCoreMobileOnboardingDismissed,
  writeMobileOnboardingDismissed as writeCoreMobileOnboardingDismissed,
} from '@mindwtr/core';

// When the welcome sheet opens and its dismissal live in core (first-run-onboarding.ts), so the native app follows the
// same rule under the same key; this app binds them to AsyncStorage and keeps the manual-trigger events.
export { MOBILE_ONBOARDING_STORAGE_KEY, shouldOpenMobileFirstRunOnboarding } from '@mindwtr/core';

const listeners = new Set<() => void>();

export function dispatchMobileOnboardingEvent(): void {
  Array.from(listeners).forEach((listener) => listener());
}

export function subscribeMobileOnboardingEvent(handler: () => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

export function readMobileOnboardingDismissed(): Promise<boolean> {
  return readCoreMobileOnboardingDismissed(AsyncStorage);
}

export function writeMobileOnboardingDismissed(): Promise<void> {
  return writeCoreMobileOnboardingDismissed(AsyncStorage);
}
