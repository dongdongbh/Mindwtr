import type { Language } from '../../../contexts/language-context';
import {
    type GlobalQuickAddShortcutSetting,
    getGlobalQuickAddShortcutOptions,
} from '../../../lib/global-quick-add-shortcut';

type ThemeMode = 'system' | 'light' | 'dark' | 'eink' | 'nord' | 'sepia';
type DensityMode = 'comfortable' | 'compact';
type TextSizeMode = 'default' | 'large' | 'extra-large';
type WeekStart = 'sunday' | 'monday';
type DateFormatSetting = 'system' | 'dmy' | 'mdy' | 'ymd';
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
    textSize: string;
    textSizeDesc: string;
    textSizeDefault: string;
    textSizeLarge: string;
    textSizeExtraLarge: string;
    system: string;
    light: string;
    dark: string;
    eink: string;
    nord: string;
    sepia: string;
    language: string;
    weekStart: string;
    weekStartSunday: string;
    weekStartMonday: string;
    dateFormat: string;
    dateFormatSystem: string;
    dateFormatDmy: string;
    dateFormatMdy: string;
    dateFormatYmd: string;
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
    language: Language;
    onLanguageChange: (lang: Language) => void;
    weekStart: WeekStart;
    onWeekStartChange: (weekStart: WeekStart) => void;
    dateFormat: DateFormatSetting;
    onDateFormatChange: (format: DateFormatSetting) => void;
    timeFormat: TimeFormatSetting;
    onTimeFormatChange: (format: TimeFormatSetting) => void;
    keybindingStyle: 'vim' | 'emacs';
    onKeybindingStyleChange: (style: 'vim' | 'emacs') => void;
    globalQuickAddShortcut: GlobalQuickAddShortcutSetting;
    onGlobalQuickAddShortcutChange: (shortcut: GlobalQuickAddShortcutSetting) => void;
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
    showTrayToggle?: boolean;
    trayVisible?: boolean;
    onTrayVisibleChange?: (visible: boolean) => void;
};

const selectCls =
    "text-[13px] bg-muted/50 text-foreground border border-border rounded-md px-2.5 py-1.5 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40";

function SectionHeader({ children }: { children: React.ReactNode }) {
    return (
        <h3 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            {children}
        </h3>
    );
}

function SettingsRow({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
    return (
        <div className="px-4 py-3 flex items-center justify-between gap-6">
            <div className="min-w-0">
                <div className="text-[13px] font-medium">{title}</div>
                {description && <div className="text-xs text-muted-foreground mt-0.5">{description}</div>}
            </div>
            <div className="flex items-center gap-2 shrink-0">{children}</div>
        </div>
    );
}

function SettingsCard({ children }: { children: React.ReactNode }) {
    return (
        <div className="bg-card border border-border rounded-lg divide-y divide-border/50">
            {children}
        </div>
    );
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
    return (
        <button
            type="button"
            onClick={onChange}
            className={`inline-flex h-[22px] w-10 items-center rounded-full transition-colors ${
                enabled ? 'bg-primary' : 'bg-muted'
            }`}
            aria-pressed={enabled}
        >
            <span
                className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white transition-transform ${
                    enabled ? 'translate-x-[20px]' : 'translate-x-[2px]'
                }`}
            />
        </button>
    );
}

export function SettingsMainPage({
    t,
    themeMode,
    onThemeChange,
    densityMode,
    onDensityChange,
    textSizeMode,
    onTextSizeChange,
    language,
    onLanguageChange,
    weekStart,
    onWeekStartChange,
    dateFormat,
    onDateFormatChange,
    timeFormat,
    onTimeFormatChange,
    keybindingStyle,
    onKeybindingStyleChange,
    globalQuickAddShortcut,
    onGlobalQuickAddShortcutChange,
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
    showTrayToggle = false,
    trayVisible = true,
    onTrayVisibleChange,
}: SettingsMainPageProps) {
    const hasWindowSection = showWindowDecorations || showCloseBehavior || showTrayToggle;
    const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
    const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);
    const globalQuickAddOptions = getGlobalQuickAddShortcutOptions({
        isMac,
        isWindows,
    });

    return (
        <div className="space-y-5">
            {/* Look & Feel */}
            <SectionHeader>{t.lookAndFeel}</SectionHeader>
            <SettingsCard>
                <SettingsRow
                    title={t.appearance}
                    description={`${t.system} / ${t.light} / ${t.dark} / ${t.eink} / ${t.nord} / ${t.sepia}`}
                >
                    <select
                        value={themeMode}
                        onChange={(e) => onThemeChange(e.target.value as ThemeMode)}
                        className={selectCls}
                    >
                        <option value="system">{t.system}</option>
                        <option value="light">{t.light}</option>
                        <option value="dark">{t.dark}</option>
                        <option value="eink">{t.eink}</option>
                        <option value="nord">{t.nord}</option>
                        <option value="sepia">{t.sepia}</option>
                    </select>
                </SettingsRow>
                <SettingsRow title={t.density} description={t.densityDesc}>
                    <select
                        value={densityMode}
                        onChange={(e) => onDensityChange(e.target.value as DensityMode)}
                        className={selectCls}
                    >
                        <option value="comfortable">{t.densityComfortable}</option>
                        <option value="compact">{t.densityCompact}</option>
                    </select>
                </SettingsRow>
                <SettingsRow title={t.textSize} description={t.textSizeDesc}>
                    <select
                        value={textSizeMode}
                        onChange={(e) => onTextSizeChange(e.target.value as TextSizeMode)}
                        className={selectCls}
                    >
                        <option value="default">{t.textSizeDefault}</option>
                        <option value="large">{t.textSizeLarge}</option>
                        <option value="extra-large">{t.textSizeExtraLarge}</option>
                    </select>
                </SettingsRow>
            </SettingsCard>

            {/* Localization */}
            <SectionHeader>{t.localization}</SectionHeader>
            <SettingsCard>
                <SettingsRow
                    title={t.language}
                    description={languages.find((l) => l.id === language)?.native ?? language}
                >
                    <select
                        value={language}
                        onChange={(e) => onLanguageChange(e.target.value as Language)}
                        className={selectCls}
                    >
                        {languages.map((lang) => (
                            <option key={lang.id} value={lang.id}>
                                {lang.native}
                            </option>
                        ))}
                    </select>
                </SettingsRow>
                <SettingsRow
                    title={t.weekStart}
                    description={weekStart === 'monday' ? t.weekStartMonday : t.weekStartSunday}
                >
                    <select
                        value={weekStart}
                        onChange={(e) => onWeekStartChange(e.target.value as WeekStart)}
                        className={selectCls}
                    >
                        <option value="sunday">{t.weekStartSunday}</option>
                        <option value="monday">{t.weekStartMonday}</option>
                    </select>
                </SettingsRow>
                <SettingsRow
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
                        value={dateFormat}
                        onChange={(e) => onDateFormatChange(e.target.value as DateFormatSetting)}
                        className={selectCls}
                    >
                        <option value="system">{t.dateFormatSystem}</option>
                        <option value="dmy">{t.dateFormatDmy}</option>
                        <option value="mdy">{t.dateFormatMdy}</option>
                        <option value="ymd">{t.dateFormatYmd}</option>
                    </select>
                </SettingsRow>
                <SettingsRow
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
                        value={timeFormat}
                        onChange={(e) => onTimeFormatChange(e.target.value as TimeFormatSetting)}
                        className={selectCls}
                    >
                        <option value="system">{t.timeFormatSystem}</option>
                        <option value="12h">{t.timeFormat12h}</option>
                        <option value="24h">{t.timeFormat24h}</option>
                    </select>
                </SettingsRow>
            </SettingsCard>

            {/* Input */}
            <SectionHeader>{t.input}</SectionHeader>
            <SettingsCard>
                <SettingsRow title={t.keybindings} description={t.keybindingsDesc}>
                    <select
                        value={keybindingStyle}
                        onChange={(e) => onKeybindingStyleChange(e.target.value as 'vim' | 'emacs')}
                        className={selectCls}
                    >
                        <option value="vim">{t.keybindingVim}</option>
                        <option value="emacs">{t.keybindingEmacs}</option>
                    </select>
                    <button
                        onClick={onOpenHelp}
                        className="text-xs px-2.5 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    >
                        {t.viewShortcuts}
                    </button>
                </SettingsRow>
                <SettingsRow title={t.globalQuickAddShortcut} description={t.globalQuickAddShortcutDesc}>
                    <select
                        value={globalQuickAddShortcut}
                        onChange={(e) => onGlobalQuickAddShortcutChange(e.target.value as GlobalQuickAddShortcutSetting)}
                        className={selectCls}
                    >
                        {globalQuickAddOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                </SettingsRow>
                <SettingsRow title={t.undoNotifications} description={t.undoNotificationsDesc}>
                    <Toggle
                        enabled={undoNotificationsEnabled}
                        onChange={() => onUndoNotificationsChange(!undoNotificationsEnabled)}
                    />
                </SettingsRow>
            </SettingsCard>

            {/* Window Behavior */}
            {hasWindowSection && (
                <>
                    <SectionHeader>{t.windowBehavior}</SectionHeader>
                    <SettingsCard>
                        {showWindowDecorations && (
                            <SettingsRow title={t.windowDecorations} description={t.windowDecorationsDesc}>
                                <Toggle
                                    enabled={windowDecorationsEnabled}
                                    onChange={() => onWindowDecorationsChange?.(!windowDecorationsEnabled)}
                                />
                            </SettingsRow>
                        )}
                        {showCloseBehavior && (
                            <SettingsRow title={t.closeBehavior} description={t.closeBehaviorDesc}>
                                <select
                                    value={closeBehavior}
                                    onChange={(e) => onCloseBehaviorChange?.(e.target.value as 'ask' | 'tray' | 'quit')}
                                    className={selectCls}
                                >
                                    <option value="ask">{t.closeBehaviorAsk}</option>
                                    <option value="tray">{t.closeBehaviorTray}</option>
                                    <option value="quit">{t.closeBehaviorQuit}</option>
                                </select>
                            </SettingsRow>
                        )}
                        {showTrayToggle && (
                            <SettingsRow title={t.showTray} description={t.showTrayDesc}>
                                <Toggle
                                    enabled={trayVisible}
                                    onChange={() => onTrayVisibleChange?.(!trayVisible)}
                                />
                            </SettingsRow>
                        )}
                    </SettingsCard>
                </>
            )}
        </div>
    );
}
