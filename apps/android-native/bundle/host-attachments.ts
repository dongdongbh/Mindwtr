/**
 * Attachments on the Android host: core's mobile attachment modules (files, common, installer, availability, the WebDAV and
 * self-hosted cloud passes, the cleanup run), bound to this host's ports as React Native's lib/attachment-sync-utils.ts,
 * attachment-sync-backends.ts, attachment-sync-availability.ts, attachment-file-installer.ts and sync-attachment-cleanup.ts
 * bind them to Expo. Every rule is core's; this file only binds:
 *
 * - core's file port to the host's app-private files (host-polyfills.js `__mindwtrFileCall`, HostFiles.kt), off the engine
 *   thread, with expo-file-system's units (getInfo's modificationTime in seconds);
 * - core's native installer port to RN's installer Kotlin (`__mindwtrInstallerCall`, HostInstaller.kt);
 * - the device keys, the keystore, the log, sync encryption's state and cipher, through host-sync.ts's bindings.
 *
 * Not on this host yet, and refused the way an unbound port is: File Sync's folder and its immutable publication (S5), Dropbox
 * (S4), the streamed upload (a WebDAV or cloud upload sends its bytes in one PUT, as RN does where expo has no upload task).
 */
// Load this leaf directly across deferred store imports and the iOS core alias.
import { createMobileAttachmentAvailability } from '../../../packages/core/src/mobile-attachment-availability';
import {
    CLOUD_ALLOW_INSECURE_HTTP_KEY, CLOUD_PROVIDER_KEY, CLOUD_URL_KEY,
    SYNC_BACKEND_KEY, SYNC_PATH_BOOKMARK_KEY, SYNC_PATH_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY, WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY, WEBDAV_URL_KEY, WEBDAV_USERNAME_KEY,
} from '../../../packages/core/src/sync-storage-keys';
import {
    createMobileAttachmentBackends,
    createMobileAttachmentCommon,
    createMobileAttachmentFiles,
    createMobileAttachmentInstaller,
    getBaseSyncUrl,
    getCloudBaseUrl,
    runMobileAttachmentCleanup,
    setSha256HexProvider,
    type MobileAttachmentFileInfo,
    type MobileAttachmentFileSystemPort,
    type MobileSyncAttachmentsPort,
    type MobileSyncEncryptionPort,
    type MobileSyncLogPort,
    type MobileSyncDropboxAuthPort,
    type NativeAttachmentFileInstaller,
    type NativeAttachmentsHost,
    type SyncCryptoPrimitives,
    type SyncKeyValueStoragePort,
} from '@mindwtr/core';

type FileCall = (request: Record<string, unknown>, bytes?: Uint8Array) => Promise<unknown>;

export type NativeAttachmentBindings = {
    storage: SyncKeyValueStoragePort;
    getSecureConfigValue: (key: string) => Promise<string | null>;
    log: Pick<MobileSyncLogPort, 'info' | 'warn' | 'sanitize'>;
    /** Sync encryption's cipher (host-sync.ts: refused until the crypto bridge, S4, so an encrypted upload fails closed). */
    crypto: SyncCryptoPrimitives;
    encryption: Pick<MobileSyncEncryptionPort, 'logSyncEncryptionEvent' | 'getSyncEncryptionMaterial'>;
    fetch?: typeof fetch;
    dropboxAuth?: Pick<MobileSyncDropboxAuthPort, 'getValidAccessToken' | 'forceRefreshAccessToken'>;
    getDropboxClientId?: () => Promise<string>;
    maxWebdavBufferedUploadBytes?: number;
};

declare const globalThis: Record<string, unknown>;

const unavailable = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available on this build yet`);
};

/** The host's file channels (host-polyfills.js), or null on a host without app files (iOS, the gates' stand-in bridge). */
export type NativeFileChannels = {
    files: FileCall;
    installer: FileCall;
    directories: { document: string; cache: string };
    /** A delete on the engine thread, at once (CoreHost's fileDeleteNow): the turn that asked keep() is the turn that deletes. */
    deleteNow: (uri: string) => void;
};

const NATIVE_ERROR = '!MindwtrNativeError:';

export const nativeFileChannels = (): NativeFileChannels | null => {
    const files = globalThis.__mindwtrFileCall as FileCall | undefined;
    const installer = globalThis.__mindwtrInstallerCall as FileCall | undefined;
    const bridge = globalThis.__mindwtrNative as { fileDirectories?: () => string; fileDeleteNow?: (uri: string) => unknown } | undefined;
    if (!files || !installer || typeof bridge?.fileDirectories !== 'function' || typeof bridge.fileDeleteNow !== 'function') return null;
    const text = bridge.fileDirectories();
    if (text.startsWith(NATIVE_ERROR)) throw new Error(text.slice(NATIVE_ERROR.length));
    const deleteNow = (uri: string) => {
        const answer = bridge.fileDeleteNow!(uri);
        if (typeof answer === 'string' && answer.startsWith(NATIVE_ERROR)) throw new Error(answer.slice(NATIVE_ERROR.length));
    };
    return { files, installer, directories: JSON.parse(text) as { document: string; cache: string }, deleteNow };
};

const bindNativeAttachmentFiles = (bindings: NativeAttachmentBindings, channels: NativeFileChannels) => {
    const call = channels.files;
    const { directories } = channels;
    // expo-file-system as RN's attachment-sync-utils.ts binds it; URIs pass through as they are.
    const fs: MobileAttachmentFileSystemPort = {
        documentDirectory: () => directories.document,
        cacheDirectory: () => directories.cache,
        getInfo: async (uri) => await call({ op: 'getInfo', uri }) as MobileAttachmentFileInfo,
        makeDirectory: async (uri) => { await call({ op: 'makeDirectory', uri }); },
        readDirectory: async (uri) => await call({ op: 'readDirectory', uri }) as string[],
        readBytes: async (uri) => await call({ op: 'readBytes', uri }) as Uint8Array,
        readBytesRange: async (uri, position, length) => await call({ op: 'readBytesRange', uri, position, length }) as Uint8Array,
        writeBytes: async (uri, bytes) => { await call({ op: 'writeBytes', uri }, bytes); },
        copy: async (from, to) => { await call({ op: 'copy', uri: from, to }); },
        move: async (from, to) => { await call({ op: 'move', uri: from, to }); },
        delete: async (uri) => { await call({ op: 'delete', uri }); },
        // A managed copy's delete (core's deleteManagedAttachmentFile): the files thread first finishes every call made before it
        // (`barrier`), then this engine turn asks keep() over the store as it is now and deletes at once, so a sync or command
        // that restored the attachment meanwhile (they run on this thread too) keeps its bytes (review finding 1).
        deleteUnlessKept: async (uri, keep) => {
            await call({ op: 'barrier' });
            if (keep()) return false;
            channels.deleteNow(uri);
            // The unlink above decided it; the folder's sync (slow, deciding nothing) runs on the files thread.
            await call({ op: 'syncParent', uri }).catch(() => undefined);
            return true;
        },
        // Storage Access Framework folders come with File Sync (S5).
        saf: () => null,
        // A file's SHA-256 streamed by the host, so an upload snapshot or a content check never reads the file into the engine.
        sha256: async (uri) => await call({ op: 'sha256File', uri }) as string,
    };

    const files = createMobileAttachmentFiles({
        fs,
        storage: bindings.storage,
        getSecureConfigValue: (key) => bindings.getSecureConfigValue(key),
        log: bindings.log,
        fetch: bindings.fetch ?? ((input, init) => fetch(input, init)),
        dropboxAuth: bindings.dropboxAuth ?? { getValidAccessToken: unavailable('Dropbox'), forceRefreshAccessToken: unavailable('Dropbox') },
    });

    // RN's installer Kotlin (HostInstaller.kt): install and hash. File Sync's immutable publication comes with S5.
    const fileSync = unavailable('File sync');
    const nativeInstaller: NativeAttachmentFileInstaller = {
        installAsync: (stagedPath, targetPath, expected, expectedDownloadSha256) =>
            channels.installer({ op: 'install', staged: stagedPath, target: targetPath, expected, expectedDownloadSha256 }),
        hashAsync: (path) => channels.installer({ op: 'hash', path }),
        publishImmutableAsync: fileSync,
        prepareImmutableStageAsync: fileSync,
        snapshotImmutableStageAsync: fileSync,
        cleanupImmutableStageAsync: fileSync,
    };
    const installer = createMobileAttachmentInstaller({
        loadNativeModule: () => nativeInstaller,
        storage: bindings.storage,
        log: { info: (message, context) => bindings.log.info(message, context) },
    });

    const common = createMobileAttachmentCommon({
        fs,
        files,
        crypto: bindings.crypto,
        encryption: { logSyncEncryptionEvent: (event, extra, options) => bindings.encryption.logSyncEncryptionEvent(event, extra, options) },
        installer: { installAttachmentFileGeneration: (...args) => installer.installAttachmentFileGeneration(...args) },
        // The installer is part of this app: a missing one is a packaging bug, never papered over.
        installerMayBeMissing: () => false,
        // The engine's timers run whenever the host pumps (CoreHost), in the background too.
        timersPaused: () => false,
        // No cancellable streamed upload here: core falls back to its bounded one-request PUT, as RN does without expo's task.
        uploads: { createUploadTask: () => null },
    });

    const availability = createMobileAttachmentAvailability({
        files,
        common,
        storage: { getItem: (key) => bindings.storage.getItem(key) },
        encryption: { getSyncEncryptionMaterial: () => bindings.encryption.getSyncEncryptionMaterial() },
        // No Dropbox app key on this build yet (S4): a Dropbox attachment reads as unavailable.
        getDropboxClientId: bindings.getDropboxClientId ?? (async () => ''),
    });

    const contractHost: NativeAttachmentsHost = {
        persistAttachmentLocally: (attachment) => files.persistAttachmentLocally(attachment),
        ensureAttachmentAvailableDetailed: (attachment) => availability.ensureAttachmentAvailableDetailed(attachment),
        deleteManagedAttachmentFile: (attachment, options) => files.deleteManagedAttachmentFile(attachment, options),
    };
    // Install the global provider only after every optional binding constructed
    // successfully. A refused local capability leaves the prior provider intact.
    setSha256HexProvider(async (bytes) => await call({ op: 'sha256' }, bytes) as string);
    return { fs, files, common, installer, contractHost };
};

export const createNativeAttachments = (bindings: NativeAttachmentBindings, channels: NativeFileChannels) => {
    const { fs, files, common, installer, contractHost } = bindNativeAttachmentFiles(bindings, channels);

    const backends = createMobileAttachmentBackends({
        fs,
        files,
        common,
        installer,
        log: { sanitize: (message) => bindings.log.sanitize(message) },
        maxWebdavBufferedUploadBytes: bindings.maxWebdavBufferedUploadBytes,
    });

    /** Sync's attachment passes (core's mobile sync service), as RN's lib/sync-service.ts binds them. */
    const syncPort: MobileSyncAttachmentsPort = {
        syncWebdav: (data, config, signal, options) => backends.syncWebdavAttachments(data, config, getBaseSyncUrl(config.url), signal, options),
        syncCloud: (data, config, options) => backends.syncCloudAttachments(data, config, getCloudBaseUrl(config.url), options),
        // Dropbox (S4) and File Sync (S5) are not offered on this host, so a cycle never reaches these.
        syncDropbox: async () => null,
        syncFile: async () => null,
        cleanupTempFiles: () => files.cleanupAttachmentTempFiles(),
        hasCompletedPresenceReconciliation: () => files.hasCompletedAttachmentPresenceReconciliation(),
        hasPendingWork: (data, options) => files.hasPendingAttachmentSyncWork(data, options),
        runCleanup: (options) => runMobileAttachmentCleanup(options, { fs }),
    };

    return { contractHost, syncPort };
};

export type NativeAttachments = ReturnType<typeof createNativeAttachments>;

const LOCAL_UNAVAILABLE = 'Local attachment capability is not available on this host';
class LocalAttachmentUnavailableError extends Error {
    constructor() { super(LOCAL_UNAVAILABLE); }
}
const refuseLocal = async (): Promise<never> => { throw new LocalAttachmentUnavailableError(); };
const LOCAL_CONFIG_READS = new Set<string>([
    SYNC_BACKEND_KEY, SYNC_PATH_KEY, SYNC_PATH_BOOKMARK_KEY, CLOUD_PROVIDER_KEY, CLOUD_URL_KEY,
    CLOUD_ALLOW_INSECURE_HTTP_KEY, WEBDAV_URL_KEY, WEBDAV_USERNAME_KEY,
    WEBDAV_ALLOW_INSECURE_HTTP_KEY, WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY,
]);

/** Explicit unbound configuration ports, not a replacement device key-value store. */
export const createNativeLocalAttachmentConfiguration = (): NativeAttachmentBindings => ({
    storage: {
        getItem: async (name) => {
            if (!LOCAL_CONFIG_READS.has(name)) return refuseLocal();
            return null;
        },
        setItem: refuseLocal,
        removeItem: refuseLocal,
    },
    getSecureConfigValue: refuseLocal,
    // Core's detailed attachment logs can include imported IDs. The local slice
    // reports only its fixed aggregate acknowledgment through host-entry's queue.
    log: { info: () => {}, warn: () => {}, sanitize: () => LOCAL_UNAVAILABLE },
    crypto: {
        argon2id: refuseLocal, aesGcmSeal: refuseLocal, aesGcmOpen: refuseLocal,
        randomBytes: () => { throw new LocalAttachmentUnavailableError(); },
    },
    encryption: {
        getSyncEncryptionMaterial: refuseLocal,
        logSyncEncryptionEvent: () => { throw new LocalAttachmentUnavailableError(); },
    },
    fetch: refuseLocal,
    dropboxAuth: { getValidAccessToken: refuseLocal, forceRefreshAccessToken: refuseLocal },
    getDropboxClientId: refuseLocal,
});

/** Local file policy only: no backend construction, cleanup or sync port escapes. */
export const createNativeLocalAttachments = (channels: NativeFileChannels) => {
    const { contractHost } = bindNativeAttachmentFiles(createNativeLocalAttachmentConfiguration(), channels);
    const localHost: NativeAttachmentsHost = {
        ...contractHost,
        ensureAttachmentAvailableDetailed: async (attachment) => {
            try { return await contractHost.ensureAttachmentAvailableDetailed(attachment); }
            catch (error) {
                // Shared availability's unconfigured WebDAV fallback may ask an
                // explicitly unbound secure port. This host has no remote bytes;
                // only our own fixed capability refusal maps to unavailable.
                if (error instanceof LocalAttachmentUnavailableError) return { status: 'unavailable' };
                throw error;
            }
        },
    };
    return { contractHost: localHost };
};

/** Optional iOS capability. Partial/refused channels never fail library boot. */
export const createNativeLocalAttachmentsForHost = () => {
    if (globalThis.__mindwtrHostPlatform !== 'ios') return null;
    const bridge = globalThis.__mindwtrNative as Record<string, unknown> | undefined;
    if (!bridge || !['fileCall', 'installerCall', 'fileAbort', 'fileDirectories', 'fileDeleteNow', 'ioNext', 'ioBody']
        .every((name) => typeof bridge[name] === 'function')
        || typeof globalThis.__mindwtrFileCall !== 'function' || typeof globalThis.__mindwtrInstallerCall !== 'function') return null;
    try {
        const channels = nativeFileChannels();
        if (!channels || Object.keys(channels.directories).sort().join(',') !== 'cache,document'
            || !Object.values(channels.directories).every((value) => typeof value === 'string' && value.length <= 4096
                && value.startsWith('file:///') && value.endsWith('/'))) return null;
        return createNativeLocalAttachments(channels);
    } catch { return null; }
};
