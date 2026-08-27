import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({ isTauriRuntime: () => true }));

import { installAttachmentDownload } from './attachment-installer';
import { setNativeInvokeTransport } from './tauri-invoke';

describe('attachment download installer native boundary', () => {
    const invoked: Array<[string, Record<string, unknown> | undefined]> = [];

    beforeEach(() => {
        invoked.length = 0;
        setNativeInvokeTransport(async (command, args) => {
            invoked.push([command, args]);
            return { kind: 'installed' } as never;
        });
    });

    afterEach(() => {
        setNativeInvokeTransport(null);
    });

    it('passes an expected-absent generation to the native installer unchanged', async () => {
        await expect(installAttachmentDownload(
            '/managed/attachments/.download-a',
            '/managed/attachments/a.pdf',
            { kind: 'absent' },
        )).resolves.toEqual({ kind: 'installed' });

        expect(invoked).toEqual([[
            'install_attachment_download',
            {
                stagedPath: '/managed/attachments/.download-a',
                targetPath: '/managed/attachments/a.pdf',
                expected: { kind: 'absent' },
            },
        ]]);
    });

    it('passes the exact expected-present SHA-256 and preserves typed conflicts', async () => {
        const expectedHash = 'a'.repeat(64);
        setNativeInvokeTransport(async (command, args) => {
            invoked.push([command, args]);
            return {
                kind: 'conflict',
                reason: 'generation-mismatch',
                preservedPath: '/managed/attachments/a.pdf',
            } as never;
        });

        await expect(installAttachmentDownload(
            '/managed/attachments/.download-a',
            '/managed/attachments/a.pdf',
            { kind: 'present', sha256: expectedHash },
        )).resolves.toEqual({
            kind: 'conflict',
            reason: 'generation-mismatch',
            preservedPath: '/managed/attachments/a.pdf',
        });

        expect(invoked[0]).toEqual([
            'install_attachment_download',
            {
                stagedPath: '/managed/attachments/.download-a',
                targetPath: '/managed/attachments/a.pdf',
                expected: { kind: 'present', sha256: expectedHash },
            },
        ]);
    });
});
