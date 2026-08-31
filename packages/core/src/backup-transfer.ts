import type { AppData, Attachment } from './types';
import { createImportDiagnostics, type ImportDiagnostic } from './import-diagnostics';
import { nextRevision, normalizeRevision, SYNC_BACKUP_RESTORE_REV_BY } from './sync-revision';
import {
    compactPurgedProjectForLocalStorage,
    compactPurgedProjectTombstone,
    compactPurgedTaskForLocalStorage,
    compactPurgedTaskTombstone,
    compactSectionsForPurgedProjects,
} from './tombstone-compaction';
import {
    isObjectRecord,
    normalizeAttachmentsForSyncMerge,
    validateMergedSyncData,
} from './sync-normalization';
import { parseSyncDocument } from './sync-document';

export const BACKUP_FILE_PREFIX = 'mindwtr-backup-';

// Backups legitimately include tombstones and attachment metadata, so they get a larger ceiling
// than third-party imports. The cap still bounds the single JSON string each client must allocate.
export const MAX_BACKUP_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_BACKUP_SOURCE_MEBIBYTES = MAX_BACKUP_SOURCE_BYTES / (1024 * 1024);

export type BackupSourceFileDiagnosticCode =
    | 'backup-source-size-unknown'
    | 'backup-source-too-large';

export class BackupSourceFileError extends Error {
    readonly code: BackupSourceFileDiagnosticCode;
    readonly params: Record<string, number | string>;

    constructor(
        code: BackupSourceFileDiagnosticCode,
        message: string,
        params: Record<string, number | string> = {},
    ) {
        super(message);
        this.name = 'BackupSourceFileError';
        this.code = code;
        this.params = params;
    }
}

export const getBackupSourceFileDiagnostic = (error: unknown): ImportDiagnostic | null => {
    if (!error || typeof error !== 'object') return null;
    const candidate = error as { code?: unknown; params?: unknown };
    if (candidate.code !== 'backup-source-size-unknown' && candidate.code !== 'backup-source-too-large') {
        return null;
    }
    const params = candidate.params && typeof candidate.params === 'object'
        ? candidate.params as Record<string, number | string>
        : {};
    return { code: candidate.code, params, severity: 'error' };
};

export const assertBackupSourceFileSize = (size: number | null | undefined): void => {
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
        throw new BackupSourceFileError(
            'backup-source-size-unknown',
            'Mindwtr could not verify the selected backup file size. Copy it locally and try again.',
        );
    }
    if (size > MAX_BACKUP_SOURCE_BYTES) {
        throw new BackupSourceFileError(
            'backup-source-too-large',
            'The selected backup file is too large. Choose a backup no larger than 128 MB.',
            { maxSizeMb: MAX_BACKUP_SOURCE_MEBIBYTES },
        );
    }
};

export type ActiveRecordCounts = {
    areas: number;
    people: number;
    projects: number;
    sections: number;
    tasks: number;
};

// Both desktop's and mobile's data-transfer.ts carried byte-identical copies of this for their
// own export/restore/snapshot logging — and both omitted `people`, a first-class synced entity,
// undercounting it in every backup/restore log line on both platforms.
export const countActiveRecords = (data: AppData): ActiveRecordCounts => ({
    tasks: data.tasks.filter((task) => !task.deletedAt).length,
    projects: data.projects.filter((project) => !project.deletedAt).length,
    sections: data.sections.filter((section) => !section.deletedAt).length,
    areas: data.areas.filter((area) => !area.deletedAt).length,
    people: (data.people ?? []).filter((person) => !person.deletedAt).length,
});

export type BackupMetadata = {
    fileName?: string;
    backupAt?: string;
    version?: string;
    taskCount: number;
    projectCount: number;
    sectionCount: number;
    areaCount: number;
};

export type BackupValidation = {
    valid: boolean;
    data: AppData | null;
    metadata: BackupMetadata | null;
    errors: string[];
    warnings: string[];
    diagnostics: ImportDiagnostic[];
};

type BackupValidationOptions = {
    appVersion?: string | null;
    fileModifiedAt?: string | number | Date | null;
    fileName?: string | null;
};

type BackupEnvelope = {
    backupMetadata?: {
        version?: unknown;
        createdAt?: unknown;
    };
    data?: unknown;
};

type BackupRestoreSyncPreparationOptions = {
    restoredAt?: string | number | Date | null;
    // The data being replaced. Anything it holds that the backup does not is
    // carried over as a tombstone so the restore survives the next merge — see
    // carryForwardEntitiesMissingFromBackup.
    previousData?: AppData | null;
};

type RestorableEntity = {
    id: string;
    deletedAt?: string;
    purgedAt?: string;
    rev?: number;
    revBy?: string;
    updatedAt: string;
};

const BACKUP_TIMESTAMP_PATTERN = new RegExp(
    `^${BACKUP_FILE_PREFIX}(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})(?:-(\\d{3}))?Z?\\.json$`,
    'i'
);

const normalizeVersion = (value?: string | null): string => String(value || '').trim().replace(/^v/i, '');

const compareVersions = (left?: string | null, right?: string | null): number => {
    const leftParts = normalizeVersion(left).split('.').map((part) => Number(part));
    const rightParts = normalizeVersion(right).split('.').map((part) => Number(part));
    const length = Math.max(leftParts.length, rightParts.length, 0);
    for (let index = 0; index < length; index += 1) {
        const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] as number : 0;
        const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] as number : 0;
        if (leftValue > rightValue) return 1;
        if (leftValue < rightValue) return -1;
    }
    return 0;
};

const toIsoString = (value?: string | number | Date | null): string | undefined => {
    if (!value) return undefined;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

const deriveBackupAtFromFileName = (fileName?: string | null): string | undefined => {
    const trimmed = String(fileName || '').trim();
    if (!trimmed) return undefined;
    const match = trimmed.match(BACKUP_TIMESTAMP_PATTERN);
    if (!match) return undefined;
    const [, date, hour, minute, second, millisecond] = match;
    const iso = `${date}T${hour}:${minute}:${second}.${millisecond ?? '000'}Z`;
    const parsed = new Date(iso);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
};

const extractBackupEnvelope = (value: unknown): { data: unknown; metadata: BackupEnvelope['backupMetadata'] | null } => {
    if (!isObjectRecord(value)) return { data: value, metadata: null };
    const record = value as BackupEnvelope;
    if (isObjectRecord(record.data)) {
        return {
            data: record.data,
            metadata: isObjectRecord(record.backupMetadata) ? record.backupMetadata : null,
        };
    }
    return {
        data: value,
        metadata: isObjectRecord(record.backupMetadata) ? record.backupMetadata : null,
    };
};

export function sanitizeSerializedJsonText(raw: string): string {
    let text = String(raw || '').replace(/^\uFEFF/, '').trim();
    // eslint-disable-next-line no-control-regex
    text = text.replace(/\u0000+$/g, '').trim();
    return text;
}

export const createBackupFileName = (date: Date = new Date()): string => {
    const timestamp = date.toISOString().replace(/[:.]/g, '-');
    return `${BACKUP_FILE_PREFIX}${timestamp}.json`;
};

const compactBackupSettings = (settings: AppData['settings']): AppData['settings'] => {
    const pendingRemoteDeletes = settings.attachments?.pendingRemoteDeletes;
    if (!pendingRemoteDeletes?.length) return settings;
    return {
        ...settings,
        attachments: {
            ...settings.attachments,
            pendingRemoteDeletes: pendingRemoteDeletes.map(({ cloudKey, attempts, lastErrorAt }) => ({
                cloudKey,
                attempts,
                lastErrorAt,
            })),
        },
    };
};

export const serializeBackupData = (data: AppData): string => JSON.stringify({
    ...data,
    tasks: data.tasks.map(compactPurgedTaskTombstone),
    projects: data.projects.map(compactPurgedProjectTombstone),
    sections: compactSectionsForPurgedProjects(data.sections, data.projects),
    settings: compactBackupSettings(data.settings),
}, null, 2);

const prepareRestoredEntityForSync = <T extends RestorableEntity>(
    item: T,
    restoredAt: string,
    previous?: T,
): T => {
    const retentionTimestamps = item.purgedAt
        ? {
            deletedAt: item.deletedAt ?? restoredAt,
            purgedAt: restoredAt,
        }
        : item.deletedAt
            ? { deletedAt: restoredAt }
            : {};
    return {
        ...item,
        ...retentionTimestamps,
        updatedAt: restoredAt,
        rev: nextRevision(Math.max(
            normalizeRevision(item.rev),
            normalizeRevision(previous?.rev),
        )),
        revBy: SYNC_BACKUP_RESTORE_REV_BY,
    };
};

/**
 * Restoring replaces local data wholesale, which silently drops the tombstones
 * this device was holding for anything deleted since the backup was taken. The
 * remote still has those records, so the next merge reads their absence as
 * "new over there" and hands them all back — the restore appears to work and
 * then undoes itself (#939).
 *
 * So every id the replaced data knows about but the backup does not is carried
 * over as a tombstone, at a revision above the one it was last seen at, making
 * the restored snapshot authoritative rather than merely newer in places.
 * Records this device never saw are untouched: absence here is ignorance, not a
 * deletion, and another device's work is not ours to erase.
 */
const carryForwardEntitiesMissingFromBackup = <T extends RestorableEntity>(
    restored: T[],
    previous: T[] | undefined,
    restoredAt: string
): T[] => {
    if (!previous?.length) return restored;
    const restoredIds = new Set(restored.map((item) => item.id));
    const carried = previous
        .filter((item) => !restoredIds.has(item.id))
        .map((item) => ({
            ...item,
            deletedAt: item.deletedAt ?? restoredAt,
        }));
    return carried.length > 0 ? [...restored, ...carried] : restored;
};

const stripDeviceLocalRestoreSettings = (settings: AppData['settings']): AppData['settings'] => {
    if (settings.security?.mobileAppLockEnabled === undefined) return settings;
    const nextSettings: AppData['settings'] = {
        ...settings,
        security: { ...settings.security },
    };
    delete nextSettings.security?.mobileAppLockEnabled;
    if (nextSettings.security && Object.keys(nextSettings.security).length === 0) {
        delete nextSettings.security;
    }
    return nextSettings;
};

/**
 * A backup file is user-supplied bytes, and restore stamps fresh revisions so its records
 * win the next merge — without this, an attachment path the sync-merge sanitizer would have
 * rejected gets published to every device from here. Bad values are cleared, never dropped:
 * the attachment degrades to "missing locally" instead of vanishing from the user's task.
 */
const sanitizeRestoredAttachments = <T extends { attachments?: Attachment[] }>(item: T): T => (
    item.attachments ? { ...item, attachments: normalizeAttachmentsForSyncMerge(item.attachments) } : item
);

/**
 * Attachments merge as child records, independently of the task/project revision.
 * A restore therefore has to make the backup authoritative at the child seam too:
 * refresh the backup children and explicitly tombstone children the replaced local
 * parent knew about but the backup omitted. Otherwise the next sync can immediately
 * resurrect an omitted attachment or let a stale remote tombstone re-delete a file
 * the user just restored.
 */
const prepareRestoredAttachmentsForSync = <T extends { attachments?: Attachment[] }>(
    item: T,
    restoredAt: string,
    previous?: T,
): T => {
    const restoredAttachments = normalizeAttachmentsForSyncMerge(item.attachments) ?? [];
    const previousAttachments = normalizeAttachmentsForSyncMerge(previous?.attachments) ?? [];
    if (restoredAttachments.length === 0 && previousAttachments.length === 0) {
        return sanitizeRestoredAttachments(item);
    }

    const restoredIds = new Set(restoredAttachments.map((attachment) => attachment.id));
    const refreshed = restoredAttachments.map((attachment) => ({
        ...attachment,
        ...(attachment.deletedAt ? { deletedAt: restoredAt } : {}),
        updatedAt: restoredAt,
    }));
    const carriedTombstones = previousAttachments
        .filter((attachment) => !restoredIds.has(attachment.id))
        .map((attachment) => ({
            ...attachment,
            deletedAt: restoredAt,
            updatedAt: restoredAt,
        }));

    return {
        ...item,
        attachments: [...refreshed, ...carriedTombstones],
    };
};

export const prepareRestoredBackupDataForSync = (
    data: AppData,
    options: BackupRestoreSyncPreparationOptions = {}
): AppData => {
    const restoredAt = toIsoString(options.restoredAt) ?? new Date().toISOString();
    const restoredSettings = stripDeviceLocalRestoreSettings(data.settings);
    const previous = options.previousData ?? null;
    const prepare = <T extends RestorableEntity>(restored: T[], before: T[] | undefined): T[] => {
        const beforeById = new Map((before ?? []).map((item) => [item.id, item]));
        return carryForwardEntitiesMissingFromBackup(restored, before, restoredAt)
            .map((item) => prepareRestoredEntityForSync(item, restoredAt, beforeById.get(item.id)));
    };
    const previousTasksById = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
    const previousProjectsById = new Map((previous?.projects ?? []).map((project) => [project.id, project]));
    const tasks = prepare(data.tasks, previous?.tasks).map((task) => (
        task.purgedAt
            ? compactPurgedTaskForLocalStorage({
                ...task,
                attachments: previousTasksById.get(task.id)?.attachments,
            })
            : prepareRestoredAttachmentsForSync(task, restoredAt, previousTasksById.get(task.id))
    ));
    const projects = prepare(data.projects, previous?.projects).map((project) => (
        project.purgedAt
            ? compactPurgedProjectForLocalStorage({
                ...project,
                attachments: previousProjectsById.get(project.id)?.attachments,
            })
            : prepareRestoredAttachmentsForSync(project, restoredAt, previousProjectsById.get(project.id))
    ));
    const sections = compactSectionsForPurgedProjects(
        prepare(data.sections, previous?.sections),
        projects,
    );
    return {
        ...data,
        tasks,
        projects,
        sections,
        areas: prepare(data.areas, previous?.areas),
        people: prepare(data.people ?? [], previous?.people),
        settings: {
            ...restoredSettings,
            pendingRemoteWriteAt: restoredAt,
            pendingRemoteWriteRetryAt: undefined,
            pendingRemoteWriteAttempts: undefined,
        },
    };
};

export const validateBackupJson = (
    rawJson: string,
    options: BackupValidationOptions = {}
): BackupValidation => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const diagnostics: ImportDiagnostic[] = [];
    const sanitized = sanitizeSerializedJsonText(rawJson);
    if (!sanitized) {
        return {
            valid: false,
            data: null,
            metadata: null,
            errors: ['Backup file is empty.'],
            warnings,
            diagnostics: createImportDiagnostics(['Backup file is empty.'], 'error'),
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(sanitized);
    } catch (error) {
        return {
            valid: false,
            data: null,
            metadata: null,
            errors: [
                error instanceof Error && error.message
                    ? `Backup file is not valid JSON: ${error.message}`
                    : 'Backup file is not valid JSON.',
            ],
            warnings,
            diagnostics: createImportDiagnostics([
                error instanceof Error && error.message
                    ? `Backup file is not valid JSON: ${error.message}`
                    : 'Backup file is not valid JSON.',
            ], 'error'),
        };
    }

    const envelope = extractBackupEnvelope(parsed);
    const document = parseSyncDocument(envelope.data, 'local');
    if (!document.ok) {
        return {
            valid: false,
            data: null,
            metadata: null,
            errors: document.errors,
            warnings,
            diagnostics: createImportDiagnostics(document.errors, 'error'),
        };
    }

    const normalized = document.data;
    const dataErrors = validateMergedSyncData(normalized);
    if (dataErrors.length > 0) {
        return {
            valid: false,
            data: null,
            metadata: null,
            errors: dataErrors,
            warnings,
            diagnostics: createImportDiagnostics(dataErrors, 'error'),
        };
    }

    const taskCount = normalized.tasks.filter((task) => !task.deletedAt).length;
    const projectCount = normalized.projects.filter((project) => !project.deletedAt).length;
    const sectionCount = normalized.sections.filter((section) => !section.deletedAt).length;
    const areaCount = normalized.areas.filter((area) => !area.deletedAt).length;
    if (taskCount === 0 && projectCount === 0) {
        warnings.push('This backup does not contain any active tasks or projects.');
        diagnostics.push({ code: 'backup-empty-active-records', params: {}, severity: 'warning' });
    }

    const metadataVersion = typeof envelope.metadata?.version === 'string'
        ? normalizeVersion(envelope.metadata.version)
        : undefined;
    const appVersion = normalizeVersion(options.appVersion);
    if (metadataVersion && appVersion) {
        const comparison = compareVersions(metadataVersion, appVersion);
        if (comparison > 0) {
            warnings.push(`This backup was created by a newer Mindwtr version (${metadataVersion}).`);
            diagnostics.push({ code: 'backup-newer-version', params: { version: metadataVersion }, severity: 'warning' });
        } else if (comparison < 0) {
            warnings.push(`This backup was created by an older Mindwtr version (${metadataVersion}).`);
            diagnostics.push({ code: 'backup-older-version', params: { version: metadataVersion }, severity: 'warning' });
        }
    }

    const metadata: BackupMetadata = {
        fileName: String(options.fileName || '').trim() || undefined,
        backupAt:
            toIsoString(envelope.metadata?.createdAt as string | number | Date | null)
            ?? toIsoString(options.fileModifiedAt)
            ?? deriveBackupAtFromFileName(options.fileName),
        version: metadataVersion,
        taskCount,
        projectCount,
        sectionCount,
        areaCount,
    };

    return {
        valid: true,
        data: normalized,
        metadata,
        errors,
        warnings,
        diagnostics,
    };
};
