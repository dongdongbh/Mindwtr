import { isDropboxUnauthorizedError, DropboxConflictError } from './dropbox';
import { traceSection } from './perf-trace';
import { normalizeCloudUrl, normalizeWebdavUrl } from './sync-helpers';
import { normalizeRemoteWriteResult } from './sync-run';
import { SyncRemoteWriteConflict, type SyncBackendIO, type SyncEncryptionPosture, type SyncRunAttachmentHelpers } from './sync-run-ports';
import {
    SyncEncryptionRemotePlaintextError,
    SyncEncryptionRemoteVersionUnavailableError,
    syncEncryptedArtifactName,
} from './sync-encryption';
import type { SyncCryptoKdfParams } from './sync-crypto';
import type { SyncEncryptionRemoteVersionKind } from './sync-encryption-diagnostics';
import type { CloudProvider } from './sync-client-helpers';
import { SYNC_FILE_NAME, type SyncBackend } from './sync-service-utils';
import type { AppData } from './types';
import type { SyncRemoteMutationFenceLease } from './sync-remote-fence';
import {
    getWebdavDocumentVersionFromError,
    isWebdavRemoteWriteConflictError,
    normalizeStrongWebdavEtag,
    type WebDavDocumentVersion,
} from './webdav';


export type SyncBackendContext = {
    backend: SyncBackend;
    cloudProvider: CloudProvider;
    webdav?: { url: string } | null;
    cloud?: { url: string } | null;
    filePath?: string;
    dropboxAppKey?: string;

    syncUrl?: string;


    dropboxRev: string | null;


    allowLegacyWebdavPlaintext?: boolean;


    syncEncryptionOff?: boolean;
};


type RemoteWriteResult = Parameters<typeof normalizeRemoteWriteResult>[1];
type RemoteHeadResult = { exists: boolean; fingerprint: string | null } | null | undefined;
type DropboxRevResult = { rev: string | null };
type DropboxDownloadResult = { data: AppData | null; rev: string | null };
type AttachmentSyncResult = Promise<AppData | boolean | null | undefined>;


export type WebdavSyncDocumentRead = WebDavDocumentVersion & { state?: 'data'; data: AppData | null };


export type WebdavSyncReadResult =
    | WebdavSyncDocumentRead
    | (WebDavDocumentVersion & { state: 'encrypted-no-key'; salt: Uint8Array; params: SyncCryptoKdfParams })
    | (WebDavDocumentVersion & { state: 'remote-plaintext' });

export type FileSyncReadResult = {
    data: AppData;
    fingerprint: string;
    source?: string;
    needsRepair?: boolean;
};


export type SyncTransport = {
    acquireWebdavRemoteMutationFence?(): Promise<SyncRemoteMutationFenceLease>;
    acquireDropboxRemoteMutationFence?(token: string): Promise<SyncRemoteMutationFenceLease>;
    webdavGet(): Promise<WebdavSyncReadResult>;

    webdavPut(
        sanitized: AppData,
        expectedEtag: string | null,
        assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>,
    ): Promise<RemoteWriteResult>;


    webdavPutLegacyPlaintext?(
        sanitized: AppData,
        assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>,
    ): Promise<RemoteWriteResult>;
    webdavHead(): Promise<RemoteHeadResult>;
    cloudGet(): Promise<AppData | null | undefined>;
    cloudPut(sanitized: AppData): Promise<RemoteWriteResult>;
    cloudHead(): Promise<RemoteHeadResult>;
    fileRead(): Promise<AppData | FileSyncReadResult | null | undefined>;
    fileWrite(sanitized: AppData, expectedFingerprint?: string): Promise<void>;
    cloudKitRead(): Promise<AppData | null | undefined>;
    cloudKitWrite(sanitized: AppData): Promise<void>;

    resolveDropboxToken(forceRefresh: boolean): Promise<string>;
    dropboxDownload(token: string): Promise<DropboxDownloadResult>;
    dropboxUpload(
        token: string,
        sanitized: AppData,
        expectedRev: string | null,
        assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>,
    ): Promise<DropboxRevResult>;
    dropboxMetadata(token: string): Promise<DropboxRevResult>;
    syncWebdavAttachments(data: AppData, helpers: SyncRunAttachmentHelpers): AttachmentSyncResult;
    syncCloudAttachments(data: AppData, helpers: SyncRunAttachmentHelpers): AttachmentSyncResult;
    syncDropboxAttachments(data: AppData, helpers: SyncRunAttachmentHelpers): AttachmentSyncResult;
    syncFileAttachments(data: AppData, helpers: SyncRunAttachmentHelpers): AttachmentSyncResult;
    syncCloudKitAttachments(data: AppData, helpers: SyncRunAttachmentHelpers): AttachmentSyncResult;
};

const DROPBOX_REV_FINGERPRINT_PREFIX = 'dropbox:v1:rev=';
const WEBDAV_ETAG_FINGERPRINT_PREFIX = 'webdav:v1:etag=';


export const buildDropboxRevFingerprint = (rev: string): string => `${DROPBOX_REV_FINGERPRINT_PREFIX}${rev}`;


const strongEtagFromWebdavFingerprint = (fingerprint: string): string | null => (
    fingerprint.startsWith(WEBDAV_ETAG_FINGERPRINT_PREFIX)
        ? normalizeStrongWebdavEtag(fingerprint.slice(WEBDAV_ETAG_FINGERPRINT_PREFIX.length))
        : null
);

const isFileSyncReadResult = (value: AppData | FileSyncReadResult): value is FileSyncReadResult => (
    typeof value === 'object'
    && value !== null
    && 'data' in value
    && 'fingerprint' in value
    && typeof value.fingerprint === 'string'
);

export function createSyncBackendIO(
    ctx: SyncBackendContext,
    transport: SyncTransport,
    posture?: SyncEncryptionPosture,
): SyncBackendIO {
    let fileRemoteFingerprint: string | null = null;
    let fileRemoteNeedsRepair = false;
    let webdavDocumentVersion: WebDavDocumentVersion | null = null;
    let webdavDocumentSnapshot: string | null = null;
    const snapshotWebdavRead = (remote: WebdavSyncDocumentRead): string => JSON.stringify({
        exists: remote.exists,
        data: remote.data,
    });


    const readWebdavDocument = async (): Promise<WebdavSyncDocumentRead> => {
        const remote = await transport.webdavGet();
        const material = posture?.material ?? null;
        const version: SyncEncryptionRemoteVersionKind = normalizeStrongWebdavEtag(remote.strongEtag)
            ? 'strong'
            : remote.strongEtag ? 'weak' : 'none';
        const logRemoteRead = posture?.logRemoteRead.bind(posture) ?? (() => {});

        if (remote.state === 'remote-plaintext') {
            logRemoteRead({
                artifact: SYNC_FILE_NAME,
                exists: true,
                kind: 'plaintext',
                version,
                decision: 'plaintext-discovered',
            });
            await posture?.onRemotePlaintextDiscovered();
            throw new SyncEncryptionRemotePlaintextError('the WebDAV remote is no longer encrypted');
        }
        if (remote.state === 'encrypted-no-key') {
            logRemoteRead({
                artifact: syncEncryptedArtifactName(SYNC_FILE_NAME),
                exists: true,
                kind: 'encrypted',
                headerSalt: remote.salt,
                headerKdf: remote.params,
                version,
                foreignSalt: material !== null,
                decision: version === 'strong' ? 'no-key' : 'version-unavailable',
            });


            if (version !== 'strong') {
                throw new SyncEncryptionRemoteVersionUnavailableError('WebDAV encrypted sync document');
            }


            if (!posture) {
                throw new Error('WebDAV remote is encrypted; createSyncBackendIO needs a SyncEncryptionPosture to read it');
            }
            await posture.onRemoteEncryptionDiscovered({ salt: remote.salt, params: remote.params });
            throw posture.noKeyError();
        }


        const encryptedRead = material !== null || ctx.syncEncryptionOff === false;
        logRemoteRead({
            artifact: encryptedRead ? syncEncryptedArtifactName(SYNC_FILE_NAME) : SYNC_FILE_NAME,
            exists: remote.exists,
            kind: remote.exists ? (encryptedRead ? 'encrypted' : 'plaintext') : 'absent',
            headerSalt: material?.salt,
            headerKdf: material?.params,
            version,
            foreignSalt: false,
            decision: !remote.exists
                ? 'absent'
                : encryptedRead
                    ? (version === 'strong' ? 'decrypt' : 'version-unavailable')
                    : (version === 'strong' ? 'plaintext' : 'legacy-plaintext'),
        });
        if (remote.exists && version !== 'strong') {
            if (encryptedRead) {
                throw new SyncEncryptionRemoteVersionUnavailableError('WebDAV encrypted sync document');
            }
            if (!ctx.allowLegacyWebdavPlaintext) {


                posture?.onWeakEtagPlaintextRead?.(remote.strongEtag ?? null);
            }
        }
        if (material && remote.exists && remote.data !== null) {
            await posture?.onRemoteEncryptionVerified?.(material);
        }
        return remote;
    };


    const runDropboxWithAuthRetry = async <T>(operation: (token: string) => Promise<T>): Promise<T> => {
        let forceRefresh = false;
        let retried = false;
        while (true) {
            const token = await transport.resolveDropboxToken(forceRefresh);
            try {
                return await operation(token);
            } catch (error) {
                if (retried || !isDropboxUnauthorizedError(error)) throw error;
                retried = true;
                forceRefresh = true;
            }
        }
    };

    return {
        acquireRemoteMutationFence: async () => {
            if (ctx.backend === 'webdav' && ctx.webdav?.url) {


                if (ctx.allowLegacyWebdavPlaintext) return null;
                return transport.acquireWebdavRemoteMutationFence?.() ?? null;
            }
            if (ctx.backend === 'cloud' && ctx.cloudProvider === 'dropbox') {
                if (!transport.acquireDropboxRemoteMutationFence) return null;
                return runDropboxWithAuthRetry((token) => transport.acquireDropboxRemoteMutationFence!(token));
            }
            return null;
        },
        getSyncUrl: () => ctx.syncUrl,
        getCachedRemoteFingerprint: () => (
            ctx.backend === 'cloud' && ctx.cloudProvider === 'dropbox' && ctx.dropboxRev
                ? buildDropboxRevFingerprint(ctx.dropboxRev)
                : null
        ),
        adoptRemoteFingerprintForWrite: (fingerprint) => {
            if (ctx.backend === 'webdav') {


                if (ctx.allowLegacyWebdavPlaintext) return false;
                const strongEtag = strongEtagFromWebdavFingerprint(fingerprint);
                if (!strongEtag) return false;
                webdavDocumentVersion = { exists: true, strongEtag };


                webdavDocumentSnapshot = null;
                return true;
            }
            if (ctx.backend === 'cloud' && ctx.cloudProvider === 'dropbox') {
                if (!fingerprint.startsWith(DROPBOX_REV_FINGERPRINT_PREFIX)) return false;
                const rev = fingerprint.slice(DROPBOX_REV_FINGERPRINT_PREFIX.length);
                if (!rev) return false;


                ctx.dropboxRev = rev;
                return true;
            }


            return false;
        },
        readRemote: async () => {
            if (ctx.backend === 'cloudkit') {
                return transport.cloudKitRead();
            }
            if (ctx.backend === 'webdav') {
                if (!ctx.webdav?.url) {
                    throw new Error('WebDAV URL not configured');
                }
                ctx.syncUrl = normalizeWebdavUrl(ctx.webdav.url);
                try {
                    const remote = await readWebdavDocument();
                    webdavDocumentVersion = { exists: remote.exists, strongEtag: remote.strongEtag };
                    webdavDocumentSnapshot = traceSection('sync:readSnapshot', () => snapshotWebdavRead(remote));


                    if (
                        ctx.syncEncryptionOff
                        && !ctx.allowLegacyWebdavPlaintext
                        && remote.exists
                        && !remote.strongEtag
                    ) {
                        ctx.allowLegacyWebdavPlaintext = true;
                    }
                    return remote.data;
                } catch (error) {


                    webdavDocumentVersion = getWebdavDocumentVersionFromError(error);
                    webdavDocumentSnapshot = null;
                    throw error;
                }
            }
            if (ctx.backend === 'cloud') {
                if (ctx.cloudProvider === 'selfhosted') {
                    if (!ctx.cloud?.url) {
                        throw new Error('Self-hosted URL not configured');
                    }
                    ctx.syncUrl = normalizeCloudUrl(ctx.cloud.url);
                    return transport.cloudGet();
                }
                if (!ctx.dropboxAppKey) {
                    throw new Error('Dropbox app key is not configured');
                }
                ctx.syncUrl = 'dropbox:///Apps/Mindwtr/data.json';
                const remote = await runDropboxWithAuthRetry((token) => transport.dropboxDownload(token));
                ctx.dropboxRev = remote.rev;
                return remote.data;
            }
            const remote = await transport.fileRead();
            if (remote && isFileSyncReadResult(remote)) {
                fileRemoteFingerprint = remote.fingerprint;
                fileRemoteNeedsRepair = remote.needsRepair === true;
                return remote.data;
            }
            fileRemoteFingerprint = null;
            fileRemoteNeedsRepair = false;
            return remote;
        },
        writeRemote: async (sanitized, assertRemoteMutationFenceHeld) => {
            if (ctx.backend === 'cloudkit') {
                await transport.cloudKitWrite(sanitized);
                return;
            }
            if (ctx.backend === 'webdav') {
                if (ctx.webdav?.url) {
                    ctx.syncUrl = normalizeWebdavUrl(ctx.webdav.url);
                }
                if (!webdavDocumentVersion) {
                    throw new Error('WebDAV document version is unavailable; refusing an unconditional write');
                }
                if (
                    webdavDocumentVersion.exists
                    && !webdavDocumentVersion.strongEtag
                    && !ctx.allowLegacyWebdavPlaintext
                ) {
                    throw new Error('WebDAV server did not provide a safe strong ETag for the existing sync document; refusing to overwrite it');
                }
                try {
                    let expectedEtag = webdavDocumentVersion.exists ? webdavDocumentVersion.strongEtag : null;
                    if (ctx.allowLegacyWebdavPlaintext && !expectedEtag) {
                        if (!webdavDocumentSnapshot || !transport.webdavPutLegacyPlaintext) {
                            throw new Error('WebDAV legacy plaintext write is unavailable; refusing an unconditional write');
                        }


                        await assertRemoteMutationFenceHeld?.();
                        const confirmed = await readWebdavDocument();
                        if (snapshotWebdavRead(confirmed) !== webdavDocumentSnapshot) {
                            throw new SyncRemoteWriteConflict();
                        }
                        webdavDocumentVersion = {
                            exists: confirmed.exists,
                            strongEtag: confirmed.strongEtag,
                        };
                        expectedEtag = confirmed.exists ? confirmed.strongEtag : null;
                        if (!expectedEtag) {
                            const result = assertRemoteMutationFenceHeld
                                ? await transport.webdavPutLegacyPlaintext(
                                    sanitized,
                                    assertRemoteMutationFenceHeld,
                                )
                                : await transport.webdavPutLegacyPlaintext(sanitized);
                            return normalizeRemoteWriteResult('webdav', result);
                        }
                    }
                    const result = assertRemoteMutationFenceHeld
                        ? await transport.webdavPut(sanitized, expectedEtag, assertRemoteMutationFenceHeld)
                        : await transport.webdavPut(sanitized, expectedEtag);
                    return normalizeRemoteWriteResult('webdav', result);
                } catch (error) {
                    if (isWebdavRemoteWriteConflictError(error)) {


                        throw new SyncRemoteWriteConflict(
                            error instanceof Error ? error.message : String(error),
                        );
                    }
                    throw error;
                }
            }
            if (ctx.backend === 'cloud') {
                if (ctx.cloudProvider === 'selfhosted') {
                    if (ctx.cloud?.url) {
                        ctx.syncUrl = normalizeCloudUrl(ctx.cloud.url);
                    }
                    const result = await transport.cloudPut(sanitized);
                    return normalizeRemoteWriteResult('cloud', result);
                }
                if (!ctx.dropboxAppKey) {
                    throw new Error('Dropbox app key is not configured');
                }
                try {
                    const uploaded = await runDropboxWithAuthRetry((token) => (
                        assertRemoteMutationFenceHeld
                            ? transport.dropboxUpload(token, sanitized, ctx.dropboxRev, assertRemoteMutationFenceHeld)
                            : transport.dropboxUpload(token, sanitized, ctx.dropboxRev)
                    ));
                    ctx.dropboxRev = uploaded.rev;
                    return;
                } catch (error) {
                    if (error instanceof DropboxConflictError) {
                        throw new SyncRemoteWriteConflict();
                    }
                    throw error;
                }
            }
            if (fileRemoteFingerprint) {
                await transport.fileWrite(sanitized, fileRemoteFingerprint);
            } else {
                await transport.fileWrite(sanitized);
            }
            fileRemoteNeedsRepair = false;
        },
        requiresRemoteRepair: () => ctx.backend === 'file' && fileRemoteNeedsRepair,
        readRemoteFingerprint: async () => {
            if (ctx.backend === 'webdav') {
                if (!ctx.webdav?.url) return null;
                ctx.syncUrl = normalizeWebdavUrl(ctx.webdav.url);
                const metadata = await transport.webdavHead();
                if (!metadata?.exists) return null;
                return metadata.fingerprint;
            }
            if (ctx.backend === 'cloud' && ctx.cloudProvider === 'selfhosted') {
                if (!ctx.cloud?.url) return null;
                ctx.syncUrl = normalizeCloudUrl(ctx.cloud.url);
                const metadata = await transport.cloudHead();
                if (!metadata?.exists) return null;
                return metadata.fingerprint;
            }
            if (ctx.backend === 'cloud' && ctx.cloudProvider === 'dropbox') {
                const metadata = await runDropboxWithAuthRetry((token) => transport.dropboxMetadata(token));
                ctx.dropboxRev = metadata.rev;
                return metadata.rev ? buildDropboxRevFingerprint(metadata.rev) : null;
            }
            return null;
        },
        syncAttachments: async (data, helpers) => {
            if (ctx.backend === 'webdav' && ctx.webdav?.url) {
                return transport.syncWebdavAttachments(data, helpers);
            }
            if (ctx.backend === 'cloudkit') {
                return transport.syncCloudKitAttachments(data, helpers);
            }
            if (ctx.backend === 'file' && ctx.filePath) {
                return transport.syncFileAttachments(data, helpers);
            }
            if (ctx.backend === 'cloud' && ctx.cloudProvider === 'selfhosted' && ctx.cloud?.url) {
                return transport.syncCloudAttachments(data, helpers);
            }
            if (ctx.backend === 'cloud' && ctx.cloudProvider === 'dropbox') {
                return transport.syncDropboxAttachments(data, helpers);
            }
            return null;
        },
    };
}
