import type { SyncBackend } from './sync-service-utils';

// The mobile apps' first-run welcome sheet (moved from React Native's lib/mobile-onboarding-events.ts so the native app opens
// it the same way): when it opens, and its dismissal. Device-local, stored by each app in its key-value store under RN's key,
// so an upgraded RN install never sees it again; never synced.

export const MOBILE_ONBOARDING_STORAGE_KEY = 'mindwtr:mobile:first-run-onboarding:v1';

type MobileFirstRunOnboardingState = {
    dataReady: boolean;
    dismissed: boolean;
    syncBackend: SyncBackend;
    visibleDataCount: number;
};

type OnboardingStorage = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
};

export function shouldOpenMobileFirstRunOnboarding({
    dataReady,
    dismissed,
    syncBackend,
    visibleDataCount,
}: MobileFirstRunOnboardingState): boolean {
    return dataReady
        && !dismissed
        && visibleDataCount === 0
        && syncBackend === 'off';
}

export async function readMobileOnboardingDismissed(storage: OnboardingStorage): Promise<boolean> {
    try {
        return await storage.getItem(MOBILE_ONBOARDING_STORAGE_KEY) === 'dismissed';
    } catch {
        return false;
    }
}

export async function writeMobileOnboardingDismissed(storage: OnboardingStorage): Promise<void> {
    try {
        await storage.setItem(MOBILE_ONBOARDING_STORAGE_KEY, 'dismissed');
    } catch {
        // Onboarding is convenience UI; storage failures should not block the app.
    }
}
