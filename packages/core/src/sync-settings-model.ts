/**
 * Settings › Sync: the screen's rules, shared by React Native's screen
 * (apps/mobile/components/settings/sync-settings-*.tsx) and the native host
 * contract (native-host-contract-settings-sync.ts). They moved here from the
 * screen, its panels and its cards: which backends the screen offers and which
 * one shows as chosen, the form checks, the failure messages, the last-sync card
 * and its history, the CloudKit account texts and the settings sync options.
 *
 * The transport actions (choose, test, save, Sync now, Dropbox) are
 * sync-settings-transport.ts; the encryption card is sync-encryption-card.ts.
 * Dates come from the host's `formatDateTime`: React Native keeps
 * `toLocaleString`, the contract builds the same English text from a pattern.
 */
import { decodeUriSafe } from './async-utils';
import { resolveI18nText, translateWithFallback, type I18nTemplateValues } from './i18n';
import { sanitizeLogMessage } from './log-sanitize';
import { classifySyncFailure } from './mobile-sync-utils';
import { isSettingsSyncGroupEnabled } from './settings-options';
import { listMergeConflictSamples, summarizeMergeStats, type EntityConflictSample } from './sync-log-utils';
import type { MergeStats, SyncHistoryEntry } from './sync-types';
import type { AppSettings } from './types';

type Translate = (key: string) => string;
export type SyncSettingsTranslator = (key: string, values?: I18nTemplateValues) => string;

export type SyncSettingsBackend = 'file' | 'webdav' | 'cloud' | 'cloudkit' | 'off';
export type SyncSettingsCloudProvider = 'selfhosted' | 'dropbox' | 'cloudkit';
/** A choice on the backend card; `dropbox` and `selfhosted` are the `cloud` backend's providers. */
export type SyncSettingsBackendOption = 'off' | 'file' | 'dropbox' | 'webdav' | 'selfhosted' | 'cloudkit';
export type CloudKitAccountStatus = 'available' | 'noAccount' | 'restricted' | 'temporarilyUnavailable' | 'unknown';

/** React Native's `tr`: the translation, else the English text, with `{{values}}` filled in. */
export const createSyncSettingsTranslator = (t: Translate): SyncSettingsTranslator => (
    (key, values) => resolveI18nText(t, key, { values })
);

export const isValidSyncHttpUrl = (value: string): boolean => {
    if (!value.trim()) return false;
    try {
        const url = new URL(value);
        // The native engine's URL is a small parser that accepts an empty or spaced
        // host; the platform's URL refuses both, so this changes nothing on React Native.
        return (url.protocol === 'http:' || url.protocol === 'https:') && /^[^\s]+$/.test(url.hostname);
    } catch {
        return false;
    }
};

const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Text shown anywhere but a form's own URL field (a status, the history, a toast, a
 * log line): the log sanitizer's redactions, no credentials in a URL, and none of
 * `secrets` (the configured password and token). A secret shorter than 4 characters
 * is redacted only as a whole word (letters, marks and digits of any script), never
 * inside a longer one.
 */
export const redactSyncText = (text: string, secrets: readonly (string | null | undefined)[] = []): string => {
    let result = sanitizeLogMessage(text).replace(URL_USERINFO_PATTERN, '$1');
    for (const secret of [...secrets].sort((left, right) => (right?.length ?? 0) - (left?.length ?? 0))) {
        if (!secret) continue;
        result = secret.length >= 4
            ? result.split(secret).join('[redacted]')
            : result.replace(new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}])${escapeRegExp(secret)}(?=$|[^\\p{L}\\p{M}\\p{N}])`, 'gu'), '$1[redacted]');
    }
    return result;
};

type Redact = (text: string) => string;
const redactUrlText: Redact = (text) => redactSyncText(text);

export const formatSyncClockSkew = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
    const minutes = seconds / 60;
    return `${minutes.toFixed(1)} min`;
};

export type SyncBackendGroup = { title: string; description: string; options: SyncSettingsBackendOption[] };

/** The backend card's groups: Dropbox only on builds that are not FOSS, iCloud only where CloudKit runs. */
export const getSyncBackendGroups = (input: { t: Translate; isFossBuild: boolean; supportsCloudKit: boolean }): SyncBackendGroup[] => [
    {
        title: input.t('settings.syncBackendGroupCloud'),
        description: input.t('settings.syncBackendGroupCloudDesc'),
        options: [
            ...(!input.isFossBuild ? (['dropbox'] as const) : []),
            ...(input.supportsCloudKit ? (['cloudkit'] as const) : []),
        ],
    },
    {
        title: input.t('settings.syncBackendGroupFile'),
        description: input.t('settings.syncBackendGroupFileDesc'),
        options: ['file'],
    },
    {
        title: input.t('settings.syncBackendGroupAdvanced'),
        description: input.t('settings.syncBackendGroupAdvancedDesc'),
        options: ['webdav', 'selfhosted'],
    },
];

/** Every choice on the backend card, in order: Off first, then each group's. */
export const getSyncBackendOptions = (groups: readonly SyncBackendGroup[]): SyncSettingsBackendOption[] => [
    'off',
    ...groups.flatMap((group) => group.options),
];

export type SyncBackendSelectionInput = {
    syncBackend: SyncSettingsBackend;
    cloudProvider: SyncSettingsCloudProvider;
    isFossBuild: boolean;
    supportsCloudKit: boolean;
};

/** What the chosen backend and provider mean on screen. */
export const resolveSyncBackendSelection = (input: SyncBackendSelectionInput) => {
    const { syncBackend, cloudProvider, isFossBuild, supportsCloudKit } = input;
    return {
        isCloudSyncSelected: syncBackend === 'cloud' || syncBackend === 'cloudkit',
        isSelfHostedSyncSelected: syncBackend === 'cloud' && (cloudProvider === 'selfhosted' || isFossBuild),
        isDropboxSyncSelected: syncBackend === 'cloud' && cloudProvider === 'dropbox' && !isFossBuild,
        isCloudKitSyncSelected: syncBackend === 'cloudkit' && cloudProvider === 'cloudkit' && supportsCloudKit,
        // Encryption covers the backends Mindwtr writes whole blobs to; the self-hosted
        // cloud and CloudKit keep structured server-side state and are out of scope.
        isEncryptionCapableBackend: syncBackend === 'file'
            || syncBackend === 'webdav'
            || (syncBackend === 'cloud' && cloudProvider === 'dropbox' && !isFossBuild),
    };
};
export type SyncBackendSelection = ReturnType<typeof resolveSyncBackendSelection>;

export const isSyncBackendOptionSelected = (
    option: SyncSettingsBackendOption,
    syncBackend: SyncSettingsBackend,
    selection: SyncBackendSelection,
): boolean => {
    switch (option) {
        case 'off':
        case 'file':
        case 'webdav':
            return syncBackend === option;
        case 'dropbox':
            return selection.isDropboxSyncSelected;
        case 'selfhosted':
            return selection.isSelfHostedSyncSelected;
        case 'cloudkit':
            return selection.isCloudKitSyncSelected;
    }
};

export const getSyncBackendOptionLabel = (option: SyncSettingsBackendOption, t: Translate): string => {
    switch (option) {
        case 'off':
            return t('settings.syncBackendOff');
        case 'file':
            return t('settings.syncBackendFile');
        case 'dropbox':
            return t('settings.cloudProviderDropbox');
        case 'webdav':
            return t('settings.syncBackendWebdav');
        case 'selfhosted':
            return t('settings.cloudProviderSelfHosted');
        case 'cloudkit':
            return 'iCloud';
    }
};

/** The backend card's description line: the backend in use. */
export const getSyncBackendCurrentLabel = (syncBackend: SyncSettingsBackend, selection: SyncBackendSelection, t: Translate): string => (
    syncBackend === 'off'
        ? t('settings.syncBackendOff')
        : syncBackend === 'file'
            ? t('settings.syncBackendFile')
            : syncBackend === 'webdav'
                ? t('settings.syncBackendWebdav')
                : selection.isCloudKitSyncSelected
                    ? 'iCloud (CloudKit)'
                    : selection.isDropboxSyncSelected
                        ? t('settings.cloudProviderDropbox')
                        : t('settings.cloudProviderSelfHosted')
);

/** The toast message for a failed sync or activation. */
export const getSyncFailureMessage = (error: unknown, t: Translate): string => {
    switch (classifySyncFailure(error)) {
        case 'offline':
            return t('settings.syncFailureOffline');
        case 'auth':
            return t('settings.syncFailureAuth');
        case 'permission':
            return t('settings.syncFailurePermission');
        case 'rateLimited':
            return t('settings.syncFailureRateLimited');
        case 'misconfigured':
            return t('settings.syncFailureMisconfigured');
        case 'conflict':
            return t('settings.syncFailureConflict');
        case 'encryptionState':
            return t('settings.syncEncryptionStateUnavailable');
        case 'encryption':
            return t('settings.syncFailureEncryption');
        case 'fileLockUnavailable':
            return t('settings.syncFileLockUnavailable');
        case 'fileGenerationCorrupt':
            return t('settings.syncFileGenerationCorrupt');
        default: {
            // An unclassified failure used to show only "Review Settings → Sync and
            // try again", which hid the one line that named the cause (#1151).
            const raw = (error instanceof Error ? error.message : String(error ?? '')).trim();
            // File Sync's internal read codes are for the log, not the toast.
            const detail = /SAF_DOCUMENTS?_[A-Z_]+/.test(raw) ? '' : redactSyncText(raw);
            return detail ? `${t('settings.syncFailureGeneric')}\n${detail}` : t('settings.syncFailureGeneric');
        }
    }
};

/**
 * The last-sync card's error line: File Sync's lock and generation failures read as
 * their guidance. `redact` is the transport's (the configured secrets too).
 */
export const getSyncLastErrorText = (lastSyncError: string | undefined, t: Translate, redact: Redact = redactUrlText): string | undefined => (
    classifySyncFailure(lastSyncError) === 'fileLockUnavailable'
        ? t('settings.syncFileLockUnavailable')
        : classifySyncFailure(lastSyncError) === 'fileGenerationCorrupt'
            ? t('settings.syncFileGenerationCorrupt')
            : lastSyncError === undefined ? undefined : redact(lastSyncError)
);

export type CloudKitStatusDetails = { label: string; helpText: string; syncEnabled: boolean };

export const getCloudKitStatusDetails = (status: CloudKitAccountStatus, tr: SyncSettingsTranslator): CloudKitStatusDetails => {
    switch (status) {
        case 'available':
            return {
                label: tr('settings.syncMobile.signedInToIcloud'),
                helpText: tr('settings.syncMobile.syncsYourTasksProjectsAndAreasAcrossAppleDevicesUsing'),
                syncEnabled: true,
            };
        case 'noAccount':
            return {
                label: tr('settings.syncMobile.icloudSignInRequired'),
                helpText: tr('settings.syncMobile.thisDeviceIsNotSignedIntoIcloudOpenIosSettings'),
                syncEnabled: false,
            };
        case 'restricted':
            return {
                label: tr('settings.syncMobile.icloudRestricted'),
                helpText: tr('settings.syncMobile.cloudkitIsRestrictedOnThisDeviceCheckScreenTimeMdm'),
                syncEnabled: false,
            };
        case 'temporarilyUnavailable':
            return {
                label: tr('settings.syncMobile.icloudTemporarilyUnavailable'),
                helpText: tr('settings.syncMobile.icloudIsTemporarilyUnavailableWaitAMomentThenTapSync'),
                syncEnabled: false,
            };
        case 'unknown':
        default:
            return {
                label: tr('settings.syncMobile.icloudStatusUnavailable'),
                helpText: tr('settings.syncMobile.syncsYourTasksProjectsAndAreasAcrossAppleDevicesUsing2'),
                syncEnabled: true,
            };
    }
};

type NamedEntity = { id: string; title?: string; name?: string };
export type SyncConflictEntities = {
    tasks: readonly NamedEntity[];
    projects: readonly NamedEntity[];
    sections: readonly NamedEntity[];
    areas: readonly NamedEntity[];
    people: readonly NamedEntity[];
};

/** A conflict's row title (or name), else its ID. */
const findConflictTitle = (sample: EntityConflictSample, entities: SyncConflictEntities): string => {
    const { id } = sample;
    const list = sample.entity === 'task'
        ? entities.tasks
        : sample.entity === 'project'
            ? entities.projects
            : sample.entity === 'section'
                ? entities.sections
                : sample.entity === 'area'
                    ? entities.areas
                    : entities.people;
    const entity = list.find((item) => item.id === id);
    if (!entity) return id;
    return ('title' in entity ? entity.title : entity.name) || id;
};

/** The last sync's resolved conflicts, up to six, and how many more there were. */
export const buildSyncConflictLines = (stats: MergeStats | null | undefined, entities: SyncConflictEntities, t: Translate): string[] => {
    const samples = listMergeConflictSamples(stats).slice(0, 6);
    if (samples.length === 0) return [];
    const lines = samples.map((sample) => {
        const outcome = sample.winner === 'incoming'
            ? translateWithFallback(t, 'settings.syncConflictKeptOtherDevice', 'kept the synced version')
            : translateWithFallback(t, 'settings.syncConflictKeptThisDevice', "kept this device's version");
        const detail = sample.reasons.includes('deleteState')
            ? translateWithFallback(t, 'settings.syncConflictDeleteRestore', 'delete vs. edit')
            : sample.diffKeys.length > 0
                ? translateWithFallback(t, 'settings.syncConflictChanged', 'changed: {{fields}}').replace('{{fields}}', sample.diffKeys.join(', '))
                : '';
        const title = findConflictTitle(sample, entities);
        return detail ? `“${title}” — ${outcome} (${detail})` : `“${title}” — ${outcome}`;
    });
    const totalConflicts = summarizeMergeStats(stats).conflicts;
    if (totalConflicts > samples.length) {
        lines.push(
            translateWithFallback(t, 'settings.syncConflictMore', '+{{count}} more resolved conflicts')
                .replace('{{count}}', String(totalConflicts - samples.length)),
        );
    }
    return lines;
};

/** What the last-sync card counts: the stats show after a success or a conflict. */
export const getSyncLastStatusSummary = (settings: Pick<AppSettings, 'lastSyncStats' | 'lastSyncStatus'>) => {
    const lastSyncStats = settings.lastSyncStats ?? null;
    const summary = summarizeMergeStats(lastSyncStats);
    return {
        lastSyncStats,
        showLastSyncStats: Boolean(lastSyncStats) && (settings.lastSyncStatus === 'success' || settings.lastSyncStatus === 'conflict'),
        conflictCount: summary.conflicts,
        maxClockSkewMs: summary.maxClockSkewMs,
        timestampAdjustments: summary.timestampAdjustments,
        conflictIds: summary.conflictIds.slice(0, 6),
    };
};

/** The card's first line: when the last sync ran, and whether it failed or had conflicts. */
export const getSyncLastStatusLine = (
    settings: Pick<AppSettings, 'lastSyncAt' | 'lastSyncStatus'>,
    t: Translate,
    formatDateTime: (iso: string) => string,
): string => [
    settings.lastSyncAt ? formatDateTime(settings.lastSyncAt) : t('settings.lastSyncNever'),
    settings.lastSyncStatus === 'error' ? t('settings.syncStatusFailedSuffix') : '',
    settings.lastSyncStatus === 'conflict' ? t('settings.syncStatusConflictsSuffix') : '',
].join('');

/** The five newest history entries, one line each; `redact` as for getSyncLastErrorText. */
export const buildSyncHistoryLines = (
    history: readonly SyncHistoryEntry[] | undefined,
    t: Translate,
    formatDateTime: (iso: string) => string,
    redact: Redact = redactUrlText,
): string[] => (history ?? []).slice(0, 5).map((entry) => {
    const statusLabel = entry.status === 'success'
        ? t('settings.lastSyncSuccess')
        : entry.status === 'conflict'
            ? t('settings.lastSyncConflict')
            : t('settings.lastSyncError');
    const details = [
        entry.backend ? `${t('settings.syncHistoryBackend')}: ${entry.backend}` : null,
        entry.type ? `${t('settings.syncHistoryType')}: ${entry.type}` : null,
        entry.conflicts ? `${t('settings.lastSyncConflicts')}: ${entry.conflicts}` : null,
        entry.maxClockSkewMs > 0 ? `${t('settings.lastSyncSkew')}: ${formatSyncClockSkew(entry.maxClockSkewMs)}` : null,
        entry.timestampAdjustments > 0 ? `${t('settings.lastSyncAdjusted')}: ${entry.timestampAdjustments}` : null,
        entry.details ? `${t('settings.syncHistoryDetails')}: ${redact(entry.details)}` : null,
    ].filter(Boolean);
    return `${formatDateTime(entry.at)} • ${statusLabel}`
        + (details.length ? ` • ${details.join(' • ')}` : '')
        + (entry.status === 'error' && entry.error ? ` • ${redact(entry.error)}` : '');
});

export const SYNC_PREFERENCE_KEYS = ['appearance', 'language', 'gtd', 'savedFilters', 'externalCalendars', 'ai'] as const;
export type SyncPreferenceKey = (typeof SYNC_PREFERENCE_KEYS)[number];

/** Which settings groups sync: GTD syncs unless turned off, the others only when turned on. */
export const getSyncPreferenceValues = (syncPreferences: AppSettings['syncPreferences']): Record<SyncPreferenceKey, boolean> => {
    const preferences = syncPreferences ?? {};
    return {
        appearance: preferences.appearance === true,
        language: preferences.language === true,
        gtd: isSettingsSyncGroupEnabled(preferences, 'gtd'),
        savedFilters: preferences.savedFilters === true,
        externalCalendars: preferences.externalCalendars === true,
        ai: preferences.ai === true,
    };
};

/** The settings write for one sync option; the other stored options keep their values. */
export const buildSyncPreferencesUpdate = (
    syncPreferences: AppSettings['syncPreferences'],
    partial: Partial<Record<SyncPreferenceKey, boolean>>,
): Pick<AppSettings, 'syncPreferences'> => ({ syncPreferences: { ...(syncPreferences ?? {}), ...partial } });

/** The settings sync options card's rows, in screen order. */
export const buildSyncPreferenceRows = (syncPreferences: AppSettings['syncPreferences'], t: Translate) => {
    const values = getSyncPreferenceValues(syncPreferences);
    const label: Record<SyncPreferenceKey, string> = {
        appearance: t('settings.syncPreferenceAppearance'),
        language: t('settings.syncPreferenceLanguage'),
        gtd: t('settings.syncPreferenceGtd'),
        savedFilters: translateWithFallback(t, 'settings.syncPreferenceSavedFilters', 'Saved filters'),
        externalCalendars: t('settings.syncPreferenceExternalCalendars'),
        ai: t('settings.syncPreferenceAi'),
    };
    return SYNC_PREFERENCE_KEYS.map((key) => ({
        key,
        label: label[key],
        hint: key === 'ai' ? t('settings.syncPreferenceAiHint') : null,
        value: values[key],
    }));
};

/** The WebDAV form as typed: a URL that is not http(s) shows the error, and the actions need a valid URL. */
export const getSyncWebDavFormState = (url: string) => {
    const urlError = url.trim() ? !isValidSyncHttpUrl(url.trim()) : false;
    return { urlError, canUseActions: url.trim().length > 0 && !urlError };
};

/**
 * The self-hosted form as typed. An empty token is valid (a server may run without
 * auth); only a non-empty token that fails the shape check is refused.
 */
export const getSyncSelfHostedFormState = (url: string, token: string, isValidToken: (token: string) => boolean) => {
    const urlError = url.trim() ? !isValidSyncHttpUrl(url.trim()) : false;
    const tokenError = token.trim() ? !isValidToken(token.trim()) : false;
    return { urlError, tokenError, canUseActions: url.trim().length > 0 && !urlError && !tokenError };
};

/**
 * The File Sync panel's folder line: the name of the stored location's last part.
 * An Android document URI ends in its percent-encoded document ID
 * ("primary%3ASync%2Fdata.json"); its name is the ID's last path part.
 */
export const getSyncFolderLabel = (syncPath: string | null, t: Translate): string | undefined => {
    if (!syncPath) return t('common.notSet');
    const leaf = syncPath.split('/').pop() ?? '';
    const name = decodeUriSafe(leaf).split('/').pop() ?? leaf;
    return (syncPath.startsWith('content://') ? name.slice(name.lastIndexOf(':') + 1) : name) || leaf;
};

/** The sync badge's state: the Menu tab's dot and the Settings menu's Sync row (moved from React Native's lib/sync-badge.ts). */
export type SyncBadgeState = 'hidden' | 'syncing' | 'healthy' | 'attention';

export function resolveSyncBadgeState(params: {
    configured: boolean;
    activityState: 'idle' | 'syncing';
    pendingRemoteWriteAt?: AppSettings['pendingRemoteWriteAt'];
    /** A local change waits in the automatic-sync scheduler (#1431): not yet uploaded. */
    localChangePending?: boolean;
    lastSyncStatus?: AppSettings['lastSyncStatus'];
    lastSyncAt?: AppSettings['lastSyncAt'];
}): SyncBadgeState {
    const {
        configured,
        activityState,
        pendingRemoteWriteAt,
        localChangePending,
        lastSyncStatus,
        lastSyncAt,
    } = params;

    if (!configured) return 'hidden';
    if (activityState === 'syncing') return 'syncing';
    if (lastSyncStatus === 'error') return 'attention';
    if (pendingRemoteWriteAt || localChangePending) return 'syncing';
    if (lastSyncStatus === 'success' || lastSyncStatus === 'conflict') return 'healthy';
    if (lastSyncAt) return 'healthy';

    return 'attention';
}
