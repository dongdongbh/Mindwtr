import type { AppData, Attachment } from './types';
import type { ActivationMissingAttachment } from './sync-run-ports';

/**
 * Attachment files the user chose to continue without when activating a sync location
 * (`acceptMissingAttachmentIds`). This device keeps the rows live with their keys, so the
 * synced document never carries a tombstone for them, and never asks that location for
 * those keys: its 404 would mark the row unrecoverable, a tombstone that would also win at
 * the location still holding the file and let that location's cleanup delete it.
 *
 * Device-local, never synced: `{ [location scope]: { [attachment id]: keys } }`, the keys
 * the row carried when the user accepted. A row leaves the record once its file is here
 * again, once it carries a key not in the record (some device uploaded the file), or once
 * it is gone, so the record cannot grow without bound.
 */
export const UNREACHABLE_ATTACHMENTS_KEY = 'mindwtr-unreachable-attachments';

export type UnreachableAttachments = Record<string, Record<string, string[]>>;

// The record as this process last read or wrote it, for the screen's "Missing file" label only.
// Data paths read the stored record themselves.
let lastKnownRecord: UnreachableAttachments = {};

export const rememberUnreachableAttachments = (record: UnreachableAttachments): void => {
    lastKnownRecord = record;
};

/** The row is kept without its file on this device: show it as missing, never as downloadable. */
export const isAttachmentKeptWithoutFile = (attachment: Attachment): boolean => (
    isUnreachableAttachment(lastKnownRecord, attachment)
);

export const parseUnreachableAttachments = (raw: string | null | undefined): UnreachableAttachments => {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const result: UnreachableAttachments = {};
        for (const [scope, entries] of Object.entries(parsed as Record<string, unknown>)) {
            if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
            const scoped: Record<string, string[]> = {};
            for (const [id, keys] of Object.entries(entries as Record<string, unknown>)) {
                if (!Array.isArray(keys)) continue;
                const valid = keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
                if (valid.length > 0) scoped[id] = valid;
            }
            if (Object.keys(scoped).length > 0) result[scope] = scoped;
        }
        return result;
    } catch {
        return {};
    }
};

/** A recorded row still carrying a recorded key, in any location: no download may ask for it. */
export const isUnreachableAttachment = (record: UnreachableAttachments, attachment: Attachment): boolean => {
    const key = attachment.cloudKey;
    if (!key) return false;
    return Object.values(record).some((entries) => entries[attachment.id]?.includes(key) === true);
};

/**
 * Drop every entry, in every location, whose row is gone, deleted, or has its file here
 * again (`localStatus: 'available'`), and, in `scope`, every entry whose row now carries a
 * key the record does not hold. Answers the same object when nothing changed.
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
    for (const [entryScope, entries] of Object.entries(record)) {
        const kept: Record<string, string[]> = {};
        for (const [id, keys] of Object.entries(entries)) {
            const attachment = live.get(id);
            const keep = attachment
                && attachment.localStatus !== 'available'
                && (entryScope !== scope || !attachment.cloudKey || keys.includes(attachment.cloudKey));
            if (keep) kept[id] = keys;
            else changed = true;
        }
        if (Object.keys(kept).length > 0) next[entryScope] = kept;
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
