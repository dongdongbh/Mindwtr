import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';
import type { OnboardingTopic } from '@mindwtr/core';

const prefix = 'mindwtr:mobile:onboarding-hint:v1:';
const dismissedThisSession = new Set<OnboardingTopic>();

export async function isMobileHintDismissed(topic: OnboardingTopic): Promise<boolean> {
    if (dismissedThisSession.has(topic)) return true;
    try {
        const value = await AsyncStorage.getItem(prefix + topic);
        // A pending read must never undo a newer dismissal.
        return dismissedThisSession.has(topic) || value === 'dismissed';
    } catch {
        return dismissedThisSession.has(topic);
    }
}

export async function dismissMobileHint(topic: OnboardingTopic): Promise<void> {
    dismissedThisSession.add(topic);
    try {
        await AsyncStorage.setItem(prefix + topic, 'dismissed');
    } catch {
        // Optional guidance never blocks navigation or task edits.
    }
}
