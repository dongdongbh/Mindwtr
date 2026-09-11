import type { AppData, AppSettings, AppTheme } from './types';
import type { StorageAdapter } from './storage';
import { isSupportedLanguage } from './i18n/i18n-constants';
import { normalizeCalendarSystemSetting, normalizeDateFormatSetting, normalizeTimeFormatSetting } from './date';

let runtimeMode: boolean | undefined;
let workspaceTransitionOwner: symbol | null = null;

/** Stop new foreground sync admission while the owner drains existing work and reloads. */
export function isWorkspaceTransitionActive(): boolean {
    return workspaceTransitionOwner !== null;
}

/**
 * Exclusive, runtime-only handoff. Keep the lease through a successful reload;
 * release it when entry fails so normal personal work can resume. Existing
 * writes and admitted sync cycles must still be drained by the platform.
 */
export function acquireWorkspaceTransitionLock(): (() => void) | null {
    if (workspaceTransitionOwner !== null) return null;
    const owner = Symbol('workspace-transition');
    workspaceTransitionOwner = owner;
    return () => {
        if (workspaceTransitionOwner === owner) workspaceTransitionOwner = null;
    };
}

/** Select the workspace before hydration. A workspace change requires a fresh JS runtime. */
export function initializeSandboxRuntime(enabled: boolean): void {
    if (runtimeMode !== undefined && runtimeMode !== enabled) {
        throw new Error('Changing workspace requires restarting the app session.');
    }
    runtimeMode = enabled;
}

/** Headless/native capture runtimes that do not initialize a sandbox remain personal. */
export function isSandboxMode(): boolean {
    return runtimeMode === true;
}

const themes: readonly AppTheme[] = [
    'light', 'dark', 'system', 'eink', 'nord', 'sepia', 'material3-light',
    'material3-dark', 'oled', 'catppuccin-macchiato', 'dracula',
];

/** Do not spread personal settings: they include credentials, custom labels and external paths. */
export function pickSandboxDisplaySettings(settings: AppSettings): AppSettings {
    const source = settings && typeof settings === 'object' ? settings : {};
    const result: AppSettings = {};
    if (source.language === 'system' || isSupportedLanguage(source.language)) result.language = source.language;
    if (themes.includes(source.theme as AppTheme)) result.theme = source.theme;
    if (typeof source.dateFormat === 'string') result.dateFormat = normalizeDateFormatSetting(source.dateFormat);
    if (typeof source.calendarSystem === 'string') result.calendarSystem = normalizeCalendarSystemSetting(source.calendarSystem);
    if (typeof source.timeFormat === 'string') result.timeFormat = normalizeTimeFormatSetting(source.timeFormat);
    const appearance = source.appearance;
    if (appearance && typeof appearance === 'object') {
        const display: NonNullable<AppSettings['appearance']> = {};
        if (appearance.density === 'comfortable' || appearance.density === 'compact' || appearance.density === 'condensed') {
            display.density = appearance.density;
        }
        if (appearance.textSize === 'small' || appearance.textSize === 'default' || appearance.textSize === 'large' || appearance.textSize === 'extra-large') {
            display.textSize = appearance.textSize;
        }
        if (typeof appearance.showTaskAge === 'boolean') display.showTaskAge = appearance.showTaskAge;
        if (typeof appearance.showFutureStarts === 'boolean') display.showFutureStarts = appearance.showFutureStarts;
        if (Object.keys(display).length > 0) result.appearance = display;
    }
    return result;
}

const BOOT_REQUEST_MAX_AGE_MS = 60_000;

/** One-shot handoff to the next app runtime, containing display preferences only. */
export function createSandboxBootRequest(settings: AppSettings, now = Date.now()): string {
    return JSON.stringify({ version: 1, requestedAt: now, settings: pickSandboxDisplaySettings(settings) });
}

/** Callers must remove the stored request before parsing/booting. Stale requests cannot reopen a sandbox. */
export function parseSandboxBootRequest(raw: string | null | undefined, now = Date.now()): AppSettings | null {
    if (!raw || raw.length > 4096) return null;
    try {
        const request = JSON.parse(raw);
        if (!request || request.version !== 1 || typeof request.requestedAt !== 'number') return null;
        const age = now - request.requestedAt;
        if (!Number.isFinite(age) || age < 0 || age > BOOT_REQUEST_MAX_AGE_MS) return null;
        if (!request.settings || typeof request.settings !== 'object' || Array.isArray(request.settings)) return null;
        return pickSandboxDisplaySettings(request.settings);
    } catch {
        return null;
    }
}

// AppData is JSON-shaped. Returning independent objects prevents live-store edits from
// modifying persisted snapshots, and keeps reset fixtures independent from every session.
const cloneData = (data: AppData): AppData => JSON.parse(JSON.stringify(data)) as AppData;

/** A disposable workspace with no filesystem, native bridge, network, or fallback storage. */
export function createSandboxStorage(seed: AppData): StorageAdapter {
    let saved = cloneData(seed);
    return {
        getData: async () => cloneData(saved),
        saveData: async (data) => {
            saved = cloneData(data);
        },
    };
}
