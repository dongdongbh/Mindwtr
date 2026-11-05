import { dataDir, join } from '@tauri-apps/api/path';
import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';

let cachedDir: string | null = null;
let pendingDir: Promise<string> | null = null;


export async function getManagedDataDir(): Promise<string> {
    if (cachedDir) return cachedDir;
    if (!pendingDir) {
        pendingDir = (async () => {
            if (isTauriRuntime()) {
                try {
                    const dir = (await invokeNative<string>('get_managed_data_dir')).trim();
                    if (dir) return dir;
                } catch {

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


export async function getDeviceManagedDataDir(): Promise<string> {
    if (cachedDeviceDir) return cachedDeviceDir;
    let dir = '';
    if (isTauriRuntime()) {
        try {
            dir = (await invokeNative<string>('get_device_managed_data_dir')).trim();
        } catch {

        }
    }
    cachedDeviceDir = dir || await getManagedDataDir();
    return cachedDeviceDir;
}

export async function getDeviceManagedPath(...segments: string[]): Promise<string> {
    return await join(await getDeviceManagedDataDir(), ...segments);
}
