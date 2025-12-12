import { useState, useEffect } from 'react';
import { Moon, Sun, Monitor, Globe, Check, ExternalLink, RefreshCw, Keyboard } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useLanguage, Language } from '../../contexts/language-context';
import { useKeybindings } from '../../contexts/keybinding-context';
import { open } from '@tauri-apps/plugin-dialog';
import { getVersion } from '@tauri-apps/api/app';
import { SyncService } from '../../lib/sync-service';
import { checkForUpdates, UpdateInfo, GITHUB_RELEASES_URL } from '../../lib/update-service';
import { useTaskStore, safeFormatDate } from '@mindwtr/core';

type ThemeMode = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'mindwtr-theme';

const LANGUAGES: { id: Language; label: string; native: string }[] = [
    { id: 'en', label: 'English', native: 'English' },
    { id: 'zh', label: 'Chinese', native: '中文' },
];

export function SettingsView() {
    const [themeMode, setThemeMode] = useState<ThemeMode>('system');
    const { language, setLanguage } = useLanguage();
    const { style: keybindingStyle, setStyle: setKeybindingStyle, openHelp } = useKeybindings();
    const { settings, updateSettings } = useTaskStore();
    const [saved, setSaved] = useState(false);
    const [appVersion, setAppVersion] = useState('0.1.0');

    // Update check state
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [updateError, setUpdateError] = useState<string | null>(null);
    const [showUpdateModal, setShowUpdateModal] = useState(false);

    // Sync state
    const [syncPath, setSyncPath] = useState<string>('');
    const [isSyncing, setIsSyncing] = useState(false);

    useEffect(() => {
        loadPreferences();
        getVersion().then(setAppVersion).catch(console.error);
    }, []);

    useEffect(() => {
        // Load current sync path from Tauri
        SyncService.getSyncPath().then(setSyncPath).catch(console.error);
    }, []);

    useEffect(() => {
        applyTheme(themeMode);
    }, [themeMode]);


    const loadPreferences = () => {
        const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
        if (savedTheme) setThemeMode(savedTheme as ThemeMode);
    };

    const saveThemePreference = (mode: ThemeMode) => {
        localStorage.setItem(THEME_STORAGE_KEY, mode);
        setThemeMode(mode);
        showSaved();
    };

    const saveLanguagePreference = (lang: Language) => {
        setLanguage(lang);
        showSaved();
    };

    const handleChangeSyncLocation = async () => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: 'Select Sync Folder'
            });

            if (selected && typeof selected === 'string') {
                const result = await SyncService.setSyncPath(selected);
                if (result.success) {
                    setSyncPath(result.path);
                    showSaved();
                }
            }
        } catch (error) {
            console.error('[Settings] Error in handleChangeSyncLocation:', error);
        }
    };

    const handleSync = async () => {
        if (!syncPath) return;

        try {
            setIsSyncing(true);

            const result = await SyncService.performSync();

            if (result.success) {
                showSaved();
                alert(t.lastSyncSuccess);
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (error) {
            console.error('Sync failed', error);
            alert(`${t.lastSyncError}: ${String(error)}`);
        } finally {
            setIsSyncing(false);
        }
    };

    const showSaved = () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    };

    const applyTheme = (mode: ThemeMode) => {
        const root = document.documentElement;
        if (mode === 'system') {
            const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            root.classList.toggle('dark', isDark);
        } else {
            root.classList.toggle('dark', mode === 'dark');
        }
    };

    // Labels based on language
    const labels = {
        en: {
            title: 'Settings',
            subtitle: 'Customize your Mindwtr experience',
            appearance: 'Appearance',
            language: 'Language',
            about: 'About',
            version: 'Version',
            platform: 'Platform',
            developer: 'Developer',
            website: 'Website',
            github: 'GitHub',
            license: 'License',
            checkForUpdates: 'Check for Updates',
            checking: 'Checking...',
            upToDate: 'You are using the latest version!',
            updateAvailable: 'Update Available',
            newVersionAvailable: 'A new version is available',
            download: 'Download',
            checkFailed: 'Failed to check for updates',
            system: 'System',
            light: 'Light',
            dark: 'Dark',
            followSystem: 'Follow system appearance',
            lightTheme: 'Light theme',
            darkTheme: 'Dark theme',
            accentColor: 'Accent Color',
            accentDesc: 'Customize highlight color',
            saved: 'Settings saved',
            keybindings: 'Keyboard Shortcuts',
            keybindingsDesc: 'Choose your preferred desktop keybinding style.',
            keybindingVim: 'Vim',
            keybindingEmacs: 'Emacs',
            viewShortcuts: 'View shortcuts',
            // Data section
            data: 'Data Storage',
            currentLocation: 'Current Location',
            changeLocation: 'Change Location',
            dataDescription: 'Choose where your data is stored. Point this to a synced folder (Dropbox, etc.) to sync with other devices.',
            // Sync section
            syncManagement: 'Sync Management',
            syncDescription: 'Configure a secondary folder to sync your data with (e.g., Dropbox, Syncthing). This merges your local data with the sync folder to prevent data loss.',
            syncFolderLocation: 'Sync Folder Location',
            savePath: 'Save Path',
            browse: 'Browse...',
            syncNow: 'Sync Now',
            syncing: 'Syncing...',
            pathHint: 'Type a path directly (e.g., ~/Sync/mindwtr) or use Browse if available',
            lastSync: 'Last sync',
            lastSyncNever: 'Never',
            lastSyncSuccess: 'Sync completed',
            lastSyncError: 'Sync failed',
            lastSyncConflicts: 'Conflicts',
        },
        zh: {
            title: '设置',
            subtitle: '自定义您的 Mindwtr 体验',
            appearance: '外观',
            language: '语言',
            about: '关于',
            version: '版本',
            platform: '平台',
            developer: '开发者',
            website: '网站',
            github: 'GitHub',
            license: '许可证',
            checkForUpdates: '检查更新',
            checking: '检查中...',
            upToDate: '您正在使用最新版本！',
            updateAvailable: '有可用更新',
            newVersionAvailable: '有新版本可用',
            download: '下载',
            checkFailed: '检查更新失败',
            system: '系统',
            light: '浅色',
            dark: '深色',
            followSystem: '跟随系统外观',
            lightTheme: '浅色主题',
            darkTheme: '深色主题',
            accentColor: '强调色',
            accentDesc: '自定义按钮和高亮颜色',
            saved: '设置已保存',
            keybindings: '快捷键',
            keybindingsDesc: '选择桌面端偏好的快捷键风格。',
            keybindingVim: 'Vim',
            keybindingEmacs: 'Emacs',
            viewShortcuts: '查看快捷键',
            // Data section
            data: '数据存储',
            currentLocation: '当前位置',
            changeLocation: '更改位置',
            dataDescription: '选择数据存储位置。将其指向同步文件夹（Dropbox 等）以与其他设备同步。',
            // Sync section
            syncManagement: '同步管理',
            syncDescription: '配置一个辅助文件夹来同步您的数据（如 Dropbox、Syncthing）。这会将本地数据与同步文件夹合并，以防止数据丢失。',
            syncFolderLocation: '同步文件夹位置',
            savePath: '保存路径',
            browse: '浏览...',
            syncNow: '立即同步',
            syncing: '同步中...',
            pathHint: '直接输入路径（如 ~/Sync/mindwtr）或点击浏览选择',
            lastSync: '上次同步',
            lastSyncNever: '从未同步',
            lastSyncSuccess: '同步完成',
            lastSyncError: '同步失败',
            lastSyncConflicts: '冲突',
        },
    };

    const t = labels[language];


    const openLink = (url: string) => {
        window.open(url, '_blank');
    };

    const handleCheckUpdates = async () => {
        setIsCheckingUpdate(true);
        setUpdateInfo(null);
        setUpdateError(null);
        setShowUpdateModal(false);

        try {
            const info = await checkForUpdates(appVersion);
            setUpdateInfo(info);

            if (info.hasUpdate) {
                // Show update modal with changelog
                setShowUpdateModal(true);
            } else {
                alert(t.upToDate);
            }
        } catch (error) {
            console.error('Update check failed:', error);
            setUpdateError(String(error));
            alert(t.checkFailed);
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const handleDownloadUpdate = () => {
        if (updateInfo?.downloadUrl) {
            window.open(updateInfo.downloadUrl, '_blank');
        } else if (updateInfo?.releaseUrl) {
            window.open(updateInfo.releaseUrl, '_blank');
        } else {
            window.open(GITHUB_RELEASES_URL, '_blank');
        }
        setShowUpdateModal(false);
    };

    const lastSyncAt = settings?.lastSyncAt;
    const lastSyncStatus = settings?.lastSyncStatus;
    const lastSyncStats = settings?.lastSyncStats;
    const lastSyncDisplay = lastSyncAt
        ? safeFormatDate(lastSyncAt, 'PPpp', lastSyncAt)
        : t.lastSyncNever;
    const conflictCount = (lastSyncStats?.tasks.conflicts || 0) + (lastSyncStats?.projects.conflicts || 0);

    return (
        <div className="h-full overflow-y-auto p-8 max-w-4xl mx-auto">
            <header className="mb-10">
                <h1 className="text-3xl font-bold mb-2">{t.title}</h1>
                <p className="text-muted-foreground">{t.subtitle}</p>
            </header>

            <div className="space-y-8">
                {/* Appearance Section */}
                <section className="space-y-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2">
                        <Monitor className="w-5 h-5" />
                        {t.appearance}
                    </h2>

	                    <div className="bg-card border border-border rounded-lg p-1">
	                        <div className="grid grid-cols-3 gap-1">
                            {/* System */}
                            <button
                                onClick={() => saveThemePreference('system')}
                                className={cn(
                                    "flex flex-col items-center gap-3 p-4 rounded-md transition-all",
                                    themeMode === 'system'
                                        ? "bg-primary/10 text-primary ring-2 ring-primary ring-inset"
                                        : "hover:bg-muted text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <div className="p-2 rounded-full border border-border bg-background">
                                    <Monitor className="w-5 h-5" />
                                </div>
                                <span className="text-sm font-medium">{t.system}</span>
                            </button>

                            {/* Light */}
                            <button
                                onClick={() => saveThemePreference('light')}
                                className={cn(
                                    "flex flex-col items-center gap-3 p-4 rounded-md transition-all",
                                    themeMode === 'light'
                                        ? "bg-primary/10 text-primary ring-2 ring-primary ring-inset"
                                        : "hover:bg-muted text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <div className="p-2 rounded-full border border-border bg-background">
                                    <Sun className="w-5 h-5" />
                                </div>
                                <span className="text-sm font-medium">{t.light}</span>
                            </button>

                            {/* Dark */}
                            <button
                                onClick={() => saveThemePreference('dark')}
                                className={cn(
                                    "flex flex-col items-center gap-3 p-4 rounded-md transition-all",
                                    themeMode === 'dark'
                                        ? "bg-primary/10 text-primary ring-2 ring-primary ring-inset"
                                        : "hover:bg-muted text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <div className="p-2 rounded-full border border-border bg-slate-950 text-slate-50">
                                    <Moon className="w-5 h-5" />
                                </div>
                                <span className="text-sm font-medium">{t.dark}</span>
                            </button>
	                        </div>
	                    </div>

	                    <div className="bg-card border border-border rounded-lg p-4 flex items-center justify-between">
	                        <div>
	                            <p className="text-sm font-medium">{t.accentColor}</p>
	                            <p className="text-xs text-muted-foreground mt-1">{t.accentDesc}</p>
	                        </div>
	                        <input
	                            type="color"
	                            value={settings?.accentColor || '#3B82F6'}
	                            onChange={(e) => updateSettings({ accentColor: e.target.value }).catch(console.error)}
	                            className="w-10 h-8 rounded cursor-pointer border-0 p-0"
	                        />
	                    </div>
	                </section>

                <div className="border-t border-border"></div>

                {/* Language Section */}
                <section className="space-y-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2">
                        <Globe className="w-5 h-5" />
                        {t.language}
                    </h2>

                    <div className="grid sm:grid-cols-2 gap-4">
                        {LANGUAGES.map((lang) => (
                            <button
                                key={lang.id}
                                onClick={() => saveLanguagePreference(lang.id)}
                                className={cn(
                                    "flex items-center justify-between p-4 rounded-lg border transition-all",
                                    language === lang.id
                                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                                        : "border-border hover:border-primary/50 hover:bg-muted/50"
                                )}
                            >
                                <span className="font-medium">{lang.native}</span>
                                {language === lang.id && (
                                    <Check className="w-4 h-4 text-primary" />
                                )}
                            </button>
                        ))}
                    </div>
                </section>

                <div className="border-t border-border"></div>

                {/* Keybindings Section */}
                <section className="space-y-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2">
                        <Keyboard className="w-5 h-5" />
                        {t.keybindings}
                    </h2>

                    <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                        <p className="text-sm text-muted-foreground">
                            {t.keybindingsDesc}
                        </p>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setKeybindingStyle('vim')}
                                className={cn(
                                    "px-4 py-2 rounded-md text-sm font-medium transition-colors border",
                                    keybindingStyle === 'vim'
                                        ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                        : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                                )}
                            >
                                {t.keybindingVim}
                            </button>
                            <button
                                onClick={() => setKeybindingStyle('emacs')}
                                className={cn(
                                    "px-4 py-2 rounded-md text-sm font-medium transition-colors border",
                                    keybindingStyle === 'emacs'
                                        ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                        : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                                )}
                            >
                                {t.keybindingEmacs}
                            </button>
                        </div>
                        <div className="flex justify-end">
                            <button
                                onClick={openHelp}
                                className="text-sm text-primary hover:underline"
                            >
                                {t.viewShortcuts}
                            </button>
                        </div>
                    </div>
                </section>

                <div className="border-t border-border"></div>

                {/* Sync Management Section */}
                <section className="space-y-4">
                    <h2 className="text-xl font-semibold flex items-center gap-2">
                        <ExternalLink className="w-5 h-5" />
                        {t.syncManagement}
                    </h2>

                    <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                        <p className="text-sm text-muted-foreground">
                            {t.syncDescription}
                        </p>

                        <div className="flex flex-col gap-2">
                            <label className="text-sm font-medium">{t.syncFolderLocation}</label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={syncPath}
                                    onChange={(e) => setSyncPath(e.target.value)}
                                    placeholder="/path/to/your/sync/folder"
                                    className="flex-1 bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <button
                                    onClick={async () => {
                                        if (syncPath) {
                                            const result = await SyncService.setSyncPath(syncPath);
                                            if (result.success) {
                                                showSaved();
                                            }
                                        }
                                    }}
                                    disabled={!syncPath}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:bg-gray-400 whitespace-nowrap"
                                >
                                    {t.savePath}
                                </button>
                                <button
                                    onClick={handleChangeSyncLocation}
                                    className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap"
                                >
                                    {t.browse}
                                </button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {t.pathHint}
                            </p>
                        </div>

                        {syncPath && (
                            <div className="pt-2">
                                <button
                                    onClick={handleSync}
                                    disabled={isSyncing}
                                    className={cn(
                                        "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white transition-colors",
                                        isSyncing ? "bg-blue-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700"
                                    )}
                                >
                                    <ExternalLink className={cn("w-4 h-4", isSyncing && "animate-spin")} />
                                    {isSyncing ? t.syncing : t.syncNow}
                                </button>
                            </div>
                        )}

                        <div className="pt-3 text-xs text-muted-foreground space-y-1">
                            <div>
                                {t.lastSync}: {lastSyncDisplay}
                                {lastSyncStatus === 'success' && ` • ${t.lastSyncSuccess}`}
                                {lastSyncStatus === 'error' && ` • ${t.lastSyncError}`}
                            </div>
                            {lastSyncStats && (
                                <div>
                                    {t.lastSyncConflicts}: {conflictCount} • Tasks {lastSyncStats.tasks.mergedTotal} / Projects {lastSyncStats.projects.mergedTotal}
                                </div>
                            )}
                            {lastSyncStatus === 'error' && settings?.lastSyncError && (
                                <div className="text-destructive">
                                    {settings.lastSyncError}
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                <div className="border-t border-border"></div>

                {/* About Section */}
                <section className="space-y-4">
                    <h2 className="text-xl font-semibold">{t.about}</h2>
                    <div className="bg-muted/30 rounded-lg p-6 space-y-4 border border-border">
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">{t.version}</span>
                            <span className="font-mono bg-muted px-2 py-1 rounded text-sm">v{appVersion}</span>
                        </div>
                        <div className="border-t border-border/50"></div>
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">{t.developer}</span>
                            <span className="font-medium">dongdongbh</span>
                        </div>
                        <div className="border-t border-border/50"></div>
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">{t.license}</span>
                            <span className="font-medium">MIT</span>
                        </div>
                        <div className="border-t border-border/50"></div>
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">{t.website}</span>
                            <button
                                onClick={() => openLink('https://dongdongbh.tech')}
                                className="text-primary hover:underline flex items-center gap-1"
                            >
                                dongdongbh.tech
                                <ExternalLink className="w-3 h-3" />
                            </button>
                        </div>
                        <div className="border-t border-border/50"></div>
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">{t.github}</span>
                            <button
                                onClick={() => openLink('https://github.com/dongdongbh/Mindwtr')}
                                className="text-blue-400 hover:underline cursor-pointer flex items-center gap-1"
                            >
                                github.com/dongdongbh/Mindwtr
                                <ExternalLink className="w-3 h-3" />
                            </button>
                        </div>
                        <div className="border-t border-border/50"></div>
                        {/* Check for Updates */}
                        <div className="flex justify-between items-center">
                            <span className="text-muted-foreground">{t.checkForUpdates}</span>
                            <button
                                onClick={handleCheckUpdates}
                                disabled={isCheckingUpdate}
                                className={cn(
                                    "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                                    isCheckingUpdate
                                        ? "bg-muted text-muted-foreground cursor-not-allowed"
                                        : "bg-primary text-primary-foreground hover:bg-primary/90"
                                )}
                            >
                                <RefreshCw className={cn("w-4 h-4", isCheckingUpdate && "animate-spin")} />
                                {isCheckingUpdate ? t.checking : t.checkForUpdates}
                            </button>
                        </div>
                        {updateError && (
                            <>
                                <div className="border-t border-border/50"></div>
                                <div className="text-red-500 text-sm">{t.checkFailed}</div>
                            </>
                        )}
                    </div>
                </section>
            </div>

            {saved && (
                <div className="fixed bottom-8 right-8 bg-primary text-primary-foreground px-4 py-2 rounded-lg shadow-lg animate-in fade-in slide-in-from-bottom-2">
                    {t.saved}
                </div>
            )}

            {/* Update Modal */}
            {showUpdateModal && updateInfo && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                    <div className="bg-card border border-border rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
                        <div className="p-6 border-b border-border">
                            <h3 className="text-xl font-semibold text-green-500 flex items-center gap-2">
                                {t.updateAvailable}
                            </h3>
                            <p className="text-muted-foreground mt-1">
                                v{updateInfo.currentVersion} → v{updateInfo.latestVersion}
                            </p>
                        </div>
                        <div className="p-6 overflow-y-auto flex-1">
                            <h4 className="font-medium mb-2">{language === 'zh' ? '更新日志' : 'Changelog'}</h4>
                            <div className="bg-muted/50 rounded-md p-4 text-sm whitespace-pre-wrap max-h-60 overflow-y-auto">
                                {updateInfo.releaseNotes || (language === 'zh' ? '暂无更新日志' : 'No changelog available')}
                            </div>
                        </div>
                        <div className="p-6 border-t border-border flex gap-3 justify-end">
                            <button
                                onClick={() => setShowUpdateModal(false)}
                                className="px-4 py-2 rounded-md text-sm font-medium bg-muted hover:bg-muted/80 transition-colors"
                            >
                                {language === 'zh' ? '稍后' : 'Later'}
                            </button>
                            <button
                                onClick={handleDownloadUpdate}
                                className="px-4 py-2 rounded-md text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors flex items-center gap-2"
                            >
                                <ExternalLink className="w-4 h-4" />
                                {t.download}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
