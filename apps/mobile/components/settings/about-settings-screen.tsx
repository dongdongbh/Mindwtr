import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';

import { submitFeedbackSubmission } from '@mindwtr/core';
import { useToast } from '@/contexts/toast-context';
import { getDeviceLocale, resolveMobileAnalyticsVersion } from '@/lib/analytics-heartbeat';
import { collectFeedbackDiagnostics } from '@/lib/app-log';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { getPlayStoreUpdateInfoAsync } from '@/lib/play-store-updates';
import { compareVersions, logSettingsError, logSettingsWarn } from '@/lib/settings-utils';

import {
    MobileExtraConfig,
    UPDATE_BADGE_AVAILABLE_KEY,
    UPDATE_BADGE_INTERVAL_MS,
    UPDATE_BADGE_LAST_CHECK_KEY,
    UPDATE_BADGE_LATEST_KEY,
} from './settings.constants';
import { FeedbackSettingsModal, type FeedbackSubmitInput } from './feedback-settings-modal';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';

const appIconSource = require('../../assets/images/icon.png');

const parseExtraBool = (value: unknown): boolean =>
    value === true || value === 1 || value === '1' || value === 'true';

export function AboutSettingsScreen({
    onUpdateBadgeChange,
}: {
    onUpdateBadgeChange: (next: boolean) => void;
}) {
    const tc = useThemeColors();
    const { showToast } = useToast();
    const { tr, t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
    const isFossBuild = parseExtraBool(extraConfig?.isFossBuild);
    const isExpoGo = Constants.appOwnership === 'expo';
    const currentVersion = Constants.expoConfig?.version || '0.0.0';
    const displayVersion = resolveMobileAnalyticsVersion(currentVersion, extraConfig?.analyticsReleaseVersion);
    const feedbackEndpointUrl = String(extraConfig?.feedbackEndpointUrl ?? '').trim();
    const appName = Constants.expoConfig?.name || Application.applicationName || 'Mindwtr';
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [feedbackOpen, setFeedbackOpen] = useState(false);
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
    const GITHUB_ISSUES_URL = 'https://github.com/dongdongbh/Mindwtr/issues/new/choose';
    const GITHUB_RELEASES_API = 'https://api.github.com/repos/dongdongbh/Mindwtr/releases/latest';
    const GITHUB_RELEASES_URL = 'https://github.com/dongdongbh/Mindwtr/releases/latest';
    const ANDROID_PACKAGE_NAME = Constants.expoConfig?.android?.package || Application.applicationId || 'tech.dongdongbh.mindwtr';
    const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE_NAME}`;
    const PLAY_STORE_MARKET_URL = `market://details?id=${ANDROID_PACKAGE_NAME}`;
    const APP_STORE_BUNDLE_ID = Constants.expoConfig?.ios?.bundleIdentifier || Application.applicationId || 'tech.dongdongbh.mindwtr';
    const APP_STORE_LOOKUP_URL = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(APP_STORE_BUNDLE_ID)}&country=US`;
    const APP_STORE_LOOKUP_FALLBACK_URL = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(APP_STORE_BUNDLE_ID)}`;
    const canRateInStore = !isFossBuild && (Platform.OS === 'android' || Platform.OS === 'ios');

    type AndroidComparableVersionResult =
        | { source: 'play-store'; updateAvailable: boolean; availableVersionCode: number | null }
        | { source: 'github-release'; version: string };

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

    const fetchAndroidComparableVersion = useCallback(async (): Promise<AndroidComparableVersionResult> => {
        if (androidInstallerSource === 'sideload') {
            const release = await fetchLatestRelease();
            return { version: release.tag_name?.replace(/^v/, '') || '0.0.0', source: 'github-release' };
        }
        try {
            const info = await getPlayStoreUpdateInfoAsync();
            return {
                source: 'play-store',
                updateAvailable: info.updateAvailable,
                availableVersionCode: info.availableVersionCode,
            };
        } catch (error) {
            logSettingsWarn('Play Store update API failed; falling back to GitHub release', error);
            const release = await fetchLatestRelease();
            return { version: release.tag_name?.replace(/^v/, '') || '0.0.0', source: 'github-release' };
        }
    }, [androidInstallerSource, fetchLatestRelease]);

    const fetchLatestComparableVersion = useCallback(async (): Promise<{ version: string; source: 'app-store' | 'github-release' }> => {
        if (Platform.OS === 'ios') {
            const { version } = await fetchLatestAppStoreInfo();
            return { version, source: 'app-store' };
        }
        const release = await fetchLatestRelease();
        return { version: release.tag_name?.replace(/^v/, '') || '0.0.0', source: 'github-release' };
    }, [fetchLatestAppStoreInfo, fetchLatestRelease]);

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
                const comparable = Platform.OS === 'android'
                    ? await fetchAndroidComparableVersion()
                    : await fetchLatestComparableVersion();
                if (cancelled) return;
                const hasUpdate = comparable.source === 'play-store'
                    ? comparable.updateAvailable
                    : compareVersions(comparable.version, currentVersion) > 0;
                await AsyncStorage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(Date.now()));
                await persistUpdateBadge(
                    hasUpdate,
                    hasUpdate && comparable.source !== 'play-store' ? comparable.version : undefined
                );
            } catch (error) {
                logSettingsWarn('Silent update check failed', error);
            }
        };

        void checkUpdates();
        return () => {
            cancelled = true;
        };
    }, [currentVersion, fetchAndroidComparableVersion, fetchLatestComparableVersion, isExpoGo, isFossBuild, onUpdateBadgeChange, persistUpdateBadge]);

    const handleCheckUpdates = async () => {
        if (isFossBuild) {
            showToast({
                title: tr('settings.aboutMobile.updatesAreManagedByYourDistributionSource'),
                message: tr('settings.aboutMobile.inAppUpdateChecksAreDisabledInThisFossBuild'),
                tone: 'info',
                durationMs: 4800,
            });
            return;
        }

        setIsCheckingUpdate(true);
        try {
            await AsyncStorage.setItem(UPDATE_BADGE_LAST_CHECK_KEY, String(Date.now()));

            if (Platform.OS === 'android' && androidInstallerSource !== 'sideload') {
                const canOpenMarket = await Linking.canOpenURL(PLAY_STORE_MARKET_URL);
                const targetUrl = canOpenMarket ? PLAY_STORE_MARKET_URL : PLAY_STORE_URL;
                const result = await fetchAndroidComparableVersion();
                const hasUpdate = result.source === 'play-store'
                    ? result.updateAvailable
                    : compareVersions(result.version, currentVersion) > 0;
                if (hasUpdate) {
                    const updateMessage = result.source === 'play-store'
                        ? tr('settings.aboutMobile.updateIsAvailableOnGooglePlayOpenAppListingNow')
                        : tr('settings.aboutMobile.googlePlayUpdateAvailableWithVersions', { currentVersion: displayVersion, latestVersion: result.version });
                    Alert.alert(tr('settings.updateAvailable'), updateMessage, [
                        { text: tr('settings.later'), style: 'cancel' },
                        { text: tr('attachments.open'), onPress: () => Linking.openURL(targetUrl) },
                    ]);
                    await persistUpdateBadge(true, result.source === 'github-release' ? result.version : undefined);
                } else {
                    const upToDateMessage = result.source === 'play-store'
                        ? tr('settings.aboutMobile.youAreUsingTheLatestGooglePlayVersion')
                        : tr('settings.aboutMobile.googlePlayCheckWasUnavailableButYourVersionMatchesThe');
                    showToast({
                        title: tr('settings.aboutMobile.upToDate'),
                        message: upToDateMessage,
                        tone: 'success',
                    });
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
                        tr('settings.updateAvailable'),
                        tr('settings.aboutMobile.appStoreUpdateAvailableWithVersions', { currentVersion: displayVersion, latestVersion }),
                        [
                            { text: tr('settings.later'), style: 'cancel' },
                            ...(targetUrl ? [{ text: tr('attachments.open'), onPress: () => Linking.openURL(targetUrl) }] : []),
                        ]
                    );
                    await persistUpdateBadge(true, latestVersion);
                } else {
                    showToast({
                        title: tr('settings.aboutMobile.upToDate'),
                        message: tr('settings.aboutMobile.youAreUsingTheLatestAppStoreVersion'),
                        tone: 'success',
                    });
                    await persistUpdateBadge(false);
                }
                return;
            }

            const release = await fetchLatestRelease();
            const latestVersion = release.tag_name?.replace(/^v/, '') || '0.0.0';
            const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

            if (hasUpdate) {
                const downloadUrl = release.html_url || GITHUB_RELEASES_URL;
                const changelog = release.body || tr('settings.noChangelog');
                Alert.alert(
                    tr('settings.updateAvailable'),
                    `v${displayVersion} → v${latestVersion}\n\n${tr('settings.changelog')}:\n${changelog.substring(0, 500)}${changelog.length > 500 ? '...' : ''}`,
                    [
                        { text: tr('settings.later'), style: 'cancel' },
                        { text: tr('attachments.download'), onPress: () => Linking.openURL(downloadUrl) },
                    ]
                );
                await persistUpdateBadge(true, latestVersion);
            } else {
                showToast({
                    title: tr('settings.aboutMobile.upToDate'),
                    message: tr('settings.upToDate'),
                    tone: 'success',
                });
                await persistUpdateBadge(false);
            }
        } catch (error) {
            logSettingsError('Update check failed:', error);
            showToast({
                title: tr('settings.syncMobile.error'),
                message: tr('settings.checkFailed'),
                tone: 'warning',
            });
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const handleRateApp = async () => {
        try {
            if (Platform.OS === 'android') {
                try {
                    await Linking.openURL(PLAY_STORE_MARKET_URL);
                } catch {
                    await Linking.openURL(PLAY_STORE_URL);
                }
                return;
            }

            if (Platform.OS === 'ios') {
                const { trackViewUrl } = await fetchLatestAppStoreInfo();
                const trackIdMatch = trackViewUrl?.match(/\/id(\d+)/i);
                const reviewDeepLink = trackIdMatch?.[1]
                    ? `itms-apps://itunes.apple.com/app/id${trackIdMatch[1]}?action=write-review`
                    : null;
                const canOpenReview = reviewDeepLink ? await Linking.canOpenURL(reviewDeepLink) : false;
                const targetUrl = canOpenReview ? reviewDeepLink : trackViewUrl;
                if (!targetUrl) throw new Error('App Store listing unavailable');
                await Linking.openURL(targetUrl);
            }
        } catch (error) {
            logSettingsWarn('Failed to open app store rating page', error);
            showToast({
                title: tr('settings.aboutMobile.storeUnavailable'),
                message: tr('settings.aboutMobile.couldNotOpenTheAppStoreRatingPagePleaseTry'),
                tone: 'warning',
            });
        }
    };

    const getInstallChannel = () => {
        if (isFossBuild) return 'fdroid';
        if (Platform.OS === 'ios') return 'app-store';
        if (Platform.OS === 'android') return androidInstallerSource;
        return Platform.OS || 'mobile';
    };

    const handleSubmitFeedback = async (input: FeedbackSubmitInput) => {
        const diagnosticsLogs = input.includeDiagnostics && input.category === 'bug'
            ? await collectFeedbackDiagnostics()
            : null;
        await submitFeedbackSubmission(feedbackEndpointUrl, {
            category: input.category,
            email: input.email,
            message: input.message,
            metadata: {
                appVersion: displayVersion,
                build: Application.nativeBuildVersion ?? undefined,
                installChannel: getInstallChannel(),
                locale: getDeviceLocale(),
                os: `${Platform.OS} ${String(Platform.Version ?? '')}`.trim(),
                platform: Platform.OS,
            },
            diagnostics: diagnosticsLogs ? { logs: diagnosticsLogs } : undefined,
        });
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={t('settings.about')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={[styles.aboutAppHeader, { borderBottomColor: tc.border }]}>
                        <Image source={appIconSource} style={styles.aboutAppIcon} resizeMode="cover" />
                        <Text style={[styles.aboutAppName, { color: tc.text }]} numberOfLines={2}>
                            {appName}
                        </Text>
                        <Text style={[styles.aboutAppVersion, { color: tc.secondaryText }]} numberOfLines={2}>
                            v{displayVersion}
                        </Text>
                    </View>
                    {!isFossBuild && (
                        <TouchableOpacity
                            style={styles.settingRow}
                            onPress={() => void handleCheckUpdates()}
                            disabled={isCheckingUpdate}
                        >
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.checkForUpdates')}</Text>
                            {isCheckingUpdate ? (
                                <ActivityIndicator size="small" color="#3B82F6" />
                            ) : (
                                <Text style={styles.linkText}>{tr('settings.aboutMobile.tapToCheck')}</Text>
                            )}
                        </TouchableOpacity>
                    )}
                    {canRateInStore && (
                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => void handleRateApp()}
                        >
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{tr('settings.aboutMobile.rateOurApp')}</Text>
                            <Text style={styles.linkText}>{Platform.OS === 'ios' ? 'App Store' : 'Google Play'}</Text>
                        </TouchableOpacity>
                    )}
                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => setFeedbackOpen(true)}
                    >
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{tr('settings.feedback')}</Text>
                        <Text style={styles.linkText}>{tr('settings.feedbackSubmit')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => openLink('https://docs.mindwtr.app')}
                    >
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.documentation')}</Text>
                        <Text style={styles.linkText}>{tr('settings.documentationLinkValue')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => openLink('https://youtube.com/playlist?list=PLLwV6zeTfB_k')}
                    >
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.videoTutorials')}</Text>
                        <Text style={styles.linkText}>YouTube</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => openLink('https://mindwtr.app/privacy')}
                    >
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.privacy')}</Text>
                        <Text style={styles.linkText}>mindwtr.app/privacy</Text>
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
                        onPress={() => openLink('https://mindwtr.app/donate?src=app_about')}
                    >
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.sponsorProject')}</Text>
                        <Text style={styles.linkText}>{tr('settings.donateLinkValue')}</Text>
                    </TouchableOpacity>
                    <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.license')}</Text>
                        <Text style={[styles.settingValue, { color: tc.secondaryText }]}>AGPL-3.0</Text>
                    </View>
                </View>
            </ScrollView>
            <FeedbackSettingsModal
                visible={feedbackOpen}
                isConfigured={Boolean(feedbackEndpointUrl)}
                tr={tr}
                onClose={() => setFeedbackOpen(false)}
                onOpenIssue={() => openLink(GITHUB_ISSUES_URL)}
                onSubmit={handleSubmitFeedback}
            />
        </SafeAreaView>
    );
}
