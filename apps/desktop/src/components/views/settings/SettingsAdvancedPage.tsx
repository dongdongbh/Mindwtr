import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SettingsLabels } from './labels';
import type { LocalApiServerStatus } from '../../../lib/local-api-server';
import type { DesktopRenderingConfig } from '../../../lib/desktop-rendering';
import { Switch } from '../../ui/Switch';
import type { SettingsKeyboardWindowProps } from './SettingsMainPage';
import { SettingRow, SettingsCard, SettingsDisclosureCard, SettingsSectionHeader } from './SettingRow';
import type { AppLockAvailability } from '../../../lib/app-lock';
import { AppLockSettingsSection } from './AppLockSettingsSection';

export type SettingsAdvancedPageProps = SettingsKeyboardWindowProps & {
    t: SettingsLabels;
    isTauri: boolean;
    localApiStatus: LocalApiServerStatus;
    localApiPortInput: string;
    localApiBusy: boolean;
    localApiPortError: string;
    networkProxyUrl: string;
    desktopRenderingConfig: DesktopRenderingConfig;
    desktopRenderingBusy: boolean;
    onLocalApiToggle: (enabled: boolean) => void;
    onLocalApiPortInputChange: (value: string) => void;
    onLocalApiPortCommit: () => void;
    onNetworkProxyUrlChange: (value: string) => void;
    onSaveNetworkProxy: () => Promise<void> | void;
    onDesktopRenderingToggle: (disableHardwareAcceleration: boolean) => void;
    /** Privacy lock support on this device; hidden when `supported` is false. */
    appLockAvailability?: AppLockAvailability;
};

const inputCls =
    'h-8 w-24 rounded-md border border-border bg-muted/50 px-2.5 text-right text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60';

export function SettingsAdvancedPage({
    t,
    isTauri,
    localApiStatus,
    localApiPortInput,
    localApiBusy,
    localApiPortError,
    networkProxyUrl,
    desktopRenderingConfig,
    desktopRenderingBusy,
    onLocalApiToggle,
    onLocalApiPortInputChange,
    onLocalApiPortCommit,
    onNetworkProxyUrlChange,
    onSaveNetworkProxy,
    onDesktopRenderingToggle,
    appLockAvailability = { supported: false, available: false },
    onOpenHelp,
    keybindingStyle,
    onKeybindingStyleChange,
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
}: SettingsAdvancedPageProps) {
    const [networkProxyOpen, setNetworkProxyOpen] = useState(false);
    const [keyboardWindowOpen, setKeyboardWindowOpen] = useState(false);
    const statusText = !isTauri
        ? t.localApiUnavailable
        : localApiStatus.running && localApiStatus.url
            ? localApiStatus.url
            : t.localApiStopped;
    const errorText = localApiPortError || localApiStatus.error || '';

    return (
        <div className="space-y-5">
            <SettingsDisclosureCard
                sectionKey="keyboardAndWindow"
                settingsKey={null}
                title={t.keyboardAndWindow}
                open={keyboardWindowOpen}
                onToggle={() => setKeyboardWindowOpen((open) => !open)}
            >
                <SettingRow padded settingsKey="keybindings" title={t.keybindings} description={t.keybindingsDesc}>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <select
                            aria-label={t.keybindings}
                            value={keybindingStyle}
                            onChange={(event) => onKeybindingStyleChange(event.target.value as 'vim' | 'emacs' | 'standard')}
                            className="rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                            <option value="standard">{t.keybindingStandard}</option>
                            <option value="vim">{t.keybindingVim}</option>
                            <option value="emacs">{t.keybindingEmacs}</option>
                        </select>
                        <button
                            type="button"
                            onClick={onOpenHelp}
                            className="rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                        >
                            {t.viewShortcuts}
                        </button>
                    </div>
                </SettingRow>
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
                            onChange={(event) => onCloseBehaviorChange?.(event.target.value as 'ask' | 'tray' | 'quit')}
                            className="rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
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
            </SettingsDisclosureCard>
            <AppLockSettingsSection t={t} availability={appLockAvailability} />
            <SettingsSectionHeader>{t.automation}</SettingsSectionHeader>
            <SettingsCard>
                <SettingRow padded settingsKey="localApiServer" title={t.localApiServer} description={statusText}>
                    <Switch
                        disabled={!isTauri || localApiBusy}
                        checked={localApiStatus.enabled}
                        aria-label={t.localApiServer}
                        onCheckedChange={() => onLocalApiToggle(!localApiStatus.enabled)}
                    />
                </SettingRow>
                <SettingRow padded settingsKey="localApiPort" title={t.localApiPort} description={t.localApiPortDesc}>
                    <input
                        aria-label={t.localApiPort}
                        className={inputCls}
                        disabled={!isTauri || localApiBusy}
                        inputMode="numeric"
                        min={1024}
                        max={65535}
                        type="number"
                        value={localApiPortInput}
                        onBlur={onLocalApiPortCommit}
                        onChange={(event) => onLocalApiPortInputChange(event.target.value)}
                    />
                </SettingRow>
                {localApiStatus.enabled && localApiStatus.token && (
                    <SettingRow padded settingsKey="localApiToken" title={t.localApiToken} description={t.localApiTokenDesc}>
                        <code className="max-w-[320px] break-all rounded border border-border bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
                            {localApiStatus.token}
                        </code>
                    </SettingRow>
                )}
                {localApiStatus.enabled && (
                    <div className="px-4 py-3 text-xs text-muted-foreground">
                        {t.localApiSecurityNote}
                    </div>
                )}
                {errorText && (
                    <div className="px-4 py-3 text-xs text-destructive">
                        {errorText}
                    </div>
                )}
            </SettingsCard>
            {isTauri && (
                <>
                    <SettingsSectionHeader>{t.rendering}</SettingsSectionHeader>
                    <SettingsCard>
                        <SettingRow padded settingsKey="softwareRendering" title={t.softwareRendering} description={t.softwareRenderingDesc}>
                            <Switch
                                disabled={desktopRenderingBusy}
                                checked={desktopRenderingConfig.disableHardwareAcceleration}
                                aria-label={t.softwareRendering}
                                onCheckedChange={() => onDesktopRenderingToggle(!desktopRenderingConfig.disableHardwareAcceleration)}
                            />
                        </SettingRow>
                    </SettingsCard>
                    <SettingsSectionHeader>{t.network}</SettingsSectionHeader>
                    <SettingsCard>
                        <div>
                            <button
                                type="button"
                                onClick={() => setNetworkProxyOpen((open) => !open)}
                                aria-expanded={networkProxyOpen}
                                data-settings-key="networkProxyUrl"
                                data-settings-section="network"
                                className="flex w-full items-center justify-between gap-4 p-4 text-left"
                            >
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">{t.networkProxyUrl}</div>
                                    <div className="text-xs text-muted-foreground mt-1">
                                        {t.networkProxyUrlDesc}
                                    </div>
                                </div>
                                {networkProxyOpen ? (
                                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                                ) : (
                                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                                )}
                            </button>
                            {networkProxyOpen && (
                                <div className="border-t border-border/50 px-4 py-3 space-y-2">
                                    <div className="flex flex-col gap-2 sm:flex-row">
                                        <input
                                            aria-label={t.networkProxyUrl}
                                            type="text"
                                            value={networkProxyUrl}
                                            onChange={(event) => onNetworkProxyUrlChange(event.target.value)}
                                            placeholder="http://proxy-host:port"
                                            className="min-w-0 flex-1 rounded-md border border-border bg-muted/50 px-2.5 py-2 text-[13px] font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                        />
                                        <button
                                            type="button"
                                            onClick={onSaveNetworkProxy}
                                            className="rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/90"
                                        >
                                            {t.networkProxySave}
                                        </button>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {t.networkProxyUrlHint}
                                    </div>
                                </div>
                            )}
                        </div>
                    </SettingsCard>
                </>
            )}
        </div>
    );
}
