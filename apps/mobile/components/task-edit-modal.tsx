import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { View, Modal, ScrollView, Share, Alert, Animated, Keyboard, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
    Task,
    TaskEditorFieldId,
    TaskStatus,
    TimeEstimate,
    useTaskStore,
    createAIProvider,
    generateUUID,
    type AIProviderId,
    type RecurrenceWeekday,
    type RecurrenceByDay,
    buildRRuleString,
    parseRRuleString,
    resolveAutoTextDirection,
    parseQuickAdd,
    DEFAULT_PROJECT_COLOR,
    getLocalizedWeekdayButtons,
    getLocalizedWeekdayLabels,
    getUsedTaskTokens,
} from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../lib/ai-config';
import type { AIResponseAction } from './ai-response-modal';
import { ExpandedMarkdownEditor } from './expanded-markdown-editor';
import { KeyboardAccessoryHost } from './keyboard-accessory-host';
import { styles } from './task-edit/task-edit-modal.styles';
import { TaskEditFieldRenderer } from './task-edit/TaskEditFieldRenderer';
import { useTaskDescriptionEditor } from './task-edit/use-task-description-editor';
import { TaskEditViewTab } from './task-edit/TaskEditViewTab';
import { TaskEditFormTab } from './task-edit/TaskEditFormTab';
import { TaskEditHeader } from './task-edit/TaskEditHeader';
import { TaskEditModalErrorBoundary } from './task-edit/TaskEditModalErrorBoundary';
import { TaskEditOverlayStack } from './task-edit/TaskEditOverlayStack';
import { TaskEditTabs } from './task-edit/TaskEditTabs';
import { areTaskFieldValuesEqual } from './task-edit/task-edit-modal.helpers';
import {
    getRecurrenceRuleValue,
    getRecurrenceStrategyValue,
    buildRecurrenceValue,
} from './task-edit/recurrence-utils';
import { useTaskEditCopilot } from './task-edit/use-task-edit-copilot';
import {
    getInitialWindowWidth,
    getTaskEditTabOffset,
    logTaskError,
    logTaskWarn,
    syncTaskEditPagerPosition,
} from './task-edit/task-edit-modal.utils';
import {
    applyMarkdownChecklistToTask,
    parseTokenList,
    replaceTrailingToken,
} from './task-edit/task-edit-token-utils';
import { useTaskEditAttachments } from './task-edit/use-task-edit-attachments';
import { useTaskEditDates } from './task-edit/use-task-edit-dates';
import { useTaskEditPreview } from './task-edit/use-task-edit-preview';
import {
    type TaskEditTab,
    useTaskEditState,
} from './task-edit/use-task-edit-state';
import { useTaskEditDerivedState } from './task-edit/use-task-edit-derived-state';
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
    const { showToast } = useToast();
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
    const prioritiesEnabled = settings.features?.priorities !== false;
    const timeEstimatesEnabled = settings.features?.timeEstimates !== false;
    const resetCopilotStateRef = useRef<() => void>(() => {});
    const {
        aiModal,
        baseTaskRef,
        contextInputDraft,
        customWeekdays,
        descriptionDebounceRef,
        descriptionDraft,
        descriptionDraftRef,
        editTab,
        editedTask,
        isAIWorking,
        isContextInputFocused,
        isDirtyRef,
        isTagInputFocused,
        pendingDueDate,
        pendingStartDate,
        setAiModal,
        setContextInputDraft,
        setCustomWeekdays,
        setDescriptionDraft,
        setEditTab,
        setEditedTask,
        setIsAIWorking,
        setIsContextInputFocused,
        setIsTagInputFocused,
        setPendingDueDate,
        setPendingStartDate,
        setShowAreaPicker,
        setShowDatePicker,
        setShowDescriptionPreview,
        setShowProjectPicker,
        setShowSectionPicker,
        setTagInputDraft,
        setTitleDraft,
        showAreaPicker,
        showDatePicker,
        showDescriptionPreview,
        showProjectPicker,
        showSectionPicker,
        tagInputDraft,
        titleDebounceRef,
        titleDraft,
        titleDraftRef,
    } = useTaskEditState({
        defaultTab,
        resetCopilotStateRef,
        task,
        tasks,
        visible,
    });
    const recurrenceWeekdayButtons = useMemo(() => getLocalizedWeekdayButtons(language, 'narrow'), [language]);
    const recurrenceWeekdayLabels = useMemo(() => getLocalizedWeekdayLabels(language, 'long'), [language]);
    const aiEnabled = settings.ai?.enabled === true;
    const aiProvider = (settings.ai?.provider ?? 'openai') as AIProviderId;

    const contextOptions = React.useMemo(() => Array.from(new Set([
            ...getUsedTaskTokens(tasks, (item) => item.contexts, { prefix: '@' }),
            ...(editedTask.contexts ?? []),
        ])).filter(Boolean), [editedTask.contexts, tasks]);
    const tagOptions = React.useMemo(() => Array.from(new Set([
            ...getUsedTaskTokens(tasks, (item) => item.tags, { prefix: '#' }),
            ...(editedTask.tags ?? []),
        ])).filter(Boolean), [editedTask.tags, tasks]);
    const {
        handlePreviewContextPress,
        handlePreviewProjectPress,
        handlePreviewTagPress,
        projectContext,
    } = useTaskEditPreview({
        editedProjectId: editedTask.projectId,
        onClose,
        onContextNavigate,
        onProjectNavigate,
        onTagNavigate,
        projectId: task?.projectId,
        projects,
        task,
        tasks,
    });

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
    resetCopilotStateRef.current = resetCopilotState;

    const {
        addFileAttachment,
        addImageAttachment,
        audioAttachment,
        audioLoading,
        audioTranscribing,
        audioTranscriptionError,
        audioModalVisible,
        audioStatus,
        closeAudioModal,
        closeImagePreview,
        closeLinkModal,
        confirmAddLink,
        downloadAttachment,
        imagePreviewAttachment,
        isImageAttachment,
        linkInput,
        linkInputTouched,
        linkModalVisible,
        openAttachment,
        removeAttachment,
        retryAudioTranscription,
        setLinkInput,
        setLinkInputTouched,
        setLinkModalVisible,
        toggleAudioPlayback,
        visibleAttachments,
    } = useTaskEditAttachments({
        editedTask,
        setEditedTask,
        t,
        visible,
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
    const {
        activeProjectId,
        availableStatusOptions,
        basicFields,
        dailyInterval,
        detailsFields,
        filteredProjectsForPicker,
        formatTimeEstimateLabel,
        monthlyAnchorDate,
        monthlyPattern,
        monthlyWeekdayCode,
        organizationFields,
        energyLevelOptions,
        priorityOptions,
        projectFilterAreaId,
        projectSections,
        recurrenceOptions,
        recurrenceRRuleValue,
        recurrenceRuleValue,
        recurrenceStrategyValue,
        schedulingFields,
        sectionOpenDefaults,
        timeEstimateOptions,
    } = useTaskEditDerivedState({
        task,
        editedTask,
        settings,
        projects,
        sections,
        prioritiesEnabled,
        timeEstimatesEnabled,
        contextInputDraft,
        descriptionDraft,
        tagInputDraft,
        visibleAttachmentsLength: visibleAttachments.length,
        t,
    });
    const isReference = (editedTask.status ?? task?.status) === 'reference';

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
            showToast({
                title: t('common.notice'),
                message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
                tone: 'warning',
                durationMs: 4200,
            });
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

    const {
        formatDate,
        formatDueDate,
        getSafePickerDateValue,
        onDateChange,
    } = useTaskEditDates({
        editedTask,
        pendingDueDate,
        pendingStartDate,
        setEditedTask,
        setPendingDueDate,
        setPendingStartDate,
        setShowDatePicker,
        showDatePicker,
        t,
    });

    const mergedTask = useMemo(() => ({
        ...(task ?? {}),
        ...editedTask,
    }), [task, editedTask]);

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
    const [isMarkdownOverlayOpen, setIsMarkdownOverlayOpen] = useState(false);
    const registerScrollTaskFormToEnd = useCallback((handler: ((targetInput?: number | string) => void) | null) => {
        setScrollTaskFormToEnd(() => handler);
    }, []);
    const lastFocusedInputRef = useRef<number | string | undefined>(undefined);
    const pendingScrollTaskFormTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        if (isMarkdownOverlayOpen) return;
        if (!visible || !containerWidth) return;
        requestAnimationFrame(() => {
            scrollToTab(editTab, false);
        });
    }, [containerWidth, editTab, isMarkdownOverlayOpen, scrollToTab, visible]);
    useEffect(() => {
        if (isMarkdownOverlayOpen) return;
        if (!visible || !containerWidth) return;
        scrollToTab(editTab, false);
    }, [containerWidth, editTab, isMarkdownOverlayOpen, scrollToTab, task?.id, visible]);

    useEffect(() => {
        if (isMarkdownOverlayOpen) return;
        if (!visible || !containerWidth) return;
        const alignmentTimer = setTimeout(() => {
            scrollToTab(editTab, false);
        }, 90);
        return () => clearTimeout(alignmentTimer);
    }, [containerWidth, editTab, isMarkdownOverlayOpen, scrollToTab, task?.id, visible]);

    useEffect(() => () => {
        if (pendingScrollTaskFormTimerRef.current) {
            clearTimeout(pendingScrollTaskFormTimerRef.current);
            pendingScrollTaskFormTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (!visible) {
            setIsMarkdownOverlayOpen(false);
        }
    }, [visible]);

    useEffect(() => {
        if (isMarkdownOverlayOpen) return;
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
    }, [alignPagerToActiveTab, isMarkdownOverlayOpen, scrollTaskFormToEnd, visible]);

    const handleInputFocus = useCallback((targetInput?: number | string) => {
        if (pendingScrollTaskFormTimerRef.current) {
            clearTimeout(pendingScrollTaskFormTimerRef.current);
            pendingScrollTaskFormTimerRef.current = null;
        }
        lastFocusedInputRef.current = targetInput;
        if (targetInput === undefined) {
            return;
        }
        pendingScrollTaskFormTimerRef.current = setTimeout(() => {
            scrollTaskFormToEnd?.(targetInput);
            pendingScrollTaskFormTimerRef.current = null;
        }, 140);
    }, [scrollTaskFormToEnd]);

    const descriptionEditor = useTaskDescriptionEditor({
        task,
        descriptionDraft,
        descriptionDraftRef,
        setDescriptionDraft,
        descriptionDebounceRef,
        setEditedTask,
        resetCopilotDraft,
        onMarkdownOverlayVisibilityChange: setIsMarkdownOverlayOpen,
        onInputFocusTracked: handleInputFocus,
    });

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
    const fieldRendererProps = {
        addFileAttachment,
        addImageAttachment,
        applyContextSuggestion,
        applyTagSuggestion,
        areas,
        availableStatusOptions,
        commitContextDraft,
        commitTagDraft,
        contextInputDraft,
        contextTokenSuggestions,
        customWeekdays,
        dailyInterval,
        descriptionDraft,
        descriptionInputRef: descriptionEditor.descriptionInputRef,
        descriptionSelection: descriptionEditor.descriptionSelection,
        setDescriptionSelection: descriptionEditor.setDescriptionSelection,
        descriptionUndoDepth: descriptionEditor.descriptionUndoDepth,
        isDescriptionInputFocused: descriptionEditor.isDescriptionInputFocused,
        setIsDescriptionInputFocused: descriptionEditor.setIsDescriptionInputFocused,
        handleDescriptionChange: descriptionEditor.handleDescriptionChange,
        handleDescriptionUndo: descriptionEditor.handleDescriptionUndo,
        handleDescriptionApplyAction: descriptionEditor.handleDescriptionApplyAction,
        openDescriptionExpandedEditor: descriptionEditor.openDescriptionExpandedEditor,
        downloadAttachment,
        editedTask,
        formatDate,
        formatDueDate,
        frequentContextSuggestions,
        frequentTagSuggestions,
        getSafePickerDateValue,
        handleInputFocus,
        handleResetChecklist,
        language,
        monthlyPattern,
        onDateChange,
        openAttachment,
        openCustomRecurrence,
        pendingDueDate,
        pendingStartDate,
        prioritiesEnabled,
        energyLevelOptions,
        priorityOptions,
        projects,
        projectSections,
        recurrenceOptions,
        recurrenceRRuleValue,
        recurrenceRuleValue,
        recurrenceStrategyValue,
        recurrenceWeekdayButtons,
        removeAttachment,
        selectedContextTokens,
        selectedTagTokens,
        setCustomWeekdays,
        setEditedTask,
        setIsContextInputFocused,
        setIsTagInputFocused,
        setLinkInputTouched,
        setLinkModalVisible,
        setShowAreaPicker,
        setShowDatePicker,
        setShowDescriptionPreview,
        setShowProjectPicker,
        setShowSectionPicker,
        showDatePicker,
        showDescriptionPreview,
        styles,
        tagInputDraft,
        tagTokenSuggestions,
        task,
        t,
        tc,
        timeEstimateOptions,
        timeEstimatesEnabled,
        titleDraft,
        toggleQuickContextToken,
        toggleQuickTagToken,
        updateContextInput,
        updateTagInput,
        visibleAttachments,
    };
    const renderField = (fieldId: TaskEditorFieldId) => (
        <TaskEditFieldRenderer fieldId={fieldId} {...fieldRendererProps} />
    );

    if (!task) return null;

    return (
        <>
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
            allowSwipeDismissal
            onRequestClose={handleAttemptClose}
        >
            <KeyboardAccessoryHost>
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
                            scrollEnabled={!isMarkdownOverlayOpen}
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
                                suspendKeyboardHandling={isMarkdownOverlayOpen}
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

                    <TaskEditOverlayStack
                        aiModal={aiModal}
                        addArea={addArea}
                        addProject={addProject}
                        addSection={addSection}
                        applyCustomRecurrence={applyCustomRecurrence}
                        areas={areas}
                        audioAttachment={audioAttachment}
                        audioLoading={audioLoading}
                        audioTranscribing={audioTranscribing}
                        audioTranscriptionError={audioTranscriptionError}
                        audioModalVisible={audioModalVisible}
                        audioStatus={audioStatus}
                        closeAIModal={closeAIModal}
                        closeAudioModal={closeAudioModal}
                        closeImagePreview={closeImagePreview}
                        closeLinkModal={closeLinkModal}
                        confirmAddLink={confirmAddLink}
                        customInterval={customInterval}
                        customMode={customMode}
                        customMonthDay={customMonthDay}
                        customOrdinal={customOrdinal}
                        customRecurrenceVisible={customRecurrenceVisible}
                        customWeekday={customWeekday}
                        filteredProjectsForPicker={filteredProjectsForPicker}
                        imagePreviewAttachment={imagePreviewAttachment}
                        linkInput={linkInput}
                        linkInputTouched={linkInputTouched}
                        linkModalVisible={linkModalVisible}
                        projectFilterAreaId={projectFilterAreaId}
                        projects={projects}
                        recurrenceWeekdayButtons={recurrenceWeekdayButtons}
                        recurrenceWeekdayLabels={recurrenceWeekdayLabels}
                        sectionPickerProjectId={activeProjectId}
                        sectionPickerSections={projectSections}
                        setCustomInterval={setCustomInterval}
                        setCustomMode={setCustomMode}
                        setCustomMonthDay={setCustomMonthDay}
                        setCustomOrdinal={setCustomOrdinal}
                        setCustomRecurrenceVisible={setCustomRecurrenceVisible}
                        setCustomWeekday={setCustomWeekday}
                        setEditedTask={setEditedTask}
                        setLinkInput={setLinkInput}
                        setLinkInputTouched={setLinkInputTouched}
                        setShowAreaPicker={setShowAreaPicker}
                        setShowProjectPicker={setShowProjectPicker}
                        setShowSectionPicker={setShowSectionPicker}
                        showAreaPicker={showAreaPicker}
                        showProjectPicker={showProjectPicker}
                        showSectionPicker={showSectionPicker}
                        styles={styles}
                        t={t}
                        tc={tc}
                        retryAudioTranscription={retryAudioTranscription}
                        toggleAudioPlayback={toggleAudioPlayback}
                        DEFAULT_PROJECT_COLOR={DEFAULT_PROJECT_COLOR}
                    />
                </SafeAreaView>
            </KeyboardAccessoryHost>
        </Modal>
        {visible ? (
            <ExpandedMarkdownEditor
                isOpen={descriptionEditor.descriptionExpanded}
                onClose={descriptionEditor.closeDescriptionExpandedEditor}
                value={descriptionDraft}
                onChange={descriptionEditor.handleDescriptionChange}
                title={t('taskEdit.descriptionLabel')}
                headerTitle={titleDraft.trim() || task?.title?.trim() || t('taskEdit.descriptionLabel')}
                placeholder={t('taskEdit.descriptionPlaceholder')}
                t={t}
                initialMode="edit"
                direction={resolvedDirection}
                selection={descriptionEditor.descriptionSelection}
                onSelectionChange={descriptionEditor.setDescriptionSelection}
                canUndo={descriptionEditor.descriptionUndoDepth > 0}
                onUndo={descriptionEditor.handleDescriptionUndo}
                onApplyAction={descriptionEditor.handleDescriptionApplyAction}
            />
        ) : null}
        </>
    );
}

const areTaskEditModalPropsEqual = (prev: TaskEditModalProps, next: TaskEditModalProps): boolean => (
    prev.visible === next.visible && prev.task === next.task && prev.onClose === next.onClose && prev.onSave === next.onSave
    && prev.onFocusMode === next.onFocusMode && prev.defaultTab === next.defaultTab
    && prev.onProjectNavigate === next.onProjectNavigate && prev.onContextNavigate === next.onContextNavigate && prev.onTagNavigate === next.onTagNavigate
);

const TaskEditModalWithBoundary = (props: TaskEditModalProps) => {
    const { t } = useLanguage();
    const tc = useThemeColors();
    return <TaskEditModalErrorBoundary onClose={props.onClose} taskId={props.task?.id} t={t} tc={tc}><TaskEditModalInner {...props} /></TaskEditModalErrorBoundary>;
};

export const TaskEditModal = React.memo(TaskEditModalWithBoundary, areTaskEditModalPropsEqual);
