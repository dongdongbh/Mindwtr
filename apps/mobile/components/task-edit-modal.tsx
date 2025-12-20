import React, { useMemo, useState, useEffect } from 'react';
import { View, Text, TextInput, Modal, StyleSheet, TouchableOpacity, ScrollView, Platform, KeyboardAvoidingView, Share, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Attachment, Task, TaskEditorFieldId, TaskStatus, TimeEstimate, useTaskStore, generateUUID, PRESET_TAGS, RecurrenceRule, RECURRENCE_RULES } from '@mindwtr/core';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { MarkdownText } from './markdown-text';

interface TaskEditModalProps {
    visible: boolean;
    task: Task | null;
    onClose: () => void;
    onSave: (taskId: string, updates: Partial<Task>) => void;
    onFocusMode?: (taskId: string) => void;
}

const STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done'];

const DEFAULT_TASK_EDITOR_ORDER: TaskEditorFieldId[] = [
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

const DEFAULT_TASK_EDITOR_HIDDEN = DEFAULT_TASK_EDITOR_ORDER.filter((id) => !['status', 'contexts', 'description'].includes(id));

export function TaskEditModal({ visible, task, onClose, onSave, onFocusMode }: TaskEditModalProps) {
    const { tasks, settings } = useTaskStore();
    const { t } = useLanguage();
    const tc = useThemeColors();
    const [editedTask, setEditedTask] = useState<Partial<Task>>({});
    const [showDatePicker, setShowDatePicker] = useState<'start' | 'start-time' | 'due' | 'due-time' | 'review' | null>(null);
    const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
    const [pendingDueDate, setPendingDueDate] = useState<Date | null>(null);
    const [focusMode, setFocusMode] = useState(false);
    const [showDescriptionPreview, setShowDescriptionPreview] = useState(false);
    const [showMoreOptions, setShowMoreOptions] = useState(false);
    const [linkModalVisible, setLinkModalVisible] = useState(false);
    const [linkInput, setLinkInput] = useState('');

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
            setShowMoreOptions(false);
            setShowDescriptionPreview(false);
        }
    }, [task]);

    const handleSave = () => {
        if (!task) return;
        onSave(task.id, editedTask);
        onClose();
    };

    const handleShare = async () => {
        if (!task) return;

        const title = String(editedTask.title ?? task.title ?? '').trim();
        const lines: string[] = [];

        if (title) lines.push(title);

        const status = (editedTask.status ?? task.status) as TaskStatus | undefined;
        if (status) lines.push(`${t('taskEdit.statusLabel')}: ${t(`status.${status}`)}`);

        if (editedTask.startTime) lines.push(`${t('taskEdit.startDateLabel')}: ${formatDate(editedTask.startTime)}`);
        if (editedTask.dueDate) lines.push(`${t('taskEdit.dueDateLabel')}: ${formatDueDate(editedTask.dueDate)}`);
        if (editedTask.reviewAt) lines.push(`${t('taskEdit.reviewDateLabel')}: ${formatDate(editedTask.reviewAt)}`);

        const estimate = editedTask.timeEstimate as TimeEstimate | undefined;
        if (estimate) lines.push(`${t('taskEdit.timeEstimateLabel')}: ${formatTimeEstimateLabel(estimate)}`);

        const contexts = (editedTask.contexts ?? []).filter(Boolean);
        if (contexts.length) lines.push(`${t('taskEdit.contextsLabel')}: ${contexts.join(', ')}`);

        const tags = (editedTask.tags ?? []).filter(Boolean);
        if (tags.length) lines.push(`${t('taskEdit.tagsLabel')}: ${tags.join(', ')}`);

        const description = String(editedTask.description ?? '').trim();
        if (description) {
            lines.push('');
            lines.push(`${t('taskEdit.descriptionLabel')}:`);
            lines.push(description);
        }

        const checklist = (editedTask.checklist ?? []).filter((item) => item && item.title);
        if (checklist.length) {
            lines.push('');
            lines.push(`${t('taskEdit.checklist')}:`);
            checklist.forEach((item) => {
                lines.push(`${item.isCompleted ? '[x]' : '[ ]'} ${item.title}`);
            });
        }

        const message = lines.join('\n').trim();
        if (!message) return;

        try {
            await Share.share({
                title: title || undefined,
                message,
            });
        } catch (error) {
            console.error('Share failed:', error);
        }
    };

    const attachments = (editedTask.attachments || []) as Attachment[];
    const visibleAttachments = attachments.filter((a) => !a.deletedAt);

    const addFileAttachment = async () => {
        const result = await DocumentPicker.getDocumentAsync({
            copyToCacheDirectory: false,
            multiple: false,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        const now = new Date().toISOString();
        const attachment: Attachment = {
            id: generateUUID(),
            kind: 'file',
            title: asset.name || 'file',
            uri: asset.uri,
            mimeType: asset.mimeType,
            size: asset.size,
            createdAt: now,
            updatedAt: now,
        };
        setEditedTask((prev) => ({ ...prev, attachments: [...(prev.attachments || []), attachment] }));
    };

    const addImageAttachment = async () => {
        let imagePicker: typeof import('expo-image-picker') | null = null;
        try {
            imagePicker = await import('expo-image-picker');
        } catch (error) {
            console.warn('Image picker unavailable', error);
            Alert.alert(t('attachments.photoUnavailableTitle'), t('attachments.photoUnavailableBody'));
            return;
        }

        const permission = await imagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) return;
        const result = await imagePicker.launchImageLibraryAsync({
            mediaTypes: imagePicker.MediaTypeOptions.Images,
            quality: 0.9,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        const now = new Date().toISOString();
        const attachment: Attachment = {
            id: generateUUID(),
            kind: 'file',
            title: asset.fileName || asset.uri.split('/').pop() || 'image',
            uri: asset.uri,
            mimeType: asset.mimeType,
            size: (asset as { fileSize?: number }).fileSize,
            createdAt: now,
            updatedAt: now,
        };
        setEditedTask((prev) => ({ ...prev, attachments: [...(prev.attachments || []), attachment] }));
    };

    const confirmAddLink = () => {
        const url = linkInput.trim();
        if (!url) return;
        const now = new Date().toISOString();
        const attachment: Attachment = {
            id: generateUUID(),
            kind: 'link',
            title: url,
            uri: url,
            createdAt: now,
            updatedAt: now,
        };
        setEditedTask((prev) => ({ ...prev, attachments: [...(prev.attachments || []), attachment] }));
        setLinkInput('');
        setLinkModalVisible(false);
    };

    const openAttachment = async (attachment: Attachment) => {
        if (attachment.kind === 'link') {
            Linking.openURL(attachment.uri).catch(console.error);
            return;
        }
        const available = await Sharing.isAvailableAsync().catch(() => false);
        if (available) {
            Sharing.shareAsync(attachment.uri).catch(console.error);
        } else {
            Linking.openURL(attachment.uri).catch(console.error);
        }
    };

    const removeAttachment = (id: string) => {
        const now = new Date().toISOString();
        const next = attachments.map((a) => (a.id === id ? { ...a, deletedAt: now, updatedAt: now } : a));
        setEditedTask((prev) => ({ ...prev, attachments: next }));
    };



    const onDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
        const currentMode = showDatePicker;
        if (!currentMode) return;

        if (Platform.OS === 'android') {
            // Android fires dismiss events; handle explicitly.
            if (event.type === 'dismissed') {
                if (currentMode === 'start-time') setPendingStartDate(null);
                if (currentMode === 'due-time') setPendingDueDate(null);
                setShowDatePicker(null);
                return;
            }
        }

        if (!selectedDate) return;

        if (currentMode === 'start') {
            if (Platform.OS !== 'android') {
                setEditedTask(prev => ({ ...prev, startTime: selectedDate.toISOString() }));
                return;
            }

            const existing = editedTask.startTime ? new Date(editedTask.startTime) : null;
            const preserveTime = existing && !Number.isNaN(existing.getTime());
            const next = new Date(selectedDate);
            if (preserveTime) {
                next.setHours(existing!.getHours(), existing!.getMinutes(), 0, 0);
            } else {
                next.setHours(9, 0, 0, 0);
            }

            setPendingStartDate(next);
            setEditedTask(prev => ({ ...prev, startTime: next.toISOString() }));
            setShowDatePicker('start-time');
            return;
        }

        if (currentMode === 'start-time') {
            const base = pendingStartDate ?? (editedTask.startTime ? new Date(editedTask.startTime) : new Date());
            const combined = new Date(base);
            combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
            setEditedTask(prev => ({ ...prev, startTime: combined.toISOString() }));
            setPendingStartDate(null);
            if (Platform.OS === 'android') setShowDatePicker(null);
            return;
        }

        if (currentMode === 'review') {
            setEditedTask(prev => ({ ...prev, reviewAt: selectedDate.toISOString() }));
            if (Platform.OS === 'android') setShowDatePicker(null);
            return;
        }

        if (currentMode === 'due') {
            // iOS supports `datetime`; Android does not.
            if (Platform.OS !== 'android') {
                setEditedTask(prev => ({ ...prev, dueDate: selectedDate.toISOString() }));
                return;
            }

            const existing = editedTask.dueDate ? new Date(editedTask.dueDate) : null;
            const preserveTime = existing && !Number.isNaN(existing.getTime()) && (existing.getHours() !== 0 || existing.getMinutes() !== 0);
            const next = new Date(selectedDate);
            if (preserveTime) {
                next.setHours(existing!.getHours(), existing!.getMinutes(), 0, 0);
            } else {
                next.setHours(0, 0, 0, 0);
            }

            setPendingDueDate(next);
            // Set date immediately (time is optional); then allow user to adjust time.
            setEditedTask(prev => ({ ...prev, dueDate: next.toISOString() }));
            setShowDatePicker('due-time');
            return;
        }

        // due-time (Android) - combine pending date with chosen time.
        const base = pendingDueDate ?? (editedTask.dueDate ? new Date(editedTask.dueDate) : new Date());
        const combined = new Date(base);
        combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
        setEditedTask(prev => ({ ...prev, dueDate: combined.toISOString() }));
        setPendingDueDate(null);
        if (Platform.OS === 'android') setShowDatePicker(null);
    };

    const formatDate = (dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = new Date(dateStr);
        if (Number.isNaN(parsed.getTime())) return t('common.notSet');
        return parsed.toLocaleDateString();
    };

    const formatStartDateTime = (dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = new Date(dateStr);
        if (Number.isNaN(parsed.getTime())) return t('common.notSet');
        const hasTime = parsed.getHours() !== 0 || parsed.getMinutes() !== 0;
        if (!hasTime) return parsed.toLocaleDateString();
        return parsed.toLocaleString(undefined, {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    const formatDueDate = (dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = new Date(dateStr);
        if (Number.isNaN(parsed.getTime())) return t('common.notSet');
        const hasTime = parsed.getHours() !== 0 || parsed.getMinutes() !== 0;
        if (!hasTime) return parsed.toLocaleDateString();
        return parsed.toLocaleString(undefined, {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    const getSafePickerDateValue = (dateStr?: string) => {
        if (!dateStr) return new Date();
        const parsed = new Date(dateStr);
        if (Number.isNaN(parsed.getTime())) return new Date();
        return parsed;
    };

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

    const defaultTimeEstimatePresets: TimeEstimate[] = ['10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const allTimeEstimates: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const savedPresets = settings.gtd?.timeEstimatePresets;
    const basePresets = savedPresets?.length ? savedPresets : defaultTimeEstimatePresets;
    const normalizedPresets = allTimeEstimates.filter((value) => basePresets.includes(value));
    const currentEstimate = editedTask.timeEstimate as TimeEstimate | undefined;
    const effectivePresets = currentEstimate && !normalizedPresets.includes(currentEstimate)
        ? [...normalizedPresets, currentEstimate]
        : normalizedPresets;

    const timeEstimateOptions: { value: TimeEstimate | ''; label: string }[] = [
        { value: '', label: t('common.none') },
        ...effectivePresets.map((value) => ({ value, label: formatTimeEstimateLabel(value) })),
    ];

    const savedOrder = settings.gtd?.taskEditor?.order ?? [];
    const savedHidden = settings.gtd?.taskEditor?.hidden ?? DEFAULT_TASK_EDITOR_HIDDEN;

    const taskEditorOrder = useMemo(() => {
        const known = new Set(DEFAULT_TASK_EDITOR_ORDER);
        const normalized = savedOrder.filter((id) => known.has(id));
        const missing = DEFAULT_TASK_EDITOR_ORDER.filter((id) => !normalized.includes(id));
        return [...normalized, ...missing];
    }, [savedOrder]);

    const hiddenSet = useMemo(() => {
        const known = new Set(taskEditorOrder);
        return new Set(savedHidden.filter((id) => known.has(id)));
    }, [savedHidden, taskEditorOrder]);

    useEffect(() => {
        setShowMoreOptions(false);
    }, [savedOrder, savedHidden]);

    const compactFieldIds = useMemo(() => {
        return taskEditorOrder.filter((fieldId) => !hiddenSet.has(fieldId));
    }, [taskEditorOrder, hiddenSet]);

    const fieldIdsToRender = showMoreOptions ? taskEditorOrder : compactFieldIds;
    const hasHiddenFields = hiddenSet.size > 0;

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

    const handleDone = () => {
        if (focusMode) {
            setFocusMode(false);
            return;
        }
        handleSave();
    };

    const renderField = (fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return (
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
                );
            case 'contexts':
                return (
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
                );
            case 'tags':
                return (
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
                                                const newTags = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag];
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
                );
            case 'blockedBy':
                return (
                    <View style={styles.formGroup}>
                        <Text style={styles.label}>{t('taskEdit.blockedByLabel')}</Text>
                        <View style={styles.suggestionsContainer}>
                            <View style={styles.suggestionTags}>
	                                {tasks
	                                    .filter(otherTask =>
	                                        otherTask.id !== task?.id &&
	                                        !otherTask.deletedAt &&
	                                        otherTask.status !== 'done'
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
                );
            case 'timeEstimate':
                return (
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
                );
            case 'recurrence':
                return (
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
                );
            case 'startTime':
                return (
                    <View style={styles.formGroup}>
                        <Text style={styles.label}>{t('taskEdit.startDateLabel')}</Text>
                        <View style={styles.dateRow}>
                            <TouchableOpacity style={[styles.dateBtn, styles.flex1]} onPress={() => setShowDatePicker('start')}>
                                <Text>{formatStartDateTime(editedTask.startTime)}</Text>
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
                );
            case 'dueDate':
                return (
                    <View style={styles.formGroup}>
                        <Text style={styles.label}>{t('taskEdit.dueDateLabel')}</Text>
                        <View style={styles.dateRow}>
                            <TouchableOpacity style={[styles.dateBtn, styles.flex1]} onPress={() => setShowDatePicker('due')}>
                                <Text>{formatDueDate(editedTask.dueDate)}</Text>
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
                );
            case 'reviewAt':
                return (
                    <View style={styles.formGroup}>
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
                );
            case 'description':
                return (
                    <View style={styles.formGroup}>
                        <View style={styles.inlineHeader}>
                            <Text style={styles.label}>{t('taskEdit.descriptionLabel')}</Text>
                            <TouchableOpacity onPress={() => setShowDescriptionPreview((v) => !v)}>
                                <Text style={[styles.inlineAction, { color: tc.tint }]}>
                                    {showDescriptionPreview ? t('markdown.edit') : t('markdown.preview')}
                                </Text>
                            </TouchableOpacity>
                        </View>
                        {showDescriptionPreview ? (
                            <View style={[styles.markdownPreview, { backgroundColor: tc.filterBg, borderColor: tc.border }]}>
                                <MarkdownText markdown={editedTask.description || ''} tc={tc} />
                            </View>
                        ) : (
                            <TextInput
                                style={[styles.input, styles.textArea]}
                                value={editedTask.description || ''}
                                onChangeText={(text) => setEditedTask(prev => ({ ...prev, description: text }))}
                                placeholder={t('taskEdit.descriptionPlaceholder')}
                                multiline
                            />
                        )}
                    </View>
                );
            case 'attachments':
                return (
                    <View style={styles.formGroup}>
                        <View style={styles.inlineHeader}>
                            <Text style={styles.label}>{t('attachments.title')}</Text>
                            <View style={styles.inlineActions}>
                                <TouchableOpacity
                                    onPress={addFileAttachment}
                                    style={[styles.smallButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                >
                                    <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addFile')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={addImageAttachment}
                                    style={[styles.smallButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                >
                                    <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addPhoto')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={() => setLinkModalVisible(true)}
                                    style={[styles.smallButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                >
                                    <Text style={[styles.smallButtonText, { color: tc.tint }]}>{t('attachments.addLink')}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                        {visibleAttachments.length === 0 ? (
                            <Text style={[styles.helperText, { color: tc.secondaryText }]}>{t('common.none')}</Text>
                        ) : (
                            <View style={[styles.attachmentsList, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                                {visibleAttachments.map((attachment) => (
                                    <View key={attachment.id} style={[styles.attachmentRow, { borderBottomColor: tc.border }]}>
                                        <TouchableOpacity
                                            style={styles.attachmentTitleWrap}
                                            onPress={() => openAttachment(attachment)}
                                        >
                                            <Text style={[styles.attachmentTitle, { color: tc.tint }]} numberOfLines={1}>
                                                {attachment.title}
                                            </Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity onPress={() => removeAttachment(attachment.id)}>
                                            <Text style={[styles.attachmentRemove, { color: tc.secondaryText }]}>
                                                {t('attachments.remove')}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                ))}
                            </View>
                        )}
                    </View>
                );
            case 'checklist':
                return (
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
                                <Text style={styles.addChecklistText}>+ {t('taskEdit.addItem')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                );
            default:
                return null;
        }
    };

    if (!task) return null;

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="pageSheet"
            onRequestClose={handleDone}
        >
            <SafeAreaView style={styles.container} edges={['top']}>
                <View style={styles.header}>
                    <TouchableOpacity onPress={handleDone}>
                        <Text style={styles.headerBtn}>{focusMode ? t('common.back') : t('common.done')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>{focusMode ? editedTask.title || t('taskEdit.checklist') : t('taskEdit.editTask')}</Text>
                    <View style={styles.headerRight}>
                        <TouchableOpacity onPress={handleShare}>
                            <Text style={styles.headerBtn}>{t('common.share')}</Text>
                        </TouchableOpacity>
                        {!focusMode && (
                            <TouchableOpacity onPress={onClose}>
                                <Text style={[styles.headerBtn, styles.saveBtn]}>{t('common.cancel')}</Text>
                            </TouchableOpacity>
                        )}
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

                            {fieldIdsToRender.map((fieldId) => (
                                <React.Fragment key={fieldId}>
                                    {renderField(fieldId)}
                                </React.Fragment>
                            ))}

                            {hasHiddenFields && (
                                <TouchableOpacity
                                    style={[styles.moreOptionsButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                    onPress={() => setShowMoreOptions((v) => !v)}
                                >
                                    <Text style={[styles.moreOptionsText, { color: tc.tint }]}>
                                        {showMoreOptions ? t('common.less') : t('common.more')}
                                    </Text>
                                </TouchableOpacity>
                            )}

                            {/* Add extra padding at bottom for scrolling past keyboard */}
                            <View style={{ height: 100 }} />

                            {showDatePicker && (
                                <DateTimePicker
                                    value={(() => {
                                        if (showDatePicker === 'start') return getSafePickerDateValue(editedTask.startTime);
                                        if (showDatePicker === 'start-time') return pendingStartDate ?? getSafePickerDateValue(editedTask.startTime);
                                        if (showDatePicker === 'review') return getSafePickerDateValue(editedTask.reviewAt);
                                        if (showDatePicker === 'due-time') return pendingDueDate ?? getSafePickerDateValue(editedTask.dueDate);
                                        return getSafePickerDateValue(editedTask.dueDate);
                                    })()}
                                    mode={
                                        showDatePicker === 'start-time' || showDatePicker === 'due-time'
                                            ? 'time'
                                            : (showDatePicker === 'start' || showDatePicker === 'due') && Platform.OS !== 'android'
                                                ? 'datetime'
                                                : 'date'
                                    }
                                    display="default"
                                    onChange={onDateChange}
                                />
                            )}

                        </ScrollView>
                    </KeyboardAvoidingView>
                )}

                <Modal
                    visible={linkModalVisible}
                    transparent
                    animationType="fade"
                    onRequestClose={() => setLinkModalVisible(false)}
                >
                    <View style={styles.overlay}>
                        <View style={[styles.modalCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.modalTitle, { color: tc.text }]}>{t('attachments.addLink')}</Text>
                            <TextInput
                                value={linkInput}
                                onChangeText={setLinkInput}
                                placeholder={t('attachments.linkPlaceholder')}
                                placeholderTextColor={tc.secondaryText}
                                style={[styles.modalInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                            <View style={styles.modalButtons}>
                                <TouchableOpacity
                                    onPress={() => {
                                        setLinkModalVisible(false);
                                        setLinkInput('');
                                    }}
                                    style={styles.modalButton}
                                >
                                    <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    onPress={confirmAddLink}
                                    disabled={!linkInput.trim()}
                                    style={[styles.modalButton, !linkInput.trim() && styles.modalButtonDisabled]}
                                >
                                    <Text style={[styles.modalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </Modal>
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
    inlineHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    inlineAction: {
        fontSize: 12,
        fontWeight: '700',
    },
    inlineActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    smallButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: '#fff',
        borderWidth: 1,
        borderColor: '#e5e5e5',
    },
    smallButtonText: {
        fontSize: 12,
        fontWeight: '600',
    },
    markdownPreview: {
        marginTop: 8,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
    },
    moreOptionsButton: {
        borderWidth: 1,
        borderRadius: 12,
        paddingVertical: 12,
        alignItems: 'center',
        marginTop: 4,
    },
    moreOptionsText: {
        fontSize: 14,
        fontWeight: '700',
    },
    helperText: {
        fontSize: 13,
        marginTop: 6,
    },
    attachmentsList: {
        marginTop: 8,
        borderWidth: 1,
        borderColor: '#e5e5e5',
        borderRadius: 10,
        overflow: 'hidden',
        backgroundColor: '#fff',
    },
    attachmentRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderBottomWidth: 1,
    },
    attachmentTitleWrap: {
        flex: 1,
        paddingRight: 10,
    },
    attachmentTitle: {
        fontSize: 13,
        fontWeight: '600',
    },
    attachmentRemove: {
        fontSize: 12,
        fontWeight: '600',
    },
    overlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    modalCard: {
        width: '100%',
        maxWidth: 420,
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
    },
    modalTitle: {
        fontSize: 16,
        fontWeight: '700',
        marginBottom: 12,
    },
    modalInput: {
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 16,
    },
    modalButtons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 12,
        marginTop: 14,
    },
    modalButton: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 10,
    },
    modalButtonText: {
        fontSize: 14,
        fontWeight: '700',
    },
    modalButtonDisabled: {
        opacity: 0.5,
    },
});
