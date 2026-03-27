import React, { useCallback, useMemo, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Switch, Text, TouchableOpacity, View } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { SafeAreaView } from 'react-native-safe-area-context';

import { normalizeDateFormatSetting, resolveDateLocaleTag, useTaskStore } from '@mindwtr/core';

import { requestNotificationPermission, startMobileNotifications } from '@/lib/notification-service';
import { useThemeColors } from '@/hooks/use-theme-colors';

import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar, SubHeader } from './settings.shell';
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

    const notificationsEnabled = settings.notificationsEnabled !== false;
    const dailyDigestMorningEnabled = settings.dailyDigestMorningEnabled === true;
    const dailyDigestEveningEnabled = settings.dailyDigestEveningEnabled === true;
    const dailyDigestMorningTime = settings.dailyDigestMorningTime || '09:00';
    const dailyDigestEveningTime = settings.dailyDigestEveningTime || '20:00';
    const weeklyReviewEnabled = settings.weeklyReviewEnabled === true;
    const weeklyReviewTime = settings.weeklyReviewTime || '18:00';
    const weeklyReviewDay = Number.isFinite(settings.weeklyReviewDay) ? (settings.weeklyReviewDay as number) : 0;
    const dateFormat = normalizeDateFormatSetting(settings.dateFormat);
    const systemLocale = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
        ? Intl.DateTimeFormat().resolvedOptions().locale
        : '';
    const locale = resolveDateLocaleTag({ language, dateFormat, systemLocale });

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
            <SettingsTopBar />
            <SubHeader title={t('settings.notifications')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={styles.settingRow}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.notificationsEnable')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.notificationsDesc')}</Text>
                        </View>
                        <Switch
                            value={notificationsEnabled}
                            onValueChange={(value) => {
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
                            trackColor={{ false: '#767577', true: '#3B82F6' }}
                        />
                    </View>
                </View>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                    <View style={styles.settingRow}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.weeklyReview')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.weeklyReviewDesc')}</Text>
                        </View>
                        <Switch
                            value={weeklyReviewEnabled}
                            onValueChange={(value) => {
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
                            trackColor={{ false: '#767577', true: '#3B82F6' }}
                            disabled={!notificationsEnabled}
                        />
                    </View>

                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => setWeeklyReviewDayPickerOpen(true)}
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
                        onPress={openWeeklyReviewTimePicker}
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
                    <View style={styles.settingRow}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.dailyDigest')}</Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.dailyDigestDesc')}</Text>
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
                            onValueChange={(value) => {
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
                            trackColor={{ false: '#767577', true: '#3B82F6' }}
                        />
                    </View>

                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => openDigestTimePicker('morning')}
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
                            onValueChange={(value) => {
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
                            trackColor={{ false: '#767577', true: '#3B82F6' }}
                        />
                    </View>

                    <TouchableOpacity
                        style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                        onPress={() => openDigestTimePicker('evening')}
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
                                            {t('common.cancel') || 'Cancel'}
                                        </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity onPress={saveDigestTimePicker} style={styles.timePickerActionButton}>
                                        <Text style={[styles.timePickerActionText, { color: tc.tint }]}>
                                            {t('common.done') || 'Done'}
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
                                            {t('common.cancel') || 'Cancel'}
                                        </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity onPress={saveWeeklyReviewTimePicker} style={styles.timePickerActionButton}>
                                        <Text style={[styles.timePickerActionText, { color: tc.tint }]}>
                                            {t('common.done') || 'Done'}
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
