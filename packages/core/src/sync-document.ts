import type { AppData } from './types';
import { normalizeAppData, validateSyncPayloadShape } from './sync-normalization';
import {
    areSyncPayloadsEqual,
    computeStableValueFingerprint,
    sanitizeAppDataForRemote,
} from './sync-helpers';

export type SyncDocumentSource = 'local' | 'remote';

export type SyncDocumentParseResult =
    | { ok: true; data: AppData }
    | { ok: false; errors: string[] };

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
                    || Object.prototype.hasOwnProperty.call(attachment, 'pendingContentUpload');
                if (!hasDeviceState) return attachment;
                const {
                    localStatus: _localStatus,
                    contentMtimeMs: _contentMtimeMs,
                    contentSize: _contentSize,
                    pendingContentUpload: _pendingContentUpload,
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
    const normalized = normalizeAppData(input as AppData);
    return {
        ok: true,
        data: source === 'remote' ? stripRemoteAttachmentDeviceState(normalized) : normalized,
    };
};

declare const remoteSyncDocumentBrand: unique symbol;

/** An AppData snapshot after device-local fields have been removed for transport. */
export type RemoteSyncDocument = AppData & {
    readonly [remoteSyncDocumentBrand]: true;
};

export const toRemoteSyncDocument = (data: AppData): RemoteSyncDocument =>
    sanitizeAppDataForRemote(data) as RemoteSyncDocument;

export const areRemoteSyncDocumentsEqual = (
    left: RemoteSyncDocument,
    right: RemoteSyncDocument,
): boolean => areSyncPayloadsEqual(left, right);

export const computeRemoteSyncDocumentFingerprint = (data: RemoteSyncDocument): string =>
    computeStableValueFingerprint(data);
