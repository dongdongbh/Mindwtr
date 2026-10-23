import type { AndroidInstallerSource } from './about-settings-model';
import {
    ACTIVE_APP_ANNOUNCEMENT,
    DONATION_PROMPT_ANNOUNCEMENT,
    getAnnouncementDismissalStorageKey,
    shouldShowAppAnnouncement,
    type AppAnnouncement,
} from './announcements';
import { shouldOpenMobileFirstRunOnboarding } from './first-run-onboarding';
import { formatI18nTemplate } from './i18n';
import type { StartupPromptDescriptor } from './startup-prompts';
import type { SyncBackend } from './sync-service-utils';
import {
    readLocalUserPromptState,
    recordUpdateReminderChecked,
    recordUpdateReminderShown,
    shouldCheckUpdateReminder,
    shouldShowDonationPrompt,
    shouldShowUpdateReminder,
    updateLocalUserPromptState,
    type UserPromptState,
} from './user-prompts';

// The mobile apps' startup prompts beyond the shared queue (moved from React Native's app/_layout.tsx so the native app shows
// the same prompts on the same rules): which builds may ask for a donation or remind about an update, the delays, and the
// update reminder's GitHub read and text.

export const resolveMobileDonationPromptAllowed = async (options: {
    platform: string;
    isExpoGo: boolean;
    donationPromptEnabled: boolean;
}): Promise<boolean> => {
    if (!options.donationPromptEnabled) return false;
    if (options.isExpoGo) return false;
    return options.platform === 'android' || options.platform === 'ios';
};

export const ANNOUNCEMENT_STARTUP_DELAY_MS = 250;
export const DONATION_PROMPT_STARTUP_DELAY_MS = 2000;
export const UPDATE_REMINDER_STARTUP_DELAY_MS = 1750;
// fetchMobileUpdateReminderInfo is a plain fetch with no timeout; cap present()
// so a hung network never holds the single prompt slot for the whole session.
export const UPDATE_REMINDER_FETCH_TIMEOUT_MS = 15000;
export const UPDATE_REMINDER_RELEASES_API = 'https://api.github.com/repos/dongdongbh/Mindwtr/releases/latest';
export const UPDATE_REMINDER_RELEASES_URL = 'https://github.com/dongdongbh/Mindwtr/releases/latest';
export const UPDATE_NOW_ACTION_LABEL = 'Update now';
export const VIEW_RELEASE_ACTION_LABEL = 'View release';

export type MobileUpdateReminderInfo = {
    currentVersion: string;
    latestVersion: string;
    latestReleasedAt: string | null;
    releaseUrl: string;
    actionLabel?: string;
    testOnly?: boolean;
};

type GitHubLatestRelease = {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
};

type UpdateReminderResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

/** The host's fetch (RN's global fetch; the native app's through its host). */
export type UpdateReminderFetcher = (url: string, init: { headers: Record<string, string> }) => Promise<UpdateReminderResponse>;

export const resolveMobileUpdateReminderAllowed = async (options: {
    platform: string;
    androidInstallerSource: AndroidInstallerSource;
    isExpoGo: boolean;
    isFossBuild: boolean;
}): Promise<boolean> => {
    if (options.isExpoGo) return false;
    if (options.platform !== 'android') return false;
    if (options.isFossBuild) return false;
    return options.androidInstallerSource === 'sideload';
};

export const fetchMobileUpdateReminderInfo = async (
    currentVersion: string,
    fetcher: UpdateReminderFetcher,
    releasesApi: string = UPDATE_REMINDER_RELEASES_API,
): Promise<MobileUpdateReminderInfo> => {
    const response = await fetcher(releasesApi, {
        headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Mindwtr-App',
        },
    });
    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
    }
    const release = await response.json() as GitHubLatestRelease;
    const latestVersion = String(release.tag_name || '').trim().replace(/^v/i, '');
    if (!latestVersion) throw new Error('GitHub release returned no version');
    return {
        currentVersion,
        latestVersion,
        latestReleasedAt: typeof release.published_at === 'string' ? release.published_at : null,
        releaseUrl: typeof release.html_url === 'string' && release.html_url.trim()
            ? release.html_url.trim()
            : UPDATE_REMINDER_RELEASES_URL,
        actionLabel: UPDATE_NOW_ACTION_LABEL,
    };
};

/** The app's words for [key], or the English [fallback] (RN's translateWithFallback; the default keeps English). */
type ResolveText = (key: string, fallback: string) => string;

export const buildUpdateReminderAnnouncement = (
    info: MobileUpdateReminderInfo,
    resolveText: ResolveText = (_key, fallback) => fallback,
): AppAnnouncement => {
    const label = info.actionLabel ?? VIEW_RELEASE_ACTION_LABEL;
    return {
        id: `update-reminder-${info.latestVersion}`,
        title: resolveText('updateReminder.title', 'Update available'),
        body: formatI18nTemplate(
            resolveText('updateReminder.body', 'Mindwtr {{latestVersion}} is available. You are using {{currentVersion}}. Update when you have a minute to keep fixes and improvements current.'),
            { latestVersion: info.latestVersion, currentVersion: info.currentVersion },
        ),
        action: {
            type: 'url',
            label: label === UPDATE_NOW_ACTION_LABEL
                ? resolveText('updateReminder.updateNow', label)
                : label === VIEW_RELEASE_ACTION_LABEL ? resolveText('updateReminder.viewRelease', label) : label,
            url: info.releaseUrl,
        },
    };
};

/** The prompt preview's announcement (RN's prompt test controls, a debug build's preview): the real window, test words. */
export const PROMPT_TEST_ANNOUNCEMENT: AppAnnouncement = {
    id: 'prompt-test-announcement',
    title: 'Test announcement',
    body: 'This is the temporary announcement template test. It uses the same popup surface as a real maintainer announcement.',
};

/** The donation ask in the app language (its words: donationPrompt.*). */
export const translateDonationPromptAnnouncement = (resolveText: ResolveText): AppAnnouncement => ({
    ...DONATION_PROMPT_ANNOUNCEMENT,
    title: resolveText('donationPrompt.title', DONATION_PROMPT_ANNOUNCEMENT.title),
    body: resolveText('donationPrompt.body', DONATION_PROMPT_ANNOUNCEMENT.body),
    dismissLabel: resolveText(
        'donationPrompt.dismiss',
        DONATION_PROMPT_ANNOUNCEMENT.dismissLabel ?? DONATION_PROMPT_ANNOUNCEMENT.title,
    ),
    action: DONATION_PROMPT_ANNOUNCEMENT.action
        ? {
            ...DONATION_PROMPT_ANNOUNCEMENT.action,
            label: resolveText('donationPrompt.action', DONATION_PROMPT_ANNOUNCEMENT.action.label),
        }
        : undefined,
});

export type MobileStartupPromptInput = {
    /** The device's key-value store (RN's AsyncStorage; the native app's RKStorage). */
    storage: {
        getItem: (key: string) => Promise<string | null>;
        setItem: (key: string, value: string) => Promise<void>;
    };
    /** The first paint has data: a backup snapshot, the canonical load, or a failed load's empty store. */
    dataReady: boolean;
    /** The canonical load finished without an error. */
    canonicalDataReady: boolean;
    mobileOnboardingDismissed: boolean;
    visibleDataCount: number;
    /** The sync backend as the app's sync settings read it; a throw counts as off. */
    readSyncBackend: () => Promise<SyncBackend>;
    onSyncBackendReadError: (error: unknown) => void;
    updateReminderAllowed: boolean | null;
    donationPromptAllowed: boolean | null;
    promptStateSnapshot: UserPromptState | null;
    onUpdateCheckRecordError: (error: unknown) => void;
    fetchUpdateInfo: () => Promise<MobileUpdateReminderInfo>;
    onUpdateReminderInfo: (info: MobileUpdateReminderInfo) => void;
    getSupportPrompt: () => Parameters<typeof shouldShowDonationPrompt>[0]['supportPrompt'];
};

/**
 * The mobile apps' four startup prompts for the shared queue (startup-prompts.ts), highest first: first-run onboarding,
 * the maintainer announcement, the update reminder, and the donation ask.
 */
export function buildMobileStartupPromptDescriptors(input: MobileStartupPromptInput): StartupPromptDescriptor[] {
    const {
        storage,
        canonicalDataReady,
        mobileOnboardingDismissed,
        visibleDataCount,
        updateReminderAllowed,
        donationPromptAllowed,
        promptStateSnapshot,
    } = input;
    // Onboarding waits for the canonical load: after a failed load the store is empty though the library may not be, and
    // seeding Getting Started there could duplicate it and would dismiss the welcome sheet for good.
    const dataReady = input.dataReady && canonicalDataReady;
    return [
        {
            // First-run onboarding outranks everything: a brand-new user must not meet
            // an announcement or a donation ask before the welcome flow.
            id: 'onboarding',
            priority: 40,
            delayMs: 0,
            isEligible: () => dataReady && !mobileOnboardingDismissed && visibleDataCount === 0,
            present: async (signal) => {
                let syncBackend: SyncBackend = 'off';
                try {
                    syncBackend = await input.readSyncBackend();
                } catch (error) {
                    input.onSyncBackendReadError(error);
                }
                if (signal.aborted) return false;
                return shouldOpenMobileFirstRunOnboarding({
                    dataReady,
                    dismissed: mobileOnboardingDismissed,
                    syncBackend,
                    visibleDataCount,
                });
            },
        },
        {
            // Maintainer announcement: when one is configured it also blocks the
            // donation and update prompts (see their isEligible).
            id: 'announcement',
            priority: 30,
            delayMs: ANNOUNCEMENT_STARTUP_DELAY_MS,
            isEligible: () => shouldShowAppAnnouncement(ACTIVE_APP_ANNOUNCEMENT, null),
            present: async (signal) => {
                const announcement = ACTIVE_APP_ANNOUNCEMENT;
                if (!shouldShowAppAnnouncement(announcement, null)) return false;
                let dismissedValue: string | null = null;
                try {
                    dismissedValue = await storage.getItem(getAnnouncementDismissalStorageKey(announcement.id));
                } catch {
                    dismissedValue = null;
                }
                if (signal.aborted) return false;
                return shouldShowAppAnnouncement(announcement, dismissedValue);
            },
        },
        {
            // Update reminder: records the check on selection, then confirms an update
            // actually exists before opening (declines otherwise).
            id: 'update-reminder',
            priority: 20,
            delayMs: UPDATE_REMINDER_STARTUP_DELAY_MS,
            presentTimeoutMs: UPDATE_REMINDER_FETCH_TIMEOUT_MS,
            isEligible: () => {
                if (updateReminderAllowed !== true) return false;
                if (ACTIVE_APP_ANNOUNCEMENT) return false;
                if (!promptStateSnapshot) return false;
                return shouldCheckUpdateReminder({
                    nowMs: Date.now(),
                    promptState: promptStateSnapshot,
                    updateReminderAllowed: true,
                });
            },
            onSelect: () => {
                // Safe here and only here: the queue runs onSelect after this descriptor
                // has won the slot, so the once-a-day check is never burned by a prompt
                // that never ran.
                void updateLocalUserPromptState(storage, (state) => recordUpdateReminderChecked(state, Date.now()))
                    .catch(input.onUpdateCheckRecordError);
            },
            present: async (signal) => {
                const info = await input.fetchUpdateInfo();
                if (signal.aborted) return false;
                const latestPromptState = await readLocalUserPromptState(storage);
                if (signal.aborted) return false;
                if (!shouldShowUpdateReminder({
                    nowMs: Date.now(),
                    promptState: latestPromptState,
                    updateReminderAllowed: true,
                    currentVersion: info.currentVersion,
                    latestVersion: info.latestVersion,
                    latestReleasedAt: info.latestReleasedAt,
                })) {
                    return false;
                }
                await updateLocalUserPromptState(storage, (state) => recordUpdateReminderShown(state, Date.now()));
                if (signal.aborted) return false;
                input.onUpdateReminderInfo(info);
                return true;
            },
        },
        {
            // Donation ask: lowest precedence; suppressed whenever an announcement is
            // configured or an update reminder is showing (via the queue).
            id: 'donation',
            priority: 10,
            delayMs: DONATION_PROMPT_STARTUP_DELAY_MS,
            isEligible: () => {
                if (donationPromptAllowed !== true) return false;
                if (ACTIVE_APP_ANNOUNCEMENT) return false;
                if (!promptStateSnapshot) return false;
                return shouldShowDonationPrompt({
                    nowMs: Date.now(),
                    promptState: promptStateSnapshot,
                    supportPrompt: input.getSupportPrompt(),
                    donationAllowed: true,
                });
            },
            present: () => true,
        },
    ];
}
