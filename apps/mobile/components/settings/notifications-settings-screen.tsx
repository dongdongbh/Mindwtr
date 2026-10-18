import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Check } from 'lucide-react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    buildNotificationsSettingsModel,
    buildNotificationsSettingsUpdate,
    type NotificationsSettingsEdit,
    type NotificationsSettingsModel,
    useTaskStore,
    tFallback,
} from '@mindwtr/core';

import { requestNotificationPermission, startMobileNotifications } from '@/lib/notification-service';
import {
    applyPersistentCaptureNotification,
    isPersistentCaptureSupported,
    readPersistentCaptureEnabled,
    writePersistentCaptureEnabled,
} from '@/lib/persistent-capture-notification';
import { isIosAppBadgeSupported, readIosAppBadgeEnabled, setIosAppBadgeEnabled } from '@/lib/ios-app-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';

import { ExactAlarmNoticeRow, useExactAlarmPermission } from './exact-alarm-notice';
import { SettingRow, SettingToggleRow } from './setting-row';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';

type Toggle = NotificationsSettingsModel['reminders']['enable'];
type TimeRow = NotificationsSettingsModel['weeklyReview']['time'];

const toTimePickerDate = (row: TimeRow) => {
    const date = new Date();
    date.setHours(row.hour, row.minute, 0, 0);
    return date;
};
const toTimeValue = (date: Date) => {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
};

/** Settings › Notifications, drawn from core's model (packages/core/src/notifications-settings-model.ts), which the native app draws too. */
export function NotificationsSettingsScreen() {
    const tc = useThemeColors();
    const { language, t } = useSettingsLocalization();
    const { settings, updateSettings } = useTaskStore();
    const scrollContentStyle = useSettingsScrollContent();
    const [timePicker, setTimePicker] = useState<TimeRow['type'] | null>(null);
    const [timeDraft, setTimeDraft] = useState<Date | null>(null);
    const [choicePicker, setChoicePicker] = useState<'weeklyReviewDay' | 'taskReminderDefault' | null>(null);
    const [persistentCaptureEnabled, setPersistentCaptureEnabled] = useState(false);
    const badgeSupported = isIosAppBadgeSupported();
    const [badgeEnabled, setBadgeEnabled] = useState(false);
    const [badgeReady, setBadgeReady] = useState(false);
    const [badgeBusy, setBadgeBusy] = useState(false);
    const badgePending = useRef(false);
    const badgeMounted = useRef(false);
    const badgeTranslate = useRef(t);
    badgeTranslate.current = t;
    useEffect(() => {
        badgeMounted.current = true;
        let cancelled = false;
        if (badgeSupported) {
            readIosAppBadgeEnabled().then((enabled) => {
                if (cancelled) return;
                setBadgeEnabled(enabled);
                setBadgeReady(true);
            }).catch(() => {
                if (!cancelled) Alert.alert(badgeTranslate.current('settings.appIconBadge'), badgeTranslate.current('settings.appIconBadgeError'));
            });
        }
        return () => { cancelled = true; badgeMounted.current = false; };
    }, [badgeSupported]);
    const changeBadge = async (enabled: boolean) => {
        if (!badgeReady || badgePending.current) return;
        badgePending.current = true;
        setBadgeBusy(true);
        try {
            const result = await setIosAppBadgeEnabled(enabled);
            if (!badgeMounted.current) return;
            if (result === 'enabled' || result === 'disabled') {
                setBadgeEnabled(result === 'enabled');
            } else {
                Alert.alert(t('settings.appIconBadge'), t(result === 'denied'
                    ? 'settings.appIconBadgeDenied' : 'settings.appIconBadgeError'));
            }
        } catch {
            if (badgeMounted.current) Alert.alert(t('settings.appIconBadge'), t('settings.appIconBadgeError'));
        } finally {
            badgePending.current = false;
            if (badgeMounted.current) setBadgeBusy(false);
        }
    };
    const persistentCaptureSupported = isPersistentCaptureSupported();

    const systemLocale = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
        ? Intl.DateTimeFormat().resolvedOptions().locale
        : '';
    const model = useMemo(() => buildNotificationsSettingsModel({
        settings,
        t,
        language,
        systemLocale,
        persistentCapture: persistentCaptureSupported ? { enabled: persistentCaptureEnabled } : undefined,
    }), [language, persistentCaptureEnabled, persistentCaptureSupported, settings, systemLocale, t]);
    const { reminders, weeklyReview, dailyDigest } = model;
    const choiceRow = choicePicker === 'taskReminderDefault' ? reminders.taskDefault : weeklyReview.day;
    const { showNotice: showExactAlarmNotice } = useExactAlarmPermission(reminders.exactAlarmNotice !== null);
    const timeRows: Record<TimeRow['type'], TimeRow> = {
        weeklyReviewTime: weeklyReview.time,
        dailyDigestMorningTime: dailyDigest.morningTime,
        dailyDigestEveningTime: dailyDigest.eveningTime,
    };
    const openTimeRow = timePicker ? timeRows[timePicker] : null;

    useEffect(() => {
        if (!persistentCaptureSupported) return;
        readPersistentCaptureEnabled().then(setPersistentCaptureEnabled).catch(console.error);
    }, [persistentCaptureSupported]);

    const ensureNotificationsPermission = useCallback(async () => {
        const result = await requestNotificationPermission();
        if (result.granted) {
            startMobileNotifications().catch(console.error);
            return true;
        }
        return false;
    }, []);

    const applyEdit = useCallback((edit: NotificationsSettingsEdit) => {
        const update = buildNotificationsSettingsUpdate(edit);
        if (update) {
            updateSettings(update).catch(console.error);
            return;
        }
        // The persistent capture notification is this device's own switch, never a synced setting.
        const enabled = edit.value as boolean;
        setPersistentCaptureEnabled(enabled);
        applyPersistentCaptureNotification(enabled, model.persistentCaptureNotification);
        writePersistentCaptureEnabled(enabled).catch(console.error);
    }, [model.persistentCaptureNotification, updateSettings]);

    const onToggle = (toggle: Toggle) => () => {
        if (!toggle.askPermission) {
            applyEdit(toggle.edit);
            return;
        }
        ensureNotificationsPermission()
            .then((granted) => {
                if (!granted) return;
                applyEdit(toggle.edit);
            })
            .catch(console.error);
    };
    const toggleRow = (toggle: Toggle, divider = true) => (
        <SettingToggleRow
            divider={divider}
            dimmed={toggle.disabled}
            label={toggle.label}
            description={toggle.description}
            value={toggle.value}
            disabled={toggle.disabled}
            onChange={onToggle(toggle)}
        />
    );

    const openTimePicker = (row: TimeRow) => {
        setTimePicker(row.type);
        if (Platform.OS !== 'ios') return;
        setTimeDraft(toTimePickerDate(row));
    };
    const timeRow = (row: TimeRow) => (
        <SettingRow
            divider
            dimmed={row.disabled}
            onPress={() => openTimePicker(row)}
            disabled={row.disabled}
            label={row.label}
            description={row.description}
        />
    );
    const closeTimePicker = useCallback(() => {
        setTimePicker(null);
        setTimeDraft(null);
    }, []);
    const saveTime = (type: TimeRow['type'], selected: Date | null | undefined) => {
        if (!selected) return;
        applyEdit({ type, value: toTimeValue(selected) });
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={model.title} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    {toggleRow(reminders.enable, false)}
                    <SettingRow
                        testID="task-reminder-default"
                        divider
                        onPress={() => setChoicePicker('taskReminderDefault')}
                        accessibilityRole="button"
                        accessibilityLabel={`${reminders.taskDefault.label}: ${reminders.taskDefault.description}`}
                        label={reminders.taskDefault.label}
                        description={reminders.taskDefault.description}
                    />
                    {toggleRow(reminders.startReminders)}
                    {toggleRow(reminders.dueReminders)}

                    {showExactAlarmNotice && reminders.exactAlarmNotice && (
                        <ExactAlarmNoticeRow
                            divider
                            label={reminders.exactAlarmNotice.label}
                            description={reminders.exactAlarmNotice.description}
                            actionLabel={reminders.exactAlarmNotice.actionLabel}
                        />
                    )}

                    {reminders.persistentCapture && toggleRow(reminders.persistentCapture)}
                </View>

                {badgeSupported && (
                    <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                        <SettingToggleRow
                            testID="app-icon-badge"
                            label={t('settings.appIconBadge')}
                            description={t('settings.appIconBadgeHint')}
                            value={badgeEnabled}
                            disabled={!badgeReady || badgeBusy}
                            onChange={(enabled) => { void changeBadge(enabled); }}
                        />
                    </View>
                )}

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>

                    {toggleRow(weeklyReview.enable, false)}

                    <SettingRow
                        divider
                        dimmed={weeklyReview.day.disabled}
                        onPress={() => setChoicePicker('weeklyReviewDay')}
                        disabled={weeklyReview.day.disabled}
                        label={weeklyReview.day.label}
                        description={weeklyReview.day.description}
                    />

                    {timeRow(weeklyReview.time)}
                </View>

                <Modal
                    transparent
                    visible={choicePicker !== null}
                    animationType="fade"
                    onRequestClose={() => setChoicePicker(null)}
                >
                    <Pressable style={styles.pickerOverlay} onPress={() => setChoicePicker(null)}>
                        <View
                            style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                            onStartShouldSetResponder={() => true}
                        >
                            <Text style={[styles.pickerTitle, { color: tc.text }]}>{choiceRow.pickerTitle}</Text>
                            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                {choiceRow.options.map((option) => (
                                    <TouchableOpacity
                                        key={option.label}
                                        accessibilityRole="radio"
                                        accessibilityLabel={option.label}
                                        accessibilityState={{ checked: option.selected }}
                                        style={[
                                            styles.pickerOption,
                                            { borderColor: tc.border, backgroundColor: option.selected ? tc.filterBg : 'transparent' },
                                        ]}
                                        onPress={() => {
                                            applyEdit(option.edit);
                                            setChoicePicker(null);
                                        }}
                                    >
                                        <Text style={[styles.pickerOptionText, { color: option.selected ? tc.tint : tc.text }]}>
                                            {option.label}
                                        </Text>
                                        {option.selected && <Check size={18} color={tc.tint} strokeWidth={2.5} />}
                                    </TouchableOpacity>
                                ))}
                            </ScrollView>
                        </View>
                    </Pressable>
                </Modal>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                    <SettingRow
                        label={dailyDigest.label}
                        description={dailyDigest.description}
                    />

                    {toggleRow(dailyDigest.morning)}
                    {timeRow(dailyDigest.morningTime)}
                    {toggleRow(dailyDigest.evening)}
                    {timeRow(dailyDigest.eveningTime)}
                </View>

                {openTimeRow && Platform.OS === 'ios' && (
                    <Modal transparent visible animationType="fade" onRequestClose={closeTimePicker}>
                        <Pressable style={styles.pickerOverlay} onPress={closeTimePicker}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>{openTimeRow.label}</Text>
                                <DateTimePicker
                                    value={timeDraft ?? toTimePickerDate(openTimeRow)}
                                    mode="time"
                                    display="spinner"
                                    onChange={(_, date) => {
                                        if (!date) return;
                                        setTimeDraft(date);
                                    }}
                                />
                                <View style={[styles.timePickerActions, { borderTopColor: tc.border }]}>
                                    <TouchableOpacity onPress={closeTimePicker} style={styles.timePickerActionButton}>
                                        <Text style={[styles.timePickerActionText, { color: tc.secondaryText }]}>
                                            {tFallback(t, 'common.cancel', 'Cancel')}
                                        </Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        onPress={() => {
                                            closeTimePicker();
                                            saveTime(openTimeRow.type, timeDraft);
                                        }}
                                        style={styles.timePickerActionButton}
                                    >
                                        <Text style={[styles.timePickerActionText, { color: tc.tint }]}>
                                            {tFallback(t, 'common.done', 'Done')}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        </Pressable>
                    </Modal>
                )}

                {openTimeRow && Platform.OS === 'android' && (
                    <DateTimePicker
                        value={toTimePickerDate(openTimeRow)}
                        mode="time"
                        display="default"
                        onChange={(event, date) => {
                            setTimePicker(null);
                            if (event.type === 'dismissed') return;
                            saveTime(openTimeRow.type, date);
                        }}
                    />
                )}
            </ScrollView>
        </SafeAreaView>
    );
}
