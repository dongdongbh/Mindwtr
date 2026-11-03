import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
    KNOWN_FILE_SYNC_LEASE_REASONS,
    KNOWN_FILE_SYNC_PUBLICATION_REASONS,
    buildFileSyncAttachmentFailureExtra,
    runFileSyncAttachmentStage,
} from './file-sync-attachment-diagnostics';

describe('File Sync attachment failure diagnostics', () => {
    it('extracts an explicit Windows OS error through bounded causes without leaking messages', () => {
        const privatePath = 'C:\\Private\\customer-secret.pdf';
        const error = new Error('File Sync attachment generation failed integrity verification') as Error & {
            cause?: unknown;
        };
        error.cause = new Error(`The process cannot access ${privatePath} (os error 32)`);

        const extra = buildFileSyncAttachmentFailureExtra('existing-generation-verify', error);

        expect(extra).toEqual({
            releaseCheck: 'v1.3.1/file-sync-attachment-failure',
            backend: 'file',
            operation: 'upload',
            stage: 'existing-generation-verify',
            errorType: 'native-os-error',
            nativeCode: '32',
            reason: 'unlisted',
        });
        expect(JSON.stringify(extra)).not.toContain(privatePath);
        expect(JSON.stringify(extra)).not.toContain('process cannot access');
    });

    it('accepts only allowlisted symbolic errno values and does not infer a bare numeric errno', () => {
        expect(buildFileSyncAttachmentFailureExtra('scratch-open', { code: 'EACCES' })).toMatchObject({
            errorType: 'native-errno',
            nativeCode: 'EACCES',
        });
        expect(buildFileSyncAttachmentFailureExtra('scratch-open', new Error('errno 13'))).toMatchObject({
            errorType: 'error',
            nativeCode: 'unknown',
        });
        expect(buildFileSyncAttachmentFailureExtra('scratch-open', { code: 'CUSTOM_SECRET' })).toMatchObject({
            errorType: 'unknown',
            nativeCode: 'unknown',
        });
    });

    it('preserves the original failure when the diagnostic logger throws', async () => {
        const transferError = new TypeError('private transfer failure');
        const logSyncWarning = vi.fn(() => {
            throw new Error('logger unavailable');
        });

        const thrown = await runFileSyncAttachmentStage(
            'native-publication',
            logSyncWarning,
            async () => { throw transferError; },
        ).catch((error: unknown) => error);

        expect(thrown).toBe(transferError);
        expect(logSyncWarning).toHaveBeenCalledWith(
            'File Sync attachment operation failed',
            undefined,
            {
                releaseCheck: 'v1.3.1/file-sync-attachment-failure',
                backend: 'file',
                operation: 'upload',
                stage: 'native-publication',
                errorType: 'error',
                nativeCode: 'unknown',
                reason: 'unlisted',
            },
        );
    });

    it('does not call the diagnostic logger when a stage succeeds', async () => {
        const logSyncWarning = vi.fn(() => {
            throw new Error('logger unavailable');
        });

        await expect(runFileSyncAttachmentStage(
            'scratch-write',
            logSyncWarning,
            async () => 'published',
        )).resolves.toBe('published');
        expect(logSyncWarning).not.toHaveBeenCalled();
    });


    it('names the native refusal only when it is one of our own fixed sentences', () => {
        expect(buildFileSyncAttachmentFailureExtra('generation-reserve', 'Attachment publication journal is full'))
            .toMatchObject({ errorType: 'string', nativeCode: 'unknown', reason: 'Attachment publication journal is full' });
        expect(buildFileSyncAttachmentFailureExtra('generation-reserve', 'Unknown or already released File Sync lease'))
            .toMatchObject({ reason: 'Unknown or already released File Sync lease' });
        expect(buildFileSyncAttachmentFailureExtra(
            'generation-reserve',
            'File Sync private publication path must be a real directory, not a link or reparse point',
        )).toMatchObject({ reason: 'File Sync private publication path must be a real directory, not a link or reparse point' });


        const leaky = 'Failed to inspect attachment publication namespace C:\\Users\\roman\\Sync\\attachments: denied';
        const extra = buildFileSyncAttachmentFailureExtra('generation-reserve', leaky);
        expect(extra.reason).toBe('unlisted');
        expect(JSON.stringify(extra)).not.toContain('roman');

        expect(buildFileSyncAttachmentFailureExtra('generation-reserve', 'File Sync C:/Users/roman path must be a directory').reason)
            .toBe('unlisted');
    });

    it('keeps the reason list in step with the native source', () => {
        const nativeDir = path.join(__dirname, '..', '..', 'src-tauri', 'src');
        const publication = readFileSync(path.join(nativeDir, 'file_sync_attachment_publication.rs'), 'utf8');
        const productionSource = publication.slice(0, publication.indexOf('#[cfg(test)]\nmod '));
        const nativeLiterals = new Set(
            Array.from(productionSource.matchAll(/"((?:Attachment|File Sync|Journal)[^"\\{}]{6,160})"/g), (match) => match[1]),
        );

        expect([...nativeLiterals].filter((literal) => !KNOWN_FILE_SYNC_PUBLICATION_REASONS.has(literal))).toEqual([]);
        expect([...KNOWN_FILE_SYNC_PUBLICATION_REASONS].filter((reason) => !nativeLiterals.has(reason))).toEqual([]);

        const leaseSource = readFileSync(path.join(nativeDir, 'sync.rs'), 'utf8');
        for (const reason of KNOWN_FILE_SYNC_LEASE_REASONS) expect(leaseSource).toContain(`"${reason}"`);
    });
});
