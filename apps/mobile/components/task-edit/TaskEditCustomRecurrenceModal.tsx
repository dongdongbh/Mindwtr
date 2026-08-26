import React from 'react';
import { Modal, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { useAndroidKeyboardInset } from '../../lib/use-android-keyboard-inset';

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

const getOrdinalTranslationKey =(value: '1' | '2' | '3' | '4' | '-1'): 'first' | 'second' | 'third' | 'fourth' | 'last' => {
    if (value === '-1') return 'last';
    if (value === '1') return 'first';
    if (value === '2') return 'second';
    if (value === '3') return 'third';
    return 'fourth';
};

type TaskEditCustomRecurrenceModalProps = {
    customInterval: number;
    customMode: 'date' | 'nth' | 'lastDay';
    customMonthDays: number[];
    customOrdinal: '1' | '2' | '3' | '4' | '-1';
    customWeekday: string;
    onClose: () => void;
    onSave: () => void;
    recurrenceWeekdayButtons: { key: string; label: string }[];
    recurrenceWeekdayLabels: Record<string, string>;
    setCustomInterval: (value: number) => void;
    setCustomMode: (value: 'date' | 'nth' | 'lastDay') => void;
    toggleCustomMonthDay: (value: number) => void;
    setCustomOrdinal: (value: '1' | '2' | '3' | '4' | '-1') => void;
    setCustomWeekday: (value: string) => void;
    styles: Record<string, any>;
    t: (key: string) => string;
    tc: ThemeColors;
    visible: boolean;
};

export function TaskEditCustomRecurrenceModal({
    customInterval,
    customMode,
    customMonthDays,
    customOrdinal,
    customWeekday,
    onClose,
    onSave,
    recurrenceWeekdayButtons,
    recurrenceWeekdayLabels,
    setCustomInterval,
    setCustomMode,
    toggleCustomMonthDay,
    setCustomOrdinal,
    setCustomWeekday,
    styles,
    t,
    tc,
    visible,
}: TaskEditCustomRecurrenceModalProps) {
    const keyboardInset = useAndroidKeyboardInset(visible);
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean) => ([
        styles.statusText,
        { color: active ? tc.onTint : tc.secondaryText },
    ]);
    const lastDayLabel = t('recurrence.lastDay');
    const numberedMonthDays = customMonthDays.filter((day) => day !== -1);
    const numberedDaysLabel = t('recurrence.onDayOfMonth').replace('{day}', numberedMonthDays.join(', '));
    const monthDaysLabel = customMonthDays.includes(-1)
        ? numberedMonthDays.length > 0
            ? `${numberedDaysLabel} + ${lastDayLabel}`
            : lastDayLabel
        : numberedDaysLabel;

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
        >
            <Pressable
                style={keyboardInset > 0 ? [styles.overlay, { paddingBottom: keyboardInset }] : styles.overlay}
                onPress={onClose}
            >
                <Pressable
                    style={[styles.modalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                    onPress={(event) => event.stopPropagation()}
                >
                    <Text style={[styles.modalTitle, { color: tc.text }]}>{t('recurrence.customTitle')}</Text>
                    <View style={[styles.customRow, { borderColor: tc.border }]}>
                        <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                        <TextInput
                            value={String(customInterval)}
                            onChangeText={(value) => {
                                const parsed = Number.parseInt(value, 10);
                                setCustomInterval(Number.isFinite(parsed) && parsed > 0 ? parsed : 1);
                            }}
                            keyboardType="number-pad"
                            style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                            accessibilityLabel={t('recurrence.repeatEvery')}
                            accessibilityHint={t('recurrence.monthUnit')}
                        />
                        <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.monthUnit')}</Text>
                    </View>
                    <View style={{ marginTop: 12 }}>
                        <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.onLabel')}</Text>
                        <View style={[styles.statusContainer, { marginTop: 8 }]}>
                            <TouchableOpacity
                                style={getStatusChipStyle(customMode === 'date')}
                                onPress={() => setCustomMode('date')}
                            >
                                <Text style={getStatusTextStyle(customMode === 'date')}>
                                    {monthDaysLabel}
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={getStatusChipStyle(customMode === 'lastDay')}
                                onPress={() => setCustomMode('lastDay')}
                            >
                                <Text style={getStatusTextStyle(customMode === 'lastDay')}>
                                    {lastDayLabel}
                                </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={getStatusChipStyle(customMode === 'nth')}
                                onPress={() => setCustomMode('nth')}
                            >
                                <Text style={getStatusTextStyle(customMode === 'nth')}>
                                    {t('recurrence.onNthWeekday')
                                        .replace('{ordinal}', t(`recurrence.ordinal.${getOrdinalTranslationKey(customOrdinal)}`))
                                        .replace('{weekday}', recurrenceWeekdayLabels[customWeekday] ?? customWeekday)}
                                </Text>
                            </TouchableOpacity>
                        </View>
                        {customMode === 'nth' && (
                            <>
                                <View style={[styles.weekdayRow, { marginTop: 10, flexWrap: 'wrap' }]}>
                                    {(['1', '2', '3', '4', '-1'] as const).map((value) => {
                                        const label = t(`recurrence.ordinal.${getOrdinalTranslationKey(value)}`);
                                        return (
                                            <TouchableOpacity
                                                key={value}
                                                style={[
                                                    styles.ordinalButton,
                                                    {
                                                        borderColor: customOrdinal === value ? tc.tint : tc.border,
                                                        backgroundColor: customOrdinal === value ? tc.tint : tc.cardBg,
                                                    },
                                                ]}
                                                onPress={() => setCustomOrdinal(value)}
                                            >
                                                <Text style={[styles.weekdayButtonText, { color: customOrdinal === value ? tc.onTint : tc.text }]}>{label}</Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                                <View style={[styles.weekdayRow, { marginTop: 10 }]}>
                                    {recurrenceWeekdayButtons.map((day) => {
                                        const active = customWeekday === day.key;
                                        return (
                                            <TouchableOpacity
                                                key={day.key}
                                                style={[
                                                    styles.weekdayButton,
                                                    {
                                                        borderColor: active ? tc.tint : tc.border,
                                                        backgroundColor: active ? tc.tint : tc.cardBg,
                                                    },
                                                ]}
                                                onPress={() => setCustomWeekday(day.key)}
                                            >
                                                <Text style={[styles.weekdayButtonText, { color: active ? tc.onTint : tc.text }]}>{day.label}</Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            </>
                        )}
                        {customMode === 'date' && (
                            <View style={[styles.monthDayGrid, { marginTop: 10 }]}>
                                {MONTH_DAYS.map((day) => {
                                    const active = customMonthDays.includes(day);
                                    return (
                                        <TouchableOpacity
                                            key={day}
                                            style={styles.monthDayCell}
                                            onPress={() => toggleCustomMonthDay(day)}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected: active }}
                                            accessibilityLabel={t('recurrence.onDayOfMonth').replace('{day}', String(day))}
                                        >
                                            <View
                                                style={[
                                                    styles.monthDayButton,
                                                    {
                                                        borderColor: active ? tc.tint : tc.border,
                                                        backgroundColor: active ? tc.tint : tc.cardBg,
                                                    },
                                                ]}
                                            >
                                                <Text style={[styles.weekdayButtonText, { color: active ? tc.onTint : tc.text }]}>{day}</Text>
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                                <TouchableOpacity
                                    style={styles.monthDayCell}
                                    onPress={() => toggleCustomMonthDay(-1)}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: customMonthDays.includes(-1) }}
                                    accessibilityLabel={`${t('common.add')} ${lastDayLabel}`}
                                >
                                    <View
                                        style={[
                                            styles.monthDayButton,
                                            {
                                                borderColor: customMonthDays.includes(-1) ? tc.tint : tc.border,
                                                backgroundColor: customMonthDays.includes(-1) ? tc.tint : tc.cardBg,
                                            },
                                        ]}
                                    >
                                        <Text
                                            style={[
                                                styles.weekdayButtonText,
                                                { color: customMonthDays.includes(-1) ? tc.onTint : tc.text },
                                            ]}
                                        >
                                            {t('recurrence.ordinal.last')}
                                        </Text>
                                    </View>
                                </TouchableOpacity>
                            </View>
                        )}
                    </View>
                    <View style={styles.modalButtons}>
                        <TouchableOpacity style={styles.modalButton} onPress={onClose}>
                            <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.modalButton} onPress={onSave}>
                            <Text style={[styles.modalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
                        </TouchableOpacity>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}
