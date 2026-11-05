import { logError } from './app-log';
import { invokeNative } from './tauri-invoke';


export async function hideMainWindowToTray(): Promise<void> {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const window = getCurrentWindow();
    try {
        await window.setSkipTaskbar(true);
    } catch (error) {
        void logError(error, { scope: 'window', step: 'setSkipTaskbar' });
    }
    await window.hide();


    await invokeNative('set_macos_activation_policy', { accessory: true }).catch((error) => {
        void logError(error, { scope: 'window', step: 'setActivationPolicy' });
    });
}
