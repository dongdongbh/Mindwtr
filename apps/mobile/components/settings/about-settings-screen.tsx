import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { compareVersions, logSettingsError, logSettingsWarn } from '@/lib/settings-utils';

import {
    MobileExtraConfig,
    UPDATE_BADGE_AVAILABLE_KEY,
    UPDATE_BADGE_INTERVAL_MS,
    UPDATE_BADGE_LAST_CHECK_KEY,
    UPDATE_BADGE_LATEST_KEY,
} from './settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar, SubHeader } from './settings.shell';
import { styles } from './settings.styles';

export function AboutSettingsScreen({
    onUpdateBadgeChange,
}: {
    onUpdateBadgeChange: (next: boolean) => void;
}) {
    const tc = useThemeColors();
    const { localize, t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
    const isFossBuild = extraConfig?.isFossBuild === true || extraConfig?.isFossBuild === 'true';
    const isExpoGo = Constants.appOwnership === 'expo';
    const currentVersion = Constants.expoConfig?.version || '0.0.0';
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [androidInstallerSource, setAndroidInstallerSource] = useState<'play-store' | 'sideload' | 'unknown'>(
        Platform.OS === 'android' ? 'unknown' : 'play-store'
    );

    useEffect(() => {
        if (Platform.OS !== 'android') {
            setAndroidInstallerSource('play-store');
            return;
        }
        if (isFossBuild) {
            setAndroidInstallerSource('sideload');
            return;
        }
        let cancelled = false;
        Application.getInstallReferrerAsync()
            .then((referrer) => {
                if (cancelled) return;
                const normalized = (referrer || '').trim().toLowerCase();
                setAndroidInstallerSource(normalized ? 'play-store' : 'sideload');
            })
            .catch((error) => {
                if (!cancelled) {
                    setAndroidInstallerSource('unknown');
                }
                logSettingsWarn('Failed to detect Android installer source', error);
            });
        return () => {
            cancelled = true;
        };
    }, [isFossBuild]);

    const openLink = (url: string) => Linking.openURL(url);
    const GITHUB_RELEASES_API = 'https://api.github.com/repos/dongdongbh/Mindwtr/releases/latest';
    const GITHUB_RELEASES_URL = 'https://github.com/dongdongbh/Mindwtr/releases/latest';
    const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr';
    const PLAY_STORE_LOOKUP_URL = 'https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr&hl=en_US&gl=US';
    const PLAY_STORE_MARKET_URL = 'market://details?id=tech.dongdongbh.mindwtr';
    const APP_STORE_BUNDLE_ID = Constants.expoConfig?.ios?.bundleIdentifier || 'tech.dongdongbh.mindwtr';
    const APP_STORE_LOOKUP_URL = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(APP_STORE_BUNDLE_ID)}&country=US`;
    const APP_STORE_LOOKUP_FALLBACK_URL = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(APP_STORE_BUNDLE_ID)}`;

    const persistUpdateBadge = useCallback(async (next: boolean, latestVersion?: string) => {
        onUpdateBadgeChange(next);
        try {
            await AsyncStorage.setItem(UPDATE_BADGE_AVAILABLE_KEY, next ? 'true' : 'false');
            if (next && latestVersion) {
                await AsyncStorage.setItem(UPDATE_BADGE_LATEST_KEY, latestVersion);
            } else {
                await AsyncStorage.removeItem(UPDATE_BADGE_LATEST_KEY);
            }
        } catch (error) {
            logSettingsWarn('Failed to persist update badge state', error);
        }
    }, [onUpdateBadgeChange]);

    const fetchLatestRelease = useCallback(async () => {
        const response = await fetch(GITHUB_RELEASES_API, {
            headers: {
                Accept: 'application/vnd.github.v3+json',
                'User-Agent': 'Mindwtr-App',
            },
        });
        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status}`);
        }
        return response.json();
    }, []);

    const fetchLatestAppStoreInfo = useCallback(async (): Promise<{ version: string; trackViewUrl: string | null }> => {
        const lookupUrls = [APP_STORE_LOOKUP_FALLBACK_URL, APP_STORE_LOOKUP_URL];
        let lastError: Error | null = null;
        let bestMatch: { version: string; trackViewUrl: string | null } | null = null;

        for (const baseUrl of lookupUrls) {
            const separator = baseUrl.includes('?') ? '&' : '?';
            const url = `${baseUrl}${separator}_=${Date.now()}`;
            const response = await fetch(url, {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'Mindwtr-App',
                },
                cache: 'no-store',
            });
            if (!response.ok) {
                lastError = new Error(`App Store lookup failed (${url}): ${response.status}`);
                continue;
            }
            const payload = await response.json() as { results?: { version?: unknown; trackViewUrl?: unknown }[] };
            const candidate = Array.isArray(payload.results) ? payload.results[0] : null;
            const version = typeof candidate?.version === 'string' ? candidate.version.trim() : '';
            if (!version) {
                lastError = new Error(`Unable to parse App Store version from ${url}`);
                continue;
            }
            const trackViewUrl = typeof candidate?.trackViewUrl === 'string' && candidate.trackViewUrl.trim()
                ? candidate.trackViewUrl.trim()
                : null;
            if (!bestMatch || compareVersions(version, bestMatch.version) > 0) {
                bestMatch = { version, trackViewUrl };
            }
        }

        if (bestMatch) return bestMatch;
        if (lastError) throw lastError;
        throw new Error('Unable to fetch App Store version');
    }, [APP_STORE_LOOKUP_FALLBACK_URL, APP_STORE_LOOKUP_URL]);

    const parsePlayStoreVersion = useCallback((html: string): string | null => {
        const patterns = [
            /"softwareVersion"\s*:\s*"([^"]+)"/i,
            /\\"softwareVersion\\"\s*:\s*\\"([^"]+)\\"/i,
            /itemprop="softwareVersion"[^>]*>\s*([^<]+)\s*</i,
            /"versionName"\s*:\s*"([^"]+)"/i,
        ];
        for (const pattern of patterns) {
            const match = html.match(pattern);
            const value = match?.[1]?.trim();
            if (value) return value;
        }
        return null;
    }, []);

    const fetchLatestPlayStoreVersion = useCallback(async () => {
        const response = await fetch(`${PLAY_STORE_LOOKUP_URL}&_=${Date.now()}`, {
            headers: {
                Accept: 'text/html,application/xhtml+xml',
                'User-Agent': 'Mozilla/5.0 (Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
            },
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(`Play Store lookup failed: ${response.status}`);
        }
        const html = await response.text();
        const version = parsePlayStoreVersion(html);
        if (!version) {
            throw new Error('Unable to parse Play Store version');
        }
        return version;
    }, [PLAY_STORE_LOOKUP_URL, parsePlayStoreVersion]);

    const fetchLatestComparableVersion = useCallback(async (): Promise<{ version: string; source: 'play-store' | 'app-store' | 'github-release' }> => {
        if (Platform.OS === 'android' && androidInstallerSource !== 'sideload') {
            try {
                return { version: await fetchLatestPlayStoreVersion(), source: 'play-store' };
            } catch (error) {
                logSettingsWarn('Play Store lookup failed; falling back to GitHub release', error);
                const release = await fetchLatestRelease();
                return { version: release.tag_name?.replace(/^v/, '') || '0.0.0', source: 'github-release' };
            }
        }
        if (Platform.OS === 'ios') {
            const { version } = await fetchLatestAppStoreInfo();
            return { version, source: 'app-store' };
        }
        const release = await fetchLatestRelease();
        return { version: release.tag_name?.replace(/^v/, '') || '0.0.0', source: 'github-release' };
    }, [androidInstallerSource, fetchLatestAppStoreInfo, fetchLatestPlayStoreVersion, fetchLatestRelease]);

    useEffect(() => {
        let cancelled = false;

        const checkUpdates = async () => {
            if (isExpoGo || isFossBuild) return;
            try {
                const lastCheckedRaw = await AsyncStorage.getItem(UPDATE_BADGE_LAST_CHECK_KEY);
                const lastChecked = Number.parseInt(lastCheckedRaw || '0', 10);
                if (Date.now() - lastChecked < UPDATE_BADGE_INTERVAL_MS) {
                    const storedBadge = await AsyncStorage.getItem(UPDATE_BADGE_AVAILABLE_KEY);
                    if (!cancelled) onUpdateBadgeChange(storedBadge === 'true');
                    return;
                }
                const { version } = await fetchLatestComparableVersion();
                if (cancelled) return;
                const hasUpdate = compareVersions(version, currentVersion) > 0;
                await AsyncStorage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(Date.now()));
                await persistUpdateBadge(hasUpdate, hasUpdate ? version : undefined);
            } catch (error) {
                logSettingsWarn('Silent update check failed', error);
            }
        };

        void checkUpdates();
        return () => {
            cancelled = true;
        };
    }, [currentVersion, fetchLatestComparableVersion, isExpoGo, isFossBuild, onUpdateBadgeChange, persistUpdateBadge]);

    const handleCheckUpdates = async () => {
        if (isFossBuild) {
            Alert.alert(
                localize('Updates are managed by your distribution source', '更新由发行渠道管理'),
                localize(
                    'In-app update checks are disabled in this FOSS build. Please update from your repository or package source.',
                    '此 FOSS 版本已禁用应用内更新检查。请通过你的软件源或包管理渠道更新。'
                )
            );
            return;
        }

        setIsCheckingUpdate(true);
        try {
            await AsyncStorage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(Date.now()));

            if (Platform.OS === 'android' && androidInstallerSource !== 'sideload') {
                const canOpenMarket = await Linking.canOpenURL(PLAY_STORE_MARKET_URL);
                const targetUrl = canOpenMarket ? PLAY_STORE_MARKET_URL : PLAY_STORE_URL;
                const { version: latestVersion, source } = await fetchLatestComparableVersion();
                const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
                if (hasUpdate) {
                    const updateMessage = source === 'play-store'
                        ? localize(
                            `v${currentVersion} → v${latestVersion}\n\nUpdate is available on Google Play. Open app listing now?`,
                            `v${currentVersion} → v${latestVersion}\n\nGoogle Play 已提供更新，是否立即打开应用页面？`
                        )
                        : localize(
                            `v${currentVersion} → v${latestVersion}\n\nPlay Store version lookup is temporarily unavailable. A newer GitHub release is available, and Play rollout may lag. Open app listing now?`,
                            `v${currentVersion} → v${latestVersion}\n\n暂时无法直接获取 Google Play 版本，GitHub 已有更新，Play 商店可能会延迟推送。是否立即打开应用页面？`
                        );
                    Alert.alert(localize('Update Available', '有可用更新'), updateMessage, [
                        { text: localize('Later', '稍后'), style: 'cancel' },
                        { text: localize('Open', '打开'), onPress: () => Linking.openURL(targetUrl) },
                    ]);
                    await persistUpdateBadge(true, latestVersion);
                } else {
                    const upToDateMessage = source === 'play-store'
                        ? localize('You are using the latest Google Play version!', '您正在使用 Google Play 最新版本！')
                        : localize(
                            'Play Store version lookup is temporarily unavailable. Your version matches the latest GitHub release.',
                            '暂时无法直接获取 Google Play 版本，但当前版本与 GitHub 最新发布一致。'
                        );
                    Alert.alert(localize('Up to Date', '已是最新'), upToDateMessage);
                    await persistUpdateBadge(false);
                }
                return;
            }

            if (Platform.OS === 'ios') {
                const { version: latestVersion, trackViewUrl } = await fetchLatestAppStoreInfo();
                const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
                const trackIdMatch = trackViewUrl?.match(/\/id(\d+)/i);
                const appStoreDeepLink = trackIdMatch?.[1] ? `itms-apps://apps.apple.com/app/id${trackIdMatch[1]}` : null;
                const canOpenDeepLink = appStoreDeepLink ? await Linking.canOpenURL(appStoreDeepLink) : false;
                const targetUrl = canOpenDeepLink ? appStoreDeepLink : trackViewUrl;

                if (hasUpdate) {
                    Alert.alert(
                        localize('Update Available', '有可用更新'),
                        localize(
                            `v${currentVersion} → v${latestVersion}\n\nUpdate is available on the App Store. Open app listing now?`,
                            `v${currentVersion} → v${latestVersion}\n\nApp Store 已提供更新，是否立即打开应用页面？`
                        ),
                        [
                            { text: localize('Later', '稍后'), style: 'cancel' },
                            ...(targetUrl ? [{ text: localize('Open', '打开'), onPress: () => Linking.openURL(targetUrl) }] : []),
                        ]
                    );
                    await persistUpdateBadge(true, latestVersion);
                } else {
                    Alert.alert(
                        localize('Up to Date', '已是最新'),
                        localize('You are using the latest App Store version!', '您正在使用 App Store 最新版本！')
                    );
                    await persistUpdateBadge(false);
                }
                return;
            }

            const release = await fetchLatestRelease();
            const latestVersion = release.tag_name?.replace(/^v/, '') || '0.0.0';
            const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

            if (hasUpdate) {
                const downloadUrl = release.html_url || GITHUB_RELEASES_URL;
                const changelog = release.body || localize('No changelog available', '暂无更新日志');
                Alert.alert(
                    localize('Update Available', '有可用更新'),
                    `v${currentVersion} → v${latestVersion}\n\n${localize('Changelog', '更新日志')}:\n${changelog.substring(0, 500)}${changelog.length > 500 ? '...' : ''}`,
                    [
                        { text: localize('Later', '稍后'), style: 'cancel' },
                        { text: localize('Download', '下载'), onPress: () => Linking.openURL(downloadUrl) },
                    ]
                );
                await persistUpdateBadge(true, latestVersion);
            } else {
                Alert.alert(localize('Up to Date', '已是最新'), localize('You are using the latest version!', '您正在使用最新版本！'));
                await persistUpdateBadge(false);
            }
        } catch (error) {
            logSettingsError('Update check failed:', error);
            Alert.alert(localize('Error', '错误'), localize('Failed to check for updates', '检查更新失败'));
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <SubHeader title={t('settings.about')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={styles.settingRow}>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.version')}</Text>
                        <Text style={[styles.settingValue, { color: tc.secondaryText }]}>
                            {Constants.expoConfig?.version ?? '0.1.0'}
                        </Text>
                    </View>
                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => openLink('https://github.com/dongdongbh/Mindwtr/wiki')}
                    >
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.documentation')}</Text>
                        <Text style={styles.linkText}>GitHub Wiki</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => openLink('https://ko-fi.com/dongdongbh')}
                    >
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.sponsorProject')}</Text>
                        <Text style={styles.linkText}>Ko-fi</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => openLink('https://github.com/dongdongbh/Mindwtr')}
                    >
                        <Text style={[styles.settingLabel, { color: tc.text }]}>GitHub</Text>
                        <Text style={styles.linkText}>Mindwtr</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => openLink('https://dongdongbh.tech')}
                    >
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.website')}</Text>
                        <Text style={styles.linkText}>dongdongbh.tech</Text>
                    </TouchableOpacity>
                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.license')}</Text>
                        <Text style={[styles.settingValue, { color: tc.secondaryText }]}>AGPL-3.0</Text>
                    </View>
                    {!isFossBuild && (
                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => void handleCheckUpdates()}
                            disabled={isCheckingUpdate}
                        >
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.checkForUpdates')}</Text>
                            {isCheckingUpdate ? (
                                <ActivityIndicator size="small" color="#3B82F6" />
                            ) : (
                                <Text style={styles.linkText}>{localize('Tap to check', '点击检查')}</Text>
                            )}
                        </TouchableOpacity>
                    )}
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}
