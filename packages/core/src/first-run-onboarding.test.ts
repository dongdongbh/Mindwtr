import { describe, expect, it, vi } from 'vitest';

import {
    MOBILE_ONBOARDING_STORAGE_KEY,
    readMobileOnboardingDismissed,
    shouldOpenMobileFirstRunOnboarding,
    writeMobileOnboardingDismissed,
} from './first-run-onboarding';

const storage = (stored: string | null = null) => ({
    getItem: vi.fn(async () => stored),
    setItem: vi.fn(async () => undefined),
});

describe('first-run onboarding', () => {
    it('opens first-run onboarding only for empty local installs with sync off', () => {
        expect(shouldOpenMobileFirstRunOnboarding({ dataReady: true, dismissed: false, syncBackend: 'off', visibleDataCount: 0 })).toBe(true);
        expect(shouldOpenMobileFirstRunOnboarding({ dataReady: false, dismissed: false, syncBackend: 'off', visibleDataCount: 0 })).toBe(false);
        expect(shouldOpenMobileFirstRunOnboarding({ dataReady: true, dismissed: true, syncBackend: 'off', visibleDataCount: 0 })).toBe(false);
        expect(shouldOpenMobileFirstRunOnboarding({ dataReady: true, dismissed: false, syncBackend: 'cloudkit', visibleDataCount: 0 })).toBe(false);
        expect(shouldOpenMobileFirstRunOnboarding({ dataReady: true, dismissed: false, syncBackend: 'off', visibleDataCount: 1 })).toBe(false);
    });

    it('stores dismissal state locally under RN key', async () => {
        const store = storage('dismissed');
        await expect(readMobileOnboardingDismissed(store)).resolves.toBe(true);
        await writeMobileOnboardingDismissed(store);
        expect(MOBILE_ONBOARDING_STORAGE_KEY).toBe('mindwtr:mobile:first-run-onboarding:v1');
        expect(store.getItem).toHaveBeenCalledWith(MOBILE_ONBOARDING_STORAGE_KEY);
        expect(store.setItem).toHaveBeenCalledWith(MOBILE_ONBOARDING_STORAGE_KEY, 'dismissed');
    });

    it('reads a missing or other value as not dismissed', async () => {
        await expect(readMobileOnboardingDismissed(storage())).resolves.toBe(false);
        await expect(readMobileOnboardingDismissed(storage('later'))).resolves.toBe(false);
    });

    it('never lets a storage failure block the app', async () => {
        const failing = {
            getItem: vi.fn(async () => { throw new Error('read failed'); }),
            setItem: vi.fn(async () => { throw new Error('write failed'); }),
        };
        await expect(readMobileOnboardingDismissed(failing)).resolves.toBe(false);
        await expect(writeMobileOnboardingDismissed(failing)).resolves.toBeUndefined();
    });
});
