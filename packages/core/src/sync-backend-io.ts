import { isDropboxUnauthorizedError, DropboxConflictError } from './dropbox';
import { normalizeCloudUrl, normalizeWebdavUrl } from './sync-helpers';
import { normalizeRemoteWriteResult } from './sync-run';
import { SyncRemoteWriteConflict, type SyncBackendIO, type SyncRunAttachmentHelpers } from './sync-run-ports';
import type { CloudProvider } from './sync-client-helpers';
import type { SyncBackend } from './sync-service-utils';
import type { AppData } from './types';
import type { SyncRemoteMutationFenceLease } from './sync-remote-fence';
import {
    getWebdavDocumentVersionFromError,
    isWebdavRemoteWriteConflictError,
    type WebDavDocumentVersion,
} from './webdav';

/**
 * ADR 0014 completion — the one implementation of the `SyncBackendIO` port.
 *
 * `sync-run-ports.ts` declared the port; desktop and mobile each hand-wrote
 * the same five-way backend ladder (cloudkit / webdav / cloud+selfhosted /
 * cloud+dropbox / file) across four methods. This module owns that ladder,
 * the `dropbox:v1:rev=` fingerprint wire format, the Dropbox conflict
 * mapping, the Dropbox auth-retry-once policy, and remote-URL normalization.
 * Platforms inject only their genuine transport truths — see `SyncTransport`.
 */

/** Ladder-visible sync config for one cycle. Mutated in place by the ladder
 *  (`syncUrl`, `dropboxRev`) so platform code and the returned `SyncBackendIO`
 *  observe the same values a request used — preserve that reporting channel's
 *  semantics exactly; platforms read it for error context and fast-sync scope. */
export type SyncBackendContext = {
    backend: SyncBackend;
    cloudProvider: CloudProvider;
    webdav?: { url: string } | null;
    cloud?: { url: string } | null;
    filePath?: string;
    dropboxAppKey?: string;
    /** Remote location of the last request this cycle made; mutated by the ladder. */
    syncUrl?: string;
    /** Cached Dropbox content-hash rev; mutated by the ladder after every
     *  Dropbox read/write/fingerprint call. */
    dropboxRev: string | null;
};

/** One remote-write transport result (webdav/cloud PUT response shape). */
type RemoteWriteResult = Parameters<typeof normalizeRemoteWriteResult>[1];
type RemoteHeadResult = { exists: boolean; fingerprint: string | null } | null | undefined;
type DropboxRevResult = { rev: string | null };
type DropboxDownloadResult = { data: AppData | null; rev: string | null };
type AttachmentSyncResult = Promise<AppData | boolean | null | undefined>;

export type WebdavSyncReadResult = WebDavDocumentVersion & { data: AppData | null };

export type FileSyncReadResult = {
    data: AppData;
    fingerprint: string;
    source?: string;
    needsRepair?: boolean;
};

/**
 * Platform transport for one sync cycle's active backend. Every member here
 * is a deliberate platform truth carried over verbatim from the desktop/mobile
 * orchestrators (see `sync-run-ports.ts` for the ones ADR 0014 already
 * codified): desktop forks `isTauriRuntimeEnv()` between `tauriInvoke` and
 * `fetch` and resolves the WebDAV password from the OS keyring; mobile wraps
 * WebDAV calls in its rate-limit controller and threads an `AbortSignal`.
 * Retry wrapping (attempt counts, backoff, which errors are retryable) is
 * also a platform truth — each method already includes whatever retry policy
 * that platform runs today. This ladder does not add or remove retries.
 */
export type SyncTransport = {
    acquireWebdavRemoteMutationFence?(): Promise<SyncRemoteMutationFenceLease>;
    acquireDropboxRemoteMutationFence?(token: string): Promise<SyncRemoteMutationFenceLease>;
    webdavGet(): Promise<WebdavSyncReadResult>;
    /** null means create-only (If-None-Match:*); a value is the strong GET ETag (If-Match). */
    webdavPut(sanitized: AppData, expectedEtag: string | null): Promise<RemoteWriteResult>;
    webdavHead(): Promise<RemoteHeadResult>;
    cloudGet(): Promise<AppData | null | undefined>;
    cloudPut(sanitized: AppData): Promise<RemoteWriteResult>;
    cloudHead(): Promise<RemoteHeadResult>;
    fileRead(): Promise<AppData | FileSyncReadResult | null | undefined>;
    fileWrite(sanitized: AppData, expectedFingerprint?: string): Promise<void>;
    cloudKitRead(): Promise<AppData | null | undefined>;
    cloudKitWrite(sanitized: AppData): Promise<void>;
    /** Resolve a Dropbox access token; `forceRefresh` on the auth-retry pass. */
    resolveDropboxToken(forceRefresh: boolean): Promise<string>;
    dropboxDownload(token: string): Promise<DropboxDownloadResult>;
    dropboxUpload(token: string, sanitized: AppData, expectedRev: string | null): Promise<DropboxRevResult>;
    dropboxMetadata(token: string): Promise<DropboxRevResult>;
    syncWebdavAttachments(data: AppData, helpers: SyncRunAttachmentHelpers): AttachmentSyncResult;
    syncCloudAttachments(data: AppData, helpers: SyncRunAttachmentHelpers): AttachmentSyncResult;
    syncDropboxAttachments(data: AppData, helpers: SyncRunAttachmentHelpers): AttachmentSyncResult;
    syncFileAttachments(data: AppData, helpers: SyncRunAttachmentHelpers): AttachmentSyncResult;
    syncCloudKitAttachments(data: AppData, helpers: SyncRunAttachmentHelpers): AttachmentSyncResult;
};

const DROPBOX_REV_FINGERPRINT_PREFIX = 'dropbox:v1:rev=';

/** `dropbox:v1:rev=` cached-fingerprint wire format — one place, not four. */
export const buildDropboxRevFingerprint = (rev: string): string => `${DROPBOX_REV_FINGERPRINT_PREFIX}${rev}`;

const isFileSyncReadResult = (value: AppData | FileSyncReadResult): value is FileSyncReadResult => (
    typeof value === 'object'
    && value !== null
    && 'data' in value
    && 'fingerprint' in value
    && typeof value.fingerprint === 'string'
);

export function createSyncBackendIO(ctx: SyncBackendContext, transport: SyncTransport): SyncBackendIO {
    let fileRemoteFingerprint: string | null = null;
    let fileRemoteNeedsRepair = false;
    let webdavDocumentVersion: WebDavDocumentVersion | null = null;
    /** Dropbox token-retry policy: try with the current token; on an
     *  unauthorized response, force-refresh once and retry once; any other
     *  error, or a second unauthorized response, propagates. Outer transient
     *  retry (backoff, attempt counts) is each platform's own, already baked
     *  into `resolveDropboxToken`/`dropboxDownload`/`dropboxUpload`/`dropboxMetadata`. */
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
                    const remote = await transport.webdavGet();
                    webdavDocumentVersion = { exists: remote.exists, strongEtag: remote.strongEtag };
                    return remote.data;
                } catch (error) {
                    // Invalid JSON still enters the shared repair path. Preserve the GET
                    // validator carried by that error so the repair is conditional too.
                    webdavDocumentVersion = getWebdavDocumentVersionFromError(error);
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
        writeRemote: async (sanitized) => {
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
                if (webdavDocumentVersion.exists && !webdavDocumentVersion.strongEtag) {
                    throw new Error('WebDAV server did not provide a safe strong ETag for the existing sync document; refusing to overwrite it');
                }
                try {
                    const result = await transport.webdavPut(
                        sanitized,
                        webdavDocumentVersion.exists ? webdavDocumentVersion.strongEtag : null,
                    );
                    return normalizeRemoteWriteResult('webdav', result);
                } catch (error) {
                    if (isWebdavRemoteWriteConflictError(error)) {
                        throw new SyncRemoteWriteConflict();
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
                    const uploaded = await runDropboxWithAuthRetry((token) =>
                        transport.dropboxUpload(token, sanitized, ctx.dropboxRev)
                    );
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
