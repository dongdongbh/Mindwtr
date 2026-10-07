import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    buildAboutFeedbackSubmission,
    buildAboutSettingsModel,
    createAboutUpdateChecks,
    getAboutInstallChannel,
    getFeedbackGitHubUrl,
    resolveAndroidInstallerSource,
    submitFeedbackSubmission,
    type AboutRow,
    type AndroidInstallerSource,
} from '@mindwtr/core';
import { useToast } from '@/contexts/toast-context';
import { getDeviceLocale, resolveMobileAnalyticsVersion } from '@/lib/analytics-heartbeat';
import { collectFeedbackDiagnostics } from '@/lib/app-log';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { getPlayStoreUpdateInfoAsync } from '@/lib/play-store-updates';
import { logSettingsError, logSettingsWarn } from '@/lib/settings-utils';

import { MobileExtraConfig } from './settings.constants';
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
    const [androidInstallerSource, setAndroidInstallerSource] = useState<AndroidInstallerSource>(
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
                setAndroidInstallerSource(resolveAndroidInstallerSource(referrer));
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
    const ANDROID_PACKAGE_NAME = Constants.expoConfig?.android?.package || Application.applicationId || 'tech.dongdongbh.mindwtr';
    const APP_STORE_BUNDLE_ID = Constants.expoConfig?.ios?.bundleIdentifier || Application.applicationId || 'tech.dongdongbh.mindwtr';

    // The latest toast and words for the checks below, which RN's effect never re-ran for.
    const toastRef = useRef(showToast);
    toastRef.current = showToast;
    const trRef = useRef(tr);
    trRef.current = tr;

    // Core's update checks and Rate row (about-settings-model.ts) on RN's device.
    const updateChecks = useMemo(() => createAboutUpdateChecks({
        platform: Platform.OS,
        isFossBuild,
        isExpoGo,
        currentVersion,
        displayVersion,
        androidInstallerSource,
        androidPackageName: ANDROID_PACKAGE_NAME,
        iosBundleId: APP_STORE_BUNDLE_ID,
        storage: AsyncStorage,
        fetcher: (url, init) => fetch(url, init),
        getPlayStoreUpdateInfo: getPlayStoreUpdateInfoAsync,
        canOpenURL: (url) => Linking.canOpenURL(url),
        openURL: (url) => Linking.openURL(url),
        onUpdateBadgeChange,
        showToast: (toast) => toastRef.current(toast),
        showAlert: (title, message, buttons) => Alert.alert(title, message, buttons.map((button) => (
            button.style === 'cancel'
                ? { text: button.text, style: 'cancel' as const }
                : { text: button.text, onPress: () => Linking.openURL(button.url!) }
        ))),
        tr: (key, values) => trRef.current(key, values),
        logWarn: logSettingsWarn,
        logError: logSettingsError,
    }), [ANDROID_PACKAGE_NAME, APP_STORE_BUNDLE_ID, androidInstallerSource, currentVersion, displayVersion, isExpoGo, isFossBuild,
        onUpdateBadgeChange]);

    useEffect(() => {
        let cancelled = false;
        void updateChecks.runSilentCheck(() => cancelled);
        return () => {
            cancelled = true;
        };
    }, [updateChecks]);

    const handleCheckUpdates = async () => {
        if (isFossBuild) {
            await updateChecks.runManualCheck();
            return;
        }
        setIsCheckingUpdate(true);
        try {
            await updateChecks.runManualCheck();
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const handleSubmitFeedback = async (input: FeedbackSubmitInput) => {
        const diagnosticsLogs = input.includeDiagnostics && input.category === 'bug'
            ? await collectFeedbackDiagnostics()
            : null;
        await submitFeedbackSubmission(feedbackEndpointUrl, buildAboutFeedbackSubmission({
            category: input.category,
            email: input.email,
            message: input.message,
            displayVersion,
            build: Application.nativeBuildVersion ?? undefined,
            installChannel: getAboutInstallChannel({ isFossBuild, platform: Platform.OS, androidInstallerSource }),
            locale: getDeviceLocale(),
            platform: Platform.OS,
            platformVersion: String(Platform.Version ?? ''),
            diagnosticsLogs,
        }));
    };

    const about = buildAboutSettingsModel({ t, tr, appName, displayVersion, isFossBuild, platform: Platform.OS });
    const onRowPress = (row: AboutRow) => {
        if (row.id === 'checkForUpdates') void handleCheckUpdates();
        else if (row.id === 'rate') void updateChecks.rateApp();
        else if (row.id === 'feedback') setFeedbackOpen(true);
        else if (row.url) void openLink(row.url);
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={about.title} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={[styles.aboutAppHeader, { borderBottomColor: tc.border }]}>
                        <Image source={appIconSource} style={styles.aboutAppIcon} resizeMode="cover" />
                        <Text style={[styles.aboutAppName, { color: tc.text }]} numberOfLines={2}>
                            {about.appName}
                        </Text>
                        <Text style={[styles.aboutAppVersion, { color: tc.secondaryText }]} numberOfLines={2}>
                            {about.versionText}
                        </Text>
                    </View>
                    {about.rows.map((row) => {
                        const rowStyle = row.id === 'checkForUpdates' ? styles.settingRow : [styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }];
                        if (row.tone === 'value') {
                            return (
                                <View key={row.id} style={rowStyle}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{row.label}</Text>
                                    <Text style={[styles.settingValue, { color: tc.secondaryText }]}>{row.value}</Text>
                                </View>
                            );
                        }
                        const checking = row.id === 'checkForUpdates' && isCheckingUpdate;
                        return (
                            <TouchableOpacity
                                key={row.id}
                                style={rowStyle}
                                onPress={() => onRowPress(row)}
                                disabled={row.id === 'checkForUpdates' ? isCheckingUpdate : undefined}
                            >
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{row.label}</Text>
                                {checking ? (
                                    <ActivityIndicator size="small" color="#3B82F6" />
                                ) : (
                                    <Text style={styles.linkText}>{row.value}</Text>
                                )}
                            </TouchableOpacity>
                        );
                    })}
                </View>
            </ScrollView>
            <FeedbackSettingsModal
                visible={feedbackOpen}
                isConfigured={Boolean(feedbackEndpointUrl)}
                tr={tr}
                onClose={() => setFeedbackOpen(false)}
                onOpenGitHub={(category) => openLink(getFeedbackGitHubUrl(category))}
                onSubmit={handleSubmitFeedback}
            />
        </SafeAreaView>
    );
}
