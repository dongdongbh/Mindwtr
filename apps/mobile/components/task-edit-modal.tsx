import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TextInput, Modal, StyleSheet, TouchableOpacity, ScrollView, Platform, KeyboardAvoidingView, Share, Alert, Image, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
    Attachment,
    Task,
    TaskEditorFieldId,
    TaskStatus,
    TaskPriority,
    TimeEstimate,
    useTaskStore,
    createAIProvider,
    generateUUID,
    PRESET_CONTEXTS,
    PRESET_TAGS,
    RecurrenceRule,
    type RecurrenceStrategy,
    RECURRENCE_RULES,
} from '@mindwtr/core';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { MarkdownText } from './markdown-text';
import { buildAIConfig, buildCopilotConfig, loadAIKey } from '../lib/ai-config';
import { AIResponseModal, type AIResponseAction } from './ai-response-modal';

interface TaskEditModalProps {
    visible: boolean;
    task: Task | null;
    onClose: () => void;
    onSave: (taskId: string, updates: Partial<Task>) => void;
    onFocusMode?: (taskId: string) => void;
    defaultTab?: 'task' | 'view';
}

const STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done'];

const DEFAULT_TASK_EDITOR_ORDER: TaskEditorFieldId[] = [
    'status',
    'priority',
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



type TaskEditTab = 'task' | 'view';

const getRecurrenceRuleValue = (recurrence: Task['recurrence']): RecurrenceRule | '' => {
    if (!recurrence) return '';
    if (typeof recurrence === 'string') return recurrence as RecurrenceRule;
    return recurrence.rule;
};

const getRecurrenceStrategyValue = (recurrence: Task['recurrence']): RecurrenceStrategy => {
    if (recurrence && typeof recurrence === 'object' && recurrence.strategy === 'fluid') {
        return 'fluid';
    }
    return 'strict';
};

const buildRecurrenceValue = (rule: RecurrenceRule | '', strategy: RecurrenceStrategy): Task['recurrence'] | undefined => {
    if (!rule) return undefined;
    return { rule, strategy };
};


export function TaskEditModal({ visible, task, onClose, onSave, onFocusMode, defaultTab }: TaskEditModalProps) {
    const { tasks, projects, settings, duplicateTask, resetTaskChecklist } = useTaskStore();
    const { t } = useLanguage();
    const tc = useThemeColors();
    const [editedTask, setEditedTask] = useState<Partial<Task>>({});
    const [showDatePicker, setShowDatePicker] = useState<'start' | 'start-time' | 'due' | 'due-time' | 'review' | null>(null);
    const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
    const [pendingDueDate, setPendingDueDate] = useState<Date | null>(null);
    const [editTab, setEditTab] = useState<TaskEditTab>('task');
    const [showDescriptionPreview, setShowDescriptionPreview] = useState(false);
    const [showMoreOptions, setShowMoreOptions] = useState(false);
    const [linkModalVisible, setLinkModalVisible] = useState(false);
    const [linkInput, setLinkInput] = useState('');
    const [isAIWorking, setIsAIWorking] = useState(false);
    const [aiModal, setAiModal] = useState<{ title: string; message?: string; actions: AIResponseAction[] } | null>(null);
    const aiEnabled = settings.ai?.enabled === true;
    const aiProvider = (settings.ai?.provider ?? 'openai') as 'openai' | 'gemini';
    const [aiKey, setAiKey] = useState('');
    const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: TimeEstimate; tags?: string[] } | null>(null);
    const [copilotApplied, setCopilotApplied] = useState(false);
    const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
    const [copilotEstimate, setCopilotEstimate] = useState<TimeEstimate | undefined>(undefined);
    const [copilotTags, setCopilotTags] = useState<string[]>([]);

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

    const contextOptions = React.useMemo(() => {
        const taskContexts = tasks.flatMap((item) => item.contexts || []);
        return Array.from(new Set([...PRESET_CONTEXTS, ...taskContexts])).filter(Boolean);
    }, [tasks]);
    const tagOptions = React.useMemo(() => {
        const taskTags = tasks.flatMap((item) => item.tags || []);
        return Array.from(new Set([...PRESET_TAGS, ...taskTags])).filter(Boolean);
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

    const resolveInitialTab = (target?: TaskEditTab, currentTask?: Task | null): TaskEditTab => {
        if (target) return target;
        if (currentTask?.taskMode === 'list') return 'view';
        return 'view';
    };

    useEffect(() => {
        if (task) {
            const recurrenceRule = getRecurrenceRuleValue(task.recurrence);
            const recurrenceStrategy = getRecurrenceStrategyValue(task.recurrence);
            setEditedTask({ ...task, recurrence: buildRecurrenceValue(recurrenceRule, recurrenceStrategy) });
            setShowMoreOptions(false);
            setShowDescriptionPreview(false);
            setEditTab(resolveInitialTab(defaultTab, task));
            setCopilotSuggestion(null);
            setCopilotApplied(false);
            setCopilotContext(undefined);
            setCopilotEstimate(undefined);
            setCopilotTags([]);
        } else if (visible) {
            setEditedTask({});
            setShowMoreOptions(false);
            setShowDescriptionPreview(false);
            setEditTab(resolveInitialTab(defaultTab, null));
        }
    }, [task, defaultTab, visible]);

    useEffect(() => {
        loadAIKey(aiProvider).then(setAiKey).catch(console.error);
    }, [aiProvider]);

    useEffect(() => {
        if (!aiEnabled || !aiKey) {
            setCopilotSuggestion(null);
            return;
        }
        const title = String(editedTask.title ?? '').trim();
        const description = String(editedTask.description ?? '').trim();
        const input = [title, description].filter(Boolean).join('\n');
        if (input.length < 4) {
            setCopilotSuggestion(null);
            return;
        }
        let cancelled = false;
        const handle = setTimeout(async () => {
            try {
                const provider = createAIProvider(buildCopilotConfig(settings, aiKey));
                const suggestion = await provider.predictMetadata({ title: input, contexts: contextOptions, tags: tagOptions });
                if (cancelled) return;
                if (!suggestion.context && !suggestion.timeEstimate && !suggestion.tags?.length) {
                    setCopilotSuggestion(null);
                } else {
                    setCopilotSuggestion(suggestion);
                }
            } catch {
                if (!cancelled) setCopilotSuggestion(null);
            }
        }, 800);
        return () => {
            cancelled = true;
            clearTimeout(handle);
        };
    }, [aiEnabled, aiKey, editedTask.title, editedTask.description, contextOptions, tagOptions, settings]);

    useEffect(() => {
        if (!visible) {
            setAiModal(null);
        }
    }, [visible]);

    const closeAIModal = () => setAiModal(null);
    const resetCopilotDraft = () => {
        setCopilotApplied(false);
        setCopilotContext(undefined);
        setCopilotEstimate(undefined);
        setCopilotTags([]);
    };

    const applyCopilotSuggestion = () => {
        if (!copilotSuggestion) return;
        if (copilotSuggestion.context) {
            const current = editedTask.contexts ?? [];
            const next = Array.from(new Set([...current, copilotSuggestion.context]));
            setEditedTask(prev => ({ ...prev, contexts: next }));
            setCopilotContext(copilotSuggestion.context);
        }
        if (copilotSuggestion.tags?.length) {
            const currentTags = editedTask.tags ?? [];
            const nextTags = Array.from(new Set([...currentTags, ...copilotSuggestion.tags]));
            setEditedTask(prev => ({ ...prev, tags: nextTags }));
            setCopilotTags(copilotSuggestion.tags);
        }
        if (copilotSuggestion.timeEstimate) {
            setEditedTask(prev => ({ ...prev, timeEstimate: copilotSuggestion.timeEstimate }));
            setCopilotEstimate(copilotSuggestion.timeEstimate);
        }
        setCopilotApplied(true);
    };

    const projectContext = useMemo(() => {
        const projectId = (editedTask.projectId as string | undefined) ?? task?.projectId;
        if (!projectId) return null;
        const project = projects.find((p) => p.id === projectId);
        const projectTasks = tasks
            .filter((t) => t.projectId === projectId && t.id !== task?.id && !t.deletedAt)
            .map((t) => `${t.title}${t.status ? ` (${t.status})` : ''}`)
            .filter(Boolean)
            .slice(0, 20);
        return {
            projectTitle: project?.title || '',
            projectTasks,
        };
    }, [editedTask.projectId, projects, task?.id, task?.projectId, tasks]);

    const handleSave = () => {
        if (!task) return;
        const updates: Partial<Task> = { ...editedTask };
        const recurrenceRule = getRecurrenceRuleValue(editedTask.recurrence);
        const recurrenceStrategy = getRecurrenceStrategyValue(editedTask.recurrence);
        updates.recurrence = buildRecurrenceValue(recurrenceRule, recurrenceStrategy);
        if (editedTask.blockedByTaskIds) {
            const filtered = editedTask.blockedByTaskIds.filter((id) => availableBlockerIds.has(id));
            updates.blockedByTaskIds = filtered.length > 0 ? filtered : undefined;
        }
        onSave(task.id, updates);
        onClose();
    };

    const handleShare = async () => {
        if (!task) return;

        const title = String(editedTask.title ?? task.title ?? '').trim();
        const lines: string[] = [];

        if (title) lines.push(title);

        const status = (editedTask.status ?? task.status) as TaskStatus | undefined;
        if (status) lines.push(`${t('taskEdit.statusLabel')}: ${t(`status.${status}`)}`);
        const priority = editedTask.priority ?? task.priority;
        if (priority) lines.push(`${t('taskEdit.priorityLabel')}: ${t(`priority.${priority}`)}`);

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

        const permission = await imagePicker.getMediaLibraryPermissionsAsync();
        if (!permission.granted) {
            const requested = await imagePicker.requestMediaLibraryPermissionsAsync();
            if (!requested.granted) return;
        }
        const result = await imagePicker.launchImageLibraryAsync({
            mediaTypes: imagePicker.MediaTypeOptions.Images,
            quality: 0.9,
            allowsMultipleSelection: false,
        });
        if (result.canceled || !result.assets?.length) return;
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
        const available = await Sharing.isAvailableAsync().catch((error) => {
            console.warn('[Sharing] availability check failed', error);
            return false;
        });
        if (available) {
            Sharing.shareAsync(attachment.uri).catch(console.error);
        } else {
            Linking.openURL(attachment.uri).catch(console.error);
        }
    };

    const isImageAttachment = (attachment: Attachment) => {
        const mime = attachment.mimeType?.toLowerCase();
        if (mime?.startsWith('image/')) return true;
        return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
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
    const priorityOptions: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];

    const savedOrder = settings.gtd?.taskEditor?.order ?? [];

    const taskEditorOrder = useMemo(() => {
        const known = new Set(DEFAULT_TASK_EDITOR_ORDER);
        const normalized = savedOrder.filter((id) => known.has(id));
        const missing = DEFAULT_TASK_EDITOR_ORDER.filter((id) => !normalized.includes(id));
        return [...normalized, ...missing];
    }, [savedOrder]);

    const primaryFieldIds = useMemo(() => new Set<TaskEditorFieldId>(['dueDate']), []);

    useEffect(() => {
        if (!visible) return;
        setShowMoreOptions(false);
    }, [visible, task]);

    const mergedTask = useMemo(() => ({
        ...(task ?? {}),
        ...editedTask,
    }), [task, editedTask]);
    const availableBlockerTasks = useMemo(() => {
        const projectId = mergedTask.projectId;
        return tasks.filter((otherTask) =>
            otherTask.id !== task?.id &&
            !otherTask.deletedAt &&
            (otherTask.projectId ?? null) === (projectId ?? null) &&
            otherTask.status !== 'done'
        );
    }, [mergedTask.projectId, task?.id, tasks]);
    const availableBlockerIds = useMemo(
        () => new Set(availableBlockerTasks.map((blocker) => blocker.id)),
        [availableBlockerTasks]
    );

    const hasFieldValue = (fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return Boolean(mergedTask.status);
            case 'priority':
                return Boolean(mergedTask.priority);
            case 'contexts':
                return (mergedTask.contexts || []).length > 0;
            case 'description':
                return Boolean(mergedTask.description && String(mergedTask.description).trim());
            case 'tags':
                return (mergedTask.tags || []).length > 0;
            case 'timeEstimate':
                return Boolean(mergedTask.timeEstimate);
            case 'recurrence':
                return Boolean(mergedTask.recurrence);
            case 'startTime':
                return Boolean(mergedTask.startTime);
            case 'dueDate':
                return Boolean(mergedTask.dueDate);
            case 'reviewAt':
                return Boolean(mergedTask.reviewAt);
            case 'blockedBy':
                return (mergedTask.blockedByTaskIds || []).length > 0;
            case 'attachments':
                return (mergedTask.attachments || []).some((attachment) => !attachment.deletedAt);
            case 'checklist':
                return (mergedTask.checklist || []).length > 0;
            default:
                return false;
        }
    };

    const compactFieldIds = useMemo(() => {
        return taskEditorOrder.filter((fieldId) => primaryFieldIds.has(fieldId) || hasFieldValue(fieldId));
    }, [taskEditorOrder, primaryFieldIds, mergedTask]);

    const fieldIdsToRender = showMoreOptions ? taskEditorOrder : compactFieldIds;
    const hasHiddenFields = taskEditorOrder.some((fieldId) => !primaryFieldIds.has(fieldId) && !hasFieldValue(fieldId));

    const recurrenceOptions: { value: RecurrenceRule | ''; label: string }[] = [
        { value: '', label: t('recurrence.none') },
        ...RECURRENCE_RULES.map((rule) => ({
            value: rule,
            label: t(`recurrence.${rule}`),
        })),
    ];
    const recurrenceRuleValue = getRecurrenceRuleValue(editedTask.recurrence);
    const recurrenceStrategyValue = getRecurrenceStrategyValue(editedTask.recurrence);

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
        handleSave();
    };

    const setModeTab = useCallback((mode: TaskEditTab) => {
        setEditTab(mode);
    }, []);

    const [containerWidth, setContainerWidth] = useState(0);
    const scrollX = useRef(new Animated.Value(0)).current;
    const scrollRef = useRef<ScrollView | null>(null);
    const isUserSwipe = useRef(false);

    const scrollToTab = useCallback((mode: TaskEditTab, animated = true) => {
        if (!containerWidth) return;
        const x = mode === 'task' ? 0 : containerWidth;
        const node = scrollRef.current as unknown as {
            scrollTo?: (options: { x: number; animated?: boolean }) => void;
            getNode?: () => { scrollTo?: (options: { x: number; animated?: boolean }) => void };
        } | null;
        if (node?.scrollTo) {
            node.scrollTo({ x, animated });
            return;
        }
        node?.getNode?.()?.scrollTo?.({ x, animated });
    }, [containerWidth]);

    useEffect(() => {
        if (!visible || !containerWidth) return;
        const targetX = editTab === 'task' ? 0 : containerWidth;
        scrollX.setValue(targetX);
        scrollToTab(editTab, false);
    }, [containerWidth, editTab, scrollToTab, task?.id, visible, scrollX]);

    const handleTabPress = (mode: TaskEditTab) => {
        isUserSwipe.current = false;
        setModeTab(mode);
        scrollToTab(mode);
    };

    const applyChecklistUpdate = (nextChecklist: NonNullable<Task['checklist']>) => {
        setEditedTask(prev => {
            const currentStatus = (prev.status ?? task?.status ?? 'inbox') as TaskStatus;
            let nextStatus = currentStatus;
            const isListMode = (prev.taskMode ?? task?.taskMode) === 'list';
            if (isListMode) {
                const allComplete = nextChecklist.length > 0 && nextChecklist.every((item) => item.isCompleted);
                if (allComplete) {
                    nextStatus = 'done';
                } else if (currentStatus === 'done') {
                    nextStatus = 'next';
                }
            }
            return {
                ...prev,
                checklist: nextChecklist,
                status: nextStatus,
            };
        });
    };

    const handleResetChecklist = () => {
        const current = editedTask.checklist || [];
        if (current.length === 0 || !task) return;
        const reset = current.map((item) => ({ ...item, isCompleted: false }));
        applyChecklistUpdate(reset);
        resetTaskChecklist(task.id).catch(console.error);
    };

    const handleDuplicateTask = async () => {
        if (!task) return;
        await duplicateTask(task.id, false).catch(console.error);
        Alert.alert(t('taskEdit.duplicateDoneTitle'), t('taskEdit.duplicateDoneBody'));
    };

    const getAIProvider = async () => {
        if (!aiEnabled) {
            Alert.alert(t('ai.disabledTitle'), t('ai.disabledBody'));
            return null;
        }
        const provider = (settings.ai?.provider ?? 'openai') as 'openai' | 'gemini';
        const apiKey = await loadAIKey(provider);
        if (!apiKey) {
            Alert.alert(t('ai.missingKeyTitle'), t('ai.missingKeyBody'));
            return null;
        }
        return createAIProvider(buildAIConfig(settings, apiKey));
    };

    const applyAISuggestion = (suggested: { title?: string; context?: string; timeEstimate?: TimeEstimate }) => {
        setEditedTask((prev) => {
            const nextContexts = suggested.context
                ? Array.from(new Set([...(prev.contexts ?? []), suggested.context]))
                : prev.contexts;
            return {
                ...prev,
                title: suggested.title ?? prev.title,
                timeEstimate: suggested.timeEstimate ?? prev.timeEstimate,
                contexts: nextContexts,
            };
        });
    };

    const handleAIClarify = async () => {
        if (!task || isAIWorking) return;
        const title = String(editedTask.title ?? task.title ?? '').trim();
        if (!title) return;
        setIsAIWorking(true);
        try {
            const provider = await getAIProvider();
            if (!provider) return;
            const contextOptions = Array.from(new Set([
                ...PRESET_CONTEXTS,
                ...suggestedTags,
                ...(editedTask.contexts ?? []),
            ]));
            const response = await provider.clarifyTask({
                title,
                contexts: contextOptions,
                ...(projectContext ?? {}),
            });
            const actions: AIResponseAction[] = response.options.slice(0, 3).map((option) => ({
                label: option.label,
                onPress: () => {
                    setEditedTask((prev) => ({ ...prev, title: option.action }));
                    closeAIModal();
                },
            }));
            if (response.suggestedAction?.title) {
                actions.push({
                    label: t('ai.applySuggestion'),
                    variant: 'primary',
                    onPress: () => {
                        applyAISuggestion(response.suggestedAction!);
                        closeAIModal();
                    },
                });
            }
            actions.push({
                label: t('common.cancel'),
                variant: 'secondary',
                onPress: closeAIModal,
            });
            setAiModal({
                title: response.question || t('taskEdit.aiClarify'),
                actions,
            });
        } catch (error) {
            console.warn(error);
            Alert.alert(t('ai.errorTitle'), t('ai.errorBody'));
        } finally {
            setIsAIWorking(false);
        }
    };

    const handleAIBreakdown = async () => {
        if (!task || isAIWorking) return;
        const title = String(editedTask.title ?? task.title ?? '').trim();
        if (!title) return;
        setIsAIWorking(true);
        try {
            const provider = await getAIProvider();
            if (!provider) return;
            const response = await provider.breakDownTask({
                title,
                description: String(editedTask.description ?? ''),
                ...(projectContext ?? {}),
            });
            const steps = response.steps.map((step) => step.trim()).filter(Boolean).slice(0, 8);
            if (steps.length === 0) return;
            setAiModal({
                title: t('ai.breakdownTitle'),
                message: steps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
                actions: [
                    {
                        label: t('common.cancel'),
                        variant: 'secondary',
                        onPress: closeAIModal,
                    },
                    {
                        label: t('ai.addSteps'),
                        variant: 'primary',
                        onPress: () => {
                            const newItems = steps.map((step) => ({
                                id: generateUUID(),
                                title: step,
                                isCompleted: false,
                            }));
                            applyChecklistUpdate([...(editedTask.checklist || []), ...newItems]);
                            closeAIModal();
                        },
                    },
                ],
            });
        } catch (error) {
            console.warn(error);
            Alert.alert(t('ai.errorTitle'), t('ai.errorBody'));
        } finally {
            setIsAIWorking(false);
        }
    };

    const inputStyle = { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text };
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean) => ([
        styles.statusText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);
    const getSuggestionChipStyle = (active: boolean) => ([
        styles.suggestionChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getSuggestionTextStyle = (active: boolean) => ([
        styles.suggestionText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);

    const renderField = (fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.statusLabel')}</Text>
                        <View style={styles.statusContainer}>
                            {STATUS_OPTIONS.map(status => (
                                <TouchableOpacity
                                    key={status}
                                    style={getStatusChipStyle(editedTask.status === status)}
                                    onPress={() => setEditedTask(prev => ({ ...prev, status }))}
                                >
                                    <Text style={getStatusTextStyle(editedTask.status === status)}>
                                        {t(`status.${status}`)}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                );
            case 'priority':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.priorityLabel')}</Text>
                        <View style={styles.statusContainer}>
                            <TouchableOpacity
                                style={getStatusChipStyle(!editedTask.priority)}
                                onPress={() => setEditedTask(prev => ({ ...prev, priority: undefined }))}
                            >
                                <Text style={getStatusTextStyle(!editedTask.priority)}>
                                    {t('common.none')}
                                </Text>
                            </TouchableOpacity>
                            {priorityOptions.map(priority => (
                                <TouchableOpacity
                                    key={priority}
                                    style={getStatusChipStyle(editedTask.priority === priority)}
                                    onPress={() => setEditedTask(prev => ({ ...prev, priority }))}
                                >
                                    <Text style={getStatusTextStyle(editedTask.priority === priority)}>
                                        {t(`priority.${priority}`)}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                );
            case 'contexts':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.contextsLabel')}</Text>
                        <TextInput
                            style={[styles.input, inputStyle]}
                            value={editedTask.contexts?.join(', ')}
                            onChangeText={(text) => setEditedTask(prev => ({
                                ...prev,
                                contexts: text.split(',').map(t => t.trim()).filter(Boolean)
                            }))}
                            placeholder="@home, @work"
                            autoCapitalize="none"
                            placeholderTextColor={tc.secondaryText}
                        />
                        <View style={styles.suggestionsContainer}>
                            <View style={styles.suggestionTags}>
                                {suggestedTags.map(tag => {
                                    const isActive = Boolean(editedTask.contexts?.includes(tag));
                                    return (
                                        <TouchableOpacity
                                            key={tag}
                                            style={getSuggestionChipStyle(isActive)}
                                            onPress={() => toggleContext(tag)}
                                        >
                                            <Text style={getSuggestionTextStyle(isActive)}>{tag}</Text>
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
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.tagsLabel')}</Text>
                        <TextInput
                            style={[styles.input, inputStyle]}
                            value={editedTask.tags?.join(', ')}
                            onChangeText={(text) => setEditedTask(prev => ({
                                ...prev,
                                tags: text.split(',').map(t => t.trim()).filter(Boolean)
                            }))}
                            placeholder="#urgent, #idea"
                            autoCapitalize="none"
                            placeholderTextColor={tc.secondaryText}
                        />
                        <View style={styles.suggestionsContainer}>
                            <View style={styles.suggestionTags}>
                                {suggestedHashtags.map(tag => {
                                    const isActive = Boolean(editedTask.tags?.includes(tag));
                                    return (
                                        <TouchableOpacity
                                            key={tag}
                                            style={getSuggestionChipStyle(isActive)}
                                            onPress={() => {
                                                const current = editedTask.tags || [];
                                                const newTags = current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag];
                                                setEditedTask(prev => ({ ...prev, tags: newTags }));
                                            }}
                                        >
                                            <Text style={getSuggestionTextStyle(isActive)}>{tag}</Text>
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
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.blockedByLabel')}</Text>
                        <View style={styles.suggestionsContainer}>
                            <View style={styles.suggestionTags}>
	                                {availableBlockerTasks.map(otherTask => {
                                        const isActive = Boolean(editedTask.blockedByTaskIds?.includes(otherTask.id));
                                        return (
                                            <TouchableOpacity
                                                key={otherTask.id}
                                                style={getSuggestionChipStyle(isActive)}
                                                onPress={() => toggleBlocker(otherTask.id)}
                                            >
                                                <Text
                                                    style={getSuggestionTextStyle(isActive)}
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
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.timeEstimateLabel')}</Text>
                        <View style={styles.statusContainer}>
                            {timeEstimateOptions.map(opt => (
                                <TouchableOpacity
                                    key={opt.value || 'none'}
                                    style={getStatusChipStyle(
                                        editedTask.timeEstimate === opt.value || (!opt.value && !editedTask.timeEstimate)
                                    )}
                                    onPress={() => setEditedTask(prev => ({ ...prev, timeEstimate: opt.value || undefined }))}
                                >
                                    <Text style={getStatusTextStyle(
                                        editedTask.timeEstimate === opt.value || (!opt.value && !editedTask.timeEstimate)
                                    )}>
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
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.recurrenceLabel')}</Text>
                        <View style={styles.statusContainer}>
                            {recurrenceOptions.map(opt => (
                                <TouchableOpacity
                                    key={opt.value || 'none'}
                                    style={getStatusChipStyle(
                                        recurrenceRuleValue === opt.value || (!opt.value && !recurrenceRuleValue)
                                    )}
                                    onPress={() => setEditedTask(prev => ({
                                        ...prev,
                                        recurrence: buildRecurrenceValue(opt.value || '', recurrenceStrategyValue),
                                    }))}
                                >
                                    <Text style={getStatusTextStyle(
                                        recurrenceRuleValue === opt.value || (!opt.value && !recurrenceRuleValue)
                                    )}>
                                        {opt.label}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                        {!!recurrenceRuleValue && (
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                {(['strict', 'fluid'] as RecurrenceStrategy[]).map((strategy) => (
                                    <TouchableOpacity
                                        key={strategy}
                                        style={getStatusChipStyle(recurrenceStrategyValue === strategy)}
                                        onPress={() => setEditedTask(prev => ({
                                            ...prev,
                                            recurrence: buildRecurrenceValue(recurrenceRuleValue, strategy),
                                        }))}
                                    >
                                        <Text style={getStatusTextStyle(recurrenceStrategyValue === strategy)}>
                                            {strategy === 'strict' ? t('recurrence.strategyStrict') : t('recurrence.strategyFluid')}
                                        </Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                    </View>
                );
            case 'startTime':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.startDateLabel')}</Text>
                        <View style={styles.dateRow}>
                            <TouchableOpacity style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]} onPress={() => setShowDatePicker('start')}>
                                <Text style={{ color: tc.text }}>{formatStartDateTime(editedTask.startTime)}</Text>
                            </TouchableOpacity>
                            {!!editedTask.startTime && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask(prev => ({ ...prev, startTime: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>
                );
            case 'dueDate':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.dueDateLabel')}</Text>
                        <View style={styles.dateRow}>
                            <TouchableOpacity style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]} onPress={() => setShowDatePicker('due')}>
                                <Text style={{ color: tc.text }}>{formatDueDate(editedTask.dueDate)}</Text>
                            </TouchableOpacity>
                            {!!editedTask.dueDate && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask(prev => ({ ...prev, dueDate: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>
                );
            case 'reviewAt':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.reviewDateLabel')}</Text>
                        <View style={styles.dateRow}>
                            <TouchableOpacity style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]} onPress={() => setShowDatePicker('review')}>
                                <Text style={{ color: tc.text }}>{formatDate(editedTask.reviewAt)}</Text>
                            </TouchableOpacity>
                            {!!editedTask.reviewAt && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask(prev => ({ ...prev, reviewAt: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>
                );
            case 'description':
                return (
                    <View style={styles.formGroup}>
                        <View style={styles.inlineHeader}>
                            <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.descriptionLabel')}</Text>
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
                                style={[styles.input, styles.textArea, inputStyle]}
                                value={editedTask.description || ''}
                                onChangeText={(text) => {
                                    setEditedTask(prev => ({ ...prev, description: text }));
                                    resetCopilotDraft();
                                }}
                                placeholder={t('taskEdit.descriptionPlaceholder')}
                                multiline
                                placeholderTextColor={tc.secondaryText}
                            />
                        )}
                    </View>
                );
            case 'attachments':
                return (
                    <View style={styles.formGroup}>
                        <View style={styles.inlineHeader}>
                            <Text style={[styles.label, { color: tc.secondaryText }]}>{t('attachments.title')}</Text>
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
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.checklist')}</Text>
                        <View style={[styles.checklistContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            {editedTask.checklist?.map((item, index) => (
                                <View key={item.id || index} style={[styles.checklistItem, { borderBottomColor: tc.border }]}>
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
                                        style={[
                                            styles.checklistInput,
                                            { color: item.isCompleted ? tc.secondaryText : tc.text },
                                            item.isCompleted && styles.completedText,
                                        ]}
                                        value={item.title}
                                        onChangeText={(text) => {
                                            const newChecklist = (editedTask.checklist || []).map((item, i) =>
                                                i === index ? { ...item, title: text } : item
                                            );
                                            setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                        }}
                                        placeholder={t('taskEdit.itemNamePlaceholder')}
                                        placeholderTextColor={tc.secondaryText}
                                    />
                                    <TouchableOpacity
                                        onPress={() => {
                                            const newChecklist = (editedTask.checklist || []).filter((_, i) => i !== index);
                                            setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                        }}
                                        style={styles.deleteBtn}
                                    >
                                        <Text style={[styles.deleteBtnText, { color: tc.secondaryText }]}>×</Text>
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
                            {(editedTask.checklist?.length ?? 0) > 0 && (
                                <View style={styles.checklistActions}>
                                    <TouchableOpacity
                                        style={[styles.checklistActionButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                        onPress={handleResetChecklist}
                                    >
                                        <Text style={[styles.checklistActionText, { color: tc.secondaryText }]}>
                                            {t('taskEdit.resetChecklist')}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </View>
                    </View>
                );
            default:
                return null;
        }
    };

    const renderViewRow = (label: string, value?: string) => {
        if (value === undefined || value === null || value === '') return null;
        return (
            <View style={[styles.viewRow, { backgroundColor: tc.inputBg, borderColor: tc.border }]}>
                <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{label}</Text>
                <Text style={[styles.viewValue, { color: tc.text }]}>{value}</Text>
            </View>
        );
    };

    const renderViewPills = (items: string[] | undefined) => {
        if (!items || items.length === 0) return null;
        return (
            <View style={styles.viewPillRow}>
                {items.map((item) => (
                    <View key={item} style={[styles.viewPill, { borderColor: tc.border, backgroundColor: tc.inputBg }]}>
                        <Text style={[styles.viewPillText, { color: tc.text }]}>{item}</Text>
                    </View>
                ))}
            </View>
        );
    };

    const renderViewContent = () => {
        const project = projects.find((p) => p.id === mergedTask.projectId);
        const blockedByTitles = (mergedTask.blockedByTaskIds || [])
            .filter((id) => availableBlockerIds.has(id))
            .map((id) => tasks.find((t) => t.id === id)?.title)
            .filter(Boolean) as string[];
        const description = String(mergedTask.description || '').trim();
        const checklist = mergedTask.checklist || [];

        const statusLabel = mergedTask.status ? (t(`status.${mergedTask.status}`) || mergedTask.status) : undefined;
        const priorityLabel = mergedTask.priority ? (t(`priority.${mergedTask.priority}`) || mergedTask.priority) : undefined;
        const timeEstimateLabel = mergedTask.timeEstimate
            ? (formatTimeEstimateLabel(mergedTask.timeEstimate as TimeEstimate) || String(mergedTask.timeEstimate))
            : undefined;
        const recurrenceRule = getRecurrenceRuleValue(mergedTask.recurrence);
        const recurrenceStrategy = getRecurrenceStrategyValue(mergedTask.recurrence);
        const recurrenceLabel = recurrenceRule
            ? `${t(`recurrence.${recurrenceRule}`) || recurrenceRule}${recurrenceStrategy === 'fluid' ? ` · ${t('recurrence.strategyFluid')}` : ''}`
            : undefined;

        return (
            <ScrollView
                style={styles.content}
                contentContainerStyle={styles.contentContainer}
                keyboardShouldPersistTaps="handled"
            >
                {renderViewRow(t('taskEdit.statusLabel'), statusLabel)}
                {renderViewRow(t('taskEdit.priorityLabel'), priorityLabel)}
                {renderViewRow(t('taskEdit.projectLabel'), project?.title)}
                {renderViewRow(t('taskEdit.startDateLabel'), mergedTask.startTime ? formatDate(mergedTask.startTime) : undefined)}
                {renderViewRow(t('taskEdit.dueDateLabel'), mergedTask.dueDate ? formatDueDate(mergedTask.dueDate) : undefined)}
                {renderViewRow(t('taskEdit.reviewDateLabel'), mergedTask.reviewAt ? formatDate(mergedTask.reviewAt) : undefined)}
                {renderViewRow(t('taskEdit.timeEstimateLabel'), timeEstimateLabel)}
                {mergedTask.contexts?.length ? (
                    <View style={styles.viewSection}>
                        <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('taskEdit.contextsLabel')}</Text>
                        {renderViewPills(mergedTask.contexts)}
                    </View>
                ) : null}
                {mergedTask.tags?.length ? (
                    <View style={styles.viewSection}>
                        <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('taskEdit.tagsLabel')}</Text>
                        {renderViewPills(mergedTask.tags)}
                    </View>
                ) : null}
                {mergedTask.location ? renderViewRow(t('taskEdit.locationLabel'), mergedTask.location) : null}
                {recurrenceLabel ? renderViewRow(t('taskEdit.recurrenceLabel'), recurrenceLabel) : null}
                {blockedByTitles.length ? (
                    <View style={styles.viewSection}>
                        <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('taskEdit.blockedByLabel')}</Text>
                        {renderViewPills(blockedByTitles)}
                    </View>
                ) : null}
                {description ? (
                    <View style={styles.viewSection}>
                        <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('taskEdit.descriptionLabel')}</Text>
                        <View style={[styles.viewCard, { borderColor: tc.border, backgroundColor: tc.inputBg }]}>
                            <MarkdownText markdown={description} tc={tc} />
                        </View>
                    </View>
                ) : null}
                {checklist.length ? (
                    <View style={styles.viewSection}>
                        <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('taskEdit.checklist')}</Text>
                        <View style={styles.viewChecklist}>
                            {checklist.map((item) => (
                                <TouchableOpacity
                                    key={item.id}
                                    style={styles.viewChecklistItem}
                                    onPress={() => {
                                        const nextChecklist = checklist.map((entry) =>
                                            entry.id === item.id ? { ...entry, isCompleted: !entry.isCompleted } : entry
                                        );
                                        applyChecklistUpdate(nextChecklist);
                                    }}
                                >
                                    <Text style={[styles.viewChecklistMarker, { color: item.isCompleted ? tc.tint : tc.secondaryText }]}>
                                        {item.isCompleted ? '✓' : '○'}
                                    </Text>
                                    <Text style={[styles.viewChecklistText, { color: tc.text }]}>{item.title}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                ) : null}
                {visibleAttachments.length ? (
                    <View style={styles.viewSection}>
                        <Text style={[styles.viewLabel, { color: tc.secondaryText }]}>{t('attachments.title')}</Text>
                        <View style={styles.viewAttachmentGrid}>
                            {visibleAttachments.map((attachment) => (
                                <TouchableOpacity
                                    key={attachment.id}
                                    style={[styles.viewAttachmentCard, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
                                    onPress={() => openAttachment(attachment)}
                                >
                                    {isImageAttachment(attachment) ? (
                                        <Image source={{ uri: attachment.uri }} style={styles.viewAttachmentImage} />
                                    ) : (
                                        <Text style={[styles.viewAttachmentText, { color: tc.text }]} numberOfLines={2}>
                                            {attachment.title}
                                        </Text>
                                    )}
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                ) : null}
            </ScrollView>
        );
    };

    if (!task) return null;

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="pageSheet"
            onRequestClose={handleDone}
        >
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['top']}>
                <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
                    <TouchableOpacity onPress={handleDone}>
                        <Text style={[styles.headerBtn, { color: tc.tint }]}>{t('common.done')}</Text>
                    </TouchableOpacity>
                    <Text style={[styles.headerTitle, { color: tc.text }]}>
                        {String(editedTask.title || '').trim() || t('taskEdit.title')}
                    </Text>
                    <View style={styles.headerRight}>
                        <TouchableOpacity onPress={handleShare}>
                            <Text style={[styles.headerBtn, { color: tc.tint }]}>{t('common.share')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>

                <View style={[styles.modeTabs, { borderBottomColor: tc.border, backgroundColor: tc.cardBg }]}>
                    <View style={[styles.modeTabsTrack, { backgroundColor: tc.filterBg, borderColor: tc.border }]}>
                        {containerWidth > 0 && (
                            <Animated.View
                                pointerEvents="none"
                                style={[
                                    styles.modeTabIndicator,
                                    {
                                        width: containerWidth / 2,
                                        backgroundColor: tc.tint,
                                        transform: [
                                            {
                                                translateX: scrollX.interpolate({
                                                    inputRange: [0, containerWidth],
                                                    outputRange: [0, containerWidth / 2],
                                                    extrapolate: 'clamp',
                                                }),
                                            },
                                        ],
                                    },
                                ]}
                            />
                        )}
                        <TouchableOpacity
                            style={styles.modeTab}
                            onPress={() => handleTabPress('task')}
                            activeOpacity={0.85}
                        >
                            <Text
                                style={[
                                    styles.modeTabText,
                                    { color: editTab === 'task' ? '#fff' : tc.text },
                                ]}
                            >
                                {t('taskEdit.tab.task')}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.modeTab}
                            onPress={() => handleTabPress('view')}
                            activeOpacity={0.85}
                        >
                            <Text
                                style={[
                                    styles.modeTabText,
                                    { color: editTab === 'view' ? '#fff' : tc.text },
                                ]}
                            >
                                {t('taskEdit.tab.view')}
                            </Text>
                        </TouchableOpacity>
                    </View>
                </View>

                <View style={styles.tabContent} onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}>
                    <Animated.ScrollView
                        ref={scrollRef}
                        horizontal
                        pagingEnabled
                        scrollEventThrottle={16}
                        showsHorizontalScrollIndicator={false}
                        directionalLockEnabled
                        onScrollBeginDrag={() => {
                            isUserSwipe.current = true;
                        }}
                        onScroll={Animated.event(
                            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
                            { useNativeDriver: true }
                        )}
                        onMomentumScrollEnd={(event) => {
                            const offsetX = event.nativeEvent.contentOffset.x;
                            if (!containerWidth) return;
                            if (!isUserSwipe.current) return;
                            isUserSwipe.current = false;
                            setModeTab(offsetX >= containerWidth / 2 ? 'view' : 'task');
                        }}
                    >
                        <View style={[styles.tabPage, { width: containerWidth || '100%' }]}>
                            <KeyboardAvoidingView
                                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                                style={{ flex: 1 }}
                                keyboardVerticalOffset={Platform.OS === 'ios' ? 100 : 0}
                            >
                                <ScrollView
                                    style={styles.content}
                                    contentContainerStyle={styles.contentContainer}
                                    keyboardShouldPersistTaps="handled"
                                    nestedScrollEnabled
                                >
                                    <View style={styles.formGroup}>
                                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.titleLabel')}</Text>
                                        <TextInput
                                            style={[styles.input, inputStyle]}
                                            value={editedTask.title}
                                            onChangeText={(text) => {
                                                setEditedTask(prev => ({ ...prev, title: text }));
                                                resetCopilotDraft();
                                            }}
                                            placeholderTextColor={tc.secondaryText}
                                        />
                                    </View>

                                    {aiEnabled && (
                                        <View style={styles.aiRow}>
                                            <TouchableOpacity
                                                style={[styles.aiButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                                                onPress={handleAIClarify}
                                                disabled={isAIWorking}
                                            >
                                                <Text style={[styles.aiButtonText, { color: tc.tint }]}>{t('taskEdit.aiClarify')}</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity
                                                style={[styles.aiButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                                                onPress={handleAIBreakdown}
                                                disabled={isAIWorking}
                                            >
                                                <Text style={[styles.aiButtonText, { color: tc.tint }]}>{t('taskEdit.aiBreakdown')}</Text>
                                            </TouchableOpacity>
                                        </View>
                                    )}
                                    {aiEnabled && copilotSuggestion && !copilotApplied && (
                                        <TouchableOpacity
                                            style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                            onPress={applyCopilotSuggestion}
                                        >
                                            <Text style={[styles.copilotText, { color: tc.text }]}>
                                                ✨ {t('copilot.suggested')}{' '}
                                                {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                                                {copilotSuggestion.timeEstimate ? `${copilotSuggestion.timeEstimate}` : ''}
                                                {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
                                            </Text>
                                            <Text style={[styles.copilotHint, { color: tc.secondaryText }]}>
                                                {t('copilot.applyHint')}
                                            </Text>
                                        </TouchableOpacity>
                                    )}
                                    {aiEnabled && copilotApplied && (
                                        <View style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                                            <Text style={[styles.copilotText, { color: tc.text }]}>
                                                ✅ {t('copilot.applied')}{' '}
                                                {copilotContext ? `${copilotContext} ` : ''}
                                                {copilotEstimate ? `${copilotEstimate}` : ''}
                                                {copilotTags.length ? copilotTags.join(' ') : ''}
                                            </Text>
                                        </View>
                                    )}
                                    {task && (
                                        <View style={styles.checklistActions}>
                                            <TouchableOpacity
                                                style={[styles.checklistActionButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                                onPress={handleDuplicateTask}
                                            >
                                                <Text style={[styles.checklistActionText, { color: tc.secondaryText }]}>
                                                    {t('taskEdit.duplicateTask')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                    )}

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
                                                {showMoreOptions ? t('taskEdit.hideOptions') : t('taskEdit.moreOptions')}
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
                        </View>
                        <View style={[styles.tabPage, { width: containerWidth || '100%' }]}>
                            {React.cloneElement(renderViewContent(), { nestedScrollEnabled: true })}
                        </View>
                    </Animated.ScrollView>
                </View>

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

                {aiModal && (
                    <AIResponseModal
                        visible={Boolean(aiModal)}
                        title={aiModal.title}
                        message={aiModal.message}
                        actions={aiModal.actions}
                        onClose={closeAIModal}
                    />
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
    modeTabs: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: '#fff',
        borderBottomWidth: 1,
    },
    modeTabsTrack: {
        flex: 1,
        flexDirection: 'row',
        borderRadius: 12,
        borderWidth: 1,
        overflow: 'hidden',
    },
    modeTab: {
        flex: 1,
        paddingVertical: 10,
        alignItems: 'center',
    },
    modeTabIndicator: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        borderRadius: 12,
    },
    modeTabActive: {
        backgroundColor: '#007AFF',
    },
    modeTabText: {
        fontSize: 13,
        fontWeight: '600',
        color: '#333',
    },
    modeTabTextActive: {
        color: '#fff',
    },
    content: { padding: 20, flex: 1 },
    contentContainer: { paddingBottom: 32, flexGrow: 1 },
    formGroup: { marginBottom: 20 },
    label: { fontSize: 14, color: '#666', marginBottom: 8, textTransform: 'uppercase' },
    input: {
        padding: 12,
        borderRadius: 10,
        fontSize: 16,
        borderWidth: 1,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
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
        borderRadius: 16,
        borderWidth: 1,
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
        borderRadius: 14,
        borderWidth: 1,
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
    aiRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 12,
    },
    aiButton: {
        borderWidth: 1,
        borderRadius: 16,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    aiButtonText: {
        fontSize: 12,
        fontWeight: '600',
    },
    copilotPill: {
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginBottom: 12,
    },
    copilotText: {
        fontSize: 12,
        fontWeight: '600',
    },
    copilotHint: {
        fontSize: 11,
        marginTop: 2,
    },
    checklistActions: {
        flexDirection: 'row',
        gap: 8,
        justifyContent: 'flex-start',
        paddingHorizontal: 4,
        paddingTop: 6,
    },
    checklistActionButton: {
        borderRadius: 12,
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    checklistActionText: {
        fontSize: 12,
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
    viewRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderWidth: 1,
        borderRadius: 10,
        marginBottom: 12,
    },
    viewLabel: {
        fontSize: 12,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        flex: 1,
    },
    viewValue: {
        fontSize: 14,
        fontWeight: '600',
        flex: 1,
        textAlign: 'right',
    },
    tabContent: {
        flex: 1,
    },
    tabPager: {
        flexDirection: 'row',
        flex: 1,
    },
    tabPage: {
        flex: 1,
    },
    viewSection: {
        marginBottom: 16,
    },
    viewPillRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 8,
    },
    viewPill: {
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    viewPillText: {
        fontSize: 12,
        fontWeight: '600',
    },
    viewCard: {
        marginTop: 8,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
    },
    viewChecklist: {
        marginTop: 8,
        gap: 6,
    },
    viewChecklistItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 6,
    },
    viewChecklistMarker: {
        fontSize: 20,
        width: 26,
        height: 26,
        textAlign: 'center',
    },
    viewChecklistText: {
        fontSize: 14,
        flex: 1,
    },
    viewAttachmentGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
        marginTop: 8,
    },
    viewAttachmentCard: {
        width: '48%',
        borderWidth: 1,
        borderRadius: 12,
        padding: 10,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 90,
    },
    viewAttachmentImage: {
        width: '100%',
        height: 90,
        borderRadius: 10,
        resizeMode: 'cover',
    },
    viewAttachmentText: {
        fontSize: 12,
        fontWeight: '600',
        textAlign: 'center',
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
