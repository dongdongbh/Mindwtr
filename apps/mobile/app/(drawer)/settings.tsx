import React, { useState, useEffect } from 'react';
import Constants from 'expo-constants';
import {
    View,
    Text,
    TextInput,
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
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage, Language } from '../../contexts/language-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { generateUUID, type ExternalCalendarSubscription, type TaskEditorFieldId, type TimeEstimate, useTaskStore } from '@mindwtr/core';
import { pickAndParseSyncFile, exportData } from '../../lib/storage-file';
import { fetchExternalCalendarEvents, getExternalCalendars, saveExternalCalendars } from '../../lib/external-calendar';
import {
    performMobileSync,
    SYNC_PATH_KEY,
    SYNC_BACKEND_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
    WEBDAV_PASSWORD_KEY,
    CLOUD_URL_KEY,
    CLOUD_TOKEN_KEY,
} from '../../lib/sync-service';

type SettingsScreen =
    | 'main'
    | 'appearance'
    | 'language'
    | 'notifications'
    | 'calendar'
    | 'gtd'
    | 'gtd-archive'
    | 'gtd-time-estimates'
    | 'gtd-task-editor'
    | 'sync'
    | 'about';

const LANGUAGES: { id: Language; native: string }[] = [
    { id: 'en', native: 'English' },
    { id: 'zh', native: '中文' },
];

export default function SettingsPage() {
    const { themeMode, setThemeMode, isDark } = useTheme();
    const { language, setLanguage, t } = useLanguage();
    const { tasks, projects, settings, updateSettings } = useTaskStore();
    const [isSyncing, setIsSyncing] = useState(false);
    const [currentScreen, setCurrentScreen] = useState<SettingsScreen>('main');
    const [syncPath, setSyncPath] = useState<string | null>(null);
    const [syncBackend, setSyncBackend] = useState<'file' | 'webdav' | 'cloud'>('file');
    const [webdavUrl, setWebdavUrl] = useState('');
    const [webdavUsername, setWebdavUsername] = useState('');
    const [webdavPassword, setWebdavPassword] = useState('');
    const [cloudUrl, setCloudUrl] = useState('');
    const [cloudToken, setCloudToken] = useState('');
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [digestTimePicker, setDigestTimePicker] = useState<'morning' | 'evening' | null>(null);
    const [weeklyReviewTimePicker, setWeeklyReviewTimePicker] = useState(false);
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [newCalendarName, setNewCalendarName] = useState('');
    const [newCalendarUrl, setNewCalendarUrl] = useState('');

    const tc = useThemeColors();
    const notificationsEnabled = settings.notificationsEnabled !== false;
    const dailyDigestMorningEnabled = settings.dailyDigestMorningEnabled === true;
    const dailyDigestEveningEnabled = settings.dailyDigestEveningEnabled === true;
    const dailyDigestMorningTime = settings.dailyDigestMorningTime || '09:00';
    const dailyDigestEveningTime = settings.dailyDigestEveningTime || '20:00';
    const weeklyReviewEnabled = settings.weeklyReviewEnabled === true;
    const weeklyReviewTime = settings.weeklyReviewTime || '18:00';
    const weeklyReviewDay = Number.isFinite(settings.weeklyReviewDay) ? settings.weeklyReviewDay as number : 0;
    const defaultTimeEstimatePresets: TimeEstimate[] = ['10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const timeEstimateOptions: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const timeEstimatePresets: TimeEstimate[] = (settings.gtd?.timeEstimatePresets?.length
        ? settings.gtd.timeEstimatePresets
        : defaultTimeEstimatePresets) as TimeEstimate[];
    const autoArchiveDays = Number.isFinite(settings.gtd?.autoArchiveDays)
        ? Math.max(0, Math.floor(settings.gtd?.autoArchiveDays as number))
        : 7;

    const formatTimeEstimateLabel = (value: TimeEstimate) => {
        if (value === '5min') return '5m';
        if (value === '10min') return '10m';
        if (value === '15min') return '15m';
        if (value === '30min') return '30m';
        if (value === '1hr') return '1h';
        if (value === '2hr') return '2h';
        if (value === '3hr') return '3h';
        if (value === '4hr') return '4h';
        return '4h+';
    };

    const formatTime = (time: string) => time;
    const locale = language === 'zh' ? 'zh-CN' : 'en-US';
    const toTimePickerDate = (time: string) => {
        const [hours, minutes] = time.split(':').map((v) => parseInt(v, 10));
        const date = new Date();
        date.setHours(Number.isFinite(hours) ? hours : 9, Number.isFinite(minutes) ? minutes : 0, 0, 0);
        return date;
    };

    const onDigestTimeChange = (_event: DateTimePickerEvent, selected?: Date) => {
        const picker = digestTimePicker;
        setDigestTimePicker(null);
        if (!picker || !selected) return;
        const hours = String(selected.getHours()).padStart(2, '0');
        const minutes = String(selected.getMinutes()).padStart(2, '0');
        const value = `${hours}:${minutes}`;
        if (picker === 'morning') {
            updateSettings({ dailyDigestMorningTime: value }).catch(console.error);
        } else {
            updateSettings({ dailyDigestEveningTime: value }).catch(console.error);
        }
    };

    const onWeeklyReviewTimeChange = (_event: DateTimePickerEvent, selected?: Date) => {
        setWeeklyReviewTimePicker(false);
        if (!selected) return;
        const hours = String(selected.getHours()).padStart(2, '0');
        const minutes = String(selected.getMinutes()).padStart(2, '0');
        updateSettings({ weeklyReviewTime: `${hours}:${minutes}` }).catch(console.error);
    };

    const getWeekdayLabel = (dayIndex: number) => {
        const base = new Date(2024, 0, 7 + dayIndex);
        return base.toLocaleDateString(locale, { weekday: 'long' });
    };

    const selectWeeklyReviewDay = () => {
        const options: Alert.Button[] = Array.from({ length: 7 }, (_, idx) => ({
            text: getWeekdayLabel(idx),
            onPress: () => updateSettings({ weeklyReviewDay: idx }).catch(console.error),
        }));
        options.push({ text: t('common.cancel'), style: 'cancel' });
        Alert.alert(t('settings.weeklyReviewDay'), '', options);
    };

    // Load sync path on mount
    useEffect(() => {
        AsyncStorage.multiGet([
            SYNC_PATH_KEY,
            SYNC_BACKEND_KEY,
            WEBDAV_URL_KEY,
            WEBDAV_USERNAME_KEY,
            WEBDAV_PASSWORD_KEY,
            CLOUD_URL_KEY,
            CLOUD_TOKEN_KEY,
        ]).then((entries) => {
            const entryMap = new Map(entries);
            const path = entryMap.get(SYNC_PATH_KEY);
            const backend = entryMap.get(SYNC_BACKEND_KEY);
            const url = entryMap.get(WEBDAV_URL_KEY);
            const username = entryMap.get(WEBDAV_USERNAME_KEY);
            const password = entryMap.get(WEBDAV_PASSWORD_KEY);
            const cloudUrlValue = entryMap.get(CLOUD_URL_KEY);
            const cloudTokenValue = entryMap.get(CLOUD_TOKEN_KEY);

            if (path) setSyncPath(path);
            setSyncBackend(backend === 'webdav' ? 'webdav' : backend === 'cloud' ? 'cloud' : 'file');
            if (url) setWebdavUrl(url);
            if (username) setWebdavUsername(username);
            if (password) setWebdavPassword(password);
            if (cloudUrlValue) setCloudUrl(cloudUrlValue);
            if (cloudTokenValue) setCloudToken(cloudTokenValue);
        }).catch(console.error);
    }, []);

    useEffect(() => {
        getExternalCalendars().then(setExternalCalendars).catch(console.error);
    }, []);

    // Handle Android hardware back button
    useEffect(() => {
        const onBackPress = () => {
            if (currentScreen !== 'main') {
                if (currentScreen === 'gtd-time-estimates' || currentScreen === 'gtd-task-editor' || currentScreen === 'gtd-archive') {
                    setCurrentScreen('gtd');
                } else {
                    setCurrentScreen('main');
                }
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
                    await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'file');
                    setSyncBackend('file');
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
        setIsSyncing(true);
        try {
            if (syncBackend === 'webdav') {
                if (!webdavUrl.trim()) {
                    Alert.alert(
                        language === 'zh' ? '提示' : 'Notice',
                        language === 'zh' ? '请先设置 WebDAV 地址' : 'Please set a WebDAV URL first'
                    );
                    return;
                }
                await AsyncStorage.multiSet([
                    [SYNC_BACKEND_KEY, 'webdav'],
                    [WEBDAV_URL_KEY, webdavUrl.trim()],
                    [WEBDAV_USERNAME_KEY, webdavUsername],
                    [WEBDAV_PASSWORD_KEY, webdavPassword],
                ]);
            } else {
                if (!syncPath) {
                    Alert.alert(
                        language === 'zh' ? '提示' : 'Notice',
                        language === 'zh' ? '请先设置同步文件' : 'Please set a sync file first'
                    );
                    return;
                }
                await AsyncStorage.setItem(SYNC_BACKEND_KEY, 'file');
            }

            const result = await performMobileSync(syncBackend === 'file' ? syncPath || undefined : undefined);
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

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.dailyDigest')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.dailyDigestDesc')}
                                </Text>
                            </View>
                        </View>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.dailyDigestMorning')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.dailyDigestMorningTime')}: {formatTime(dailyDigestMorningTime)}
                                </Text>
                            </View>
                            <Switch
                                value={dailyDigestMorningEnabled}
                                onValueChange={(value) => updateSettings({ dailyDigestMorningEnabled: value }).catch(console.error)}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>

                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => setDigestTimePicker('morning')}
                            disabled={!dailyDigestMorningEnabled}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text, opacity: dailyDigestMorningEnabled ? 1 : 0.5 }]}>
                                    {t('settings.dailyDigestMorningTime')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, opacity: dailyDigestMorningEnabled ? 1 : 0.5 }]}>
                                    {formatTime(dailyDigestMorningTime)}
                                </Text>
                            </View>
                        </TouchableOpacity>

                        <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.dailyDigestEvening')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.dailyDigestEveningTime')}: {formatTime(dailyDigestEveningTime)}
                                </Text>
                            </View>
                            <Switch
                                value={dailyDigestEveningEnabled}
                                onValueChange={(value) => updateSettings({ dailyDigestEveningEnabled: value }).catch(console.error)}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        </View>

                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => setDigestTimePicker('evening')}
                            disabled={!dailyDigestEveningEnabled}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text, opacity: dailyDigestEveningEnabled ? 1 : 0.5 }]}>
                                    {t('settings.dailyDigestEveningTime')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, opacity: dailyDigestEveningEnabled ? 1 : 0.5 }]}>
                                    {formatTime(dailyDigestEveningTime)}
                                </Text>
                            </View>
                        </TouchableOpacity>
                    </View>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.weeklyReview')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {t('settings.weeklyReviewDesc')}
                                </Text>
                            </View>
                            <Switch
                                value={weeklyReviewEnabled}
                                onValueChange={(value) => updateSettings({ weeklyReviewEnabled: value }).catch(console.error)}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                                disabled={!notificationsEnabled}
                            />
                        </View>

                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={selectWeeklyReviewDay}
                            disabled={!weeklyReviewEnabled || !notificationsEnabled}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text, opacity: weeklyReviewEnabled ? 1 : 0.5 }]}>
                                    {t('settings.weeklyReviewDay')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, opacity: weeklyReviewEnabled ? 1 : 0.5 }]}>
                                    {getWeekdayLabel(weeklyReviewDay)}
                                </Text>
                            </View>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            onPress={() => setWeeklyReviewTimePicker(true)}
                            disabled={!weeklyReviewEnabled || !notificationsEnabled}
                        >
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text, opacity: weeklyReviewEnabled ? 1 : 0.5 }]}>
                                    {t('settings.weeklyReviewTime')}
                                </Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, opacity: weeklyReviewEnabled ? 1 : 0.5 }]}>
                                    {formatTime(weeklyReviewTime)}
                                </Text>
                            </View>
                        </TouchableOpacity>
                    </View>

                    {digestTimePicker && (
                        <DateTimePicker
                            value={toTimePickerDate(digestTimePicker === 'morning' ? dailyDigestMorningTime : dailyDigestEveningTime)}
                            mode="time"
                            display="default"
                            onChange={(event, date) => {
                                if (Platform.OS === 'android') {
                                    if (event.type === 'dismissed') {
                                        setDigestTimePicker(null);
                                        return;
                                    }
                                }
                                onDigestTimeChange(event, date);
                            }}
                        />
                    )}

                    {weeklyReviewTimePicker && (
                        <DateTimePicker
                            value={toTimePickerDate(weeklyReviewTime)}
                            mode="time"
                            display="default"
                            onChange={(event, date) => {
                                if (Platform.OS === 'android') {
                                    if (event.type === 'dismissed') {
                                        setWeeklyReviewTimePicker(false);
                                        return;
                                    }
                                }
                                onWeeklyReviewTimeChange(event, date);
                            }}
                        />
                    )}


                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ GTD MENU ============
    if (currentScreen === 'gtd') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SubHeader title={t('settings.gtd')} />
                <ScrollView style={styles.scrollView}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.gtdDesc')}</Text>
                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        <MenuItem
                            title={t('settings.timeEstimatePresets')}
                            onPress={() => setCurrentScreen('gtd-time-estimates')}
                        />
                        <MenuItem
                            title={t('settings.autoArchive')}
                            onPress={() => setCurrentScreen('gtd-archive')}
                        />
                        <MenuItem
                            title={t('settings.taskEditorLayout')}
                            onPress={() => setCurrentScreen('gtd-task-editor')}
                        />
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ GTD: AUTO ARCHIVE ============
    if (currentScreen === 'gtd-archive') {
        const autoArchiveOptions = [0, 1, 3, 7, 14, 30, 60];
        const formatAutoArchiveLabel = (days: number) => {
            if (days <= 0) return t('settings.autoArchiveNever');
            return language === 'zh' ? `${days} 天` : `${days} days`;
        };

        const handleSelectArchive = (days: number) => {
            updateSettings({
                gtd: {
                    ...(settings.gtd ?? {}),
                    autoArchiveDays: days,
                },
            }).catch(console.error);
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SubHeader title={t('settings.autoArchive')} />
                <ScrollView style={styles.scrollView}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.autoArchiveDesc')}</Text>
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        {autoArchiveOptions.map((days, idx) => {
                            const selected = autoArchiveDays === days;
                            return (
                                <TouchableOpacity
                                    key={days}
                                    style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => handleSelectArchive(days)}
                                >
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{formatAutoArchiveLabel(days)}</Text>
                                    {selected && <Text style={{ color: '#3B82F6', fontSize: 20 }}>✓</Text>}
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ GTD: TIME ESTIMATES ============
    if (currentScreen === 'gtd-time-estimates') {
        const togglePreset = (value: TimeEstimate) => {
            const isSelected = timeEstimatePresets.includes(value);
            if (isSelected && timeEstimatePresets.length <= 1) return;

            const next = isSelected ? timeEstimatePresets.filter((v) => v !== value) : [...timeEstimatePresets, value];
            const ordered = timeEstimateOptions.filter((v) => next.includes(v));

            updateSettings({
                gtd: {
                    ...(settings.gtd ?? {}),
                    timeEstimatePresets: ordered,
                },
            }).catch(console.error);
        };

        const resetToDefault = () => {
            updateSettings({
                gtd: {
                    ...(settings.gtd ?? {}),
                    timeEstimatePresets: [...defaultTimeEstimatePresets],
                },
            }).catch(console.error);
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SubHeader title={t('settings.timeEstimatePresets')} />
                <ScrollView style={styles.scrollView}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.timeEstimatePresetsDesc')}</Text>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        {timeEstimateOptions.map((value, idx) => {
                            const selected = timeEstimatePresets.includes(value);
                            return (
                                <TouchableOpacity
                                    key={value}
                                    style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => togglePreset(value)}
                                >
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>
                                        {formatTimeEstimateLabel(value)}
                                    </Text>
                                    {selected && <Text style={{ color: '#3B82F6', fontSize: 20 }}>✓</Text>}
                                </TouchableOpacity>
                            );
                        })}
                    </View>

                    <TouchableOpacity
                        style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}
                        onPress={resetToDefault}
                    >
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.resetToDefault')}</Text>
                        </View>
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ GTD: TASK EDITOR ============
    if (currentScreen === 'gtd-task-editor') {
        const ROW_HEIGHT = 52;

        const defaultTaskEditorOrder: TaskEditorFieldId[] = [
            'status',
            'contexts',
            'description',
            'tags',
            'timeEstimate',
            'recurrence',
            'startTime',
            'dueDate',
            'reviewAt',
            'blockedBy',
            'attachments',
            'checklist',
        ];

        const defaultTaskEditorHidden = defaultTaskEditorOrder.filter((id) => !['status', 'contexts', 'description'].includes(id));
        const known = new Set(defaultTaskEditorOrder);
        const savedOrder = (settings.gtd?.taskEditor?.order ?? []).filter((id) => known.has(id));
        const taskEditorOrder = [...savedOrder, ...defaultTaskEditorOrder.filter((id) => !savedOrder.includes(id))];

        const savedHidden = settings.gtd?.taskEditor?.hidden ?? defaultTaskEditorHidden;
        const hiddenSet = new Set(savedHidden.filter((id) => known.has(id)));

        const fieldLabel = (fieldId: TaskEditorFieldId) => {
            switch (fieldId) {
                case 'status':
                    return t('taskEdit.statusLabel');
                case 'contexts':
                    return t('taskEdit.contextsLabel');
                case 'description':
                    return t('taskEdit.descriptionLabel');
                case 'tags':
                    return t('taskEdit.tagsLabel');
                case 'timeEstimate':
                    return t('taskEdit.timeEstimateLabel');
                case 'recurrence':
                    return t('taskEdit.recurrenceLabel');
                case 'startTime':
                    return t('taskEdit.startDateLabel');
                case 'dueDate':
                    return t('taskEdit.dueDateLabel');
                case 'reviewAt':
                    return t('taskEdit.reviewDateLabel');
                case 'blockedBy':
                    return t('taskEdit.blockedByLabel');
                case 'attachments':
                    return t('attachments.title');
                case 'checklist':
                    return t('taskEdit.checklist');
                default:
                    return fieldId;
            }
        };

        const saveTaskEditor = (next: { order?: TaskEditorFieldId[]; hidden?: TaskEditorFieldId[] }) => {
            updateSettings({
                gtd: {
                    ...(settings.gtd ?? {}),
                    taskEditor: {
                        ...(settings.gtd?.taskEditor ?? {}),
                        ...(next.order ? { order: next.order } : null),
                        ...(next.hidden ? { hidden: next.hidden } : null),
                    },
                },
            }).catch(console.error);
        };

        const toggleFieldVisibility = (fieldId: TaskEditorFieldId) => {
            const nextHidden = new Set(hiddenSet);
            if (nextHidden.has(fieldId)) nextHidden.delete(fieldId);
            else nextHidden.add(fieldId);
            saveTaskEditor({ order: taskEditorOrder, hidden: Array.from(nextHidden) });
        };

        const moveOrder = (fromIndex: number, toIndex: number) => {
            if (fromIndex === toIndex) return;
            const clampedTo = Math.max(0, Math.min(taskEditorOrder.length - 1, toIndex));
            const nextOrder = [...taskEditorOrder];
            const [item] = nextOrder.splice(fromIndex, 1);
            nextOrder.splice(clampedTo, 0, item);
            saveTaskEditor({ order: nextOrder, hidden: Array.from(hiddenSet) });
        };

        function TaskEditorRow({ fieldId, index }: { fieldId: TaskEditorFieldId; index: number }) {
            const translateY = useSharedValue(0);
            const scale = useSharedValue(1);
            const zIndex = useSharedValue(0);

            const onDrop = (from: number, deltaRows: number) => {
                const nextIndex = Math.max(0, Math.min(taskEditorOrder.length - 1, from + deltaRows));
                moveOrder(from, nextIndex);
            };

            const panGesture = Gesture.Pan()
                .activateAfterLongPress(220)
                .onStart(() => {
                    scale.value = withSpring(1.02);
                    zIndex.value = 50;
                })
                .onUpdate((event) => {
                    translateY.value = event.translationY;
                })
                .onEnd((event) => {
                    const deltaRows = Math.round(event.translationY / ROW_HEIGHT);
                    if (deltaRows !== 0) runOnJS(onDrop)(index, deltaRows);
                    translateY.value = withSpring(0);
                    scale.value = withSpring(1);
                    zIndex.value = 0;
                });

            const animatedStyle = useAnimatedStyle(() => ({
                transform: [{ translateY: translateY.value }, { scale: scale.value }],
                zIndex: zIndex.value,
            }));

            const visible = !hiddenSet.has(fieldId);

            return (
                <Animated.View
                    style={[
                        styles.taskEditorRow,
                        { borderTopColor: tc.border },
                        index > 0 && styles.taskEditorRowBorder,
                        animatedStyle,
                    ]}
                >
                    <TouchableOpacity
                        style={styles.taskEditorRowContent}
                        onPress={() => toggleFieldVisibility(fieldId)}
                        activeOpacity={0.7}
                    >
                        <View style={styles.taskEditorCheckSlot}>
                            {visible ? <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text> : null}
                        </View>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{fieldLabel(fieldId)}</Text>
                    </TouchableOpacity>

                    <GestureDetector gesture={panGesture}>
                        <View style={styles.taskEditorDragHandle}>
                            <IconSymbol name="line.3.horizontal" size={18} color={tc.secondaryText} />
                        </View>
                    </GestureDetector>
                </Animated.View>
            );
        }

        const resetToDefault = () => {
            saveTaskEditor({ order: [...defaultTaskEditorOrder], hidden: [...defaultTaskEditorHidden] });
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SubHeader title={t('settings.taskEditorLayout')} />
                <ScrollView style={styles.scrollView}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.taskEditorLayoutDesc')}</Text>
                    <Text style={[styles.description, { color: tc.secondaryText, marginTop: -6 }]}>{t('settings.taskEditorLayoutHint')}</Text>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, overflow: 'visible' }]}>
                        {taskEditorOrder.map((fieldId, index) => (
                            <TaskEditorRow key={fieldId} fieldId={fieldId} index={index} />
                        ))}
                    </View>

                    <TouchableOpacity
                        style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}
                        onPress={resetToDefault}
                    >
                        <View style={styles.settingRow}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.resetToDefault')}</Text>
                        </View>
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // ============ CALENDAR SCREEN ============
    if (currentScreen === 'calendar') {
        const handleAddCalendar = async () => {
            const url = newCalendarUrl.trim();
            if (!url) return;

            const name = (newCalendarName.trim() || (language === 'zh' ? '日历' : 'Calendar')).trim();
            const next: ExternalCalendarSubscription[] = [
                ...externalCalendars,
                { id: generateUUID(), name, url, enabled: true },
            ];

            setExternalCalendars(next);
            setNewCalendarName('');
            setNewCalendarUrl('');
            await saveExternalCalendars(next);
        };

        const handleToggleCalendar = async (id: string, enabled: boolean) => {
            const next = externalCalendars.map((c) => (c.id === id ? { ...c, enabled } : c));
            setExternalCalendars(next);
            await saveExternalCalendars(next);
        };

        const handleRemoveCalendar = async (id: string) => {
            const next = externalCalendars.filter((c) => c.id !== id);
            setExternalCalendars(next);
            await saveExternalCalendars(next);
        };

        const handleTestFetch = async () => {
            try {
                const now = new Date();
                const rangeStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
                const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
                const { events } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
                Alert.alert(
                    language === 'zh' ? '成功' : 'Success',
                    language === 'zh' ? `已加载 ${events.length} 个日程` : `Loaded ${events.length} events`
                );
            } catch (error) {
                console.error(error);
                Alert.alert(language === 'zh' ? '错误' : 'Error', language === 'zh' ? '加载失败' : 'Failed to load events');
            }
        };

        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SubHeader title={t('settings.calendar')} />
                <ScrollView style={styles.scrollView}>
                    <Text style={[styles.description, { color: tc.secondaryText }]}>
                        {t('settings.calendarDesc')}
                    </Text>

                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                        <View style={styles.inputGroup}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.externalCalendarName')}</Text>
                            <TextInput
                                style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                                placeholder={language === 'zh' ? '可选' : 'Optional'}
                                placeholderTextColor={tc.secondaryText}
                                value={newCalendarName}
                                onChangeText={setNewCalendarName}
                            />

                            <Text style={[styles.settingLabel, { color: tc.text, marginTop: 12 }]}>{t('settings.externalCalendarUrl')}</Text>
                            <TextInput
                                style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                                placeholder="https://..."
                                placeholderTextColor={tc.secondaryText}
                                autoCapitalize="none"
                                autoCorrect={false}
                                value={newCalendarUrl}
                                onChangeText={setNewCalendarUrl}
                            />

                            <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: newCalendarUrl.trim() ? tc.tint : tc.filterBg },
                                    ]}
                                    onPress={handleAddCalendar}
                                    disabled={!newCalendarUrl.trim()}
                                >
                                    <Text style={[styles.backendOptionText, { color: newCalendarUrl.trim() ? '#FFFFFF' : tc.secondaryText }]}>
                                        {t('settings.externalCalendarAdd')}
                                    </Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[styles.backendOption, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={handleTestFetch}
                                >
                                    <Text style={[styles.backendOptionText, { color: tc.text }]}>
                                        {language === 'zh' ? '测试' : 'Test'}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>

                    {externalCalendars.length > 0 && (
                        <View style={{ marginTop: 16 }}>
                            <Text style={[styles.sectionTitle, { color: tc.secondaryText }]}>{t('settings.externalCalendars')}</Text>
                            <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                                {externalCalendars.map((calendar, idx) => (
                                    <View
                                        key={calendar.id}
                                        style={[
                                            styles.settingRow,
                                            idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border },
                                        ]}
                                    >
                                        <View style={styles.settingInfo}>
                                            <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                                                {calendar.name}
                                            </Text>
                                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                                {calendar.url}
                                            </Text>
                                        </View>
                                        <View style={{ alignItems: 'flex-end', gap: 10 }}>
                                            <Switch
                                                value={calendar.enabled}
                                                onValueChange={(value) => handleToggleCalendar(calendar.id, value)}
                                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                                            />
                                            <TouchableOpacity onPress={() => handleRemoveCalendar(calendar.id)}>
                                                <Text style={{ color: '#EF4444', fontSize: 13, fontWeight: '600' }}>
                                                    {t('settings.externalCalendarRemove')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                ))}
                            </View>
                        </View>
                    )}
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
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 12 }]}>
                        <View style={styles.settingRow}>
                            <View style={styles.settingInfo}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncBackend')}</Text>
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                    {syncBackend === 'webdav'
                                        ? t('settings.syncBackendWebdav')
                                        : syncBackend === 'cloud'
                                            ? t('settings.syncBackendCloud')
                                            : t('settings.syncBackendFile')}
                                </Text>
                            </View>
                            <View style={styles.backendToggle}>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: syncBackend === 'file' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        AsyncStorage.setItem(SYNC_BACKEND_KEY, 'file').catch(console.error);
                                        setSyncBackend('file');
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: syncBackend === 'file' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.syncBackendFile')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: syncBackend === 'webdav' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        AsyncStorage.setItem(SYNC_BACKEND_KEY, 'webdav').catch(console.error);
                                        setSyncBackend('webdav');
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: syncBackend === 'webdav' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.syncBackendWebdav')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[
                                        styles.backendOption,
                                        { borderColor: tc.border, backgroundColor: syncBackend === 'cloud' ? tc.filterBg : 'transparent' },
                                    ]}
                                    onPress={() => {
                                        AsyncStorage.setItem(SYNC_BACKEND_KEY, 'cloud').catch(console.error);
                                        setSyncBackend('cloud');
                                    }}
                                >
                                    <Text style={[styles.backendOptionText, { color: syncBackend === 'cloud' ? tc.tint : tc.secondaryText }]}>
                                        {t('settings.syncBackendCloud')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>

                    {syncBackend === 'file' && (
                        <>
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
                        </>
                    )}

                    {syncBackend === 'webdav' && (
                        <>
                            <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>
                                {t('settings.syncBackendWebdav')}
                            </Text>
                            <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                                <View style={styles.inputGroup}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.webdavUrl')}</Text>
                                    <TextInput
                                        value={webdavUrl}
                                        onChangeText={setWebdavUrl}
                                        placeholder="https://example.com/remote.php/dav/files/user/data.json"
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    />
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.webdavHint')}
                                    </Text>
                                </View>

                                <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.webdavUsername')}</Text>
                                    <TextInput
                                        value={webdavUsername}
                                        onChangeText={setWebdavUsername}
                                        placeholder="user"
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    />
                                </View>

                                <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.webdavPassword')}</Text>
                                    <TextInput
                                        value={webdavPassword}
                                        onChangeText={setWebdavPassword}
                                        placeholder="••••••••"
                                        placeholderTextColor={tc.secondaryText}
                                        secureTextEntry
                                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    />
                                </View>

                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => {
                                        AsyncStorage.multiSet([
                                            [SYNC_BACKEND_KEY, 'webdav'],
                                            [WEBDAV_URL_KEY, webdavUrl.trim()],
                                            [WEBDAV_USERNAME_KEY, webdavUsername],
                                            [WEBDAV_PASSWORD_KEY, webdavPassword],
                                        ]).then(() => {
                                            Alert.alert(language === 'zh' ? '成功' : 'Success', t('settings.webdavSave'));
                                        }).catch(console.error);
                                    }}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.tint }]}>{t('settings.webdavSave')}</Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.webdavUrl')}
                                        </Text>
                                    </View>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={handleSync}
                                    disabled={isSyncing || !webdavUrl.trim()}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: webdavUrl.trim() ? tc.tint : tc.secondaryText }]}>
                                            {language === 'zh' ? '同步' : 'Sync'}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {language === 'zh' ? '读取并合并 WebDAV 数据' : 'Read and merge WebDAV data'}
                                        </Text>
                                    </View>
                                    {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                                </TouchableOpacity>

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
                        </>
                    )}

                    {syncBackend === 'cloud' && (
                        <>
                            <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>
                                {t('settings.syncBackendCloud')}
                            </Text>
                            <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                                <View style={styles.inputGroup}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.cloudUrl')}</Text>
                                    <TextInput
                                        value={cloudUrl}
                                        onChangeText={setCloudUrl}
                                        placeholder="https://example.com/v1/data"
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    />
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {t('settings.cloudHint')}
                                    </Text>
                                </View>

                                <View style={[styles.inputGroup, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.cloudToken')}</Text>
                                    <TextInput
                                        value={cloudToken}
                                        onChangeText={setCloudToken}
                                        placeholderTextColor={tc.secondaryText}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        secureTextEntry
                                        style={[styles.textInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    />
                                </View>

                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={() => {
                                        AsyncStorage.multiSet([
                                            [CLOUD_URL_KEY, cloudUrl.trim()],
                                            [CLOUD_TOKEN_KEY, cloudToken.trim()],
                                        ]).catch(console.error);
                                    }}
                                    disabled={!cloudUrl.trim() || !cloudToken.trim()}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: cloudUrl.trim() && cloudToken.trim() ? tc.tint : tc.secondaryText }]}>
                                            {t('settings.cloudSave')}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {t('settings.cloudUrl')}
                                        </Text>
                                    </View>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                                    onPress={handleSync}
                                    disabled={isSyncing || !cloudUrl.trim() || !cloudToken.trim()}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: cloudUrl.trim() && cloudToken.trim() ? tc.tint : tc.secondaryText }]}>
                                            {language === 'zh' ? '同步' : 'Sync'}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                            {language === 'zh' ? '读取并合并云端数据' : 'Read and merge cloud data'}
                                        </Text>
                                    </View>
                                    {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                                </TouchableOpacity>

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
                        </>
                    )}

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
                    <MenuItem title={t('settings.calendar')} onPress={() => setCurrentScreen('calendar')} />
                    <MenuItem title={t('settings.gtd')} onPress={() => setCurrentScreen('gtd')} />
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
    taskEditorRow: { flexDirection: 'row', alignItems: 'center', height: 52, paddingHorizontal: 16, position: 'relative' },
    taskEditorRowBorder: { borderTopWidth: 1 },
    taskEditorRowContent: { flex: 1, flexDirection: 'row', alignItems: 'center' },
    taskEditorCheckSlot: { width: 28, alignItems: 'center', marginRight: 12 },
    taskEditorDragHandle: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    settingInfo: { flex: 1, marginRight: 16 },
    settingLabel: { fontSize: 16, fontWeight: '500' },
    settingDescription: { fontSize: 13, marginTop: 2 },
    settingValue: { fontSize: 16 },
    linkText: { fontSize: 16, color: '#3B82F6' },
    helpBox: { borderRadius: 12, padding: 16, marginBottom: 8, borderWidth: 1 },
    helpTitle: { fontSize: 15, fontWeight: '600', marginBottom: 8 },
    helpText: { fontSize: 13, lineHeight: 20 },
    backendToggle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    backendOption: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
    backendOptionText: { fontSize: 13, fontWeight: '700' },
    inputGroup: { padding: 16 },
    textInput: { marginTop: 8, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
});
