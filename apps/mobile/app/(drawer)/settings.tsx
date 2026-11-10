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
import { buildSettingsAdvancedMenu, buildSettingsMenu, isSandboxMode, type SettingsMenuIcon } from '@mindwtr/core';

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
    normalizeSettingsScreen,
    type SettingsScreen,
    UPDATE_BADGE_AVAILABLE_KEY,
} from '@/components/settings/settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from '@/components/settings/settings.hooks';
import { SandboxSettingsScreen } from '@/components/settings/sandbox-settings-screen';


const MENU_ICONS: Record<SettingsMenuIcon, LucideIcon> = {
    Monitor, ListChecks, Layers, Bell, RefreshCw, Database, Settings2, Info, Sparkles, CalendarDays,
};

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
    const { syncBadgeAccessibilityLabel, syncBadgeColor, syncBadgeIcon } = useMobileSyncBadge();
    const [hasUpdateBadge, setHasUpdateBadge] = useState(false);
    const [search, setSearch] = useState('');

    useEffect(() => {
        AsyncStorage.getItem(UPDATE_BADGE_AVAILABLE_KEY)
            .then((value) => setHasUpdateBadge(value === 'true'))
            .catch(() => setHasUpdateBadge(false));
    }, []);

    const currentScreen = useMemo<SettingsScreen>(() => {
        const rawScreen = Array.isArray(settingsScreen) ? settingsScreen[0] : settingsScreen;
        return normalizeSettingsScreen(rawScreen);
    }, [settingsScreen]);
    const showOnboardingHandoff = useMemo(() => {
        const rawHandoff = Array.isArray(onboardingHandoff) ? onboardingHandoff[0] : onboardingHandoff;
        return rawHandoff === '1';
    }, [onboardingHandoff]);
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
        const advancedMenu = buildSettingsAdvancedMenu(t);
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={advancedMenu.title} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        {advancedMenu.rows.map((row, rowIndex) => (
                            <MenuItem
                                key={row.id}
                                title={row.title}
                                description={row.description}
                                icon={MENU_ICONS[row.icon]}
                                isLast={rowIndex === advancedMenu.rows.length - 1}
                                onPress={() => pushSettingsScreen(row.id)}
                            />
                        ))}
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }


    const menu = buildSettingsMenu({
        t,
        query: search,
        sync: { color: syncBadgeColor, accessibilityLabel: syncBadgeAccessibilityLabel, icon: syncBadgeIcon },
        updateAvailable: hasUpdateBadge,
    });
    const filteredGroups = menu.groups;

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[searchStyles.searchBar, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                    <Search color={tc.secondaryText} size={18} strokeWidth={2} />
                    <TextInput
                        value={search}
                        onChangeText={setSearch}
                        placeholder={menu.searchPlaceholder}
                        placeholderTextColor={tc.secondaryText}
                        style={[searchStyles.searchInput, { color: tc.text }]}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="search"
                        clearButtonMode="while-editing"
                        accessibilityLabel={menu.searchPlaceholder}
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
                                    icon={MENU_ICONS[row.icon]}
                                    isLast={rowIndex === group.length - 1}
                                    onPress={() => pushSettingsScreen(row.id)}
                                    showIndicator={row.showIndicator}
                                    indicatorColor={row.indicatorColor}
                                    indicatorIcon={row.indicatorIcon}
                                    indicatorAccessibilityLabel={row.indicatorAccessibilityLabel}
                                />
                            ))}
                        </View>
                    ))}
                    {menu.noMatches !== null ? (
                        <Text style={[searchStyles.noResults, { color: tc.secondaryText }]}>
                            {menu.noMatches}
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
