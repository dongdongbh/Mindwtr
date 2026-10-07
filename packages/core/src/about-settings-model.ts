/**
 * Settings › About as React Native draws and runs it (apps/mobile/components/settings/about-settings-screen.tsx and
 * feedback-settings-modal.tsx): the header and its rows, the silent update check when the screen opens and the manual one
 * behind Check for updates (Google Play's update answer, GitHub's latest release, the App Store lookup on iOS), the update dot
 * under RN's AsyncStorage keys, the Rate row, and the feedback modal's rules and submission. Shared by RN and the native host
 * contract (native-host-contract-about.ts); each host brings its device (storage, fetch, links, alerts and toasts). The update dot's
 * keys, the version order and the App Store lookup are app-store-update.ts's (the iOS host's too).
 */
import {
    compareAppVersions as compareVersions,
    fetchAppStoreInfo,
    shouldCheckForAppUpdate,
    UPDATE_BADGE_AVAILABLE_KEY,
    UPDATE_BADGE_LAST_CHECK_KEY,
    UPDATE_BADGE_LATEST_KEY,
} from './app-store-update';
import { isValidFeedbackEmail, type FeedbackCategory, type FeedbackSubmissionInput } from './feedback';

/** RN's settings `tr`: a key's text (English when the language lacks it), with template values filled. */
export type AboutTranslate = (key: string, values?: Record<string, string>) => string;

export const ABOUT_GITHUB_ISSUES_URL = 'https://github.com/dongdongbh/Mindwtr/issues/new/choose';
export const ABOUT_GITHUB_DISCUSSIONS_URL = 'https://github.com/dongdongbh/Mindwtr/discussions/new';
export const ABOUT_GITHUB_RELEASES_API = 'https://api.github.com/repos/dongdongbh/Mindwtr/releases/latest';
export const ABOUT_GITHUB_RELEASES_URL = 'https://github.com/dongdongbh/Mindwtr/releases/latest';
export const ABOUT_LINKS = {
    website: 'https://mindwtr.app',
    tutorials: 'https://youtube.com/playlist?list=PLLwV6zeTfB_k',
    privacy: 'https://mindwtr.app/privacy',
    terms: 'https://mindwtr.app/terms',
    sponsor: 'https://mindwtr.app/donate?src=app_about',
} as const;
export const ABOUT_LICENSE = 'AGPL-3.0';

/** How the Android app was installed, as RN reads it: the Play install referrer is non-empty for a Play install. */
export type AndroidInstallerSource = 'play-store' | 'sideload' | 'unknown';

/** RN's reading of expo-application's getInstallReferrerAsync answer (a rejected call reads as 'unknown'). */
export const resolveAndroidInstallerSource = (referrer: string | null | undefined): AndroidInstallerSource => {
    const normalized = (referrer || '').trim().toLowerCase();
    return normalized ? 'play-store' : 'sideload';
};

/** The feedback's installChannel. */
export const getAboutInstallChannel = (input: { isFossBuild: boolean; platform: string; androidInstallerSource: AndroidInstallerSource }): string => {
    if (input.isFossBuild) return 'fdroid';
    if (input.platform === 'ios') return 'app-store';
    if (input.platform === 'android') return input.androidInstallerSource;
    return input.platform || 'mobile';
};

export type AboutRowId = 'checkForUpdates' | 'rate' | 'feedback' | 'website' | 'tutorials' | 'privacy' | 'terms' | 'sponsor' | 'license';

/** One About row: its label and the text at its right (`link` rows draw it in RN's link blue and are pressable). */
export type AboutRow = { id: AboutRowId; label: string; value: string; tone: 'link' | 'value'; url: string | null };

export type AboutSettingsModel = {
    title: string;
    appName: string;
    /** `v` and the display version, under the name. */
    versionText: string;
    rows: AboutRow[];
};

/**
 * RN's About card: the header, Check for updates (not in a FOSS build), Rate (Android and iOS store builds), Send feedback, the
 * four links, Sponsor and the license. `t` is RN's language `t`, `tr` its settings `tr`; each row uses the one RN's does.
 */
export function buildAboutSettingsModel(input: {
    t: (key: string) => string;
    tr: AboutTranslate;
    appName: string;
    displayVersion: string;
    isFossBuild: boolean;
    platform: string;
}): AboutSettingsModel {
    const { t, tr } = input;
    const canRateInStore = !input.isFossBuild && (input.platform === 'android' || input.platform === 'ios');
    const link = (id: AboutRowId, label: string, value: string, url: string | null): AboutRow => ({ id, label, value, tone: 'link', url });
    return {
        title: t('settings.about'),
        appName: input.appName,
        versionText: `v${input.displayVersion}`,
        rows: [
            ...(!input.isFossBuild ? [link('checkForUpdates', t('settings.checkForUpdates'), tr('settings.aboutMobile.tapToCheck'), null)] : []),
            ...(canRateInStore ? [link('rate', tr('settings.aboutMobile.rateOurApp'), input.platform === 'ios' ? 'App Store' : 'Google Play', null)] : []),
            link('feedback', tr('settings.feedback'), tr('settings.feedbackSubmit'), null),
            link('website', t('settings.officialWebsite'), 'Mindwtr', ABOUT_LINKS.website),
            link('tutorials', t('settings.videoTutorials'), 'YouTube', ABOUT_LINKS.tutorials),
            link('privacy', t('settings.privacy'), t('settings.privacy'), ABOUT_LINKS.privacy),
            link('terms', t('settings.terms'), t('settings.terms'), ABOUT_LINKS.terms),
            link('sponsor', t('settings.sponsorProject'), tr('settings.donateLinkValue'), ABOUT_LINKS.sponsor),
            { id: 'license', label: t('settings.license'), value: ABOUT_LICENSE, tone: 'value', url: null },
        ],
    };
}

/** Google Play's in-app update answer, as RN's PlayStoreUpdates module gives it (the fields RN reads). */
export type PlayStoreUpdateAnswer = { updateAvailable: boolean; availableVersionCode: number | null };

type AboutResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

export type AboutToast = { title: string; message: string; tone: 'info' | 'success' | 'warning'; durationMs?: number };
/** An alert's button: `url` is the link it opens; a `cancel` button only closes. */
export type AboutAlertButton = { text: string; style?: 'cancel'; url?: string };

/** The host's device for the update checks and the Rate row. */
export type AboutUpdateDevice = {
    platform: string;
    isFossBuild: boolean;
    isExpoGo: boolean;
    /** The app's version (app.json) and the one shown (resolveMobileAnalyticsVersion: an RC tag when it extends it). */
    currentVersion: string;
    displayVersion: string;
    androidInstallerSource: AndroidInstallerSource;
    androidPackageName: string;
    iosBundleId: string;
    storage: {
        getItem: (key: string) => Promise<string | null>;
        setItem: (key: string, value: string) => Promise<void>;
        removeItem: (key: string) => Promise<void>;
    };
    fetcher: (url: string, init: { headers: Record<string, string>; cache?: 'no-store' }) => Promise<AboutResponse>;
    getPlayStoreUpdateInfo: () => Promise<PlayStoreUpdateAnswer>;
    canOpenURL: (url: string) => Promise<boolean>;
    openURL: (url: string) => Promise<unknown>;
    onUpdateBadgeChange: (next: boolean) => void;
    showToast: (toast: AboutToast) => void;
    showAlert: (title: string, message: string, buttons: AboutAlertButton[]) => void;
    tr: AboutTranslate;
    logWarn: (message: string, error: unknown) => void;
    logError: (message: string, error: unknown) => void;
    now?: () => number;
    /** GitHub's latest-release API (a device check points it at a local stub). */
    githubReleasesApi?: string;
};

type AndroidComparableVersionResult =
    | { source: 'play-store'; updateAvailable: boolean; availableVersionCode: number | null }
    | { source: 'github-release'; version: string };

type GithubRelease = { tag_name?: string; html_url?: string; body?: string };

/** RN's update checks and Rate row on [device]: the silent check when About opens, Check for updates, and Rate our app. */
export function createAboutUpdateChecks(device: AboutUpdateDevice) {
    const { tr, storage } = device;
    const now = device.now ?? Date.now;
    const currentVersion = device.currentVersion;
    const displayVersion = device.displayVersion;
    const githubReleasesApi = device.githubReleasesApi ?? ABOUT_GITHUB_RELEASES_API;
    const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${device.androidPackageName}`;
    const PLAY_STORE_MARKET_URL = `market://details?id=${device.androidPackageName}`;

    const persistUpdateBadge = async (next: boolean, latestVersion?: string) => {
        device.onUpdateBadgeChange(next);
        try {
            await storage.setItem(UPDATE_BADGE_AVAILABLE_KEY, next ? 'true' : 'false');
            if (next && latestVersion) {
                await storage.setItem(UPDATE_BADGE_LATEST_KEY, latestVersion);
            } else {
                await storage.removeItem(UPDATE_BADGE_LATEST_KEY);
            }
        } catch (error) {
            device.logWarn('Failed to persist update badge state', error);
        }
    };

    const fetchLatestRelease = async (): Promise<GithubRelease> => {
        const response = await device.fetcher(githubReleasesApi, {
            headers: {
                Accept: 'application/vnd.github.v3+json',
                'User-Agent': 'Mindwtr-App',
            },
        });
        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status}`);
        }
        return response.json() as Promise<GithubRelease>;
    };

    // The App Store lookup (app-store-update.ts) through the host's fetch.
    const fetchLatestAppStoreInfo = () => fetchAppStoreInfo(device.iosBundleId, device.fetcher as unknown as typeof globalThis.fetch);

    const fetchAndroidComparableVersion = async (): Promise<AndroidComparableVersionResult> => {
        if (device.androidInstallerSource === 'sideload') {
            const release = await fetchLatestRelease();
            return { version: release.tag_name?.replace(/^v/, '') || '0.0.0', source: 'github-release' };
        }
        try {
            const info = await device.getPlayStoreUpdateInfo();
            return {
                source: 'play-store',
                updateAvailable: info.updateAvailable,
                availableVersionCode: info.availableVersionCode,
            };
        } catch (error) {
            device.logWarn('Play Store update API failed; falling back to GitHub release', error);
            const release = await fetchLatestRelease();
            return { version: release.tag_name?.replace(/^v/, '') || '0.0.0', source: 'github-release' };
        }
    };

    const fetchLatestComparableVersion = async (): Promise<{ version: string; source: 'app-store' | 'github-release' }> => {
        if (device.platform === 'ios') {
            const { version } = await fetchLatestAppStoreInfo();
            return { version, source: 'app-store' };
        }
        const release = await fetchLatestRelease();
        return { version: release.tag_name?.replace(/^v/, '') || '0.0.0', source: 'github-release' };
    };

    return {
        /**
         * The check when About opens: at most once a day it asks the channel (Play or GitHub) and stores the dot; within the day
         * it reports the stored dot. Silent: a failure is only logged. `cancelled` ends it once the screen closed.
         */
        async runSilentCheck(cancelled: () => boolean = () => false): Promise<void> {
            if (device.isExpoGo || device.isFossBuild) return;
            try {
                const lastCheckedRaw = await storage.getItem(UPDATE_BADGE_LAST_CHECK_KEY);
                if (!shouldCheckForAppUpdate(lastCheckedRaw, now())) {
                    const storedBadge = await storage.getItem(UPDATE_BADGE_AVAILABLE_KEY);
                    if (!cancelled()) device.onUpdateBadgeChange(storedBadge === 'true');
                    return;
                }
                const comparable = device.platform === 'android'
                    ? await fetchAndroidComparableVersion()
                    : await fetchLatestComparableVersion();
                if (cancelled()) return;
                const hasUpdate = comparable.source === 'play-store'
                    ? comparable.updateAvailable
                    : compareVersions(comparable.version, currentVersion) > 0;
                await storage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(now()));
                await persistUpdateBadge(
                    hasUpdate,
                    hasUpdate && comparable.source !== 'play-store' ? comparable.version : undefined
                );
            } catch (error) {
                device.logWarn('Silent update check failed', error);
            }
        },

        /** Check for updates: the channel's answer as RN's alert (an update) or toast, and the dot stored. */
        async runManualCheck(): Promise<void> {
            if (device.isFossBuild) {
                device.showToast({
                    title: tr('settings.aboutMobile.updatesAreManagedByYourDistributionSource'),
                    message: tr('settings.aboutMobile.inAppUpdateChecksAreDisabledInThisFossBuild'),
                    tone: 'info',
                    durationMs: 4800,
                });
                return;
            }

            try {
                await storage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(now()));

                if (device.platform === 'android' && device.androidInstallerSource !== 'sideload') {
                    const canOpenMarket = await device.canOpenURL(PLAY_STORE_MARKET_URL);
                    const targetUrl = canOpenMarket ? PLAY_STORE_MARKET_URL : PLAY_STORE_URL;
                    const result = await fetchAndroidComparableVersion();
                    const hasUpdate = result.source === 'play-store'
                        ? result.updateAvailable
                        : compareVersions(result.version, currentVersion) > 0;
                    if (hasUpdate) {
                        const updateMessage = result.source === 'play-store'
                            ? tr('settings.aboutMobile.updateIsAvailableOnGooglePlayOpenAppListingNow')
                            : tr('settings.aboutMobile.googlePlayUpdateAvailableWithVersions', { currentVersion: displayVersion, latestVersion: result.version });
                        device.showAlert(tr('settings.updateAvailable'), updateMessage, [
                            { text: tr('settings.later'), style: 'cancel' },
                            { text: tr('attachments.open'), url: targetUrl },
                        ]);
                        await persistUpdateBadge(true, result.source === 'github-release' ? result.version : undefined);
                    } else {
                        const upToDateMessage = result.source === 'play-store'
                            ? tr('settings.aboutMobile.youAreUsingTheLatestGooglePlayVersion')
                            : tr('settings.aboutMobile.googlePlayCheckWasUnavailableButYourVersionMatchesThe');
                        device.showToast({
                            title: tr('settings.aboutMobile.upToDate'),
                            message: upToDateMessage,
                            tone: 'success',
                        });
                        await persistUpdateBadge(false);
                    }
                    return;
                }

                if (device.platform === 'ios') {
                    const { version: latestVersion, trackViewUrl } = await fetchLatestAppStoreInfo();
                    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
                    const trackIdMatch = trackViewUrl?.match(/\/id(\d+)/i);
                    const appStoreDeepLink = trackIdMatch?.[1] ? `itms-apps://apps.apple.com/app/id${trackIdMatch[1]}` : null;
                    const canOpenDeepLink = appStoreDeepLink ? await device.canOpenURL(appStoreDeepLink) : false;
                    const targetUrl = canOpenDeepLink ? appStoreDeepLink : trackViewUrl;

                    if (hasUpdate) {
                        device.showAlert(
                            tr('settings.updateAvailable'),
                            tr('settings.aboutMobile.appStoreUpdateAvailableWithVersions', { currentVersion: displayVersion, latestVersion }),
                            [
                                { text: tr('settings.later'), style: 'cancel' },
                                ...(targetUrl ? [{ text: tr('attachments.open'), url: targetUrl }] : []),
                            ]
                        );
                        await persistUpdateBadge(true, latestVersion);
                    } else {
                        device.showToast({
                            title: tr('settings.aboutMobile.upToDate'),
                            message: tr('settings.aboutMobile.youAreUsingTheLatestAppStoreVersion'),
                            tone: 'success',
                        });
                        await persistUpdateBadge(false);
                    }
                    return;
                }

                const release = await fetchLatestRelease();
                const latestVersion = release.tag_name?.replace(/^v/, '') || '0.0.0';
                const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

                if (hasUpdate) {
                    const downloadUrl = release.html_url || ABOUT_GITHUB_RELEASES_URL;
                    const changelog = release.body || tr('settings.noChangelog');
                    device.showAlert(
                        tr('settings.updateAvailable'),
                        `v${displayVersion} → v${latestVersion}\n\n${tr('settings.changelog')}:\n${changelog.substring(0, 500)}${changelog.length > 500 ? '...' : ''}`,
                        [
                            { text: tr('settings.later'), style: 'cancel' },
                            { text: tr('attachments.download'), url: downloadUrl },
                        ]
                    );
                    await persistUpdateBadge(true, latestVersion);
                } else {
                    device.showToast({
                        title: tr('settings.aboutMobile.upToDate'),
                        message: tr('settings.upToDate'),
                        tone: 'success',
                    });
                    await persistUpdateBadge(false);
                }
            } catch (error) {
                device.logError('Update check failed:', error);
                device.showToast({
                    title: tr('settings.syncMobile.error'),
                    message: tr('settings.checkFailed'),
                    tone: 'warning',
                });
            }
        },

        /** Rate our app: Google Play's listing (the market link, else the web page), or the App Store's review page. */
        async rateApp(): Promise<void> {
            try {
                if (device.platform === 'android') {
                    try {
                        await device.openURL(PLAY_STORE_MARKET_URL);
                    } catch {
                        await device.openURL(PLAY_STORE_URL);
                    }
                    return;
                }

                if (device.platform === 'ios') {
                    const { trackViewUrl } = await fetchLatestAppStoreInfo();
                    const trackIdMatch = trackViewUrl?.match(/\/id(\d+)/i);
                    const reviewDeepLink = trackIdMatch?.[1]
                        ? `itms-apps://itunes.apple.com/app/id${trackIdMatch[1]}?action=write-review`
                        : null;
                    const canOpenReview = reviewDeepLink ? await device.canOpenURL(reviewDeepLink) : false;
                    const targetUrl = canOpenReview ? reviewDeepLink : trackViewUrl;
                    if (!targetUrl) throw new Error('App Store listing unavailable');
                    await device.openURL(targetUrl);
                }
            } catch (error) {
                device.logWarn('Failed to open app store rating page', error);
                device.showToast({
                    title: tr('settings.aboutMobile.storeUnavailable'),
                    message: tr('settings.aboutMobile.couldNotOpenTheAppStoreRatingPagePleaseTry'),
                    tone: 'warning',
                });
            }
        },
    };
}

// ---- The feedback modal ----

export const FEEDBACK_LOCATIONS = [
    'inbox',
    'focus',
    'projects',
    'review',
    'settings',
    'sync',
    'importExport',
    'notifications',
    'other',
] as const;

export type FeedbackLocation = typeof FEEDBACK_LOCATIONS[number];

export const FEEDBACK_MESSAGE_MAX_LENGTH = 4000;

export type FeedbackModalText = {
    title: string;
    /** The header's GitHub line around its link, per category (RN splits settings.feedbackGitHubDesc at `{channel}`). */
    gitHub: Record<FeedbackCategory, { before: string; link: string; after: string; url: string }>;
    close: string;
    category: string;
    categories: Record<FeedbackCategory, string>;
    where: string;
    locations: Record<FeedbackLocation, string>;
    message: string;
    messagePlaceholders: Record<FeedbackCategory, string>;
    email: string;
    emailPlaceholder: string;
    includeDiagnostics: string;
    includeDiagnosticsDescription: string;
    unavailable: string;
    unavailableDescription: string;
    sent: string;
    cancel: string;
    submit: string;
    sending: string;
};

/** The modal's words, as RN's FeedbackSettingsModal reads them. */
export function buildFeedbackModalText(tr: (key: string) => string): FeedbackModalText {
    const [before, after] = tr('settings.feedbackGitHubDesc').split('{channel}');
    const gitHubLine = (category: FeedbackCategory) => ({
        before,
        link: tr(category === 'other' ? 'settings.feedbackOpenGitHubDiscussion' : 'settings.feedbackOpenGitHubIssue'),
        after,
        url: getFeedbackGitHubUrl(category),
    });
    return {
        title: tr('settings.feedback'),
        gitHub: { bug: gitHubLine('bug'), feature: gitHubLine('feature'), other: gitHubLine('other') },
        close: tr('common.close'),
        category: tr('settings.feedbackCategory'),
        categories: {
            bug: tr('settings.feedbackCategoryBug'),
            feature: tr('settings.feedbackCategoryFeature'),
            other: tr('settings.feedbackCategoryOther'),
        },
        where: tr('settings.feedbackWhere'),
        locations: {
            inbox: tr('settings.feedbackWhereInbox'),
            focus: tr('settings.feedbackWhereFocus'),
            projects: tr('settings.feedbackWhereProjects'),
            review: tr('settings.feedbackWhereReview'),
            settings: tr('settings.feedbackWhereSettings'),
            sync: tr('settings.feedbackWhereSync'),
            importExport: tr('settings.feedbackWhereImportExport'),
            notifications: tr('settings.feedbackWhereNotifications'),
            other: tr('settings.feedbackWhereOther'),
        },
        message: tr('settings.feedbackMessage'),
        messagePlaceholders: {
            bug: tr('settings.feedbackMessagePlaceholderBug'),
            feature: tr('settings.feedbackMessagePlaceholderFeature'),
            other: tr('settings.feedbackMessagePlaceholderOther'),
        },
        email: tr('settings.feedbackEmail'),
        emailPlaceholder: tr('settings.feedbackEmailPlaceholder'),
        includeDiagnostics: tr('settings.feedbackIncludeDiagnostics'),
        includeDiagnosticsDescription: tr('settings.feedbackIncludeDiagnosticsDesc'),
        unavailable: tr('settings.feedbackUnavailable'),
        unavailableDescription: tr('settings.feedbackUnavailableDesc'),
        sent: tr('settings.feedbackSent'),
        cancel: tr('common.cancel'),
        submit: tr('settings.feedbackSubmit'),
        sending: tr('settings.feedbackSending'),
    };
}

/** The header link: GitHub Discussions for Other, the issue templates for a bug or a feature. */
export const getFeedbackGitHubUrl = (category: FeedbackCategory): string => (
    category === 'other' ? ABOUT_GITHUB_DISCUSSIONS_URL : ABOUT_GITHUB_ISSUES_URL
);

export type FeedbackDraft = {
    category: FeedbackCategory;
    message: string;
    email: string;
    location: FeedbackLocation | '';
    includeDiagnostics: boolean;
};

export type FeedbackStatus = 'idle' | 'sending' | 'sent' | 'error';

// The endpoint's own rule (feedback.ts: the shape and at most 254 characters), so the modal never sends an email it refuses.
const isFeedbackEmailShapeValid = (trimmedEmail: string) => isValidFeedbackEmail(trimmedEmail);

/**
 * The modal's state as RN derives it from the draft: whether Send is on, and the error line (the screen's own error first,
 * else the invalid-email line while the typed email is not one).
 */
export function getFeedbackDraftState(input: {
    tr: (key: string) => string;
    isConfigured: boolean;
    message: string;
    email: string;
    status: FeedbackStatus;
    error: string | null;
}): { canSubmit: boolean; emailValid: boolean; visibleError: string | null } {
    const trimmedMessage = input.message.trim();
    const trimmedEmail = input.email.trim();
    const emailValid = isFeedbackEmailShapeValid(trimmedEmail);
    const canSubmit = input.isConfigured && trimmedMessage.length > 0 && emailValid && input.status !== 'sending';
    const visibleError = input.error
        ?? (trimmedEmail && !emailValid ? input.tr('settings.feedbackInvalidEmail') : null);
    return { canSubmit, emailValid, visibleError };
}

/**
 * Send: the refusal RN shows for a blank message or an invalid email (`error`), else what it submits. A bug's place, when one
 * is chosen, leads the message ("Where: Sync" and a blank line); diagnostics go only with a bug.
 */
export function planFeedbackSubmit(draft: FeedbackDraft, tr: (key: string) => string):
    | { error: string }
    | { input: { category: FeedbackCategory; email?: string; includeDiagnostics: boolean; message: string } } {
    const trimmedMessage = draft.message.trim();
    const trimmedEmail = draft.email.trim();
    if (!trimmedMessage) return { error: tr('settings.feedbackRequired') };
    if (!isFeedbackEmailShapeValid(trimmedEmail)) return { error: tr('settings.feedbackInvalidEmail') };
    const submittedMessage = draft.category === 'bug' && draft.location
        ? `${tr('settings.feedbackWhereMessagePrefix')}: ${buildFeedbackModalText(tr).locations[draft.location]}\n\n${trimmedMessage}`
        : trimmedMessage;
    return {
        input: {
            category: draft.category,
            email: trimmedEmail || undefined,
            includeDiagnostics: draft.category === 'bug' && draft.includeDiagnostics,
            message: submittedMessage,
        },
    };
}

/** What About sends for the modal's input: the app's metadata, and the diagnostics a bug asked for. */
export function buildAboutFeedbackSubmission(input: {
    category: FeedbackCategory;
    email?: string;
    message: string;
    displayVersion: string;
    build?: string;
    installChannel: string;
    locale: string;
    platform: string;
    platformVersion: string;
    diagnosticsLogs: string | null;
}): FeedbackSubmissionInput {
    return {
        category: input.category,
        email: input.email,
        message: input.message,
        metadata: {
            appVersion: input.displayVersion,
            build: input.build,
            installChannel: input.installChannel,
            locale: input.locale,
            os: `${input.platform} ${input.platformVersion}`.trim(),
            platform: input.platform,
        },
        diagnostics: input.diagnosticsLogs ? { logs: input.diagnosticsLogs } : undefined,
    };
}

export const isFeedbackLocation = (value: unknown): value is FeedbackLocation => FEEDBACK_LOCATIONS.includes(value as FeedbackLocation);
