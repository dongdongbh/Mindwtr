import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Modal, StyleSheet, TouchableOpacity, ScrollView, Platform, KeyboardAvoidingView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Task, TaskStatus, TimeEstimate, useTaskStore, generateUUID, PRESET_TAGS, RecurrenceRule, RECURRENCE_RULES } from '@mindwtr/core';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useLanguage } from '../contexts/language-context';

interface TaskEditModalProps {
    visible: boolean;
    task: Task | null;
    onClose: () => void;
    onSave: (taskId: string, updates: Partial<Task>) => void;
    onFocusMode?: (taskId: string) => void;
}

const STATUS_OPTIONS: TaskStatus[] = ['inbox', 'todo', 'next', 'in-progress', 'waiting', 'someday', 'done', 'archived'];

export function TaskEditModal({ visible, task, onClose, onSave, onFocusMode }: TaskEditModalProps) {
    const { tasks } = useTaskStore();
    const { t } = useLanguage();
    const [editedTask, setEditedTask] = useState<Partial<Task>>({});
    const [showDatePicker, setShowDatePicker] = useState<'start' | 'due' | 'review' | null>(null);
    const [focusMode, setFocusMode] = useState(false);

    // Compute most frequent tags from all tasks
    const suggestedTags = React.useMemo(() => {
        const counts = new Map<string, number>();
        tasks.forEach(t => {
            t.contexts?.forEach(ctx => {
                counts.set(ctx, (counts.get(ctx) || 0) + 1);
            });
        });

        const sorted = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1]) // Sort desc by count
            .map(([tag]) => tag);

        // Add default tags if we don't have enough history
        const defaults = ['@home', '@work', '@errands', '@computer', '@phone'];
        const unique = new Set([...sorted, ...defaults]);

        return Array.from(unique).slice(0, 8);
    }, [tasks]);

    // Compute most frequent tags (hashtags)
    const suggestedHashtags = React.useMemo(() => {
        const counts = new Map<string, number>();
        tasks.forEach(t => {
            t.tags?.forEach(tag => {
                counts.set(tag, (counts.get(tag) || 0) + 1);
            });
        });

        const sorted = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1]) // Sort desc by count
            .map(([tag]) => tag);

        // Explicitly cast PRESET_TAGS to string[] or use it directly
        // TS Error Fix: If PRESET_TAGS is constant tuple, spread works but type might need assertion
        // But TS says "Cannot find name", so import is the key.
        const unique = new Set([...sorted, ...PRESET_TAGS]);

        return Array.from(unique).slice(0, 8);
    }, [tasks]);

    useEffect(() => {
        if (task) {
            setEditedTask({ ...task });
        }
    }, [task]);

    if (!task) return null;

    const handleSave = () => {
        if (task.id) {
            onSave(task.id, editedTask);
            onClose();
        }
    };



    const onDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
        const currentMode = showDatePicker;
        if (Platform.OS === 'android') {
            setShowDatePicker(null);
        }

        if (selectedDate && currentMode) {
            if (currentMode === 'start') {
                setEditedTask(prev => ({ ...prev, startTime: selectedDate.toISOString() }));
            } else if (currentMode === 'due') {
                setEditedTask(prev => ({ ...prev, dueDate: selectedDate.toISOString() }));
            } else {
                setEditedTask(prev => ({ ...prev, reviewAt: selectedDate.toISOString() }));
            }
        }
    };

    const formatDate = (dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        return new Date(dateStr).toLocaleDateString();
    };

    const timeEstimateOptions: { value: TimeEstimate | ''; label: string }[] = [
        { value: '', label: t('common.none') },
        { value: '5min', label: '5m' },
        { value: '15min', label: '15m' },
        { value: '30min', label: '30m' },
        { value: '1hr', label: '1h' },
        { value: '2hr+', label: '2h+' },
    ];

    const recurrenceOptions: { value: RecurrenceRule | ''; label: string }[] = [
        { value: '', label: t('recurrence.none') },
        ...RECURRENCE_RULES.map((rule) => ({
            value: rule,
            label: t(`recurrence.${rule}`),
        })),
    ];

    const toggleContext = (tag: string) => {
        const current = editedTask.contexts || [];
        const exists = current.includes(tag);

        let newContexts;
        if (exists) {
            newContexts = current.filter(t => t !== tag);
        } else {
            newContexts = [...current, tag];
        }
        setEditedTask(prev => ({ ...prev, contexts: newContexts }));
    };

    const toggleBlocker = (blockerId: string) => {
        const current = editedTask.blockedByTaskIds || [];
        const exists = current.includes(blockerId);
        const next = exists ? current.filter(id => id !== blockerId) : [...current, blockerId];
        setEditedTask(prev => ({ ...prev, blockedByTaskIds: next }));
    };

    return (
        <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
            <SafeAreaView style={styles.container} edges={['top']}>
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => { if (focusMode) setFocusMode(false); else onClose(); }}>
                        <Text style={styles.headerBtn}>{focusMode ? t('common.back') : t('common.cancel')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>{focusMode ? editedTask.title || t('taskEdit.checklist') : t('taskEdit.editTask')}</Text>
                    <View style={styles.headerRight}>
                        {!focusMode && (editedTask.status === 'next' || editedTask.status === 'todo') && (
                            <TouchableOpacity
                                onPress={() => {
                                    onSave(task.id, { ...editedTask, status: 'in-progress' });
                                    onClose();
                                }}
                                style={styles.startBtn}
                            >
                                <Text style={styles.startBtnText}>▶ {t('taskEdit.start')}</Text>
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity onPress={handleSave}>
                            <Text style={[styles.headerBtn, styles.saveBtn]}>{t('common.save')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Focus Mode Banner - Conditional */}
                {!focusMode && editedTask.checklist && editedTask.checklist.length > 0 && (
                    <View style={{ padding: 16, backgroundColor: '#f0f9ff', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#e0f2fe' }}>
                        <Text style={{ fontSize: 14, color: '#0369a1' }}>{t('taskEdit.shoppingListPrompt')}</Text>
                        <TouchableOpacity
                            style={{ backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: '#0ea5e9' }}
                            onPress={() => setFocusMode(true)}
                        >
                            <Text style={{ fontSize: 13, fontWeight: '600', color: '#0284c7' }}>{t('taskEdit.openChecklistMode')}</Text>
                        </TouchableOpacity>
                    </View>
                )}

                {/* FOCUS MODE VIEW */}
                {focusMode ? (
                    <ScrollView style={styles.content}>
                        <View style={styles.checklistContainer}>
                            {editedTask.checklist?.map((item, index) => (
                                <View key={item.id || index} style={styles.checklistItem}>
                                    <TouchableOpacity
                                        onPress={() => {
                                            const newChecklist = (editedTask.checklist || []).map((item, i) =>
                                                i === index ? { ...item, isCompleted: !item.isCompleted } : item
                                            );
                                            setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                        }}
                                        style={styles.checkboxTouch}
                                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                        activeOpacity={0.6}
                                    >
                                        <View style={[styles.checkbox, item.isCompleted && styles.checkboxChecked]}>
                                            {item.isCompleted && <Text style={styles.checkmark}>✓</Text>}
                                        </View>
                                    </TouchableOpacity>
                                    <TextInput
                                        style={[styles.checklistInput, { fontSize: 18, paddingVertical: 8 }, item.isCompleted && styles.completedText]}
                                        value={item.title}
                                        onChangeText={(text) => {
                                            const newChecklist = (editedTask.checklist || []).map((item, i) =>
                                                i === index ? { ...item, title: text } : item
                                            );
                                            setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                        }}
                                        placeholder={t('taskEdit.itemNamePlaceholder')}
                                    />
                                    <TouchableOpacity
                                        onPress={() => {
                                            const newChecklist = (editedTask.checklist || []).filter((_, i) => i !== index);
                                            setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                        }}
                                        style={styles.deleteBtn}
                                    >
                                        <Text style={styles.deleteBtnText}>×</Text>
                                    </TouchableOpacity>
                                </View>
                            ))}
                            <TouchableOpacity
                                style={[styles.addChecklistBtn, { paddingVertical: 16 }]}
                                onPress={() => {
                                    const newItem = {
                                        id: generateUUID(),
                                        title: '',
                                        isCompleted: false
                                    };
                                    setEditedTask(prev => ({
                                        ...prev,
                                        checklist: [...(prev.checklist || []), newItem]
                                    }));
                                }}
                            >
                                <Text style={[styles.addChecklistText, { fontSize: 17 }]}>+ {t('taskEdit.addItem')}</Text>
                            </TouchableOpacity>
                        </View>
                    </ScrollView>
                ) : (

                    <KeyboardAvoidingView
                        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                        style={{ flex: 1 }}
                        keyboardVerticalOffset={Platform.OS === 'ios' ? 100 : 0}
                    >
                        <ScrollView style={styles.content}>
                            <View style={styles.formGroup}>
                                <Text style={styles.label}>{t('taskEdit.titleLabel')}</Text>
                                <TextInput
                                    style={styles.input}
                                    value={editedTask.title}
                                    onChangeText={(text) => setEditedTask(prev => ({ ...prev, title: text }))}
                                />
                            </View>

                            <View style={styles.formGroup}>
                                <Text style={styles.label}>{t('taskEdit.statusLabel')}</Text>
                                <View style={styles.statusContainer}>
                                    {STATUS_OPTIONS.map(status => (
                                        <TouchableOpacity
                                            key={status}
                                            style={[
                                                styles.statusChip,
                                                editedTask.status === status && styles.statusChipActive
                                            ]}
                                            onPress={() => setEditedTask(prev => ({ ...prev, status }))}
                                        >
                                            <Text style={[
                                                styles.statusText,
                                                editedTask.status === status && styles.statusTextActive
                                            ]}>
                                                {t(`status.${status}`)}
                                            </Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            </View>

                            <View style={styles.formGroup}>
                                <Text style={styles.label}>{t('taskEdit.contextsLabel')}</Text>
                                <TextInput
                                    style={styles.input}
                                    value={editedTask.contexts?.join(', ')}
                                    onChangeText={(text) => setEditedTask(prev => ({
                                        ...prev,
                                        contexts: text.split(',').map(t => t.trim()).filter(Boolean)
                                    }))}
                                    placeholder="@home, @work"
                                    autoCapitalize="none"
                                />
                                <View style={styles.suggestionsContainer}>
                                    <View style={styles.suggestionTags}>
                                        {suggestedTags.map(tag => {
                                            const isActive = editedTask.contexts?.includes(tag);
                                            return (
                                                <TouchableOpacity
                                                    key={tag}
                                                    style={[
                                                        styles.suggestionChip,
                                                        isActive && styles.suggestionChipActive
                                                    ]}
                                                    onPress={() => toggleContext(tag)}
                                                >
                                                    <Text style={[
                                                        styles.suggestionText,
                                                        isActive && styles.suggestionTextActive
                                                    ]}>{tag}</Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                </View>
                            </View>

                            <View style={styles.formGroup}>
                                <Text style={styles.label}>{t('taskEdit.tagsLabel')}</Text>
                                <TextInput
                                    style={styles.input}
                                    value={editedTask.tags?.join(', ')}
                                    onChangeText={(text) => setEditedTask(prev => ({
                                        ...prev,
                                        tags: text.split(',').map(t => t.trim()).filter(Boolean)
                                    }))}
                                    placeholder="#urgent, #idea"
                                    autoCapitalize="none"
                                />
                                <View style={styles.suggestionsContainer}>
                                    <View style={styles.suggestionTags}>
                                        {suggestedHashtags.map(tag => {
                                            const isActive = editedTask.tags?.includes(tag);
                                            return (
                                                <TouchableOpacity
                                                    key={tag}
                                                    style={[
                                                        styles.suggestionChip,
                                                        isActive && styles.suggestionChipActive
                                                    ]}
                                                    onPress={() => {
                                                        const current = editedTask.tags || [];
                                                        let newTags;
                                                        if (current.includes(tag)) {
                                                            newTags = current.filter(t => t !== tag);
                                                        } else {
                                                            newTags = [...current, tag];
                                                        }
                                                        setEditedTask(prev => ({ ...prev, tags: newTags }));
                                                    }}
                                                >
                                                    <Text style={[
                                                        styles.suggestionText,
                                                        isActive && styles.suggestionTextActive
                                                    ]}>{tag}</Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                </View>
                            </View>

                            <View style={styles.formGroup}>
                                <Text style={styles.label}>{t('taskEdit.blockedByLabel')}</Text>
                                <View style={styles.suggestionsContainer}>
                                    <View style={styles.suggestionTags}>
                                        {tasks
                                            .filter(otherTask =>
                                                otherTask.id !== task.id &&
                                                !otherTask.deletedAt &&
                                                otherTask.status !== 'done' &&
                                                otherTask.status !== 'archived'
                                            )
                                            .map(otherTask => {
                                                const isActive = editedTask.blockedByTaskIds?.includes(otherTask.id);
                                                return (
                                                    <TouchableOpacity
                                                        key={otherTask.id}
                                                        style={[
                                                            styles.suggestionChip,
                                                            isActive && styles.suggestionChipActive
                                                        ]}
                                                        onPress={() => toggleBlocker(otherTask.id)}
                                                    >
                                                        <Text
                                                            style={[
                                                                styles.suggestionText,
                                                                isActive && styles.suggestionTextActive
                                                            ]}
                                                            numberOfLines={1}
                                                        >
                                                            {otherTask.title}
                                                        </Text>
                                                    </TouchableOpacity>
                                                );
                                            })}
                                    </View>
                                </View>
                            </View>

		                            <View style={styles.formGroup}>
		                                <Text style={styles.label}>{t('taskEdit.timeEstimateLabel')}</Text>
		                                <View style={styles.statusContainer}>
	                                    {timeEstimateOptions.map(opt => (
	                                        <TouchableOpacity
	                                            key={opt.value || 'none'}
	                                            style={[
	                                                styles.statusChip,
	                                                editedTask.timeEstimate === opt.value && styles.statusChipActive,
	                                                !opt.value && !editedTask.timeEstimate && styles.statusChipActive
	                                            ]}
	                                            onPress={() => setEditedTask(prev => ({ ...prev, timeEstimate: opt.value || undefined }))}
	                                        >
	                                            <Text style={[
	                                                styles.statusText,
	                                                (editedTask.timeEstimate === opt.value || (!opt.value && !editedTask.timeEstimate)) && styles.statusTextActive
	                                            ]}>
	                                                {opt.label}
	                                            </Text>
	                                        </TouchableOpacity>
	                                    ))}
	                                </View>
	                            </View>

	                            <View style={styles.formGroup}>
	                                <Text style={styles.label}>{t('taskEdit.recurrenceLabel')}</Text>
	                                <View style={styles.statusContainer}>
	                                    {recurrenceOptions.map(opt => (
	                                        <TouchableOpacity
	                                            key={opt.value || 'none'}
	                                            style={[
	                                                styles.statusChip,
	                                                editedTask.recurrence === opt.value && styles.statusChipActive,
	                                                !opt.value && !editedTask.recurrence && styles.statusChipActive
	                                            ]}
	                                            onPress={() => setEditedTask(prev => ({ ...prev, recurrence: opt.value || undefined }))}
	                                        >
	                                            <Text style={[
	                                                styles.statusText,
	                                                (editedTask.recurrence === opt.value || (!opt.value && !editedTask.recurrence)) && styles.statusTextActive
	                                            ]}>
	                                                {opt.label}
	                                            </Text>
	                                        </TouchableOpacity>
	                                    ))}
	                                </View>
	                            </View>

	                            <View style={styles.formGroup}>
	                                <Text style={styles.label}>{t('taskEdit.descriptionLabel')}</Text>
	                                <TextInput
	                                    style={[styles.input, styles.textArea]}
                                    value={editedTask.description || ''}
                                    onChangeText={(text) => setEditedTask(prev => ({ ...prev, description: text }))}
                                    multiline
                                />
	                            </View>

                            <View style={styles.formGroup}>
                                <Text style={styles.label}>{t('taskEdit.checklist')}</Text>
                                <View style={styles.checklistContainer}>
                                    {editedTask.checklist?.map((item, index) => (
                                        <View key={item.id || index} style={styles.checklistItem}>
                                            <TouchableOpacity
                                                onPress={() => {
                                                    const newChecklist = (editedTask.checklist || []).map((item, i) =>
                                                        i === index ? { ...item, isCompleted: !item.isCompleted } : item
                                                    );
                                                    setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                                }}
                                                style={styles.checkboxTouch}
                                            >
                                                <View style={[styles.checkbox, item.isCompleted && styles.checkboxChecked]}>
                                                    {item.isCompleted && <Text style={styles.checkmark}>✓</Text>}
                                                </View>
                                            </TouchableOpacity>
                                            <TextInput
                                                style={[styles.checklistInput, item.isCompleted && styles.completedText]}
                                                value={item.title}
                                                onChangeText={(text) => {
                                                    const newChecklist = (editedTask.checklist || []).map((item, i) =>
                                                        i === index ? { ...item, title: text } : item
                                                    );
                                                    setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                                }}
                                                placeholder={t('taskEdit.itemNamePlaceholder')}
                                            />
                                            <TouchableOpacity
                                                onPress={() => {
                                                    const newChecklist = (editedTask.checklist || []).filter((_, i) => i !== index);
                                                    setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                                }}
                                                style={styles.deleteBtn}
                                            >
                                                <Text style={styles.deleteBtnText}>×</Text>
                                            </TouchableOpacity>
                                        </View>
                                    ))}
                                    <TouchableOpacity
                                        style={styles.addChecklistBtn}
                                        onPress={() => {
                                            const newItem = {
                                                id: Date.now().toString(),
                                                title: '',
                                                isCompleted: false
                                            };
                                            setEditedTask(prev => ({
                                                ...prev,
                                                checklist: [...(prev.checklist || []), newItem]
                                            }));
                                        }}
                                    >
                                        <Text style={styles.addChecklistText}>+ {t('taskEdit.addItem')}</Text>
                                    </TouchableOpacity>
                                </View>
                            </View>

	                            <View style={styles.row}>
	                                <View style={[styles.formGroup, styles.flex1]}>
	                                    <Text style={styles.label}>{t('taskEdit.startDateLabel')}</Text>
	                                    <View style={styles.dateRow}>
	                                        <TouchableOpacity style={[styles.dateBtn, styles.flex1]} onPress={() => setShowDatePicker('start')}>
	                                            <Text>{formatDate(editedTask.startTime)}</Text>
	                                        </TouchableOpacity>
	                                        {!!editedTask.startTime && (
	                                            <TouchableOpacity
	                                                style={styles.clearDateBtn}
	                                                onPress={() => setEditedTask(prev => ({ ...prev, startTime: undefined }))}
	                                            >
	                                                <Text style={styles.clearDateText}>{t('common.clear')}</Text>
	                                            </TouchableOpacity>
	                                        )}
	                                    </View>
	                                </View>
	                                <View style={[styles.formGroup, styles.flex1]}>
	                                    <Text style={styles.label}>{t('taskEdit.dueDateLabel')}</Text>
	                                    <View style={styles.dateRow}>
	                                        <TouchableOpacity style={[styles.dateBtn, styles.flex1]} onPress={() => setShowDatePicker('due')}>
	                                            <Text>{formatDate(editedTask.dueDate)}</Text>
	                                        </TouchableOpacity>
	                                        {!!editedTask.dueDate && (
	                                            <TouchableOpacity
	                                                style={styles.clearDateBtn}
	                                                onPress={() => setEditedTask(prev => ({ ...prev, dueDate: undefined }))}
	                                            >
	                                                <Text style={styles.clearDateText}>{t('common.clear')}</Text>
	                                            </TouchableOpacity>
	                                        )}
	                                    </View>
	                                </View>
	                            </View>

	                            <View style={styles.row}>
	                                <View style={[styles.formGroup, styles.flex1]}>
	                                    <Text style={styles.label}>{t('taskEdit.reviewDateLabel')}</Text>
	                                    <View style={styles.dateRow}>
	                                        <TouchableOpacity style={[styles.dateBtn, styles.flex1]} onPress={() => setShowDatePicker('review')}>
	                                            <Text>{formatDate(editedTask.reviewAt)}</Text>
	                                        </TouchableOpacity>
	                                        {!!editedTask.reviewAt && (
	                                            <TouchableOpacity
	                                                style={styles.clearDateBtn}
	                                                onPress={() => setEditedTask(prev => ({ ...prev, reviewAt: undefined }))}
	                                            >
	                                                <Text style={styles.clearDateText}>{t('common.clear')}</Text>
	                                            </TouchableOpacity>
	                                        )}
	                                    </View>
	                                </View>
	                            </View>

                            {/* Add extra padding at bottom for scrolling past keyboard */}
                            <View style={{ height: 100 }} />

	                            {showDatePicker && (
	                                <DateTimePicker
	                                    value={new Date(
	                                        (showDatePicker === 'start'
	                                            ? editedTask.startTime
	                                            : showDatePicker === 'due'
	                                                ? editedTask.dueDate
	                                                : editedTask.reviewAt) || Date.now()
	                                    )}
	                                    mode="date"
	                                    display="default"
	                                    onChange={onDateChange}
	                                />
	                            )}

	                        </ScrollView>
                    </KeyboardAvoidingView>
                )}
            </SafeAreaView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f2f2f7' },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        padding: 16,
        backgroundColor: '#fff',
        borderBottomWidth: 1,
        borderBottomColor: '#e5e5e5',
        alignItems: 'center',
    },
    headerBtn: { fontSize: 17, color: '#007AFF' },
    saveBtn: { fontWeight: '600' },
    headerTitle: { fontSize: 17, fontWeight: '600' },
    content: { padding: 20 },
    formGroup: { marginBottom: 20 },
    label: { fontSize: 14, color: '#666', marginBottom: 8, textTransform: 'uppercase' },
    input: {
        backgroundColor: '#fff',
        padding: 12,
        borderRadius: 10,
        fontSize: 16,
        borderWidth: 1,
        borderColor: '#e5e5e5',
    },
    textArea: { minHeight: 100, textAlignVertical: 'top' },
	    row: { flexDirection: 'row', gap: 12 },
	    flex1: { flex: 1 },
	    dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	    dateBtn: {
	        backgroundColor: '#fff',
	        padding: 12,
	        borderRadius: 10,
	        borderWidth: 1,
	        borderColor: '#e5e5e5',
	    },
	    clearDateBtn: {
	        paddingHorizontal: 10,
	        paddingVertical: 8,
	        borderRadius: 8,
	        backgroundColor: '#e5e5e5',
	    },
	    clearDateText: {
	        fontSize: 12,
	        color: '#333',
	        fontWeight: '600',
	    },
    statusContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    statusChip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: '#e5e5e5',
        borderRadius: 16,
    },
    statusChipActive: { backgroundColor: '#007AFF' },
    statusText: { fontSize: 14, color: '#333' },
    statusTextActive: { color: '#fff' },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    startBtn: { backgroundColor: '#34C759', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
    startBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    doneBtn: { backgroundColor: '#007AFF', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
    doneBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
    suggestionsContainer: { marginTop: 12 },
    suggestionLabel: { fontSize: 12, color: '#888', marginBottom: 8 },
    suggestionTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    suggestionChip: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: '#e1e1e6',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: '#d1d1d6',
    },
    suggestionChipActive: {
        backgroundColor: '#e8f2ff',
        borderColor: '#007AFF',
    },
    suggestionText: {
        fontSize: 13,
        color: '#555',
    },
    suggestionTextActive: {
        color: '#007AFF',
        fontWeight: '500',
    },
    checklistContainer: {
        backgroundColor: '#fff',
        borderRadius: 10,
        padding: 8,
        borderWidth: 1,
        borderColor: '#e5e5e5',
    },
    checklistItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#f0f0f0',
    },
    checkboxTouch: {
        padding: 4,
    },
    checkbox: {
        width: 28,
        height: 28,
        borderRadius: 6,
        borderWidth: 2,
        borderColor: '#007AFF',
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 10,
        backgroundColor: 'transparent',
    },
    checkboxChecked: {
        backgroundColor: '#007AFF',
    },
    checkmark: {
        color: '#fff',
        fontSize: 12,
        fontWeight: 'bold',
    },
    checklistInput: {
        flex: 1,
        fontSize: 16,
        padding: 0,
    },
    completedText: {
        textDecorationLine: 'line-through',
        color: '#999',
    },
    deleteBtn: {
        padding: 8,
    },
    deleteBtnText: {
        fontSize: 20,
        color: '#999',
        fontWeight: '300',
    },
    addChecklistBtn: {
        paddingVertical: 12,
        alignItems: 'center',
    },
    addChecklistText: {
        color: '#007AFF',
        fontSize: 15,
        fontWeight: '500',
    },
});
