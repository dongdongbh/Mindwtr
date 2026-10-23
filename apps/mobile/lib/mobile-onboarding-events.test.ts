import { beforeEach, describe, expect, it, vi } from 'vitest';

const asyncStorageGetItem = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const asyncStorageSetItem = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: asyncStorageGetItem,
    setItem: asyncStorageSetItem,
  },
}));

import {
  MOBILE_ONBOARDING_STORAGE_KEY,
  dispatchMobileOnboardingEvent,
  readMobileOnboardingDismissed,
  subscribeMobileOnboardingEvent,
  writeMobileOnboardingDismissed,
} from './mobile-onboarding-events';

describe('mobile onboarding events', () => {
  beforeEach(() => {
    asyncStorageGetItem.mockReset();
    asyncStorageSetItem.mockReset();
    asyncStorageGetItem.mockResolvedValue(null);
    asyncStorageSetItem.mockResolvedValue(undefined);
  });

  it('dispatches manual trigger events until unsubscribed', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeMobileOnboardingEvent(handler);

    dispatchMobileOnboardingEvent();
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    dispatchMobileOnboardingEvent();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // The gate itself is core's (first-run-onboarding.test.ts); this pins the AsyncStorage binding under RN's key.
  it('stores dismissal state locally', async () => {
    asyncStorageGetItem.mockResolvedValueOnce('dismissed');

    await expect(readMobileOnboardingDismissed()).resolves.toBe(true);
    await writeMobileOnboardingDismissed();

    expect(asyncStorageGetItem).toHaveBeenCalledWith(MOBILE_ONBOARDING_STORAGE_KEY);
    expect(asyncStorageSetItem).toHaveBeenCalledWith(MOBILE_ONBOARDING_STORAGE_KEY, 'dismissed');
  });
});
