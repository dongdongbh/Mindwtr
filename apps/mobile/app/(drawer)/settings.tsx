import React, { useState, useEffect } from 'react';
import Constants from 'expo-constants';
import {
    View,
    Text,
    Switch,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Linking,
    Alert,
    ActivityIndicator,
    BackHandler,
    Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage, Language } from '../../contexts/language-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useTaskStore } from '@mindwtr/core';
import { pickAndParseSyncFile, exportData } from '../../lib/storage-file';
import { performMobileSync, SYNC_PATH_KEY } from '../../lib/sync-service';

type SettingsScreen = 'main' | 'appearance' | 'language' | 'notifications' | 'sync' | 'about';

const LANGUAGES: { id: Language; native: string }[] = [
    { id: 'en', native: 'English' },
    { id: 'zh', native: '中文' },
];

export default function SettingsPage() {
    const { themeMode, setThemeMode, isDark } = useTheme();
    const { language, setLanguage, t } = useLanguage();
    const { tasks, projects, settings, fetchData, updateSettings } = useTaskStore();
    const [isSyncing, setIsSyncing] = useState(false);
    const [currentScreen, setCurrentScreen] = useState<SettingsScreen>('main');
    const [syncPath, setSyncPath] = useState<string | null>(null);
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

    const tc = useThemeColors();
    const notificationsEnabled = settings.notificationsEnabled !== false;

    // Load sync path on mount
    useEffect(() => {
        AsyncStorage.getItem(SYNC_PATH_KEY).then(path => {
            if (path) setSyncPath(path);
        });
    }, []);

    // Handle Android hardware back button
    useEffect(() => {
        const onBackPress = () => {
            if (currentScreen !== 'main') {
                setCurrentScreen('main');
                return true; // prevent default behavior
            }
            return false;
        };

        const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);

        return () => subscription.remove();
    }, [currentScreen]);

    const toggleDarkMode = () => setThemeMode(isDark ? 'light' : 'dark');
    const toggleSystemMode = (useSystem: boolean) => setThemeMode(useSystem ? 'system' : (isDark ? 'dark' : 'light'));
    const openLink = (url: string) => Linking.openURL(url);

    const GITHUB_RELEASES_API = 'https://api.github.com/repos/dongdongbh/Mindwtr/releases/latest';
    const GITHUB_RELEASES_URL = 'https://github.com/dongdongbh/Mindwtr/releases/latest';

    const handleCheckUpdates = async () => {
        setIsCheckingUpdate(true);
        try {
            const response = await fetch(GITHUB_RELEASES_API, {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'Mindwtr-App'
                }
            });

            if (!response.ok) {
                throw new Error(`GitHub API error: ${response.status}`);
            }

            const release = await response.json();
            const latestVersion = release.tag_name?.replace(/^v/, '') || '0.0.0';
            const currentVersion = Constants.expoConfig?.version || '0.0.0';

            // Compare versions
            const compareVersions = (v1: string, v2: string): number => {
                const parts1 = v1.split('.').map(Number);
                const parts2 = v2.split('.').map(Number);
                for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
                    const p1 = parts1[i] || 0;
                    const p2 = parts2[i] || 0;
                    if (p1 > p2) return 1;
                    if (p1 < p2) return -1;
                }
                return 0;
            };

            const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

            if (hasUpdate) {
                // Find APK download URL
                let downloadUrl = GITHUB_RELEASES_URL;
                if (Platform.OS === 'android' && release.assets) {
                    const apkAsset = release.assets.find((a: { name: string }) => a.name.endsWith('.apk'));
                    if (apkAsset) {
                        downloadUrl = apkAsset.browser_download_url;
                    }
                }

                const changelog = release.body || (language === 'zh' ? '暂无更新日志' : 'No changelog available');

                Alert.alert(
                    language === 'zh' ? '有可用更新' : 'Update Available',
                    `v${currentVersion} → v${latestVersion}\n\n${language === 'zh' ? '更新日志' : 'Changelog'}:\n${changelog.substring(0, 500)}${changelog.length > 500 ? '...' : ''}`,
                    [
                        {
                            text: language === 'zh' ? '稍后' : 'Later',
                            style: 'cancel'
                        },
                        {
                            text: language === 'zh' ? '下载' : 'Download',
                            onPress: () => Linking.openURL(downloadUrl)
                        }
                    ]
                );
            } else {
                Alert.alert(
                    language === 'zh' ? '已是最新' : 'Up to Date',
                    language === 'zh' ? '您正在使用最新版本！' : 'You are using the latest version!'
                );
            }
        } catch (error) {
            console.error('Update check failed:', error);
            Alert.alert(
                language === 'zh' ? '错误' : 'Error',
                language === 'zh' ? '检查更新失败' : 'Failed to check for updates'
            );
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    // Set sync directory by picking a file (we'll use the file's directory)
    const handleSetSyncPath = async () => {
        try {
            const result = await pickAndParseSyncFile();
            if (result) {
                // Get the file URI that was picked
                const fileUri = (result as { __fileUri: string }).__fileUri;
                if (fileUri) {
                    await AsyncStorage.setItem(SYNC_PATH_KEY, fileUri);
                    setSyncPath(fileUri);
                    Alert.alert(
                        language === 'zh' ? '成功' : 'Success',
                        language === 'zh' ? '同步文件已设置' : 'Sync file set successfully'
                    );
                }
            }
        } catch (error) {
            console.error(error);
            Alert.alert(language === 'zh' ? '错误' : 'Error', language === 'zh' ? '设置失败' : 'Failed to set sync path');
        }
    };

    // Sync from stored path
    const handleSync = async () => {
        if (!syncPath) {
            Alert.alert(
                language === 'zh' ? '提示' : 'Notice',
                language === 'zh' ? '请先设置同步文件' : 'Please set a sync file first'
            );
            return;
        }

        setIsSyncing(true);
        try {
            const result = await performMobileSync(syncPath);
            if (result.success) {
                Alert.alert(
                    language === 'zh' ? '成功' : 'Success',
                    language === 'zh' ? '同步完成！' : 'Sync completed!'
                );
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } catch (error) {
            console.error(error);
            Alert.alert(language === 'zh' ? '错误' : 'Error', language === 'zh' ? '同步失败' : 'Sync failed');
        } finally {
            setIsSyncing(false);
        }
    };

    const handleBackup = async () => {
        setIsSyncing(true);
        try {
            await exportData({ tasks, projects, settings });
        } catch (error) {
            console.error(error);
            Alert.alert(language === 'zh' ? '错误' : 'Error', language === 'zh' ? '导出失败' : 'Failed to export data');
        } finally {
            setIsSyncing(false);
        }
    };

    // Sub-screen header
    const SubHeader = ({ title }: { title: string }) => (
        <View style={styles.subHeader}>
            <Text style={[styles.subHeaderTitle, { color: tc.text }]}>{title}</Text>
        </View>
    );

    // Menu Item
    const MenuItem = ({ title, onPress }: { title: string; onPress: () => void }) => (
        <TouchableOpacity style={[styles.menuItem, { borderBottomColor: tc.border }]} onPress={onPress}>
            <Text style={[styles.menuLabel, { color: tc.text }]}>{title}</Text>
            <Text style={[styles.chevron, { color: tc.secondaryText }]}>›</Text>
        </TouchableOpacity>
    );

    // ============ APPEARANCE SCREEN ============
    if (currentScreen === 'appearance') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SubHeader title={t('settings.appearance')} />
                <ScrollView style={styles.scrollView}>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.useSystem')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.followDevice')}</Text>
                            </View>
                            <Switch
                                value={themeMode === 'system'}
                                onValueChange={toggleSystemMode}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                        {themeMode !== 'system' && (
                            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.darkMode')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {isDark ? t('settings.darkEnabled') : t('settings.lightEnabled')}
                                    </Text>
                                </View>
                                <Switch
                                    value={isDark}
                                    onValueChange={toggleDarkMode}
                                    trackColor={{ false: '#767577', true: '#3B82F6' }}
                                />
                            </View>
                        )}

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.accentColor')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.accentDesc')}</Text>
                            </View>
                            <View style={styles.colorPickerRow}>
                                {['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'].map(color => (
                                    <TouchableOpacity
                                        key={color}
                                        onPress={() => updateSettings({ accentColor: color })}
                                        style={[
                                            styles.colorDot,
                                            { backgroundColor: color },
                                            settings.accentColor === color && styles.colorDotSelected
                                        ]}
                                    />
                                ))}
                            </View>
                        </View>
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ LANGUAGE SCREEN ============
    if (currentScreen === 'language') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SubHeader title={t('settings.language')} />
                <ScrollView style={styles.scrollView}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.selectLang')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        {LANGUAGES.map((lang, idx) => (
                            <TouchableOpacity
                                key={lang.id}
                                style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                onPress={() => setLanguage(lang.id)}
                            >
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{lang.native}</Text>
                                {language === lang.id && <Text style={{ color: '#3B82F6', fontSize: 20 }}>✓</Text>}
                            </TouchableOpacity>
                        ))}
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ NOTIFICATIONS SCREEN ============
    if (currentScreen === 'notifications') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SubHeader title={t('settings.notifications')} />
                <ScrollView style={styles.scrollView}>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.notificationsEnable')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.notificationsDesc')}
                                </Text>
                            </View>
                            <Switch
                                value={notificationsEnabled}
                                onValueChange={(value) => updateSettings({ notificationsEnabled: value }).catch(console.error)}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>
                    </View>

                    <Text style={[styles.description, { color: tc.secondaryText, marginTop: 12 }]}>
                        {t('settings.notificationsDevHint')}
                    </Text>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ SYNC SCREEN ============
    if (currentScreen === 'sync') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SubHeader title={t('settings.dataSync')} />
                <ScrollView style={styles.scrollView}>
                    {/* Step-by-step instructions */}
                    <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                        <Text style={[styles.helpTitle, { color: tc.text }]}>
                            {language === 'zh' ? '如何同步' : 'How to Sync'}
                        </Text>
                        <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                            {language === 'zh'
                                ? '1. 先点击"导出备份"保存文件到同步文件夹（如 Google Drive）\n2. 点击"选择文件"选中该文件\n3. 之后点击"同步"即可合并数据'
                                : '1. First, tap "Export Backup" and save to your sync folder (e.g., Google Drive)\n2. Tap "Select File" to choose that file\n3. Then tap "Sync" to merge data'}
                        </Text>
                    </View>

                    <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>
                        {language === 'zh' ? '同步设置' : 'Sync Settings'}
                    </Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        {/* Sync File Path */}
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>
                                    {language === 'zh' ? '同步文件' : 'Sync File'}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                    {syncPath ? syncPath.split('/').pop() : (language === 'zh' ? '未设置' : 'Not set')}
                                </Text>
                            </View>
                            <TouchableOpacity onPress={handleSetSyncPath}>
                                <Text style={styles.linkText}>{language === 'zh' ? '选择文件' : 'Select File'}</Text>
                            </TouchableOpacity>
                        </View>

                        {/* Sync Now */}
                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={handleSync}
                            disabled={isSyncing || !syncPath}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: syncPath ? '#3B82F6' : tc.secondaryText }]}>
                                    {language === 'zh' ? '同步' : 'Sync'}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {language === 'zh' ? '读取并合并同步文件' : 'Read and merge sync file'}
                                </Text>
                            </View>
                            {isSyncing && <ActivityIndicator size="small" color="#3B82F6" />}
                        </TouchableOpacity>

                        {/* Last Sync Status */}
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>
                                    {language === 'zh' ? '上次同步' : 'Last Sync'}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {settings.lastSyncAt
                                        ? new Date(settings.lastSyncAt).toLocaleString()
                                        : (language === 'zh' ? '从未同步' : 'Never')}
                                    {settings.lastSyncStatus === 'error' && (language === 'zh' ? '（失败）' : ' (failed)')}
                                </Text>
                                {settings.lastSyncStats && (
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {(language === 'zh' ? '冲突' : 'Conflicts')}: {(settings.lastSyncStats.tasks.conflicts || 0) + (settings.lastSyncStats.projects.conflicts || 0)}
                                    </Text>
                                )}
                                {settings.lastSyncStatus === 'error' && settings.lastSyncError && (
                                    <Text style={[styles.settingDescription, { color: '#EF4444' }]}>
                                        {settings.lastSyncError}
                                    </Text>
                                )}
                            </View>
                        </View>
                    </View>

                    {/* Backup Section */}
                    <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 24 }]}>
                        {language === 'zh' ? '备份' : 'Backup'}
                    </Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <TouchableOpacity
                            style={styles.settingRow}
                            onPress={handleBackup}
                            disabled={isSyncing}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: '#3B82F6' }]}>
                                    {language === 'zh' ? '导出备份' : 'Export Backup'}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {language === 'zh' ? '保存到同步文件夹' : 'Save to sync folder'}
                                </Text>
                            </View>
                        </TouchableOpacity>
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ ABOUT SCREEN ============
    if (currentScreen === 'about') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SubHeader title={t('settings.about')} />
                <ScrollView style={styles.scrollView}>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.version')}</Text>
                            <Text style={[styles.settingValue, { color: tc.secondaryText }]}>
                                {Constants.expoConfig?.version ?? '0.1.0'}
                            </Text>
                        </View>
                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{language === 'zh' ? '许可证' : 'License'}</Text>
                            <Text style={[styles.settingValue, { color: tc.secondaryText }]}>MIT</Text>
                        </View>
                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => openLink('https://dongdongbh.tech')}
                        >
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{language === 'zh' ? '网站' : 'Website'}</Text>
                            <Text style={styles.linkText}>dongdongbh.tech</Text>
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
                            onPress={handleCheckUpdates}
                            disabled={isCheckingUpdate}
                        >
                            <Text style={[styles.settingLabel, { color: tc.text }]}>
                                {language === 'zh' ? '检查更新' : 'Check for Updates'}
                            </Text>
                            {isCheckingUpdate ? (
                                <ActivityIndicator size="small" color="#3B82F6" />
                            ) : (
                                <Text style={styles.linkText}>
                                    {language === 'zh' ? '点击检查' : 'Tap to check'}
                                </Text>
                            )}
                        </TouchableOpacity>
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ MAIN SETTINGS SCREEN ============
    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <ScrollView style={styles.scrollView}>
                <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                    <MenuItem title={t('settings.appearance')} onPress={() => setCurrentScreen('appearance')} />
                    <MenuItem title={t('settings.language')} onPress={() => setCurrentScreen('language')} />
                    <MenuItem title={t('settings.notifications')} onPress={() => setCurrentScreen('notifications')} />
                    <MenuItem title={t('settings.dataSync')} onPress={() => setCurrentScreen('sync')} />
                    <MenuItem title={t('settings.about')} onPress={() => setCurrentScreen('about')} />
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    scrollView: { flex: 1, padding: 16 },
    subHeader: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 },
    backButton: { fontSize: 16, fontWeight: '500' },
    subHeaderTitle: { fontSize: 18, fontWeight: '600' },
    description: { fontSize: 13, marginBottom: 12, paddingHorizontal: 4, lineHeight: 18 },
    sectionTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8, marginLeft: 4 },
    menuCard: { borderRadius: 12, overflow: 'hidden' },
    menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1 },
    menuLabel: { fontSize: 17, fontWeight: '400' },
    chevron: { fontSize: 24, fontWeight: '300' },
    settingCard: { borderRadius: 12, overflow: 'hidden' },
    settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
    settingInfo: { flex: 1, marginRight: 16 },
    settingLabel: { fontSize: 16, fontWeight: '500' },
    settingDescription: { fontSize: 13, marginTop: 2 },
    settingValue: { fontSize: 16 },
    linkText: { fontSize: 16, color: '#3B82F6' },
    colorPickerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    colorDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: 'transparent' },
    colorDotSelected: { borderColor: '#111827' },
    helpBox: { borderRadius: 12, padding: 16, marginBottom: 8, borderWidth: 1 },
    helpTitle: { fontSize: 15, fontWeight: '600', marginBottom: 8 },
    helpText: { fontSize: 13, lineHeight: 20 },
});
