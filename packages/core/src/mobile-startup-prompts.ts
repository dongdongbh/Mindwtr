import type { AndroidInstallerSource } from './about-settings-model';
import type { AppAnnouncement } from './announcements';

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

export const buildUpdateReminderAnnouncement = (info: MobileUpdateReminderInfo): AppAnnouncement => ({
    id: `update-reminder-${info.latestVersion}`,
    title: 'Update available',
    body: `Mindwtr ${info.latestVersion} is available. You are using ${info.currentVersion}. Update when you have a minute to keep fixes and improvements current.`,
    action: {
        type: 'url',
        label: info.actionLabel ?? VIEW_RELEASE_ACTION_LABEL,
        url: info.releaseUrl,
    },
});
