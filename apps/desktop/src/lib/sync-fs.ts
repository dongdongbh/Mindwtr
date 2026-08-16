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
