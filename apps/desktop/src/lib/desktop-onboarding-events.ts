import type { OnboardingTopic, SyncBackend } from '@mindwtr/core';
import { getWorkspaceCache } from './workspace-cache';

export const MINDWTR_DESKTOP_ONBOARDING_EVENT = 'mindwtr:desktop-onboarding';
const DESKTOP_ONBOARDING_HANDOFF_HINT_KEY_PREFIX = 'mindwtr:desktop:onboarding-handoff-hint:v1:';

export type DesktopOnboardingHandoffPage = 'sync' | 'data';


export type DesktopOnboardingHint = DesktopOnboardingHandoffPage | OnboardingTopic;

type DesktopFirstRunOnboardingState = {
    hasHydratedSettings: boolean;
    isLoading: boolean;
    dismissed: boolean;
    visibleDataCount: number;
    syncBackend: SyncBackend;
};

export function shouldOpenDesktopFirstRunOnboarding({
    hasHydratedSettings,
    isLoading,
    dismissed,
    visibleDataCount,
    syncBackend,
}: DesktopFirstRunOnboardingState): boolean {
    return hasHydratedSettings
        && !isLoading
        && !dismissed
        && visibleDataCount === 0
        && syncBackend === 'off';
}

export function dispatchDesktopOnboardingEvent(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(MINDWTR_DESKTOP_ONBOARDING_EVENT));
}

export function subscribeDesktopOnboardingEvent(handler: () => void): () => void {
    if (typeof window === 'undefined') {
        return () => undefined;
    }

    const listener: EventListener = () => handler();
    window.addEventListener(MINDWTR_DESKTOP_ONBOARDING_EVENT, listener);
    return () => window.removeEventListener(MINDWTR_DESKTOP_ONBOARDING_EVENT, listener);
}

function getDesktopOnboardingHintKey(hint: DesktopOnboardingHint): string {
    return `${DESKTOP_ONBOARDING_HANDOFF_HINT_KEY_PREFIX}${hint}`;
}

export function isDesktopOnboardingHintDismissed(hint: DesktopOnboardingHint): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return getWorkspaceCache()?.getItem(getDesktopOnboardingHintKey(hint)) === 'dismissed';
    } catch {
        return false;
    }
}


export function shouldShowInboxProjectHint(dismissed: boolean): boolean {
    return !dismissed;
}

export function dismissDesktopOnboardingHint(hint: DesktopOnboardingHint): void {
    if (typeof window === 'undefined') return;
    try {
        getWorkspaceCache()?.setItem(getDesktopOnboardingHintKey(hint), 'dismissed');
    } catch {

    }
}
