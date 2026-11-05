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


export const PROMPT_TEST_ANNOUNCEMENT: AppAnnouncement = {
    id: 'prompt-test-announcement',
    title: 'Test announcement',
    body: 'This is the temporary announcement template test. It uses the same popup surface as a real maintainer announcement.',
};


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

    storage: {
        getItem: (key: string) => Promise<string | null>;
        setItem: (key: string, value: string) => Promise<void>;
    };

    dataReady: boolean;

    canonicalDataReady: boolean;
    mobileOnboardingDismissed: boolean;
    visibleDataCount: number;

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


    const dataReady = input.dataReady && canonicalDataReady;
    return [
        {


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
