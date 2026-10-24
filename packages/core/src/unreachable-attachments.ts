import type { AppData, Attachment } from './types';
import type { ActivationMissingAttachment } from './sync-run-ports';

/**
 * Attachment files the user chose to continue without when activating a sync location
 * (`acceptMissingAttachmentIds`). The rows stay live with their keys, and this device still
 * tries to download them there, so a file another device uploads arrives. For a recorded
 * row, that location's "not found" is no news: the row stays live and keyed and shows
 * "Missing file". It is never marked unrecoverable, since that tombstone would also win at
 * the location still holding the file and let that location's cleanup delete it.
 *
 * Device-local, never synced: `{ [location scope]: [attachment id] }`. An id leaves its
 * location once the row's file is on this device with no upload pending (a download
 * succeeded, or this device uploaded its bytes there), and every location once the row is
 * gone or deleted, so the record cannot grow without bound.
 */
export const UNREACHABLE_ATTACHMENTS_KEY = 'mindwtr-unreachable-attachments';

export type UnreachableAttachments = Record<string, string[]>;

// The record and the active location as this process last read or wrote them, for the
// screen's "Missing file" label and the on-demand download. Sync passes read the stored record.
let lastKnown: { record: UnreachableAttachments; scope: string | null } = { record: {}, scope: null };

/** `scope` is left as it was when omitted: the on-demand download reads the record but not the location. */
export const rememberUnreachableAttachments = (record: UnreachableAttachments, scope?: string | null): void => {
    lastKnown = { record, scope: scope === undefined ? lastKnown.scope : scope };
};

/**
 * The row is kept without its file at the active location: show it as missing, and treat that
 * location's "not found" as no news. Before this process knows the location, any location counts.
 */
export const isAttachmentKeptWithoutFile = (attachment: Pick<Attachment, 'id'>): boolean => {
    const { record, scope } = lastKnown;
    if (scope) return record[scope]?.includes(attachment.id) === true;
    return Object.values(record).some((ids) => ids.includes(attachment.id));
};

export const parseUnreachableAttachments = (raw: string | null | undefined): UnreachableAttachments => {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const result: UnreachableAttachments = {};
        for (const [scope, ids] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(ids)) continue;
            const valid = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
            if (valid.length > 0) result[scope] = valid;
        }
        return result;
    } catch {
        return {};
    }
};

/**
 * Drop every id, in every location, whose row is gone or deleted, and, in `scope`, every id
 * whose row has its file here with no upload pending. Answers the same object when nothing changed.
 */
export const pruneUnreachableAttachments = (
    record: UnreachableAttachments,
    data: AppData,
    scope: string,
): UnreachableAttachments => {
    const live = new Map<string, Attachment>();
    for (const owner of [...data.tasks, ...data.projects]) {
        if (owner.deletedAt) continue;
        for (const attachment of owner.attachments ?? []) {
            if (attachment.kind === 'file' && !attachment.deletedAt) live.set(attachment.id, attachment);
        }
    }
    let changed = false;
    const next: UnreachableAttachments = {};
    for (const [entryScope, ids] of Object.entries(record)) {
        const kept = ids.filter((id) => {
            const attachment = live.get(id);
            return attachment !== undefined && (
                entryScope !== scope
                || attachment.localStatus !== 'available'
                || attachment.pendingContentUpload === true
            );
        });
        if (kept.length !== ids.length) changed = true;
        if (kept.length > 0) next[entryScope] = kept;
    }
    return changed ? next : record;
};

/** The dialog's list of files an activation could not find: one line each, the first `max`, then `more(rest)`. */
export const formatActivationMissingAttachments = (
    files: readonly ActivationMissingAttachment[],
    more: (count: number) => string,
    max = 5,
): string => {
    const lines = files.slice(0, max).map((file) => {
        const name = file.title.trim() || file.id;
        const owner = file.ownerTitle.trim();
        return owner ? `• ${name} (${owner})` : `• ${name}`;
    });
    if (files.length > max) lines.push(more(files.length - max));
    return lines.join('\n');
};
