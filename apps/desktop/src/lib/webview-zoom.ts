type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type WebviewZoomTarget = {
    setZoom: (scaleFactor: number) => Promise<void>;
};

type WebviewZoomModule = {
    getCurrentWebview: () => WebviewZoomTarget;
};

type WebviewZoomShortcutEvent = Pick<
    KeyboardEvent,
    'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'preventDefault' | 'stopPropagation'
>;

type WebviewZoomWheelEvent = Pick<
    WheelEvent,
    'altKey' | 'ctrlKey' | 'deltaY' | 'metaKey' | 'preventDefault' | 'stopPropagation'
>;

type WebviewZoomShortcutAction = 'in' | 'out' | 'reset';

type WebviewZoomOptions = {
    storage?: StorageLike | null;
    loadWebviewModule?: () => Promise<WebviewZoomModule>;
    onError?: (error: unknown) => void;
};

export const WEBVIEW_ZOOM_STORAGE_KEY = 'mindwtr:webview-zoom:v1';
export const DEFAULT_WEBVIEW_ZOOM = 1;
export const MIN_WEBVIEW_ZOOM = 0.5;
export const MAX_WEBVIEW_ZOOM = 2;
const WEBVIEW_ZOOM_STEP = 0.1;
const WEBVIEW_ZOOM_WHEEL_THRESHOLD = 80;
const DEFAULT_ZOOM_EPSILON = 0.001;

const roundZoom = (value: number): number => Math.round(value * 100) / 100;

export function normalizeWebviewZoom(value: unknown, fallback = DEFAULT_WEBVIEW_ZOOM): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return roundZoom(Math.min(MAX_WEBVIEW_ZOOM, Math.max(MIN_WEBVIEW_ZOOM, numeric)));
}

function parseStoredZoom(raw: string | null): number {
    if (!raw) return DEFAULT_WEBVIEW_ZOOM;
    try {
        return normalizeWebviewZoom(JSON.parse(raw));
    } catch {
        return normalizeWebviewZoom(raw);
    }
}

export function loadStoredWebviewZoom(storage?: StorageLike | null): number {
    if (!storage) return DEFAULT_WEBVIEW_ZOOM;
    try {
        return parseStoredZoom(storage.getItem(WEBVIEW_ZOOM_STORAGE_KEY));
    } catch {
        return DEFAULT_WEBVIEW_ZOOM;
    }
}

export function saveStoredWebviewZoom(value: number, storage?: StorageLike | null): number {
    const zoom = normalizeWebviewZoom(value);
    if (!storage) return zoom;
    try {
        if (Math.abs(zoom - DEFAULT_WEBVIEW_ZOOM) < DEFAULT_ZOOM_EPSILON) {
            storage.removeItem(WEBVIEW_ZOOM_STORAGE_KEY);
            return zoom;
        }
        storage.setItem(WEBVIEW_ZOOM_STORAGE_KEY, JSON.stringify(zoom));
    } catch {

    }
    return zoom;
}

export function getNextWebviewZoom(current: number, action: WebviewZoomShortcutAction): number {
    if (action === 'reset') return DEFAULT_WEBVIEW_ZOOM;
    const delta = action === 'in' ? WEBVIEW_ZOOM_STEP : -WEBVIEW_ZOOM_STEP;
    return normalizeWebviewZoom(current + delta);
}

export function getWebviewZoomShortcutAction(event: WebviewZoomShortcutEvent): WebviewZoomShortcutAction | null {
    if (event.altKey || (!event.ctrlKey && !event.metaKey)) return null;
    const key = event.key.toLowerCase();
    if (event.code === 'Equal' || event.code === 'NumpadAdd' || key === '=' || key === '+') {
        return 'in';
    }
    if (event.code === 'Minus' || event.code === 'NumpadSubtract' || key === '-' || key === '_') {
        return 'out';
    }
    if (event.code === 'Digit0' || event.code === 'Numpad0' || key === '0') {
        return 'reset';
    }
    return null;
}

export function getWebviewZoomWheelAction(event: WebviewZoomWheelEvent): WebviewZoomShortcutAction | null {
    if (event.altKey || (!event.ctrlKey && !event.metaKey)) return null;
    if (event.deltaY < 0) return 'in';
    if (event.deltaY > 0) return 'out';
    return null;
}

const loadCurrentWebviewModule = (): Promise<WebviewZoomModule> => import('@tauri-apps/api/webview');

async function applyWebviewZoom(
    zoom: number,
    loadWebviewModule: () => Promise<WebviewZoomModule>
): Promise<void> {
    const { getCurrentWebview } = await loadWebviewModule();
    await getCurrentWebview().setZoom(zoom);
}

export async function restoreStoredWebviewZoom(options: WebviewZoomOptions = {}): Promise<void> {
    const zoom = loadStoredWebviewZoom(options.storage);
    if (Math.abs(zoom - DEFAULT_WEBVIEW_ZOOM) < DEFAULT_ZOOM_EPSILON) return;
    await applyWebviewZoom(zoom, options.loadWebviewModule ?? loadCurrentWebviewModule);
}

export function installWebviewZoomShortcuts(options: WebviewZoomOptions = {}): () => void {
    if (typeof window === 'undefined') return () => { };

    const storage = options.storage;
    const loadWebviewModule = options.loadWebviewModule ?? loadCurrentWebviewModule;
    let currentZoom = loadStoredWebviewZoom(storage);
    let applyQueue = Promise.resolve();
    let wheelDelta = 0;

    const queueApplyZoom = (zoom: number) => {
        applyQueue = applyQueue
            .then(() => applyWebviewZoom(zoom, loadWebviewModule))
            .catch((error) => {
                options.onError?.(error);
            });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
        const action = getWebviewZoomShortcutAction(event);
        if (!action) return;

        event.preventDefault();
        event.stopPropagation();

        currentZoom = saveStoredWebviewZoom(getNextWebviewZoom(currentZoom, action), storage);
        queueApplyZoom(currentZoom);
    };

    const handleWheel = (event: WheelEvent) => {
        const action = getWebviewZoomWheelAction(event);
        if (!action) return;

        event.preventDefault();
        event.stopPropagation();

        wheelDelta += event.deltaY;
        if (Math.abs(wheelDelta) < WEBVIEW_ZOOM_WHEEL_THRESHOLD) return;

        const wheelAction = wheelDelta < 0 ? 'in' : 'out';
        wheelDelta = 0;
        currentZoom = saveStoredWebviewZoom(getNextWebviewZoom(currentZoom, wheelAction), storage);
        queueApplyZoom(currentZoom);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    return () => {
        window.removeEventListener('keydown', handleKeyDown, true);
        window.removeEventListener('wheel', handleWheel, true);
    };
}
