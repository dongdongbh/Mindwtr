import type { AppData, AppSettings, AppTheme } from './types';
import type { StorageAdapter } from './storage';
import { isSupportedLanguage } from './i18n/i18n-constants';
import { normalizeCalendarSystemSetting, normalizeDateFormatSetting, normalizeTimeFormatSetting } from './date';

let runtimeMode: boolean | undefined;
let workspaceTransitionOwner: symbol | null = null;


export function isWorkspaceTransitionActive(): boolean {
    return workspaceTransitionOwner !== null;
}


export function acquireWorkspaceTransitionLock(): (() => void) | null {
    if (workspaceTransitionOwner !== null) return null;
    const owner = Symbol('workspace-transition');
    workspaceTransitionOwner = owner;
    return () => {
        if (workspaceTransitionOwner === owner) workspaceTransitionOwner = null;
    };
}


export function initializeSandboxRuntime(enabled: boolean): void {
    if (runtimeMode !== undefined && runtimeMode !== enabled) {
        throw new Error('Changing workspace requires restarting the app session.');
    }
    runtimeMode = enabled;
}


export function isSandboxMode(): boolean {
    return runtimeMode === true;
}

const themes: readonly AppTheme[] = [
    'light', 'dark', 'system', 'eink', 'nord', 'sepia', 'material3-light',
    'material3-dark', 'oled', 'catppuccin-macchiato', 'dracula', 'gruvbox-light', 'gruvbox-dark',
];


export function pickSandboxDisplaySettings(settings: AppSettings): AppSettings {
    const source = settings && typeof settings === 'object' ? settings : {};
    const result: AppSettings = {};

    if (typeof source.diagnostics?.loggingEnabled === 'boolean') {
        result.diagnostics = { loggingEnabled: source.diagnostics.loggingEnabled };
    }
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


export function createSandboxBootRequest(settings: AppSettings, now = Date.now()): string {
    return JSON.stringify({ version: 1, requestedAt: now, settings: pickSandboxDisplaySettings(settings) });
}


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


const cloneData = (data: AppData): AppData => JSON.parse(JSON.stringify(data)) as AppData;


export function createSandboxStorage(seed: AppData): StorageAdapter {
    let saved = cloneData(seed);
    return {
        getData: async () => cloneData(saved),
        saveData: async (data) => {
            saved = cloneData(data);
        },
    };
}
