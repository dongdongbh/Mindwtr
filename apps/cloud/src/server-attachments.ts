// Attachment lifecycle: the cloud-key bookkeeping that cascades from a project purge,
// and the garbage collector that reconciles on-disk attachment files against what the
// stored AppData still references. Pulled out of server.ts so these rules — previously
// reachable only by spinning up a live server — have a direct test surface.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'fs';
import { join, relative } from 'path';
import {
    validateAttachmentForUpload,
    type Attachment,
    type AppData,
    type PendingRemoteAttachmentDelete,
    type Project,
} from '@mindwtr/core';
import { corsOrigin, errorResponse, jsonResponse, logFailureWarn } from './server-config';
import { loadAppDataForWrite } from './server-data-cache';
import {
    abandonPreparedFilePublication,
    durablyRemoveDirectory,
    durablyRemoveFile,
    durablySyncDirectory,
    getFsErrorCode,
    isBodyReadError,
    isPathWithinRoot,
    normalizeAttachmentRelativePath,
    prepareFilePublicationSafely,
    publishPreparedFilePublication,
    readRequestBytes,
    throwIfRequestAborted,
    type DurableRemovalFileSystem,
    type PreparedFilePublication,
} from './server-storage';
import { validateAppData } from './server-validation';

// Relies on POSIX mtime; do not lower below 1 minute without auditing filesystem timestamp resolution and batching.
const ORPHAN_ATTACHMENT_GC_GRACE_MS = 5 * 60 * 1000;

export const getAttachmentCloudKey = (attachment: Attachment): string | null => {
    if (attachment.kind !== 'file' || !attachment.cloudKey) return null;
    return normalizeAttachmentRelativePath(attachment.cloudKey);
};

export const collectRetainedAttachmentCloudKeysForProjectPurge = (data: AppData, purgedProjectId: string): Set<string> => {
    const cloudKeys = new Set<string>();
    for (const project of data.projects) {
        if (project.id === purgedProjectId || project.purgedAt) continue;
        for (const attachment of project.attachments || []) {
            const cloudKey = getAttachmentCloudKey(attachment);
            if (cloudKey) cloudKeys.add(cloudKey);
        }
    }
    for (const task of data.tasks) {
        if (task.purgedAt) continue;
        for (const attachment of task.attachments || []) {
            const cloudKey = getAttachmentCloudKey(attachment);
            if (cloudKey) cloudKeys.add(cloudKey);
        }
    }
    return cloudKeys;
};

export const collectPendingRemoteDeletesForProjectPurge = (
    project: Project,
    data: AppData,
): PendingRemoteAttachmentDelete[] => {
    const retainedCloudKeys = collectRetainedAttachmentCloudKeysForProjectPurge(data, project.id);
    const byCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    for (const attachment of project.attachments || []) {
        const cloudKey = getAttachmentCloudKey(attachment);
        if (!cloudKey || retainedCloudKeys.has(cloudKey) || byCloudKey.has(cloudKey)) continue;
        byCloudKey.set(cloudKey, {
            cloudKey,
        });
    }
    return Array.from(byCloudKey.values());
};

export const appendPendingRemoteAttachmentDeletes = (
    settings: AppData['settings'],
    pendingDeletes: readonly PendingRemoteAttachmentDelete[],
): AppData['settings'] => {
    if (pendingDeletes.length === 0) return settings;
    const byCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    for (const existing of settings.attachments?.pendingRemoteDeletes || []) {
        byCloudKey.set(existing.cloudKey, existing);
    }
    for (const pending of pendingDeletes) {
        if (byCloudKey.has(pending.cloudKey)) continue;
        byCloudKey.set(pending.cloudKey, pending);
    }
    return {
        ...settings,
        attachments: {
            ...settings.attachments,
            pendingRemoteDeletes: Array.from(byCloudKey.values()),
        },
    };
};

export function collectReferencedAttachmentCloudKeys(data: AppData): Set<string> {
    const referenced = new Set<string>();
    // Owner predicate mirrors collectRetainedAttachmentCloudKeysForProjectPurge and
    // core's findLiveAttachmentResourceReferences: purgedAt, not deletedAt. A
    // soft-deleted owner is still restorable from Trash for 90 days, so its
    // attachment bytes stay referenced until the owner is actually purged.
    const collect = (attachments: Attachment[] | undefined, ownerPurged?: string) => {
        if (ownerPurged) return;
        for (const attachment of attachments ?? []) {
            if (attachment.kind !== 'file' || attachment.deletedAt || !attachment.cloudKey) continue;
            const normalized = normalizeAttachmentRelativePath(attachment.cloudKey);
            if (normalized) referenced.add(normalized);
        }
    };
    data.tasks.forEach((task) => collect(task.attachments, task.purgedAt));
    data.projects.forEach((project) => collect(project.attachments, project.purgedAt));
    return referenced;
}

export function garbageCollectOrphanAttachments(
    dataDir: string,
    key: string,
    data: AppData,
    removalFileSystem?: DurableRemovalFileSystem,
): {
    deleted: number;
    errors: string[];
    kept: number;
    scanned: number;
} {
    const rootDir = join(dataDir, key, 'attachments');
    if (!existsSync(rootDir)) return { deleted: 0, errors: [], kept: 0, scanned: 0 };
    mkdirSync(rootDir, { recursive: true });
    const rootStat = lstatSync(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        return {
            deleted: 0,
            errors: ['attachment root is not a normal directory'],
            kept: 0,
            scanned: 0,
        };
    }
    const rootRealPath = realpathSync(rootDir);
    const referenced = collectReferencedAttachmentCloudKeys(data);
    const errors: string[] = [];
    let deleted = 0;
    let kept = 0;
    let scanned = 0;

    const visit = (dirPath: string) => {
        for (const dirent of readdirSync(dirPath, { withFileTypes: true })) {
            const entryPath = join(dirPath, dirent.name);
            let stat;
            try {
                stat = lstatSync(entryPath);
            } catch (error) {
                // S9: never surface (error as Error).message — node fs errors embed the
                // absolute server path (and, here, the namespace key). Report the short
                // error code alongside the already-namespace-relative path instead.
                errors.push(`${relative(rootRealPath, entryPath)}: ${getFsErrorCode(error)}`);
                continue;
            }
            if (stat.isDirectory()) {
                visit(entryPath);
                try {
                    if (entryPath !== rootRealPath) {
                        // syncParent: false — this directory's own removal from dirPath's
                        // listing is published by the batched durablySyncDirectory(dirPath)
                        // below, alongside every file this pass removed from dirPath. A
                        // per-entry fsync here would republish the same parent N+1 times.
                        durablyRemoveDirectory(entryPath, removalFileSystem, { syncParent: false });
                    }
                } catch (error) {
                    const code = getFsErrorCode(error);
                    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') {
                        errors.push(`${relative(rootRealPath, entryPath)}: ${code}`);
                    }
                }
                continue;
            }

            scanned += 1;
            const relativePath = normalizeAttachmentRelativePath(relative(rootRealPath, entryPath).replace(/\\/g, '/'));
            if (!relativePath || referenced.has(relativePath)) {
                kept += 1;
                continue;
            }
            if (stat.mtimeMs > Date.now() - ORPHAN_ATTACHMENT_GC_GRACE_MS) {
                kept += 1;
                continue;
            }
            try {
                // syncParent: false — same batching as the directory-prune case above:
                // this file's removal is published by the trailing durablySyncDirectory
                // call for dirPath, not by its own per-entry fsync.
                if (durablyRemoveFile(entryPath, removalFileSystem, { syncParent: false })) {
                    deleted += 1;
                }
            } catch (error) {
                errors.push(`${relativePath}: ${getFsErrorCode(error)}`);
            }
        }
        // S7-CORRECTION: always attempt the trailing sync, even when an entry in this
        // directory failed to remove. With syncParent:false (batched removals above),
        // a removal failure can no longer mean "the parent fsync already failed" — it
        // now only ever means "this one entry couldn't be unlinked/rmdir'd" — so
        // skipping the batch sync here used to leave every OTHER successfully removed
        // entry in the same directory permanently unpublished. This try/catch is the
        // only place a directory-publish failure is now recorded.
        try {
            // Publish the directory even when a prior run already made an unlink
            // visible before its parent fsync failed. Otherwise GC loses the absent
            // file as a retry target and can falsely report a durable clean pass.
            durablySyncDirectory(dirPath, removalFileSystem);
        } catch (error) {
            const relativeDir = relative(rootRealPath, dirPath).replace(/\\/g, '/') || '.';
            errors.push(`${relativeDir}: ${getFsErrorCode(error)}`);
        }
    };

    visit(rootRealPath);
    return { deleted, errors, kept, scanned };
}

/** Route body for POST/DELETE /v1/attachments/orphans, once withNamespace + the write lock have already run. */
export function handleOrphanAttachmentGcRequest(dataDir: string, key: string, filePath: string): Response {
    const dataResult = loadAppDataForWrite(filePath);
    if (dataResult.state === 'unreadable') {
        logFailureWarn('Stored cloud data failed validation before attachment GC', {
            failureClass: 'validation',
            failureCode: 'stored_data_invalid_json',
        });
        return errorResponse('Stored data failed validation', 500);
    }
    const data = dataResult.data;
    const validated = validateAppData(data);
    if (!validated.ok) {
        logFailureWarn('Stored cloud data failed validation before attachment GC', {
            failureClass: 'validation',
            failureCode: 'stored_data_invalid',
        });
        return errorResponse('Stored data failed validation', 500);
    }
    const result = garbageCollectOrphanAttachments(dataDir, key, data);
    const ok = result.errors.length === 0;
    // S8: a GC pass that failed to remove or durably publish some entries is not a
    // 200 — 500 is the existing convention this file already uses for durability/
    // filesystem failures (see e.g. the validation-failure branch above), and unlike
    // 207 it makes response.ok false for every caller without bespoke handling.
    return jsonResponse({ ok, ...result }, { status: ok ? 200 : 500 });
}

const normalizeAttachmentContentType = (value: string | null): string => value?.split(';', 1)[0]?.trim().toLowerCase() || '';

const getBlockedAttachmentSignature = (bytes: Uint8Array): string | null => {
    if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
        return 'windows-pe';
    }
    if (bytes.length >= 4) {
        if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
            return 'elf';
        }
        const signature = `${bytes[0].toString(16).padStart(2, '0')}${bytes[1].toString(16).padStart(2, '0')}`
            + `${bytes[2].toString(16).padStart(2, '0')}${bytes[3].toString(16).padStart(2, '0')}`;
        if (signature === 'feedface' || signature === 'feedfacf' || signature === 'cefaedfe' || signature === 'cffaedfe') {
            return 'mach-o';
        }
    }
    return null;
};

/**
 * Route body for HEAD/GET/PUT/DELETE /v1/attachments/:path, once withNamespace has already
 * resolved and validated the on-disk path (see resolveAttachmentPath in
 * server-storage.ts). Takes the resolved path rather than resolving it itself, so it
 * can be exercised directly against a temp directory without a live server.
 *
 * HEAD shares GET's body below and drops the bytes at the end. It exists for the #1119
 * attachment presence pass: a client that cannot stop a response body early (React Native's
 * XHR transport buffers the whole reply before resolving) would otherwise have to download
 * every attachment to learn whether it is still there.
 */
export async function handleAttachmentPathRequest(
    req: Request,
    pathname: string,
    resolved: { rootRealPath: string; filePath: string },
    options: {
        maxAttachmentBytes: number;
        abortSignal: AbortSignal;
        removalFileSystem?: DurableRemovalFileSystem;
        assertStorageRoot?: () => void;
    },
): Promise<Response> {
    const { rootRealPath, filePath } = resolved;

    if (req.method === 'GET' || req.method === 'HEAD') {
        options.assertStorageRoot?.();
        if (!existsSync(filePath)) {
            options.assertStorageRoot?.();
            return errorResponse('Not found', 404);
        }
        try {
            const realFilePath = realpathSync(filePath);
            if (!isPathWithinRoot(realFilePath, rootRealPath)) {
                options.assertStorageRoot?.();
                return errorResponse('Invalid attachment path', 400);
            }
            const file = readFileSync(realFilePath);
            options.assertStorageRoot?.();
            const headers = new Headers();
            headers.set('Access-Control-Allow-Origin', corsOrigin);
            headers.set('Content-Type', 'application/octet-stream');
            // ponytail: HEAD still reads the file, so its status and Content-Length cannot
            // disagree with GET's. Stat instead of read if presence checks ever get hot.
            if (req.method === 'HEAD') {
                headers.set('Content-Length', String(file.byteLength));
                return new Response(null, { status: 200, headers });
            }
            return new Response(file, { status: 200, headers });
        } catch {
            options.assertStorageRoot?.();
            return errorResponse('Failed to read attachment', 500);
        }
    }

    if (req.method === 'PUT') {
        // Namespace write cap already enforced by withNamespace's guardMethods
        // override (attachmentPathServerConfig) before this handler runs.
        const contentType = normalizeAttachmentContentType(req.headers.get('content-type'));
        if (contentType) {
            const validation = await validateAttachmentForUpload({
                id: 'attachment-upload',
                kind: 'file',
                title: pathname,
                uri: '',
                createdAt: '1970-01-01T00:00:00.000Z',
                updatedAt: '1970-01-01T00:00:00.000Z',
                mimeType: contentType,
            } satisfies Attachment, 0);
            if (!validation.valid && validation.error === 'mime_type_blocked') {
                return errorResponse(`Blocked attachment content type: ${validation.details}`, 400);
            }
        }
        options.assertStorageRoot?.();
        let prepared: PreparedFilePublication | null;
        try {
            prepared = prepareFilePublicationSafely(rootRealPath, filePath, 'upload');
        } catch (error) {
            options.assertStorageRoot?.();
            throw error;
        }
        if (!prepared) {
            options.assertStorageRoot?.();
            return errorResponse('Invalid attachment path', 400);
        }

        try {
            // Reserve the exact staged inode under the verified root before the
            // request body can suspend this handler. Publication later accepts
            // only this stage and the same startup-pinned storage identity.
            const body = await readRequestBytes(req, options.maxAttachmentBytes, options.abortSignal);
            if (isBodyReadError(body)) {
                return errorResponse(body.__mindwtrError.message, body.__mindwtrError.status);
            }
            const blockedSignature = getBlockedAttachmentSignature(body);
            if (blockedSignature) {
                return errorResponse(`Blocked executable attachment signature: ${blockedSignature}`, 400);
            }
            throwIfRequestAborted(options.abortSignal);
            let wrote: boolean;
            try {
                wrote = publishPreparedFilePublication(prepared, body, options.assertStorageRoot);
            } catch (error) {
                options.assertStorageRoot?.();
                throw error;
            }
            if (!wrote) {
                options.assertStorageRoot?.();
                return errorResponse('Invalid attachment path', 400);
            }
            return jsonResponse({ ok: true });
        } finally {
            abandonPreparedFilePublication(prepared);
        }
    }

    if (req.method === 'DELETE') {
        options.assertStorageRoot?.();
        if (!existsSync(filePath)) {
            try {
                options.assertStorageRoot?.();
                durablyRemoveFile(filePath, options.removalFileSystem);
                options.assertStorageRoot?.();
                return jsonResponse({ ok: true });
            } catch {
                options.assertStorageRoot?.();
                return errorResponse('Failed to delete attachment', 500);
            }
        }
        try {
            const realFilePath = realpathSync(filePath);
            if (!isPathWithinRoot(realFilePath, rootRealPath)) {
                options.assertStorageRoot?.();
                return errorResponse('Invalid attachment path', 400);
            }
            options.assertStorageRoot?.();
            durablyRemoveFile(realFilePath, options.removalFileSystem);
            options.assertStorageRoot?.();
            return jsonResponse({ ok: true });
        } catch {
            options.assertStorageRoot?.();
            return errorResponse('Failed to delete attachment', 500);
        }
    }

    return errorResponse('Method not allowed', 405);
}
