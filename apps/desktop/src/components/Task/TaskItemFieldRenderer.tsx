import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
    applyMarkdownKeyboardShortcut,
    applyMarkdownPairInsertion,
    applyMarkdownToolbarAction,
    applyMarkdownUrlPaste,
    buildRRuleString,
    continueMarkdownOnEnter,
    computeRelativeStartTime,
    getProjectedRecurringTaskCalendarDate,
    getRecurrenceCompletedOccurrencesValue,
    getTaskDateCoherenceIssues,
    hasTimeComponent,
    isMarkdownEditorAssistEnabled,
    parseRRuleString,
    REPEAT_REMINDER_INTERVAL_OPTIONS,
    resolveAutoTextDirection,
    safeFormatDate,
    safeParseDate,
    tFallback,
    useTaskStore,
    type Attachment,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
    type RecurrenceByDay,
    type Recurrence,
    type RecurrenceRule,
    type RecurrenceStrategy,
    type Task,
    type TaskDraft,
    type TaskDraftSetter,
    type TaskEditorFieldId,
    type TaskEnergyLevel,
    type TaskPriority,
    type TaskStatus,
    type TimeEstimate,
} from '@mindwtr/core';
import { joinDateTime, splitDateTime } from '@mindwtr/core/date-draft';
import { remove } from '@tauri-apps/plugin-fs';

import { useMarkdownReferenceAutocomplete } from '../MarkdownReferenceAutocomplete';
import { DateField } from '../ui/DateField';
import { AttachmentsField } from './TaskForm/AttachmentsField';
import { ChecklistField } from './TaskForm/ChecklistField';
import { normalizeDateInputValue } from './task-item-helpers';
import { QUICK_ADD_FIELD_TOKENS, taskEditorLabelClassName } from './task-editor-label';
import { DescriptionField } from './fields/DescriptionField';
import { RecurrenceField } from './fields/RecurrenceField';
import {
    AssignedToField,
    ContextsField,
    EnergyLevelField,
    PriorityField,
    StatusField,
    TagsField,
    TimeEstimateField,
    TimeSpentField,
} from './fields/TaskMetadataFields';
import {
    captureScrollSnapshot,
    focusElementWithoutScroll,
    keepTextareaSelectionVisible,
    restoreScrollSnapshotSoon,
} from '../../lib/scroll-preservation';
import { logWarn } from '../../lib/app-log';
import { startAudioCapture, type AudioCaptureSession } from '../../lib/audio-capture';
import { processAudioCapture, resolveSpeechCapture } from '../../lib/speech-to-text';

type DescriptionAudioState = 'idle' | 'recording' | 'transcribing';

const isRangeSelection = (selection: MarkdownSelection | null | undefined): selection is MarkdownSelection => (
    selection != null && selection.start !== selection.end
);

const getPairInsertionSelection = (
    currentValue: string,
    eventSelection: MarkdownSelection,
    pairSnapshot: { value: string; selection: MarkdownSelection } | null | undefined,
    fallbackSelection: MarkdownSelection | null | undefined,
): MarkdownSelection => {
    if (eventSelection.start !== eventSelection.end) {
        return eventSelection;
    }
    if (pairSnapshot?.value === currentValue && isRangeSelection(pairSnapshot.selection)) {
        return pairSnapshot.selection;
    }
    if (isRangeSelection(fallbackSelection)) {
        return fallbackSelection;
    }
    return eventSelection;
};

export type MonthlyRecurrenceInfo = {
    pattern: 'date' | 'custom';
    interval: number;
};

/** Locale- and settings-derived facts the field editors render against. */
export type TaskEditorEnv = {
    t: (key: string) => string;
    language: string;
    dateFormatSetting?: string | null;
    nativeDateInputLocale: string;
    defaultScheduleTime: string;
    timeSpentEnabled: boolean;
    showObsidianNoteAttachment: boolean;
};

/** Token/person option lists (lazily loaded by useTaskItemProjectContext). */
export type TaskEditorOptionLists = {
    allContextOptions: string[];
    allTagOptions: string[];
    popularContextOptions: string[];
    popularTagOptions: string[];
    assignedToOptions: string[];
};

/** The slice of useTaskItemAttachments the attachments field consumes. */
export type TaskEditorAttachments = {
    attachmentError: string | null;
    visibleEditAttachments: Attachment[];
    addFileAttachment: () => void;
    addLinkAttachment: () => void;
    addObsidianNoteAttachment: () => void;
    editLinkAttachment: (attachment: Attachment) => void;
    openAttachment: (attachment: Attachment) => void;
    removeAttachment: (id: string) => void;
};

export type TaskEditorDescriptionPreview = {
    visible: boolean;
    toggle: () => void;
    editSource: () => void;
};

export type TaskEditorActions = {
    openCustomRecurrence: () => void;
    createAssignedToPerson: (name: string) => void | Promise<void>;
    requestBackdatedComplete?: () => void;
    updateTask: (taskId: string, updates: Partial<Task>) => void;
    resetTaskChecklist: (taskId: string) => void;
};

type TaskItemFieldRendererProps = {
    fieldId: TaskEditorFieldId;
    task: Task;
    draft: TaskDraft;
    setField: TaskDraftSetter;
    monthlyRecurrence: MonthlyRecurrenceInfo;
    descriptionPreview: TaskEditorDescriptionPreview;
    env: TaskEditorEnv;
    options: TaskEditorOptionLists;
    attachments: TaskEditorAttachments;
    actions: TaskEditorActions;
};

export function TaskItemFieldRenderer({
    fieldId,
    task,
    draft,
    setField,
    monthlyRecurrence,
    descriptionPreview,
    env,
    options,
    attachments,
    actions,
}: TaskItemFieldRendererProps) {
    const {
        t,
        language,
        dateFormatSetting,
        nativeDateInputLocale,
        defaultScheduleTime,
        timeSpentEnabled,
        showObsidianNoteAttachment,
    } = env;
    const {
        allContextOptions,
        allTagOptions,
        popularContextOptions,
        popularTagOptions,
        assignedToOptions,
    } = options;
    const {
        attachmentError,
        visibleEditAttachments,
        addFileAttachment,
        addLinkAttachment,
        addObsidianNoteAttachment,
        editLinkAttachment,
        openAttachment,
        removeAttachment,
    } = attachments;
    const {
        openCustomRecurrence,
        createAssignedToPerson,
        requestBackdatedComplete,
        updateTask,
        resetTaskChecklist,
    } = actions;
    const taskId = task.id;
    const showDescriptionPreview = descriptionPreview.visible;
    const toggleDescriptionPreview = descriptionPreview.toggle;
    const editDescriptionFromPreview = descriptionPreview.editSource;
    // Draft values and their setField bindings, under the names the field
    // editors below were written against.
    const {
        description: editDescription,
        startTime: editStartTime,
        relativeStartOffset: editRelativeStartOffset,
        dueDate: editDueDate,
        reviewAt: editReviewAt,
        repeatReminderMinutes: editRepeatReminderMinutes,
        suppressMindwtrReminders: editSuppressMindwtrReminders,
        status: editStatus,
        priority: editPriority,
        energyLevel: editEnergyLevel,
        assignedTo: editAssignedTo,
        recurrence: editRecurrence,
        recurrenceStrategy: editRecurrenceStrategy,
        recurrenceRRule: editRecurrenceRRule,
        showFutureRecurrence: editShowFutureRecurrence,
        timeEstimate: editTimeEstimate,
        timeSpentMinutes: editTimeSpentMinutes,
        contexts: editContexts,
        tags: editTags,
        location: editLocation,
    } = draft;
    const setEditDescription = (value: string) => setField('description', value);
    const setEditStartTime = (value: string) => setField('startTime', value);
    const setEditRelativeStartOffset = (value: Task['relativeStartOffset']) => setField('relativeStartOffset', value);
    const setEditDueDate = (value: string) => setField('dueDate', value);
    const setEditReviewAt = (value: string) => setField('reviewAt', value);
    const setEditRepeatReminderMinutes = (value: number | undefined) => setField('repeatReminderMinutes', value);
    const setEditSuppressMindwtrReminders = (value: boolean) => setField('suppressMindwtrReminders', value);
    const setEditStatus = (value: TaskStatus) => setField('status', value);
    const setEditPriority = (value: TaskPriority | '') => setField('priority', value);
    const setEditEnergyLevel = (value: NonNullable<TaskEnergyLevel> | '') => setField('energyLevel', value);
    const setEditAssignedTo = (value: string) => setField('assignedTo', value);
    const setEditRecurrence = (value: RecurrenceRule | '') => setField('recurrence', value);
    const setEditRecurrenceStrategy = (value: RecurrenceStrategy) => setField('recurrenceStrategy', value);
    const setEditRecurrenceRRule = (value: string) => setField('recurrenceRRule', value);
    const setEditShowFutureRecurrence = (value: boolean) => setField('showFutureRecurrence', value);
    const setEditTimeEstimate = (value: TimeEstimate | '') => setField('timeEstimate', value);
    const setEditTimeSpentMinutes = (value: number | undefined) => setField('timeSpentMinutes', value);
    const setEditContexts = (value: string) => setField('contexts', value);
    const setEditTags = (value: string) => setField('tags', value);
    const setEditLocation = (value: string) => setField('location', value);

    const markdownEditorAssist = useTaskStore((state) => isMarkdownEditorAssistEnabled(state.settings));

    const [remindersExpanded, setRemindersExpanded] = useState(false);
    const [descriptionExpanded, setDescriptionExpanded] = useState(false);
    const descriptionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const lastDescriptionPairSelectionRef = useRef<{ value: string; selection: MarkdownSelection } | null>(null);
    const descriptionSelectionRef = useRef<MarkdownSelection>({
        start: editDescription.length,
        end: editDescription.length,
    });
    const descriptionUndoRef = useRef<Array<{ value: string; selection: MarkdownSelection }>>([]);
    const [descriptionUndoDepth, setDescriptionUndoDepth] = useState(0);
    const [descriptionAudioState, setDescriptionAudioState] = useState<DescriptionAudioState>('idle');
    const [descriptionAudioError, setDescriptionAudioError] = useState<string | null>(null);
    const descriptionAudioStateRef = useRef<DescriptionAudioState>('idle');
    const descriptionCaptureRef = useRef<AudioCaptureSession | null>(null);
    useEffect(() => {
        descriptionAudioStateRef.current = descriptionAudioState;
    }, [descriptionAudioState]);
    useEffect(() => () => {
        const session = descriptionCaptureRef.current;
        descriptionCaptureRef.current = null;
        if (descriptionAudioStateRef.current !== 'recording' || !session) return;
        void session.cancel();
    }, []);
    useEffect(() => {
        descriptionSelectionRef.current = {
            start: editDescription.length,
            end: editDescription.length,
        };
        lastDescriptionPairSelectionRef.current = null;
        descriptionUndoRef.current = [];
        setDescriptionUndoDepth(0);
        setDescriptionAudioError(null);
    }, [taskId]);
    const parsedRecurrenceRRule = parseRRuleString(editRecurrenceRRule);
    const recurrenceEndMode: 'never' | 'until' | 'count' = parsedRecurrenceRRule.count
        ? 'count'
        : parsedRecurrenceRRule.until
            ? 'until'
            : 'never';
    const recurrenceDefaultEndDate = parsedRecurrenceRRule.until
        || safeFormatDate(
            safeParseDate(editDueDate || editStartTime || task.dueDate || task.startTime) ?? new Date(),
            'yyyy-MM-dd'
        );
    const buildRecurrenceRRule = (
        rule: RecurrenceRule,
        overrides: {
            byDay?: RecurrenceByDay[];
            interval?: number;
            byMonthDay?: number[];
            count?: number;
            until?: string;
        } = {}
    ) => {
        const hasOverride = <TKey extends keyof typeof overrides>(key: TKey) =>
            Object.prototype.hasOwnProperty.call(overrides, key);
        return buildRRuleString(
            rule,
            hasOverride('byDay') ? overrides.byDay : parsedRecurrenceRRule.byDay,
            hasOverride('interval') ? overrides.interval : parsedRecurrenceRRule.interval,
            {
                byMonthDay: hasOverride('byMonthDay') ? overrides.byMonthDay : parsedRecurrenceRRule.byMonthDay,
                count: hasOverride('count') ? overrides.count : parsedRecurrenceRRule.count,
                until: hasOverride('until') ? overrides.until : parsedRecurrenceRRule.until,
            }
        );
    };
    const recurrencePreviewValue: Recurrence | undefined = editRecurrence
        ? { rule: editRecurrence, strategy: editRecurrenceStrategy }
        : undefined;
    if (recurrencePreviewValue && editRecurrenceRRule) {
        if (parsedRecurrenceRRule.byDay && parsedRecurrenceRRule.byDay.length > 0) {
            recurrencePreviewValue.byDay = parsedRecurrenceRRule.byDay;
        }
        if (parsedRecurrenceRRule.byMonthDay && parsedRecurrenceRRule.byMonthDay.length > 0) {
            recurrencePreviewValue.byMonthDay = parsedRecurrenceRRule.byMonthDay;
        }
        if (parsedRecurrenceRRule.count) {
            recurrencePreviewValue.count = parsedRecurrenceRRule.count;
        }
        if (parsedRecurrenceRRule.until) {
            recurrencePreviewValue.until = parsedRecurrenceRRule.until;
        }
        const completedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence);
        if (typeof completedOccurrences === 'number') {
            recurrencePreviewValue.completedOccurrences = completedOccurrences;
        }
        recurrencePreviewValue.rrule = editRecurrenceRRule;
    }
    const projectedRecurrenceDateLabel = recurrencePreviewValue
        ? safeFormatDate(getProjectedRecurringTaskCalendarDate({
            ...task,
            startTime: editStartTime || undefined,
            dueDate: editDueDate || undefined,
            recurrence: recurrencePreviewValue,
            showFutureRecurrence: true,
        }), 'PP')
        : '';

    const resolvedDirection = resolveAutoTextDirection([task.title, editDescription].filter(Boolean).join(' '), language);
    const isRtl = resolvedDirection === 'rtl';
    const pushDescriptionUndoEntry = (value: string, selection: MarkdownSelection) => {
        const previousEntry = descriptionUndoRef.current[descriptionUndoRef.current.length - 1];
        if (
            previousEntry
            && previousEntry.value === value
            && previousEntry.selection.start === selection.start
            && previousEntry.selection.end === selection.end
        ) {
            return;
        }
        const nextUndoEntries = [...descriptionUndoRef.current, { value, selection }];
        descriptionUndoRef.current = nextUndoEntries.length > 100
            ? nextUndoEntries.slice(nextUndoEntries.length - 100)
            : nextUndoEntries;
        setDescriptionUndoDepth(descriptionUndoRef.current.length);
    };
    const applyDescriptionValue = (
        value: string,
        options?: {
            nextSelection?: MarkdownSelection;
            recordUndo?: boolean;
            baseSelection?: MarkdownSelection;
        },
    ) => {
        if ((options?.recordUndo ?? true) && value !== editDescription) {
            pushDescriptionUndoEntry(editDescription, options?.baseSelection ?? descriptionSelectionRef.current);
        }
        setEditDescription(value);
        if (options?.nextSelection) {
            descriptionSelectionRef.current = options.nextSelection;
        } else {
            lastDescriptionPairSelectionRef.current = null;
        }
    };
    const restoreDescriptionTextareaSelection = (
        textarea: HTMLTextAreaElement,
        selection: MarkdownSelection,
    ) => {
        requestAnimationFrame(() => {
            const target = textarea.isConnected ? textarea : descriptionTextareaRef.current;
            if (!target) return;
            const scrollSnapshot = captureScrollSnapshot(target);
            const surroundingScrollSnapshot = scrollSnapshot.filter(
                (snapshot) => snapshot.kind === 'window' || snapshot.target !== target,
            );
            focusElementWithoutScroll(target, scrollSnapshot);
            target.setSelectionRange(selection.start, selection.end);
            keepTextareaSelectionVisible(target);
            restoreScrollSnapshotSoon(surroundingScrollSnapshot);
        });
    };
    const handleDescriptionUndo = () => {
        const previousEntry = descriptionUndoRef.current[descriptionUndoRef.current.length - 1];
        if (!previousEntry) return undefined;
        descriptionUndoRef.current = descriptionUndoRef.current.slice(0, -1);
        setDescriptionUndoDepth(descriptionUndoRef.current.length);
        applyDescriptionValue(previousEntry.value, {
            nextSelection: previousEntry.selection,
            recordUndo: false,
        });
        return previousEntry.selection;
    };
    const handleDescriptionApplyAction = (actionId: MarkdownToolbarActionId, selection: MarkdownSelection): MarkdownToolbarResult => {
        const next = applyMarkdownToolbarAction(editDescription, selection, actionId);
        applyDescriptionValue(next.value, {
            baseSelection: selection,
            nextSelection: next.selection,
        });
        return next;
    };
    const descriptionAutocomplete = useMarkdownReferenceAutocomplete({
        currentTaskId: taskId,
        value: editDescription,
        selection: descriptionSelectionRef.current,
        textareaRef: descriptionTextareaRef,
        onApplyResult: (next) => {
            lastDescriptionPairSelectionRef.current = null;
            applyDescriptionValue(next.value, {
                baseSelection: descriptionSelectionRef.current,
                nextSelection: next.selection,
            });
            descriptionSelectionRef.current = next.selection;
        },
    });
    const handleDescriptionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (descriptionAutocomplete.handleKeyDown(event)) {
            return;
        }
        const eventTextarea = event.currentTarget;
        const currentValue = event.currentTarget.value;
        const selection = {
            start: event.currentTarget.selectionStart ?? currentValue.length,
            end: event.currentTarget.selectionEnd ?? currentValue.length,
        };
        const applyDescriptionKeyboardResult = (
            next: MarkdownToolbarResult,
            baseSelection = selection,
            rememberPairRange = false,
        ) => {
            applyDescriptionValue(next.value, {
                baseSelection,
                nextSelection: next.selection,
            });
            descriptionSelectionRef.current = next.selection;
            lastDescriptionPairSelectionRef.current = rememberPairRange && isRangeSelection(next.selection)
                ? { value: next.value, selection: next.selection }
                : null;
            restoreDescriptionTextareaSelection(eventTextarea, next.selection);
        };
        const lowerKey = event.key.toLowerCase();
        if ((event.metaKey || event.ctrlKey) && !event.altKey) {
            if (lowerKey === 'b' || lowerKey === 'i') {
                const next = applyMarkdownKeyboardShortcut(currentValue, selection, {
                    key: event.key,
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                });
                if (!next) return;
                event.preventDefault();
                applyDescriptionKeyboardResult(next);
                return;
            }
            if (lowerKey !== 'z') return;
            if (descriptionUndoRef.current.length === 0) return;
            event.preventDefault();
            const restoredSelection = handleDescriptionUndo();
            if (restoredSelection) {
                restoreDescriptionTextareaSelection(eventTextarea, restoredSelection);
            }
            return;
        }

        const isPairInsertionKey = !event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1;
        if (!isPairInsertionKey && event.key !== 'Tab') {
            lastDescriptionPairSelectionRef.current = null;
        }
        if (event.key === 'Tab' || isPairInsertionKey) {
            const pairSelection = isPairInsertionKey
                ? getPairInsertionSelection(currentValue, selection, lastDescriptionPairSelectionRef.current, descriptionSelectionRef.current)
                : selection;
            const next = event.key === 'Tab'
                ? applyMarkdownKeyboardShortcut(currentValue, selection, {
                    key: event.key,
                    shiftKey: event.shiftKey,
                })
                : applyMarkdownPairInsertion(
                    currentValue,
                    `${currentValue.slice(0, pairSelection.start)}${event.key}${currentValue.slice(pairSelection.end)}`,
                    pairSelection,
                    { assist: markdownEditorAssist },
                );
            if (!next) return;
            event.preventDefault();
            applyDescriptionKeyboardResult(next, pairSelection, isPairInsertionKey);
            return;
        }

        if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
        const next = continueMarkdownOnEnter(currentValue, selection, { assist: markdownEditorAssist });
        if (!next) return;

        event.preventDefault();
        lastDescriptionPairSelectionRef.current = null;
        applyDescriptionKeyboardResult(next);
    };
    const handleDescriptionPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const pastedText = event.clipboardData.getData('text/plain');
        if (!pastedText) return;
        const eventTextarea = event.currentTarget;
        const currentValue = event.currentTarget.value;
        const selection = {
            start: event.currentTarget.selectionStart ?? currentValue.length,
            end: event.currentTarget.selectionEnd ?? currentValue.length,
        };
        const next = applyMarkdownUrlPaste(
            currentValue,
            `${currentValue.slice(0, selection.start)}${pastedText}${currentValue.slice(selection.end)}`,
            selection,
            { assist: markdownEditorAssist },
        );
        if (!next) return;
        event.preventDefault();
        lastDescriptionPairSelectionRef.current = null;
        applyDescriptionValue(next.value, {
            baseSelection: selection,
            nextSelection: next.selection,
        });
        descriptionSelectionRef.current = next.selection;
        restoreDescriptionTextareaSelection(eventTextarea, next.selection);
    };
    const handleDescriptionInput = (
        value: string,
        selection: MarkdownSelection,
        source: HTMLTextAreaElement,
    ) => {
        const previousSelection = descriptionSelectionRef.current;
        const pairedInsertion = applyMarkdownPairInsertion(editDescription, value, previousSelection, { assist: markdownEditorAssist });
        if (pairedInsertion) {
            applyDescriptionValue(pairedInsertion.value, {
                baseSelection: previousSelection,
                nextSelection: pairedInsertion.selection,
            });
            descriptionSelectionRef.current = pairedInsertion.selection;
            lastDescriptionPairSelectionRef.current = isRangeSelection(pairedInsertion.selection)
                ? { value: pairedInsertion.value, selection: pairedInsertion.selection }
                : null;
            restoreDescriptionTextareaSelection(source, pairedInsertion.selection);
            return;
        }

        lastDescriptionPairSelectionRef.current = null;
        applyDescriptionValue(value);
        descriptionSelectionRef.current = selection;
    };
    const insertDescriptionTranscript = useCallback((transcript: string) => {
        const trimmedTranscript = transcript.trim();
        if (!trimmedTranscript) return;

        const currentValue = editDescription;
        const rawSelection = descriptionSelectionRef.current;
        const start = Math.max(0, Math.min(rawSelection.start, currentValue.length));
        const end = Math.max(start, Math.min(rawSelection.end, currentValue.length));
        const before = currentValue.slice(0, start);
        const after = currentValue.slice(end);
        const prefix = before.length > 0 && !/\s$/.test(before) ? '\n' : '';
        const suffix = after.length > 0 && !/^\s/.test(after) ? '\n' : '';
        const insertion = `${prefix}${trimmedTranscript}${suffix}`;
        const nextValue = `${before}${insertion}${after}`;
        const nextCursor = before.length + insertion.length;
        const nextSelection = { start: nextCursor, end: nextCursor };

        lastDescriptionPairSelectionRef.current = null;
        applyDescriptionValue(nextValue, {
            baseSelection: rawSelection,
            nextSelection,
        });
        descriptionSelectionRef.current = nextSelection;

        const textarea = descriptionTextareaRef.current;
        if (textarea) restoreDescriptionTextareaSelection(textarea, nextSelection);
    }, [editDescription]);
    const handleDescriptionAudioInput = useCallback(async () => {
        if (descriptionAudioState === 'transcribing') return;

        if (descriptionAudioState !== 'recording') {
            setDescriptionAudioError(null);
            try {
                descriptionCaptureRef.current = await startAudioCapture({
                    defaultName: () => 'description-audio.wav',
                });
                setDescriptionAudioState('recording');
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                setDescriptionAudioError(message || tFallback(t, 'quickAdd.audioErrorBody', 'Could not start audio recording.'));
            }
            return;
        }

        const session = descriptionCaptureRef.current;
        descriptionCaptureRef.current = null;
        if (!session) {
            setDescriptionAudioState('idle');
            return;
        }

        let capture: { path: string } | null = null;
        setDescriptionAudioError(null);
        try {
            const stopped = await session.stop();
            capture = stopped;
            setDescriptionAudioState('transcribing');

            const currentSettings = useTaskStore.getState().settings;
            const { ready: speechReady, config: speechConfig } = await resolveSpeechCapture(currentSettings.ai);
            if (!speechReady) {
                throw new Error(tFallback(t, 'attachments.transcriptionUnavailable', 'Speech-to-text is not ready. Check your AI settings and try again.'));
            }

            const audioBytes = await stopped.bytes();
            const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : undefined;
            const result = await processAudioCapture(
                {
                    bytes: audioBytes,
                    mimeType: 'audio/wav',
                    name: stopped.name,
                    path: stopped.path,
                },
                {
                    ...speechConfig,
                    mode: 'transcribe_only',
                    fieldStrategy: 'description_only',
                    now: new Date(),
                    timeZone,
                },
            );
            const transcript = (result.description || result.transcript || '').trim();
            if (!transcript) {
                throw new Error(tFallback(t, 'attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
            }
            insertDescriptionTranscript(transcript);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setDescriptionAudioError(message || tFallback(t, 'attachments.transcriptionFailed', 'Transcription failed. Please try again.'));
        } finally {
            if (capture?.path) {
                remove(capture.path).catch((error) => {
                    void logWarn('Description audio cleanup failed', {
                        scope: 'audio',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                });
            }
            setDescriptionAudioState('idle');
        }
    }, [descriptionAudioState, insertDescriptionTranscript, t]);
    const handleEditDescriptionFromPreview = (source?: HTMLElement) => {
        const scrollSnapshot = captureScrollSnapshot(source);
        editDescriptionFromPreview();
        restoreScrollSnapshotSoon(scrollSnapshot);
        requestAnimationFrame(() => {
            const textarea = descriptionTextareaRef.current;
            if (!textarea) return;
            focusElementWithoutScroll(textarea, scrollSnapshot);
            restoreScrollSnapshotSoon(scrollSnapshot);
        });
    };
    const dateInputClassName = 'min-w-0 flex-1 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground';
    const timeInputClassName = 'w-24 shrink-0 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground';
    const dateIssueLabel = getTaskDateCoherenceIssues({
        startTime: editStartTime || undefined,
        dueDate: editDueDate || undefined,
    }).some((issue) => issue.code === 'start_after_due')
        ? tFallback(t, 'task.dateIssue.startAfterDue', 'Starts after due date')
        : '';
    const renderDateField = ({
        label,
        labelToken,
        dateAriaLabel,
        dateValue,
        selectedDate,
        onDateChange,
        timeInput,
        onClear,
        onDateOnly,
        hasValue,
        warning,
    }: {
        label: string;
        labelToken?: string;
        dateAriaLabel: string;
        dateValue: string;
        selectedDate: Date | null;
        onDateChange: (value: string) => void;
        timeInput: ReactNode;
        onClear: () => void;
        onDateOnly?: () => void;
        hasValue: boolean;
        warning?: string;
    }) => (
        <div className="space-y-1">
            <DateField
                t={t}
                label={label}
                labelToken={labelToken}
                dateAriaLabel={dateAriaLabel}
                dateValue={dateValue}
                selectedDate={selectedDate}
                dateFormatSetting={dateFormatSetting}
                nativeDateInputLocale={nativeDateInputLocale}
                dateInputClassName={dateInputClassName}
                timeInput={timeInput}
                onDateChange={onDateChange}
                onClear={onClear}
                onDateOnly={onDateOnly}
                hasValue={hasValue}
            />
            {warning && (
                <p className="text-xs text-warning" role="note">
                    {warning}
                </p>
            )}
        </div>
    );

    switch (fieldId) {
        case 'description':
            return (
                <DescriptionField
                    t={t}
                    taskTitle={task.title}
                    taskId={taskId}
                    showDescriptionPreview={showDescriptionPreview}
                    editDescription={editDescription}
                    isRtl={isRtl}
                    resolvedDirection={resolvedDirection}
                    descriptionExpanded={descriptionExpanded}
                    descriptionUndoDepth={descriptionUndoDepth}
                    descriptionTextareaRef={descriptionTextareaRef}
                    descriptionSelection={descriptionSelectionRef.current}
                    descriptionAutocomplete={descriptionAutocomplete}
                    descriptionAudioState={descriptionAudioState}
                    descriptionAudioError={descriptionAudioError}
                    onTogglePreview={toggleDescriptionPreview}
                    onEditFromPreview={handleEditDescriptionFromPreview}
                    onExpand={() => setDescriptionExpanded(true)}
                    onCloseExpanded={() => setDescriptionExpanded(false)}
                    onDescriptionInput={handleDescriptionInput}
                    onDescriptionChange={applyDescriptionValue}
                    onSelectionChange={(selection) => {
                        descriptionSelectionRef.current = selection;
                        if (isRangeSelection(selection)) {
                            lastDescriptionPairSelectionRef.current = null;
                        }
                    }}
                    onUndo={handleDescriptionUndo}
                    onApplyAction={handleDescriptionApplyAction}
                    onKeyDown={handleDescriptionKeyDown}
                    onPaste={handleDescriptionPaste}
                    onDescriptionAudioInput={handleDescriptionAudioInput}
                />
            );
        case 'attachments':
            return (
                <AttachmentsField
                    t={t}
                    attachmentError={attachmentError}
                    visibleEditAttachments={visibleEditAttachments}
                    addFileAttachment={addFileAttachment}
                    addLinkAttachment={addLinkAttachment}
                    addObsidianNoteAttachment={addObsidianNoteAttachment}
                    showObsidianNoteAttachment={showObsidianNoteAttachment}
                    editLinkAttachment={editLinkAttachment}
                    openAttachment={openAttachment}
                    removeAttachment={removeAttachment}
                />
            );
        case 'startTime':
            {
                const { date: dateValue, time: timeValue } = splitDateTime(editStartTime);
                const hasTime = Boolean(timeValue);
                const parsed = editStartTime ? safeParseDate(editStartTime) : null;
                const handleDateChange = (value: string) => {
                    setEditRelativeStartOffset(undefined);
                    const normalizedDate = normalizeDateInputValue(value);
                    setEditStartTime(joinDateTime(normalizedDate, timeValue, { defaultTime: defaultScheduleTime }));
                };
                const handleTimeChange = (value: string) => {
                    setEditRelativeStartOffset(undefined);
                    const datePart = dateValue || (value ? safeFormatDate(new Date(), 'yyyy-MM-dd') : '');
                    setEditStartTime(joinDateTime(datePart, value));
                };
                const dueDateHasTime = hasTimeComponent(editDueDate);
                const relativeUnit = editRelativeStartOffset?.unit ?? 'day';
                const relativeUnitForDueDate = !dueDateHasTime && (relativeUnit === 'minute' || relativeUnit === 'hour')
                    ? 'day'
                    : relativeUnit;
                const relativeAmount = editRelativeStartOffset ? Math.abs(editRelativeStartOffset.amount) : 3;
                const relativeUnitOptions: Array<{ value: NonNullable<Task['relativeStartOffset']>['unit']; label: string }> = dueDateHasTime
                    ? [
                        { value: 'minute', label: t('taskEdit.relativeStartMinutes') },
                        { value: 'hour', label: t('taskEdit.relativeStartHours') },
                        { value: 'day', label: t('taskEdit.relativeStartDays') },
                        { value: 'week', label: t('taskEdit.relativeStartWeeks') },
                    ]
                    : [
                        { value: 'day', label: t('taskEdit.relativeStartDays') },
                        { value: 'week', label: t('taskEdit.relativeStartWeeks') },
                    ];
                const applyRelativeStartOffset = (amountValue: number, unitValue: NonNullable<Task['relativeStartOffset']>['unit']) => {
                    if (!editDueDate || !Number.isFinite(amountValue)) return;
                    // 0 is valid: start on the due date itself.
                    const magnitude = Math.max(0, Math.floor(amountValue));
                    const offset = { amount: magnitude === 0 ? 0 : -magnitude, unit: unitValue };
                    const computedStart = computeRelativeStartTime(editDueDate, offset);
                    if (!computedStart) {
                        setEditRelativeStartOffset(undefined);
                        return;
                    }
                    setEditRelativeStartOffset(offset);
                    setEditStartTime(computedStart);
                };
                return (
                    <>
                        {renderDateField({
                            label: t('taskEdit.startDateLabel'),
                            labelToken: QUICK_ADD_FIELD_TOKENS.startTime,
                            dateAriaLabel: t('task.aria.startDate'),
                            dateValue,
                            selectedDate: parsed,
                            onDateChange: handleDateChange,
                            timeInput: (
                                <input
                                    type="time"
                                    lang={nativeDateInputLocale}
                                    aria-label={t('task.aria.startTime')}
                                    value={timeValue}
                                    onChange={(event) => handleTimeChange(event.target.value)}
                                    className={timeInputClassName}
                                />
                            ),
                            onClear: () => {
                                setEditRelativeStartOffset(undefined);
                                setEditStartTime('');
                            },
                            onDateOnly: hasTime ? () => handleTimeChange('') : undefined,
                            hasValue: Boolean(editStartTime),
                            warning: dateIssueLabel,
                        })}
                        {editDueDate && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5" aria-label={t('taskEdit.startModeLabel')}>
                                    <button
                                        type="button"
                                        aria-pressed={!editRelativeStartOffset}
                                        onClick={() => setEditRelativeStartOffset(undefined)}
                                        className={`rounded px-2 py-1 ${!editRelativeStartOffset ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                                    >
                                        {t('taskEdit.startModeAbsolute')}
                                    </button>
                                    <button
                                        type="button"
                                        aria-pressed={Boolean(editRelativeStartOffset)}
                                        onClick={() => applyRelativeStartOffset(relativeAmount, relativeUnitForDueDate)}
                                        className={`rounded px-2 py-1 ${editRelativeStartOffset ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                                    >
                                        {t('taskEdit.startModeRelative')}
                                    </button>
                                </div>
                                {editRelativeStartOffset && (
                                    <>
                                        <input
                                            type="number"
                                            min={0}
                                            max={10000}
                                            value={relativeAmount}
                                            onChange={(event) => applyRelativeStartOffset(Number(event.target.value), relativeUnitForDueDate)}
                                            className="h-8 w-16 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                                            aria-label={t('taskEdit.relativeStartAmount')}
                                        />
                                        <select
                                            value={relativeUnitForDueDate}
                                            onChange={(event) => applyRelativeStartOffset(relativeAmount, event.target.value as NonNullable<Task['relativeStartOffset']>['unit'])}
                                            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                                            aria-label={t('taskEdit.relativeStartUnit')}
                                        >
                                            {relativeUnitOptions.map((option) => (
                                                <option key={option.value} value={option.value}>{option.label}</option>
                                            ))}
                                        </select>
                                    </>
                                )}
                            </div>
                        )}
                    </>
                );
            }
        case 'dueDate':
            {
                const { date: dateValue, time: timeValue } = splitDateTime(editDueDate);
                const hasTime = Boolean(timeValue);
                const hasReminderHandoffSchedule = hasTimeComponent(editStartTime) || hasTime;
                const parsed = editDueDate ? safeParseDate(editDueDate) : null;
                const updateDueDate = (nextDueDate: string) => {
                    setEditDueDate(nextDueDate);
                    if (!editRelativeStartOffset) return;
                    if (!nextDueDate) {
                        setEditRelativeStartOffset(undefined);
                        return;
                    }
                    const computedStart = computeRelativeStartTime(nextDueDate, editRelativeStartOffset);
                    if (computedStart) {
                        setEditStartTime(computedStart);
                    } else {
                        setEditRelativeStartOffset(undefined);
                    }
                };
                const handleDateChange = (value: string) => {
                    const normalizedDate = normalizeDateInputValue(value);
                    updateDueDate(joinDateTime(normalizedDate, timeValue, { defaultTime: defaultScheduleTime }));
                };
                const handleTimeChange = (value: string) => {
                    const datePart = dateValue || (value ? safeFormatDate(new Date(), 'yyyy-MM-dd') : '');
                    updateDueDate(joinDateTime(datePart, value));
                };
                return (
                    <>
                        {renderDateField({
                            label: t('taskEdit.dueDateLabel'),
                            labelToken: QUICK_ADD_FIELD_TOKENS.dueDate,
                            dateAriaLabel: t('task.aria.dueDate'),
                            dateValue,
                            selectedDate: parsed,
                            onDateChange: handleDateChange,
                            timeInput: (
                                <input
                                    type="time"
                                    lang={nativeDateInputLocale}
                                    aria-label={t('task.aria.dueTime')}
                                    value={timeValue}
                                    onChange={(event) => handleTimeChange(event.target.value)}
                                    className={timeInputClassName}
                                />
                            ),
                            onClear: () => updateDueDate(''),
                            onDateOnly: hasTime ? () => handleTimeChange('') : undefined,
                            hasValue: Boolean(editDueDate),
                            warning: dateIssueLabel,
                        })}
                        {hasReminderHandoffSchedule && (() => {
                            const repeatLabel = tFallback(t, 'taskEdit.repeatReminderLabel', 'Repeat reminder');
                            const current = editRepeatReminderMinutes ?? 0;
                            const showRepeat = hasTime && !editSuppressMindwtrReminders;
                            const formatValue = (minutes: number) => (
                                minutes === 0
                                    ? tFallback(t, 'taskEdit.repeatReminderOff', 'Off')
                                    : tFallback(t, 'taskEdit.repeatReminderEveryMinutes', 'Every {count} min').replace('{count}', String(minutes))
                            );
                            const formatOption = (minutes: number) => (
                                minutes === 0
                                    ? tFallback(t, 'taskEdit.repeatReminderOff', 'Off')
                                    : tFallback(t, 'taskEdit.repeatReminderMinutesShort', '{count} min').replace('{count}', String(minutes))
                            );
                            // One quiet line for both correction-path options; it has to
                            // say when either one is off its default without being opened.
                            // A stored repeat interval is unreachable once the due time is
                            // gone, so it must not light up a summary that cannot show it.
                            const isDefault = !editSuppressMindwtrReminders && (!showRepeat || current === 0);
                            const summary = editSuppressMindwtrReminders
                                ? tFallback(t, 'taskEdit.suppressMindwtrRemindersViewValue', 'Mindwtr reminders off')
                                : [
                                    tFallback(t, 'taskEdit.remindersSummaryOn', 'Reminders on'),
                                    ...(showRepeat ? [`${repeatLabel}: ${formatValue(current)}`] : []),
                                ].join(' · ');
                            return (
                                <div className="mt-1 space-y-1.5">
                                    <button
                                        type="button"
                                        aria-expanded={remindersExpanded}
                                        className={`w-full rounded border px-2 py-1.5 text-left text-xs transition-colors ${remindersExpanded || !isDefault
                                            ? 'border-primary/60 bg-primary/10 text-foreground'
                                            : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/50'
                                            }`}
                                        onClick={() => setRemindersExpanded((expanded) => !expanded)}
                                    >
                                        {summary}
                                    </button>
                                    {remindersExpanded && (
                                        <>
                                            <label className="flex items-start gap-2 rounded border border-border/70 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
                                                <input
                                                    type="checkbox"
                                                    checked={editSuppressMindwtrReminders}
                                                    onChange={(event) => setEditSuppressMindwtrReminders(event.target.checked)}
                                                    className="mt-0.5 shrink-0 accent-primary"
                                                />
                                                <span className="min-w-0">
                                                    <span className="block font-medium text-foreground">
                                                        {tFallback(t, 'taskEdit.suppressMindwtrReminders', 'Skip reminders')}
                                                    </span>
                                                    <span className="block leading-snug">
                                                        {tFallback(t, 'taskEdit.suppressMindwtrRemindersHint', 'Skip start and due reminders for this task. It still appears in Focus and your lists.')}
                                                    </span>
                                                </span>
                                            </label>
                                            {showRepeat && (
                                                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={repeatLabel}>
                                                    <span className="text-xs text-muted-foreground">{repeatLabel}</span>
                                                    {[0, ...REPEAT_REMINDER_INTERVAL_OPTIONS].map((minutes) => {
                                                        const active = current === minutes;
                                                        return (
                                                            <button
                                                                key={minutes}
                                                                type="button"
                                                                aria-pressed={active}
                                                                className={`rounded border px-2 py-1 text-xs transition-colors ${active
                                                                    ? 'border-primary bg-primary text-primary-foreground'
                                                                    : 'border-border bg-muted/40 text-foreground hover:bg-muted'
                                                                    }`}
                                                                onClick={() => setEditRepeatReminderMinutes(minutes > 0 ? minutes : undefined)}
                                                            >
                                                                {formatOption(minutes)}
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            );
                        })()}
                    </>
                );
            }
        case 'reviewAt':
            {
                const { date: dateValue, time: timeValue } = splitDateTime(editReviewAt);
                const hasTime = Boolean(timeValue);
                const parsed = editReviewAt ? safeParseDate(editReviewAt) : null;
                const handleDateChange = (value: string) => {
                    const normalizedDate = normalizeDateInputValue(value);
                    setEditReviewAt(joinDateTime(normalizedDate, timeValue, { defaultTime: defaultScheduleTime }));
                };
                const handleTimeChange = (value: string) => {
                    const datePart = dateValue || (value ? safeFormatDate(new Date(), 'yyyy-MM-dd') : '');
                    setEditReviewAt(joinDateTime(datePart, value));
                };
                return renderDateField({
                    label: t('taskEdit.reviewDateLabel'),
                    labelToken: QUICK_ADD_FIELD_TOKENS.reviewAt,
                    dateAriaLabel: t('task.aria.reviewDate'),
                    dateValue,
                    selectedDate: parsed,
                    onDateChange: handleDateChange,
                    timeInput: (
                        // The same native control Start and Due use (#896). It was the one
                        // text field parsed on blur, with a mirrored draft and an effect to
                        // keep that draft in step with the task — all of which the native
                        // input does for free.
                        <input
                            type="time"
                            lang={nativeDateInputLocale}
                            aria-label={t('task.aria.reviewTime')}
                            value={timeValue}
                            onChange={(event) => handleTimeChange(event.target.value)}
                            className={timeInputClassName}
                        />
                    ),
                    onClear: () => setEditReviewAt(''),
                    onDateOnly: hasTime ? () => handleTimeChange('') : undefined,
                    hasValue: Boolean(editReviewAt),
                });
            }
        case 'status':
            return (
                <StatusField
                    t={t}
                    value={editStatus}
                    onChange={setEditStatus}
                    onRequestBackdatedComplete={requestBackdatedComplete}
                />
            );
        case 'priority':
            return <PriorityField t={t} value={editPriority} onChange={setEditPriority} />;
        case 'energyLevel':
            return <EnergyLevelField t={t} value={editEnergyLevel} onChange={setEditEnergyLevel} />;
        case 'assignedTo':
            return <AssignedToField t={t} value={editAssignedTo} options={assignedToOptions} onChange={setEditAssignedTo} onCreatePerson={createAssignedToPerson} />;
        case 'recurrence':
            return (
                <RecurrenceField
                    t={t}
                    language={language}
                    editRecurrence={editRecurrence}
                    editRecurrenceStrategy={editRecurrenceStrategy}
                    editRecurrenceRRule={editRecurrenceRRule}
                    editShowFutureRecurrence={editShowFutureRecurrence}
                    monthlyRecurrence={monthlyRecurrence}
                    parsedRecurrenceRRule={parsedRecurrenceRRule}
                    completedOccurrences={getRecurrenceCompletedOccurrencesValue(task.recurrence)}
                    recurrenceEndMode={recurrenceEndMode}
                    recurrenceDefaultEndDate={recurrenceDefaultEndDate}
                    dateFormatSetting={dateFormatSetting}
                    nativeDateInputLocale={nativeDateInputLocale}
                    projectedRecurrenceDateLabel={projectedRecurrenceDateLabel}
                    onRecurrenceChange={setEditRecurrence}
                    onRecurrenceStrategyChange={setEditRecurrenceStrategy}
                    onRecurrenceRRuleChange={setEditRecurrenceRRule}
                    onShowFutureRecurrenceChange={setEditShowFutureRecurrence}
                    openCustomRecurrence={openCustomRecurrence}
                    buildRecurrenceRRule={buildRecurrenceRRule}
                />
            );
        case 'timeEstimate':
            // Time spent is opt-in: it only appears while the Pomodoro timer's
            // task linking is engaged, so the default editor stays estimate-only.
            if (!timeSpentEnabled) {
                return <TimeEstimateField t={t} value={editTimeEstimate} onChange={setEditTimeEstimate} />;
            }
            return (
                <div className="flex gap-2 w-full">
                    <TimeEstimateField t={t} value={editTimeEstimate} onChange={setEditTimeEstimate} />
                    <TimeSpentField t={t} value={editTimeSpentMinutes} onChange={setEditTimeSpentMinutes} />
                </div>
            );
        case 'contexts':
            return (
                <ContextsField
                    t={t}
                    value={editContexts}
                    options={popularContextOptions}
                    suggestions={allContextOptions}
                    onChange={setEditContexts}
                />
            );
        case 'tags':
            return (
                <TagsField
                    t={t}
                    value={editTags}
                    options={popularTagOptions}
                    suggestions={allTagOptions}
                    onChange={setEditTags}
                />
            );
        case 'location':
            return (
                <div className="flex flex-col gap-1">
                    <label className={taskEditorLabelClassName}>{t('taskEdit.locationLabel')}</label>
                    <input
                        type="text"
                        aria-label={t('task.aria.location')}
                        value={editLocation}
                        onChange={(event) => setEditLocation(event.target.value)}
                        placeholder={t('taskEdit.locationPlaceholder')}
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground placeholder:text-muted-foreground"
                    />
                </div>
            );
        case 'checklist':
            return (
                <ChecklistField
                    t={t}
                    taskId={taskId}
                    checklist={task.checklist}
                    updateTask={updateTask}
                    resetTaskChecklist={resetTaskChecklist}
                />
            );
        default:
            return null;
    }
}
