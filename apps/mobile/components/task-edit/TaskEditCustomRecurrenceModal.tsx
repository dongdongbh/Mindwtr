import React from 'react';
import { Modal, Pressable, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { ThemeColors } from '@/hooks/use-theme-colors';

const getOrdinalTranslationKey = (value: '1' | '2' | '3' | '4' | '-1'): 'first' | 'second' | 'third' | 'fourth' | 'last' => {
    if (value === '-1') return 'last';
    if (value === '1') return 'first';
    if (value === '2') return 'second';
    if (value === '3') return 'third';
    return 'fourth';
};

type TaskEditCustomRecurrenceModalProps = {
    customInterval: number;
    customMode: 'date' | 'nth';
    customMonthDay: number;
    customOrdinal: '1' | '2' | '3' | '4' | '-1';
    customWeekday: string;
    onClose: () => void;
    onSave: () => void;
    recurrenceWeekdayButtons: { key: string; label: string }[];
    recurrenceWeekdayLabels: Record<string, string>;
    setCustomInterval: (value: number) => void;
    setCustomMode: (value: 'date' | 'nth') => void;
    setCustomMonthDay: (value: number) => void;
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
    customMonthDay,
    customOrdinal,
    customWeekday,
    onClose,
    onSave,
    recurrenceWeekdayButtons,
    recurrenceWeekdayLabels,
    setCustomInterval,
    setCustomMode,
    setCustomMonthDay,
    setCustomOrdinal,
    setCustomWeekday,
    styles,
    t,
    tc,
    visible,
}: TaskEditCustomRecurrenceModalProps) {
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean) => ([
        styles.statusText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
        >
            <Pressable style={styles.overlay} onPress={onClose}>
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
                                    {t('recurrence.onDayOfMonth').replace('{day}', String(customMonthDay))}
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
                                                        borderColor: tc.border,
                                                        backgroundColor: customOrdinal === value ? tc.filterBg : tc.cardBg,
                                                    },
                                                ]}
                                                onPress={() => setCustomOrdinal(value)}
                                            >
                                                <Text style={[styles.weekdayButtonText, { color: tc.text }]}>{label}</Text>
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
                                                        borderColor: tc.border,
                                                        backgroundColor: active ? tc.filterBg : tc.cardBg,
                                                    },
                                                ]}
                                                onPress={() => setCustomWeekday(day.key)}
                                            >
                                                <Text style={[styles.weekdayButtonText, { color: tc.text }]}>{day.label}</Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            </>
                        )}
                        {customMode === 'date' && (
                            <View style={[styles.customRow, { marginTop: 10 }]}>
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>
                                    {t('recurrence.onDayOfMonth').replace('{day}', '')}
                                </Text>
                                <TextInput
                                    value={String(customMonthDay)}
                                    onChangeText={(value) => {
                                        const parsed = Number.parseInt(value, 10);
                                        if (!Number.isFinite(parsed)) {
                                            setCustomMonthDay(1);
                                        } else {
                                            setCustomMonthDay(Math.min(Math.max(parsed, 1), 31));
                                        }
                                    }}
                                    keyboardType="number-pad"
                                    style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    accessibilityLabel={t('recurrence.onDayOfMonth').replace('{day}', '')}
                                    accessibilityHint={t('recurrence.monthlyOnDay')}
                                />
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
