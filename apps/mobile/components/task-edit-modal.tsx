import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, ScrollView, Platform, Share, Alert, Animated, Pressable, Keyboard } from 'react-native';
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
    RecurrenceRule,
    type AIProviderId,
    type RecurrenceStrategy,
    type RecurrenceWeekday,
    type RecurrenceByDay,
    buildRRuleString,
    parseRRuleString,
    RECURRENCE_RULES,
    hasTimeComponent,
    safeFormatDate,
    safeParseDate,
    safeParseDueDate,
    resolveAutoTextDirection,
    getAttachmentDisplayTitle,
    normalizeLinkAttachmentInput,
    validateAttachmentForUpload,
    parseQuickAdd,
    DEFAULT_PROJECT_COLOR,
    getLocalizedWeekdayButtons,
    getLocalizedWeekdayLabels,
    filterProjectsBySelectedArea,
    getUsedTaskTokens,
} from '@mindwtr/core';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as DocumentPicker from 'expo-document-picker';
import * as Linking from 'expo-linking';
import * as Sharing from 'expo-sharing';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Paths } from 'expo-file-system';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { MarkdownText } from './markdown-text';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../lib/ai-config';
import { ensureAttachmentAvailable, persistAttachmentLocally } from '../lib/attachment-sync';
import { AIResponseModal, type AIResponseAction } from './ai-response-modal';
import { styles } from './task-edit/task-edit-modal.styles';
import { TaskEditViewTab } from './task-edit/TaskEditViewTab';
import { TaskEditFormTab } from './task-edit/TaskEditFormTab';
import { TaskEditHeader } from './task-edit/TaskEditHeader';
import { TaskEditTabs } from './task-edit/TaskEditTabs';
import { TaskEditProjectPicker } from './task-edit/TaskEditProjectPicker';
import { TaskEditAreaPicker } from './task-edit/TaskEditAreaPicker';
import { TaskEditSectionPicker } from './task-edit/TaskEditSectionPicker';
import {
    TaskEditAudioModal,
    TaskEditImagePreviewModal,
    TaskEditLinkModal,
} from './task-edit/TaskEditOverlayModals';
import {
    WEEKDAY_ORDER,
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
    buildRecurrenceValue,
    getRecurrenceByDayValue,
    getRecurrenceRRuleValue,
} from './task-edit/recurrence-utils';
import { useTaskEditCopilot } from './task-edit/use-task-edit-copilot';
import {
    DEFAULT_TASK_EDITOR_ORDER,
    TASK_EDITOR_FIXED_FIELDS,
    DEFAULT_TASK_EDITOR_VISIBLE,
    getTaskEditorSectionAssignments,
    getTaskEditorSectionOpenDefaults,
    getInitialWindowWidth,
    getTaskEditTabOffset,
    isReleasedAudioPlayerError,
    isValidLinkUri,
    logTaskError,
    logTaskWarn,
    STATUS_OPTIONS,
    syncTaskEditPagerPosition,
} from './task-edit/task-edit-modal.utils';
import {
    applyMarkdownChecklistToTask,
    parseTokenList,
    replaceTrailingToken,
} from './task-edit/task-edit-token-utils';
import { useTaskTokenSuggestions } from './task-edit/use-task-token-suggestions';


interface TaskEditModalProps {
    visible: boolean;
    task: Task | null;
    onClose: () => void;
    onSave: (taskId: string, updates: Partial<Task>) => void;
    onFocusMode?: (taskId: string) => void;
    defaultTab?: 'task' | 'view';
    onProjectNavigate?: (projectId: string) => void;
    onContextNavigate?: (context: string) => void;
    onTagNavigate?: (tag: string) => void;
}

type TaskEditTab = 'task' | 'view';

function resolveInitialTaskEditTab(target?: TaskEditTab, currentTask?: Task | null): TaskEditTab {
    if (target) return target;
    if (currentTask?.taskMode === 'list') return 'view';
    return 'view';
}

function areTaskFieldValuesEqual(left: unknown, right: unknown): boolean {
    if ((left === '' && right == null) || (right === '' && left == null)) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right) || (typeof left === 'object' && left !== null) || (typeof right === 'object' && right !== null)) {
        return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
    }
    return (left ?? null) === (right ?? null);
}

const getOrdinalTranslationKey = (value: '1' | '2' | '3' | '4' | '-1'): 'first' | 'second' | 'third' | 'fourth' | 'last' => {
    if (value === '-1') return 'last';
    if (value === '1') return 'first';
    if (value === '2') return 'second';
    if (value === '3') return 'third';
    return 'fourth';
};

function TaskEditModalInner({
    visible,
    task,
    onClose,
    onSave,
    onFocusMode,
    defaultTab,
    onProjectNavigate,
    onContextNavigate,
    onTagNavigate,
}: TaskEditModalProps) {
    const {
        tasks,
        projects,
        sections,
        areas,
        settings,
        duplicateTask,
        resetTaskChecklist,
        addProject,
        addSection,
        addArea,
        deleteTask,
    } = useTaskStore();
    const { t, language } = useLanguage();
    const tc = useThemeColors();
    const prioritiesEnabled = settings.features?.priorities === true;
    const timeEstimatesEnabled = settings.features?.timeEstimates === true;
    const liveTask = useMemo(() => {
        if (!task?.id) return task ?? null;
        return tasks.find((item) => item.id === task.id) ?? task;
    }, [task, tasks]);
    const [editedTask, setEditedTaskState] = useState<Partial<Task>>({});
    const isDirtyRef = useRef(false);
    const baseTaskRef = useRef<Task | null>(null);
    const setEditedTask = useCallback(
        (value: React.SetStateAction<Partial<Task>>, markDirty = true) => {
            if (markDirty) {
                isDirtyRef.current = true;
            }
            setEditedTaskState(value);
        },
        []
    );
    const [showDatePicker, setShowDatePicker] = useState<'start' | 'start-time' | 'due' | 'due-time' | 'review' | null>(null);
    const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
    const [pendingDueDate, setPendingDueDate] = useState<Date | null>(null);
    const [editTab, setEditTab] = useState<TaskEditTab>(() => resolveInitialTaskEditTab(defaultTab, task));
    const [showDescriptionPreview, setShowDescriptionPreview] = useState(false);
    const [showAreaPicker, setShowAreaPicker] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    const titleDraftRef = useRef('');
    const titleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [descriptionDraft, setDescriptionDraft] = useState('');
    const descriptionDraftRef = useRef('');
    const descriptionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [contextInputDraft, setContextInputDraft] = useState('');
    const [tagInputDraft, setTagInputDraft] = useState('');
    const [isContextInputFocused, setIsContextInputFocused] = useState(false);
    const [isTagInputFocused, setIsTagInputFocused] = useState(false);
    const [linkModalVisible, setLinkModalVisible] = useState(false);
    const [audioModalVisible, setAudioModalVisible] = useState(false);
    const [imagePreviewAttachment, setImagePreviewAttachment] = useState<Attachment | null>(null);
    const [audioAttachment, setAudioAttachment] = useState<Attachment | null>(null);
    const [audioLoading, setAudioLoading] = useState(false);
    const audioPlayer = useAudioPlayer(null, { updateInterval: 500 });
    const audioStatus = useAudioPlayerStatus(audioPlayer);
    const audioLoadedRef = useRef(false);
    const audioStoppingRef = useRef(false);
    const [showProjectPicker, setShowProjectPicker] = useState(false);
    const [showSectionPicker, setShowSectionPicker] = useState(false);
    const [linkInput, setLinkInput] = useState('');
    const [linkInputTouched, setLinkInputTouched] = useState(false);
    const [customWeekdays, setCustomWeekdays] = useState<RecurrenceWeekday[]>([]);
    const recurrenceWeekdayButtons = useMemo(
        () => getLocalizedWeekdayButtons(language, 'narrow'),
        [language]
    );
    const recurrenceWeekdayLabels = useMemo(
        () => getLocalizedWeekdayLabels(language, 'long'),
        [language]
    );
    const [isAIWorking, setIsAIWorking] = useState(false);
    const [aiModal, setAiModal] = useState<{ title: string; message?: string; actions: AIResponseAction[] } | null>(null);
    const aiEnabled = settings.ai?.enabled === true;
    const aiProvider = (settings.ai?.provider ?? 'openai') as AIProviderId;

    const contextOptions = React.useMemo(() => {
        return Array.from(new Set([
            ...getUsedTaskTokens(tasks, (item) => item.contexts, { prefix: '@' }),
            ...(editedTask.contexts ?? []),
        ])).filter(Boolean);
    }, [editedTask.contexts, tasks]);
    const tagOptions = React.useMemo(() => {
        return Array.from(new Set([
            ...getUsedTaskTokens(tasks, (item) => item.tags, { prefix: '#' }),
            ...(editedTask.tags ?? []),
        ])).filter(Boolean);
    }, [editedTask.tags, tasks]);
    const handlePreviewProjectPress = useCallback((projectId: string) => {
        onClose();
        onProjectNavigate?.(projectId);
    }, [onClose, onProjectNavigate]);
    const handlePreviewContextPress = useCallback((context: string) => {
        onClose();
        onContextNavigate?.(context);
    }, [onClose, onContextNavigate]);
    const handlePreviewTagPress = useCallback((tag: string) => {
        onClose();
        onTagNavigate?.(tag);
    }, [onClose, onTagNavigate]);

    const {
        copilotSuggestion,
        copilotApplied,
        copilotContext,
        copilotEstimate,
        copilotTags,
        resetCopilotDraft,
        resetCopilotState,
        applyCopilotSuggestion,
    } = useTaskEditCopilot({
        settings,
        aiEnabled,
        aiProvider,
        timeEstimatesEnabled,
        titleDraft,
        descriptionDraft,
        contextOptions,
        tagOptions,
        editedTask,
        visible,
        setEditedTask,
    });

    const {
        contextTokenSuggestions,
        tagTokenSuggestions,
        frequentContextSuggestions,
        frequentTagSuggestions,
        selectedContextTokens,
        selectedTagTokens,
    } = useTaskTokenSuggestions({
        tasks,
        editedContexts: editedTask.contexts,
        editedTags: editedTask.tags,
        contextInputDraft,
        tagInputDraft,
    });

    useEffect(() => {
        if (liveTask) {
            const recurrenceRule = getRecurrenceRuleValue(liveTask.recurrence);
            const recurrenceStrategy = getRecurrenceStrategyValue(liveTask.recurrence);
            const byDay = getRecurrenceByDayValue(liveTask.recurrence);
            const rrule = getRecurrenceRRuleValue(liveTask.recurrence);
            const normalizedTask: Task = {
                ...liveTask,
                recurrence: recurrenceRule
                    ? { rule: recurrenceRule, strategy: recurrenceStrategy, ...(rrule ? { rrule } : {}), ...(byDay.length ? { byDay } : {}) }
                    : undefined,
            };
            const taskChanged = baseTaskRef.current?.id !== normalizedTask.id;
            const updatedChanged = baseTaskRef.current?.updatedAt !== normalizedTask.updatedAt;
            if (taskChanged || (!isDirtyRef.current && updatedChanged)) {
                setCustomWeekdays(byDay);
                setEditedTaskState(normalizedTask);
                baseTaskRef.current = normalizedTask;
                isDirtyRef.current = false;
                setShowDescriptionPreview(false);
                const nextTitle = String(normalizedTask.title ?? '');
                if (titleDebounceRef.current) {
                    clearTimeout(titleDebounceRef.current);
                    titleDebounceRef.current = null;
                }
                titleDraftRef.current = nextTitle;
                setTitleDraft(nextTitle);
                const nextDescription = String(normalizedTask.description ?? '');
                descriptionDraftRef.current = nextDescription;
                setDescriptionDraft(nextDescription);
                setContextInputDraft((normalizedTask.contexts ?? []).join(', '));
                setTagInputDraft((normalizedTask.tags ?? []).join(', '));
                setIsContextInputFocused(false);
                setIsTagInputFocused(false);
                setEditTab(resolveInitialTaskEditTab(defaultTab, normalizedTask));
                resetCopilotState();
            }
        } else if (visible) {
            setEditedTaskState({});
            baseTaskRef.current = null;
            isDirtyRef.current = false;
            setShowDescriptionPreview(false);
            if (titleDebounceRef.current) {
                clearTimeout(titleDebounceRef.current);
                titleDebounceRef.current = null;
            }
            titleDraftRef.current = '';
            setTitleDraft('');
            descriptionDraftRef.current = '';
            setDescriptionDraft('');
            setContextInputDraft('');
            setTagInputDraft('');
            setIsContextInputFocused(false);
            setIsTagInputFocused(false);
            setEditTab(resolveInitialTaskEditTab(defaultTab, null));
            setCustomWeekdays([]);
        }
    }, [liveTask, defaultTab, visible, resetCopilotState]);

    useEffect(() => {
        if (!visible) {
            setAiModal(null);
        }
    }, [visible]);

    useEffect(() => {
        if (!visible) {
            if (titleDebounceRef.current) {
                clearTimeout(titleDebounceRef.current);
                titleDebounceRef.current = null;
            }
            if (descriptionDebounceRef.current) {
                clearTimeout(descriptionDebounceRef.current);
                descriptionDebounceRef.current = null;
            }
        }
    }, [visible]);

    useEffect(() => {
        if (!visible || isContextInputFocused) return;
        const normalized = (editedTask.contexts ?? []).join(', ');
        if (contextInputDraft !== normalized) {
            setContextInputDraft(normalized);
        }
    }, [contextInputDraft, editedTask.contexts, isContextInputFocused, visible]);

    useEffect(() => {
        if (!visible || isTagInputFocused) return;
        const normalized = (editedTask.tags ?? []).join(', ');
        if (tagInputDraft !== normalized) {
            setTagInputDraft(normalized);
        }
    }, [editedTask.tags, isTagInputFocused, tagInputDraft, visible]);

    useEffect(() => () => {
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        if (descriptionDebounceRef.current) {
            clearTimeout(descriptionDebounceRef.current);
            descriptionDebounceRef.current = null;
        }
    }, []);

    const closeAIModal = () => setAiModal(null);
    const setTitleImmediate = useCallback((text: string) => {
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        titleDraftRef.current = text;
        setTitleDraft(text);
        setEditedTask((prev) => ({ ...prev, title: text }));
    }, [setEditedTask]);
    const handleTitleDraftChange = useCallback((text: string) => {
        titleDraftRef.current = text;
        setTitleDraft(text);
        resetCopilotDraft();
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
        }
        titleDebounceRef.current = setTimeout(() => {
            setEditedTask((prev) => ({ ...prev, title: text }));
        }, 250);
    }, [resetCopilotDraft, setEditedTask]);

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

    const activeProjectId = editedTask.projectId ?? task?.projectId;
    const projectFilterAreaId =
        typeof editedTask.areaId === 'string' && editedTask.areaId.trim().length > 0
            ? editedTask.areaId
            : undefined;
    const filteredProjectsForPicker = useMemo(
        () => filterProjectsBySelectedArea(projects, projectFilterAreaId),
        [projectFilterAreaId, projects]
    );

    useEffect(() => {
        const projectId = editedTask.projectId ?? task?.projectId;
        const sectionId = editedTask.sectionId ?? task?.sectionId;
        if (!sectionId) return;
        if (!projectId) {
            setEditedTask(prev => ({ ...prev, sectionId: undefined }));
            return;
        }
        const isValid = sections.some((section) => section.id === sectionId && section.projectId === projectId && !section.deletedAt);
        if (!isValid) {
            setEditedTask(prev => ({ ...prev, sectionId: undefined }));
        }
    }, [editedTask.projectId, editedTask.sectionId, sections, setEditedTask, task?.projectId, task?.sectionId]);

    useEffect(() => {
        if (!activeProjectId) {
            setShowSectionPicker(false);
        }
    }, [activeProjectId]);

    const handleSave = async () => {
        if (!task) return;
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        if (descriptionDebounceRef.current) {
            clearTimeout(descriptionDebounceRef.current);
            descriptionDebounceRef.current = null;
        }
        const rawTitle = String(titleDraftRef.current ?? '');
        const { title: parsedTitle, props: parsedProps, projectTitle, invalidDateCommands } = parseQuickAdd(rawTitle, projects, new Date(), areas);
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            Alert.alert(t('common.notice'), `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`);
            return;
        }
        const existingProjectId = editedTask.projectId ?? task?.projectId;
        const hasProjectCommand = Boolean(parsedProps.projectId || projectTitle);
        let resolvedProjectId = parsedProps.projectId;
        if (!resolvedProjectId && projectTitle) {
            try {
                const created = await addProject(
                    projectTitle,
                    DEFAULT_PROJECT_COLOR,
                    projectFilterAreaId ? { areaId: projectFilterAreaId } : undefined
                );
                resolvedProjectId = created?.id;
            } catch (error) {
                logTaskError('Failed to create project from quick add', error);
            }
        }
        if (!resolvedProjectId) {
            resolvedProjectId = existingProjectId;
        }
        const fallbackTitle = editedTask.title ?? task.title ?? rawTitle;
        const cleanedTitle = parsedTitle.trim() ? parsedTitle : fallbackTitle;
        const baseDescription = descriptionDraftRef.current;
        const resolvedDescription = parsedProps.description
            ? (baseDescription ? `${baseDescription}\n${parsedProps.description}` : parsedProps.description)
            : baseDescription;
        const mergedContexts = parsedProps.contexts
            ? Array.from(new Set([...(editedTask.contexts || []), ...parsedProps.contexts]))
            : editedTask.contexts;
        const mergedTags = parsedProps.tags
            ? Array.from(new Set([...(editedTask.tags || []), ...parsedProps.tags]))
            : editedTask.tags;
        const updates: Partial<Task> = {
            ...editedTask,
            title: cleanedTitle,
            description: resolvedDescription,
            contexts: mergedContexts,
            tags: mergedTags,
        };
        updates.checklist = applyMarkdownChecklistToTask(resolvedDescription, updates.checklist);
        if (parsedProps.status) updates.status = parsedProps.status;
        if (parsedProps.startTime) updates.startTime = parsedProps.startTime;
        if (parsedProps.dueDate) updates.dueDate = parsedProps.dueDate;
        if (parsedProps.reviewAt) updates.reviewAt = parsedProps.reviewAt;
        if (hasProjectCommand && resolvedProjectId && resolvedProjectId !== existingProjectId) {
            updates.projectId = resolvedProjectId;
            updates.sectionId = undefined;
            updates.areaId = undefined;
        }
        const recurrenceRule = getRecurrenceRuleValue(editedTask.recurrence);
        const recurrenceStrategy = getRecurrenceStrategyValue(editedTask.recurrence);
        if (recurrenceRule) {
            if (recurrenceRule === 'weekly' && customWeekdays.length > 0) {
                const rrule = buildRRuleString('weekly', customWeekdays);
                updates.recurrence = { rule: 'weekly', strategy: recurrenceStrategy, byDay: customWeekdays, rrule };
            } else if (recurrenceRRuleValue) {
                const parsed = parseRRuleString(recurrenceRRuleValue);
                if (parsed.byDay?.length) {
                    updates.recurrence = { rule: recurrenceRule, strategy: recurrenceStrategy, byDay: parsed.byDay, rrule: recurrenceRRuleValue };
                } else {
                    updates.recurrence = { rule: recurrenceRule, strategy: recurrenceStrategy, rrule: recurrenceRRuleValue };
                }
            } else {
                updates.recurrence = buildRecurrenceValue(recurrenceRule, recurrenceStrategy);
            }
        } else {
            updates.recurrence = undefined;
        }
        const baseTask = baseTaskRef.current ?? task;
        const nextProjectId = updates.projectId ?? baseTask.projectId;
        if (nextProjectId) {
            updates.areaId = undefined;
        } else {
            updates.sectionId = undefined;
        }
        if (nextProjectId) {
            const nextSectionId = updates.sectionId ?? baseTask.sectionId;
            if (nextSectionId) {
                const isValid = sections.some((section) =>
                    section.id === nextSectionId && section.projectId === nextProjectId && !section.deletedAt
                );
                if (!isValid) {
                    updates.sectionId = undefined;
                }
            }
        }
        const trimmedUpdates: Partial<Task> = { ...updates };
        (Object.keys(trimmedUpdates) as (keyof Task)[]).forEach((key) => {
            const nextValue = trimmedUpdates[key];
            const baseValue = baseTask[key];
            if (Array.isArray(nextValue) || typeof nextValue === 'object') {
                const nextSerialized = nextValue == null ? null : JSON.stringify(nextValue);
                const baseSerialized = baseValue == null ? null : JSON.stringify(baseValue);
                if (nextSerialized === baseSerialized) delete trimmedUpdates[key];
            } else if ((nextValue ?? null) === (baseValue ?? null)) {
                delete trimmedUpdates[key];
            }
        });
        if (Object.keys(trimmedUpdates).length === 0) {
            onClose();
            return;
        }
        onSave(task.id, trimmedUpdates);
        onClose();
    };

    const handleShare = async () => {
        if (!task) return;

        const title = String(titleDraftRef.current ?? editedTask.title ?? task.title ?? '').trim();
        const lines: string[] = [];

        if (title) lines.push(title);

        const status = (editedTask.status ?? task.status) as TaskStatus | undefined;
        if (status) lines.push(`${t('taskEdit.statusLabel')}: ${t(`status.${status}`)}`);
        if (prioritiesEnabled) {
            const priority = editedTask.priority ?? task.priority;
            if (priority) lines.push(`${t('taskEdit.priorityLabel')}: ${t(`priority.${priority}`)}`);
        }

        if (editedTask.startTime) lines.push(`${t('taskEdit.startDateLabel')}: ${formatDate(editedTask.startTime)}`);
        if (editedTask.dueDate) lines.push(`${t('taskEdit.dueDateLabel')}: ${formatDueDate(editedTask.dueDate)}`);
        if (editedTask.reviewAt) lines.push(`${t('taskEdit.reviewDateLabel')}: ${formatDate(editedTask.reviewAt)}`);

        if (timeEstimatesEnabled) {
            const estimate = editedTask.timeEstimate as TimeEstimate | undefined;
            if (estimate) lines.push(`${t('taskEdit.timeEstimateLabel')}: ${formatTimeEstimateLabel(estimate)}`);
        }

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
            logTaskError('Share failed:', error);
        }
    };

    const attachments = (editedTask.attachments || []) as Attachment[];
    const visibleAttachments = attachments.filter((a) => !a.deletedAt);

    const resolveValidationMessage = (error?: string) => {
        if (error === 'file_too_large') return t('attachments.fileTooLarge');
        if (error === 'mime_type_blocked' || error === 'mime_type_not_allowed') return t('attachments.invalidFileType');
        return t('attachments.fileNotSupported');
    };

    const addFileAttachment = async () => {
        const result = await DocumentPicker.getDocumentAsync({
            copyToCacheDirectory: false,
            multiple: false,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        const size = asset.size;
        if (typeof size === 'number') {
            const validation = await validateAttachmentForUpload(
                {
                    id: 'pending',
                    kind: 'file',
                    title: asset.name || 'file',
                    uri: asset.uri,
                    mimeType: asset.mimeType,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                size
            );
            if (!validation.valid) {
                Alert.alert(t('attachments.title'), resolveValidationMessage(validation.error));
                return;
            }
        }
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
            localStatus: 'available',
        };
        const cached = await persistAttachmentLocally(attachment);
        setEditedTask((prev) => ({ ...prev, attachments: [...(prev.attachments || []), cached] }));
    };

    const addImageAttachment = async () => {
        let imagePicker: typeof import('expo-image-picker') | null = null;
        try {
            imagePicker = await import('expo-image-picker');
        } catch (error) {
            logTaskWarn('Image picker unavailable', error);
            Alert.alert(t('attachments.photoUnavailableTitle'), t('attachments.photoUnavailableBody'));
            return;
        }

        // Android can use the system picker flow without requesting legacy media permissions.
        // Keep the explicit permission request on iOS where Photos permission is required.
        if (Platform.OS === 'ios') {
            const permission = await imagePicker.getMediaLibraryPermissionsAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionsAsync();
                if (!requested.granted) return;
            }
        }
        const result = await imagePicker.launchImageLibraryAsync({
            mediaTypes: imagePicker.MediaTypeOptions.Images,
            quality: 0.9,
            allowsMultipleSelection: false,
        });
        if (result.canceled || !result.assets?.length) return;
        const asset = result.assets[0];
        const size = (asset as { fileSize?: number }).fileSize ?? (asset as { size?: number }).size;
        if (typeof size === 'number') {
            const validation = await validateAttachmentForUpload(
                {
                    id: 'pending',
                    kind: 'file',
                    title: asset.fileName || asset.uri.split('/').pop() || 'image',
                    uri: asset.uri,
                    mimeType: asset.mimeType,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
                size
            );
            if (!validation.valid) {
                Alert.alert(t('attachments.title'), resolveValidationMessage(validation.error));
                return;
            }
        }
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
            localStatus: 'available',
        };
        const cached = await persistAttachmentLocally(attachment);
        setEditedTask((prev) => ({ ...prev, attachments: [...(prev.attachments || []), cached] }));
    };

    const confirmAddLink = () => {
        if (!linkInput.trim()) {
            setLinkInputTouched(true);
            return;
        }
        const normalized = normalizeLinkAttachmentInput(linkInput);
        if (!normalized.uri || !isValidLinkUri(normalized.uri)) {
            Alert.alert(t('attachments.title'), t('attachments.invalidLink'));
            return;
        }
        const now = new Date().toISOString();
        const attachment: Attachment = {
            id: generateUUID(),
            kind: normalized.kind,
            title: normalized.title,
            uri: normalized.uri,
            createdAt: now,
            updatedAt: now,
        };
        setEditedTask((prev) => ({ ...prev, attachments: [...(prev.attachments || []), attachment] }));
        setLinkInput('');
        setLinkInputTouched(false);
        setLinkModalVisible(false);
    };

    const closeLinkModal = useCallback(() => {
        setLinkModalVisible(false);
        setLinkInput('');
        setLinkInputTouched(false);
    }, []);

    const isAudioAttachment = (attachment: Attachment) => {
        const mime = attachment.mimeType?.toLowerCase();
        if (mime?.startsWith('audio/')) return true;
        return /\.(m4a|aac|mp3|wav|caf|ogg|oga|3gp|3gpp)$/i.test(attachment.uri);
    };

    const unloadAudio = useCallback(async () => {
        if (audioStoppingRef.current) return;
        if (!audioLoadedRef.current) return;
        audioStoppingRef.current = true;
        try {
            await Promise.resolve(audioPlayer.pause());
        } catch (error) {
            if (!isReleasedAudioPlayerError(error)) {
                logTaskWarn('Stop audio failed', error);
            }
        } finally {
            audioLoadedRef.current = false;
            audioStoppingRef.current = false;
        }
    }, [audioPlayer]);

    const normalizeAudioUri = useCallback((uri: string) => {
        if (!uri) return '';
        if (uri.startsWith('file://') || uri.startsWith('content://')) return uri;
        if (uri.startsWith('file:/')) {
            const stripped = uri.replace(/^file:\//, '/');
            return `file://${stripped}`;
        }
        if (uri.startsWith('/')) return `file://${uri}`;
        return uri;
    }, []);

    const openAudioAttachment = useCallback(async (attachment: Attachment) => {
        setAudioAttachment(attachment);
        setAudioModalVisible(true);
        setAudioLoading(true);
        try {
            await unloadAudio();
            await setAudioModeAsync({
                allowsRecording: false,
                playsInSilentMode: true,
                interruptionMode: 'duckOthers',
                interruptionModeAndroid: 'duckOthers',
            });
            const normalizedUri = normalizeAudioUri(attachment.uri);
            if (normalizedUri) {
                try {
                    const info = Paths.info(normalizedUri);
                    if (info?.exists === false) {
                        logTaskWarn('Audio attachment missing', new Error(`uri:${normalizedUri}`));
                        Alert.alert(t('attachments.title'), t('attachments.missing'));
                        setAudioModalVisible(false);
                        setAudioAttachment(null);
                        return;
                    }
                    if (info?.isDirectory) {
                        logTaskWarn('Audio attachment path is directory', new Error(`uri:${normalizedUri}`));
                        Alert.alert(t('attachments.title'), t('attachments.missing'));
                        setAudioModalVisible(false);
                        setAudioAttachment(null);
                        return;
                    }
                } catch (error) {
                    logTaskWarn('Audio attachment info failed', error);
                }
            } else {
                logTaskWarn('Audio attachment uri missing', new Error('empty-uri'));
                Alert.alert(t('attachments.title'), t('attachments.missing'));
                setAudioModalVisible(false);
                setAudioAttachment(null);
                return;
            }
            audioPlayer.replace({ uri: normalizedUri });
            audioLoadedRef.current = true;
            await Promise.resolve(audioPlayer.play());
        } catch (error) {
            audioLoadedRef.current = false;
            logTaskError('Failed to play audio attachment', error);
            Alert.alert(t('quickAdd.audioErrorTitle'), t('quickAdd.audioErrorBody'));
            setAudioModalVisible(false);
            setAudioAttachment(null);
        } finally {
            setAudioLoading(false);
        }
    }, [audioPlayer, normalizeAudioUri, t, unloadAudio]);

    const closeAudioModal = useCallback(() => {
        setAudioModalVisible(false);
        setAudioAttachment(null);
        setAudioLoading(false);
        void unloadAudio();
    }, [unloadAudio]);

    const closeImagePreview = useCallback(() => {
        setImagePreviewAttachment(null);
    }, []);

    const toggleAudioPlayback = useCallback(async () => {
        if (!audioStatus?.isLoaded || !audioLoadedRef.current) return;
        try {
            if (audioStatus.playing) {
                await Promise.resolve(audioPlayer.pause());
            } else {
                const duration = Number.isFinite(audioStatus.duration) ? audioStatus.duration : 0;
                const currentTime = Number.isFinite(audioStatus.currentTime) ? audioStatus.currentTime : 0;
                const isAtEnd = duration > 0 && currentTime >= Math.max(0, duration - 0.1);
                if (audioStatus.didJustFinish || isAtEnd) {
                    await Promise.resolve(audioPlayer.seekTo(0));
                }
                await Promise.resolve(audioPlayer.play());
            }
        } catch (error) {
            if (isReleasedAudioPlayerError(error)) {
                audioLoadedRef.current = false;
                return;
            }
            logTaskWarn('Toggle audio playback failed', error);
        }
    }, [audioPlayer, audioStatus]);

    const updateAttachmentState = useCallback((nextAttachment: Attachment) => {
        setEditedTask((prev) => {
            const nextAttachments = (prev.attachments || []).map((item) =>
                item.id === nextAttachment.id ? { ...item, ...nextAttachment } : item
            );
            return { ...prev, attachments: nextAttachments };
        }, false);
    }, [setEditedTask]);

    const resolveAttachment = useCallback(async (attachment: Attachment): Promise<Attachment | null> => {
        if (attachment.kind !== 'file') return attachment;
        const shouldDownload =
            attachment.cloudKey &&
            (attachment.localStatus === 'missing' || !attachment.uri);
        if (shouldDownload && attachment.localStatus !== 'downloading') {
            updateAttachmentState({ ...attachment, localStatus: 'downloading' });
        }
        const resolved = await ensureAttachmentAvailable(attachment);
        if (resolved) {
            if (resolved.uri !== attachment.uri || resolved.localStatus !== attachment.localStatus) {
                updateAttachmentState(resolved);
            }
            return resolved;
        }
        if (shouldDownload) {
            updateAttachmentState({ ...attachment, localStatus: 'missing' });
        }
        return null;
    }, [updateAttachmentState]);

    const downloadAttachment = useCallback(async (attachment: Attachment) => {
        const resolved = await resolveAttachment(attachment);
        if (!resolved) {
            const message = attachment.kind === 'file' ? t('attachments.missing') : t('attachments.fileNotSupported');
            Alert.alert(t('attachments.title'), message);
        }
    }, [resolveAttachment, t]);

    const openAttachment = async (attachment: Attachment) => {
        const resolved = await resolveAttachment(attachment);
        if (!resolved) {
            const message = attachment.kind === 'file' ? t('attachments.missing') : t('attachments.fileNotSupported');
            Alert.alert(t('attachments.title'), message);
            return;
        }

        if (resolved.kind === 'link') {
            Linking.openURL(resolved.uri).catch((error) => logTaskError('Failed to open attachment URL', error));
            return;
        }
        if (isAudioAttachment(resolved)) {
            openAudioAttachment(resolved).catch((error) => logTaskError('Failed to open audio attachment', error));
            return;
        }
        if (isImageAttachment(resolved)) {
            setImagePreviewAttachment(resolved);
            return;
        }
        const available = await Sharing.isAvailableAsync().catch((error) => {
            logTaskWarn('[Sharing] availability check failed', error);
            return false;
        });
        if (available) {
            Sharing.shareAsync(resolved.uri).catch((error) => logTaskError('Failed to share attachment', error));
        } else {
            Linking.openURL(resolved.uri).catch((error) => logTaskError('Failed to open attachment URL', error));
        }
    };

    const isImageAttachment = (attachment: Attachment) => {
        const mime = attachment.mimeType?.toLowerCase();
        if (mime?.startsWith('image/')) return true;
        return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
    };

    useEffect(() => {
        if (!visible) {
            closeAudioModal();
            closeImagePreview();
        }
    }, [closeAudioModal, closeImagePreview, visible]);

    useEffect(() => {
        if (!audioStatus?.isLoaded) {
            audioLoadedRef.current = false;
        }
    }, [audioStatus?.isLoaded]);

    useEffect(() => {
        return () => {
            void unloadAudio();
        };
    }, [unloadAudio]);

    const removeAttachment = (id: string) => {
        const now = new Date().toISOString();
        const next = attachments.map((a) => (a.id === id ? { ...a, deletedAt: now, updatedAt: now } : a));
        setEditedTask((prev) => ({ ...prev, attachments: next }));
    };



    const onDateChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
        const currentMode = showDatePicker;
        if (!currentMode) return;

        if (event.type === 'dismissed') {
            if (currentMode === 'start-time') setPendingStartDate(null);
            if (currentMode === 'due-time') setPendingDueDate(null);
            setShowDatePicker(null);
            return;
        }

        if (!selectedDate) return;

        if (currentMode === 'start') {
            const dateOnly = safeFormatDate(selectedDate, 'yyyy-MM-dd');
            const existing = editedTask.startTime && hasTimeComponent(editedTask.startTime)
                ? safeParseDate(editedTask.startTime)
                : null;
            if (existing) {
                const combined = new Date(selectedDate);
                combined.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
                setPendingStartDate(combined);
                setEditedTask(prev => ({ ...prev, startTime: combined.toISOString() }));
            } else {
                setPendingStartDate(new Date(selectedDate));
                setEditedTask(prev => ({ ...prev, startTime: dateOnly }));
            }
            if (Platform.OS === 'android') setShowDatePicker(null);
            return;
        }

        if (currentMode === 'start-time') {
            const base = pendingStartDate ?? safeParseDate(editedTask.startTime) ?? new Date();
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
            const dateOnly = safeFormatDate(selectedDate, 'yyyy-MM-dd');
            const existing = editedTask.dueDate && hasTimeComponent(editedTask.dueDate)
                ? safeParseDate(editedTask.dueDate)
                : null;
            if (existing) {
                const combined = new Date(selectedDate);
                combined.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
                setPendingDueDate(combined);
                setEditedTask(prev => ({ ...prev, dueDate: combined.toISOString() }));
            } else {
                setPendingDueDate(new Date(selectedDate));
                setEditedTask(prev => ({ ...prev, dueDate: dateOnly }));
            }
            if (Platform.OS === 'android') setShowDatePicker(null);
            return;
        }

        // due-time (Android) - combine pending date with chosen time.
        const base = pendingDueDate ?? safeParseDate(editedTask.dueDate) ?? new Date();
        const combined = new Date(base);
        combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
        setEditedTask(prev => ({ ...prev, dueDate: combined.toISOString() }));
        setPendingDueDate(null);
        if (Platform.OS === 'android') setShowDatePicker(null);
    };

    const formatDate = (dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = safeParseDate(dateStr);
        if (!parsed) return t('common.notSet');
        return parsed.toLocaleDateString();
    };

    const formatStartDateTime = (dateStr?: string) => {
        if (!dateStr) return t('common.notSet');
        const parsed = safeParseDate(dateStr);
        if (!parsed) return t('common.notSet');
        const hasTime = hasTimeComponent(dateStr);
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
        const parsed = safeParseDueDate(dateStr);
        if (!parsed) return t('common.notSet');
        const hasTime = hasTimeComponent(dateStr);
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
        const parsed = safeParseDate(dateStr);
        if (!parsed) return new Date();
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

    const savedOrder = useMemo(() => settings.gtd?.taskEditor?.order ?? [], [settings.gtd?.taskEditor?.order]);
    const savedHidden = useMemo(() => {
        const featureHiddenFields = new Set<TaskEditorFieldId>();
        if (!prioritiesEnabled) featureHiddenFields.add('priority');
        if (!timeEstimatesEnabled) featureHiddenFields.add('timeEstimate');
        const defaultHidden = DEFAULT_TASK_EDITOR_ORDER.filter(
            (fieldId) => !DEFAULT_TASK_EDITOR_VISIBLE.includes(fieldId) || featureHiddenFields.has(fieldId)
        );
        return settings.gtd?.taskEditor?.hidden ?? defaultHidden;
    }, [prioritiesEnabled, settings.gtd?.taskEditor?.hidden, timeEstimatesEnabled]);
    const isReference = (editedTask.status ?? task?.status) === 'reference';
    const availableStatusOptions = useMemo(
        () => (isReference ? STATUS_OPTIONS : STATUS_OPTIONS.filter((status) => status !== 'reference')),
        [isReference]
    );
    const disabledFields = useMemo(() => {
        const next = new Set<TaskEditorFieldId>();
        if (!prioritiesEnabled) next.add('priority');
        if (!timeEstimatesEnabled) next.add('timeEstimate');
        return next;
    }, [prioritiesEnabled, timeEstimatesEnabled]);

    const taskEditorOrder = useMemo(() => {
        const known = new Set(DEFAULT_TASK_EDITOR_ORDER);
        const normalized = savedOrder.filter((id) => known.has(id));
        const missing = DEFAULT_TASK_EDITOR_ORDER.filter((id) => !normalized.includes(id));
        return [...normalized, ...missing].filter((id) => !disabledFields.has(id));
    }, [savedOrder, disabledFields]);
    const sectionAssignments = useMemo(
        () => getTaskEditorSectionAssignments(settings.gtd?.taskEditor),
        [settings.gtd?.taskEditor]
    );
    const sectionOpenDefaults = useMemo(
        () => getTaskEditorSectionOpenDefaults(settings.gtd?.taskEditor),
        [settings.gtd?.taskEditor]
    );
    const hiddenSet = useMemo(() => {
        const known = new Set(taskEditorOrder);
        const next = new Set(savedHidden.filter((id) => known.has(id)));
        if (settings.features?.priorities === false) next.add('priority');
        if (settings.features?.timeEstimates === false) next.add('timeEstimate');
        return next;
    }, [savedHidden, settings.features?.priorities, settings.features?.timeEstimates, taskEditorOrder]);

    const orderFields = useCallback(
        (fields: TaskEditorFieldId[]) => {
            const ordered = taskEditorOrder.filter((id) => fields.includes(id));
            const missing = fields.filter((id) => !ordered.includes(id));
            return [...ordered, ...missing];
        },
        [taskEditorOrder]
    );

    const referenceHiddenFields = useMemo(() => new Set<TaskEditorFieldId>([
        'startTime',
        'dueDate',
        'reviewAt',
        'recurrence',
        'priority',
        'timeEstimate',
        'checklist',
    ]), []);
    const hasValue = useCallback((fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return (editedTask.status ?? task?.status) !== 'inbox';
            case 'project':
                return Boolean(editedTask.projectId ?? task?.projectId);
            case 'section':
                return Boolean(editedTask.sectionId ?? task?.sectionId);
            case 'area':
                return Boolean(editedTask.areaId ?? task?.areaId);
            case 'priority':
                if (!prioritiesEnabled) return false;
                return Boolean(editedTask.priority ?? task?.priority);
            case 'contexts':
                return Boolean(contextInputDraft.trim());
            case 'description':
                return Boolean(descriptionDraft.trim());
            case 'tags':
                return Boolean(tagInputDraft.trim());
            case 'timeEstimate':
                if (!timeEstimatesEnabled) return false;
                return Boolean(editedTask.timeEstimate ?? task?.timeEstimate);
            case 'recurrence':
                return Boolean(editedTask.recurrence ?? task?.recurrence);
            case 'startTime':
                return Boolean(editedTask.startTime ?? task?.startTime);
            case 'dueDate':
                return Boolean(editedTask.dueDate ?? task?.dueDate);
            case 'reviewAt':
                return Boolean(editedTask.reviewAt ?? task?.reviewAt);
            case 'attachments':
                return visibleAttachments.length > 0;
            case 'checklist':
                return (editedTask.checklist ?? task?.checklist ?? []).length > 0;
            default:
                return false;
        }
    }, [
        contextInputDraft,
        descriptionDraft,
        editedTask.areaId,
        editedTask.checklist,
        editedTask.dueDate,
        editedTask.priority,
        editedTask.projectId,
        editedTask.recurrence,
        editedTask.reviewAt,
        editedTask.sectionId,
        editedTask.startTime,
        editedTask.status,
        editedTask.timeEstimate,
        prioritiesEnabled,
        tagInputDraft,
        task?.areaId,
        task?.checklist,
        task?.dueDate,
        task?.priority,
        task?.projectId,
        task?.recurrence,
        task?.reviewAt,
        task?.sectionId,
        task?.startTime,
        task?.status,
        task?.timeEstimate,
        timeEstimatesEnabled,
        visibleAttachments.length,
    ]);
    const isFieldVisible = useCallback(
        (fieldId: TaskEditorFieldId) => {
            if (isReference && referenceHiddenFields.has(fieldId)) return false;
            return !hiddenSet.has(fieldId) || hasValue(fieldId);
        },
        [hasValue, hiddenSet, isReference, referenceHiddenFields]
    );
    const filterVisibleFields = useCallback(
        (fields: TaskEditorFieldId[]) => fields.filter(isFieldVisible),
        [isFieldVisible]
    );
    const basicFields = useMemo(
        () => filterVisibleFields(orderFields(
            ['status', ...taskEditorOrder.filter((fieldId) =>
                !TASK_EDITOR_FIXED_FIELDS.includes(fieldId) && sectionAssignments[fieldId] === 'basic'
            )]
        )),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const schedulingFields = useMemo(
        () => filterVisibleFields(orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'scheduling'))),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const organizationFields = useMemo(
        () => filterVisibleFields(orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'organization'))),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );
    const detailsFields = useMemo(
        () => filterVisibleFields(orderFields(taskEditorOrder.filter((fieldId) => sectionAssignments[fieldId] === 'details'))),
        [filterVisibleFields, orderFields, sectionAssignments, taskEditorOrder]
    );

    const mergedTask = useMemo(() => ({
        ...(task ?? {}),
        ...editedTask,
    }), [task, editedTask]);

    const projectSections = useMemo(() => {
        if (!activeProjectId) return [];
        return sections
            .filter((section) => section.projectId === activeProjectId && !section.deletedAt)
            .sort((a, b) => {
                const aOrder = Number.isFinite(a.order) ? a.order : 0;
                const bOrder = Number.isFinite(b.order) ? b.order : 0;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.title.localeCompare(b.title);
            });
    }, [activeProjectId, sections]);

    const recurrenceOptions: { value: RecurrenceRule | ''; label: string }[] = [
        { value: '', label: t('recurrence.none') },
        ...RECURRENCE_RULES.map((rule) => ({
            value: rule,
            label: t(`recurrence.${rule}`),
        })),
    ];
    const recurrenceRuleValue = getRecurrenceRuleValue(editedTask.recurrence);
    const recurrenceStrategyValue = getRecurrenceStrategyValue(editedTask.recurrence);
    const recurrenceRRuleValue = getRecurrenceRRuleValue(editedTask.recurrence);
    const dailyInterval = useMemo(() => {
        if (recurrenceRuleValue !== 'daily') return 1;
        const parsed = parseRRuleString(recurrenceRRuleValue);
        return parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
    }, [recurrenceRuleValue, recurrenceRRuleValue]);
    const monthlyAnchorDate = useMemo(() => {
        return safeParseDate(editedTask.dueDate ?? task?.dueDate) ?? new Date();
    }, [editedTask.dueDate, task?.dueDate]);
    const monthlyWeekdayCode = WEEKDAY_ORDER[monthlyAnchorDate.getDay()];
    const monthlyPattern = useMemo(() => {
        if (recurrenceRuleValue !== 'monthly') return 'date';
        const parsed = parseRRuleString(recurrenceRRuleValue);
        const hasLast = parsed.byDay?.some((day) => String(day).startsWith('-1'));
        const hasNth = parsed.byDay?.some((day) => /^[1-4]/.test(String(day)));
        const hasByMonthDay = parsed.byMonthDay && parsed.byMonthDay.length > 0;
        const interval = parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
        const isCustomDay = hasByMonthDay && parsed.byMonthDay?.[0] !== monthlyAnchorDate.getDate();
        return hasNth || hasLast || interval > 1 || isCustomDay ? 'custom' : 'date';
    }, [recurrenceRuleValue, recurrenceRRuleValue, monthlyAnchorDate]);

    const [customRecurrenceVisible, setCustomRecurrenceVisible] = useState(false);
    const [customInterval, setCustomInterval] = useState(1);
    const [customMode, setCustomMode] = useState<'date' | 'nth'>('date');
    const [customOrdinal, setCustomOrdinal] = useState<'1' | '2' | '3' | '4' | '-1'>('1');
    const [customWeekday, setCustomWeekday] = useState<RecurrenceWeekday>(monthlyWeekdayCode);
    const [customMonthDay, setCustomMonthDay] = useState<number>(monthlyAnchorDate.getDate());

    const openCustomRecurrence = useCallback(() => {
        const parsed = parseRRuleString(recurrenceRRuleValue);
        const interval = parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
        let mode: 'date' | 'nth' = 'date';
        let ordinal: '1' | '2' | '3' | '4' | '-1' = '1';
        let weekday: RecurrenceWeekday = monthlyWeekdayCode;
        const monthDay = parsed.byMonthDay?.[0];
        if (monthDay) {
            mode = 'date';
            setCustomMonthDay(Math.min(Math.max(monthDay, 1), 31));
        }
        const token = parsed.byDay?.find((day) => /^(-1|1|2|3|4)/.test(String(day)));
        if (token) {
            const match = String(token).match(/^(-1|1|2|3|4)?(SU|MO|TU|WE|TH|FR|SA)$/);
            if (match) {
                mode = 'nth';
                ordinal = (match[1] ?? '1') as '1' | '2' | '3' | '4' | '-1';
                weekday = match[2] as RecurrenceWeekday;
            }
        }
        setCustomInterval(interval);
        setCustomMode(mode);
        setCustomOrdinal(ordinal);
        setCustomWeekday(weekday);
        if (!monthDay) {
            setCustomMonthDay(monthlyAnchorDate.getDate());
        }
        setCustomRecurrenceVisible(true);
    }, [monthlyAnchorDate, monthlyWeekdayCode, recurrenceRRuleValue]);

    const applyCustomRecurrence = useCallback(() => {
        const intervalValue = Number(customInterval);
        const safeInterval = Number.isFinite(intervalValue) && intervalValue > 0 ? intervalValue : 1;
        const safeMonthDay = Math.min(Math.max(Math.round(customMonthDay || 1), 1), 31);
        const rrule = customMode === 'nth'
            ? buildRRuleString('monthly', [`${customOrdinal}${customWeekday}` as RecurrenceByDay], safeInterval)
            : [
                'FREQ=MONTHLY',
                safeInterval > 1 ? `INTERVAL=${safeInterval}` : null,
                `BYMONTHDAY=${safeMonthDay}`,
            ].filter(Boolean).join(';');
        setEditedTask(prev => ({
            ...prev,
            recurrence: {
                rule: 'monthly',
                strategy: recurrenceStrategyValue,
                ...(customMode === 'nth' ? { byDay: [`${customOrdinal}${customWeekday}` as RecurrenceByDay] } : {}),
                rrule,
            },
        }));
        setCustomRecurrenceVisible(false);
    }, [customInterval, customMode, customOrdinal, customWeekday, customMonthDay, recurrenceStrategyValue, setEditedTask]);

    const updateContextInput = useCallback((text: string) => {
        setContextInputDraft(text);
        setEditedTask((prev) => ({ ...prev, contexts: parseTokenList(text, '@') }));
    }, [setEditedTask]);
    const updateTagInput = useCallback((text: string) => {
        setTagInputDraft(text);
        setEditedTask((prev) => ({ ...prev, tags: parseTokenList(text, '#') }));
    }, [setEditedTask]);
    const applyContextSuggestion = useCallback((token: string) => {
        updateContextInput(replaceTrailingToken(contextInputDraft, token));
    }, [contextInputDraft, updateContextInput]);
    const applyTagSuggestion = useCallback((token: string) => {
        updateTagInput(replaceTrailingToken(tagInputDraft, token));
    }, [tagInputDraft, updateTagInput]);
    const toggleQuickContextToken = useCallback((token: string) => {
        const next = new Set(parseTokenList(contextInputDraft, '@'));
        if (next.has(token)) {
            next.delete(token);
        } else {
            next.add(token);
        }
        updateContextInput(Array.from(next).join(', '));
    }, [contextInputDraft, updateContextInput]);
    const toggleQuickTagToken = useCallback((token: string) => {
        const next = new Set(parseTokenList(tagInputDraft, '#'));
        if (next.has(token)) {
            next.delete(token);
        } else {
            next.add(token);
        }
        updateTagInput(Array.from(next).join(', '));
    }, [tagInputDraft, updateTagInput]);
    const commitContextDraft = useCallback(() => {
        setIsContextInputFocused(false);
        updateContextInput(parseTokenList(contextInputDraft, '@').join(', '));
    }, [contextInputDraft, updateContextInput]);
    const commitTagDraft = useCallback(() => {
        setIsTagInputFocused(false);
        updateTagInput(parseTokenList(tagInputDraft, '#').join(', '));
    }, [tagInputDraft, updateTagInput]);

    const discardAndClose = useCallback(() => {
        if (titleDebounceRef.current) {
            clearTimeout(titleDebounceRef.current);
            titleDebounceRef.current = null;
        }
        if (descriptionDebounceRef.current) {
            clearTimeout(descriptionDebounceRef.current);
            descriptionDebounceRef.current = null;
        }
        isDirtyRef.current = false;
        onClose();
    }, [onClose]);

    const hasPendingChanges = useCallback((): boolean => {
        if (!task) return false;

        const baseTask = baseTaskRef.current ?? task;
        const pendingContexts = isContextInputFocused
            ? parseTokenList(contextInputDraft, '@')
            : (editedTask.contexts ?? baseTask.contexts ?? []);
        const pendingTags = isTagInputFocused
            ? parseTokenList(tagInputDraft, '#')
            : (editedTask.tags ?? baseTask.tags ?? []);
        const currentSnapshot: Task = {
            ...baseTask,
            ...editedTask,
            title: String(titleDraftRef.current ?? editedTask.title ?? baseTask.title ?? ''),
            description: String(descriptionDraftRef.current ?? editedTask.description ?? baseTask.description ?? ''),
            contexts: pendingContexts,
            tags: pendingTags,
        };
        const keys = new Set<keyof Task>([
            ...(Object.keys(baseTask) as (keyof Task)[]),
            ...(Object.keys(currentSnapshot) as (keyof Task)[]),
        ]);

        for (const key of keys) {
            if (!areTaskFieldValuesEqual(currentSnapshot[key], baseTask[key])) {
                return true;
            }
        }

        return false;
    }, [contextInputDraft, editedTask, isContextInputFocused, isTagInputFocused, tagInputDraft, task]);

    const handleAttemptClose = useCallback(() => {
        if (!hasPendingChanges()) {
            discardAndClose();
            return;
        }

        Alert.alert(
            t('taskEdit.discardChanges'),
            t('taskEdit.discardChangesDesc'),
            [
                {
                    text: t('common.cancel'),
                    style: 'cancel',
                },
                {
                    text: t('common.discard'),
                    style: 'destructive',
                    onPress: discardAndClose,
                },
                {
                    text: t('common.save'),
                    onPress: () => {
                        void handleSave();
                    },
                },
            ],
            { cancelable: true }
        );
    }, [discardAndClose, handleSave, hasPendingChanges, t]);

    const handleDone = () => {
        void handleSave();
    };

    const setModeTab = useCallback((mode: TaskEditTab) => {
        setEditTab(mode);
    }, []);

    const [containerWidth, setContainerWidth] = useState(getInitialWindowWidth);
    const scrollX = useRef(new Animated.Value(0)).current;
    const scrollRef = useRef<ScrollView | null>(null);
    const [scrollTaskFormToEnd, setScrollTaskFormToEnd] = useState<((targetInput?: number | string) => void) | null>(null);
    const registerScrollTaskFormToEnd = useCallback((handler: ((targetInput?: number | string) => void) | null) => {
        setScrollTaskFormToEnd(() => handler);
    }, []);
    const lastFocusedInputRef = useRef<number | string | undefined>(undefined);

    const scrollToTab = useCallback((mode: TaskEditTab, animated = true) => {
        const node = scrollRef.current as unknown as {
            scrollTo?: (options: { x: number; animated?: boolean }) => void;
            getNode?: () => { scrollTo?: (options: { x: number; animated?: boolean }) => void };
        } | null;
        syncTaskEditPagerPosition({
            mode,
            containerWidth,
            scrollValue: scrollX,
            scrollNode: node,
            animated,
        });
    }, [containerWidth, scrollX]);
    const alignPagerToActiveTab = useCallback(() => {
        if (!visible || !containerWidth) return;
        requestAnimationFrame(() => {
            scrollToTab(editTab, false);
        });
    }, [containerWidth, editTab, scrollToTab, visible]);
    useEffect(() => {
        if (!visible || !containerWidth) return;
        scrollToTab(editTab, false);
    }, [containerWidth, editTab, scrollToTab, task?.id, visible]);

    useEffect(() => {
        if (!visible || !containerWidth) return;
        const alignmentTimer = setTimeout(() => {
            scrollToTab(editTab, false);
        }, 90);
        return () => clearTimeout(alignmentTimer);
    }, [containerWidth, editTab, scrollToTab, task?.id, visible]);

    useEffect(() => {
        if (!visible) return;
        if (typeof Keyboard?.addListener !== 'function') return;
        const handleKeyboardShow = () => {
            alignPagerToActiveTab();
            if (lastFocusedInputRef.current !== undefined) {
                scrollTaskFormToEnd?.(lastFocusedInputRef.current);
            }
        };
        const handleKeyboardHide = () => {
            alignPagerToActiveTab();
        };
        const showListener = Keyboard.addListener('keyboardDidShow', handleKeyboardShow);
        const hideListener = Keyboard.addListener('keyboardDidHide', handleKeyboardHide);
        return () => {
            showListener.remove();
            hideListener.remove();
        };
    }, [alignPagerToActiveTab, scrollTaskFormToEnd, visible]);

    const handleInputFocus = useCallback((targetInput?: number | string) => {
        lastFocusedInputRef.current = targetInput;
        setTimeout(() => {
            scrollTaskFormToEnd?.(targetInput);
        }, 140);
    }, [scrollTaskFormToEnd]);

    const handleTabPress = (mode: TaskEditTab) => {
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
        resetTaskChecklist(task.id).catch((error) => logTaskError('Failed to reset checklist', error));
    };

    const handleDuplicateTask = async () => {
        if (!task) return;
        await duplicateTask(task.id, false).catch((error) => logTaskError('Failed to duplicate task', error));
        Alert.alert(t('taskEdit.duplicateDoneTitle'), t('taskEdit.duplicateDoneBody'));
    };

    const handleDeleteTask = async () => {
        if (!task) return;
        await deleteTask(task.id).catch((error) => logTaskError('Failed to delete task', error));
        onClose();
    };

    const handleConvertToReference = useCallback(() => {
        if (!task) return;
        const referenceUpdate: Partial<Task> = {
            status: 'reference',
            startTime: undefined,
            dueDate: undefined,
            reviewAt: undefined,
            recurrence: undefined,
            priority: undefined,
            timeEstimate: undefined,
            checklist: undefined,
            isFocusedToday: false,
            pushCount: 0,
        };
        onSave(task.id, referenceUpdate);
        setEditedTask((prev) => ({
            ...prev,
            ...referenceUpdate,
        }));
    }, [onSave, setEditedTask, task]);

    const getAIProvider = async () => {
        if (!aiEnabled) {
            Alert.alert(t('ai.disabledTitle'), t('ai.disabledBody'));
            return null;
        }
        const provider = (settings.ai?.provider ?? 'openai') as AIProviderId;
        const apiKey = await loadAIKey(provider);
        if (isAIKeyRequired(settings) && !apiKey) {
            Alert.alert(t('ai.missingKeyTitle'), t('ai.missingKeyBody'));
            return null;
        }
        return createAIProvider(buildAIConfig(settings, apiKey));
    };

    const applyAISuggestion = (suggested: { title?: string; context?: string; timeEstimate?: TimeEstimate }) => {
        if (suggested.title) {
            setTitleImmediate(suggested.title);
        }
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
        const title = String(titleDraftRef.current ?? editedTask.title ?? task.title ?? '').trim();
        if (!title) return;
        setIsAIWorking(true);
        try {
            const provider = await getAIProvider();
            if (!provider) return;
            const contextOptions = Array.from(new Set([
                ...getUsedTaskTokens(tasks, (item) => item.contexts, { prefix: '@' }),
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
                    setTitleImmediate(option.action);
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
            logTaskWarn('AI clarify failed', error);
            Alert.alert(t('ai.errorTitle'), t('ai.errorBody'));
        } finally {
            setIsAIWorking(false);
        }
    };

    const handleAIBreakdown = async () => {
        if (!task || isAIWorking) return;
        const title = String(titleDraftRef.current ?? editedTask.title ?? task.title ?? '').trim();
        if (!title) return;
        setIsAIWorking(true);
        try {
            const provider = await getAIProvider();
            if (!provider) return;
            const response = await provider.breakDownTask({
                title,
                description: String(descriptionDraft ?? ''),
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
            logTaskWarn('AI breakdown failed', error);
            Alert.alert(t('ai.errorTitle'), t('ai.errorBody'));
        } finally {
            setIsAIWorking(false);
        }
    };

    const inputStyle = { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text };
    const combinedText = `${titleDraft ?? ''}\n${descriptionDraft ?? ''}`.trim();
    const resolvedDirection = resolveAutoTextDirection(combinedText, language);
    const textDirectionStyle = {
        writingDirection: resolvedDirection,
        textAlign: resolvedDirection === 'rtl' ? 'right' : 'left',
    } as const;
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean) => ([
        styles.statusText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);
    const getStatusLabel = (status: TaskStatus) => {
        const key = `status.${status}` as const;
        const translated = t(key);
        return translated === key ? status : translated;
    };
    const getQuickTokenChipStyle = (active: boolean) => ([
        styles.quickTokenChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getQuickTokenTextStyle = (active: boolean) => ([
        styles.quickTokenText,
        { color: active ? '#fff' : tc.secondaryText },
    ]);
    const openDatePicker = (mode: NonNullable<typeof showDatePicker>) => {
        Keyboard.dismiss();
        setShowDatePicker(mode);
    };
    const getDatePickerValue = (mode: NonNullable<typeof showDatePicker>) => {
        if (mode === 'start') return getSafePickerDateValue(editedTask.startTime);
        if (mode === 'start-time') return pendingStartDate ?? getSafePickerDateValue(editedTask.startTime);
        if (mode === 'review') return getSafePickerDateValue(editedTask.reviewAt);
        if (mode === 'due-time') return pendingDueDate ?? getSafePickerDateValue(editedTask.dueDate);
        return getSafePickerDateValue(editedTask.dueDate);
    };
    const getDatePickerMode = (mode: NonNullable<typeof showDatePicker>) =>
        mode === 'start-time' || mode === 'due-time' ? 'time' : 'date';
    const renderInlineIOSDatePicker = (targetModes: Array<NonNullable<typeof showDatePicker>>) => {
        if (Platform.OS !== 'ios' || !showDatePicker || !targetModes.includes(showDatePicker)) {
            return null;
        }
        return (
            <View style={{ marginTop: 8 }}>
                <View style={styles.pickerToolbar}>
                    <View style={styles.pickerSpacer} />
                    <Pressable onPress={() => setShowDatePicker(null)} style={styles.pickerDone}>
                        <Text style={styles.pickerDoneText}>{t('common.done')}</Text>
                    </Pressable>
                </View>
                <DateTimePicker
                    value={getDatePickerValue(showDatePicker)}
                    mode={getDatePickerMode(showDatePicker)}
                    display="spinner"
                    onChange={onDateChange}
                />
            </View>
        );
    };

    const renderField = (fieldId: TaskEditorFieldId) => {
        switch (fieldId) {
            case 'status':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.statusLabel')}</Text>
                        <View style={styles.statusContainerCompact}>
                            {availableStatusOptions.map(status => (
                                <TouchableOpacity
                                    key={status}
                                    style={[styles.statusChipCompact, ...getStatusChipStyle(editedTask.status === status)]}
                                    onPress={() => setEditedTask(prev => ({ ...prev, status }))}
                                >
                                    <Text style={getStatusTextStyle(editedTask.status === status)}>
                                        {getStatusLabel(status)}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    </View>
                );
            case 'project':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.projectLabel')}</Text>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => setShowProjectPicker(true)}
                            >
                                <Text style={{ color: tc.text }}>
                                    {projects.find((p) => p.id === editedTask.projectId)?.title || t('taskEdit.noProjectOption')}
                                </Text>
                            </TouchableOpacity>
                            {!!editedTask.projectId && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask(prev => ({ ...prev, projectId: undefined, sectionId: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>
                );
            case 'section': {
                const projectId = editedTask.projectId ?? task?.projectId;
                if (!projectId) return null;
                const section = projectSections.find((item) => item.id === editedTask.sectionId);
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.sectionLabel')}</Text>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => setShowSectionPicker(true)}
                            >
                                <Text style={{ color: tc.text }}>
                                    {section?.title || t('taskEdit.noSectionOption')}
                                </Text>
                            </TouchableOpacity>
                            {!!editedTask.sectionId && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask(prev => ({ ...prev, sectionId: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>
                );
            }
            case 'area':
                if (editedTask.projectId) return null;
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.areaLabel')}</Text>
                        <View style={styles.dateRow}>
                            <TouchableOpacity
                                style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                                onPress={() => setShowAreaPicker(true)}
                            >
                                <Text style={{ color: tc.text }}>
                                    {areas.find((area) => area.id === editedTask.areaId)?.name || t('taskEdit.noAreaOption')}
                                </Text>
                            </TouchableOpacity>
                            {!!editedTask.areaId && (
                                <TouchableOpacity
                                    style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                    onPress={() => setEditedTask(prev => ({ ...prev, areaId: undefined }))}
                                >
                                    <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    </View>
                );
            case 'priority':
                if (!prioritiesEnabled) return null;
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
                            value={contextInputDraft}
                            onChangeText={updateContextInput}
                            onFocus={(event) => {
                                setIsContextInputFocused(true);
                                handleInputFocus(event.nativeEvent.target);
                            }}
                            onBlur={commitContextDraft}
                            onSubmitEditing={() => {
                                commitContextDraft();
                                Keyboard.dismiss();
                            }}
                            returnKeyType="done"
                            blurOnSubmit
                            placeholder={t('taskEdit.contextsPlaceholder')}
                            autoCapitalize="none"
                            placeholderTextColor={tc.secondaryText}
                            accessibilityLabel={t('taskEdit.contextsLabel')}
                            accessibilityHint={t('taskEdit.contextsPlaceholder')}
                        />
                        {contextTokenSuggestions.length > 0 && (
                            <View style={[styles.tokenSuggestionsMenu, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                {contextTokenSuggestions.map((token, index) => (
                                    <TouchableOpacity
                                        key={token}
                                        style={[
                                            styles.tokenSuggestionItem,
                                            index === contextTokenSuggestions.length - 1 ? styles.tokenSuggestionItemLast : null,
                                        ]}
                                        onPress={() => applyContextSuggestion(token)}
                                    >
                                        <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                        {frequentContextSuggestions.length > 0 && (
                            <View style={styles.quickTokensRow}>
                                {frequentContextSuggestions.map((token) => {
                                    const isActive = selectedContextTokens.has(token);
                                    return (
                                        <TouchableOpacity
                                            key={token}
                                            style={getQuickTokenChipStyle(isActive)}
                                            onPress={() => toggleQuickContextToken(token)}
                                        >
                                            <Text style={getQuickTokenTextStyle(isActive)}>{token}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        )}
                    </View>
                );
            case 'tags':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.tagsLabel')}</Text>
                        <TextInput
                            style={[styles.input, inputStyle]}
                            value={tagInputDraft}
                            onChangeText={updateTagInput}
                            onFocus={(event) => {
                                setIsTagInputFocused(true);
                                handleInputFocus(event.nativeEvent.target);
                            }}
                            onBlur={commitTagDraft}
                            onSubmitEditing={() => {
                                commitTagDraft();
                                Keyboard.dismiss();
                            }}
                            returnKeyType="done"
                            blurOnSubmit
                            placeholder={t('taskEdit.tagsPlaceholder')}
                            autoCapitalize="none"
                            placeholderTextColor={tc.secondaryText}
                            accessibilityLabel={t('taskEdit.tagsLabel')}
                            accessibilityHint={t('taskEdit.tagsPlaceholder')}
                        />
                        {tagTokenSuggestions.length > 0 && (
                            <View style={[styles.tokenSuggestionsMenu, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                {tagTokenSuggestions.map((token, index) => (
                                    <TouchableOpacity
                                        key={token}
                                        style={[
                                            styles.tokenSuggestionItem,
                                            index === tagTokenSuggestions.length - 1 ? styles.tokenSuggestionItemLast : null,
                                        ]}
                                        onPress={() => applyTagSuggestion(token)}
                                    >
                                        <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{token}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                        {frequentTagSuggestions.length > 0 && (
                            <View style={styles.quickTokensRow}>
                                {frequentTagSuggestions.map((token) => {
                                    const isActive = selectedTagTokens.has(token);
                                    return (
                                        <TouchableOpacity
                                            key={token}
                                            style={getQuickTokenChipStyle(isActive)}
                                            onPress={() => toggleQuickTagToken(token)}
                                        >
                                            <Text style={getQuickTokenTextStyle(isActive)}>{token}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        )}
                    </View>
                );
            case 'timeEstimate':
                if (!timeEstimatesEnabled) return null;
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
                                    onPress={() => {
                                        if (opt.value !== 'weekly') {
                                            setCustomWeekdays([]);
                                        }
                                        if (opt.value === 'daily') {
                                            const parsed = parseRRuleString(recurrenceRRuleValue);
                                            const interval = parsed.rule === 'daily' && parsed.interval && parsed.interval > 0 ? parsed.interval : 1;
                                            setEditedTask(prev => ({
                                                ...prev,
                                                recurrence: {
                                                    rule: 'daily',
                                                    strategy: recurrenceStrategyValue,
                                                    rrule: buildRRuleString('daily', undefined, interval),
                                                },
                                            }));
                                            return;
                                        }
                                        if (opt.value === 'monthly') {
                                            setEditedTask(prev => ({
                                                ...prev,
                                                recurrence: {
                                                    rule: 'monthly',
                                                    strategy: recurrenceStrategyValue,
                                                    rrule: buildRRuleString('monthly'),
                                                },
                                            }));
                                            return;
                                        }
                                        setEditedTask(prev => ({
                                            ...prev,
                                            recurrence: buildRecurrenceValue(opt.value as RecurrenceRule | '', recurrenceStrategyValue),
                                        }));
                                    }}
                                >
                                    <Text style={getStatusTextStyle(
                                        recurrenceRuleValue === opt.value || (!opt.value && !recurrenceRuleValue)
                                    )}>
                                        {opt.label}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                        {recurrenceRuleValue === 'weekly' && (
                            <View style={[styles.weekdayRow, { marginTop: 10 }]}>
                                {recurrenceWeekdayButtons.map((day) => {
                                    const active = customWeekdays.includes(day.key);
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
                                            onPress={() => {
                                                const next = active
                                                    ? customWeekdays.filter((d) => d !== day.key)
                                                    : [...customWeekdays, day.key];
                                                setCustomWeekdays(next);
                                                setEditedTask(prev => ({
                                                    ...prev,
                                                    recurrence: {
                                                        rule: 'weekly',
                                                        strategy: recurrenceStrategyValue,
                                                        byDay: next,
                                                        rrule: buildRRuleString('weekly', next),
                                                    },
                                                }));
                                            }}
                                        >
                                            <Text style={[styles.weekdayButtonText, { color: tc.text }]}>{day.label}</Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                        )}
                        {recurrenceRuleValue === 'daily' && (
                            <View style={[styles.customRow, { marginTop: 8, borderColor: tc.border }]}>
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.repeatEvery')}</Text>
                                <TextInput
                                    value={String(dailyInterval)}
                                    onChangeText={(value) => {
                                        const parsed = Number.parseInt(value, 10);
                                        const interval = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 365) : 1;
                                        setEditedTask(prev => ({
                                            ...prev,
                                            recurrence: {
                                                rule: 'daily',
                                                strategy: recurrenceStrategyValue,
                                                rrule: buildRRuleString('daily', undefined, interval),
                                            },
                                        }));
                                    }}
                                    keyboardType="number-pad"
                                    style={[styles.customInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                                    accessibilityLabel={t('recurrence.repeatEvery')}
                                    accessibilityHint={t('recurrence.dayUnit')}
                                />
                                <Text style={[styles.modalLabel, { color: tc.secondaryText }]}>{t('recurrence.dayUnit')}</Text>
                            </View>
                        )}
                        {recurrenceRuleValue === 'monthly' && (
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                <TouchableOpacity
                                    style={getStatusChipStyle(monthlyPattern === 'date')}
                                    onPress={() => {
                                        setEditedTask(prev => ({
                                            ...prev,
                                            recurrence: {
                                                rule: 'monthly',
                                                strategy: recurrenceStrategyValue,
                                                rrule: buildRRuleString('monthly'),
                                            },
                                        }));
                                    }}
                                >
                                    <Text style={getStatusTextStyle(monthlyPattern === 'date')}>
                                        {t('recurrence.monthlyOnDay')}
                                    </Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={getStatusChipStyle(monthlyPattern === 'custom')}
                                    onPress={openCustomRecurrence}
                                >
                                    <Text style={getStatusTextStyle(monthlyPattern === 'custom')}>
                                        {t('recurrence.custom')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}
                        {!!recurrenceRuleValue && (
                            <View style={[styles.statusContainer, { marginTop: 8 }]}>
                                <TouchableOpacity
                                    style={getStatusChipStyle(recurrenceStrategyValue === 'fluid')}
                                    onPress={() => {
                                        const nextStrategy: RecurrenceStrategy = recurrenceStrategyValue === 'fluid' ? 'strict' : 'fluid';
                                        setEditedTask(prev => ({
                                            ...prev,
                                            recurrence:
                                                recurrenceRuleValue === 'weekly' && customWeekdays.length > 0
                                                    ? {
                                                        rule: 'weekly',
                                                        strategy: nextStrategy,
                                                        byDay: customWeekdays,
                                                        rrule: buildRRuleString('weekly', customWeekdays),
                                                    }
                                                    : recurrenceRuleValue && recurrenceRRuleValue
                                                        ? { rule: recurrenceRuleValue, strategy: nextStrategy, ...(parseRRuleString(recurrenceRRuleValue).byDay ? { byDay: parseRRuleString(recurrenceRRuleValue).byDay } : {}), rrule: recurrenceRRuleValue }
                                                        : buildRecurrenceValue(recurrenceRuleValue, nextStrategy),
                                        }));
                                    }}
                                >
                                    <Text style={getStatusTextStyle(recurrenceStrategyValue === 'fluid')}>
                                        {t('recurrence.afterCompletion')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}
                    </View>
                );
            case 'startTime':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.startDateLabel')}</Text>
                        {(() => {
                            const parsed = editedTask.startTime ? safeParseDate(editedTask.startTime) : null;
                            const hasTime = hasTimeComponent(editedTask.startTime);
                            const dateOnly = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
                            const timeOnly = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                            return (
                                <View>
                                    <View style={styles.dateRow}>
                                        <TouchableOpacity style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]} onPress={() => openDatePicker('start')}>
                                            <Text style={{ color: tc.text }}>{formatStartDateTime(editedTask.startTime)}</Text>
                                        </TouchableOpacity>
                                        {!!editedTask.startTime && (
                                            <TouchableOpacity
                                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                                onPress={() => openDatePicker('start-time')}
                                            >
                                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>
                                                    {hasTime && timeOnly ? timeOnly : (t('calendar.changeTime') || 'Add time')}
                                                </Text>
                                            </TouchableOpacity>
                                        )}
                                        {!!editedTask.startTime && (
                                            <TouchableOpacity
                                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                                onPress={() => setEditedTask(prev => ({ ...prev, startTime: undefined }))}
                                            >
                                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                            </TouchableOpacity>
                                        )}
                                    </View>
                                    {renderInlineIOSDatePicker(['start', 'start-time'])}
                                </View>
                            );
                        })()}
                    </View>
                );
            case 'dueDate':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.dueDateLabel')}</Text>
                        {(() => {
                            const parsed = editedTask.dueDate ? safeParseDate(editedTask.dueDate) : null;
                            const hasTime = hasTimeComponent(editedTask.dueDate);
                            const dateOnly = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
                            const timeOnly = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                            return (
                                <View>
                                    <View style={styles.dateRow}>
                                        <TouchableOpacity style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]} onPress={() => openDatePicker('due')}>
                                            <Text style={{ color: tc.text }}>{formatDueDate(editedTask.dueDate)}</Text>
                                        </TouchableOpacity>
                                        {!!editedTask.dueDate && (
                                            <TouchableOpacity
                                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                                onPress={() => openDatePicker('due-time')}
                                            >
                                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>
                                                    {hasTime && timeOnly ? timeOnly : (t('calendar.changeTime') || 'Add time')}
                                                </Text>
                                            </TouchableOpacity>
                                        )}
                                        {!!editedTask.dueDate && (
                                            <TouchableOpacity
                                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                                onPress={() => setEditedTask(prev => ({ ...prev, dueDate: undefined }))}
                                            >
                                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                                            </TouchableOpacity>
                                        )}
                                    </View>
                                    {renderInlineIOSDatePicker(['due', 'due-time'])}
                                </View>
                            );
                        })()}
                    </View>
                );
            case 'reviewAt':
                return (
                    <View style={styles.formGroup}>
                        <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.reviewDateLabel')}</Text>
                        <View style={styles.dateRow}>
                            <TouchableOpacity style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]} onPress={() => openDatePicker('review')}>
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
                        {renderInlineIOSDatePicker(['review'])}
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
                                <MarkdownText markdown={descriptionDraft || ''} tc={tc} direction={resolvedDirection} />
                            </View>
                        ) : (
                            <TextInput
                                style={[styles.input, styles.textArea, inputStyle, textDirectionStyle]}
                                value={descriptionDraft}
                                onFocus={(event) => {
                                    handleInputFocus(event.nativeEvent.target);
                                }}
                                onChangeText={(text) => {
                                    setDescriptionDraft(text);
                                    descriptionDraftRef.current = text;
                                    resetCopilotDraft();
                                    if (descriptionDebounceRef.current) {
                                        clearTimeout(descriptionDebounceRef.current);
                                    }
                                    descriptionDebounceRef.current = setTimeout(() => {
                                        setEditedTask(prev => ({ ...prev, description: text }));
                                    }, 250);
                                }}
                                placeholder={t('taskEdit.descriptionPlaceholder')}
                                multiline
                                placeholderTextColor={tc.secondaryText}
                                accessibilityLabel={t('taskEdit.descriptionLabel')}
                                accessibilityHint={t('taskEdit.descriptionPlaceholder')}
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
                                    onPress={() => {
                                        setLinkInputTouched(false);
                                        setLinkModalVisible(true);
                                    }}
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
                                {visibleAttachments.map((attachment) => {
                                    const displayTitle = getAttachmentDisplayTitle(attachment);
                                    const isMissing = attachment.kind === 'file'
                                        && (!attachment.uri || attachment.localStatus === 'missing');
                                    const canDownload = isMissing && Boolean(attachment.cloudKey);
                                    const isDownloading = attachment.localStatus === 'downloading';
                                    return (
                                        <View key={attachment.id} style={[styles.attachmentRow, { borderBottomColor: tc.border }]}>
                                            <TouchableOpacity
                                                style={styles.attachmentTitleWrap}
                                                onPress={() => openAttachment(attachment)}
                                                disabled={isDownloading}
                                            >
                                                <Text style={[styles.attachmentTitle, { color: tc.tint }]} numberOfLines={1}>
                                                    {displayTitle}
                                                </Text>
                                            </TouchableOpacity>
                                            {isDownloading ? (
                                                <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                                    {t('common.loading')}
                                                </Text>
                                            ) : canDownload ? (
                                                <TouchableOpacity onPress={() => downloadAttachment(attachment)}>
                                                    <Text style={[styles.attachmentDownload, { color: tc.tint }]}>
                                                        {t('attachments.download')}
                                                    </Text>
                                                </TouchableOpacity>
                                            ) : isMissing ? (
                                                <Text style={[styles.attachmentStatus, { color: tc.secondaryText }]}>
                                                    {t('attachments.missing')}
                                                </Text>
                                            ) : null}
                                            <TouchableOpacity onPress={() => removeAttachment(attachment.id)}>
                                                <Text style={[styles.attachmentRemove, { color: tc.secondaryText }]}>
                                                    {t('attachments.remove')}
                                                </Text>
                                            </TouchableOpacity>
                                        </View>
                                    );
                                })}
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
                                            textDirectionStyle,
                                            { color: item.isCompleted ? tc.secondaryText : tc.text },
                                            item.isCompleted && styles.completedText,
                                        ]}
                                        value={item.title}
                                        onFocus={(event) => {
                                            handleInputFocus(event.nativeEvent.target);
                                        }}
                                        onChangeText={(text) => {
                                            const newChecklist = (editedTask.checklist || []).map((item, i) =>
                                                i === index ? { ...item, title: text } : item
                                            );
                                            setEditedTask(prev => ({ ...prev, checklist: newChecklist }));
                                        }}
                                        placeholder={t('taskEdit.itemNamePlaceholder')}
                                        placeholderTextColor={tc.secondaryText}
                                        accessibilityLabel={`${t('taskEdit.checklist')} ${index + 1}`}
                                        accessibilityHint={t('taskEdit.itemNamePlaceholder')}
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

    if (!task) return null;

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="pageSheet"
            allowSwipeDismissal
            onRequestClose={handleAttemptClose}
        >
            <SafeAreaView
                style={[styles.container, { backgroundColor: tc.bg }]}
                edges={['top']}
            >
                <TaskEditHeader
                    title={String(titleDraft || editedTask.title || '').trim() || t('taskEdit.title')}
                    onDone={handleDone}
                    onShare={handleShare}
                    onDuplicate={handleDuplicateTask}
                    onDelete={handleDeleteTask}
                    onConvertToReference={handleConvertToReference}
                    showConvertToReference={!isReference}
                />

                <TaskEditTabs
                    editTab={editTab}
                    onTabPress={handleTabPress}
                    scrollX={scrollX}
                    containerWidth={containerWidth}
                />

                <View
                    style={styles.tabContent}
                    onLayout={(event) => {
                        const nextWidth = Math.round(event.nativeEvent.layout.width);
                        if (nextWidth > 0 && nextWidth !== containerWidth) {
                            setContainerWidth(nextWidth);
                        }
                    }}
                >
                    <Animated.ScrollView
                        ref={scrollRef}
                        horizontal
                        pagingEnabled
                        scrollEnabled
                        scrollEventThrottle={16}
                        showsHorizontalScrollIndicator={false}
                        directionalLockEnabled
                        onScroll={Animated.event(
                            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
                            { useNativeDriver: true }
                        )}
                        onMomentumScrollEnd={(event) => {
                            if (!containerWidth) return;
                            const offsetX = event.nativeEvent.contentOffset.x;
                            const target = offsetX >= containerWidth * 0.5 ? 'view' : 'task';
                            setModeTab(target);
                            const targetX = getTaskEditTabOffset(target, containerWidth);
                            if (Math.abs(offsetX - targetX) > 1) {
                                scrollToTab(target, false);
                            }
                        }}
                    >
                        <TaskEditFormTab
                            t={t}
                            tc={tc}
                            styles={styles}
                            inputStyle={inputStyle}
                            editedTask={editedTask}
                            setEditedTask={setEditedTask}
                            aiEnabled={aiEnabled}
                            isAIWorking={isAIWorking}
                            handleAIClarify={handleAIClarify}
                            handleAIBreakdown={handleAIBreakdown}
                            copilotSuggestion={copilotSuggestion}
                            copilotApplied={copilotApplied}
                            applyCopilotSuggestion={applyCopilotSuggestion}
                            copilotContext={copilotContext}
                            copilotEstimate={copilotEstimate}
                            copilotTags={copilotTags}
                            timeEstimatesEnabled={timeEstimatesEnabled}
                            renderField={renderField}
                            basicFields={basicFields}
                            schedulingFields={schedulingFields}
                            organizationFields={organizationFields}
                            detailsFields={detailsFields}
                            sectionOpenDefaults={sectionOpenDefaults}
                            showDatePicker={showDatePicker}
                            pendingStartDate={pendingStartDate}
                            pendingDueDate={pendingDueDate}
                            getSafePickerDateValue={getSafePickerDateValue}
                            onDateChange={onDateChange}
                            containerWidth={containerWidth}
                            textDirectionStyle={textDirectionStyle}
                            titleDraft={titleDraft}
                            onTitleDraftChange={handleTitleDraftChange}
                            registerScrollToEnd={registerScrollTaskFormToEnd}
                            formResetKey={`${task.id}:${visible ? 'open' : 'closed'}`}
                        />
                        <View style={[styles.tabPage, { width: containerWidth || '100%' }]}>
                            <TaskEditViewTab
                                t={t}
                                tc={tc}
                                styles={styles}
                                mergedTask={mergedTask}
                                projects={projects}
                                sections={projectSections}
                                areas={areas}
                                prioritiesEnabled={prioritiesEnabled}
                                timeEstimatesEnabled={timeEstimatesEnabled}
                                formatTimeEstimateLabel={formatTimeEstimateLabel}
                                formatDate={formatDate}
                                formatDueDate={formatDueDate}
                                getRecurrenceRuleValue={getRecurrenceRuleValue}
                                getRecurrenceStrategyValue={getRecurrenceStrategyValue}
                                applyChecklistUpdate={applyChecklistUpdate}
                                visibleAttachments={visibleAttachments}
                                openAttachment={openAttachment}
                                isImageAttachment={isImageAttachment}
                                textDirectionStyle={textDirectionStyle}
                                resolvedDirection={resolvedDirection}
                                nestedScrollEnabled
                                onProjectPress={onProjectNavigate ? handlePreviewProjectPress : undefined}
                                onContextPress={onContextNavigate ? handlePreviewContextPress : undefined}
                                onTagPress={onTagNavigate ? handlePreviewTagPress : undefined}
                            />
                        </View>
                    </Animated.ScrollView>
                </View>

                <TaskEditLinkModal
                    visible={linkModalVisible}
                    t={t}
                    tc={tc}
                    linkInput={linkInput}
                    linkInputTouched={linkInputTouched}
                    onChangeLinkInput={(text) => {
                        setLinkInput(text);
                        setLinkInputTouched(true);
                    }}
                    onBlurLinkInput={() => setLinkInputTouched(true)}
                    onClose={closeLinkModal}
                    onSave={confirmAddLink}
                />
                <TaskEditAudioModal
                    visible={audioModalVisible}
                    t={t}
                    tc={tc}
                    audioTitle={audioAttachment?.title}
                    audioStatus={audioStatus}
                    audioLoading={audioLoading}
                    onTogglePlayback={() => {
                        void toggleAudioPlayback();
                    }}
                    onClose={closeAudioModal}
                />
                <TaskEditImagePreviewModal
                    visible={Boolean(imagePreviewAttachment)}
                    t={t}
                    tc={tc}
                    imagePreviewAttachment={imagePreviewAttachment}
                    onClose={closeImagePreview}
                />
                <Modal
                    visible={customRecurrenceVisible}
                    transparent
                    animationType="fade"
                    onRequestClose={() => setCustomRecurrenceVisible(false)}
                >
                    <Pressable style={styles.overlay} onPress={() => setCustomRecurrenceVisible(false)}>
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
                                <TouchableOpacity
                                    style={styles.modalButton}
                                    onPress={() => setCustomRecurrenceVisible(false)}
                                >
                                    <Text style={[styles.modalButtonText, { color: tc.secondaryText }]}>{t('common.cancel')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.modalButton}
                                    onPress={applyCustomRecurrence}
                                >
                                    <Text style={[styles.modalButtonText, { color: tc.tint }]}>{t('common.save')}</Text>
                                </TouchableOpacity>
                            </View>
                        </Pressable>
                    </Pressable>
                </Modal>

                <TaskEditProjectPicker
                    visible={showProjectPicker}
                    projects={filteredProjectsForPicker}
                    allProjects={projects}
                    tc={tc}
                    t={t}
                    onClose={() => setShowProjectPicker(false)}
                    onSelectProject={(projectId) => {
                        setEditedTask(prev => ({
                            ...prev,
                            projectId,
                            areaId: projectId ? undefined : prev.areaId,
                            sectionId: projectId && prev.projectId === projectId ? prev.sectionId : undefined,
                        }));
                    }}
                    onCreateProject={(title) => addProject(
                        title,
                        DEFAULT_PROJECT_COLOR,
                        projectFilterAreaId ? { areaId: projectFilterAreaId } : undefined
                    )}
                    emptyLabel={projectFilterAreaId ? t('projects.noProjectsInArea') : undefined}
                    noMatchesLabel={t('common.noMatches')}
                />

                <TaskEditSectionPicker
                    visible={showSectionPicker}
                    sections={projectSections}
                    projectId={activeProjectId}
                    tc={tc}
                    t={t}
                    onClose={() => setShowSectionPicker(false)}
                    onSelectSection={(sectionId) => {
                        setEditedTask(prev => ({ ...prev, sectionId }));
                    }}
                    onCreateSection={async (projectId, title) => addSection(projectId, title)}
                />

                <TaskEditAreaPicker
                    visible={showAreaPicker}
                    areas={areas}
                    tc={tc}
                    t={t}
                    onClose={() => setShowAreaPicker(false)}
                    onSelectArea={(areaId) => {
                        setEditedTask(prev => ({ ...prev, areaId, projectId: undefined, sectionId: undefined }));
                    }}
                    onCreateArea={(name) => addArea(name, { color: DEFAULT_PROJECT_COLOR })}
                />

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

type TaskEditModalErrorBoundaryProps = {
    visible: boolean;
    resetKey: string;
    onClose: () => void;
    children: React.ReactNode;
};

type TaskEditModalErrorBoundaryState = {
    hasError: boolean;
};

class TaskEditModalErrorBoundary extends React.Component<TaskEditModalErrorBoundaryProps, TaskEditModalErrorBoundaryState> {
    state: TaskEditModalErrorBoundaryState = { hasError: false };

    static getDerivedStateFromError(): TaskEditModalErrorBoundaryState {
        return { hasError: true };
    }

    componentDidCatch(error: unknown) {
        logTaskError('Task edit modal render failed', error);
    }

    componentDidUpdate(prevProps: TaskEditModalErrorBoundaryProps) {
        if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
            this.setState({ hasError: false });
        }
    }

    render() {
        if (!this.state.hasError) return this.props.children;

        return (
            <Modal
                visible={this.props.visible}
                transparent
                animationType="fade"
                onRequestClose={this.props.onClose}
            >
                <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: 16 }}>
                    <View style={[styles.modalCard, { backgroundColor: '#111827', borderColor: '#334155' }]}>
                        <Text style={[styles.modalTitle, { color: '#F8FAFC' }]}>Something went wrong</Text>
                        <Text style={{ color: '#CBD5E1', marginBottom: 14 }}>The editor encountered an error and was safely closed.</Text>
                        <TouchableOpacity style={styles.modalButton} onPress={this.props.onClose}>
                            <Text style={[styles.modalButtonText, { color: '#93C5FD' }]}>Close</Text>
                        </TouchableOpacity>
                    </View>
                </SafeAreaView>
            </Modal>
        );
    }
}

const areTaskEditModalPropsEqual = (prev: TaskEditModalProps, next: TaskEditModalProps): boolean => (
    prev.visible === next.visible
    && prev.task === next.task
    && prev.onClose === next.onClose
    && prev.onSave === next.onSave
    && prev.onFocusMode === next.onFocusMode
    && prev.defaultTab === next.defaultTab
    && prev.onProjectNavigate === next.onProjectNavigate
    && prev.onContextNavigate === next.onContextNavigate
    && prev.onTagNavigate === next.onTagNavigate
);

const TaskEditModalWithBoundary = (props: TaskEditModalProps) => {
    const resetKey = `${props.visible ? 'open' : 'closed'}:${props.task?.id ?? 'new'}`;
    return (
        <TaskEditModalErrorBoundary
            visible={props.visible}
            resetKey={resetKey}
            onClose={props.onClose}
        >
            <TaskEditModalInner {...props} />
        </TaskEditModalErrorBoundary>
    );
};

export const TaskEditModal = React.memo(TaskEditModalWithBoundary, areTaskEditModalPropsEqual);
TaskEditModal.displayName = 'TaskEditModal';
