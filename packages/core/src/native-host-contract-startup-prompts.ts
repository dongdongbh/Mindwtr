


import type { AndroidInstallerSource } from './about-settings-model';
import { ACTIVE_APP_ANNOUNCEMENT, APP_ANNOUNCEMENT_DISMISSED_VALUE, getAnnouncementDismissalStorageKey, type AppAnnouncement } from './announcements';
import { readMobileOnboardingDismissed, writeMobileOnboardingDismissed } from './first-run-onboarding';
import { translateWithFallback } from './i18n';
import {
    buildMobileStartupPromptDescriptors,
    buildUpdateReminderAnnouncement,
    fetchMobileUpdateReminderInfo,
    PROMPT_TEST_ANNOUNCEMENT,
    resolveMobileDonationPromptAllowed,
    resolveMobileUpdateReminderAllowed,
    translateDonationPromptAnnouncement,
    UPDATE_NOW_ACTION_LABEL,
    UPDATE_REMINDER_RELEASES_URL,
    VIEW_RELEASE_ACTION_LABEL,
    type MobileUpdateReminderInfo,
} from './mobile-startup-prompts';
import { coerceSupportedBackend, resolveBackend } from './mobile-sync-utils';
import type { NativeAboutHost } from './native-host-contract-about';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import { isSandboxMode } from './sandbox';
import { runStartupPromptsOnce } from './startup-prompt-run';
import { useTaskStore } from './store';
import { SYNC_BACKEND_KEY } from './sync-storage-keys';
import {
    readLocalUserPromptState,
    recordDonationPromptShown,
    recordLocalPromptActivity,
    recordUpdateReminderDismissed,
    updateLocalUserPromptState,
    withSupportPromptShown,
    type UserPromptState,
} from './user-prompts';

type Deps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => (key: string) => string;

    language: () => string;
    host: () => NativeStartupPromptHost | null;
};

export type NativeStartupPromptHost = Pick<NativeAboutHost, 'storage' | 'fetcher' | 'logInfo' | 'logWarn'> & {
    app: Pick<NativeAboutHost['app'], 'platform' | 'isFossBuild' | 'version' | 'packageName' | 'githubReleasesApi'>;
};

export const NATIVE_STARTUP_PROMPT_IDS = ['onboarding', 'announcement', 'update-reminder', 'donation'] as const;
export type NativeStartupPromptId = typeof NATIVE_STARTUP_PROMPT_IDS[number];


const ONBOARDING_WORDS = ['title', 'subtitle', 'startFreshTitle', 'startFreshDesc', 'startFreshBusy', 'syncTitle', 'syncDesc', 'importTitle',
    'importDescMobile', 'footer', 'skipForNow', 'skip', 'errorNotCreated', 'errorFailed', 'toastNotCreated', 'toastFailed', 'toastReady'] as const;


export type NativeStartupPrompt =
    | { id: 'onboarding'; words: Record<typeof ONBOARDING_WORDS[number], string>; language: string }
    | {
        id: Exclude<NativeStartupPromptId, 'onboarding'>;
        announcement: AppAnnouncement;

        notNow: string;
        closeLabel: string;
    };

const INSTALLER_SOURCES = new Set<string>(['play-store', 'sideload', 'unknown']);
const PROMPT_IDS = new Set<string>(NATIVE_STARTUP_PROMPT_IDS);
const ACTIONS = new Set<string>(['dismiss', 'act', 'shown']);

const unavailable = () => fail('ACTION_FAILED', 'Startup prompts are not available on this host');

export function createStartupPromptMethods(deps: Deps) {
    const receipts = createNativeRequestReceipts({ save: deps.save });


    const retired = new Set<string>();
    let activityRecorded = false;

    let openedUpdateVersion: string | null = null;
    const resolveText = (key: string, fallback: string) => translateWithFallback(deps.t(), key, fallback);

    const view = (id: NativeStartupPromptId, updateInfo: MobileUpdateReminderInfo | null, announcement: AppAnnouncement | null): NativeStartupPrompt | null => {
        if (id === 'onboarding') {
            const t = deps.t();
            const words = Object.fromEntries(ONBOARDING_WORDS.map((key) => [key, t(`onboarding.${key}`)])) as Record<typeof ONBOARDING_WORDS[number], string>;
            return { id, words, language: deps.language() };
        }
        const labels = { notNow: resolveText('common.notNow', 'Not now'), closeLabel: resolveText('announcement.dismiss', 'Dismiss announcement') };
        if (id === 'announcement') return announcement ? { id, announcement, ...labels } : null;
        if (id === 'update-reminder') return updateInfo ? { id, announcement: buildUpdateReminderAnnouncement(updateInfo, resolveText), ...labels } : null;
        return { id, announcement: translateDonationPromptAnnouncement(resolveText), ...labels };
    };
    const warn = (host: NativeStartupPromptHost, message: string, error: unknown) => {
        try { host.logWarn(message, error); } catch {                   }
    };

    return {


        async beginStartupPrompts(input: unknown): Promise<NativeHostResult<{ prompt: NativeStartupPrompt | null; notice?: string; delayMs?: number }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return unavailable();
            if (!isObjectRecord(input) || typeof input.installerSource !== 'string' || !INSTALLER_SOURCES.has(input.installerSource)
                || typeof input.donationEnabled !== 'boolean') {
                return fail('INVALID_INPUT', 'beginStartupPrompts takes installerSource and donationEnabled');
            }
            if (input.deferDelay !== undefined && typeof input.deferDelay !== 'boolean') return fail('INVALID_INPUT', 'deferDelay takes a boolean');
            const deferDelay = input.deferDelay === true;
            const noDelay = deferDelay ? { delayMs: 0 } : {};
            if (isSandboxMode()) return { ok: true, value: { prompt: null, ...noDelay } };


            if (input.preview !== undefined) {
                if (typeof input.preview !== 'string' || !PROMPT_IDS.has(input.preview)) return fail('INVALID_INPUT', 'preview takes a prompt id');


                retired.add(input.preview);
                const source = input.installerSource;
                const target = host.app.isFossBuild ? null
                    : source === 'play-store' ? { label: UPDATE_NOW_ACTION_LABEL, url: `https://play.google.com/store/apps/details?id=${host.app.packageName}` }
                        : { label: source === 'sideload' ? UPDATE_NOW_ACTION_LABEL : VIEW_RELEASE_ACTION_LABEL, url: UPDATE_REMINDER_RELEASES_URL };

                if (input.preview === 'update-reminder' && !target) return { ok: true, value: { prompt: null, notice: 'Updates are managed by this build channel.', ...noDelay } };
                return { ok: true, value: { prompt: view(input.preview as NativeStartupPromptId, target && {
                    currentVersion: host.app.version, latestVersion: '99.99.99', latestReleasedAt: new Date().toISOString(),
                    releaseUrl: target.url, actionLabel: target.label, testOnly: true,
                }, PROMPT_TEST_ANNOUNCEMENT), ...noDelay } };
            }
            const storage = host.storage;


            let promptStateSnapshot: UserPromptState | null = null;
            if (!activityRecorded) {
                activityRecorded = true;
                let outcome = 'stored';
                try {
                    promptStateSnapshot = await recordLocalPromptActivity(storage);
                } catch (error) {
                    outcome = 'failed';
                    warn(host, 'Failed to record local prompt activity', error);
                }
                try { host.logInfo('Native prompt activity recorded', { releaseCheck: 'v1.3.5/native-prompt-activity', outcome }); } catch {                   }
            } else {
                try {
                    promptStateSnapshot = await readLocalUserPromptState(storage);
                } catch (error) {
                    warn(host, 'Failed to read local prompt state', error);
                }
            }
            const mobileOnboardingDismissed = await readMobileOnboardingDismissed(storage);
            const state = useTaskStore.getState();
            const visibleDataCount = state.tasks.length + state.projects.length + state.sections.length + state.areas.length;
            const platform = host.app.platform;
            const installerSource = input.installerSource as AndroidInstallerSource;
            const [donationPromptAllowed, updateReminderAllowed] = await Promise.all([
                resolveMobileDonationPromptAllowed({ platform, isExpoGo: false, donationPromptEnabled: input.donationEnabled }),
                resolveMobileUpdateReminderAllowed({ platform, androidInstallerSource: installerSource, isExpoGo: false, isFossBuild: host.app.isFossBuild }),
            ]);
            let updateInfo: MobileUpdateReminderInfo | null = null;
            const descriptors = buildMobileStartupPromptDescriptors({
                storage,

                dataReady: true,
                canonicalDataReady: true,
                mobileOnboardingDismissed,
                visibleDataCount,

                readSyncBackend: async () => coerceSupportedBackend(resolveBackend(await storage.getItem(SYNC_BACKEND_KEY)), false),
                onSyncBackendReadError: (error) => warn(host, 'Failed to read the sync backend for onboarding', error),
                updateReminderAllowed,
                donationPromptAllowed,
                promptStateSnapshot,
                onUpdateCheckRecordError: (error) => warn(host, 'Failed to record update reminder check', error),
                fetchUpdateInfo: () => fetchMobileUpdateReminderInfo(host.app.version, host.fetcher, host.app.githubReleasesApi),
                onUpdateReminderInfo: (info) => { updateInfo = info; },
                getSupportPrompt: () => useTaskStore.getState().settings.supportPrompt,
            });
            const id = await runStartupPromptsOnce(deferDelay ? descriptors.map((descriptor) => ({ ...descriptor, delayMs: 0 })) : descriptors, {
                retired,
                onLog: (error, context) => warn(host, `Startup prompt failed: ${context.id} ${context.phase}`, error),
            });
            if (!id) return { ok: true, value: { prompt: null, ...noDelay } };

            const opened = updateInfo as MobileUpdateReminderInfo | null;
            if (id === 'update-reminder' && opened) openedUpdateVersion = opened.latestVersion;
            const delayed = deferDelay ? { delayMs: descriptors.find((descriptor) => descriptor.id === id)?.delayMs ?? 0 } : {};
            return { ok: true, value: { prompt: view(id as NativeStartupPromptId, opened, ACTIVE_APP_ANNOUNCEMENT), ...delayed } };
        },


        async startupPromptAction(input: unknown): Promise<NativeHostResult<{ shownAt: string | null }>> {
            const host = deps.host();
            if (!host) return unavailable();
            if (!isObjectRecord(input) || typeof input.id !== 'string' || !PROMPT_IDS.has(input.id)
                || typeof input.action !== 'string' || !ACTIONS.has(input.action)) {
                return fail('INVALID_INPUT', 'startupPromptAction takes a prompt id and an action');
            }
            const storage = host.storage;
            const { id, action } = input;
            try {
                if (id === 'onboarding' && action === 'dismiss') {
                    await writeMobileOnboardingDismissed(storage);
                } else if (id === 'announcement' && action !== 'shown' && ACTIVE_APP_ANNOUNCEMENT) {
                    await storage.setItem(getAnnouncementDismissalStorageKey(ACTIVE_APP_ANNOUNCEMENT.id), APP_ANNOUNCEMENT_DISMISSED_VALUE);
                } else if (id === 'update-reminder' && action !== 'shown' && openedUpdateVersion) {
                    const latestVersion = openedUpdateVersion;
                    await updateLocalUserPromptState(storage, (state) => recordUpdateReminderDismissed(state, latestVersion));
                } else if (id === 'donation' && action === 'shown') {
                    const nowMs = Date.now();
                    await updateLocalUserPromptState(storage, (state) => recordDonationPromptShown(state, nowMs));
                    return { ok: true, value: { shownAt: new Date(nowMs).toISOString() } };
                }
            } catch (error) {
                warn(host, `Failed to store the ${id} prompt's ${action}`, error);
                if (id === 'donation') return { ok: true, value: { shownAt: new Date().toISOString() } };
            }
            return { ok: true, value: { shownAt: null } };
        },


        async supportPromptShown(input: unknown): Promise<NativeHostResult<{ changed: boolean }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const shownAtMs = isObjectRecord(input) && typeof input.shownAt === 'string' ? Date.parse(input.shownAt) : Number.NaN;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !Number.isFinite(shownAtMs)) {
                return fail('INVALID_INPUT', 'supportPromptShown takes a request UUID and the time the ask showed');
            }
            return receipts.run<{ changed: boolean }>(input.requestId, JSON.stringify(['supportPromptShown', input.shownAt]), async () => {
                const written = await runStoreWrite(() => {
                    const { settings, updateSettings } = useTaskStore.getState();
                    return updateSettings({ supportPrompt: withSupportPromptShown(settings.supportPrompt, shownAtMs) });
                });
                return settleWrite(written, { changed: true });
            });
        },
    };
}
