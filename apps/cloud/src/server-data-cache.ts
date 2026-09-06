import { lstatSync, type Stats } from 'fs';
import type { AppData } from '@mindwtr/core';

import { corsOrigin, errorResponse, logFailureWarn } from './server-config';
import {
    loadAppDataForWriteUncached,
    loadAppDataUncached,
    writeData,
    type AppDataForWriteResult,
    type WriteDataOptions,
} from './server-storage';

const DATA_CACHE_MAX_ENTRIES = 64;

type DataMetadataCacheEntry = {
    ctimeMs: number;
    etag: string;
    ino: number;
    lastModified: string;
    mtimeMs: number;
    size: number;
};

export type DataFileMetadata = {
    etag: string;
    lastModified: string;
    size: number;
};

type DataFileIdentity = {
    ctimeMs: number;
    ino: number;
    mtimeMs: number;
    size: number;
};

type ParsedDataCacheEntry = DataFileIdentity & {
    data: AppData;
};

const dataMetadataCache = new Map<string, DataMetadataCacheEntry>();
const validatedDataCache = new Map<string, DataFileIdentity>();
const parsedDataCache = new Map<string, ParsedDataCacheEntry>();

// The app-data caches are process-local and are valid only when callers respect
// the cloud write lock. Cross-process deployments are still safe because every
// cache hit is rechecked against the file's stat identity after atomic rename;
// uncoordinated writers can defeat that invariant and are unsupported.
const getDataFileIdentity = (filePath: string): DataFileIdentity | null => {
    try {
        const stat = lstatSync(filePath);
        return {
            ctimeMs: stat.ctimeMs,
            ino: stat.ino,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
        };
    } catch {
        return null;
    }
};

const sameDataFileIdentity = (left: DataFileIdentity | undefined, right: DataFileIdentity | null): boolean => (
    !!left
    && !!right
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.ino === right.ino
);

const trimDataCache = <T>(cache: Map<string, T>, maxEntries: number = DATA_CACHE_MAX_ENTRIES): void => {
    while (cache.size > maxEntries) {
        const oldestKey = cache.keys().next().value as string | undefined;
        if (!oldestKey) return;
        cache.delete(oldestKey);
    }
};

const promoteCacheEntry = <T>(cache: Map<string, T>, key: string, entry: T): void => {
    cache.delete(key);
    cache.set(key, entry);
};

export const isTrustedValidatedDataFile = (filePath: string): boolean => {
    const cached = validatedDataCache.get(filePath);
    if (cached && sameDataFileIdentity(cached, getDataFileIdentity(filePath))) {
        promoteCacheEntry(validatedDataCache, filePath, cached);
        return true;
    }
    if (cached) {
        validatedDataCache.delete(filePath);
    }
    return false;
};

const cloneAppData = (data: AppData): AppData => structuredClone(data) as AppData;

const tryCloneAppData = (data: AppData): AppData | null => {
    try {
        return cloneAppData(data);
    } catch {
        logFailureWarn('Failed to clone cloud app data cache entry', {
            failureClass: 'cache',
            failureCode: 'cache_clone_failed',
        });
        return null;
    }
};

const rememberParsedDataFile = (filePath: string, data: AppData): void => {
    const identity = getDataFileIdentity(filePath);
    if (identity) {
        const cachedData = tryCloneAppData(data);
        if (!cachedData) {
            parsedDataCache.delete(filePath);
            return;
        }
        promoteCacheEntry(parsedDataCache, filePath, { ...identity, data: cachedData });
        trimDataCache(parsedDataCache);
    } else {
        parsedDataCache.delete(filePath);
    }
};

export const loadAppData = (filePath: string): AppData => {
    const identity = getDataFileIdentity(filePath);
    const cached = parsedDataCache.get(filePath);
    if (cached && sameDataFileIdentity(cached, identity)) {
        const data = tryCloneAppData(cached.data);
        if (data) {
            promoteCacheEntry(parsedDataCache, filePath, cached);
            return data;
        }
        parsedDataCache.delete(filePath);
    }

    const data = loadAppDataUncached(filePath);
    rememberParsedDataFile(filePath, data);
    return data;
};

/**
 * Same cache as loadAppData, but for write paths that must not treat "the document
 * exists but couldn't be read" as an empty namespace (see loadAppDataForWriteUncached
 * in server-storage.ts). A cache hit already proves the file parsed cleanly on a
 * previous read, so only an actual cache miss touches disk through the discriminated
 * loader.
 */
export const loadAppDataForWrite = (filePath: string): AppDataForWriteResult => {
    const identity = getDataFileIdentity(filePath);
    const cached = parsedDataCache.get(filePath);
    if (cached && sameDataFileIdentity(cached, identity)) {
        const data = tryCloneAppData(cached.data);
        if (data) {
            promoteCacheEntry(parsedDataCache, filePath, cached);
            return { state: 'ok', data };
        }
        parsedDataCache.delete(filePath);
    }

    const result = loadAppDataForWriteUncached(filePath);
    if (result.state === 'unreadable') return result;
    rememberParsedDataFile(filePath, result.data);
    return result;
};

/**
 * Guards every namespace-data read (REST reads/writes, search, the calendar feed) against
 * a namespace file that exists but can't be read/parsed (EIO/EACCES/corrupt JSON): that
 * must 500, never silently fall back to an empty document — a write path would then save
 * the empty document over the real data, and a read path would serve empty results as if
 * the namespace were genuinely empty.
 */
export const loadAppDataOrError = (filePath: string): AppData | { error: Response } => {
    const result = loadAppDataForWrite(filePath);
    if (result.state === 'unreadable') {
        logFailureWarn('Stored cloud data failed validation', {
            failureClass: 'validation',
            failureCode: 'stored_data_invalid_json',
        });
        return { error: errorResponse('Stored data failed validation', 500) };
    }
    return result.data;
};

export const rememberValidatedDataFile = (filePath: string): void => {
    const identity = getDataFileIdentity(filePath);
    if (identity) {
        promoteCacheEntry(validatedDataCache, filePath, identity);
        trimDataCache(validatedDataCache);
    } else {
        validatedDataCache.delete(filePath);
    }
};

export const writeCloudData = (filePath: string, data: AppData, options: WriteDataOptions = {}): void => {
    try {
        writeData(filePath, data, options);
    } catch (error) {
        parsedDataCache.delete(filePath);
        throw error;
    }
    rememberParsedDataFile(filePath, data);
    rememberValidatedDataFile(filePath);
};

const formatStatEtagPart = (value: number): string => {
    if (!Number.isFinite(value)) return '0';
    return Math.max(0, Math.trunc(value)).toString(36);
};

const buildDataMetadataEtag = (stat: Stats): string => (
    `W/"mindwtr-${formatStatEtagPart(stat.ino)}-${formatStatEtagPart(stat.size)}`
    + `-${formatStatEtagPart(stat.mtimeMs)}-${formatStatEtagPart(stat.ctimeMs)}"`
);

const getDataMetadata = (filePath: string, stat: Stats): DataMetadataCacheEntry => {
    const cached = dataMetadataCache.get(filePath);
    if (
        cached
        && cached.size === stat.size
        && cached.mtimeMs === stat.mtimeMs
        && cached.ctimeMs === stat.ctimeMs
        && cached.ino === stat.ino
    ) {
        promoteCacheEntry(dataMetadataCache, filePath, cached);
        return cached;
    }
    if (cached) {
        dataMetadataCache.delete(filePath);
    }

    const entry: DataMetadataCacheEntry = {
        ctimeMs: stat.ctimeMs,
        etag: buildDataMetadataEtag(stat),
        ino: stat.ino,
        lastModified: stat.mtime.toUTCString(),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
    };
    promoteCacheEntry(dataMetadataCache, filePath, entry);
    trimDataCache(dataMetadataCache);
    return entry;
};

export const getDataFileMetadata = (filePath: string): DataFileMetadata => {
    const stat = lstatSync(filePath);
    const metadata = getDataMetadata(filePath, stat);
    return {
        etag: metadata.etag,
        lastModified: metadata.lastModified,
        size: metadata.size,
    };
};

export const dataMetadataResponse = (filePath: string): Response => {
    const metadata = getDataFileMetadata(filePath);
    const headers = new Headers({
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
        'Access-Control-Allow-Methods': 'GET,HEAD,PUT,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Expose-Headers': 'ETag, Last-Modified, Content-Length',
        'Content-Length': String(metadata.size),
        'ETag': metadata.etag,
        'Last-Modified': metadata.lastModified,
    });
    return new Response(null, { status: 200, headers });
};

export const jsonFileResponse = (body: string | Uint8Array): Response => {
    const contentLength = typeof body === 'string'
        ? new TextEncoder().encode(body).byteLength
        : body.byteLength;
    const responseBody = typeof body === 'string'
        ? body
        : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    const headers = new Headers({
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
        'Access-Control-Allow-Methods': 'GET,HEAD,PUT,POST,PATCH,DELETE,OPTIONS',
        'Content-Length': String(contentLength),
        'Content-Type': 'application/json; charset=utf-8',
    });
    return new Response(responseBody, { status: 200, headers });
};

export const __serverDataCacheTestUtils = {
    clearDataCaches: () => {
        dataMetadataCache.clear();
        parsedDataCache.clear();
        validatedDataCache.clear();
    },
    dataMetadataResponse,
    getDataCacheMaxEntries: () => DATA_CACHE_MAX_ENTRIES,
    getDataFileMetadata,
    getDataMetadataCacheSize: () => dataMetadataCache.size,
    getParsedDataCacheSize: () => parsedDataCache.size,
    getValidatedDataCacheSize: () => validatedDataCache.size,
    hasDataMetadataCacheEntry: (filePath: string) => dataMetadataCache.has(filePath),
    hasParsedDataCacheEntry: (filePath: string) => parsedDataCache.has(filePath),
    hasValidatedDataCacheEntry: (filePath: string) => validatedDataCache.has(filePath),
    isTrustedValidatedDataFile,
    loadAppData,
    loadAppDataForWrite,
    rememberValidatedDataFile,
    writeCloudData,
};
