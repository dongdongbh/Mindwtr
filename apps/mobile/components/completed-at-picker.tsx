import React, { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { normalizeTimeSpentMinutes, resolveTaskEditorBackdatedCompletion, tFallback } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';

type CompletedAtPickerProps = {

    initialValue?: string;
    initialTimeSpentMinutes?: number;
    showTimeSpent?: boolean;
    onCancel: () => void;
    onConfirm: (iso: string, timeSpentMinutes?: number) => void;
    t: (key: string) => string;
    tc: ThemeColors;
};

const toValidDate = (value?: string): Date => {
    if (!value) return new Date();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};


export function CompletedAtPicker({
    initialValue,
    initialTimeSpentMinutes,
    showTimeSpent = false,
    onCancel,
    onConfirm,
    t,
    tc,
}: CompletedAtPickerProps) {
    const [draft, setDraft] = useState<Date>(() => toValidDate(initialValue));
    const [timeSpentDraft, setTimeSpentDraft] = useState(
        () => normalizeTimeSpentMinutes(initialTimeSpentMinutes)?.toString() ?? ''
    );
    const [androidStep, setAndroidStep] = useState<'date' | 'time' | 'details'>('date');

    const confirm = (date: Date) => {
        const patch = resolveTaskEditorBackdatedCompletion({
            completedAt: date.toISOString(),
            ...(showTimeSpent ? { timeSpentText: timeSpentDraft } : {}),
        });
        if (!patch) return;
        if (showTimeSpent) onConfirm(patch.completedAt, patch.timeSpentMinutes);
        else onConfirm(patch.completedAt);
    };

    if (Platform.OS === 'android' && androidStep !== 'details') {
        return (
            <DateTimePicker
                key={androidStep}
                value={draft}
                mode={androidStep}
                display="default"
                onChange={(event: DateTimePickerEvent, selected?: Date) => {
                    if (event.type === 'dismissed' || !selected) {
                        onCancel();
                        return;
                    }
                    if (androidStep === 'date') {
                        const next = new Date(draft);
                        next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
                        setDraft(next);
                        setAndroidStep('time');
                        return;
                    }
                    const next = new Date(draft);
                    next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
                    if (showTimeSpent) {
                        setDraft(next);
                        setAndroidStep('details');
                        return;
                    }
                    confirm(next);
                }}
            />
        );
    }

    return (
        <Modal visible transparent animationType="fade" onRequestClose={onCancel} accessibilityViewIsModal>
            <Pressable style={styles.overlay} onPress={onCancel}>
                <Pressable
                    style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                    onPress={(event) => event.stopPropagation()}
                >
                    <Text style={[styles.title, { color: tc.text }]} accessibilityRole="header">
                        {tFallback(t, 'task.completedAtPromptTitle', 'Completion time')}
                    </Text>
                    {Platform.OS === 'android' ? (
                        <Text style={[styles.completionValue, { color: tc.text }]}>
                            {draft.toLocaleString()}
                        </Text>
                    ) : (
                        <DateTimePicker
                            value={draft}
                            mode="datetime"
                            display="spinner"
                            textColor={tc.text}
                            onChange={(_event: DateTimePickerEvent, selected?: Date) => {
                                if (selected) setDraft(selected);
                            }}
                        />
                    )}
                    {showTimeSpent ? (
                        <>
                            <Text style={[styles.fieldLabel, { color: tc.secondaryText }]}>
                                {tFallback(t, 'taskEdit.timeSpentLabel', 'Time Spent')}
                            </Text>
                            <TextInput
                                value={timeSpentDraft}
                                onChangeText={(text) => setTimeSpentDraft(text.replace(/[^0-9]/g, ''))}
                                keyboardType="number-pad"
                                placeholder={tFallback(t, 'taskEdit.timeSpentPlaceholder', 'minutes')}
                                placeholderTextColor={tc.secondaryText}
                                accessibilityLabel={tFallback(t, 'taskEdit.timeSpentLabel', 'Time Spent')}
                                style={[
                                    styles.input,
                                    { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text },
                                ]}
                            />
                        </>
                    ) : null}
                    <View style={styles.actions}>
                        <Pressable
                            onPress={onCancel}
                            accessibilityRole="button"
                            accessibilityLabel={tFallback(t, 'common.cancel', 'Cancel')}
                            style={styles.actionButton}
                        >
                            <Text style={[styles.actionText, { color: tc.secondaryText }]}>
                                {tFallback(t, 'common.cancel', 'Cancel')}
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() => confirm(draft)}
                            accessibilityRole="button"
                            accessibilityLabel={tFallback(t, 'common.save', 'Save')}
                            style={styles.actionButton}
                        >
                            <Text style={[styles.actionText, { color: tc.tint }]}>
                                {tFallback(t, 'common.save', 'Save')}
                            </Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    card: {
        width: '100%',
        maxWidth: 360,
        borderRadius: 16,
        borderWidth: 1,
        padding: 16,
    },
    title: {
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 8,
        textAlign: 'center',
    },
    completionValue: {
        fontSize: 15,
        textAlign: 'center',
        marginBottom: 16,
    },
    fieldLabel: {
        fontSize: 13,
        fontWeight: '500',
        marginBottom: 6,
    },
    input: {
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 16,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 16,
        marginTop: 8,
    },
    actionButton: {
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    actionText: {
        fontSize: 15,
        fontWeight: '600',
    },
});
