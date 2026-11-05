import { base64ToBytes, bytesToBase64, createMobileFileSync, FileSyncPathOwnerTerminatedError, type MobileFileSyncFullHost, type MobileSyncFileSyncPort } from '@mindwtr/core';
import type { NativeFileChannels, NativeFileSyncAttachments } from './host-attachments';

export type NativeFileSyncLease = { readonly turn: string };
export type NativeFileSyncSelection = { readonly turn: string; readonly canonicalPath: string; readonly rootURI: string };
type Reply = { id?: unknown; body?: unknown; value?: unknown; base64?: unknown; error?: unknown; events?: unknown };
export type NativeFileSyncCall = (request: Record<string, unknown>) => Promise<Reply>;
const maximumBytes = 8 * 1024 * 1024;
const refused = (): never => { throw new FileSyncPathOwnerTerminatedError(); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const encode = (bytes: Uint8Array): string => {
    if (bytes.byteLength > maximumBytes) return refused();
    return bytesToBase64(bytes);
};
const decode = (text: unknown): Uint8Array => {
    if (typeof text !== 'string' || text.length > Math.ceil(maximumBytes / 3) * 4) return refused();
    const bytes = base64ToBytes(text);
    if (bytes.byteLength > maximumBytes || bytesToBase64(bytes) !== text) return refused();
    return bytes;
};

const logNativeFileSyncEvents = (events: unknown, log: MobileFileSyncFullHost['log']): void => {
    if (events !== undefined) {
        if (!Array.isArray(events)) return refused();
        for (const event of events) {
            if (!record(event) || typeof event.message !== 'string' || !record(event.context)
                || !['Native iOS File Sync read owner admitted', 'Native iOS File Sync created-file write completed', 'Native iOS File Sync quarantine rename completed', 'Native iOS File Sync owned artifact deletion completed'].includes(event.message)
                || Object.values(event.context).some((v) => typeof v !== 'string')) return refused();
            const expected: Record<string, [string, string, string]> = {
                'Native iOS File Sync read owner admitted': ['v1.3.8/ios-file-sync-read-owner', 'admission', 'confirmed'],
                'Native iOS File Sync created-file write completed': ['v1.3.8/ios-file-sync-created-write', 'createdWrite', 'completed'],
                'Native iOS File Sync quarantine rename completed': ['v1.3.8/ios-file-sync-publication-primitives', 'quarantine', 'completed'],
                'Native iOS File Sync owned artifact deletion completed': ['v1.3.8/ios-file-sync-publication-primitives', 'ownedDelete', 'completed'],
            };
            const fields = expected[event.message];
            if (!fields || Object.keys(event.context).length !== 3 || event.context.releaseCheck !== fields[0]
                || event.context.operation !== fields[1] || event.context.outcome !== fields[2]) return refused();
            log.info(event.message, { scope: 'sync', extra: event.context });
        }
    }
};


/** Resolve once under the owner's live scope. The subsequent port adopts that same session. */
export const prepareNativeFileSync = async (turn: string, call: NativeFileSyncCall,
    log: MobileFileSyncFullHost['log']): Promise<NativeFileSyncSelection> => {
    const reply = await call({ turn, op: 'prepare' });
    if (!record(reply)) return refused();
    logNativeFileSyncEvents(reply.events, log);
    if (typeof reply.id !== 'string' || Object.keys(reply).some((name) => !['id', 'value', 'events'].includes(name))
        || !record(reply.value) || Object.keys(reply.value).length !== 2
        || typeof reply.value.rootURI !== 'string' || !reply.value.rootURI.startsWith('file:///')
        || !reply.value.rootURI.endsWith('/') || typeof reply.value.canonicalPath !== 'string'
        || reply.value.canonicalPath !== reply.value.rootURI + 'data.json'
        || new TextEncoder().encode(reply.value.canonicalPath).byteLength > 16 * 1024) return refused();
    return { turn, rootURI: reply.value.rootURI, canonicalPath: reply.value.canonicalPath };
};

const identity = (value: unknown): boolean => typeof value === 'string' && /^\d{1,20}:\d{1,20}$/.test(value);
const attachmentReplies: Record<string, (value: unknown) => boolean> = {
    attachmentInfo: (value) => record(value) && (value.exists === false ? Object.keys(value).length === 1
        : value.exists === true && Object.keys(value).length === 4 && typeof value.isDirectory === 'boolean'
            && Number.isSafeInteger(value.size) && Number(value.size) >= 0
            && typeof value.modificationTime === 'number' && Number.isFinite(value.modificationTime) && value.modificationTime >= 0),
    attachmentList: (value) => Array.isArray(value) && value.length <= 10_000
        && value.every((name) => typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')),
    attachmentDirectory: (value) => value === null,
    attachmentWrite: (value) => value === null,
    attachmentPrepare: (value) => record(value) && Object.keys(value).length === 3
        && identity(value.stagedIdentity) && identity(value.directoryIdentity) && identity(value.privateDirectoryIdentity),
    attachmentSnapshot: (value) => record(value) && Object.keys(value).length === 2
        && identity(value.stagedIdentity) && identity(value.directoryIdentity),
    attachmentPublish: (value) => value === 'published' || value === 'alreadyExists',
    attachmentCleanup: (value) => value === 'removed' || value === 'missing' || value === 'conflict',
};
const missingAttachment = (): Error => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
const unavailableAttachment = (): Error => new Error('File Sync attachment operation is unavailable');

export type NativeFileSyncPort = MobileSyncFileSyncPort<NativeFileSyncLease> & { readonly attachments: NativeFileSyncAttachments };

export const createNativeFileSync = (selection: NativeFileSyncSelection, call: NativeFileSyncCall,
    host: Pick<MobileFileSyncFullHost, 'encryption' | 'crypto' | 'log'>): NativeFileSyncPort => {
    let opened = false;
    let terminal = false;
    const request = async (op: string, fields: Record<string, unknown> = {}): Promise<Reply> => {
        if (terminal && op !== 'close') return refused();
        try {
            const reply = await call({ turn: selection.turn, op, ...fields });
            if (!record(reply)) return refused();
            logNativeFileSyncEvents(reply.events, host.log);
            if (reply.error !== undefined) return refused();
            const allowed = new Set(['id', 'value', 'events', 'body', 'base64']);
            if (Object.keys(reply).some((name) => !allowed.has(name)) || typeof reply.id !== 'string') return refused();
            if (op === 'read' || op === 'attachmentRead') {
                if (reply.value === 'bytes') { if (reply.body !== true) return refused(); decode(reply.base64); }
                else if ((reply.value !== 'absent' && (op !== 'attachmentRead' || reply.value !== 'tooLarge'))
                    || reply.body !== undefined || reply.base64 !== undefined) return refused();
            } else {
                if (reply.body !== undefined || reply.base64 !== undefined) return refused();
                if (op === 'info') {
                    if (!record(reply.value) || typeof reply.value.exists !== 'boolean'
                        || Object.keys(reply.value).some((field) => !['exists', 'size'].includes(field))
                        || (reply.value.exists ? !Number.isSafeInteger(reply.value.size) || Number(reply.value.size) < 0 : reply.value.size !== undefined)) return refused();
                } else if (op === 'list') {
                    if (!Array.isArray(reply.value) || !reply.value.every((name) => typeof name === 'string')) return refused();
                } else if (op === 'create') {
                    if (reply.value !== 'created' && reply.value !== 'exists') return refused();
                } else if (op === 'renameObserved') {
                    if (reply.value !== selection.rootURI + encodeURIComponent(String(fields.name))) return refused();
                } else if (attachmentReplies[op]) {
                    if (!attachmentReplies[op](reply.value)) return refused();
                } else if (reply.value !== null) return refused();
            }

            return reply;
        } catch {
            terminal = true;
            // Native failures already drain; an invalid decoded envelope also ends the real session.
            if (op !== 'close') { try { await call({ turn: selection.turn, op: 'close' }); } catch { /* Outer native fence retains failure. */ } }
            return refused();
        }
    };
    const value = async (op: string, fields?: Record<string, unknown>) => (await request(op, fields)).value;
    const done = async (op: string, fields?: Record<string, unknown>) => { if (await value(op, fields) !== null) return refused(); };
    const createExclusive = async (uri: string): Promise<'created' | 'exists'> => {
        const answer = await value('create', { uri });
        return answer === 'created' || answer === 'exists' ? answer : refused();
    };
    const writeCreated = async (uri: string, bytes: Uint8Array) => done('writeCreated', { uri, base64: encode(bytes) });
    const mobile = createMobileFileSync({
        ...host, os: () => 'ios', saf: null,
        bookmarks: { supported: () => false, readText: async () => refused() },
        path: {
            exists: async (uri) => { const info = await value('info', { uri }); return record(info) && typeof info.exists === 'boolean' ? info.exists : refused(); },
            info: async (uri) => {
                const info = await value('info', { uri });
                if (!record(info) || typeof info.exists !== 'boolean' || (info.exists && (!Number.isSafeInteger(info.size) || Number(info.size) < 0))) return refused();
                return info.exists ? { exists: true, size: Number(info.size) } : { exists: false };
            },
            list: async (uri) => { const names = await value('list', { uri }); return Array.isArray(names) && names.every((name) => typeof name === 'string') ? names : refused(); },
            readBytes: async (uri) => {
                const answer = await request('read', { uri });
                if (answer.value === 'absent' && answer.base64 === undefined) return null;
                return answer.value === 'bytes' ? decode(answer.base64) : refused();
            },
            readText: async (uri) => {
                const answer = await request('read', { uri });
                if (answer.value === 'absent' && answer.base64 === undefined) return null;
                if (answer.value !== 'bytes') return refused();
                try { return new TextDecoder('utf-8', { fatal: true }).decode(decode(answer.base64)); } catch { return refused(); }
            },
            writeBytes: async () => refused(), delete: async () => refused(), rename: async () => refused(),
            createExclusive, writeCreated,
            observedPublication: { createExclusive, writeCreated,
                renameObserved: async (uri, name, bytes) => {
                    const answer = await value('renameObserved', { uri, name, base64: encode(bytes) });
                    return typeof answer === 'string' ? answer : refused();
                },
                deleteOwned: (uri, bytes) => done('deleteOwned', { uri, base64: encode(bytes) }),
            },
        },
    });
    const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
        try { return await operation(); }
        catch {
            terminal = true;
            try { await call({ turn: selection.turn, op: 'close' }); } catch { /* Outer native fence retains cleanup failure. */ }
            return refused();
        }
    };
    const path = (uri: string) => { if (uri !== selection.canonicalPath) return refused(); };
    return {
        acquireLease: (uri) => owned(async () => { path(uri); if (opened) return refused(); await done('open'); opened = true; return { turn: selection.turn }; }),
        revalidateLease: (lease) => owned(async () => { if (!opened || lease.turn !== selection.turn) return refused(); await done('revalidate'); }),
        releaseLease: (lease) => owned(async () => { if (lease.turn !== selection.turn) return refused(); terminal = true; await done('close'); }),
        resolveUri: (uri) => owned(async () => { path(uri); return uri; }),
        isBookmarksAvailable: () => false, resolveBookmark: async () => refused(),
        readVersioned: (uri, options) => owned(async () => {
            path(uri); if (options.material || options.bookmark) return refused();
            return mobile.readSyncFileVersioned(uri, options);
        }),
        write: (uri, data, options) => owned(async () => {
            path(uri); if (options.material || options.bookmark) return refused();
            await mobile.writeSyncFile(uri, data, options);
        }),
        attachments: createNativeFileSyncAttachments(selection, () => opened && !terminal, request),
    };
};

const createNativeFileSyncAttachments = (selection: NativeFileSyncSelection, admitted: () => boolean,
    request: (op: string, fields?: Record<string, unknown>) => Promise<Reply>): NativeFileSyncAttachments => {
    const directory = selection.rootURI + 'attachments/';
    const inFolder = (uri: unknown): uri is string => typeof uri === 'string' && uri.startsWith(directory);
    let published = 0;
    let downloaded = 0;
    const value = async (op: string, fields: Record<string, unknown>) => {
        if (!admitted() || !inFolder(fields.uri)) throw unavailableAttachment();
        return (await request(op, fields)).value;
    };
    const read = async (uri: string, position: number, length: number | null): Promise<Uint8Array> => {
        if (!Number.isSafeInteger(position) || position < 0 || (length !== null && (!Number.isSafeInteger(length) || length < 0))) throw unavailableAttachment();
        if (length !== null && length > maximumBytes) throw new Error('File Sync attachment read exceeds the 8 MiB transfer limit');
        if (!admitted()) throw unavailableAttachment();
        const answer = await request('attachmentRead', { uri, position, length });
        if (answer.value === 'absent') throw missingAttachment();
        if (answer.value === 'tooLarge') throw new Error('File Sync attachment exceeds the 8 MiB transfer limit');
        return decode(answer.base64);
    };
    const stagePath = (target: string, operationId: string) => `${target.slice(0, target.lastIndexOf('/') + 1)}.mindwtr-install-${operationId}.candidate/stage`;
    return {
        channels: (local: NativeFileChannels): NativeFileChannels => ({ ...local, files: async (input, bytes) => {
            const { op, uri } = input;
            if (op === 'copy' && inFolder(input.to)) throw unavailableAttachment();
            if (!inFolder(uri)) return local.files(input, bytes);
            switch (op) {
                case 'getInfo': return value('attachmentInfo', { uri });
                case 'makeDirectory':
                    if (uri !== directory) throw unavailableAttachment();
                    await value('attachmentDirectory', { uri });
                    return null;
                case 'readDirectory': return value('attachmentList', { uri });
                case 'readBytes': return read(uri, 0, null);
                case 'readBytesRange': return read(uri, Number(input.position), Number(input.length));
                case 'writeBytes':
                    if (!(bytes instanceof Uint8Array)) throw unavailableAttachment();
                    await value('attachmentWrite', { uri, base64: encode(bytes) });
                    return null;
                case 'copy': {
                    if (typeof input.to !== 'string') throw unavailableAttachment();
                    const copied = await read(uri, 0, null);
                    await local.files({ op: 'writeBytes', uri: input.to }, copied);
                    downloaded += 1;
                    return null;
                }
                default: throw unavailableAttachment();
            }
        } }),
        immutable: {
            prepareImmutableStageAsync: async (targetPath, operationId) => {
                const prepared = await value('attachmentPrepare', { uri: targetPath, operationId });
                return { ...(prepared as Record<string, string>), stagedPath: stagePath(targetPath, operationId) };
            },
            snapshotImmutableStageAsync: (stagedPath, targetPath, expectedStagedSha256) => {
                if (!inFolder(targetPath)) throw unavailableAttachment();
                return value('attachmentSnapshot', { uri: stagedPath, target: targetPath, sha256: expectedStagedSha256 });
            },
            publishImmutableAsync: async (stagedPath, targetPath, sha256, stagedIdentity, directoryIdentity, privateDirectoryIdentity) => {
                if (!inFolder(targetPath)) throw unavailableAttachment();
                const status = await value('attachmentPublish', { uri: stagedPath, target: targetPath, sha256, stagedIdentity, directoryIdentity, privateDirectoryIdentity });
                if (status === 'published') published += 1;
                return { status };
            },
            cleanupImmutableStageAsync: async (stagedPath, targetPath, operationId, sha256, stagedIdentity, directoryIdentity, privateDirectoryIdentity) => {
                if (!inFolder(targetPath)) throw unavailableAttachment();
                return { status: await value('attachmentCleanup', { uri: stagedPath, target: targetPath, operationId, sha256, stagedIdentity, directoryIdentity, privateDirectoryIdentity }) };
            },
        },
        drainCounts: () => {
            const counts = { published, downloaded };
            published = 0;
            downloaded = 0;
            return counts;
        },
    };
};
