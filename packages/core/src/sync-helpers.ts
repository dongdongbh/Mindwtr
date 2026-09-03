import type { AppData, Attachment } from './types';
import { normalizeSavedFilters } from './saved-filters';
import { getGtdSyncSnapshot, isSettingsSyncGroupEnabled } from './settings-options';
import { normalizeRevision } from './sync-revision';
import { SYNC_FILE_NAME } from './sync-service-utils';
import {
    compactPurgedProjectTombstone,
    compactPurgedTaskTombstone,
    compactSectionsForPurgedProjects,
} from './tombstone-compaction';

const MISSING_ATTACHMENT_TIMESTAMP_SENTINEL = '1970-01-01T00:00:00.000Z';
const MISSING_SETTINGS_SYNC_TIMESTAMP_SENTINEL = '1970-01-01T00:00:00.000Z';

const advanceLatestSyncTimestamp = (...values: Array<string | undefined>): string | undefined => {
    let latestTime = Date.parse(MISSING_SETTINGS_SYNC_TIMESTAMP_SENTINEL);
    for (const value of values) {
        const parsed = Date.parse(value ?? '');
        if (Number.isFinite(parsed) && parsed > latestTime) latestTime = parsed;
    }
    if (!Number.isFinite(latestTime)) return undefined;
    const advanced = new Date(latestTime + 1);
    return Number.isFinite(advanced.getTime()) ? advanced.toISOString() : undefined;
};

export type SoftDeletable = {
    deletedAt?: string | null;
};

export function filterNotDeleted<T extends SoftDeletable>(items: readonly T[]): T[] {
    return items.filter((item) => !item.deletedAt);
}

export type PendingAttachmentUpload = {
    ownerType: 'task' | 'project';
    ownerId: string;
    attachmentId: string;
    title: string;
    uriScheme: string;
    localStatus?: Attachment['localStatus'];
    reason: 'content-replacement' | 'missing-cloud-key';
};

export const normalizeWebdavUrl = (rawUrl: string): string => {
    const splitIndex = rawUrl.search(/[?#]/);
    const pathEnd = splitIndex >= 0 ? splitIndex : rawUrl.length;
    const path = rawUrl.slice(0, pathEnd).replace(/\/+$/, '');
    const suffix = rawUrl.slice(pathEnd);
    const lowerPath = path.toLowerCase();
    const normalizedPath = lowerPath.endsWith(`/${SYNC_FILE_NAME}`) || lowerPath.endsWith('.json')
        ? path
        : `${path}/${SYNC_FILE_NAME}`;

    if (!suffix) return normalizedPath;
    const hashIndex = suffix.indexOf('#');
    const queryPart = suffix.startsWith('?')
        ? suffix.slice(0, hashIndex >= 0 ? hashIndex : suffix.length)
        : '';
    const hashPart = hashIndex >= 0 ? suffix.slice(hashIndex) : (suffix.startsWith('#') ? suffix : '');
    if (!queryPart) return `${normalizedPath}${hashPart}`;

    const params = new URLSearchParams(queryPart.slice(1));
    params.delete('_');
    const query = params.toString();
    return `${normalizedPath}${query ? `?${query}` : ''}${hashPart}`;
};

export const normalizeCloudUrl = (rawUrl: string): string => {
    const trimmed = rawUrl.replace(/\/+$/, '');
    const lower = trimmed.toLowerCase();

    if (lower.endsWith('/v1/data') || lower.endsWith('/data')) {
        return trimmed;
    }

    if (/\/v\d+$/i.test(trimmed)) {
        return `${trimmed}/data`;
    }

    return `${trimmed}/v1/data`;
};

const isLocalAttachmentUri = (uri: string): boolean => {
    const trimmed = uri.trim();
    if (!trimmed) return false;
    return !/^https?:\/\//i.test(trimmed);
};

const getAttachmentUriScheme = (uri: string): string => {
    const trimmed = uri.trim();
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
    return match?.[1]?.toLowerCase() ?? (trimmed ? 'file' : 'empty');
};

const isLocalCalendarSourceUrl = (url: string): boolean => {
    const normalized = url.trim().toLowerCase();
    return normalized.startsWith('file://') || normalized.startsWith('content://');
};

const collectPendingUploads = (
    ownerType: PendingAttachmentUpload['ownerType'],
    ownerId: string,
    attachments?: Attachment[]
): PendingAttachmentUpload[] => {
    if (!attachments || attachments.length === 0) return [];

    return attachments
        .filter((attachment) => {
            if (attachment.kind !== 'file') return false;
            if (attachment.deletedAt) return false;
            if (attachment.pendingContentUpload === true) return true;
            if (attachment.cloudKey) return false;
            if (!isLocalAttachmentUri(attachment.uri)) return false;
            if (attachment.localStatus === 'missing') return false;
            return true;
        })
        .map((attachment) => ({
            ownerType,
            ownerId,
            attachmentId: attachment.id,
            title: attachment.title,
            uriScheme: getAttachmentUriScheme(attachment.uri),
            localStatus: attachment.localStatus,
            reason: attachment.pendingContentUpload === true
                ? 'content-replacement'
                : 'missing-cloud-key',
        }));
};

export const findPendingAttachmentUploads = (data: AppData): PendingAttachmentUpload[] => {
    const pending: PendingAttachmentUpload[] = [];

    for (const task of data.tasks) {
        if (task.deletedAt) continue;
        pending.push(...collectPendingUploads('task', task.id, task.attachments));
    }

    for (const project of data.projects) {
        if (project.deletedAt) continue;
        pending.push(...collectPendingUploads('project', project.id, project.attachments));
    }

    return pending;
};

const assertNoPendingUploadList = (pending: PendingAttachmentUpload[]): void => {
    if (pending.length === 0) return;

    const sample = pending
        .slice(0, 3)
        .map((item) => `${item.ownerType}:${item.ownerId}:${item.attachmentId}`)
        .join(', ');
    const extra = pending.length > 3 ? `, +${pending.length - 3} more` : '';
    throw new Error(
        `Attachment upload incomplete: ${pending.length} file attachment(s) are still pending upload (${sample}${extra}).`
    );
};

export const assertNoPendingAttachmentUploads = (data: AppData): void => {
    assertNoPendingUploadList(findPendingAttachmentUploads(data));
};

export const assertNoPendingAttachmentContentReplacements = (data: AppData): void => {
    assertNoPendingUploadList(
        findPendingAttachmentUploads(data).filter((item) => item.reason === 'content-replacement'),
    );
};

export const hasPendingSyncSideEffects = (data: AppData): boolean => (
    Boolean(data.settings.pendingRemoteWriteAt)
    || findPendingAttachmentUploads(data).length > 0
    || Boolean(data.settings.attachments?.pendingRemoteDeletes?.length)
);

const sanitizeSettingsForRemote = (settings: AppData['settings']): AppData['settings'] => {
    const prefs = settings.syncPreferences ?? {};
    const remotePrefs = { ...prefs };
    let remotePrefsUpdatedAt = settings.syncPreferencesUpdatedAt
        ? { ...settings.syncPreferencesUpdatedAt }
        : undefined;
    if (isSettingsSyncGroupEnabled(prefs, 'gtd')) {
        // Current clients treat a missing GTD preference as enabled. Materialize
        // that effective value only in the wire snapshot so RC.2 peers, which
        // require explicit true, do not strip the synced GTD fields on upload.
        remotePrefs.gtd = true;
        if (prefs.gtd === undefined) {
            // RC.2 merges the whole preference map before deciding whether GTD
            // fields may upload. Advance the wire-only true one deterministic
            // tick past both relevant generations so an equal copied timestamp
            // cannot deadlock, without advancing the persisted setting.
            const materializedAt = advanceLatestSyncTimestamp(
                remotePrefsUpdatedAt?.preferences,
                remotePrefsUpdatedAt?.gtd,
            );
            if (materializedAt) {
                remotePrefsUpdatedAt = { ...remotePrefsUpdatedAt, preferences: materializedAt };
            }
        }
    }
    const next: AppData['settings'] = {
        syncPreferences: remotePrefs,
        syncPreferencesUpdatedAt: remotePrefsUpdatedAt,
    };

    if (prefs.appearance === true) {
        next.theme = settings.theme;
        next.appearance = settings.appearance ? { ...settings.appearance } : settings.appearance;
        next.keybindingStyle = settings.keybindingStyle;
        // Desktop global shortcut registration is local runtime behavior and should never sync.
        next.globalQuickAddShortcut = undefined;
    }

    if (prefs.language === true) {
        next.language = settings.language;
        next.weekStart = settings.weekStart;
        next.dateFormat = settings.dateFormat;
        next.timeFormat = settings.timeFormat;
    }

    if (isSettingsSyncGroupEnabled(prefs, 'gtd')) {
        const gtdSnapshot = getGtdSyncSnapshot(settings);
        next.gtd = gtdSnapshot.gtd;
        next.quickAddAutoClean = gtdSnapshot.quickAddAutoClean;
        next.markdownEditorAssist = gtdSnapshot.markdownEditorAssist;
        next.features = gtdSnapshot.features;
    }

    if (prefs.savedFilters === true) {
        next.savedFilters = normalizeSavedFilters(settings.savedFilters);
    }

    if (prefs.externalCalendars === true) {
        next.externalCalendars = settings.externalCalendars
            ? settings.externalCalendars
                .filter((item) => !isLocalCalendarSourceUrl(item.url))
                .map((item) => ({ ...item }))
            : settings.externalCalendars;
    }

    if (prefs.ai === true && settings.ai) {
        next.ai = {
            ...settings.ai,
            apiKey: undefined,
            speechToText: settings.ai.speechToText
                ? {
                    ...settings.ai.speechToText,
                    offlineModelPath: undefined,
                }
                : settings.ai.speechToText,
        };
    }

    return next;
};

export const sanitizeAppDataForRemote = (data: AppData): AppData => {
    const hasNonEmptyValue = (value: unknown): boolean => (
        typeof value === 'string' && value.trim().length > 0
    );
    const sanitizeAttachments = (attachments?: Attachment[], ownerDeleted = false): Attachment[] | undefined => {
        if (!attachments) return attachments;
        return attachments.map((attachment) => {
            if (attachment.kind !== 'file') return attachment;
            const hasCloudKey = hasNonEmptyValue(attachment.cloudKey);
            if (!attachment.deletedAt) {
                if ((ownerDeleted && !hasCloudKey) || (attachment.localStatus === 'missing' && !hasCloudKey)) {
                    const fallbackUpdatedAt = hasNonEmptyValue(attachment.updatedAt)
                        ? attachment.updatedAt
                        : MISSING_ATTACHMENT_TIMESTAMP_SENTINEL;
                    return {
                        ...attachment,
                        deletedAt: fallbackUpdatedAt,
                        updatedAt: fallbackUpdatedAt,
                        uri: '',
                        localStatus: undefined,
                        contentMtimeMs: undefined,
                        contentSize: undefined,
                        pendingContentUpload: undefined,
                    };
                }
            }
            return {
                ...attachment,
                uri: '',
                localStatus: undefined,
                // #1057 (review B1): recorded mtime/size describe THIS device's disk file
                // and must never travel — two devices holding byte-identical content would
                // otherwise carry permanently different values for a field the merge (and
                // the fast unchanged-check) both compare, causing a remote write every cycle
                // forever. Only `contentRev`/`fileHash` are synced content-identity; each
                // device re-derives its own stat locally after its own upload/download.
                contentMtimeMs: undefined,
                contentSize: undefined,
                pendingContentUpload: undefined,
            };
        });
    };

    return {
        ...data,
        tasks: data.tasks.map((task) => task.purgedAt
            ? compactPurgedTaskTombstone(task)
            : {
                ...task,
                attachments: sanitizeAttachments(task.attachments, Boolean(task.deletedAt)),
            }),
        projects: data.projects.map((project) => project.purgedAt
            ? compactPurgedProjectTombstone(project)
            : {
                ...project,
                attachments: sanitizeAttachments(project.attachments, Boolean(project.deletedAt)),
            }),
        sections: compactSectionsForPurgedProjects(data.sections, data.projects),
        settings: sanitizeSettingsForRemote(data.settings),
    };
};

const isIdKeyed = (item: unknown): item is { id: string } => (
    !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
);

// Lists of id-keyed records (entities, attachments, checklist items) compare
// by content, not position. A merge emits the local side's order first, so two
// devices that added records concurrently hold the same set in different
// orders forever; comparing positionally made every fingerprint differ, every
// cycle upload, and the self-hosted server report a merge each time (#1136).
// Position carries no meaning for these lists: ordering lives in explicit
// order fields, and every reorder bumps the owner's updatedAt anyway.
const normalizeForSyncComparison = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        const items = value.map((item) => normalizeForSyncComparison(item));
        if (items.length > 1 && items.every(isIdKeyed)) {
            items.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        }
        return items;
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const normalized: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            normalized[key] = normalizeForSyncComparison(record[key]);
        }
        return normalized;
    }
    return value;
};

export const areSyncPayloadsEqual = (left: AppData, right: AppData): boolean =>
    JSON.stringify(normalizeForSyncComparison(left)) === JSON.stringify(normalizeForSyncComparison(right));

export const toStableSyncJson = (value: unknown): string =>
    JSON.stringify(normalizeForSyncComparison(value));

const hashStableSyncJson = (value: string): string => {
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        left ^= code;
        left = Math.imul(left, 0x01000193);
        right ^= code + index;
        right = Math.imul(right, 0x85ebca6b);
        right ^= right >>> 13;
    }
    return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
};

export const computeStableValueFingerprint = (value: unknown): string => {
    const json = toStableSyncJson(value);
    return `stable-v2:${json.length}:${hashStableSyncJson(json)}`;
};

export const computeSyncPayloadFingerprint = (data: AppData): string =>
    computeStableValueFingerprint(sanitizeAppDataForRemote(data));

/**
 * Sync's own status bookkeeping fields. Writes to these never mark the store
 * dirty (store-settings builds its non-mutating list from this), and the
 * covered-settings fingerprint below ignores them because the sync cycle
 * itself rewrites them while it runs.
 */
export const SYNC_STATUS_BOOKKEEPING_SETTINGS_KEYS = [
    'lastSyncAt',
    'lastSyncStatus',
    'lastSyncError',
    'pendingRemoteWriteAt',
    'pendingRemoteWriteRetryAt',
    'pendingRemoteWriteAttempts',
    'lastSyncStats',
    'lastSyncHistory',
] as const satisfies readonly (keyof AppData['settings'])[];

/**
 * Fingerprint of the settings a sync apply would overwrite, including the
 * device-local fields that sanitizeSettingsForRemote strips from the payload
 * (e.g. `filters`, the sidebar area selection). The payload fingerprint alone
 * cannot see those fields, so a covered-snapshot check that trusts it would
 * let the cycle's finalize revert a device-local change made mid-sync (#316).
 * Sync status bookkeeping is excluded — the running cycle mutates it.
 */
export const computeCoveredSettingsFingerprint = (settings: AppData['settings']): string => {
    const comparable: Record<string, unknown> = { ...(settings ?? {}) };
    for (const key of SYNC_STATUS_BOOKKEEPING_SETTINGS_KEYS) {
        delete comparable[key];
    }
    return computeStableValueFingerprint(comparable);
};

/**
 * JSON-value equality with no intermediate object graph and an exit at the
 * first difference — the cheap way to ask "are these two documents the same"
 * when the answer is usually no. A missing key and an explicitly-undefined one
 * compare equal, matching what a stable serialize emits: the sync merge
 * normalizers deliberately emit explicit-undefined keys (#766), which must not
 * read as a difference against a JSON round-tripped twin.
 */
export const isDeepJsonEqual = (left: unknown, right: unknown): boolean => {
    if (left === right) return true;
    if (left === null || right === null) return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
            if (!isDeepJsonEqual(left[index], right[index])) return false;
        }
        return true;
    }
    if (typeof left !== 'object' || typeof right !== 'object') return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    let definedInLeft = 0;
    for (const key of Object.keys(leftRecord)) {
        const leftValue = leftRecord[key];
        if (leftValue === undefined) {
            if (rightRecord[key] !== undefined) return false;
            continue;
        }
        if (!isDeepJsonEqual(leftValue, rightRecord[key])) return false;
        definedInLeft += 1;
    }
    let definedInRight = 0;
    for (const key of Object.keys(rightRecord)) {
        if (rightRecord[key] !== undefined) definedInRight += 1;
    }
    return definedInLeft === definedInRight;
};

const withoutSyncStatusBookkeeping = (settings: AppData['settings']): Record<string, unknown> => {
    const comparable: Record<string, unknown> = { ...(settings ?? {}) };
    for (const key of SYNC_STATUS_BOOKKEEPING_SETTINGS_KEYS) {
        delete comparable[key];
    }
    return comparable;
};

/**
 * True when persisting `candidate` over `stored` would change nothing durable.
 *
 * Everything a local write persists is compared, not just the transport
 * payload: `sanitizeAppDataForRemote` strips attachment `uri`, `localStatus`,
 * the recorded content stats, `pendingContentUpload`, the uncompacted half of
 * a purged tombstone and every device-local setting, all of which are real
 * local content that a skipped write would silently drop. Only the sync
 * bookkeeping the running cycle rewrites by design is excluded.
 */
export const isLocalPersistEquivalent = (candidate: AppData, stored: AppData): boolean => {
    if (candidate === stored) return true;
    if (!isDeepJsonEqual(
        withoutSyncStatusBookkeeping(candidate.settings),
        withoutSyncStatusBookkeeping(stored.settings),
    )) return false;
    return isDeepJsonEqual(
        { ...candidate, settings: undefined },
        { ...stored, settings: undefined },
    );
};

type RevisionedEntity = {
    id: string;
    rev?: number;
    revBy?: string;
    updatedAt?: string;
    deletedAt?: string;
    purgedAt?: string;
};

const appendEntityRevisions = (parts: string[], entities: readonly RevisionedEntity[] | undefined): void => {
    parts.push(String(entities?.length ?? 0));
    for (const entity of entities ?? []) {
        parts.push(
            `${entity.id}|${normalizeRevision(entity.rev)}|${entity.revBy ?? ''}|${entity.updatedAt ?? ''}|${entity.deletedAt ?? ''}|${entity.purgedAt ?? ''}`
        );
    }
};

/**
 * Cheap "did anything sync-worthy change since last time" fingerprint.
 *
 * computeSyncPayloadFingerprint answers the same question, but it deep clones,
 * sanitizes, key-sorts and hashes the whole library — measured at ~5 s per
 * store change on a 5k-task Android library, blocking every tap behind it
 * (#766). Every synced write bumps rev/updatedAt, and that same tuple is what
 * reconcileEntityCollection already trusts when it decides an in-memory entity
 * is unchanged, so digesting the tuples plus the (small) sanitized settings
 * answers the change question at a fraction of the cost. Use the payload
 * fingerprint when the bytes themselves matter (remote comparison); use this
 * one when the only question is whether to schedule work.
 */
export const computeSyncChangeFingerprint = (data: AppData): string => {
    const parts: string[] = [];
    appendEntityRevisions(parts, data.tasks);
    appendEntityRevisions(parts, data.projects);
    appendEntityRevisions(parts, data.sections);
    appendEntityRevisions(parts, data.areas);
    appendEntityRevisions(parts, data.people);
    parts.push(computeStableValueFingerprint(sanitizeSettingsForRemote(data.settings ?? {})));
    const digest = parts.join('\n');
    return `change-v1:${digest.length}:${hashStableSyncJson(digest)}`;
};

type ExternalCalendarProvider = {
    load: () => Promise<AppData['settings']['externalCalendars'] | undefined>;
    save: (calendars: AppData['settings']['externalCalendars'] | undefined) => Promise<void>;
    onWarn?: (message: string, error?: unknown) => void;
};

export const injectExternalCalendars = async (
    data: AppData,
    provider: ExternalCalendarProvider
): Promise<AppData> => {
    if (data.settings.syncPreferences?.externalCalendars !== true) return data;
    try {
        const stored = await provider.load();
        if (!stored || stored.length === 0) return data;
        if (data.settings.externalCalendars && data.settings.externalCalendars.length > 0) {
            return data;
        }
        return {
            ...data,
            settings: {
                ...data.settings,
                externalCalendars: stored,
            },
        };
    } catch (error) {
        provider.onWarn?.('Failed to load external calendars for sync', error);
        return data;
    }
};

export const persistExternalCalendars = async (
    data: AppData,
    provider: ExternalCalendarProvider
): Promise<void> => {
    if (data.settings.syncPreferences?.externalCalendars !== true) return;
    try {
        await provider.save(data.settings.externalCalendars ?? []);
    } catch (error) {
        provider.onWarn?.('Failed to save external calendars from sync', error);
    }
};
