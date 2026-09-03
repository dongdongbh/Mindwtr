import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { SafeAreaView } from 'react-native-safe-area-context';

import { areDueDateRemindersEnabled,
    areStartDateRemindersEnabled,
    areTaskRemindersEnabled,
    isWeeklyReviewReminderEnabled,
    normalizeDateFormatSetting,
    resolveDateLocaleTag,
    useTaskStore, tFallback, } from '@mindwtr/core';

import { requestNotificationPermission, startMobileNotifications } from '@/lib/notification-service';
import {
    applyPersistentCaptureNotification,
    isPersistentCaptureSupported,
    readPersistentCaptureEnabled,
    writePersistentCaptureEnabled,
} from '@/lib/persistent-capture-notification';
import { useThemeColors } from '@/hooks/use-theme-colors';

import { ExactAlarmNoticeRow, useExactAlarmPermission } from './exact-alarm-notice';
import { SettingRow, SettingToggleRow } from './setting-row';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';

export function NotificationsSettingsScreen() {
    const tc = useThemeColors();
    const { language, t } = useSettingsLocalization();
    const { settings, updateSettings } = useTaskStore();
    const scrollContentStyle = useSettingsScrollContent();
    const [digestTimePicker, setDigestTimePicker] = useState<'morning' | 'evening' | null>(null);
    const [digestTimeDraft, setDigestTimeDraft] = useState<Date | null>(null);
    const [weeklyReviewTimePicker, setWeeklyReviewTimePicker] = useState(false);
    const [weeklyReviewTimeDraft, setWeeklyReviewTimeDraft] = useState<Date | null>(null);
    const [weeklyReviewDayPickerOpen, setWeeklyReviewDayPickerOpen] = useState(false);

    const notificationsEnabled = areTaskRemindersEnabled(settings);
    const { showNotice: showExactAlarmNotice } = useExactAlarmPermission(notificationsEnabled);
    const startDateNotificationsEnabled = areStartDateRemindersEnabled(settings);
    const dueDateNotificationsEnabled = areDueDateRemindersEnabled(settings);
    const dailyDigestMorningEnabled = settings.dailyDigestMorningEnabled === true;
    const dailyDigestEveningEnabled = settings.dailyDigestEveningEnabled === true;
    const dailyDigestMorningTime = settings.dailyDigestMorningTime || '09:00';
    const dailyDigestEveningTime = settings.dailyDigestEveningTime || '20:00';
    const weeklyReviewEnabled = isWeeklyReviewReminderEnabled(settings);
    const weeklyReviewTime = settings.weeklyReviewTime || '18:00';
    const weeklyReviewDay = Number.isFinite(settings.weeklyReviewDay) ? (settings.weeklyReviewDay as number) : 0;
    const dateFormat = normalizeDateFormatSetting(settings.dateFormat);
    const systemLocale = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
        ? Intl.DateTimeFormat().resolvedOptions().locale
        : '';
    const locale = resolveDateLocaleTag({
        language,
        dateFormat,
        calendarSystem: settings.calendarSystem,
        systemLocale,
    });

    const toTimePickerDate = (time: string) => {
        const [hours, minutes] = time.split(':').map((v) => parseInt(v, 10));
        const date = new Date();
        date.setHours(Number.isFinite(hours) ? hours : 9, Number.isFinite(minutes) ? minutes : 0, 0, 0);
        return date;
    };
    const toTimeValue = (date: Date) => {
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${hours}:${minutes}`;
    };
    const formatTime = (time: string) => time;
    const getWeekdayLabel = useCallback((dayIndex: number) => {
        const base = new Date(2024, 0, 7 + dayIndex);
        return base.toLocaleDateString(locale, { weekday: 'long' });
    }, [locale]);

    const ensureNotificationsPermission = useCallback(async () => {
        const result = await requestNotificationPermission();
        if (result.granted) {
            startMobileNotifications().catch(console.error);
            return true;
        }
        return false;
    }, []);

    const [persistentCaptureEnabled, setPersistentCaptureEnabled] = useState(false);
    useEffect(() => {
        if (!isPersistentCaptureSupported()) return;
        readPersistentCaptureEnabled().then(setPersistentCaptureEnabled).catch(console.error);
    }, []);
    const persistentCaptureStrings = useCallback(() => ({
        title: tFallback(t, 'captureNotification.title', 'Quick capture'),
        text: tFallback(t, 'captureNotification.text', 'Tap to capture to your Inbox'),
        channelName: tFallback(t, 'captureNotification.channelName', 'Quick capture'),
    }), [t]);
    const togglePersistentCapture = useCallback((value: boolean) => {
        if (!value) {
            setPersistentCaptureEnabled(false);
            applyPersistentCaptureNotification(false, persistentCaptureStrings());
            writePersistentCaptureEnabled(false).catch(console.error);
            return;
        }
        ensureNotificationsPermission()
            .then((granted) => {
                if (!granted) return;
                setPersistentCaptureEnabled(true);
                applyPersistentCaptureNotification(true, persistentCaptureStrings());
                writePersistentCaptureEnabled(true).catch(console.error);
            })
            .catch(console.error);
    }, [ensureNotificationsPermission, persistentCaptureStrings]);

    const openDigestTimePicker = useCallback((picker: 'morning' | 'evening') => {
        setDigestTimePicker(picker);
        if (Platform.OS !== 'ios') return;
        const current = picker === 'morning' ? dailyDigestMorningTime : dailyDigestEveningTime;
        setDigestTimeDraft(toTimePickerDate(current));
    }, [dailyDigestEveningTime, dailyDigestMorningTime]);

    const closeDigestTimePicker = useCallback(() => {
        setDigestTimePicker(null);
        setDigestTimeDraft(null);
    }, []);

    const saveDigestTimePicker = useCallback(() => {
        const picker = digestTimePicker;
        const selected = digestTimeDraft;
        closeDigestTimePicker();
        if (!picker || !selected) return;
        const value = toTimeValue(selected);
        if (picker === 'morning') {
            updateSettings({ dailyDigestMorningTime: value }).catch(console.error);
            return;
        }
        updateSettings({ dailyDigestEveningTime: value }).catch(console.error);
    }, [closeDigestTimePicker, digestTimeDraft, digestTimePicker, updateSettings]);

    const openWeeklyReviewTimePicker = useCallback(() => {
        setWeeklyReviewTimePicker(true);
        if (Platform.OS !== 'ios') return;
        setWeeklyReviewTimeDraft(toTimePickerDate(weeklyReviewTime));
    }, [weeklyReviewTime]);

    const closeWeeklyReviewTimePicker = useCallback(() => {
        setWeeklyReviewTimePicker(false);
        setWeeklyReviewTimeDraft(null);
    }, []);

    const saveWeeklyReviewTimePicker = useCallback(() => {
        const selected = weeklyReviewTimeDraft;
        closeWeeklyReviewTimePicker();
        if (!selected) return;
        updateSettings({ weeklyReviewTime: toTimeValue(selected) }).catch(console.error);
    }, [closeWeeklyReviewTimePicker, updateSettings, weeklyReviewTimeDraft]);

    const onDigestTimeChange = (_event: DateTimePickerEvent, selected?: Date) => {
        const picker = digestTimePicker;
        setDigestTimePicker(null);
        if (!picker || !selected) return;
        const value = toTimeValue(selected);
        if (picker === 'morning') {
            updateSettings({ dailyDigestMorningTime: value }).catch(console.error);
        } else {
            updateSettings({ dailyDigestEveningTime: value }).catch(console.error);
        }
    };

    const onWeeklyReviewTimeChange = (_event: DateTimePickerEvent, selected?: Date) => {
        setWeeklyReviewTimePicker(false);
        if (!selected) return;
        updateSettings({ weeklyReviewTime: toTimeValue(selected) }).catch(console.error);
    };

    const weeklyDays = useMemo(() => Array.from({ length: 7 }, (_, idx) => idx), []);

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={t('settings.notifications')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <SettingToggleRow
                        label={t('settings.notificationsEnable')}
                        description={t('settings.notificationsDesc')}
                        value={notificationsEnabled}
                        onChange={(value) => {
                            if (!value) {
                                updateSettings({ notificationsEnabled: false }).catch(console.error);
                                return;
                            }
                            ensureNotificationsPermission()
                                .then((granted) => {
                                    if (!granted) return;
                                    updateSettings({ notificationsEnabled: true }).catch(console.error);
                                })
                                .catch(console.error);
                        }}
                    />

                    <SettingToggleRow
                        divider
                        dimmed={!notificationsEnabled}
                        label={t('settings.startDateNotifications')}
                        description={t('settings.startDateNotificationsDesc')}
                        value={startDateNotificationsEnabled}
                        disabled={!notificationsEnabled}
                        onChange={(value) => {
                            if (!value) {
                                updateSettings({ startDateNotificationsEnabled: false }).catch(console.error);
                                return;
                            }
                            ensureNotificationsPermission()
                                .then((granted) => {
                                    if (!granted) return;
                                    updateSettings({ startDateNotificationsEnabled: true }).catch(console.error);
                                })
                                .catch(console.error);
                        }}
                    />

                    <SettingToggleRow
                        divider
                        dimmed={!notificationsEnabled}
                        label={t('settings.dueDateNotifications')}
                        description={t('settings.dueDateNotificationsDesc')}
                        value={dueDateNotificationsEnabled}
                        disabled={!notificationsEnabled}
                        onChange={(value) => {
                            if (!value) {
                                updateSettings({ dueDateNotificationsEnabled: false }).catch(console.error);
                                return;
                            }
                            ensureNotificationsPermission()
                                .then((granted) => {
                                    if (!granted) return;
                                    updateSettings({ dueDateNotificationsEnabled: true }).catch(console.error);
                                })
                                .catch(console.error);
                        }}
                    />

                    {showExactAlarmNotice && (
                        <ExactAlarmNoticeRow
                            divider
                            label={t('settings.exactAlarmsLabel')}
                            description={t('settings.exactAlarmsDesc')}
                            actionLabel={t('settings.exactAlarmsAllow')}
                        />
                    )}

                    {isPersistentCaptureSupported() && (
                        <SettingToggleRow
                            divider
                            label={t('settings.persistentCaptureLabel')}
                            description={t('settings.persistentCaptureDesc')}
                            value={persistentCaptureEnabled}
                            onChange={togglePersistentCapture}
                        />
                    )}
                </View>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                    <SettingToggleRow
                        label={t('settings.weeklyReview')}
                        description={t('settings.weeklyReviewDesc')}
                        value={weeklyReviewEnabled}
                        onChange={(value) => {
                            if (!value) {
                                updateSettings({ weeklyReviewEnabled: false }).catch(console.error);
                                return;
                            }
                            ensureNotificationsPermission()
                                .then((granted) => {
                                    if (!granted) return;
                                    updateSettings({ weeklyReviewEnabled: true }).catch(console.error);
                                })
                                .catch(console.error);
                        }}
                    />

                    <SettingRow
                        divider
                        dimmed={!weeklyReviewEnabled}
                        onPress={() => setWeeklyReviewDayPickerOpen(true)}
                        disabled={!weeklyReviewEnabled}
                        label={t('settings.weeklyReviewDay')}
                        description={getWeekdayLabel(weeklyReviewDay)}
                    />

                    <SettingRow
                        divider
                        dimmed={!weeklyReviewEnabled}
                        onPress={openWeeklyReviewTimePicker}
                        disabled={!weeklyReviewEnabled}
                        label={t('settings.weeklyReviewTime')}
                        description={formatTime(weeklyReviewTime)}
                    />
                </View>

                <Modal
                    transparent
                    visible={weeklyReviewDayPickerOpen}
                    animationType="fade"
                    onRequestClose={() => setWeeklyReviewDayPickerOpen(false)}
                >
                    <Pressable style={styles.pickerOverlay} onPress={() => setWeeklyReviewDayPickerOpen(false)}>
                        <View
                            style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                            onStartShouldSetResponder={() => true}
                        >
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.weeklyReviewDay')}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {weeklyDays.map((idx) => {
                                    const label = getWeekdayLabel(idx);
                                    const selected = weeklyReviewDay === idx;
                                    return (
                                        <TouchableOpacity
                                            key={label}
                                            style={[
                                                styles.pickerOption,
                                                { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                            ]}
                                            onPress={() => {
                                                updateSettings({ weeklyReviewDay: idx }).catch(console.error);
                                                setWeeklyReviewDayPickerOpen(false);
                                            }}
                                        >
                                            <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                {label}
                                            </Text>
                                            {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                    <SettingRow
                        label={t('settings.dailyDigest')}
                        description={t('settings.dailyDigestDesc')}
                    />

                    <SettingToggleRow
                        divider
                        label={t('settings.dailyDigestMorning')}
                        description={`${t('settings.dailyDigestMorningTime')}: ${formatTime(dailyDigestMorningTime)}`}
                        value={dailyDigestMorningEnabled}
                        onChange={(value) => {
                            if (!value) {
                                updateSettings({ dailyDigestMorningEnabled: false }).catch(console.error);
                                return;
                            }
                            ensureNotificationsPermission()
                                .then((granted) => {
                                    if (!granted) return;
                                    updateSettings({ dailyDigestMorningEnabled: true }).catch(console.error);
                                })
                                .catch(console.error);
                        }}
                    />

                    <SettingRow
                        divider
                        dimmed={!dailyDigestMorningEnabled}
                        onPress={() => openDigestTimePicker('morning')}
                        disabled={!dailyDigestMorningEnabled}
                        label={t('settings.dailyDigestMorningTime')}
                        description={formatTime(dailyDigestMorningTime)}
                    />

                    <SettingToggleRow
                        divider
                        label={t('settings.dailyDigestEvening')}
                        description={`${t('settings.dailyDigestEveningTime')}: ${formatTime(dailyDigestEveningTime)}`}
                        value={dailyDigestEveningEnabled}
                        onChange={(value) => {
                            if (!value) {
                                updateSettings({ dailyDigestEveningEnabled: false }).catch(console.error);
                                return;
                            }
                            ensureNotificationsPermission()
                                .then((granted) => {
                                    if (!granted) return;
                                    updateSettings({ dailyDigestEveningEnabled: true }).catch(console.error);
                                })
                                .catch(console.error);
                        }}
                    />

                    <SettingRow
                        divider
                        dimmed={!dailyDigestEveningEnabled}
                        onPress={() => openDigestTimePicker('evening')}
                        disabled={!dailyDigestEveningEnabled}
                        label={t('settings.dailyDigestEveningTime')}
                        description={formatTime(dailyDigestEveningTime)}
                    />
                </View>

                {digestTimePicker && Platform.OS === 'ios' && (
                    <Modal transparent visible animationType="fade" onRequestClose={closeDigestTimePicker}>
                        <Pressable style={styles.pickerOverlay} onPress={closeDigestTimePicker}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>
                                    {digestTimePicker === 'morning' ? t('settings.dailyDigestMorningTime') : t('settings.dailyDigestEveningTime')}
                                </Text>
                                <DateTimePicker
                                    value={digestTimeDraft ?? toTimePickerDate(digestTimePicker === 'morning' ? dailyDigestMorningTime : dailyDigestEveningTime)}
                                    mode="time"
                                    display="spinner"
                                    onChange={(_, date) => {
                                        if (!date) return;
                                        setDigestTimeDraft(date);
                                    }}
                                />
                                <View style={[styles.timePickerActions, { borderTopColor: tc.border }]}>
                                    <TouchableOpacity onPress={closeDigestTimePicker} style={styles.timePickerActionButton}>
                                        <Text style={[styles.timePickerActionText, { color: tc.secondaryText }]}>
                                            {tFallback(t, 'common.cancel', 'Cancel')}
                                        </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity onPress={saveDigestTimePicker} style={styles.timePickerActionButton}>
                                        <Text style={[styles.timePickerActionText, { color: tc.tint }]}>
                                            {tFallback(t, 'common.done', 'Done')}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        </Pressable>
                    </Modal>
                )}

                {digestTimePicker && Platform.OS === 'android' && (
                    <DateTimePicker
                        value={toTimePickerDate(digestTimePicker === 'morning' ? dailyDigestMorningTime : dailyDigestEveningTime)}
                        mode="time"
                        display="default"
                        onChange={(event, date) => {
                            if (event.type === 'dismissed') {
                                setDigestTimePicker(null);
                                return;
                            }
                            onDigestTimeChange(event, date);
                        }}
                    />
                )}

                {weeklyReviewTimePicker && Platform.OS === 'ios' && (
                    <Modal transparent visible animationType="fade" onRequestClose={closeWeeklyReviewTimePicker}>
                        <Pressable style={styles.pickerOverlay} onPress={closeWeeklyReviewTimePicker}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>{t('settings.weeklyReviewTime')}</Text>
                                <DateTimePicker
                                    value={weeklyReviewTimeDraft ?? toTimePickerDate(weeklyReviewTime)}
                                    mode="time"
                                    display="spinner"
                                    onChange={(_, date) => {
                                        if (!date) return;
                                        setWeeklyReviewTimeDraft(date);
                                    }}
                                />
                                <View style={[styles.timePickerActions, { borderTopColor: tc.border }]}>
                                    <TouchableOpacity onPress={closeWeeklyReviewTimePicker} style={styles.timePickerActionButton}>
                                        <Text style={[styles.timePickerActionText, { color: tc.secondaryText }]}>
                                            {tFallback(t, 'common.cancel', 'Cancel')}
                                        </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity onPress={saveWeeklyReviewTimePicker} style={styles.timePickerActionButton}>
                                        <Text style={[styles.timePickerActionText, { color: tc.tint }]}>
                                            {tFallback(t, 'common.done', 'Done')}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        </Pressable>
                    </Modal>
                )}

                {weeklyReviewTimePicker && Platform.OS === 'android' && (
                    <DateTimePicker
                        value={toTimePickerDate(weeklyReviewTime)}
                        mode="time"
                        display="default"
                        onChange={(event, date) => {
                            if (event.type === 'dismissed') {
                                setWeeklyReviewTimePicker(false);
                                return;
                            }
                            onWeeklyReviewTimeChange(event, date);
                        }}
                    />
                )}
            </ScrollView>
        </SafeAreaView>
    );
}
