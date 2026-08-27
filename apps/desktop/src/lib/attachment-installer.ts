import { invokeNative } from './tauri-invoke';

export type AttachmentInstallExpectation =
    | { kind: 'absent' }
    | { kind: 'present'; sha256: string };

export type AttachmentInstallConflictReason =
    | 'target-exists'
    | 'target-missing'
    | 'generation-mismatch'
    | 'recovery-conflict';

export type AttachmentInstallOutcome =
    | { kind: 'installed'; preservedPath?: string }
    | {
        kind: 'conflict';
        reason: AttachmentInstallConflictReason;
        preservedPath?: string;
    };

/**
 * Commits a fully-written download stage inside the managed attachments directory.
 * Rust owns the generation check, no-replace namespace mutation, quarantine, and
 * crash journal; this wrapper deliberately contains no filesystem policy.
 */
export const installAttachmentDownload = (
    stagedPath: string,
    targetPath: string,
    expected: AttachmentInstallExpectation,
    expectedDownloadSha256: string,
): Promise<AttachmentInstallOutcome> => invokeNative('install_attachment_download', {
    stagedPath,
    targetPath,
    expected,
    expectedDownloadSha256,
});
