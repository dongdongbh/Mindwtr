import type { AppData, Attachment, SettingsSyncGroup } from './types';
import { mapPass, runToEnd, SLICE_ITEMS, type CooperativePass } from './cooperative';
import { keepSavedFilters } from './saved-filters';
import { getGtdSyncSnapshot, isSettingsSyncGroupEnabled } from './settings-options';
import { normalizeRevision } from './sync-revision';
import { isNonEmptyString } from './sync-normalization';
import { SYNC_FILE_NAME } from './sync-service-utils';
import {
    compactPurgedProjectTombstone,
    compactPurgedTaskTombstone,
    compactSectionsForPurgedProjects,
} from './tombstone-compaction';

const MISSING_ATTACHMENT_TIMESTAMP_SENTINEL = '1970-01-01T00:00:00.000Z';
const MISSING_SETTINGS_SYNC_TIMESTAMP_SENTINEL = '1970-01-01T00:00:00.000Z';

export const advanceLatestSyncTimestamp = (...values: Array<string | undefined>): string | undefined => {
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

        for (const upload of collectPendingUploads('task', task.id, task.attachments)) pending.push(upload);
    }

    for (const project of data.projects) {
        if (project.deletedAt) continue;
        for (const upload of collectPendingUploads('project', project.id, project.attachments)) pending.push(upload);
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

const syncsGroup = (prefs: AppData['settings']['syncPreferences'], group: SettingsSyncGroup): boolean => (
    isSettingsSyncGroupEnabled(prefs, group) === true
);

export const keepSyncedSettingsStamps = (settings: AppData['settings']): AppData['settings']['syncPreferencesUpdatedAt'] => (
    settings.syncPreferencesUpdatedAt
        ? Object.fromEntries(Object.entries(settings.syncPreferencesUpdatedAt).filter(([group]) => (
            group === 'preferences' || syncsGroup(settings.syncPreferences, group as SettingsSyncGroup)
        )))
        : undefined
);

const sanitizeSettingsForRemote = (settings: AppData['settings']): AppData['settings'] => {
    const prefs = settings.syncPreferences ?? {};
    const remotePrefs = { ...prefs };
    let remotePrefsUpdatedAt = keepSyncedSettingsStamps(settings);
    if (syncsGroup(prefs, 'gtd')) {


        remotePrefs.gtd = true;
        if (prefs.gtd === undefined) {


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


    if (settings.taxonomy !== undefined) next.taxonomy = settings.taxonomy;
    if (isNonEmptyString(settings.analyticsProfileId)) {
        next.analyticsProfileId = settings.analyticsProfileId;
    }
    if (settings.supportPrompt) {
        next.supportPrompt = { ...settings.supportPrompt };
    }

    if (syncsGroup(prefs, 'appearance')) {
        next.theme = settings.theme;
        next.appearance = settings.appearance ? { ...settings.appearance } : settings.appearance;
        next.keybindingStyle = settings.keybindingStyle;

        next.globalQuickAddShortcut = undefined;
    }

    if (syncsGroup(prefs, 'language')) {
        next.language = settings.language;
        next.weekStart = settings.weekStart;
        next.dateFormat = settings.dateFormat;
        next.timeFormat = settings.timeFormat;
    }

    if (syncsGroup(prefs, 'gtd')) {
        const gtdSnapshot = getGtdSyncSnapshot(settings);
        next.gtd = gtdSnapshot.gtd;
        next.taskReminderDefault = gtdSnapshot.taskReminderDefault;
        next.quickAddAutoClean = gtdSnapshot.quickAddAutoClean;
        next.markdownEditorAssist = gtdSnapshot.markdownEditorAssist;
        next.features = gtdSnapshot.features;
    }

    if (syncsGroup(prefs, 'savedFilters')) {
        next.savedFilters = keepSavedFilters(settings.savedFilters);
    }

    if (syncsGroup(prefs, 'externalCalendars')) {
        next.externalCalendars = settings.externalCalendars
            ? settings.externalCalendars
                .filter((item) => !isLocalCalendarSourceUrl(item.url))
                .map((item) => ({ ...item }))
            : settings.externalCalendars;
    }

    if (syncsGroup(prefs, 'ai') && settings.ai) {
        next.ai = {
            ...settings.ai,
            apiKey: undefined,


            baseUrl: undefined,
            openAIExtraBodyParams: undefined,
            speechToText: settings.ai.speechToText
                ? {
                    ...settings.ai.speechToText,
                    offlineModelPath: undefined,
                    baseUrl: undefined,
                }
                : settings.ai.speechToText,
        };
    }

    return next;
};

export const sanitizeAppDataForRemote = (data: AppData): AppData => runToEnd(sanitizeAppDataForRemotePass(data));


export function* sanitizeAppDataForRemotePass(data: AppData): CooperativePass<AppData> {
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
                        staleContentHash: undefined,
                    };
                }
            }
            return {
                ...attachment,
                uri: '',
                localStatus: undefined,


                contentMtimeMs: undefined,
                contentSize: undefined,
                pendingContentUpload: undefined,
                staleContentHash: undefined,
            };
        });
    };

    return {
        ...data,
        tasks: yield* mapPass(data.tasks, (task) => task.purgedAt
            ? compactPurgedTaskTombstone(task)
            : {
                ...task,
                attachments: sanitizeAttachments(task.attachments, Boolean(task.deletedAt)),
            }),
        projects: yield* mapPass(data.projects, (project) => project.purgedAt
            ? compactPurgedProjectTombstone(project)
            : {
                ...project,
                attachments: sanitizeAttachments(project.attachments, Boolean(project.deletedAt)),
            }),
        sections: compactSectionsForPurgedProjects(data.sections, data.projects),
        settings: sanitizeSettingsForRemote(data.settings),
    };
}

const isIdKeyed = (item: unknown): item is { id: string } => (
    !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string'
);

type SyncPropertyOrder = { original: string[]; sorted: string[] };


const getSortedSyncProperties = (value: object, orders: SyncPropertyOrder[]): string[] => {
    const properties = Object.keys(value);
    for (const order of orders) {
        if (properties.length === order.original.length
            && properties.every((property, index) => property === order.original[index])) {
            return order.sorted;
        }
    }
    const sorted = properties.slice().sort();
    if (orders.length === 8) orders.shift();
    orders.push({ original: properties, sorted });
    return sorted;
};


const sortIdKeyed = (items: unknown[]): unknown[] => {
    if (items.length > 1 && items.every(isIdKeyed)) {
        items.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    }
    return items;
};

const normalizeForSyncComparison = (value: unknown, orders: SyncPropertyOrder[] = []): unknown => {
    if (Array.isArray(value)) {
        return sortIdKeyed(value.map((item) => normalizeForSyncComparison(item, orders)));
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const normalized: Record<string, unknown> = {};
        for (const key of getSortedSyncProperties(record, orders)) {
            normalized[key] = normalizeForSyncComparison(record[key], orders);
        }
        return normalized;
    }
    return value;
};

export const areSyncPayloadsEqual = (left: AppData, right: AppData): boolean =>
    JSON.stringify(normalizeForSyncComparison(left)) === JSON.stringify(normalizeForSyncComparison(right));

export const toStableSyncJson = (value: unknown): string =>
    JSON.stringify(normalizeForSyncComparison(value));


export function* toStableSyncJsonPass(value: unknown): CooperativePass<string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return toStableSyncJson(value);
    const orders: SyncPropertyOrder[] = [];
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of getSortedSyncProperties(record, orders)) {
        const field = record[key];
        normalized[key] = Array.isArray(field)
            ? sortIdKeyed(yield* mapPass(field, (item) => normalizeForSyncComparison(item, orders)))
            : normalizeForSyncComparison(field, orders);
        yield;
    }
    return JSON.stringify(normalized);
}

function* hashStableSyncJsonPass(value: string): CooperativePass<string> {
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        left ^= code;
        left = Math.imul(left, 0x01000193);
        right ^= code + index;
        right = Math.imul(right, 0x85ebca6b);
        right ^= right >>> 13;
        if ((index & 0xffff) === 0xffff) yield;
    }
    return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}


export function* fingerprintStableSyncJsonPass(json: string): CooperativePass<string> {
    return `stable-v2:${json.length}:${yield* hashStableSyncJsonPass(json)}`;
}


export const fingerprintStableSyncJson = (json: string): string => runToEnd(fingerprintStableSyncJsonPass(json));

export const computeStableValueFingerprint = (value: unknown): string => fingerprintStableSyncJson(toStableSyncJson(value));

export const computeSyncPayloadFingerprint = (data: AppData): string =>
    computeStableValueFingerprint(sanitizeAppDataForRemote(data));


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


export const computeCoveredSettingsFingerprint = (settings: AppData['settings']): string => {
    const comparable: Record<string, unknown> = { ...(settings ?? {}) };
    for (const key of SYNC_STATUS_BOOKKEEPING_SETTINGS_KEYS) {
        delete comparable[key];
    }
    return computeStableValueFingerprint(comparable);
};


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

function* appendEntityRevisions(parts: string[], entities: readonly RevisionedEntity[] | undefined): CooperativePass<void> {
    parts.push(String(entities?.length ?? 0));
    let count = 0;
    for (const entity of entities ?? []) {
        parts.push(
            `${entity.id}|${normalizeRevision(entity.rev)}|${entity.revBy ?? ''}|${entity.updatedAt ?? ''}|${entity.deletedAt ?? ''}|${entity.purgedAt ?? ''}`
        );
        count += 1;
        if (count % SLICE_ITEMS === 0) yield;
    }
}


export const computeSyncChangeFingerprint = (data: AppData): string => runToEnd(computeSyncChangeFingerprintPass(data));


export function* computeSyncChangeFingerprintPass(data: AppData): CooperativePass<string> {
    const parts: string[] = [];
    yield* appendEntityRevisions(parts, data.tasks);
    yield* appendEntityRevisions(parts, data.projects);
    yield* appendEntityRevisions(parts, data.sections);
    yield* appendEntityRevisions(parts, data.areas);
    yield* appendEntityRevisions(parts, data.people);
    parts.push(computeStableValueFingerprint(sanitizeSettingsForRemote(data.settings ?? {})));
    const digest = parts.join('\n');
    return `change-v1:${digest.length}:${yield* hashStableSyncJsonPass(digest)}`;
}

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
