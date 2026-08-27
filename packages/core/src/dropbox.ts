import type { AppData } from './types';
import {
    isDropboxPathConflictTag,
    isDropboxPathNotFoundTag,
    parseDropboxApiErrorTag,
    parseDropboxMetadataRev,
    resolveDropboxPath,
} from './dropbox-sync-utils';
import {
    DEFAULT_TIMEOUT_MS,
    fetchWithTimeout,
    MAX_DOWNLOAD_BYTES,
    MAX_SYNC_DOCUMENT_BYTES,
    readResponseBody,
} from './http-utils';
import { decryptRemoteArtifactOrThrow, detectForeignSaltArtifact, isPlaintextSyncArtifact, syncEncryptedArtifactName } from './sync-encryption';
import { encryptSyncArtifact, inspectSyncArtifact, type SyncCryptoKdfParams, type SyncCryptoPrimitives, type SyncKeyMaterial } from './sync-crypto';

const DROPBOX_SYNC_PATH = '/data.json';
const DOWNLOAD_ENDPOINT = 'https://content.dropboxapi.com/2/files/download';
const UPLOAD_ENDPOINT = 'https://content.dropboxapi.com/2/files/upload';
const FILE_METADATA_ENDPOINT = 'https://api.dropboxapi.com/2/files/get_metadata';
const FILE_DELETE_ENDPOINT = 'https://api.dropboxapi.com/2/files/delete_v2';

export type DropboxRequestOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
};

const fetchDropbox = (
    fetcher: typeof fetch,
    url: string,
    init: RequestInit,
    options: DropboxRequestOptions,
    timeoutMessage: string,
): Promise<Response> => fetchWithTimeout(
    url,
    { ...init, signal: options.signal },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetcher,
    timeoutMessage,
);

export class DropboxConflictError extends Error {
    constructor(message = 'Dropbox remote data changed during sync') {
        super(message);
        this.name = 'DropboxConflictError';
    }
}

export const isDropboxConflictError = (error: unknown): boolean => (
    error instanceof DropboxConflictError
    || (error instanceof Error && error.name === 'DropboxConflictError')
);

export class DropboxUnauthorizedError extends Error {
    constructor(message = 'Dropbox authorization failed (HTTP 401)') {
        super(message);
        this.name = 'DropboxUnauthorizedError';
    }
}

export class DropboxFileNotFoundError extends Error {
    constructor(message = 'Dropbox file not found') {
        super(message);
        this.name = 'DropboxFileNotFoundError';
    }
}

export const isDropboxUnauthorizedError = (error: unknown): boolean => {
    if (error instanceof DropboxUnauthorizedError) return true;
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return message.includes('http 401')
        || message.includes('invalid_access_token')
        || message.includes('expired_access_token')
        || message.includes('unauthorized');
};

export type DropboxDownloadResult = {
    data: AppData | null;
    rev: string | null;
    /** Set instead of `data` when this call has no key for a remote that is (or looks
     *  like it is) MWENC1-encrypted. Callers persist this via sync-encryption.ts's
     *  markRemoteEncryptionDiscovered; never treated as "no data". */
    encryptedNoKey?: { salt: Uint8Array; params: SyncCryptoKdfParams };
    /** Set instead of `data` when this call HAS a key, `/data.json.enc` is gone, and a
     *  plaintext `/data.json` is in its place — a peer disabled encryption at the sync
     *  location. Callers persist `remote-plaintext` and abort; never treated as "no data". */
    remotePlaintext?: true;
};

export type DropboxSyncCrypto = {
    /** Full key material. Omitting this is the encryption-off path and is byte-for-byte
     *  identical to calling these functions without it (backward-compat invariant #1):
     *  same `/data.json` path, same request/body shape, same errors. */
    material?: SyncKeyMaterial;
    cryptoPrims?: SyncCryptoPrimitives;
};

const requireDropboxPathNotFound = async (response: Response): Promise<void> => {
    const errorTag = await parseDropboxApiErrorTag(response);
    if (isDropboxPathNotFoundTag(errorTag)) return;
    const detail = errorTag ? ` (${errorTag})` : ' (missing path/not_found error tag)';
    throw new Error(`Dropbox download failed: HTTP ${response.status}${detail}`);
};

const requireDropboxDownloadOrNotFound = async (response: Response): Promise<'ok' | 'not-found'> => {
    if (response.status === 401) {
        throw new DropboxUnauthorizedError('Dropbox download failed: HTTP 401');
    }
    if (response.status === 409) {
        await requireDropboxPathNotFound(response);
        return 'not-found';
    }
    if (!response.ok) {
        throw new Error(`Dropbox download failed: HTTP ${response.status}`);
    }
    return 'ok';
};

export async function getDropboxAppDataMetadata(
    accessToken: string,
    fetcher: typeof fetch = fetch,
    /** Same shape as the download/upload helpers: supplying `material` moves this probe to the
     *  `.enc` path so an encrypted remote reports a real rev instead of 409-ing to `null` and
     *  making every cycle look like a fresh remote. Omitting it is the pre-feature behavior. */
    crypto: DropboxSyncCrypto = {},
    requestOptions: DropboxRequestOptions = {},
): Promise<{ rev: string | null }> {
    const response = await fetchDropbox(fetcher, FILE_METADATA_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            path: crypto.material ? syncEncryptedArtifactName(DROPBOX_SYNC_PATH) : DROPBOX_SYNC_PATH,
            include_media_info: false,
            include_deleted: false,
        }),
    }, requestOptions, 'Dropbox metadata request timed out');
    if (response.status === 409) {
        return { rev: null };
    }
    if (response.status === 401) {
        throw new DropboxUnauthorizedError('Dropbox metadata failed: HTTP 401');
    }
    if (!response.ok) {
        throw new Error(`Dropbox metadata failed: HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => null) as { rev?: unknown } | null;
    return { rev: typeof payload?.rev === 'string' ? payload.rev : null };
}

/** Cheap exact-generation lookup for one attachment. A missing path returns
 * `null`; every other 409 is an error so callers never turn unreadable state
 * into an unsafe create. */
export async function getDropboxFileMetadata(
    accessToken: string,
    path: string,
    fetcher: typeof fetch = fetch,
    requestOptions: DropboxRequestOptions = {},
): Promise<{ rev: string | null }> {
    const response = await fetchDropbox(fetcher, FILE_METADATA_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            path: resolveDropboxPath(path),
            include_media_info: false,
            include_deleted: false,
        }),
    }, requestOptions, 'Dropbox file metadata request timed out');
    if (response.status === 401) {
        throw new DropboxUnauthorizedError('Dropbox file metadata failed: HTTP 401');
    }
    if (response.status === 409) {
        if (isDropboxPathNotFoundTag(await parseDropboxApiErrorTag(response))) return { rev: null };
        throw new Error('Dropbox file metadata failed: HTTP 409');
    }
    if (!response.ok) throw new Error(`Dropbox file metadata failed: HTTP ${response.status}`);
    const payload = await response.json().catch(() => null) as { rev?: unknown } | null;
    const rev = typeof payload?.rev === 'string' ? payload.rev.trim() : '';
    if (!rev) throw new Error('Dropbox file metadata response is missing a revision');
    return { rev };
}

export async function downloadDropboxAppData(
    accessToken: string,
    fetcher: typeof fetch = fetch,
    crypto: DropboxSyncCrypto = {},
    requestOptions: DropboxRequestOptions = {},
): Promise<DropboxDownloadResult> {
    const path = crypto.material ? syncEncryptedArtifactName(DROPBOX_SYNC_PATH) : DROPBOX_SYNC_PATH;
    const response = await fetchDropbox(fetcher, DOWNLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Dropbox-API-Arg': JSON.stringify({ path }),
        },
    }, requestOptions, 'Dropbox download timed out');

    if (await requireDropboxDownloadOrNotFound(response) === 'not-found') {
        if (!crypto.material) {
            // Nothing at the plain path — the common "first sync" shape. Only when this
            // device doesn't already have a key do we take one extra look at the `.enc`
            // path, to catch a peer that already enabled encryption and deleted the
            // plaintext original (decision #2). A device syncing an existing plaintext
            // folder never reaches this branch — its plain download succeeds every
            // cycle — so invariant #1 (no extra requests for an existing install) holds.
            const probe = await fetchDropbox(fetcher, DOWNLOAD_ENDPOINT, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Dropbox-API-Arg': JSON.stringify({ path: syncEncryptedArtifactName(DROPBOX_SYNC_PATH) }),
                },
            }, requestOptions, 'Dropbox encrypted-generation probe timed out');
            if (await requireDropboxDownloadOrNotFound(probe) === 'not-found') {
                return { data: null, rev: null };
            }
            const encBytes = new Uint8Array(await readResponseBody(probe, undefined, MAX_SYNC_DOCUMENT_BYTES));
            const inspected = inspectSyncArtifact(encBytes);
            if (inspected.kind === 'encrypted') {
                return { data: null, rev: null, encryptedNoKey: { salt: inspected.salt, params: inspected.params } };
            }
        } else {
            // Mirror of the probe above, in the other direction and gated the same way: this
            // device HAS a key and its `.enc` path is empty, so one look at the plain path
            // tells "first sync" apart from "a peer disabled encryption here".
            const probe = await fetchDropbox(fetcher, DOWNLOAD_ENDPOINT, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_SYNC_PATH }),
                },
            }, requestOptions, 'Dropbox plaintext-generation probe timed out');
            if (await requireDropboxDownloadOrNotFound(probe) === 'not-found') {
                return { data: null, rev: null };
            }
            if (isPlaintextSyncArtifact(new Uint8Array(await readResponseBody(probe, undefined, MAX_SYNC_DOCUMENT_BYTES)))) {
                return { data: null, rev: null, remotePlaintext: true };
            }
        }
        return { data: null, rev: null };
    }

    const metadata = parseDropboxMetadataRev(response.headers.get('dropbox-api-result'));

    if (crypto.material) {
        const bodyBytes = new Uint8Array(await readResponseBody(response, undefined, MAX_SYNC_DOCUMENT_BYTES));
        // Sealed under another salt = this device's key is for a different encryption
        // generation; report it as a no-key discovery (which can prompt for the passphrase)
        // instead of decrypting into a dead-end Auth failure.
        const foreign = detectForeignSaltArtifact(bodyBytes, crypto.material);
        if (foreign) return { data: null, rev: metadata.rev, encryptedNoKey: foreign };
        const plaintext = await decryptRemoteArtifactOrThrow(bodyBytes, crypto.material.key, crypto.cryptoPrims);
        return { data: JSON.parse(new TextDecoder().decode(plaintext)) as AppData, rev: metadata.rev };
    }

    // Off-state: reads via .text(), exactly as before this feature existed — a fetch
    // mock (real or test double) that only implements .text() keeps working unchanged
    // (backward-compat invariant #1).
    const text = await response.text();
    if (!text.trim()) {
        return { data: null, rev: metadata.rev };
    }

    let data: AppData;
    try {
        data = JSON.parse(text) as AppData;
    } catch {
        // Distinguish "someone already encrypted this remote" from genuine corruption
        // before falling back to the existing error — ciphertext is never "invalid
        // JSON" to repair (decision #4). `text` may already be a lossy UTF-8
        // reconstruction of binary ciphertext, so re-issue the same download request
        // for raw bytes to inspect (mirrors the 409 branch's re-fetch above) rather than
        // re-encoding `text`. Best-effort: any problem here (including a bare-bones
        // fetch double with no arrayBuffer()) just falls through to the original error.
        let inspected: ReturnType<typeof inspectSyncArtifact> | null = null;
        try {
            const raw = await fetchDropbox(fetcher, DOWNLOAD_ENDPOINT, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Dropbox-API-Arg': JSON.stringify({ path }),
                },
            }, requestOptions, 'Dropbox encrypted-generation inspection timed out');
            if (raw.ok) inspected = inspectSyncArtifact(new Uint8Array(await readResponseBody(raw, undefined, MAX_SYNC_DOCUMENT_BYTES)));
        } catch {
            // fall through to the original error below
        }
        if (inspected?.kind === 'encrypted') {
            return { data: null, rev: metadata.rev, encryptedNoKey: { salt: inspected.salt, params: inspected.params } };
        }
        throw new Error('Dropbox data.json is not valid JSON');
    }
    return { data, rev: metadata.rev };
}

export async function uploadDropboxAppData(
    accessToken: string,
    data: AppData,
    expectedRev: string | null,
    fetcher: typeof fetch = fetch,
    crypto: DropboxSyncCrypto = {},
    requestOptions: DropboxRequestOptions = {},
): Promise<{ rev: string | null }> {
    const mode = expectedRev
        ? { '.tag': 'update', update: expectedRev }
        : { '.tag': 'add' };
    const path = crypto.material ? syncEncryptedArtifactName(DROPBOX_SYNC_PATH) : DROPBOX_SYNC_PATH;
    // `.slice()` copies into a fresh, exactly-sized ArrayBuffer — sidesteps the
    // Uint8Array<ArrayBufferLike> vs BodyInit's Uint8Array<ArrayBuffer> typing mismatch
    // (same TS 5.9 DOM-lib issue sync-crypto.ts's toArrayBufferView works around).
    const body: BodyInit = crypto.material
        ? (await encryptSyncArtifact(new TextEncoder().encode(JSON.stringify(data)), crypto.material, crypto.cryptoPrims)).slice().buffer
        : JSON.stringify(data);
    const response = await fetchDropbox(fetcher, UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Dropbox-API-Arg': JSON.stringify({
                path,
                mode,
                autorename: false,
                mute: true,
                strict_conflict: true,
            }),
            'Content-Type': 'application/octet-stream',
        },
        body,
    }, requestOptions, 'Dropbox upload timed out');

    if (response.status === 409) {
        const errorTag = await parseDropboxApiErrorTag(response);
        if (isDropboxPathConflictTag(errorTag)) {
            throw new DropboxConflictError();
        }
    }
    if (response.status === 401) {
        throw new DropboxUnauthorizedError('Dropbox upload failed: HTTP 401');
    }
    if (!response.ok) {
        throw new Error(`Dropbox upload failed: HTTP ${response.status}`);
    }

    const payload = await response.json().catch(() => null) as { rev?: unknown } | null;
    return { rev: typeof payload?.rev === 'string' ? payload.rev : null };
}

export async function downloadDropboxFile(
    accessToken: string,
    path: string,
    fetcher: typeof fetch = fetch,
    requestOptions: DropboxRequestOptions = {},
): Promise<ArrayBuffer> {
    const response = await fetchDropbox(fetcher, DOWNLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Dropbox-API-Arg': JSON.stringify({ path: resolveDropboxPath(path) }),
        },
    }, requestOptions, 'Dropbox file download timed out');
    if (response.status === 401) {
        throw new DropboxUnauthorizedError('Dropbox file download failed: HTTP 401');
    }
    if (response.status === 409) {
        if (isDropboxPathNotFoundTag(await parseDropboxApiErrorTag(response))) {
            throw new DropboxFileNotFoundError('Dropbox file not found');
        }
        throw new Error('Dropbox file download failed: HTTP 409');
    }
    if (!response.ok) {
        throw new Error(`Dropbox file download failed: HTTP ${response.status}`);
    }
    return await readResponseBody(response, undefined, MAX_DOWNLOAD_BYTES);
}

/** Versioned byte read for encryption transitions. Dropbox returns the file rev in the
 * same download response's Dropbox-API-Result header, so bytes and generation cannot drift. */
export async function downloadDropboxFileVersionedWithServerTime(
    accessToken: string,
    path: string,
    fetcher: typeof fetch = fetch,
    requestOptions: DropboxRequestOptions = {},
): Promise<{ bytes: Uint8Array | null; version: string | null; serverNowMs: number | null }> {
    const response = await fetchDropbox(fetcher, DOWNLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Dropbox-API-Arg': JSON.stringify({ path: resolveDropboxPath(path) }),
        },
    }, requestOptions, 'Dropbox versioned file download timed out');
    const parsedServerNow = Date.parse(response.headers.get('date') ?? '');
    const serverNowMs = Number.isFinite(parsedServerNow) ? parsedServerNow : null;
    if (response.status === 401) throw new DropboxUnauthorizedError('Dropbox file download failed: HTTP 401');
    if (response.status === 409) {
        if (isDropboxPathNotFoundTag(await parseDropboxApiErrorTag(response))) {
            return { bytes: null, version: null, serverNowMs };
        }
        throw new Error('Dropbox file download failed: HTTP 409');
    }
    if (!response.ok) throw new Error(`Dropbox file download failed: HTTP ${response.status}`);
    const metadata = parseDropboxMetadataRev(response.headers.get('dropbox-api-result'));
    return {
        bytes: new Uint8Array(await readResponseBody(response, undefined, MAX_DOWNLOAD_BYTES)),
        version: metadata.rev,
        serverNowMs,
    };
}

/** Compatibility shape for transition callers that only need bytes + Dropbox rev. */
export async function downloadDropboxFileVersioned(
    accessToken: string,
    path: string,
    fetcher: typeof fetch = fetch,
    requestOptions: DropboxRequestOptions = {},
): Promise<{ bytes: Uint8Array | null; version: string | null }> {
    const { bytes, version } = await downloadDropboxFileVersionedWithServerTime(
        accessToken,
        path,
        fetcher,
        requestOptions,
    );
    return { bytes, version };
}

export async function uploadDropboxFile(
    accessToken: string,
    path: string,
    content: ArrayBuffer | Uint8Array,
    _contentType = 'application/octet-stream',
    fetcher: typeof fetch = fetch,
    requestOptions: DropboxRequestOptions = {},
): Promise<{ rev: string | null }> {
    const sourceBytes = content instanceof Uint8Array ? content : new Uint8Array(content);
    const bytes = new Uint8Array(sourceBytes.length);
    bytes.set(sourceBytes);
    const requestBody = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const response = await fetchDropbox(fetcher, UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Dropbox-API-Arg': JSON.stringify({
                path: resolveDropboxPath(path),
                mode: { '.tag': 'overwrite' },
                mute: true,
                strict_conflict: false,
            }),
            'Content-Type': 'application/octet-stream',
        },
        body: requestBody,
    }, requestOptions, 'Dropbox file upload timed out');
    if (response.status === 401) {
        throw new DropboxUnauthorizedError('Dropbox file upload failed: HTTP 401');
    }
    if (!response.ok) {
        throw new Error(`Dropbox file upload failed: HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => null) as { rev?: unknown } | null;
    return { rev: typeof payload?.rev === 'string' ? payload.rev : null };
}

/** CAS byte write for encryption transitions. A missing read maps to Dropbox's add mode;
 * an existing read maps to update(rev). No overwrite mode is used. */
export async function uploadDropboxFileVersioned(
    accessToken: string,
    path: string,
    content: ArrayBuffer | Uint8Array,
    expectedRev: string | null,
    fetcher: typeof fetch = fetch,
    requestOptions: DropboxRequestOptions = {},
): Promise<{ rev: string | null }> {
    const sourceBytes = content instanceof Uint8Array ? content : new Uint8Array(content);
    const requestBody = new Uint8Array(sourceBytes).buffer;
    const mode = expectedRev
        ? { '.tag': 'update', update: expectedRev }
        : { '.tag': 'add' };
    const response = await fetchDropbox(fetcher, UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Dropbox-API-Arg': JSON.stringify({
                path: resolveDropboxPath(path),
                mode,
                autorename: false,
                mute: true,
                strict_conflict: true,
            }),
            'Content-Type': 'application/octet-stream',
        },
        body: requestBody,
    }, requestOptions, 'Dropbox versioned file upload timed out');
    if (response.status === 401) throw new DropboxUnauthorizedError('Dropbox file upload failed: HTTP 401');
    if (response.status === 409) throw new DropboxConflictError('Dropbox artifact changed during encryption transition');
    if (!response.ok) throw new Error(`Dropbox file upload failed: HTTP ${response.status}`);
    const payload = await response.json().catch(() => null) as { rev?: unknown } | null;
    return { rev: typeof payload?.rev === 'string' ? payload.rev : null };
}

export async function deleteDropboxFile(
    accessToken: string,
    path: string,
    fetcher: typeof fetch = fetch,
    requestOptions: DropboxRequestOptions = {},
): Promise<void> {
    const response = await fetchDropbox(fetcher, FILE_DELETE_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: resolveDropboxPath(path) }),
    }, requestOptions, 'Dropbox file delete timed out');
    if (response.status === 401) {
        throw new DropboxUnauthorizedError('Dropbox file delete failed: HTTP 401');
    }
    if (response.status === 409) {
        if (isDropboxPathNotFoundTag(await parseDropboxApiErrorTag(response))) return;
        throw new Error('Dropbox file delete failed: HTTP 409');
    }
    if (!response.ok) {
        throw new Error(`Dropbox file delete failed: HTTP ${response.status}`);
    }
}

/** Revision-conditional Dropbox delete. `parent_rev` is supported for files by delete_v2;
 * every 409 is a generation conflict, including a peer that removed the path first. */
export async function deleteDropboxFileVersioned(
    accessToken: string,
    path: string,
    expectedRev: string,
    fetcher: typeof fetch = fetch,
    requestOptions: DropboxRequestOptions = {},
): Promise<void> {
    if (!expectedRev.trim()) throw new Error('Dropbox conditional delete requires a revision');
    const response = await fetchDropbox(fetcher, FILE_DELETE_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: resolveDropboxPath(path), parent_rev: expectedRev }),
    }, requestOptions, 'Dropbox versioned file delete timed out');
    if (response.status === 401) throw new DropboxUnauthorizedError('Dropbox file delete failed: HTTP 401');
    if (response.status === 409) throw new DropboxConflictError('Dropbox artifact changed during encryption transition');
    if (!response.ok) throw new Error(`Dropbox file delete failed: HTTP ${response.status}`);
}

export async function testDropboxAccess(
    accessToken: string,
    fetcher: typeof fetch = fetch,
    requestOptions: DropboxRequestOptions = {},
): Promise<void> {
    const response = await fetchDropbox(fetcher, FILE_METADATA_ENDPOINT, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            path: DROPBOX_SYNC_PATH,
            include_media_info: false,
            include_deleted: false,
        }),
    }, requestOptions, 'Dropbox connection test timed out');
    if (response.status === 409) {
        return;
    }
    if (response.status === 401) {
        throw new DropboxUnauthorizedError('Dropbox connection failed: HTTP 401');
    }
    if (!response.ok) {
        throw new Error(`Dropbox connection failed: HTTP ${response.status}`);
    }
}
