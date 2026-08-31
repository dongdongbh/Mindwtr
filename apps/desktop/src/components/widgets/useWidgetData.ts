import { useCallback, useEffect, useState } from 'react';

import type { AppData } from '@mindwtr/core';

import { invokeNative } from '../../lib/tauri-invoke';

const DEFAULT_REFRESH_INTERVAL_MS = 15_000;

/**
 * Loads the persisted data snapshot for the widget window and keeps it fresh.
 * Widgets are mostly read-only; writing goes through the shared task store and
 * callers refresh with the returned `refresh` after a mutation. Polling plus
 * refresh-on-focus covers external changes (CLI/MCP) and main-window edits.
 */
export function useWidgetData(refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS): { data: AppData | null; refresh: () => Promise<void> } {
    const [data, setData] = useState<AppData | null>(null);

    const refresh = useCallback(async () => {
        try {
            setData(await invokeNative<AppData>('get_data'));
        } catch {
            // Keep the last good snapshot; widgets fail quiet and read-only.
        }
    }, []);

    useEffect(() => {
        void refresh();
        const interval = window.setInterval(() => void refresh(), refreshIntervalMs);
        const onFocus = () => void refresh();
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onFocus);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onFocus);
        };
    }, [refresh, refreshIntervalMs]);

    return { data, refresh };
}
