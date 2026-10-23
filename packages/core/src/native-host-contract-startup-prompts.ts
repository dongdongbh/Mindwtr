/**
 * The native hosts' startup prompts (React Native's app/_layout.tsx queue): after the validated boot, the host asks which
 * prompt opens now (first-run onboarding, the maintainer announcement, the update reminder or the donation ask; at most one)
 * and reports what the user did with it. Core decides with RN's own descriptors (mobile-startup-prompts.ts) and queue
 * (startup-prompt-run.ts); the host draws the prompt and opens links.
 *
 * Both requests write only RN's device keys (the prompt state, the onboarding and announcement dismissals), never the
 * store: the donation ask's synced record (settings.supportPrompt) is a journaled command of its own (pass O2f, with its Kotlin
 * sender), written with the `shownAt` that `startupPromptAction` returns, as RN writes both with one time.
 */
import type { AndroidInstallerSource } from './about-settings-model';
import { ACTIVE_APP_ANNOUNCEMENT, APP_ANNOUNCEMENT_DISMISSED_VALUE, getAnnouncementDismissalStorageKey, type AppAnnouncement } from './announcements';
import { readMobileOnboardingDismissed, writeMobileOnboardingDismissed } from './first-run-onboarding';
import { translateWithFallback } from './i18n';
import {
    buildMobileStartupPromptDescriptors,
    buildUpdateReminderAnnouncement,
    fetchMobileUpdateReminderInfo,
    resolveMobileDonationPromptAllowed,
    resolveMobileUpdateReminderAllowed,
    translateDonationPromptAnnouncement,
    type MobileUpdateReminderInfo,
} from './mobile-startup-prompts';
import { coerceSupportedBackend, resolveBackend } from './mobile-sync-utils';
import type { NativeAboutHost } from './native-host-contract-about';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord } from './native-host-contract-menu-views';
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
    type UserPromptState,
} from './user-prompts';

type Deps = {
    readiness: () => NativeHostResult<null>;
    t: () => (key: string) => string;
    host: () => NativeAboutHost | null;
};

export const NATIVE_STARTUP_PROMPT_IDS = ['onboarding', 'announcement', 'update-reminder', 'donation'] as const;
export type NativeStartupPromptId = typeof NATIVE_STARTUP_PROMPT_IDS[number];

/** The prompt to open: the welcome sheet (its words come with the sheet), or the announcement window with its words. */
export type NativeStartupPrompt =
    | { id: 'onboarding' }
    | {
        id: Exclude<NativeStartupPromptId, 'onboarding'>;
        announcement: AppAnnouncement;
        /** The window's dismiss label when the prompt has none, and its close button's label. */
        notNow: string;
        closeLabel: string;
        /** The update reminder's version, sent back with its dismissal. */
        version?: string;
    };

const INSTALLER_SOURCES = new Set<string>(['play-store', 'sideload', 'unknown']);
const PROMPT_IDS = new Set<string>(NATIVE_STARTUP_PROMPT_IDS);
const ACTIONS = new Set<string>(['dismiss', 'act', 'shown']);
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

const unavailable = () => fail('ACTION_FAILED', 'Startup prompts are not available on this host');

export function createStartupPromptMethods(deps: Deps) {
    // The session (this process), as RN's queue keeps it: the prompts already opened, declined or failed, and whether today's
    // activity was recorded.
    const retired = new Set<string>();
    let activityRecorded = false;
    const resolveText = (key: string, fallback: string) => translateWithFallback(deps.t(), key, fallback);
    const warn = (host: NativeAboutHost, message: string, error: unknown) => {
        try { host.logWarn(message, error); } catch { /* best effort */ }
    };

    return {
        /**
         * The prompt that opens now, or null. The host asks again after a dismissal, as RN's queue goes on to the next prompt;
         * a prompt this process already opened, declined or failed is never tried again. The first ask records today's activity
         * first, as RN does at first paint, so the donation and update rules count this launch.
         */
        async beginStartupPrompts(input: unknown): Promise<NativeHostResult<{ prompt: NativeStartupPrompt | null }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const host = deps.host();
            if (!host) return unavailable();
            if (!isObjectRecord(input) || typeof input.installerSource !== 'string' || !INSTALLER_SOURCES.has(input.installerSource)
                || typeof input.donationEnabled !== 'boolean') {
                return fail('INVALID_INPUT', 'beginStartupPrompts takes installerSource and donationEnabled');
            }
            if (isSandboxMode()) return { ok: true, value: { prompt: null } };
            const storage = host.storage;

            // A failed read leaves the snapshot null, which keeps the donation and update prompts out, as in RN.
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
                try { host.logInfo('Native prompt activity recorded', { releaseCheck: 'v1.3.5/native-prompt-activity', outcome }); } catch { /* best effort */ }
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
                // The host asks only after its validated boot load.
                dataReady: true,
                canonicalDataReady: true,
                mobileOnboardingDismissed,
                visibleDataCount,
                // Android has no CloudKit.
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
            const id = await runStartupPromptsOnce(descriptors, {
                retired,
                onLog: (error, context) => warn(host, `Startup prompt failed: ${context.id} ${context.phase}`, error),
            });
            if (!id) return { ok: true, value: { prompt: null } };
            if (id === 'onboarding') return { ok: true, value: { prompt: { id } } };
            const words = {
                notNow: resolveText('common.notNow', 'Not now'),
                closeLabel: resolveText('announcement.dismiss', 'Dismiss announcement'),
            };
            if (id === 'announcement' && ACTIVE_APP_ANNOUNCEMENT) {
                return { ok: true, value: { prompt: { id, announcement: ACTIVE_APP_ANNOUNCEMENT, ...words } } };
            }
            if (id === 'update-reminder' && updateInfo) {
                const info: MobileUpdateReminderInfo = updateInfo;
                return { ok: true, value: { prompt: { id, announcement: buildUpdateReminderAnnouncement(info, resolveText), version: info.latestVersion, ...words } } };
            }
            if (id === 'donation') {
                return { ok: true, value: { prompt: { id, announcement: translateDonationPromptAnnouncement(resolveText), ...words } } };
            }
            return { ok: true, value: { prompt: null } };
        },

        /**
         * What the user did with the open prompt: `dismiss` (Not now, close, Back, Skip, or a finished Start), `act` (its button)
         * or `shown` (the donation window became visible). Writes RN's device keys as RN's handlers do; a failed write is logged,
         * never refused. `shown` answers the time it recorded, for the journaled supportPromptShown.
         */
        async startupPromptAction(input: unknown): Promise<NativeHostResult<{ shownAt: string | null }>> {
            const host = deps.host();
            if (!host) return unavailable();
            if (!isObjectRecord(input) || typeof input.id !== 'string' || !PROMPT_IDS.has(input.id)
                || typeof input.action !== 'string' || !ACTIONS.has(input.action)
                || !(input.version === undefined || (typeof input.version === 'string' && VERSION.test(input.version)))) {
                return fail('INVALID_INPUT', 'startupPromptAction takes a prompt id, an action and the update version');
            }
            const storage = host.storage;
            const { id, action } = input;
            try {
                if (id === 'onboarding' && action === 'dismiss') {
                    await writeMobileOnboardingDismissed(storage);
                } else if (id === 'announcement' && action !== 'shown' && ACTIVE_APP_ANNOUNCEMENT) {
                    await storage.setItem(getAnnouncementDismissalStorageKey(ACTIVE_APP_ANNOUNCEMENT.id), APP_ANNOUNCEMENT_DISMISSED_VALUE);
                } else if (id === 'update-reminder' && action !== 'shown' && typeof input.version === 'string') {
                    const latestVersion = input.version;
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
    };
}
