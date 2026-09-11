import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkspaceCache } from './workspace-cache';
import {
    dismissDesktopOnboardingHint,
    isDesktopOnboardingHintDismissed,
    shouldShowInboxProjectHint,
    shouldOpenDesktopFirstRunOnboarding,
} from './desktop-onboarding-events';

const sandboxState = vi.hoisted(() => ({ enabled: false }));
vi.mock('@mindwtr/core', () => ({ isSandboxMode: () => sandboxState.enabled }));

describe('desktop onboarding events', () => {
    beforeEach(() => {
        sandboxState.enabled = true;
        getWorkspaceCache()?.clear();
        sandboxState.enabled = false;
        window.localStorage.clear();
    });

    it('opens automatically on a fresh install with empty local data and sync off', () => {
        expect(shouldOpenDesktopFirstRunOnboarding({
            hasHydratedSettings: true,
            isLoading: false,
            dismissed: false,
            visibleDataCount: 0,
            syncBackend: 'off',
        })).toBe(true);
    });

    it('does not reopen after the user dismisses it', () => {
        expect(shouldOpenDesktopFirstRunOnboarding({
            hasHydratedSettings: true,
            isLoading: false,
            dismissed: true,
            visibleDataCount: 0,
            syncBackend: 'off',
        })).toBe(false);
    });

    it('does not interrupt existing data or configured sync', () => {
        expect(shouldOpenDesktopFirstRunOnboarding({
            hasHydratedSettings: true,
            isLoading: false,
            dismissed: false,
            visibleDataCount: 1,
            syncBackend: 'off',
        })).toBe(false);

        expect(shouldOpenDesktopFirstRunOnboarding({
            hasHydratedSettings: true,
            isLoading: false,
            dismissed: false,
            visibleDataCount: 0,
            syncBackend: 'webdav',
        })).toBe(false);
    });

    it('stores onboarding handoff hint dismissals per page in local storage', () => {
        expect(isDesktopOnboardingHintDismissed('sync')).toBe(false);
        expect(isDesktopOnboardingHintDismissed('data')).toBe(false);

        dismissDesktopOnboardingHint('sync');

        expect(isDesktopOnboardingHintDismissed('sync')).toBe(true);
        expect(isDesktopOnboardingHintDismissed('data')).toBe(false);
    });

    it('keeps sandbox learning hints separate from personal dismissals', () => {
        dismissDesktopOnboardingHint('data');
        const before = JSON.stringify(window.localStorage);
        sandboxState.enabled = true;
        expect(isDesktopOnboardingHintDismissed('data')).toBe(false);
        dismissDesktopOnboardingHint('inbox-project');
        expect(isDesktopOnboardingHintDismissed('inbox-project')).toBe(true);
        expect(JSON.stringify(window.localStorage)).toBe(before);
        sandboxState.enabled = false;
        expect(isDesktopOnboardingHintDismissed('data')).toBe(true);
        expect(isDesktopOnboardingHintDismissed('inbox-project')).toBe(false);
    });

    it('keeps the inbox project hint dismissal separate from the settings handoff hints', () => {
        dismissDesktopOnboardingHint('inbox-project');

        expect(isDesktopOnboardingHintDismissed('inbox-project')).toBe(true);
        expect(isDesktopOnboardingHintDismissed('sync')).toBe(false);
    });

    it('uses explicit learning or dismissal, not the existence of seeded or imported projects', () => {
        expect(shouldShowInboxProjectHint(false)).toBe(true);
        expect(shouldShowInboxProjectHint(true)).toBe(false);
    });
});
