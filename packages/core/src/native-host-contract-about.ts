/**
 * The native host contract for Settings › About (React Native's about-settings-screen.tsx and feedback-settings-modal.tsx),
 * the daily analytics heartbeat (RN's use-root-layout-startup.ts) and the store review prompt after a Weekly Review (RN's
 * store-review-prompt.ts). Kept in its own file and spread into createNativeHostContract. The rules are core's, the code RN
 * runs: about-settings-model.ts, analytics-heartbeat.ts, user-prompts.ts and feedback.ts.
 *
 * A host binds its device through `NativeAboutHost` (createNativeHostContract's `about` option): the build's facts (its
 * version, channel and the endpoints it was built with), RN's AsyncStorage (the update dot, the heartbeat's id and day, the
 * prompt state, all under RN's keys, so an upgraded RN user keeps them), the fetch, and the recent diagnostics. Without it the
 * screen and the requests answer ACTION_FAILED.
 *
 * - getAboutSettings is the screen: the header, the rows, the feedback modal's words. `installerSource` is what the host read
 *   from Google Play's install referrer (RN's resolveAndroidInstallerSource; 'unknown' while unread or when the read failed;
 *   a FOSS build sends 'sideload', as RN does).
 * - runAboutUpdateCheck is the silent check when About opens (`silent`) and Check for updates (`manual`). The host asks
 *   Google Play first on a Play build installed from Play and sends its answer as `play` (null when the build has no Play
 *   update API: a FOSS build), and says whether a market link opens (`marketAvailable`). The answer is the update dot to show
 *   (null: unchanged) and RN's alert or toast; an alert button with a `url` opens it.
 * - checkAboutFeedback is the modal's state for the draft as typed (Send on or off, the error line); submitAboutFeedback
 *   sends it to the build's feedback endpoint. Neither is a store write.
 * - sendAboutHeartbeat (after the boot), recordAboutPromptActivity (at first paint) and attemptAboutStoreReview (after a
 *   Weekly Review, with whether the store has a review flow) write only RN's AsyncStorage keys.
 *
 * Nothing here is journaled: the requests write no synced data, and a replay would send feedback or a heartbeat twice. The
 * feedback text and email go only to the endpoint, never to a log, receipt or error text.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the import cycle between the two files is safe.
 */
import {
    buildAboutFeedbackSubmission,
    buildAboutSettingsModel,
    buildFeedbackModalText,
    createAboutUpdateChecks,
    FEEDBACK_LOCATIONS,
    getAboutInstallChannel,
    getFeedbackDraftState,
    getFeedbackMessageMaxLength,
    isFeedbackLocation,
    planFeedbackSubmit,
    type AboutAlertButton,
    type AboutSettingsModel,
    type AboutToast,
    type AndroidInstallerSource,
    type FeedbackModalText,
    type PlayStoreUpdateAnswer,
} from './about-settings-model';
import {
    isMobileAnalyticsHeartbeatConfigured,
    resolveMobileAnalyticsVersion,
    sendMobileDailyHeartbeat,
    type MobileAnalyticsHeartbeatConfig,
    type MobileHeartbeatDevice,
} from './analytics-heartbeat';
import { FEEDBACK_CATEGORIES, isFeedbackCategory, submitFeedbackSubmission } from './feedback';
import { resolveI18nText } from './i18n';
import { NATIVE_HOST_CONTRACT_VERSION, type NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord, isText } from './native-host-contract-menu-views';
import { useTaskStore } from './store';
import { attemptStoreReviewAfterPositiveMoment, recordLocalPromptActivity } from './user-prompts';

/** RN's AsyncStorage on the host. */
type AboutStorage = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
};

export type NativeAboutHost = {
    /** The build, as RN reads it from app.json and app.config.ts's extra. */
    app: {
        appName: string;
        /** app.json's version. */
        version: string;
        /** The release tag (release-version.json or ANALYTICS_RELEASE_VERSION): shown when it extends the version. */
        releaseVersion: string;
        /** The build number (RN's nativeBuildVersion). */
        build: string;
        packageName: string;
        isFossBuild: boolean;
        /** A development build (RN's __DEV__): it never sends a heartbeat. */
        isDev: boolean;
        platform: string;
        platformVersion: string | number;
        osRelease: string;
        feedbackEndpointUrl: string;
        analyticsHeartbeatUrl: string;
        analyticsHeartbeatChannel: string;
        /** GitHub's latest-release API; a device check points it at a local stub. */
        githubReleasesApi?: string;
    };
    storage: AboutStorage;
    fetcher: (url: string, init?: RequestInit) => Promise<Response>;
    /** The device locale (RN's Intl resolvedOptions().locale). */
    locale: () => string;
    generateId: () => string;
    /** The diagnostics a bug report attaches (RN's collectFeedbackDiagnostics). */
    feedbackDiagnostics: () => Promise<string | null>;
    logWarn: (message: string, error: unknown) => void;
    logInfo: (message: string, context: Record<string, string>) => void;
};

export type NativeAboutSettings = AboutSettingsModel & {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;
    /** The Rate row's links, in the order to try (RN's market link, else the web page), and the toast when none opens. */
    rate: { urls: string[]; failed: AboutToast };
    feedback: {
        text: FeedbackModalText;
        /** No endpoint in this build: Send stays off and the modal says so. */
        isConfigured: boolean;
        categories: readonly string[];
        /** A bug's places, in RN's order. */
        locations: readonly string[];
    };
};

export type NativeAboutNotice = ({ kind: 'toast' } & AboutToast) | { kind: 'alert'; title: string; message: string; buttons: AboutAlertButton[] };

type Deps = {
    readiness: () => NativeHostResult<null>;
    t: () => (key: string) => string;
    language: () => string;
    host: () => NativeAboutHost | null;
};

const INSTALLER_SOURCES = new Set<string>(['play-store', 'sideload', 'unknown']);

const unavailable = () => fail('ACTION_FAILED', 'About is not available on this host');

const readPlay = (value: unknown): { value: PlayStoreUpdateAnswer } | { error: string } | null | undefined => {
    if (value === null) return null;
    if (!isObjectRecord(value)) return undefined;
    if ('error' in value) return isText(value.error, 500) ? { error: value.error } : undefined;
    const answer = value.value;
    if (!isObjectRecord(answer) || typeof answer.updateAvailable !== 'boolean'
        || !(answer.availableVersionCode === null || Number.isSafeInteger(answer.availableVersionCode))) return undefined;
    return { value: { updateAvailable: answer.updateAvailable, availableVersionCode: answer.availableVersionCode as number | null } };
};

const displayVersion = (host: NativeAboutHost) => resolveMobileAnalyticsVersion(host.app.version, host.app.releaseVersion);

/** The heartbeat's build config and device on [host] (the Data screen's opt-out sends with them too). */
export function nativeAboutHeartbeat(host: NativeAboutHost): { config: MobileAnalyticsHeartbeatConfig; device: MobileHeartbeatDevice; available: boolean } {
    const config = {
        analyticsHeartbeatUrl: host.app.analyticsHeartbeatUrl,
        analyticsHeartbeatChannel: host.app.analyticsHeartbeatChannel,
        appVersion: displayVersion(host),
        isExpoGo: false,
        isFossBuild: host.app.isFossBuild,
    };
    return {
        config,
        available: isMobileAnalyticsHeartbeatConfigured(config),
        device: {
            platform: host.app.platform,
            platformVersion: host.app.platformVersion,
            osRelease: host.app.osRelease,
            locale: host.locale(),
            isDev: host.app.isDev,
            storage: host.storage,
            fetcher: host.fetcher,
            generateId: host.generateId,
        },
    };
}

export function createAboutMethods(deps: Deps) {
    const tr = (key: string, values?: Record<string, string>) => resolveI18nText(deps.t(), key, { values });
    const heartbeatConfig = (host: NativeAboutHost) => nativeAboutHeartbeat(host).config;
    const readSource = (value: unknown): AndroidInstallerSource | null => (INSTALLER_SOURCES.has(value as string) ? value as AndroidInstallerSource : null);

    return {
        /** Settings › About for `installerSource` (see the module doc). */
        getAboutSettings(input: { installerSource: AndroidInstallerSource }): NativeHostResult<NativeAboutSettings> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return unavailable();
            if (!isObjectRecord(input) || !readSource(input.installerSource)) return fail('INVALID_INPUT', 'An installer source is required');
            const packageName = host.app.packageName;
            return {
                ok: true,
                value: {
                    version: NATIVE_HOST_CONTRACT_VERSION,
                    revision: deps.language(),
                    ...buildAboutSettingsModel({ t: deps.t(), tr, appName: host.app.appName, displayVersion: displayVersion(host),
                        isFossBuild: host.app.isFossBuild, platform: host.app.platform }),
                    rate: {
                        urls: [`market://details?id=${packageName}`, `https://play.google.com/store/apps/details?id=${packageName}`],
                        failed: {
                            title: tr('settings.aboutMobile.storeUnavailable'),
                            message: tr('settings.aboutMobile.couldNotOpenTheAppStoreRatingPagePleaseTry'),
                            tone: 'warning',
                        },
                    },
                    feedback: {
                        text: buildFeedbackModalText(tr),
                        isConfigured: Boolean(host.app.feedbackEndpointUrl.trim()),
                        categories: FEEDBACK_CATEGORIES,
                        locations: FEEDBACK_LOCATIONS,
                    },
                },
            };
        },

        /**
         * RN's update check: `silent` when About opens (at most once a day; within the day it answers the stored dot), `manual`
         * behind Check for updates. The answer's `badge` is the dot to show (null: unchanged), `notices` RN's alert or toast.
         */
        async runAboutUpdateCheck(input: {
            mode: 'silent' | 'manual';
            installerSource: AndroidInstallerSource;
            play: { value: PlayStoreUpdateAnswer } | { error: string } | null;
            marketAvailable: boolean;
        }): Promise<NativeHostResult<{ badge: boolean | null; notices: NativeAboutNotice[] }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return unavailable();
            const source = isObjectRecord(input) ? readSource(input.installerSource) : null;
            const play = isObjectRecord(input) ? readPlay(input.play) : undefined;
            if (!source || play === undefined || (input.mode !== 'silent' && input.mode !== 'manual') || typeof input.marketAvailable !== 'boolean') {
                return fail('INVALID_INPUT', 'A mode, an installer source, the Play answer (or null) and whether a market link opens are required');
            }
            let badge: boolean | null = null;
            const notices: NativeAboutNotice[] = [];
            const checks = createAboutUpdateChecks({
                platform: host.app.platform,
                isFossBuild: host.app.isFossBuild,
                isExpoGo: false,
                currentVersion: host.app.version,
                displayVersion: displayVersion(host),
                androidInstallerSource: source,
                androidPackageName: host.app.packageName,
                iosBundleId: host.app.packageName,
                storage: host.storage,
                fetcher: (url, init) => host.fetcher(url, init),
                getPlayStoreUpdateInfo: async () => {
                    if (!play) throw new Error('Play Store updates module unavailable');
                    if ('error' in play) throw new Error(play.error);
                    return play.value;
                },
                canOpenURL: async (url) => url.startsWith('market://') && input.marketAvailable,
                // Opening is the host's (an alert button's url).
                openURL: async () => undefined,
                onUpdateBadgeChange: (next) => { badge = next; },
                showToast: (toast) => { notices.push({ kind: 'toast', ...toast }); },
                showAlert: (title, message, buttons) => { notices.push({ kind: 'alert', title, message, buttons }); },
                tr,
                logWarn: host.logWarn,
                logError: host.logWarn,
                ...(host.app.githubReleasesApi ? { githubReleasesApi: host.app.githubReleasesApi } : {}),
            });
            if (input.mode === 'silent') await checks.runSilentCheck();
            else await checks.runManualCheck();
            try {
                host.logInfo('Native About update check', {
                    releaseCheck: 'v1.3.5/native-about-update-check',
                    mode: input.mode,
                    source,
                    play: play === null ? 'none' : 'error' in play ? 'failed' : 'answered',
                    badge: badge === null ? 'unchanged' : String(badge),
                    notice: notices[0]?.kind ?? 'none',
                });
            } catch { /* a diagnostic line must never fail its caller */ }
            return { ok: true, value: { badge, notices } };
        },

        /**
         * The modal's state for the draft as typed: whether Send is on, the error line under the fields, and the message field's
         * limit (less a bug's place, which leads the message).
         */
        checkAboutFeedback(input: { message: string; email: string; sending: boolean; error: string | null; category: string; location: string }):
            NativeHostResult<{ canSubmit: boolean; visibleError: string | null; messageMaxLength: number }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return unavailable();
            if (!isObjectRecord(input) || !isText(input.message, 10_000) || !isText(input.email, 1_000) || typeof input.sending !== 'boolean'
                || !(input.error === null || isText(input.error, 1_000)) || !isFeedbackCategory(input.category)
                || !(input.location === '' || isFeedbackLocation(input.location))) {
                return fail('INVALID_INPUT', 'The draft (category, place, message, email), whether it is sending and the screen\'s error are required');
            }
            const { canSubmit, visibleError } = getFeedbackDraftState({ tr, isConfigured: Boolean(host.app.feedbackEndpointUrl.trim()),
                message: input.message, email: input.email, status: input.sending ? 'sending' : 'idle', error: input.error });
            const messageMaxLength = getFeedbackMessageMaxLength({ category: input.category, location: input.location as never }, tr);
            return { ok: true, value: { canSubmit, visibleError, messageMaxLength } };
        },

        /**
         * Send: RN's refusal for a blank message or an invalid email (`refused`, the modal's error line), else the feedback to the
         * build's endpoint with the app's metadata and, for a bug that asked, the recent diagnostics. A failed send answers
         * `failed` (RN's line; the draft stays). Never journaled, never logged.
         */
        async submitAboutFeedback(input: {
            draft: { category: string; message: string; email: string; location: string; includeDiagnostics: boolean };
            installerSource: AndroidInstallerSource;
        }): Promise<NativeHostResult<{ sent: boolean; refused: string | null; failed: string | null }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return unavailable();
            const draft = isObjectRecord(input) && isObjectRecord(input.draft) ? input.draft : null;
            const source = isObjectRecord(input) ? readSource(input.installerSource) : null;
            if (!draft || !source || !isFeedbackCategory(draft.category) || !isText(draft.message, 10_000) || !isText(draft.email, 1_000)
                || !(draft.location === '' || isFeedbackLocation(draft.location)) || typeof draft.includeDiagnostics !== 'boolean') {
                return fail('INVALID_INPUT', 'A feedback draft and an installer source are required');
            }
            const plan = planFeedbackSubmit({ category: draft.category, message: draft.message, email: draft.email,
                location: draft.location as never, includeDiagnostics: draft.includeDiagnostics }, tr);
            if ('error' in plan) return { ok: true, value: { sent: false, refused: plan.error, failed: null } };
            let diagnostics = 'none';
            try {
                const diagnosticsLogs = plan.input.includeDiagnostics && plan.input.category === 'bug' ? await host.feedbackDiagnostics() : null;
                diagnostics = diagnosticsLogs ? 'attached' : 'none';
                await submitFeedbackSubmission(host.app.feedbackEndpointUrl.trim(), buildAboutFeedbackSubmission({
                    ...plan.input,
                    displayVersion: displayVersion(host),
                    build: host.app.build || undefined,
                    installChannel: getAboutInstallChannel({ isFossBuild: host.app.isFossBuild, platform: host.app.platform, androidInstallerSource: source }),
                    locale: host.locale(),
                    platform: host.app.platform,
                    platformVersion: String(host.app.platformVersion ?? ''),
                    diagnosticsLogs,
                }), host.fetcher as typeof fetch);
            } catch (error) {
                // Only the failure's code: an error text could carry the endpoint.
                const code = error instanceof Error && /^feedback_[a-z_]+\d*$/.test(error.message) ? error.message : 'request_failed';
                try { host.logInfo('Native About feedback', { releaseCheck: 'v1.3.5/native-about-feedback', outcome: code, diagnostics }); } catch { /* best effort */ }
                return { ok: true, value: { sent: false, refused: null, failed: tr('settings.feedbackFailed') } };
            }
            try { host.logInfo('Native About feedback', { releaseCheck: 'v1.3.5/native-about-feedback', outcome: 'sent', diagnostics }); } catch { /* best effort */ }
            return { ok: true, value: { sent: true, refused: null, failed: null } };
        },

        /** The day's heartbeat after the boot, as RN's startup sends it; whether one went. Failures stay silent, as on RN. */
        async sendAboutHeartbeat(): Promise<NativeHostResult<{ sent: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return unavailable();
            const config = heartbeatConfig(host);
            if (!isMobileAnalyticsHeartbeatConfigured(config)) return { ok: true, value: { sent: false } };
            let sent = false;
            try {
                sent = await sendMobileDailyHeartbeat(config, useTaskStore.getState().settings, nativeAboutHeartbeat(host).device);
            } catch {
                // Keep analytics heartbeat failures silent, as RN's startup does.
            }
            if (sent) {
                try { host.logInfo('Native analytics heartbeat sent', { releaseCheck: 'v1.3.5/native-analytics-heartbeat', channel: config.analyticsHeartbeatChannel || 'fallback' }); } catch { /* best effort */ }
            }
            return { ok: true, value: { sent } };
        },

        /** Today counts as an active day for the prompts (RN's recordLocalPromptActivity at first paint). */
        async recordAboutPromptActivity(): Promise<NativeHostResult<null>> {
            const host = deps.host();
            if (!host) return unavailable();
            try {
                await recordLocalPromptActivity(host.storage);
            } catch (error) {
                host.logWarn('Failed to record local prompt activity', error);
            }
            return { ok: true, value: null };
        },

        /**
         * After a finished Weekly Review: whether to show the store's review flow now (core's gate; the attempt is stored first).
         * `storeReviewAvailable` is whether the store has one (RN's StoreReview.hasAction: Google Play installed). A FOSS build
         * never asks.
         */
        async attemptAboutStoreReview(input: { storeReviewAvailable: boolean }): Promise<NativeHostResult<{ request: boolean }>> {
            const host = deps.host();
            if (!host) return unavailable();
            if (!isObjectRecord(input) || typeof input.storeReviewAvailable !== 'boolean') return fail('INVALID_INPUT', 'Whether the store has a review flow is required');
            const platform = host.app.platform === 'android' || host.app.platform === 'ios' ? host.app.platform : 'unknown';
            const request = await attemptStoreReviewAfterPositiveMoment({
                buildEligible: !host.app.isFossBuild && platform !== 'unknown',
                platform,
                storage: host.storage,
                hasNativeReviewAction: async () => input.storeReviewAvailable,
                nowMs: Date.now(),
            });
            try { host.logInfo('Native store review prompt', { releaseCheck: 'v1.3.5/native-store-review', request: String(request) }); } catch { /* best effort */ }
            return { ok: true, value: { request } };
        },
    };
}
