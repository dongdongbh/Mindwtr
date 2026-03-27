import React, { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { AboutSettingsScreen } from '@/components/settings/about-settings-screen';
import { AISettingsScreen } from '@/components/settings/ai-settings-screen';
import { CalendarSettingsScreen } from '@/components/settings/calendar-settings-screen';
import { GeneralSettingsScreen } from '@/components/settings/general-settings-screen';
import { GtdSettingsScreen } from '@/components/settings/gtd-settings-screen';
import { ManageSettingsScreen } from '@/components/settings/manage-settings-screen';
import { NotificationsSettingsScreen } from '@/components/settings/notifications-settings-screen';
import { MenuItem, SettingsTopBar, SubHeader } from '@/components/settings/settings.shell';
import { styles } from '@/components/settings/settings.styles';
import {
    SETTINGS_SCREEN_SET,
    type SettingsScreen,
    UPDATE_BADGE_AVAILABLE_KEY,
} from '@/components/settings/settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from '@/components/settings/settings.hooks';
import { SyncSettingsScreen } from '@/components/settings/sync-settings-screen';

export default function SettingsPage() {
    const router = useRouter();
    const tc = useThemeColors();
    const { t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const { settingsScreen } = useLocalSearchParams<{ settingsScreen?: string | string[] }>();
    const { syncBadgeAccessibilityLabel, syncBadgeColor } = useMobileSyncBadge();
    const [hasUpdateBadge, setHasUpdateBadge] = useState(false);

    useEffect(() => {
        AsyncStorage.getItem(UPDATE_BADGE_AVAILABLE_KEY)
            .then((value) => setHasUpdateBadge(value === 'true'))
            .catch(() => setHasUpdateBadge(false));
    }, []);

    const currentScreen = useMemo<SettingsScreen>(() => {
        const rawScreen = Array.isArray(settingsScreen) ? settingsScreen[0] : settingsScreen;
        if (!rawScreen) return 'main';
        return SETTINGS_SCREEN_SET[rawScreen as SettingsScreen] ? (rawScreen as SettingsScreen) : 'main';
    }, [settingsScreen]);

    const pushSettingsScreen = (nextScreen: SettingsScreen) => {
        if (nextScreen === 'main') {
            router.push('/settings');
            return;
        }
        router.push({ pathname: '/settings', params: { settingsScreen: nextScreen } });
    };

    if (currentScreen === 'notifications') {
        return <NotificationsSettingsScreen />;
    }

    if (currentScreen === 'general') {
        return <GeneralSettingsScreen />;
    }

    if (currentScreen === 'ai') {
        return <AISettingsScreen />;
    }

    if (currentScreen === 'manage') {
        return <ManageSettingsScreen />;
    }

    if (
        currentScreen === 'gtd'
        || currentScreen === 'gtd-archive'
        || currentScreen === 'gtd-time-estimates'
        || currentScreen === 'gtd-task-editor'
    ) {
        return <GtdSettingsScreen onNavigate={pushSettingsScreen} screen={currentScreen} />;
    }

    if (currentScreen === 'calendar') {
        return <CalendarSettingsScreen />;
    }

    if (currentScreen === 'sync') {
        return <SyncSettingsScreen />;
    }

    if (currentScreen === 'about') {
        return <AboutSettingsScreen onUpdateBadgeChange={setHasUpdateBadge} />;
    }

    if (currentScreen === 'advanced') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar />
                <SubHeader title={t('settings.advanced')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        <MenuItem title={t('settings.ai')} onPress={() => pushSettingsScreen('ai')} />
                        <MenuItem title={t('settings.calendar')} onPress={() => pushSettingsScreen('calendar')} />
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[styles.menuCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
                    <MenuItem title={t('settings.general')} onPress={() => pushSettingsScreen('general')} />
                    <MenuItem title={t('settings.gtd')} onPress={() => pushSettingsScreen('gtd')} />
                    <MenuItem title={t('settings.manage')} onPress={() => pushSettingsScreen('manage')} />
                    <MenuItem title={t('settings.notifications')} onPress={() => pushSettingsScreen('notifications')} />
                    <MenuItem
                        title={t('settings.dataSync')}
                        onPress={() => pushSettingsScreen('sync')}
                        showIndicator={Boolean(syncBadgeColor)}
                        indicatorColor={syncBadgeColor}
                        indicatorAccessibilityLabel={syncBadgeAccessibilityLabel}
                    />
                    <MenuItem title={t('settings.advanced')} onPress={() => pushSettingsScreen('advanced')} />
                    <MenuItem title={t('settings.about')} onPress={() => pushSettingsScreen('about')} showIndicator={hasUpdateBadge} />
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}
