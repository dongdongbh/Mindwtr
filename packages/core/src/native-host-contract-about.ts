


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
    resolveAndroidInstallerSource,
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
import { shouldCheckForAppUpdate, UPDATE_BADGE_LAST_CHECK_KEY } from './app-store-update';
import { FEEDBACK_CATEGORIES, isFeedbackCategory, submitFeedbackSubmission } from './feedback';
import { resolveI18nText } from './i18n';
import { NATIVE_HOST_CONTRACT_VERSION, type NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord, isText } from './native-host-contract-menu-views';
import { useTaskStore } from './store';
import { attemptStoreReviewAfterPositiveMoment } from './user-prompts';


type AboutStorage = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
};

export type NativeAboutHost = {

    app: {
        appName: string;

        version: string;

        releaseVersion: string;

        build: string;
        packageName: string;
        isFossBuild: boolean;

        isDev: boolean;
        platform: string;
        platformVersion: string | number;
        osRelease: string;
        feedbackEndpointUrl: string;
        analyticsHeartbeatUrl: string;
        analyticsHeartbeatChannel: string;

        githubReleasesApi?: string;
    };
    storage: AboutStorage;
    fetcher: (url: string, init?: RequestInit) => Promise<Response>;

    locale: () => string;
    generateId: () => string;

    feedbackDiagnostics: () => Promise<string | null>;
    logWarn: (message: string, error: unknown) => void;
    logInfo: (message: string, context: Record<string, string>) => void;
};

export type NativeAboutSettings = AboutSettingsModel & {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    revision: string;

    rate: { urls: string[]; failed: AboutToast };
    feedback: {
        text: FeedbackModalText;

        isConfigured: boolean;
        categories: readonly string[];

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

        getAboutInstallerSource(input: { referrer: string | null; installerPackageName: string | null }): NativeHostResult<{ source: AndroidInstallerSource }> {
            const host = deps.host();
            if (!host) return unavailable();
            if (!isObjectRecord(input) || !(input.referrer === null || isText(input.referrer, 10_000))
                || !(input.installerPackageName === null || isText(input.installerPackageName, 500))) {
                return fail('INVALID_INPUT', 'The install referrer (or null) and the installing package (or null) are required');
            }
            if (host.app.isFossBuild) return { ok: true, value: { source: 'sideload' } };
            const source = resolveAndroidInstallerSource(input.referrer, input.installerPackageName);

            return { ok: true, value: { source: input.referrer === null && source !== 'play-store' ? 'unknown' : source } };
        },


        async isAboutUpdateCheckDue(input: { mode: 'silent' | 'manual' }): Promise<NativeHostResult<{ due: boolean }>> {
            const host = deps.host();
            if (!host) return unavailable();
            if (!isObjectRecord(input) || (input.mode !== 'silent' && input.mode !== 'manual')) return fail('INVALID_INPUT', 'A mode is required');
            if (host.app.isFossBuild) return { ok: true, value: { due: false } };
            if (input.mode === 'manual') return { ok: true, value: { due: true } };
            try {
                return { ok: true, value: { due: shouldCheckForAppUpdate(await host.storage.getItem(UPDATE_BADGE_LAST_CHECK_KEY), Date.now()) } };
            } catch {

                return fail('ACTION_FAILED', 'The last update check could not be read');
            }
        },


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


            if (play === null && !host.app.isFossBuild && host.app.platform === 'android' && source !== 'sideload') {
                const due = input.mode === 'manual' || await host.storage.getItem(UPDATE_BADGE_LAST_CHECK_KEY)
                    .then((raw) => shouldCheckForAppUpdate(raw, Date.now()), () => true);
                if (due) {
                    try {
                        host.logInfo('Native About update check', { releaseCheck: 'v1.3.5/native-about-update-check', mode: input.mode, source,
                            play: 'not-asked', badge: 'unchanged', notice: 'none' });
                    } catch {                                                    }
                    return { ok: true, value: { badge: null, notices: [] } };
                }
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
            } catch {                                                    }
            return { ok: true, value: { badge, notices } };
        },


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

                const code = error instanceof Error && /^feedback_[a-z_]+\d*$/.test(error.message) ? error.message : 'request_failed';
                try { host.logInfo('Native About feedback', { releaseCheck: 'v1.3.5/native-about-feedback', outcome: code, diagnostics }); } catch {                   }
                return { ok: true, value: { sent: false, refused: null, failed: tr('settings.feedbackFailed') } };
            }
            try { host.logInfo('Native About feedback', { releaseCheck: 'v1.3.5/native-about-feedback', outcome: 'sent', diagnostics }); } catch {                   }
            return { ok: true, value: { sent: true, refused: null, failed: null } };
        },


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

            }
            if (sent) {
                try { host.logInfo('Native analytics heartbeat sent', { releaseCheck: 'v1.3.5/native-analytics-heartbeat', channel: config.analyticsHeartbeatChannel || 'fallback' }); } catch {                   }
            }
            return { ok: true, value: { sent } };
        },


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
            try { host.logInfo('Native store review prompt', { releaseCheck: 'v1.3.5/native-store-review', request: String(request) }); } catch {                   }
            return { ok: true, value: { request } };
        },
    };
}
