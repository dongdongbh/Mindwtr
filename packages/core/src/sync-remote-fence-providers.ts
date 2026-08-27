import {
    deleteDropboxFileVersioned,
    downloadDropboxFileVersionedWithServerTime,
    isDropboxConflictError,
    uploadDropboxFileVersioned,
    type DropboxRequestOptions,
} from './dropbox';
import {
    isWebdavRemoteWriteConflictError,
    webdavDeleteFileVersioned,
    webdavGetFileVersionedWithServerTime,
    webdavPutFileVersioned,
    type WebDavOptions,
} from './webdav';
import {
    SYNC_REMOTE_MUTATION_FENCE_NAME,
    type SyncRemoteMutationFencePort,
} from './sync-remote-fence';

const FENCE_MAX_BYTES = 4_096;

export const webdavMutationFenceUrl = (documentUrl: string): string => {
    const parsed = new URL(documentUrl);
    const slash = parsed.pathname.lastIndexOf('/');
    parsed.pathname = `${parsed.pathname.slice(0, slash + 1)}${SYNC_REMOTE_MUTATION_FENCE_NAME}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
};

export const createWebdavSyncRemoteMutationFencePort = (
    documentUrl: string,
    options: WebDavOptions = {},
): SyncRemoteMutationFencePort => {
    const url = webdavMutationFenceUrl(documentUrl);
    const readOptions: WebDavOptions = { ...options, maxBytes: FENCE_MAX_BYTES };
    return {
        read: () => webdavGetFileVersionedWithServerTime(url, readOptions),
        write: (bytes, expectedVersion) => webdavPutFileVersioned(
            url,
            bytes,
            'application/json',
            expectedVersion,
            options,
        ),
        remove: (expectedVersion) => webdavDeleteFileVersioned(url, expectedVersion, options),
        isConflict: isWebdavRemoteWriteConflictError,
    };
};

export const createDropboxSyncRemoteMutationFencePort = (
    accessToken: string,
    fetcher: typeof fetch = fetch,
    requestOptions: DropboxRequestOptions = {},
): SyncRemoteMutationFencePort => {
    const path = `/${SYNC_REMOTE_MUTATION_FENCE_NAME}`;
    return {
        read: () => downloadDropboxFileVersionedWithServerTime(accessToken, path, fetcher, requestOptions),
        write: async (bytes, expectedVersion) => {
            await uploadDropboxFileVersioned(accessToken, path, bytes, expectedVersion, fetcher, requestOptions);
        },
        remove: (expectedVersion) => deleteDropboxFileVersioned(
            accessToken,
            path,
            expectedVersion,
            fetcher,
            requestOptions,
        ),
        isConflict: isDropboxConflictError,
    };
};
