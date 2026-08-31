import { DESKTOP_WIDGET_WINDOW_PREFIX, getDesktopWidgetKindFromLocation, type DesktopWidgetKind } from './widget-data';

const WIDGET_POSITION_STORAGE_PREFIX = 'mindwtr.widget.pos.';

/**
 * Brings the main window to the front when the user clicks a widget item.
 * Best effort: if the window cannot be focused, the click is simply ignored.
 */
export async function focusMainWindow(): Promise<void> {
    try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const main = await WebviewWindow.getByLabel('main');
        await main?.setFocus();
    } catch {
        // Widget stays read-only when window focus is unavailable.
    }
}

/** Remembers the current widget window position so it reopens in place. */
export async function saveWidgetPosition(kind: DesktopWidgetKind): Promise<void> {
    try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const position = await getCurrentWebviewWindow().outerPosition();
        localStorage.setItem(`${WIDGET_POSITION_STORAGE_PREFIX}${kind}`, JSON.stringify({ x: position.x, y: position.y }));
    } catch {
        // Position memory is best effort; widgets still work without it.
    }
}

/**
 * Closes the widget window itself from its chrome (X button). The native app
 * intercepts `CloseRequested` for every window (main window closes to tray),
 * so widgets must `destroy()` instead: `close()` would stay open and take the
 * main window down with it. Position is saved first because `destroy()` skips
 * close-request handlers.
 */
export async function closeWidgetWindow(): Promise<void> {
    const kind = getDesktopWidgetKindFromLocation();
    if (kind) await saveWidgetPosition(kind);
    try {
        const { WebviewWindow, getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const self = kind ? await WebviewWindow.getByLabel(`${DESKTOP_WIDGET_WINDOW_PREFIX}${kind}`) : null;
        if (self) {
            await self.destroy();
            return;
        }
        await getCurrentWebviewWindow().destroy();
    } catch {
        // Without window APIs (e.g. browser preview) there is nothing to close.
    }
}
