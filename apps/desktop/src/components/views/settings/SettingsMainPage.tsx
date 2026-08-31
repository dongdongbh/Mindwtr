import type { Language } from '../../../contexts/language-context';
import {
    type GlobalQuickAddShortcutSetting,
    GLOBAL_QUICK_ADD_SHORTCUT_DISABLED,
    getGlobalQuickAddShortcutOptions,
} from '../../../lib/global-quick-add-shortcut';
import { getLocaleCoverageTier, normalizeWeekStartSetting, resolveFeatureFlags, useTaskStore } from '@mindwtr/core';
import type { DesktopThemeMode } from '../../../lib/theme';
import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Switch } from '../../ui/Switch';
import { SettingRow, SettingsCard, SettingsSectionHeader } from './SettingRow';
import { useUiStore } from '../../../store/ui-store';
import { HIDEABLE_SIDEBAR_VIEW_IDS, type HideableSidebarViewId } from '../../../lib/sidebar-views';

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
    navDone: string;
    navArchived: string;
    navTrash: string;
    system: string;
    light: string;
    dark: string;
    eink: string;
    nord: string;
    catppuccinMacchiato: string;
    dracula: string;
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
    themeMode: ThemeMode;
    onThemeChange: (mode: ThemeMode) => void;
    densityMode: DensityMode;
    onDensityChange: (mode: DensityMode) => void;
    textSizeMode: TextSizeMode;
    onTextSizeChange: (mode: TextSizeMode) => void;
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
    keybindingStyle: 'vim' | 'emacs' | 'standard';
    onKeybindingStyleChange: (style: 'vim' | 'emacs' | 'standard') => void;
    globalQuickAddShortcut: GlobalQuickAddShortcutSetting;
    onGlobalQuickAddShortcutChange: (shortcut: GlobalQuickAddShortcutSetting) => void;
    isFlatpak?: boolean;
    undoNotificationsEnabled: boolean;
    onUndoNotificationsChange: (enabled: boolean) => void;
    onOpenHelp: () => void;
    languages: LanguageOption[];
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
    themeMode,
    onThemeChange,
    densityMode,
    onDensityChange,
    textSizeMode,
    onTextSizeChange,
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
    keybindingStyle,
    onKeybindingStyleChange,
    globalQuickAddShortcut,
    onGlobalQuickAddShortcutChange,
    isFlatpak = false,
    undoNotificationsEnabled,
    onUndoNotificationsChange,
    onOpenHelp,
    languages,
    showWindowDecorations = false,
    windowDecorationsEnabled = true,
    onWindowDecorationsChange,
    showCloseBehavior = false,
    closeBehavior = 'ask',
    onCloseBehaviorChange,
    showLaunchAtStartup = false,
    launchAtStartupEnabled = false,
    launchAtStartupLoading = false,
    onLaunchAtStartupChange,
    showTrayToggle = false,
    trayVisible = true,
    onTrayVisibleChange,
}: SettingsMainPageProps) {
    // A <select> takes text, not markup, so the caveat rides the option label itself.
    const languageLabel = (code: string) => {
        const native = languages.find((l) => l.id === code)?.native ?? code;
        return getLocaleCoverageTier(code) === 'partial'
            ? `${native} — ${t.languagePartlyTranslated}`
            : native;
    };
    const hasWindowSection = showWindowDecorations || showCloseBehavior || showLaunchAtStartup || showTrayToggle;
    const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
    const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);
    const globalQuickAddOptions = getGlobalQuickAddShortcutOptions({
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
        done: t.navDone,
        archived: t.navArchived,
        trash: t.navTrash,
    };
    const sidebarViewOptions = HIDEABLE_SIDEBAR_VIEW_IDS
        .filter((id) => id !== 'timeline' || timelineEnabled)
        .map((id) => ({ id, label: sidebarViewLabels[id] }));

    return (
        <div className="space-y-5">
            {/* Look & Feel */}
            <SettingsSectionHeader>{t.lookAndFeel}</SettingsSectionHeader>
            <SettingsCard>
                <SettingRow padded
                    settingsKey="appearance"
                    title={t.appearance}
                    description={`${t.system} / ${t.light} / ${t.dark} / ${t.eink} / ${t.nord} / ${t.catppuccinMacchiato} / ${t.dracula} / ${t.sepia} / ${t.oled}`}
                >
                    <select
                        aria-label={t.appearance}
                        value={themeMode}
                        onChange={(e) => onThemeChange(e.target.value as ThemeMode)}
                        className={selectCls}
                    >
                        <option value="system">{t.system}</option>
                        <option value="light">{t.light}</option>
                        <option value="dark">{t.dark}</option>
                        <option value="eink">{t.eink}</option>
                        <option value="nord">{t.nord}</option>
                        <option value="catppuccin-macchiato">{t.catppuccinMacchiato}</option>
                        <option value="dracula">{t.dracula}</option>
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
                                const visible = !hiddenSidebarViews.includes(view.id);
                                return (
                                    <button
                                        key={view.id}
                                        type="button"
                                        aria-pressed={visible}
                                        onClick={() => setSidebarViewHidden(view.id, visible)}
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
            </SettingsCard>

            {/* Input */}
            <SettingsSectionHeader>{t.input}</SettingsSectionHeader>
            <SettingsCard>
                <SettingRow padded settingsKey="keybindings" title={t.keybindings} description={t.keybindingsDesc}>
                    <select
                        aria-label={t.keybindings}
                        value={keybindingStyle}
                        onChange={(e) => onKeybindingStyleChange(e.target.value as 'vim' | 'emacs' | 'standard')}
                        className={selectCls}
                    >
                        <option value="standard">{t.keybindingStandard}</option>
                        <option value="vim">{t.keybindingVim}</option>
                        <option value="emacs">{t.keybindingEmacs}</option>
                    </select>
                    <button
                        onClick={onOpenHelp}
                        className="text-xs px-2.5 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    >
                        {t.viewShortcuts}
                    </button>
                </SettingRow>
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

            {/* Window Behavior */}
            {hasWindowSection && (
                <>
                    <SettingsSectionHeader>{t.windowBehavior}</SettingsSectionHeader>
                    <SettingsCard>
                        {showWindowDecorations && (
                            <SettingRow padded settingsKey="windowDecorations" title={t.windowDecorations} description={t.windowDecorationsDesc}>
                                <Switch
                                    checked={windowDecorationsEnabled}
                                    aria-label={t.windowDecorations}
                                    onCheckedChange={() => onWindowDecorationsChange?.(!windowDecorationsEnabled)}
                                />
                            </SettingRow>
                        )}
                        {showCloseBehavior && (
                            <SettingRow padded settingsKey="closeBehavior" title={t.closeBehavior} description={t.closeBehaviorDesc}>
                                <select
                                    aria-label={t.closeBehavior}
                                    value={closeBehavior}
                                    onChange={(e) => onCloseBehaviorChange?.(e.target.value as 'ask' | 'tray' | 'quit')}
                                    className={selectCls}
                                >
                                    <option value="ask">{t.closeBehaviorAsk}</option>
                                    <option value="tray">{t.closeBehaviorTray}</option>
                                    <option value="quit">{t.closeBehaviorQuit}</option>
                                </select>
                            </SettingRow>
                        )}
                        {showTrayToggle && (
                            <SettingRow padded settingsKey="showTray" title={t.showTray} description={t.showTrayDesc}>
                                <Switch
                                    checked={trayVisible}
                                    aria-label={t.showTray}
                                    onCheckedChange={() => onTrayVisibleChange?.(!trayVisible)}
                                />
                            </SettingRow>
                        )}
                        {showLaunchAtStartup && (
                            <SettingRow padded settingsKey="launchAtStartup" title={t.launchAtStartup} description={t.launchAtStartupDesc}>
                                <Switch
                                    disabled={launchAtStartupLoading}
                                    checked={launchAtStartupEnabled}
                                    aria-label={t.launchAtStartup}
                                    onCheckedChange={() => onLaunchAtStartupChange?.(!launchAtStartupEnabled)}
                                />
                            </SettingRow>
                        )}
                    </SettingsCard>
                </>
            )}
        </div>
    );
}
