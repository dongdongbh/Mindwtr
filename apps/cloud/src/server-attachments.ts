


import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'fs';
import { join, relative } from 'path';
import {
    validateAttachmentForUpload,
    type Attachment,
    type AppData,
    type PendingRemoteAttachmentDelete,
    type Project,
} from '@mindwtr/core';
import { corsOrigin, errorResponse, jsonResponse, logFailureWarn, logInfo } from './server-config';
import { loadAppDataForWrite, loadAppDataOrError } from './server-data-cache';
import {
    abandonPreparedFilePublication,
    durablyRemoveDirectory,
    durablyRemoveFile,
    durablySyncDirectory,
    getFsErrorCode,
    isBodyReadError,
    isPathWithinRoot,
    normalizeAttachmentRelativePath,
    pathContainsSymlink,
    prepareFilePublicationSafely,
    publishPreparedFilePublication,
    readRequestBytes,
    throwIfRequestAborted,
    type DurableRemovalFileSystem,
    type PreparedFilePublication,
} from './server-storage';
import { validateAppData } from './server-validation';


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


    const referenced = new Set<string>();
    for (const cloudKey of collectReferencedAttachmentCloudKeys(data)) {
        const rootRelative = cloudKey.startsWith('attachments/')
            ? cloudKey.slice('attachments/'.length)
            : cloudKey;
        const canonical = normalizeAttachmentRelativePath(rootRelative);
        if (!canonical) continue;
        referenced.add(canonical);
        if (rootRelative !== cloudKey) referenced.add(cloudKey);
    }
    const errors: string[] = [];
    let deleted = 0;
    let kept = 0;
    let referencedKept = 0;
    let scanned = 0;

    const visit = (dirPath: string) => {
        for (const dirent of readdirSync(dirPath, { withFileTypes: true })) {
            const entryPath = join(dirPath, dirent.name);
            let stat;
            try {
                stat = lstatSync(entryPath);
            } catch (error) {


                errors.push(`${relative(rootRealPath, entryPath)}: ${getFsErrorCode(error)}`);
                continue;
            }
            if (stat.isDirectory()) {
                visit(entryPath);
                try {
                    if (entryPath !== rootRealPath) {


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
            const isReferenced = Boolean(relativePath && referenced.has(relativePath));
            if (!relativePath || isReferenced) {
                kept += 1;
                if (isReferenced) referencedKept += 1;
                continue;
            }
            if (stat.mtimeMs > Date.now() - ORPHAN_ATTACHMENT_GC_GRACE_MS) {
                kept += 1;
                continue;
            }
            try {


                if (durablyRemoveFile(entryPath, removalFileSystem, { syncParent: false })) {
                    deleted += 1;
                }
            } catch (error) {
                errors.push(`${relativePath}: ${getFsErrorCode(error)}`);
            }
        }


        try {


            durablySyncDirectory(dirPath, removalFileSystem);
        } catch (error) {
            const relativeDir = relative(rootRealPath, dirPath).replace(/\\/g, '/') || '.';
            errors.push(`${relativeDir}: ${getFsErrorCode(error)}`);
        }
    };

    visit(rootRealPath);
    if (referencedKept > 0) {
        logInfo('Referenced attachment files retained during cleanup', {
            count: referencedKept,
            operation: 'orphan-gc',
            outcome: errors.length === 0 ? 'complete' : 'partial',
            releaseCheck: 'v1.3.1/cloud-attachment-gc-retention',
        });
    }
    return { deleted, errors, kept, scanned };
}


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


    return jsonResponse({ ok, ...result }, { status: ok ? 200 : 500 });
}


const historicalCaptureReadPath = (
    dataFilePath: string,
    resolved: { rootRealPath: string; filePath: string },
    assertStorageRoot?: () => void,
): string | Response | null => {
    const { rootRealPath, filePath } = resolved;
    const requested = normalizeAttachmentRelativePath(relative(rootRealPath, filePath).replace(/\\/g, '/'));
    if (!requested || requested.includes('/')) return null;
    const cloudKey = normalizeAttachmentRelativePath(`attachments/${requested}`);
    if (!cloudKey) return null;

    assertStorageRoot?.();
    const loaded = loadAppDataOrError(dataFilePath);
    assertStorageRoot?.();
    if ('error' in loaded) return loaded.error;
    const validated = validateAppData(loaded);
    assertStorageRoot?.();
    if (!validated.ok) return errorResponse('Stored data failed validation', 500);
    const referenced = collectReferencedAttachmentCloudKeys(validated.data).has(cloudKey);
    assertStorageRoot?.();
    if (!referenced) return null;

    const historicalPath = join(rootRealPath, 'attachments', requested);
    if (!isPathWithinRoot(historicalPath, rootRealPath) || pathContainsSymlink(rootRealPath, historicalPath)) {
        assertStorageRoot?.();
        return errorResponse('Invalid attachment path', 400);
    }
    assertStorageRoot?.();
    let stat: ReturnType<typeof lstatSync>;
    try {
        stat = lstatSync(historicalPath);
    } catch (error) {
        assertStorageRoot?.();
        if (getFsErrorCode(error) === 'ENOENT') return null;
        return errorResponse('Failed to read attachment', 500);
    }
    assertStorageRoot?.();
    if (!stat.isFile() || stat.isSymbolicLink()) return errorResponse('Invalid attachment path', 400);
    let realFilePath: string;
    try {
        realFilePath = realpathSync(historicalPath);
    } catch (error) {
        assertStorageRoot?.();
        if (getFsErrorCode(error) === 'ENOENT') return null;
        return errorResponse('Failed to read attachment', 500);
    }
    assertStorageRoot?.();
    if (!isPathWithinRoot(realFilePath, rootRealPath)) return errorResponse('Invalid attachment path', 400);
    return historicalPath;
};

const attachmentPathMissing = (filePath: string): boolean => {
    try {
        lstatSync(filePath);
        return false;
    } catch (error) {
        if (getFsErrorCode(error) === 'ENOENT') return true;
        throw error;
    }
};

const normalizeAttachmentContentType = (value: string | null): string => value?.split(';', 1)[0]?.trim().toLowerCase() || '';


export const getBlockedAttachmentSignature = (bytes: Uint8Array): string | null => {
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


export async function handleAttachmentPathRequest(
    req: Request,
    pathname: string,
    resolved: { rootRealPath: string; filePath: string },
    options: {
        maxAttachmentBytes: number;
        abortSignal: AbortSignal;
        removalFileSystem?: DurableRemovalFileSystem;
        assertStorageRoot?: () => void;
        historicalDataFilePath?: string;
    },
): Promise<Response> {
    const { rootRealPath, filePath } = resolved;

    if (req.method === 'GET' || req.method === 'HEAD') {
        options.assertStorageRoot?.();
        let selectedPath = filePath;
        if (attachmentPathMissing(filePath)) {
            if (!options.historicalDataFilePath) {
                options.assertStorageRoot?.();
                return errorResponse('Not found', 404);
            }
            const historical = historicalCaptureReadPath(options.historicalDataFilePath, resolved, options.assertStorageRoot);
            if (historical instanceof Response) return historical;
            if (!historical) {
                options.assertStorageRoot?.();
                return errorResponse('Not found', 404);
            }

            selectedPath = attachmentPathMissing(filePath) ? historical : filePath;
        }
        try {
            if (selectedPath !== filePath && pathContainsSymlink(rootRealPath, selectedPath)) {
                options.assertStorageRoot?.();
                return errorResponse('Invalid attachment path', 400);
            }
            const realFilePath = realpathSync(selectedPath);
            if (!isPathWithinRoot(realFilePath, rootRealPath)) {
                options.assertStorageRoot?.();
                return errorResponse('Invalid attachment path', 400);
            }
            if (selectedPath !== filePath && !lstatSync(selectedPath).isFile()) {
                options.assertStorageRoot?.();
                return errorResponse('Invalid attachment path', 400);
            }
            const file = readFileSync(realFilePath);
            options.assertStorageRoot?.();
            if (selectedPath !== filePath) {
                const linked = pathContainsSymlink(rootRealPath, selectedPath);
                options.assertStorageRoot?.();
                if (linked) return errorResponse('Invalid attachment path', 400);
                logInfo('Legacy capture audio served from historical layout', {
                    method: req.method,
                    operation: 'legacy-capture-audio-read',
                    outcome: 'served',
                    releaseCheck: 'v1.3.1/legacy-capture-audio',
                });
            }
            const headers = new Headers();
            headers.set('Access-Control-Allow-Origin', corsOrigin);
            headers.set('Content-Type', 'application/octet-stream');


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
