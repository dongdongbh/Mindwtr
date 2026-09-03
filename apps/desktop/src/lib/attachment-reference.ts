import { useEffect, useState } from 'react';
import type { Attachment } from '@mindwtr/core';
import { normalizeAttachmentPathForUrl } from './attachment-paths';
import { stripFileScheme } from './sync-service-utils';
import { isTauriRuntime } from './runtime';

type AttachmentRef = Pick<Attachment, 'kind' | 'uri' | 'cloudKey'>;

// An external reference is a file attachment whose path lies outside the
// managed attachments dir. Pre-#1001-fix "Add link" items are this shape —
// possibly with a synced copy (cloudKey) attached — and are the ones Edit
// can convert into true link pointers. Pure string comparison — never stats
// the disk, safe in render paths.
export function isExternalFileReference(attachment: AttachmentRef, managedDirPrefix: string | null): boolean {
    if (attachment.kind !== 'file') return false;
    if (!managedDirPrefix) return false;
    const uri = (attachment.uri || '').trim();
    if (!uri || /^https?:\/\//i.test(uri)) return false;
    const normalized = normalizeAttachmentPathForUrl(stripFileScheme(uri));
    return !normalized.startsWith(managedDirPrefix);
}

// A bare reference is an external reference the app also cannot restore:
// no synced copy (cloudKey) exists.
export function isBareFileReference(attachment: AttachmentRef, managedDirPrefix: string | null): boolean {
    if (attachment.cloudKey) return false;
    return isExternalFileReference(attachment, managedDirPrefix);
}

let cachedManagedDirPrefix: string | null = null;
let managedDirPrefixPromise: Promise<string | null> | null = null;

/** The managed attachments dir, normalized and trailing-slashed, for `isExternalFileReference`.
 *  Exported so the sync gate (`hasAttachmentSyncWork` in sync-service.ts) asks the same
 *  question the UI's paperclip/link icons ask, rather than reimplementing the prefix rules.
 *  Resolves at most one IPC per session; `null` means "not resolved / not desktop", which
 *  every caller must treat as "assume external". */
export async function loadManagedAttachmentsDirPrefix(): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    if (cachedManagedDirPrefix) return cachedManagedDirPrefix;
    if (!managedDirPrefixPromise) {
        managedDirPrefixPromise = import('./managed-paths')
            .then(async ({ getManagedDataDir }) => {
                const base = await getManagedDataDir();
                // Owned copies live only in the managed attachments dir
                // (portable-aware, same dir as imports and sync downloads).
                // The trailing slash keeps sibling dirs like ".../attachments-old"
                // from matching by prefix.
                cachedManagedDirPrefix = `${normalizeAttachmentPathForUrl(base).replace(/\/+$/, '')}/attachments/`;
                return cachedManagedDirPrefix;
            })
            .catch(() => null);
    }
    return managedDirPrefixPromise;
}

// Resolves the managed attachments dir once per session; until it resolves,
// every attachment counts as owned (paperclip) so icons never flicker.
function useManagedDirPrefix(): string | null {
    const [prefix, setPrefix] = useState<string | null>(cachedManagedDirPrefix);
    useEffect(() => {
        if (prefix) return;
        let cancelled = false;
        void loadManagedAttachmentsDirPrefix().then((resolved) => {
            if (!cancelled && resolved) setPrefix(resolved);
        });
        return () => {
            cancelled = true;
        };
    }, [prefix]);
    return prefix;
}

export function useBareFileReferenceCheck(): (attachment: AttachmentRef) => boolean {
    const prefix = useManagedDirPrefix();
    return (attachment) => isBareFileReference(attachment, prefix);
}

export function useExternalFileReferenceCheck(): (attachment: AttachmentRef) => boolean {
    const prefix = useManagedDirPrefix();
    return (attachment) => isExternalFileReference(attachment, prefix);
}
