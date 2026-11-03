export type FileSyncAttachmentFailureStage =
    | 'local-source-stat'
    | 'local-source-read'
    | 'snapshot-prepare'
    | 'wire-encryption'
    | 'generation-presence'
    | 'generation-reserve'
    | 'scratch-open'
    | 'scratch-write'
    | 'scratch-close'
    | 'existing-generation-read'
    | 'existing-generation-verify'
    | 'native-publication';

type FileSyncAttachmentFailureLogger = (
    message: string,
    error?: unknown,
    extra?: Record<string, string>,
) => void;

const FILE_SYNC_ATTACHMENT_FAILURE_MESSAGE = 'File Sync attachment operation failed';
const FILE_SYNC_ATTACHMENT_FAILURE_RELEASE_CHECK = 'v1.3.1/file-sync-attachment-failure';
const MAX_CAUSE_DEPTH = 4;
const MAX_WINDOWS_ERROR_CODE = 0xffff_ffff;
const ALLOWED_ERRNOS = new Set([
    'EACCES',
    'EBUSY',
    'EEXIST',
    'EFBIG',
    'EIO',
    'EISDIR',
    'EMFILE',
    'ENAMETOOLONG',
    'ENFILE',
    'ENOENT',
    'ENOSPC',
    'ENOTDIR',
    'ENOTEMPTY',
    'EPERM',
    'EROFS',
    'EXDEV',
]);

type ObservedNativeFailure = {
    errorType: 'native-os-error' | 'native-errno' | 'error' | 'string' | 'unknown';
    nativeCode: string;
};

const readCause = (value: unknown): unknown => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
    try {
        return Reflect.get(value, 'cause');
    } catch {
        return undefined;
    }
};

const readSymbolicErrno = (value: unknown): string | null => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
    try {
        const code = Reflect.get(value, 'code');
        return typeof code === 'string' && ALLOWED_ERRNOS.has(code) ? code : null;
    } catch {
        return null;
    }
};

const readErrorText = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    return null;
};

const readWindowsOsErrorCode = (value: unknown): string | null => {
    const text = readErrorText(value);
    if (!text) return null;
    const match = /\bos error\s+(\d+)\b/i.exec(text);
    if (!match) return null;
    const code = Number(match[1]);
    return Number.isSafeInteger(code) && code >= 0 && code <= MAX_WINDOWS_ERROR_CODE
        ? String(code)
        : null;
};

const observeNativeFailure = (error: unknown): ObservedNativeFailure => {
    const seen = new Set<unknown>();
    let current: unknown = error;
    let fallbackType: ObservedNativeFailure['errorType'] = 'unknown';

    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
        if (seen.has(current)) break;
        seen.add(current);

        if (current instanceof Error) fallbackType = 'error';
        else if (typeof current === 'string' && fallbackType === 'unknown') fallbackType = 'string';

        const windowsCode = readWindowsOsErrorCode(current);
        if (windowsCode !== null) {
            return { errorType: 'native-os-error', nativeCode: windowsCode };
        }
        const errno = readSymbolicErrno(current);
        if (errno !== null) {
            return { errorType: 'native-errno', nativeCode: errno };
        }
        current = readCause(current);
    }

    return { errorType: fallbackType, nativeCode: 'unknown' };
};


export const KNOWN_FILE_SYNC_PUBLICATION_REASONS: ReadonlySet<string> = new Set([
    'File Sync filesystem does not expose a stable directory identity',
    'File Sync directory identity is unsupported on this platform',
    'File Sync root must be absolute and normalized',
    'Attachment publication journal directory identity no longer matches the held lease',
    'File Sync attachments directory is not bound',
    'Attachment publication SHA-256 must be 64 hexadecimal characters',
    'Attachment publication journal must be a real directory',
    'Attachment publication paths must be absolute and normalized',
    'Attachment publication target must be a direct child of the leased attachments directory',
    'Attachment publication target has no valid file name',
    'Attachment publication target is not hash-qualified',
    'Attachment publication journal version is unsupported',
    'Attachment publication operation id is invalid',
    'Attachment publication journal belongs to a different sync folder',
    'Attachment publication private namespace ownership is invalid',
    'Attachment publication scratch ownership is invalid',
    'Attachment publication journal entry is too large',
    'Attachment publication journal must not be a reparse point',
    'Attachment publication journal is not a bounded regular file',
    'Attachment publication journal is invalid',
    'Attachment publication journal file name is invalid',
    'Attachment publication journal has no parent',
    'Attachment publication journal must be a regular file',
    'Attachment publication private namespace was not fully reserved',
    'Attachment publication private namespace changed',
    'Attachment publication namespace has no parent',
    'Attachment publication private namespace ownership was not recorded; preserving it',
    'Journal-owned attachment scratch is not a regular file',
    'Attachment publication journal is full',
    'Attachment generation stage size changed before publication',
    'Attachment generation stage size overflow',
    'Attachment generation stage failed integrity verification',
    'Attachment publication target has no file name',
    'Attachment publication journal exceeds its entry limit',
]);

export const KNOWN_FILE_SYNC_LEASE_REASONS: ReadonlySet<string> = new Set([
    'File Sync lease state is unavailable',
    'Unknown or already released File Sync lease',
    'File Sync lease belongs to a different renderer window',
]);


const TEMPLATED_REASON_PATTERNS = [
    /^File Sync [a-z][a-z ]{0,30} path must be a real directory, not a link or reparse point$/,
    /^File Sync [a-z][a-z ]{0,30} path must be a directory$/,
    /^File Sync [a-z][a-z ]{0,30} directory changed while its lease was held$/,
];

const readKnownReason = (error: unknown): string => {
    const seen = new Set<unknown>();
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
        if (seen.has(current)) break;
        seen.add(current);
        const text = readErrorText(current)?.trim();
        if (text && (
            KNOWN_FILE_SYNC_PUBLICATION_REASONS.has(text)
            || KNOWN_FILE_SYNC_LEASE_REASONS.has(text)
            || TEMPLATED_REASON_PATTERNS.some((pattern) => pattern.test(text))
        )) return text;
        current = readCause(current);
    }
    return 'unlisted';
};

export const buildFileSyncAttachmentFailureExtra = (
    stage: FileSyncAttachmentFailureStage,
    error: unknown,
): Record<string, string> => ({
    releaseCheck: FILE_SYNC_ATTACHMENT_FAILURE_RELEASE_CHECK,
    backend: 'file',
    operation: 'upload',
    stage,
    ...observeNativeFailure(error),
    reason: readKnownReason(error),
});

export const reportFileSyncAttachmentFailure = (
    stage: FileSyncAttachmentFailureStage,
    error: unknown,
    logSyncWarning: FileSyncAttachmentFailureLogger,
): void => {
    try {
        logSyncWarning(
            FILE_SYNC_ATTACHMENT_FAILURE_MESSAGE,
            undefined,
            buildFileSyncAttachmentFailureExtra(stage, error),
        );
    } catch {

    }
};

export const runFileSyncAttachmentStage = async <T>(
    stage: FileSyncAttachmentFailureStage,
    logSyncWarning: FileSyncAttachmentFailureLogger,
    operation: () => Promise<T>,
): Promise<T> => {
    try {
        return await operation();
    } catch (error) {
        reportFileSyncAttachmentFailure(stage, error, logSyncWarning);
        throw error;
    }
};
