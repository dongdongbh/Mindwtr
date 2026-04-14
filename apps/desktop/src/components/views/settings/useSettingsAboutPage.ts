import { useCallback, useEffect, useMemo, useState } from 'react';

import {
    APP_STORE_LISTING_URL,
    checkForUpdates,
    compareVersions,
    getFlatpakInstallChannel,
    HOMEBREW_CASK_URL,
    MS_STORE_URL,
    normalizeInstallSource,
    verifyDownloadChecksum,
    WINGET_PACKAGE_URL,
    type InstallSource,
    type UpdateInfo,
} from '../../../lib/update-service';
import {
    buildLinuxPostDownloadNotice,
    canDownloadRecommendedUpdate,
    resolveLinuxFlavor,
    resolvePreferredDownloadUrl,
    resolveRecommendedDownload,
    type LinuxDistroInfo,
} from './update-platform';
import {
    getInstallSourceOrFallback,
    isTauriRuntime,
} from '../../../lib/runtime';
import { reportError } from '../../../lib/report-error';
import { getLogPath } from '../../../lib/app-log';
import { measureSettingsOpenStep } from '../../../lib/settings-open-diagnostics';
import type { SettingsLabels } from './labels';
import type { SettingsAboutPageProps } from './SettingsAboutPage';
import type { RecommendedDownload, SettingsUpdateModalProps } from './SettingsUpdateModal';

const UPDATE_BADGE_AVAILABLE_KEY = 'mindwtr-update-available';
const UPDATE_BADGE_LAST_CHECK_KEY = 'mindwtr-update-last-check';
const UPDATE_BADGE_LATEST_KEY = 'mindwtr-update-latest';
const UPDATE_BADGE_INTERVAL_MS = 1000 * 60 * 60 * 24;

type UseSettingsAboutPageOptions = {
    t: SettingsLabels;
};

type UseSettingsAboutPageResult = {
    aboutPageProps: Omit<SettingsAboutPageProps, 't'>;
    hasUpdateBadge: boolean;
    logPath: string;
    updateModalProps: Omit<SettingsUpdateModalProps, 't'>;
};

export function useSettingsAboutPage({
    t,
}: UseSettingsAboutPageOptions): UseSettingsAboutPageResult {
    const isTauri = isTauriRuntime();
    const [appVersion, setAppVersion] = useState('0.1.0');
    const [logPath, setLogPath] = useState('');
    const [installSource, setInstallSource] = useState<InstallSource>('unknown');
    const [installChannel, setInstallChannel] = useState<string | null>(null);
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [updateError, setUpdateError] = useState<string | null>(null);
    const [updateNotice, setUpdateNotice] = useState<string | null>(null);
    const [showUpdateModal, setShowUpdateModal] = useState(false);
    const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
    const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
    const [linuxDistro, setLinuxDistro] = useState<LinuxDistroInfo | null>(null);
    const [hasUpdateBadge, setHasUpdateBadge] = useState(false);

    const persistUpdateBadge = useCallback((next: boolean, latestVersion?: string) => {
        setHasUpdateBadge(next);
        try {
            localStorage.setItem(
                UPDATE_BADGE_AVAILABLE_KEY,
                next ? 'true' : 'false',
            );
            if (next && latestVersion) {
                localStorage.setItem(UPDATE_BADGE_LATEST_KEY, latestVersion);
            } else {
                localStorage.removeItem(UPDATE_BADGE_LATEST_KEY);
            }
        } catch (error) {
            reportError('Failed to persist update badge state', error);
        }
    }, []);

    useEffect(() => {
        if (!isTauri) {
            setInstallSource('github-release');
            setInstallChannel(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const rawSource = await measureSettingsOpenStep('install-source', () =>
                    getInstallSourceOrFallback('unknown'),
                );
                const source = normalizeInstallSource(rawSource);
                const channel = getFlatpakInstallChannel(rawSource);
                if (!cancelled) {
                    setInstallSource(source);
                    setInstallChannel(channel);
                }
            } catch (error) {
                if (!cancelled) {
                    setInstallSource('unknown');
                    setInstallChannel(null);
                }
                reportError('Failed to detect install source', error);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isTauri]);

    useEffect(() => {
        if (!isTauri) {
            setAppVersion('web');
            return;
        }

        let cancelled = false;
        const timer = window.setTimeout(() => {
            if (cancelled) return;
            measureSettingsOpenStep('app-version', async () => {
                const { getVersion } = await import('@tauri-apps/api/app');
                return await getVersion();
            })
                .then((version) => {
                    if (!cancelled) setAppVersion(version);
                })
                .catch((error) => reportError('Failed to read app version', error));

            measureSettingsOpenStep('linux-distro', async () => {
                const { invoke } = await import('@tauri-apps/api/core');
                return await invoke<LinuxDistroInfo | null>('get_linux_distro');
            })
                .then((distro) => {
                    if (cancelled) return;
                    setLinuxDistro(distro);
                })
                .catch((error) => reportError('Failed to read system paths', error));

            measureSettingsOpenStep('log-path', () => getLogPath())
                .then((path) => {
                    if (path && !cancelled) setLogPath(path);
                })
                .catch((error) => reportError('Failed to read log path', error));
        }, 0);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [isTauri]);

    useEffect(() => {
        if (!isTauri || !appVersion || appVersion === 'web') return;
        try {
            const storedAvailable = localStorage.getItem(UPDATE_BADGE_AVAILABLE_KEY);
            const storedLatest = localStorage.getItem(UPDATE_BADGE_LATEST_KEY);
            if (
                storedAvailable === 'true' &&
                storedLatest &&
                compareVersions(storedLatest, appVersion) > 0
            ) {
                setHasUpdateBadge(true);
                return;
            }
            setHasUpdateBadge(false);
            if (storedAvailable === 'true') {
                localStorage.setItem(UPDATE_BADGE_AVAILABLE_KEY, 'false');
                localStorage.removeItem(UPDATE_BADGE_LATEST_KEY);
            }
        } catch (error) {
            reportError('Failed to read update badge state', error);
        }
    }, [appVersion, installSource, isTauri]);

    useEffect(() => {
        if (!isTauri || !appVersion || appVersion === 'web') return;
        let lastCheck = 0;
        try {
            lastCheck = Number(
                localStorage.getItem(UPDATE_BADGE_LAST_CHECK_KEY) || 0,
            );
        } catch (error) {
            reportError('Failed to read update check timestamp', error);
        }
        if (Date.now() - lastCheck < UPDATE_BADGE_INTERVAL_MS) return;
        try {
            localStorage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(Date.now()));
        } catch (error) {
            reportError('Failed to persist update check timestamp', error);
        }
        let cancelled = false;
        (async () => {
            try {
                const info = await measureSettingsOpenStep(
                    'background-update-check',
                    () => checkForUpdates(appVersion, { installSource }),
                );
                if (cancelled) return;
                if (info.hasUpdate) {
                    persistUpdateBadge(true, info.latestVersion);
                } else {
                    persistUpdateBadge(false);
                }
            } catch (error) {
                reportError('Background update check failed', error);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [appVersion, installSource, isTauri, persistUpdateBadge]);

    const openLink = useCallback(async (url: string): Promise<boolean> => {
        const nextUrl = url.trim();
        let openError: unknown = null;
        if (isTauri) {
            try {
                const { open } = await import('@tauri-apps/plugin-shell');
                await open(nextUrl);
                return true;
            } catch (error) {
                openError = error;
            }
        }

        const opened = window.open(nextUrl, '_blank', 'noopener,noreferrer');
        if (!opened) {
            reportError(
                'Failed to open external link',
                openError ?? new Error('Popup blocked'),
            );
            return false;
        }
        return true;
    }, [isTauri]);

    const linuxFlavor = useMemo(() => resolveLinuxFlavor(linuxDistro), [linuxDistro]);
    const linuxPostDownloadNotice = useMemo(
        () =>
            buildLinuxPostDownloadNotice({
                downloadAURHint: t.downloadAURHint,
                installSource,
                linuxFlavor,
                linuxUpdateHint: t.linuxUpdateHint,
            }),
        [installSource, linuxFlavor, t.downloadAURHint, t.linuxUpdateHint],
    );
    const recommendedDownload = useMemo<RecommendedDownload | null>(
        () => resolveRecommendedDownload({ installSource, linuxFlavor, updateInfo }),
        [installSource, linuxFlavor, updateInfo],
    );
    const preferredDownloadUrl = useMemo(
        () =>
            resolvePreferredDownloadUrl({
                installSource,
                linuxFlavor,
                recommendedDownload,
                updateInfo,
            }),
        [installSource, linuxFlavor, recommendedDownload, updateInfo],
    );

    const isArchLinuxUpdate =
        updateInfo?.platform === 'linux' && linuxFlavor === 'arch';
    const canDownloadUpdate = useMemo(
        () =>
            canDownloadRecommendedUpdate({
                installSource,
                isArchLinuxUpdate,
                preferredDownloadUrl,
            }),
        [installSource, isArchLinuxUpdate, preferredDownloadUrl],
    );

    const handleCheckUpdates = useCallback(async () => {
        setIsCheckingUpdate(true);
        setUpdateInfo(null);
        setUpdateError(null);
        setUpdateNotice(null);
        try {
            try {
                localStorage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(Date.now()));
            } catch (error) {
                reportError('Failed to persist update check timestamp', error);
            }
            const info = await checkForUpdates(appVersion, { installSource });
            if (!info || !info.hasUpdate) {
                setUpdateNotice(t.upToDate);
                persistUpdateBadge(false);
                return;
            }
            setUpdateInfo(info);
            persistUpdateBadge(true, info.latestVersion);
            if (info.platform === 'linux' && linuxFlavor === 'arch') {
                setDownloadNotice(t.downloadAURHint);
            } else if (
                info.platform === 'macos' &&
                (installSource === 'direct'
                    || installSource === 'github-release'
                    || installSource === 'unknown')
            ) {
                setDownloadNotice(
                    'Recommended on macOS: brew update && brew upgrade --cask mindwtr',
                );
            } else {
                setDownloadNotice(null);
            }
            setIsDownloadingUpdate(false);
            setShowUpdateModal(true);
        } catch (error) {
            reportError('Update check failed', error);
            setUpdateError(String(error));
        } finally {
            setIsCheckingUpdate(false);
        }
    }, [appVersion, installSource, linuxFlavor, persistUpdateBadge, t.downloadAURHint, t.upToDate]);

    const handleDownloadUpdate = useCallback(async () => {
        const targetUrl = preferredDownloadUrl;
        if (installSource === 'microsoft-store') {
            await openLink(MS_STORE_URL);
            setDownloadNotice(t.storeUpdateHint);
            return;
        }
        if (installSource === 'mac-app-store') {
            const opened = await openLink(APP_STORE_LISTING_URL);
            setDownloadNotice(opened ? 'Update via App Store.' : t.downloadFailed);
            return;
        }
        if (installSource === 'homebrew') {
            await openLink(HOMEBREW_CASK_URL);
            setDownloadNotice(
                'Update via Homebrew: brew update && brew upgrade --cask mindwtr',
            );
            return;
        }
        if (installSource === 'winget') {
            await openLink(WINGET_PACKAGE_URL);
            setDownloadNotice(
                'Update via winget: winget upgrade --id dongdongbh.Mindwtr --exact',
            );
            return;
        }
        if (updateInfo?.platform === 'macos') {
            const opened = await openLink(HOMEBREW_CASK_URL);
            setDownloadNotice(
                opened
                    ? 'Recommended on macOS: brew update && brew upgrade --cask mindwtr'
                    : t.downloadFailed,
            );
            return;
        }
        if (updateInfo?.platform === 'linux' && linuxFlavor === 'arch') {
            setDownloadNotice(linuxPostDownloadNotice);
            return;
        }
        if (!targetUrl) {
            setDownloadNotice(t.downloadFailed);
            return;
        }
        setIsDownloadingUpdate(true);
        setDownloadNotice(t.downloadStarting);

        try {
            let checksumStatus: 'verified' | 'unavailable' | 'mismatch' =
                'unavailable';
            if (updateInfo?.assets?.length) {
                try {
                    checksumStatus = await verifyDownloadChecksum(
                        targetUrl,
                        updateInfo.assets,
                    );
                } catch (error) {
                    reportError('Checksum verification failed unexpectedly', error);
                    checksumStatus = 'unavailable';
                }
                if (checksumStatus === 'mismatch') {
                    setDownloadNotice(t.downloadChecksumMismatch);
                    return;
                }
            }
            const opened = await openLink(targetUrl);
            if (!opened) {
                setDownloadNotice(t.downloadFailed);
                return;
            }
            if (updateInfo?.platform === 'linux') {
                setDownloadNotice(linuxPostDownloadNotice);
            } else {
                setDownloadNotice(t.downloadStarted);
            }
        } catch (error) {
            reportError('Failed to open update URL', error);
            setDownloadNotice(t.downloadFailed);
        } finally {
            setIsDownloadingUpdate(false);
        }
    }, [
        installSource,
        linuxFlavor,
        linuxPostDownloadNotice,
        openLink,
        preferredDownloadUrl,
        t.downloadChecksumMismatch,
        t.downloadFailed,
        t.downloadStarted,
        t.downloadStarting,
        t.storeUpdateHint,
        updateInfo,
    ]);

    const installChannelDisplay = useMemo(() => {
        if (installSource === 'portable') return 'Portable';
        if (installSource !== 'flatpak') return null;
        if (!installChannel) return 'Flatpak';
        return `Flatpak (${installChannel})`;
    }, [installChannel, installSource]);

    const updateActionLabel =
        installSource === 'microsoft-store'
            ? t.checkStoreUpdates
            : t.checkForUpdates;

    return {
        aboutPageProps: {
            appVersion,
            installChannel: installChannelDisplay,
            isCheckingUpdate,
            onCheckUpdates: handleCheckUpdates,
            onOpenLink: openLink,
            updateActionLabel,
            updateError,
            updateNotice,
        },
        hasUpdateBadge,
        logPath,
        updateModalProps: {
            canDownload: canDownloadUpdate,
            downloadNotice,
            isDownloading: isDownloadingUpdate,
            isOpen: showUpdateModal,
            linuxFlavor,
            onClose: () => {
                setShowUpdateModal(false);
                setIsDownloadingUpdate(false);
                setDownloadNotice(null);
            },
            onDownload: handleDownloadUpdate,
            recommendedDownload,
            updateInfo,
        },
    };
}
