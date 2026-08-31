import { useEffect, useState } from 'react';

import { useTaskStore } from '@mindwtr/core';

import { isTauriRuntime } from '../../lib/runtime';
import { CalendarWidget } from './CalendarWidget';
import { TodayNoteWidget } from './TodayNoteWidget';
import { useWidgetData } from './useWidgetData';
import {
    getDesktopWidgetKindFromLocation,
    type DesktopWidgetKind,
} from './widget-data';

const WIDGET_POSITION_STORAGE_PREFIX = 'mindwtr.widget.pos.';

export const readStoredPosition = (kind: DesktopWidgetKind): { x: number; y: number } | null => {
    try {
        const raw = localStorage.getItem(`${WIDGET_POSITION_STORAGE_PREFIX}${kind}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
        if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null;
        return { x: parsed.x, y: parsed.y };
    } catch {
        return null;
    }
};

/**
 * Hydrates the shared task store in this webview so widget writes (adding a
 * task) persist a complete snapshot instead of clobbering existing data.
 * Returns true once the store is safe to write to.
 */
function useWidgetStoreHydration(): boolean {
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => {
        let cancelled = false;
        if (!isTauriRuntime()) {
            // Browser preview never writes through the store.
            setHydrated(true);
            return;
        }
        void useTaskStore.getState().fetchData({ silent: true })
            .then(() => {
                if (!cancelled) setHydrated(true);
            })
            .catch(() => {
                // Widgets stay read-only when hydration fails; writes are
                // skipped because they would persist an incomplete snapshot.
            });
        return () => {
            cancelled = true;
        };
    }, []);
    return hydrated;
}

/** Persists the widget window position (debounced) so it reopens where the user left it. */
function usePersistedWidgetPosition(kind: DesktopWidgetKind): void {
    useEffect(() => {
        if (!isTauriRuntime()) return;
        let disposeMoved: (() => void) | null = null;
        let saveTimer: number | null = null;

        void (async () => {
            try {
                const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                const current = getCurrentWebviewWindow();
                disposeMoved = await current.onMoved(({ payload }) => {
                    if (saveTimer !== null) window.clearTimeout(saveTimer);
                    saveTimer = window.setTimeout(() => {
                        saveTimer = null;
                        persistPosition(kind, { x: payload.x, y: payload.y });
                    }, 400);
                });
            } catch {
                // Window event APIs unavailable (e.g. non-Tauri preview): skip.
            }
        })();

        return () => {
            if (saveTimer !== null) window.clearTimeout(saveTimer);
            disposeMoved?.();
        };
    }, [kind]);
}

function persistPosition(kind: DesktopWidgetKind, position: { x: number; y: number }): void {
    try {
        localStorage.setItem(`${WIDGET_POSITION_STORAGE_PREFIX}${kind}`, JSON.stringify(position));
    } catch {
        // Best effort only.
    }
}

export function DesktopWidgetApp() {
    const kind = getDesktopWidgetKindFromLocation();
    const storeReady = useWidgetStoreHydration();
    usePersistedWidgetPosition(kind ?? 'calendar');
    const { data, refresh } = useWidgetData();

    if (!kind) {
        return null;
    }
    if (kind === 'calendar') {
        return <CalendarWidget data={data} canWrite={storeReady} onRefresh={refresh} />;
    }
    return <TodayNoteWidget data={data} canWrite={storeReady} onRefresh={refresh} />;
}
