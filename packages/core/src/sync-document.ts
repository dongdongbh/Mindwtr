import type { AppData, Attachment } from './types';
import { logInfo } from './logger';
import {
    isNonEmptyString,
    isObjectRecord,
    isValidTimestamp,
    normalizeAppData,
    validateSyncPayloadShape,
} from './sync-normalization';
import {
    areSyncPayloadsEqual,
    computeStableValueFingerprint,
    sanitizeAppDataForRemote,
    sanitizeAppDataForRemotePass,
    toStableSyncJsonPass,
} from './sync-helpers';
import type { CooperativePass } from './cooperative';
import { generateDeterministicUUID } from './uuid';

export type SyncDocumentSource = 'local' | 'remote';

export type SyncDocumentParseResult =
    | { ok: true; data: AppData; legacyAttachmentsChanged?: true }
    | { ok: false; errors: string[] };

const LEGACY_ATTACHMENT_TIMESTAMP_SENTINEL = '1970-01-01T00:00:00.000Z';

const parseAbsoluteHttpUrl = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        const url = new URL(trimmed);
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname
            ? trimmed
            : null;
    } catch {
        return null;
    }
};

type LegacyAttachmentOwnerKind = 'task' | 'project';

/**
 * Timestamps a recovered attachment inherits from its owner, so two peers
 * repairing the same raw document produce byte-identical records.
 */
const legacyAttachmentTimestamps = (owner: Record<string, unknown>): { createdAt: string; updatedAt: string } => {
    const createdAt = isValidTimestamp(owner.createdAt)
        ? owner.createdAt
        : isValidTimestamp(owner.updatedAt)
            ? owner.updatedAt
            : LEGACY_ATTACHMENT_TIMESTAMP_SENTINEL;
    const updatedAt = isValidTimestamp(owner.updatedAt) ? owner.updatedAt : createdAt;
    return { createdAt, updatedAt };
};

/**
 * A pre-1.3.0 REST client could store an attachment array entry with fields
 * missing (`attachments: [{ kind: 'link', uri }]`, or a bare `{ url }`), and
 * rejecting it made the whole namespace unreadable for every client. Repair
 * only what an absolute HTTP(S) URL makes unambiguous; a `file` record is never
 * invented from one, because its bytes are not addressable this way.
 * Returns null when the entry stays a hard error.
 */
const repairLegacyAttachmentEntry = (
    attachment: Record<string, unknown>,
    owner: Record<string, unknown>,
    ownerKind: LegacyAttachmentOwnerKind,
): Attachment | null => {
    if (attachment.kind === 'file') return null;
    const uri = (typeof attachment.uri === 'string' ? parseAbsoluteHttpUrl(attachment.uri) : null)
        ?? (typeof attachment.url === 'string' ? parseAbsoluteHttpUrl(attachment.url) : null);
    if (!uri) return null;
    let id: string;
    if (isNonEmptyString(attachment.id)) {
        id = attachment.id;
    } else if (isNonEmptyString(owner.id)) {
        id = generateDeterministicUUID(JSON.stringify([
            'legacy-attachment-link',
            ownerKind,
            owner.id,
            uri,
        ]));
    } else {
        return null;
    }
    const ownerTimestamps = legacyAttachmentTimestamps(owner);
    const { url: _legacyUrl, ...rest } = attachment;
    return {
        ...rest,
        id,
        kind: 'link',
        title: typeof attachment.title === 'string' ? attachment.title : uri,
        uri,
        createdAt: isValidTimestamp(attachment.createdAt) ? attachment.createdAt : ownerTimestamps.createdAt,
        updatedAt: isValidTimestamp(attachment.updatedAt) ? attachment.updatedAt : ownerTimestamps.updatedAt,
    } as Attachment;
};

type LegacyAttachmentRecoveryResult = {
    data: unknown;
    errors: string[];
    repairedOwners: number;
};

/**
 * An older API accepted one bare URL where Attachment[] belongs.
 * Repair only that exact legacy shape at the sync ingress, before any caller
 * dereferences attachment records. All generated fields derive from synced
 * owner data so two peers produce byte-identical link records.
 */
const recoverLegacyAttachmentUrls = (
    input: unknown,
    source: SyncDocumentSource,
): LegacyAttachmentRecoveryResult => {
    if (!isObjectRecord(input)) return { data: input, errors: [], repairedOwners: 0 };

    const errors: string[] = [];
    let repairedOwners = 0;
    let nextData: Record<string, unknown> | undefined;

    const recoverOwners = (ownerKind: LegacyAttachmentOwnerKind): void => {
        const surface = ownerKind === 'task' ? 'tasks' : 'projects';
        const owners = input[surface];
        if (!Array.isArray(owners)) return;

        let nextOwners: unknown[] | undefined;
        owners.forEach((owner, ownerIndex) => {
            if (!isObjectRecord(owner)) return;
            const attachments = owner.attachments;
            if (attachments === undefined) return;
            const fieldPath = `${surface}[${ownerIndex}].attachments`;

            // Cloud task/project PATCH has always used null as an explicit clear.
            // The downstream merge/sanitizer already treats it as absent.
            if (attachments === null) return;

            if (typeof attachments === 'string') {
                const uri = parseAbsoluteHttpUrl(attachments);
                if (!uri) {
                    errors.push(`${source} payload field "${fieldPath}" must be an array or an absolute HTTP(S) URL string when present`);
                    return;
                }
                if (!isNonEmptyString(owner.id)) return;

                const nextOwner = { ...owner };
                if (isNonEmptyString(owner.purgedAt)) {
                    delete nextOwner.attachments;
                } else {
                    const { createdAt, updatedAt } = legacyAttachmentTimestamps(owner);
                    const attachment: Attachment = {
                        id: generateDeterministicUUID(JSON.stringify([
                            'legacy-attachment-link',
                            ownerKind,
                            owner.id,
                            uri,
                        ])),
                        kind: 'link',
                        title: uri,
                        uri,
                        createdAt,
                        updatedAt,
                    };
                    nextOwner.attachments = [attachment];
                    repairedOwners += 1;
                }
                nextOwners = nextOwners ?? owners.slice();
                nextOwners[ownerIndex] = nextOwner;
                return;
            }

            if (!Array.isArray(attachments)) {
                errors.push(`${source} payload field "${fieldPath}" must be an array or an absolute HTTP(S) URL string when present`);
                return;
            }

            let nextAttachments: unknown[] | undefined;
            attachments.forEach((attachment, attachmentIndex) => {
                const attachmentPath = `${fieldPath}[${attachmentIndex}]`;
                if (!isObjectRecord(attachment)) {
                    errors.push(`${source} payload field "${attachmentPath}" must be an object`);
                    return;
                }
                const entryErrors: string[] = [];
                if (!isNonEmptyString(attachment.id)) {
                    entryErrors.push(`${source} payload field "${attachmentPath}.id" must be a non-empty string`);
                }
                if (attachment.kind !== 'file' && attachment.kind !== 'link') {
                    entryErrors.push(`${source} payload field "${attachmentPath}.kind" must be "file" or "link"`);
                }
                if (typeof attachment.title !== 'string') {
                    entryErrors.push(`${source} payload field "${attachmentPath}.title" must be a string`);
                }
                if (typeof attachment.uri !== 'string') {
                    entryErrors.push(`${source} payload field "${attachmentPath}.uri" must be a string`);
                }
                if (!isValidTimestamp(attachment.createdAt)) {
                    entryErrors.push(`${source} payload field "${attachmentPath}.createdAt" must be a valid ISO timestamp`);
                }
                if (!isValidTimestamp(attachment.updatedAt)) {
                    entryErrors.push(`${source} payload field "${attachmentPath}.updatedAt" must be a valid ISO timestamp`);
                }
                // A record that already validates is published untouched; only a
                // broken one is rebuilt, and only when it stays unambiguous.
                if (entryErrors.length === 0) return;
                const repaired = repairLegacyAttachmentEntry(attachment, owner, ownerKind);
                if (!repaired) {
                    errors.push(...entryErrors);
                    return;
                }
                nextAttachments = nextAttachments ?? attachments.slice();
                nextAttachments[attachmentIndex] = repaired;
            });

            if (!nextAttachments) return;
            nextOwners = nextOwners ?? owners.slice();
            nextOwners[ownerIndex] = { ...owner, attachments: nextAttachments };
            repairedOwners += 1;
        });

        if (!nextOwners) return;
        nextData = nextData ?? { ...input };
        nextData[surface] = nextOwners;
    };

    recoverOwners('task');
    recoverOwners('project');
    return { data: nextData ?? input, errors, repairedOwners };
};

/**
 * Remote documents must never seed device-local attachment state. This is a
 * deliberately narrower operation than `sanitizeAppDataForRemote`: outbound
 * sanitization also applies missing-file tombstone policy, while an inbound
 * document must retain its synced deletion/content metadata unchanged.
 */
const stripRemoteAttachmentDeviceState = (data: AppData): AppData => {
    const stripAttachments = <T extends { attachments?: AppData['tasks'][number]['attachments'] }>(
        owners: T[],
    ): T[] => {
        let ownersChanged = false;
        const nextOwners = owners.map((owner) => {
            if (!Array.isArray(owner.attachments)) return owner;
            let attachmentsChanged = false;
            const attachments = owner.attachments.map((attachment) => {
                if (attachment.kind !== 'file') return attachment;
                const hasDeviceState = attachment.uri !== ''
                    || Object.prototype.hasOwnProperty.call(attachment, 'localStatus')
                    || Object.prototype.hasOwnProperty.call(attachment, 'contentMtimeMs')
                    || Object.prototype.hasOwnProperty.call(attachment, 'contentSize')
                    || Object.prototype.hasOwnProperty.call(attachment, 'pendingContentUpload')
                    || Object.prototype.hasOwnProperty.call(attachment, 'staleContentHash');
                if (!hasDeviceState) return attachment;
                const {
                    localStatus: _localStatus,
                    contentMtimeMs: _contentMtimeMs,
                    contentSize: _contentSize,
                    pendingContentUpload: _pendingContentUpload,
                    staleContentHash: _staleContentHash,
                    ...syncedAttachment
                } = attachment;
                attachmentsChanged = true;
                return { ...syncedAttachment, uri: '' };
            });
            if (!attachmentsChanged) return owner;
            ownersChanged = true;
            return { ...owner, attachments };
        });
        return ownersChanged ? nextOwners : owners;
    };

    const tasks = stripAttachments(data.tasks);
    const projects = stripAttachments(data.projects);
    return tasks === data.tasks && projects === data.projects
        ? data
        : { ...data, tasks, projects };
};

export const parseSyncDocument = (
    input: unknown,
    source: SyncDocumentSource,
): SyncDocumentParseResult => {
    const errors = validateSyncPayloadShape(input, source);
    if (errors.length > 0) return { ok: false, errors };
    const recovery = recoverLegacyAttachmentUrls(input, source);
    if (recovery.errors.length > 0) return { ok: false, errors: recovery.errors };
    const normalized = normalizeAppData(recovery.data as AppData);
    const data = source === 'remote' ? stripRemoteAttachmentDeviceState(normalized) : normalized;
    if (recovery.repairedOwners > 0) {
        logInfo('Legacy attachment URL normalized for sync', {
            scope: 'sync',
            context: {
                count: recovery.repairedOwners,
            },
        });
    }
    return {
        ok: true,
        data,
        ...(recovery.data !== input ? { legacyAttachmentsChanged: true as const } : {}),
    };
};

declare const remoteSyncDocumentBrand: unique symbol;

/** An AppData snapshot after device-local fields have been removed for transport. */
export type RemoteSyncDocument = AppData & {
    readonly [remoteSyncDocumentBrand]: true;
};

export const toRemoteSyncDocument = (data: AppData): RemoteSyncDocument =>
    sanitizeAppDataForRemote(data) as RemoteSyncDocument;

/**
 * A snapshot's remote document as stable sync JSON, the form both {@link computeRemoteSyncDocumentFingerprint} and
 * {@link areRemoteSyncDocumentsEqual} serialize, as a cooperative pass (cooperative.ts).
 */
export function* remoteSyncDocumentStableJsonPass(data: AppData): CooperativePass<string> {
    return yield* toStableSyncJsonPass(yield* sanitizeAppDataForRemotePass(data));
}

export const areRemoteSyncDocumentsEqual = (
    left: RemoteSyncDocument,
    right: RemoteSyncDocument,
): boolean => areSyncPayloadsEqual(left, right);

export const computeRemoteSyncDocumentFingerprint = (data: RemoteSyncDocument): string =>
    computeStableValueFingerprint(data);
