import { isTauriRuntime } from './runtime';
import {
    DESKTOP_WIDGET_MIN_SIZE,
    DESKTOP_WIDGET_PARAM,
    DESKTOP_WIDGET_WINDOW_PREFIX,
    desktopWidgetDefaultSize,
    type DesktopWidgetKind,
} from '../components/widgets/widget-data';
import { readStoredPosition } from '../components/widgets/DesktopWidgetApp';
import { logWarn } from './app-log';

/**
 * Opens the desktop widget window for `kind`, or closes it when it is already
 * open (toolbar buttons act as toggles). Windows are created from the frontend
 * via the Tauri JS API so no native command surface is needed.
 */
export async function toggleDesktopWidget(kind: DesktopWidgetKind): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const label = `${DESKTOP_WIDGET_WINDOW_PREFIX}${kind}`;
        const existing = await WebviewWindow.getByLabel(label);
        if (existing) {
            await existing.destroy();
            return;
        }

        const size = desktopWidgetDefaultSize(kind);
        const minSize = DESKTOP_WIDGET_MIN_SIZE[kind];
        const storedPosition = readStoredPosition(kind);
        new WebviewWindow(label, {
            url: `index.html?${DESKTOP_WIDGET_PARAM}=${kind}`,
            title: 'Mindwtr',
            width: size.width,
            height: size.height,
            minWidth: minSize.width,
            minHeight: minSize.height,
            resizable: true,
            decorations: false,
            shadow: false,
            transparent: true,
            alwaysOnTop: true,
            skipTaskbar: true,
            ...(storedPosition ? { x: storedPosition.x, y: storedPosition.y } : {}),
        });
    } catch (error) {
        void logWarn('Failed to toggle desktop widget window', {
            scope: 'window',
            extra: {
                kind,
                error: error instanceof Error ? error.message : String(error),
            },
        });
    }
}
