import { base64ToBytes, bytesToBase64, createMobileFileSync, FileSyncPathOwnerTerminatedError, type AppData, type MobileFileSyncFullHost, type MobileSyncFileSyncPort } from '@mindwtr/core';

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

/** The first native app binding admits metadata documents only, before either side can merge. */
export const assertNativeFileSyncData = (data: AppData): void => {
    if (data.tasks.some((task) => (task.attachments?.length ?? 0) !== 0)
        || data.projects.some((project) => (project.attachments?.length ?? 0) !== 0)) {
        throw new Error('Native iOS File Sync attachments are unavailable');
    }
};

export const createNativeFileSync = (selection: NativeFileSyncSelection, call: NativeFileSyncCall,
    host: Pick<MobileFileSyncFullHost, 'encryption' | 'crypto' | 'log'>): MobileSyncFileSyncPort<NativeFileSyncLease> => {
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
            if (op === 'read') {
                if (reply.value === 'bytes') { if (reply.body !== true) return refused(); decode(reply.base64); }
                else if (reply.value !== 'absent' || reply.body !== undefined || reply.base64 !== undefined) return refused();
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
            const result = await mobile.readSyncFileVersioned(uri, options); assertNativeFileSyncData(result.data); return result;
        }),
        write: (uri, data, options) => owned(async () => {
            path(uri); if (options.material || options.bookmark) return refused(); assertNativeFileSyncData(data);
            await mobile.writeSyncFile(uri, data, options);
        }),
    };
};
