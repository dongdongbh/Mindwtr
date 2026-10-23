import type { Language } from '../../../contexts/language-context';
import {
    type GlobalQuickAddShortcutSetting,
    GLOBAL_QUICK_ADD_SHORTCUT_DISABLED,
    getGlobalQuickAddShortcutOptions,
} from '../../../lib/global-quick-add-shortcut';
import { normalizeWeekStartSetting, resolveFeatureFlags, useTaskStore, type TranslateFn } from '@mindwtr/core';
import type { DesktopThemeMode } from '../../../lib/theme';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Switch } from '../../ui/Switch';
import { SettingRow, SettingsCard, SettingsDisclosureCard, SettingsSectionHeader } from './SettingRow';
import { useUiStore } from '../../../store/ui-store';
import { HIDEABLE_SIDEBAR_VIEW_IDS, type HideableSidebarViewId } from '../../../lib/sidebar-views';
import { canListInstalledFonts, loadInstalledFontFamilies } from '../../../lib/font-family';
import { AutocompleteTextInput } from '../../ui/AutocompleteTextInput';

const FLATPAK_QUICK_ADD_COMMAND = 'flatpak run tech.dongdongbh.mindwtr --quick-add';

type ThemeMode = DesktopThemeMode;
type DensityMode = 'comfortable' | 'compact' | 'condensed';
type TextSizeMode = 'small' | 'default' | 'large' | 'extra-large';
type WeekStart = 'system' | 'sunday' | 'monday' | 'saturday';
type DateFormatSetting = 'system' | 'dmy' | 'mdy' | 'ymd';
type CalendarSystemSetting = 'gregorian' | 'jalali';
type TimeFormatSetting = 'system' | '12h' | '24h';

type Labels = {
    lookAndFeel: string;
    localization: string;
    regionalFormats: string;
    input: string;
    windowBehavior: string;
    appearance: string;
    density: string;
    densityDesc: string;
    densityComfortable: string;
    densityCompact: string;
    densityCondensed: string;
    textSize: string;
    textSizeDesc: string;
    textSizeSmall: string;
    textSizeDefault: string;
    textSizeLarge: string;
    textSizeExtraLarge: string;
    fontFamily: string;
    fontFamilyDesc: string;
    fontFamilyDefault: string;
    fontFamilyPlaceholder: string;
    showTaskAge: string;
    showTaskAgeDesc: string;
    sidebarViews: string;
    sidebarViewsDesc: string;
    navAgenda: string;
    navSomeday: string;
    navWaiting: string;
    navReference: string;
    navCalendar: string;
    navReview: string;
    navContexts: string;
    navBoard: string;
    navTimeline: string;
    navHistory: string;
    navTrash: string;
    system: string;
    light: string;
    dark: string;
    eink: string;
    nord: string;
    catppuccinMacchiato: string;
    dracula: string;
    gruvboxLight: string;
    gruvboxDark: string;
    sepia: string;
    oled: string;
    language: string;
    languagePartlyTranslated: string;
    weekStart: string;
    weekStartSunday: string;
    weekStartMonday: string;
    weekStartSaturday: string;
    weekStartSystem: string;
    dateFormat: string;
    dateFormatSystem: string;
    dateFormatDmy: string;
    dateFormatMdy: string;
    dateFormatYmd: string;
    calendarSystem: string;
    calendarSystemGregorian: string;
    calendarSystemJalali: string;
    timeFormat: string;
    timeFormatSystem: string;
    timeFormat12h: string;
    timeFormat24h: string;
    keybindings: string;
    keybindingsDesc: string;
    undoNotifications: string;
    undoNotificationsDesc: string;
    globalQuickAddShortcut: string;
    globalQuickAddShortcutDesc: string;
    globalQuickAddFlatpakDesc: string;
    globalQuickAddFlatpakCommand: string;
    globalQuickAddFlatpakCommandDesc: string;
    keybindingStandard: string;
    keybindingVim: string;
    keybindingEmacs: string;
    viewShortcuts: string;
    windowDecorations: string;
    windowDecorationsDesc: string;
    closeBehavior: string;
    closeBehaviorDesc: string;
    closeBehaviorAsk: string;
    closeBehaviorTray: string;
    closeBehaviorQuit: string;
    launchAtStartup: string;
    launchAtStartupDesc: string;
    showTray: string;
    showTrayDesc: string;
};

type LanguageOption = { id: Language; native: string };

export type SettingsMainPageProps = {
    t: Labels;
    translate: TranslateFn;
    themeMode: ThemeMode;
    onThemeChange: (mode: ThemeMode) => void;
    densityMode: DensityMode;
    onDensityChange: (mode: DensityMode) => void;
    textSizeMode: TextSizeMode;
    onTextSizeChange: (mode: TextSizeMode) => void;
    /** '' = app default, else an installed family name. */
    fontFamily: string;
    onFontFamilyChange: (value: string) => void;
    showTaskAge: boolean;
    onShowTaskAgeChange: (enabled: boolean) => void;
    language: Language;
    onLanguageChange: (lang: Language) => void;
    weekStart: WeekStart;
    onWeekStartChange: (weekStart: WeekStart) => void;
    dateFormat: DateFormatSetting;
    onDateFormatChange: (format: DateFormatSetting) => void;
    calendarSystem: CalendarSystemSetting;
    showCalendarSystem: boolean;
    onCalendarSystemChange: (calendarSystem: CalendarSystemSetting) => void;
    timeFormat: TimeFormatSetting;
    onTimeFormatChange: (format: TimeFormatSetting) => void;
    globalQuickAddShortcut: GlobalQuickAddShortcutSetting;
    onGlobalQuickAddShortcutChange: (shortcut: GlobalQuickAddShortcutSetting) => void;
    isFlatpak?: boolean;
    undoNotificationsEnabled: boolean;
    onUndoNotificationsChange: (enabled: boolean) => void;
    languages: LanguageOption[];
};

export type SettingsKeyboardWindowProps = {
    onOpenHelp: () => void;
    keybindingStyle: 'vim' | 'emacs' | 'standard';
    onKeybindingStyleChange: (style: 'vim' | 'emacs' | 'standard') => void;
    showWindowDecorations?: boolean;
    windowDecorationsEnabled?: boolean;
    onWindowDecorationsChange?: (enabled: boolean) => void;
    showCloseBehavior?: boolean;
    closeBehavior?: 'ask' | 'tray' | 'quit';
    onCloseBehaviorChange?: (behavior: 'ask' | 'tray' | 'quit') => void;
    showLaunchAtStartup?: boolean;
    launchAtStartupEnabled?: boolean;
    launchAtStartupLoading?: boolean;
    onLaunchAtStartupChange?: (enabled: boolean) => void;
    showTrayToggle?: boolean;
    trayVisible?: boolean;
    onTrayVisibleChange?: (visible: boolean) => void;
};

const selectCls =
    "text-[13px] bg-muted/50 text-foreground border border-border rounded-md px-2.5 py-1.5 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40";

export function SettingsMainPage({
    t,
    translate,
    themeMode,
    onThemeChange,
    densityMode,
    onDensityChange,
    textSizeMode,
    onTextSizeChange,
    fontFamily,
    onFontFamilyChange,
    showTaskAge,
    onShowTaskAgeChange,
    language,
    onLanguageChange,
    weekStart,
    onWeekStartChange,
    dateFormat,
    onDateFormatChange,
    calendarSystem,
    showCalendarSystem,
    onCalendarSystemChange,
    timeFormat,
    onTimeFormatChange,
    globalQuickAddShortcut,
    onGlobalQuickAddShortcutChange,
    isFlatpak = false,
    undoNotificationsEnabled,
    onUndoNotificationsChange,
    languages,
}: SettingsMainPageProps) {
    const languageLabel = (code: string) => languages.find((l) => l.id === code)?.native ?? code;
    const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
    const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);
    const globalQuickAddOptions = getGlobalQuickAddShortcutOptions(translate, {
        isFlatpak,
        isMac,
        isWindows,
    });
    const quickAddShortcutValue = isFlatpak ? GLOBAL_QUICK_ADD_SHORTCUT_DISABLED : globalQuickAddShortcut;
    const weekStartDescription = weekStart === 'monday'
        ? t.weekStartMonday
        : weekStart === 'saturday'
            ? t.weekStartSaturday
            : weekStart === 'sunday'
                ? t.weekStartSunday
                : t.weekStartSystem;

    const [sidebarViewsOpen, setSidebarViewsOpen] = useState(false);
    const [regionalFormatsOpen, setRegionalFormatsOpen] = useState(false);
    const hiddenSidebarViews = useUiStore((state) => state.hiddenSidebarViews);
    const setSidebarViewHidden = useUiStore((state) => state.setSidebarViewHidden);
    const timelineEnabled = useTaskStore((state) => resolveFeatureFlags(state.settings).timeline);
    const sidebarViewLabels: Record<HideableSidebarViewId, string> = {
        agenda: t.navAgenda,
        someday: t.navSomeday,
        waiting: t.navWaiting,
        reference: t.navReference,
        calendar: t.navCalendar,
        review: t.navReview,
        contexts: t.navContexts,
        board: t.navBoard,
        timeline: t.navTimeline,
        done: t.navHistory,
        archived: t.navHistory,
        trash: t.navTrash,
    };
    // The sidebar shows Done and Archived as one History entry and hides it only
    // when both ids are hidden (Layout.tsx), so the roster offers one History
    // toggle that writes both. The stored ids are unchanged.
    const sidebarViewOptions = HIDEABLE_SIDEBAR_VIEW_IDS
        .filter((id) => (id !== 'timeline' || timelineEnabled) && id !== 'archived')
        .map((id) => ({
            ids: (id === 'done' ? ['done', 'archived'] : [id]) as HideableSidebarViewId[],
            label: sidebarViewLabels[id],
        }));

    return (
        <div className="space-y-5">
            {/* Look & Feel */}
            <SettingsSectionHeader>{t.lookAndFeel}</SettingsSectionHeader>
            <SettingsCard>
                <SettingRow padded
                    settingsKey="appearance"
                    title={t.appearance}
                    description={`${t.system} / ${t.system} (${t.light} / OLED ${t.dark}) / ${t.light} / ${t.dark} / ${t.eink} / ${t.nord} / ${t.catppuccinMacchiato} / ${t.dracula} / ${t.gruvboxLight} / ${t.gruvboxDark} / ${t.sepia} / ${t.oled}`}
                >
                    <select
                        aria-label={t.appearance}
                        value={themeMode}
                        onChange={(e) => onThemeChange(e.target.value as ThemeMode)}
                        className={selectCls}
                    >
                        <option value="system">{t.system}</option>
                        <option value="system-oled">{t.system} ({t.light} / OLED {t.dark})</option>
                        <option value="light">{t.light}</option>
                        <option value="dark">{t.dark}</option>
                        <option value="eink">{t.eink}</option>
                        <option value="nord">{t.nord}</option>
                        <option value="catppuccin-macchiato">{t.catppuccinMacchiato}</option>
                        <option value="dracula">{t.dracula}</option>
                        <option value="gruvbox-light">{t.gruvboxLight}</option>
                        <option value="gruvbox-dark">{t.gruvboxDark}</option>
                        <option value="sepia">{t.sepia}</option>
                        <option value="oled">{t.oled}</option>
                    </select>
                </SettingRow>
                <SettingRow padded settingsKey="density" title={t.density} description={t.densityDesc}>
                    <select
                        aria-label={t.density}
                        value={densityMode}
                        onChange={(e) => onDensityChange(e.target.value as DensityMode)}
                        className={selectCls}
                    >
                        <option value="comfortable">{t.densityComfortable}</option>
                        <option value="compact">{t.densityCompact}</option>
                        <option value="condensed">{t.densityCondensed}</option>
                    </select>
                </SettingRow>
                <SettingRow padded settingsKey="textSize" title={t.textSize} description={t.textSizeDesc}>
                    <select
                        aria-label={t.textSize}
                        value={textSizeMode}
                        onChange={(e) => onTextSizeChange(e.target.value as TextSizeMode)}
                        className={selectCls}
                    >
                        <option value="small">{t.textSizeSmall}</option>
                        <option value="default">{t.textSizeDefault}</option>
                        <option value="large">{t.textSizeLarge}</option>
                        <option value="extra-large">{t.textSizeExtraLarge}</option>
                    </select>
                </SettingRow>
                <SettingRow padded settingsKey="fontFamily" title={t.fontFamily} description={t.fontFamilyDesc}>
                    <FontFamilyControl t={t} value={fontFamily} onChange={onFontFamilyChange} />
                </SettingRow>
                <SettingRow padded settingsKey="showTaskAge" title={t.showTaskAge} description={t.showTaskAgeDesc}>
                    <Switch
                        checked={showTaskAge}
                        aria-label={t.showTaskAge}
                        onCheckedChange={() => onShowTaskAgeChange(!showTaskAge)}
                    />
                </SettingRow>
            {/* Folded by default: the roster is a one-time customization, not a
                daily control, and a dozen always-open toggles would dominate the card. */}
            <div data-settings-key="sidebarViews" className="p-4 flex flex-col gap-3">
                    <button
                        type="button"
                        aria-expanded={sidebarViewsOpen}
                        onClick={() => setSidebarViewsOpen((prev) => !prev)}
                        className="flex w-full items-center justify-between gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-md"
                    >
                        <span>
                            <span className="block font-medium">{t.sidebarViews}</span>
                            <span className="block text-sm text-muted-foreground">{t.sidebarViewsDesc}</span>
                        </span>
                        <ChevronDown
                            className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', sidebarViewsOpen && 'rotate-180')}
                            aria-hidden="true"
                        />
                    </button>
                    {sidebarViewsOpen && (
                        <div className="flex flex-wrap gap-2">
                            {sidebarViewOptions.map((view) => {
                                const visible = !view.ids.every((id) => hiddenSidebarViews.includes(id));
                                return (
                                    <button
                                        key={view.ids.join('+')}
                                        type="button"
                                        aria-pressed={visible}
                                        onClick={() => view.ids.forEach((id) => setSidebarViewHidden(id, visible))}
                                        className={cn(
                                            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors',
                                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                                            visible
                                                ? 'border-primary/40 bg-primary/10 text-primary'
                                                : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
                                        )}
                                    >
                                        {visible && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                                        <span className="truncate">{view.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </SettingsCard>

            {/* Localization */}
            <SettingsSectionHeader>{t.localization}</SettingsSectionHeader>
            <SettingsCard>
                <SettingRow padded
                    settingsKey="language"
                    title={t.language}
                    description={languageLabel(language)}
                >
                    <select
                        aria-label={t.language}
                        value={language}
                        onChange={(e) => onLanguageChange(e.target.value as Language)}
                        className={selectCls}
                    >
                        {languages.map((lang) => (
                            <option key={lang.id} value={lang.id}>
                                {languageLabel(lang.id)}
                            </option>
                        ))}
                    </select>
                </SettingRow>
            </SettingsCard>
            <SettingsDisclosureCard
                sectionKey="regionalFormats"
                settingsKey={null}
                title={t.regionalFormats}
                hint={`${weekStartDescription} · ${dateFormat === 'system' ? t.dateFormatSystem : dateFormat === 'dmy' ? t.dateFormatDmy : dateFormat === 'mdy' ? t.dateFormatMdy : t.dateFormatYmd} · ${timeFormat === 'system' ? t.timeFormatSystem : timeFormat === '12h' ? t.timeFormat12h : t.timeFormat24h}`}
                open={regionalFormatsOpen}
                onToggle={() => setRegionalFormatsOpen((open) => !open)}
            >
                <SettingRow padded
                    settingsKey="weekStart"
                    title={t.weekStart}
                    description={weekStartDescription}
                >
                    <select
                        aria-label={t.weekStart}
                        value={weekStart}
                        onChange={(e) => onWeekStartChange(e.target.value as WeekStart)}
                        className={selectCls}
                    >
                        {/* Both "System default" labels show what they resolve to:
                            the runtime locale decides, which on a customized OS can
                            differ from the OS setting (#1006). */}
                        <option value="system">{`${t.weekStartSystem} (${normalizeWeekStartSetting('system') === 'monday' ? t.weekStartMonday : normalizeWeekStartSetting('system') === 'saturday' ? t.weekStartSaturday : t.weekStartSunday})`}</option>
                        <option value="sunday">{t.weekStartSunday}</option>
                        <option value="monday">{t.weekStartMonday}</option>
                        <option value="saturday">{t.weekStartSaturday}</option>
                    </select>
                </SettingRow>
                <SettingRow padded
                    settingsKey="dateFormat"
                    title={t.dateFormat}
                    description={
                        dateFormat === 'dmy'
                            ? t.dateFormatDmy
                            : dateFormat === 'mdy'
                                ? t.dateFormatMdy
                                : dateFormat === 'ymd'
                                    ? t.dateFormatYmd
                                : t.dateFormatSystem
                    }
                >
                    <select
                        aria-label={t.dateFormat}
                        value={dateFormat}
                        onChange={(e) => onDateFormatChange(e.target.value as DateFormatSetting)}
                        className={selectCls}
                    >
                        {/* Show what "System default" resolves to — the runtime
                            locale's short date, which on a customized OS can
                            differ from the OS format (#1006). */}
                        <option value="system">{`${t.dateFormatSystem} (${new Date().toLocaleDateString()})`}</option>
                        <option value="dmy">{t.dateFormatDmy}</option>
                        <option value="mdy">{t.dateFormatMdy}</option>
                        <option value="ymd">{t.dateFormatYmd}</option>
                    </select>
                </SettingRow>
                {showCalendarSystem && (
                    <SettingRow padded
                        settingsKey="calendarSystem"
                        title={t.calendarSystem}
                        description={
                            calendarSystem === 'jalali'
                                ? t.calendarSystemJalali
                                : t.calendarSystemGregorian
                        }
                    >
                        <select
                            aria-label={t.calendarSystem}
                            value={calendarSystem}
                            onChange={(e) => onCalendarSystemChange(e.target.value as CalendarSystemSetting)}
                            className={selectCls}
                        >
                            <option value="gregorian">{t.calendarSystemGregorian}</option>
                            <option value="jalali">{t.calendarSystemJalali}</option>
                        </select>
                    </SettingRow>
                )}
                <SettingRow padded
                    settingsKey="timeFormat"
                    title={t.timeFormat}
                    description={
                        timeFormat === '12h'
                            ? t.timeFormat12h
                            : timeFormat === '24h'
                                ? t.timeFormat24h
                                : t.timeFormatSystem
                    }
                >
                    <select
                        aria-label={t.timeFormat}
                        value={timeFormat}
                        onChange={(e) => onTimeFormatChange(e.target.value as TimeFormatSetting)}
                        className={selectCls}
                    >
                        <option value="system">{t.timeFormatSystem}</option>
                        <option value="12h">{t.timeFormat12h}</option>
                        <option value="24h">{t.timeFormat24h}</option>
                    </select>
                </SettingRow>
            </SettingsDisclosureCard>

            {/* Input */}
            <SettingsSectionHeader>{t.input}</SettingsSectionHeader>
            <SettingsCard>
                <SettingRow padded
                    settingsKey="globalQuickAddShortcut"
                    title={t.globalQuickAddShortcut}
                    description={isFlatpak ? t.globalQuickAddFlatpakDesc : t.globalQuickAddShortcutDesc}
                >
                    <select
                        aria-label={t.globalQuickAddShortcut}
                        disabled={isFlatpak}
                        value={quickAddShortcutValue}
                        onChange={(e) => onGlobalQuickAddShortcutChange(e.target.value as GlobalQuickAddShortcutSetting)}
                        className={`${selectCls} ${isFlatpak ? 'cursor-not-allowed opacity-70' : ''}`}
                    >
                        {globalQuickAddOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </SettingRow>
                {isFlatpak && (
                    <div className="px-4 py-3">
                        <div className="text-[13px] font-medium">{t.globalQuickAddFlatpakCommand}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{t.globalQuickAddFlatpakCommandDesc}</div>
                        <code className="mt-2 block break-all rounded-md border border-border bg-muted/50 px-2.5 py-2 text-xs text-foreground select-all">
                            {FLATPAK_QUICK_ADD_COMMAND}
                        </code>
                    </div>
                )}
                <SettingRow padded settingsKey="undoNotifications" title={t.undoNotifications} description={t.undoNotificationsDesc}>
                    <Switch
                        checked={undoNotificationsEnabled}
                        aria-label={t.undoNotifications}
                        onCheckedChange={() => onUndoNotificationsChange(!undoNotificationsEnabled)}
                    />
                </SettingRow>
            </SettingsCard>
        </div>
    );
}

// A combobox over the fonts installed on this computer, listed by the desktop
// shell (no browser permission involved). Focusing clears the field so the whole
// list opens at once (the current font stays visible as the placeholder); typing
// narrows it; an exact pick applies; leaving without a pick restores the value.
// "App default" is the first entry and already resolves to the OS interface font
// on every platform. The plain web build has no native list, so there the field
// takes a typed name as-is (#1244).
function FontFamilyControl({
    t,
    value,
    onChange,
}: {
    t: Labels;
    value: string;
    onChange: (value: string) => void;
}) {
    const [installedFonts, setInstalledFonts] = useState<string[] | null>(null);
    const [draft, setDraft] = useState(value);
    const pendingListFocus = useRef(false);
    useEffect(() => {
        setDraft(value);
    }, [value]);
    useEffect(() => {
        if (!canListInstalledFonts()) {
            setInstalledFonts([]);
            return;
        }
        let active = true;
        void loadInstalledFontFamilies().then((families) => {
            if (!active) return;
            setInstalledFonts(families);
            if (pendingListFocus.current && families.length > 0) setDraft('');
            pendingListFocus.current = false;
        });
        return () => {
            active = false;
        };
    }, []);

    const hasList = (installedFonts?.length ?? 0) > 0;
    const defaultLabel = t.fontFamilyDefault;
    const findInstalled = (name: string) => {
        const key = name.trim().toLowerCase();
        return installedFonts?.find((family) => family.toLowerCase() === key) ?? null;
    };
    const handleChange = (next: string) => {
        pendingListFocus.current = false;
        if (hasList && next === defaultLabel) {
            setDraft('');
            if (value !== '') onChange('');
            return;
        }
        setDraft(next);
        const installed = hasList ? findInstalled(next) : null;
        if (installed && installed !== value) onChange(installed);
    };
    const commitDraft = () => {
        const trimmed = draft.trim();
        if (!hasList) {
            if (trimmed !== value) onChange(trimmed);
            return;
        }
        const installed = trimmed ? findInstalled(trimmed) : null;
        if (installed && installed !== value) onChange(installed);
        else setDraft(value);
    };
    const previewFamily = (draft.trim() || value).replace(/"/g, '');

    return (
        <div className="w-56">
            <AutocompleteTextInput
                aria-label={t.fontFamily}
                placeholder={hasList ? (value || defaultLabel) : t.fontFamilyPlaceholder}
                value={draft}
                onChange={handleChange}
                suggestions={hasList ? [defaultLabel, ...(installedFonts ?? [])] : []}
                maxSuggestions={(installedFonts?.length ?? 0) + 1}
                showAllWhenEmpty
                style={previewFamily ? { fontFamily: `"${previewFamily}", ui-sans-serif, sans-serif` } : undefined}
                onFocus={() => {
                    if (hasList) {
                        setDraft('');
                    } else {
                        pendingListFocus.current = installedFonts === null && canListInstalledFonts();
                    }
                }}
                onBlur={() => {
                    pendingListFocus.current = false;
                    commitDraft();
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        commitDraft();
                    }
                }}
                className={cn(selectCls, 'w-full')}
            />
        </div>
    );
}
