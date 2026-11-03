import { formatI18nTemplate, type TranslateFn } from '@mindwtr/core';
import { invokeNative } from './tauri-invoke';

export const GLOBAL_QUICK_ADD_SHORTCUT_DISABLED = 'disabled';
export const GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT = 'Control+Alt+M';
export const GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N = 'Control+Alt+N';
export const GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q = 'Control+Alt+Q';
export const GLOBAL_QUICK_ADD_SHORTCUT_LEGACY = 'CommandOrControl+Shift+A';

export type GlobalQuickAddShortcutSetting =
    | typeof GLOBAL_QUICK_ADD_SHORTCUT_DISABLED
    | typeof GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT
    | typeof GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N
    | typeof GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q
    | typeof GLOBAL_QUICK_ADD_SHORTCUT_LEGACY;

type ShortcutOption = {
    value: GlobalQuickAddShortcutSetting;
    label: string;
};

type GlobalQuickAddShortcutPlatform = {
    isFlatpak?: boolean;
    isMac?: boolean;
    isWindows?: boolean;
};

const ALLOWED_SHORTCUTS = new Set<GlobalQuickAddShortcutSetting>([
    GLOBAL_QUICK_ADD_SHORTCUT_DISABLED,
    GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT,
    GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N,
    GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q,
    GLOBAL_QUICK_ADD_SHORTCUT_LEGACY,
]);

export function getDefaultGlobalQuickAddShortcut(
    platform: GlobalQuickAddShortcutPlatform = {}
): GlobalQuickAddShortcutSetting {
    if (platform.isWindows || platform.isFlatpak) {
        return GLOBAL_QUICK_ADD_SHORTCUT_DISABLED;
    }
    return GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT;
}

export function normalizeGlobalQuickAddShortcut(
    value?: string | null,
    platform: GlobalQuickAddShortcutPlatform = {}
): GlobalQuickAddShortcutSetting {
    const defaultShortcut = getDefaultGlobalQuickAddShortcut(platform);
    if (!value) return defaultShortcut;
    if (ALLOWED_SHORTCUTS.has(value as GlobalQuickAddShortcutSetting)) {
        return value as GlobalQuickAddShortcutSetting;
    }
    return defaultShortcut;
}

export function getGlobalQuickAddShortcutOptions(
    t: TranslateFn,
    platform: GlobalQuickAddShortcutPlatform = {}
): ShortcutOption[] {
    const isFlatpak = platform.isFlatpak === true;
    const isMac = platform.isMac === true;
    const isWindows = platform.isWindows === true;
    const defaultShortcut = getDefaultGlobalQuickAddShortcut(platform);
    const legacyLabel = isMac ? 'Cmd+Shift+A' : 'Ctrl+Shift+A';


    const legacyLabelTemplate = defaultShortcut === GLOBAL_QUICK_ADD_SHORTCUT_LEGACY
        ? t('settings.globalQuickAddShortcutRecommended')
        : t('settings.globalQuickAddShortcutLegacy');
    const disabledLabel = isWindows
        ? t('settings.globalQuickAddShortcutDisabledDefault')
        : isFlatpak
            ? t('settings.globalQuickAddShortcutDisabledFlatpakDefault')
        : defaultShortcut === GLOBAL_QUICK_ADD_SHORTCUT_DISABLED
            ? formatI18nTemplate(t('settings.globalQuickAddShortcutRecommended'), { shortcut: t('settings.globalQuickAddShortcutDisabled') })
            : t('settings.globalQuickAddShortcutDisabled');

    return [
        {
            value: GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT,


            label:
                defaultShortcut === GLOBAL_QUICK_ADD_SHORTCUT_DEFAULT || isWindows
                    ? formatI18nTemplate(t('settings.globalQuickAddShortcutRecommended'), { shortcut: isMac ? 'Ctrl+Option+M' : 'Ctrl+Alt+M' })
                    : isMac ? 'Ctrl+Option+M' : 'Ctrl+Alt+M',
        },
        {
            value: GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N,
            label: isMac ? 'Ctrl+Option+N' : 'Ctrl+Alt+N',
        },
        {
            value: GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q,
            label: isMac ? 'Ctrl+Option+Q' : 'Ctrl+Alt+Q',
        },
        {
            value: GLOBAL_QUICK_ADD_SHORTCUT_LEGACY,
            label: formatI18nTemplate(legacyLabelTemplate, { shortcut: legacyLabel }),
        },
        {
            value: GLOBAL_QUICK_ADD_SHORTCUT_DISABLED,
            label: disabledLabel,
        },
    ];
}

export function formatGlobalQuickAddShortcutForDisplay(
    shortcut: GlobalQuickAddShortcutSetting,
    isMac: boolean,
    t: TranslateFn
): string {
    if (shortcut === GLOBAL_QUICK_ADD_SHORTCUT_DISABLED) {
        return t('settings.globalQuickAddShortcutDisabled');
    }
    if (shortcut === GLOBAL_QUICK_ADD_SHORTCUT_LEGACY) {
        return isMac ? 'Cmd+Shift+A' : 'Ctrl+Shift+A';
    }
    if (shortcut === GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N) {
        return isMac ? 'Ctrl+Option+N' : 'Ctrl+Alt+N';
    }
    if (shortcut === GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q) {
        return isMac ? 'Ctrl+Option+Q' : 'Ctrl+Alt+Q';
    }
    return isMac ? 'Ctrl+Option+M' : 'Ctrl+Alt+M';
}


export type GlobalQuickAddShortcutApplyResult = {
    shortcut?: string | null;
    warning?: string | null;
};


export const applyGlobalQuickAddShortcut = (
    shortcut: GlobalQuickAddShortcutSetting,
): Promise<GlobalQuickAddShortcutApplyResult> => (
    invokeNative<GlobalQuickAddShortcutApplyResult>('set_global_quick_add_shortcut', { shortcut })
);

export function matchesGlobalQuickAddShortcut(
    event: KeyboardEvent,
    shortcut: GlobalQuickAddShortcutSetting
): boolean {
    if (shortcut === GLOBAL_QUICK_ADD_SHORTCUT_DISABLED) {
        return false;
    }
    if (shortcut === GLOBAL_QUICK_ADD_SHORTCUT_LEGACY) {
        return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyA';
    }
    if (shortcut === GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_N) {
        return event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey && event.code === 'KeyN';
    }
    if (shortcut === GLOBAL_QUICK_ADD_SHORTCUT_ALTERNATE_Q) {
        return event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey && event.code === 'KeyQ';
    }
    return event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey && event.code === 'KeyM';
}
