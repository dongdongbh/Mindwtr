import { invokeNative } from './tauri-invoke';

/**
 * File-system primitives for sync-folder paths.
 *
 * `exists`, `mkdir`, `remove` and `rename` are plain `#[tauri::command]`s in
 * tauri-plugin-fs, so the plugin runs each syscall on the Tauri main thread.
 * A file sync issues one `exists` per attachment plus a mkdir/rename/remove per
 * copy against the sync folder, and on a slow mount (rclone/WinFSP, network
 * share) that blocks the native message pump for the whole run — Windows paints
 * "Mindwtr (Not Responding)" (#1037). These go through async Rust commands
 * instead, which run on the blocking pool.
 *
 * `readFile`/`writeFile`/`readDir` are already `async fn` upstream, so those
 * keep coming straight from the plugin. Paths must be absolute — the
 * base-directory-relative plugin calls all land on local app data.
 */
export const exists = (path: string): Promise<boolean> => invokeNative('sync_fs_exists', { path });

export const mkdir = (path: string): Promise<void> => invokeNative('sync_fs_create_dir', { path });

export const remove = (path: string): Promise<void> => invokeNative('sync_fs_remove_file', { path });

export const rename = (from: string, to: string): Promise<void> =>
    invokeNative('sync_fs_rename', { from, to });

/**
 * Atomically publishes one already-written immutable attachment generation.
 * Native code streams and verifies the exact scratch bytes, flushes them, then
 * replaces only the hash-qualified final path and persists the directory entry.
 */
export const publishAttachmentGeneration = (
    scratchPath: string,
    targetPath: string,
    expectedSize: number,
    expectedSha256: string,
): Promise<void> => invokeNative('sync_fs_publish_attachment_generation', {
    scratchPath,
    targetPath,
    expectedSize,
    expectedSha256,
});

/** #1057: same main-thread-freeze risk as `exists` above — the fs plugin's `stat`
 *  is a plain (non-async) command too. */
export const stat = (path: string): Promise<{ mtimeMs: number; size: number }> =>
    invokeNative('sync_fs_stat', { path });

/**
 * Holds the native OS lock on the sync folder's stable `.mindwtr.lock` inode.
 * The opaque token is process-local and path-bound; callers must retain it for
 * the complete mutation cycle and release it in `finally`.
 */
export const acquireFileSyncLease = (path?: string): Promise<string> =>
    invokeNative('acquire_file_sync_lease', path ? { path } : undefined);

export const releaseFileSyncLease = (token: string): Promise<void> =>
    invokeNative('release_file_sync_lease', { token });
