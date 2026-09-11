import React, { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
    Bell,
    CalendarDays,
    Database,
    Info,
    Layers,
    ListChecks,
    Monitor,
    RefreshCw,
    Search,
    Settings2,
    Sparkles,
    type LucideIcon,
} from 'lucide-react-native';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { isSandboxMode } from '@mindwtr/core';

import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { AboutSettingsScreen } from '@/components/settings/about-settings-screen';
import { AISettingsScreen } from '@/components/settings/ai-settings-screen';
import { CalendarSettingsScreen } from '@/components/settings/calendar-settings-screen';
import { DataSettingsScreen, SyncSettingsScreen } from '@/components/settings/sync-settings-screen';
import { GeneralSettingsScreen } from '@/components/settings/general-settings-screen';
import { GtdSettingsScreen } from '@/components/settings/gtd-settings-screen';
import { ManageSettingsScreen } from '@/components/settings/manage-settings-screen';
import { NotificationsSettingsScreen } from '@/components/settings/notifications-settings-screen';
import { MenuItem, SettingsTopBar } from '@/components/settings/settings.shell';
import { styles } from '@/components/settings/settings.styles';
import {
    buildSettingsMenuSearchText,
    findSettingsMenuMatch,
    SETTINGS_SCREEN_SET,
    settingsMenuMatchesQuery,
    type SettingsMenuRowId,
    type SettingsScreen,
    UPDATE_BADGE_AVAILABLE_KEY,
} from '@/components/settings/settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from '@/components/settings/settings.hooks';
import { SandboxSettingsScreen } from '@/components/settings/sandbox-settings-screen';

export default function SettingsPage() {
    if (isSandboxMode()) return <SandboxSettingsScreen />;
    return <PersonalSettingsPage />;
}

function PersonalSettingsPage() {
    const router = useRouter();
    const tc = useThemeColors();
    const { t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const { onboardingHandoff, settingsScreen } = useLocalSearchParams<{
        onboardingHandoff?: string | string[];
        settingsScreen?: string | string[];
    }>();
    const { syncBadgeAccessibilityLabel, syncBadgeColor } = useMobileSyncBadge();
    const [hasUpdateBadge, setHasUpdateBadge] = useState(false);
    const [search, setSearch] = useState('');

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
    const showOnboardingHandoff = useMemo(() => {
        const rawHandoff = Array.isArray(onboardingHandoff) ? onboardingHandoff[0] : onboardingHandoff;
        return rawHandoff === '1';
    }, [onboardingHandoff]);
    const dataLabel = t('settings.data');
    const menuDescriptions = useMemo(
        () => ({
            general: t('settings.menuDesc.general'),
            gtd: t('settings.menuDesc.gtd'),
            manage: t('settings.menuDesc.manage'),
            notifications: t('settings.menuDesc.notifications'),
            sync: t('settings.menuDesc.sync'),
            data: t('settings.menuDesc.data'),
            advanced: t('settings.menuDesc.advanced'),
            about: t('settings.menuDesc.about'),
            ai: t('settings.menuDesc.ai'),
            calendar: t('settings.menuDesc.calendar'),
        }),
        [t],
    );

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
        || currentScreen === 'gtd-capture'
        || currentScreen === 'gtd-inbox'
        || currentScreen === 'gtd-pomodoro'
        || currentScreen === 'gtd-review'
        || currentScreen === 'gtd-time-estimates'
        || currentScreen === 'gtd-task-editor'
    ) {
        return <GtdSettingsScreen onNavigate={pushSettingsScreen} screen={currentScreen} />;
    }

    if (currentScreen === 'calendar') {
        return <CalendarSettingsScreen />;
    }

    if (currentScreen === 'sync') {
        return <SyncSettingsScreen onboardingHandoff={showOnboardingHandoff} />;
    }

    if (currentScreen === 'data') {
        return <DataSettingsScreen onboardingHandoff={showOnboardingHandoff} />;
    }

    if (currentScreen === 'about') {
        return <AboutSettingsScreen onUpdateBadgeChange={setHasUpdateBadge} />;
    }

    if (currentScreen === 'advanced') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={t('settings.advanced')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        <MenuItem
                            title={t('settings.ai')}
                            description={menuDescriptions.ai}
                            icon={Sparkles}
                            onPress={() => pushSettingsScreen('ai')}
                        />
                        <MenuItem
                            title={t('settings.calendar')}
                            description={menuDescriptions.calendar}
                            icon={CalendarDays}
                            isLast
                            onPress={() => pushSettingsScreen('calendar')}
                        />
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    type MenuRow = {
        id: SettingsMenuRowId;
        title: string;
        description?: string;
        icon: LucideIcon;
        onPress: () => void;
        showIndicator?: boolean;
        indicatorColor?: string;
        indicatorAccessibilityLabel?: string;
    };

    const menuGroups: MenuRow[][] = [
        [
            { id: 'general', title: t('settings.general'), description: menuDescriptions.general, icon: Monitor, onPress: () => pushSettingsScreen('general') },
            { id: 'gtd', title: t('settings.gtd'), description: menuDescriptions.gtd, icon: ListChecks, onPress: () => pushSettingsScreen('gtd') },
            { id: 'manage', title: t('settings.manage'), description: menuDescriptions.manage, icon: Layers, onPress: () => pushSettingsScreen('manage') },
            { id: 'notifications', title: t('settings.notifications'), description: menuDescriptions.notifications, icon: Bell, onPress: () => pushSettingsScreen('notifications') },
        ],
        [
            {
                id: 'sync',
                title: t('settings.sync'),
                description: menuDescriptions.sync,
                icon: RefreshCw,
                onPress: () => pushSettingsScreen('sync'),
                showIndicator: Boolean(syncBadgeColor),
                indicatorColor: syncBadgeColor,
                indicatorAccessibilityLabel: syncBadgeAccessibilityLabel,
            },
            { id: 'data', title: dataLabel, description: menuDescriptions.data, icon: Database, onPress: () => pushSettingsScreen('data') },
        ],
        [
            { id: 'advanced', title: t('settings.advanced'), description: menuDescriptions.advanced, icon: Settings2, onPress: () => pushSettingsScreen('advanced') },
            {
                id: 'about',
                title: t('settings.about'),
                description: menuDescriptions.about,
                icon: Info,
                onPress: () => pushSettingsScreen('about'),
                showIndicator: hasUpdateBadge,
                indicatorAccessibilityLabel: hasUpdateBadge ? t('settings.updateAvailable') : undefined,
            },
        ],
    ];

    const filteredGroups = menuGroups
        .map((group) =>
            group
                .filter((row) =>
                    settingsMenuMatchesQuery(
                        buildSettingsMenuSearchText(row.id, row.title, row.description, t),
                        search,
                    ),
                )
                // While searching, the row's second line says which setting
                // matched and where it lives, instead of the generic blurb.
                .map((row) => {
                    const match = findSettingsMenuMatch(row.id, row.title, t, search);
                    return match ? { ...row, description: `${match.title} · ${match.path}` } : row;
                }),
        )
        .filter((group) => group.length > 0);

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[searchStyles.searchBar, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <Search color={tc.secondaryText} size={18} strokeWidth={2} />
                    <TextInput
                        value={search}
                        onChangeText={setSearch}
                        placeholder={t('common.search')}
                        placeholderTextColor={tc.secondaryText}
                        style={[searchStyles.searchInput, { color: tc.text }]}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="search"
                        clearButtonMode="while-editing"
                        accessibilityLabel={t('common.search')}
                    />
                </View>
                <View style={styles.menuGroupStack}>
                    {filteredGroups.map((group) => (
                        <View key={group[0].id} style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                            {group.map((row, rowIndex) => (
                                <MenuItem
                                    key={row.id}
                                    title={row.title}
                                    description={row.description}
                                    icon={row.icon}
                                    isLast={rowIndex === group.length - 1}
                                    onPress={row.onPress}
                                    showIndicator={row.showIndicator}
                                    indicatorColor={row.indicatorColor}
                                    indicatorAccessibilityLabel={row.indicatorAccessibilityLabel}
                                />
                            ))}
                        </View>
                    ))}
                    {filteredGroups.length === 0 ? (
                        <Text style={[searchStyles.noResults, { color: tc.secondaryText }]}>
                            {t('common.noMatches')}
                        </Text>
                    ) : null}
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const searchStyles = StyleSheet.create({
    searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 16,
        paddingHorizontal: 12,
        height: 44,
        borderWidth: 1,
        borderRadius: 12,
    },
    searchInput: {
        flex: 1,
        fontSize: 15,
        paddingVertical: 0,
    },
    noResults: {
        textAlign: 'center',
        fontSize: 14,
        paddingVertical: 24,
    },
});
