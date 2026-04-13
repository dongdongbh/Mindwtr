import type { AppData } from '@mindwtr/core';

export type DesktopTextSizeMode = NonNullable<NonNullable<AppData['settings']['appearance']>['textSize']>;

export const TEXT_SIZE_STORAGE_KEY = 'mindwtr-text-size';
export const DEFAULT_DESKTOP_TEXT_SIZE_MODE: DesktopTextSizeMode = 'default';

const TEXT_SCALE_BY_MODE: Record<DesktopTextSizeMode, string> = {
    default: '1',
    large: '1.125',
    'extra-large': '1.25',
};

export function coerceDesktopTextSize(value: string | null | undefined): DesktopTextSizeMode {
    if (value === 'default' || value === 'large' || value === 'extra-large') {
        return value;
    }
    return DEFAULT_DESKTOP_TEXT_SIZE_MODE;
}

export function applyDesktopTextSize(mode: DesktopTextSizeMode): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.dataset.textSize = mode;
    root.style.setProperty('--mindwtr-text-scale', TEXT_SCALE_BY_MODE[mode]);
}
