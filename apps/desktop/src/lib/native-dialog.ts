import { withMindwtrDialog } from './app-lock';

/**
 * Drop-in `open`/`save` from @tauri-apps/plugin-dialog. A native file dialog
 * takes focus from the window; routing every dialog through here tells the
 * privacy lock (in Rust, shared by every window) that this focus loss is
 * Mindwtr's own, not the user leaving.
 */
type DialogPlugin = typeof import('@tauri-apps/plugin-dialog');

export const open = (async (options?: Parameters<DialogPlugin['open']>[0]) => {
    const dialog = await import('@tauri-apps/plugin-dialog');
    return withMindwtrDialog(() => dialog.open(options));
}) as DialogPlugin['open'];

export const save = (async (options?: Parameters<DialogPlugin['save']>[0]) => {
    const dialog = await import('@tauri-apps/plugin-dialog');
    return withMindwtrDialog(() => dialog.save(options));
}) as DialogPlugin['save'];
