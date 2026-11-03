


import { type AppData, type Language, getSystemDefaultLanguage, loadStoredLanguageSync, useTaskStore } from '@mindwtr/core';
import { buildMacWidgetPayload } from './macos-widget-data';
import { logError, logWarn } from './app-log';
import { isTauriRuntime } from './runtime';
import { invokeNativeOr } from './tauri-invoke';


const MAC_WIDGET_SYNC_DEBOUNCE_MS = 2000;

const isMacOS = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    const src = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
    return src.includes('mac');
};

export const isMacWidgetSyncAvailable = (): boolean => isTauriRuntime() && isMacOS();

const getCurrentLanguage = (): Language => {
    if (typeof localStorage === 'undefined') return 'en';
    return loadStoredLanguageSync(localStorage, getSystemDefaultLanguage());
};

const getSystemIsDark = (): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
        return false;
    }
};


export async function triggerMacWidgetPayloadWrite(data: AppData): Promise<void> {
    if (!isMacWidgetSyncAvailable()) return;
    try {
        const payload = buildMacWidgetPayload(data, getCurrentLanguage(), getSystemIsDark());
        await invokeNativeOr(undefined, 'write_macos_widget_payload', {
            payloadJson: JSON.stringify(payload),
        });
    } catch (error) {
        void logWarn('[MacWidget] Failed to write widget payload', {
            scope: 'macos-widget',
            extra: { error: error instanceof Error ? error.message : String(error) },
        });
        void logError(error, { scope: 'macos-widget' });
    }
}


const buildFullAppData = (): AppData => {
    const { tasks, projects, sections, areas, settings } = useTaskStore.getState();
    const ensureArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
    return {
        tasks: ensureArray<AppData['tasks'][number]>(tasks),
        projects: ensureArray<AppData['projects'][number]>(projects),
        sections: ensureArray<AppData['sections'][number]>(sections),
        areas: ensureArray<AppData['areas'][number]>(areas),
        settings: settings ?? {},
    };
};

export async function triggerMacWidgetSyncFromStore(): Promise<void> {
    if (!isMacWidgetSyncAvailable()) return;
    await triggerMacWidgetPayloadWrite(buildFullAppData());
}

let unsubscribeStore: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;


export function startMacWidgetSync(): () => void {
    if (unsubscribeStore) return stopMacWidgetSync;
    if (!isMacWidgetSyncAvailable()) return () => undefined;

    void triggerMacWidgetSyncFromStore();

    unsubscribeStore = useTaskStore.subscribe((state, prevState) => {
        if (state.lastDataChangeAt === prevState.lastDataChangeAt) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void triggerMacWidgetSyncFromStore();
        }, MAC_WIDGET_SYNC_DEBOUNCE_MS);
    });

    return stopMacWidgetSync;
}

export function stopMacWidgetSync(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    unsubscribeStore?.();
    unsubscribeStore = null;
}
