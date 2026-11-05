import React, { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
    createTaskDraft,
    formatTaskEditorDate,
    getTaskDraftDateEdit,
    getTaskEditorDateIssueLabel,
    normalizeClockTimeInput,
    safeFormatDate,
    safeParseDate,
    setTaskDraftDate,
    setTaskDraftField,
    taskDraftToChangedUpdatePatch,
    tFallback,
    useTaskStore,
    type Task,
    type TaskDraft,
    type TaskDraftField,
} from '@mindwtr/core';

import type { ThemeColors } from '../../hooks/use-theme-colors';
import { QuickDateChips } from '../QuickDateChips';
import { styles } from './swipeable-task-item.styles';

type DateField = 'startTime' | 'dueDate';

type Props = {
    task: Task;
    tc: ThemeColors;
    t: (key: string) => string;
    onClose: () => void;

    onSave: (patch: Partial<Task>) => void;
};


export function SwipeableTaskItemDatesSheet({ task, tc, t, onClose, onSave }: Props) {


    const [baseTask] = useState(task);
    const [draft, setDraft] = useState<TaskDraft>(() => createTaskDraft(baseTask));
    const [pickerField, setPickerField] = useState<DateField | null>(null);
    const { height: windowHeight } = useWindowDimensions();
    const defaultScheduleTime = useTaskStore((state) => normalizeClockTimeInput(state.settings?.gtd?.defaultScheduleTime) || '');
    const notSet = tFallback(t, 'common.notSet', 'Not set');
    const dateIssue = getTaskEditorDateIssueLabel(draft, t);

    const setDate = (field: DateField, day: Date | null) => {
        setDraft((current) => {
            const value = day ? setTaskDraftDate(field, current[field], day, { defaultScheduleTime, formatDate: safeFormatDate }) : '';
            return Object.entries(getTaskDraftDateEdit(field, value)).reduce(
                (next, [key, fieldValue]) => setTaskDraftField(next, key as TaskDraftField, fieldValue as never),
                current,
            );
        });
    };

    const save = () => {
        const patch = taskDraftToChangedUpdatePatch(draft, baseTask);
        if (patch && Object.keys(patch).length > 0) onSave(patch);
        else onClose();
    };

    const renderField = (field: DateField) => {
        const label = field === 'startTime'
            ? tFallback(t, 'taskEdit.startDateLabel', 'Start Date')
            : tFallback(t, 'taskEdit.dueDateLabel', 'Due Date');
        const value = formatTaskEditorDate(draft[field], safeFormatDate, notSet, { due: field === 'dueDate' });
        return (
            <View key={field} style={{ marginTop: 12 }}>
                <Text style={[styles.menuText, { color: tc.secondaryText }]}>{label}</Text>
                <Pressable
                    style={[styles.menuMoveItem, { borderColor: tc.border, marginTop: 6, minHeight: 48 }]}
                    onPress={() => setPickerField(field)}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityValue={{ text: value }}
                >
                    <Text style={[styles.menuMoveText, { color: tc.text }]}>{value}</Text>
                </Pressable>
                <QuickDateChips
                    t={t}
                    tc={tc}
                    accessibilityLabelPrefix={label}
                    selectedDate={safeParseDate(draft[field])}
                    chipStyle={{ minHeight: 48 }}
                    onSelect={(day) => {
                        setPickerField(null);
                        setDate(field, day);
                    }}
                />
                {pickerField === field ? (
                    <View>
                        {Platform.OS === 'ios' ? (
                            <Pressable
                                onPress={() => setPickerField(null)}
                                style={{ minHeight: 48, justifyContent: 'center', alignItems: 'flex-end' }}
                                accessibilityRole="button"
                                accessibilityLabel={`${label}: ${tFallback(t, 'common.done', 'Done')}`}
                            >
                                <Text style={{ color: tc.tint }}>{tFallback(t, 'common.done', 'Done')}</Text>
                            </Pressable>
                        ) : null}
                        <DateTimePicker
                            value={safeParseDate(draft[field]) ?? new Date()}
                            mode="date"
                            display={Platform.OS === 'ios' ? 'inline' : 'default'}
                            textColor={tc.text}
                            onChange={(event, day) => {
                                if (Platform.OS !== 'ios' || event.type === 'dismissed') setPickerField(null);
                                if (event.type !== 'dismissed' && day) setDate(field, day);
                            }}
                        />
                    </View>
                ) : null}
            </View>
        );
    };

    return (
        <Modal visible transparent animationType="fade" onRequestClose={onClose} accessibilityViewIsModal>
            <Pressable style={styles.modalOverlay} onPress={onClose}>
                {                                                                }
                <Pressable style={[styles.menuContainer, { backgroundColor: tc.cardBg }]} onPress={() => undefined}>
                    <Text style={[styles.menuTitle, { color: tc.text }]} accessibilityRole="header">
                        {tFallback(t, 'filters.taskDates', 'Task dates')}
                    </Text>
                    {                                                                                           }
                    <ScrollView style={{ maxHeight: windowHeight * 0.6 }} keyboardShouldPersistTaps="handled">
                        {renderField('startTime')}
                        {renderField('dueDate')}
                        {dateIssue ? <Text style={{ marginTop: 8, color: tc.warning }}>{dateIssue}</Text> : null}
                    </ScrollView>
                    <View style={[styles.menuMoveActions, { flexDirection: 'row' }]}>
                        <Pressable
                            style={[styles.menuMoveItem, { flex: 1, minHeight: 48, borderColor: tc.border }]}
                            onPress={onClose}
                            accessibilityRole="button"
                            accessibilityLabel={tFallback(t, 'common.cancel', 'Cancel')}
                        >
                            <Text style={[styles.menuMoveText, { color: tc.text }]}>{tFallback(t, 'common.cancel', 'Cancel')}</Text>
                        </Pressable>
                        <Pressable
                            style={[styles.menuMoveItem, { flex: 1, minHeight: 48, borderColor: tc.tint, backgroundColor: tc.tint }]}
                            onPress={save}
                            accessibilityRole="button"
                            accessibilityLabel={tFallback(t, 'common.save', 'Save')}
                        >
                            <Text style={[styles.menuMoveText, { color: tc.onTint }]}>{tFallback(t, 'common.save', 'Save')}</Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}
