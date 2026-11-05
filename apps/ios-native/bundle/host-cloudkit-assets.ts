import { isObjectRecord, isValidTimestamp, type MobileCloudKitAttachmentAssetPort,
    type MobileCloudKitAttachmentMetadata } from '@mindwtr/core';
import type { NativeCloudKitRequest } from './host-cloudkit';

export type NativeCloudKitAssetRequest =
    | { op: 'saveAttachmentAsset'; recordName: string; filePath: string; metadataJSON: string }
    | { op: 'fetchAttachmentAsset'; recordName: string; targetPath: string }
    | { op: 'deleteRecords'; recordType: 'MindwtrAttachment'; recordIDs: string[] };
export type NativeCloudKitTransportRequest = NativeCloudKitRequest | NativeCloudKitAssetRequest;
export type NativeCloudKitTransportCall = (request: NativeCloudKitTransportRequest, signal?: AbortSignal) => Promise<string>;

const maximumBytes = 16 * 1024 * 1024;
const invalid = (): never => { throw new Error('Native CloudKit attachment response or request is invalid'); };
const bounded = (text: string): string => {
    if (new TextEncoder().encode(text).byteLength > maximumBytes) return invalid();
    return text;
};
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    && new TextEncoder().encode(value).byteLength <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(value);
const abort = (signal: AbortSignal): void => {
    if (!signal.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw Object.assign(new Error('Native CloudKit attachment operation cancelled'), { name: 'AbortError' });
};
const metadata = (value: unknown, recordName?: string): MobileCloudKitAttachmentMetadata => {
    if (!isObjectRecord(value) || !identifier(value.attachmentId) || !identifier(value.ownerId)
        || (value.ownerType !== 'task' && value.ownerType !== 'project') || typeof value.title !== 'string'
        || !isValidTimestamp(value.updatedAt)
        || Object.keys(value).some((field) => !['attachmentId', 'ownerType', 'ownerId', 'title', 'mimeType', 'size',
            'fileHash', 'updatedAt', 'deletedAt', ...(recordName === undefined ? [] : ['recordName', 'filePath'])].includes(field))
        || (recordName !== undefined && value.recordName !== recordName)
        || (value.filePath !== undefined && typeof value.filePath !== 'string')
        || (value.mimeType !== undefined && typeof value.mimeType !== 'string')
        || (value.fileHash !== undefined && typeof value.fileHash !== 'string')
        || (value.size !== undefined && (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0))
        || (value.deletedAt !== undefined && !isValidTimestamp(value.deletedAt))) return invalid();
    return { attachmentId: value.attachmentId, ownerType: value.ownerType, ownerId: value.ownerId,
        title: value.title, updatedAt: value.updatedAt,
        ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
        ...(typeof value.fileHash === 'string' ? { fileHash: value.fileHash } : {}),
        ...(typeof value.size === 'number' ? { size: value.size } : {}),
        ...(typeof value.deletedAt === 'string' ? { deletedAt: value.deletedAt } : {}) };
};

/** Only transports owned paths. Swift authorizes and receipts all staging and SDK asset IO. */
export const createNativeCloudKitAssets = (call: NativeCloudKitTransportCall): MobileCloudKitAttachmentAssetPort => {
    const request = async (input: NativeCloudKitAssetRequest, signal: AbortSignal): Promise<unknown> => {
        abort(signal);
        bounded(JSON.stringify(input));
        let raw: string;
        try { raw = await call(input, signal); }
        catch (error) { abort(signal); throw error; }
        abort(signal);
        if (typeof raw !== 'string') return invalid();
        return JSON.parse(bounded(raw));
    };
    const assetRequest = (recordName: string, path: string): void => {
        if (!identifier(recordName) || typeof path !== 'string' || !path.length) return invalid();
    };
    return {
        saveAttachmentAsset: async (recordName, filePath, source, options = {}) => {
            const signal = options.signal ?? new AbortController().signal;
            abort(signal); assetRequest(recordName, filePath);
            const metadataJSON = bounded(JSON.stringify(metadata(source)));
            return metadata(await request({ op: 'saveAttachmentAsset', recordName, filePath, metadataJSON }, signal), recordName);
        },
        fetchAttachmentAsset: async (recordName, targetPath, options = {}) => {
            const signal = options.signal ?? new AbortController().signal;
            abort(signal); assetRequest(recordName, targetPath);
            return metadata(await request({ op: 'fetchAttachmentAsset', recordName, targetPath }, signal), recordName);
        },
        deleteAttachmentAssets: async (recordIDs, options = {}) => {
            const signal = options.signal ?? new AbortController().signal;
            abort(signal);
            if (!Array.isArray(recordIDs) || recordIDs.length > 100_000 || !recordIDs.every(identifier)
                || new Set(recordIDs).size !== recordIDs.length) return invalid();
            if (await request({ op: 'deleteRecords', recordType: 'MindwtrAttachment', recordIDs: [...recordIDs] }, signal) !== null) return invalid();
        },
        isAttachmentNotFoundError: (error) => isObjectRecord(error) && error.code === 'ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND',
    };
};
