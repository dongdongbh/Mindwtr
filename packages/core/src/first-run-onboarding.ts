import type { SyncBackend } from './sync-service-utils';


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

    }
}
