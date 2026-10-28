import { dataDir, join } from '@tauri-apps/api/path';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';

let cachedDir: string | null = null;
let pendingDir: Promise<string> | null = null;

// The directory for app-managed files the webview reads and writes directly
// (attachments, logs, audio captures, speech models). Standard installs
// resolve to the OS data dir + "mindwtr" (the historical layout); portable
// installs resolve into the portable profile dir (#855). Never anchor managed
// files on BaseDirectory.Data — that bypasses the portable redirect.
export async function getManagedDataDir(): Promise<string> {
    if (cachedDir) return cachedDir;
    if (!pendingDir) {
        pendingDir = (async () => {
            if (isTauriRuntime()) {
                try {
                    const dir = (await invokeNative<string>('get_managed_data_dir')).trim();
                    if (dir) return dir;
                } catch {
                    // Older backend without the command — fall through.
                }
            }
            return await join(await dataDir(), 'mindwtr');
        })()
            .then((dir) => {
                cachedDir = dir;
                return dir;
            })
            .catch((error) => {
                pendingDir = null;
                throw error;
            });
    }
    return pendingDir;
}

export async function getManagedPath(...segments: string[]): Promise<string> {
    return await join(await getManagedDataDir(), ...segments);
}

let cachedDeviceDir: string | null = null;

// Device-level managed files shared by every workspace (#1473): logs and
// speech models. In the default workspace this is getManagedDataDir() itself.
export async function getDeviceManagedDataDir(): Promise<string> {
    if (cachedDeviceDir) return cachedDeviceDir;
    let dir = '';
    if (isTauriRuntime()) {
        try {
            dir = (await invokeNative<string>('get_device_managed_data_dir')).trim();
        } catch {
            // Older backend without the command: workspaces did not exist then.
        }
    }
    cachedDeviceDir = dir || await getManagedDataDir();
    return cachedDeviceDir;
}

export async function getDeviceManagedPath(...segments: string[]): Promise<string> {
    return await join(await getDeviceManagedDataDir(), ...segments);
}
