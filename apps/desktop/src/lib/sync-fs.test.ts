import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setNativeInvokeTransport } from './tauri-invoke';
import { exists, mkdir, publishAttachmentGeneration, remove, rename } from './sync-fs';

vi.mock('./runtime', () => ({ isTauriRuntime: () => true }));

describe('sync folder file-system primitives', () => {
    const invoked: Array<[string, Record<string, unknown> | undefined]> = [];

    beforeEach(() => {
        invoked.length = 0;
        setNativeInvokeTransport(async (command, args) => {
            invoked.push([command, args]);
            return true as never;
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
        await publishAttachmentGeneration(
            '/mnt/rclone/sync/attachments/.mindwtr-attachment-generation-1.tmp',
            '/mnt/rclone/sync/attachments/a.abc.txt',
            3,
            'a'.repeat(64),
        );

        expect(invoked).toEqual([
            ['sync_fs_exists', { path: '/mnt/rclone/sync/attachments/a.txt' }],
            ['sync_fs_create_dir', { path: '/mnt/rclone/sync/attachments' }],
            ['sync_fs_remove_file', { path: '/mnt/rclone/sync/attachments/a.txt' }],
            ['sync_fs_rename', { from: '/mnt/rclone/sync/a.tmp', to: '/mnt/rclone/sync/a.txt' }],
            ['sync_fs_publish_attachment_generation', {
                scratchPath: '/mnt/rclone/sync/attachments/.mindwtr-attachment-generation-1.tmp',
                targetPath: '/mnt/rclone/sync/attachments/a.abc.txt',
                expectedSize: 3,
                expectedSha256: 'a'.repeat(64),
            }],
        ]);
    });
});
