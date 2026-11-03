import { useEffect, useState } from 'react';
import type { Attachment } from '@mindwtr/core';
import { normalizeAttachmentPathForUrl } from './attachment-paths';
import { stripFileScheme } from './sync-service-utils';
import { isTauriRuntime } from './runtime';

type AttachmentRef = Pick<Attachment, 'kind' | 'uri' | 'cloudKey'>;


export const FOLDER_LINK_MIME_TYPE = 'inode/directory';

export const isFolderLinkAttachment = (attachment: Pick<Attachment, 'kind' | 'mimeType'>): boolean =>
    attachment.kind === 'link' && attachment.mimeType === FOLDER_LINK_MIME_TYPE;


export function isExternalFileReference(attachment: AttachmentRef, managedDirPrefix: string | null): boolean {
    if (attachment.kind !== 'file') return false;
    if (!managedDirPrefix) return false;
    const uri = (attachment.uri || '').trim();
    if (!uri || /^https?:\/\//i.test(uri)) return false;
    const normalized = normalizeAttachmentPathForUrl(stripFileScheme(uri));
    return !normalized.startsWith(managedDirPrefix);
}


export function isBareFileReference(attachment: AttachmentRef, managedDirPrefix: string | null): boolean {
    if (attachment.cloudKey) return false;
    return isExternalFileReference(attachment, managedDirPrefix);
}

let cachedManagedDirPrefix: string | null = null;
let managedDirPrefixPromise: Promise<string | null> | null = null;


export async function loadManagedAttachmentsDirPrefix(): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    if (cachedManagedDirPrefix) return cachedManagedDirPrefix;
    if (!managedDirPrefixPromise) {
        managedDirPrefixPromise = import('./managed-paths')
            .then(async ({ getManagedDataDir }) => {
                const base = await getManagedDataDir();


                cachedManagedDirPrefix = `${normalizeAttachmentPathForUrl(base).replace(/\/+$/, '')}/attachments/`;
                return cachedManagedDirPrefix;
            })
            .catch(() => null);
    }
    return managedDirPrefixPromise;
}


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
