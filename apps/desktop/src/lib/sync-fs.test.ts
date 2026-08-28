import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setNativeInvokeTransport } from './tauri-invoke';
import {
    abandonAttachmentGeneration,
    exists,
    mkdir,
    publishAttachmentGeneration,
    remove,
    rename,
    reserveAttachmentGeneration,
} from './sync-fs';

vi.mock('./runtime', () => ({ isTauriRuntime: () => true }));

describe('sync folder file-system primitives', () => {
    const invoked: Array<[string, Record<string, unknown> | undefined]> = [];

    beforeEach(() => {
        invoked.length = 0;
        setNativeInvokeTransport(async (command, args) => {
            invoked.push([command, args]);
            if (command === 'sync_fs_reserve_attachment_generation') {
                return {
                    operationId: 'operation-1',
                    scratchPath: '/mnt/rclone/sync/attachments/.mindwtr-attachment-generation-operation-1.tmp',
                } as never;
            }
            return command === 'sync_fs_publish_attachment_generation'
                ? { status: 'published' } as never
                : true as never;
        });
    });

    afterEach(() => {
        setNativeInvokeTransport(null);
    });

    // #1037: these four are plain `#[tauri::command]`s in tauri-plugin-fs, so
    // the plugin runs them on the Tauri main thread and a sync folder on a slow
    // mount freezes the window for the whole run. They must go to Rust.
    it('routes every op through an async Rust command instead of the fs plugin', async () => {
        await exists('/mnt/rclone/sync/attachments/a.txt');
        await mkdir('/mnt/rclone/sync/attachments');
        await remove('/mnt/rclone/sync/attachments/a.txt');
        await rename('/mnt/rclone/sync/a.tmp', '/mnt/rclone/sync/a.txt');
        await expect(reserveAttachmentGeneration(
            'lease-1',
            '/mnt/rclone/sync/attachments/a.abc.txt',
            3,
            'a'.repeat(64),
        )).resolves.toMatchObject({ operationId: 'operation-1' });
        await expect(publishAttachmentGeneration(
            'lease-1',
            'operation-1',
        )).resolves.toEqual({ status: 'published' });
        await abandonAttachmentGeneration('lease-1', 'operation-2');

        expect(invoked).toEqual([
            ['sync_fs_exists', { path: '/mnt/rclone/sync/attachments/a.txt' }],
            ['sync_fs_create_dir', { path: '/mnt/rclone/sync/attachments' }],
            ['sync_fs_remove_file', { path: '/mnt/rclone/sync/attachments/a.txt' }],
            ['sync_fs_rename', { from: '/mnt/rclone/sync/a.tmp', to: '/mnt/rclone/sync/a.txt' }],
            ['sync_fs_reserve_attachment_generation', {
                leaseToken: 'lease-1',
                targetPath: '/mnt/rclone/sync/attachments/a.abc.txt',
                expectedSize: 3,
                expectedSha256: 'a'.repeat(64),
            }],
            ['sync_fs_publish_attachment_generation', {
                leaseToken: 'lease-1',
                operationId: 'operation-1',
            }],
            ['sync_fs_abandon_attachment_generation', {
                leaseToken: 'lease-1',
                operationId: 'operation-2',
            }],
        ]);
    });
});
