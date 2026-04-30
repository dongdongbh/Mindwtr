import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import {
    applyMarkdownToolbarAction,
    buildRRuleString,
    continueMarkdownOnEnter,
    hasTimeComponent,
    normalizeClockTimeInput,
    parseRRuleString,
    resolveAutoTextDirection,
    safeFormatDate,
    safeParseDate,
    tFallback,
    type Attachment,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
    type RecurrenceByDay,
    type RecurrenceRule,
    type RecurrenceStrategy,
    type Task,
    type TaskEditorFieldId,
    type TaskEnergyLevel,
    type TaskPriority,
    type TaskStatus,
    type TimeEstimate,
} from '@mindwtr/core';

import { useMarkdownReferenceAutocomplete } from '../MarkdownReferenceAutocomplete';
import { AttachmentsField } from './TaskForm/AttachmentsField';
import { ChecklistField } from './TaskForm/ChecklistField';
import { normalizeDateInputValue } from './task-item-helpers';
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
} from './fields/TaskMetadataFields';

export type MonthlyRecurrenceInfo = {
    pattern: 'date' | 'custom';
    interval: number;
};

export type TaskItemFieldRendererData = {
    t: (key: string) => string;
    task: Task;
    taskId: string;
    showDescriptionPreview: boolean;
    editDescription: string;
    attachmentError: string | null;
    visibleEditAttachments: Attachment[];
    editStartTime: string;
    editDueDate: string;
    editReviewAt: string;
    editStatus: TaskStatus;
    editPriority: TaskPriority | '';
    editEnergyLevel: NonNullable<TaskEnergyLevel> | '';
    editAssignedTo: string;
    editRecurrence: RecurrenceRule | '';
    editRecurrenceStrategy: RecurrenceStrategy;
    editRecurrenceRRule: string;
    monthlyRecurrence: MonthlyRecurrenceInfo;
    editTimeEstimate: TimeEstimate | '';
    editContexts: string;
    editTags: string;
    language: string;
    nativeDateInputLocale: string;
    defaultScheduleTime: string;
    popularContextOptions: string[];
    popularTagOptions: string[];
};

export type TaskItemFieldRendererHandlers = {
    toggleDescriptionPreview: () => void;
    setEditDescription: (value: string) => void;
    addFileAttachment: () => void;
    addLinkAttachment: () => void;
    openAttachment: (attachment: Attachment) => void;
    removeAttachment: (id: string) => void;
    setEditStartTime: (value: string) => void;
    setEditDueDate: (value: string) => void;
    setEditReviewAt: (value: string) => void;
    setEditStatus: (value: TaskStatus) => void;
    setEditPriority: (value: TaskPriority | '') => void;
    setEditEnergyLevel: (value: NonNullable<TaskEnergyLevel> | '') => void;
    setEditAssignedTo: (value: string) => void;
    setEditRecurrence: (value: RecurrenceRule | '') => void;
    setEditRecurrenceStrategy: (value: RecurrenceStrategy) => void;
    setEditRecurrenceRRule: (value: string) => void;
    openCustomRecurrence: () => void;
    setEditTimeEstimate: (value: TimeEstimate | '') => void;
    setEditContexts: (value: string) => void;
    setEditTags: (value: string) => void;
    updateTask: (taskId: string, updates: Partial<Task>) => void;
    resetTaskChecklist: (taskId: string) => void;
};

type TaskItemFieldRendererProps = {
    fieldId: TaskEditorFieldId;
    data: TaskItemFieldRendererData;
    handlers: TaskItemFieldRendererHandlers;
};

export function TaskItemFieldRenderer({
    fieldId,
    data,
    handlers,
}: TaskItemFieldRendererProps) {
    const {
        t,
        task,
        taskId,
        showDescriptionPreview,
        editDescription,
        attachmentError,
        visibleEditAttachments,
        editStartTime,
        editDueDate,
        editReviewAt,
        editStatus,
        editPriority,
        editEnergyLevel,
        editAssignedTo,
        editRecurrence,
        editRecurrenceStrategy,
        editRecurrenceRRule,
        monthlyRecurrence,
        editTimeEstimate,
        editContexts,
        editTags,
        language,
        nativeDateInputLocale,
        defaultScheduleTime,
        popularContextOptions,
        popularTagOptions,
    } = data;

    const [reviewTimeDraft, setReviewTimeDraft] = useState('');
    const [descriptionExpanded, setDescriptionExpanded] = useState(false);
    const descriptionTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const descriptionSelectionRef = useRef<MarkdownSelection>({
        start: editDescription.length,
        end: editDescription.length,
    });
    const descriptionUndoRef = useRef<Array<{ value: string; selection: MarkdownSelection }>>([]);
    const [descriptionUndoDepth, setDescriptionUndoDepth] = useState(0);
    useEffect(() => {
        const parsed = editReviewAt ? safeParseDate(editReviewAt) : null;
        const hasTime = hasTimeComponent(editReviewAt);
        const next = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
        setReviewTimeDraft(next);
    }, [editReviewAt]);
    useEffect(() => {
        descriptionSelectionRef.current = {
            start: editDescription.length,
            end: editDescription.length,
        };
        descriptionUndoRef.current = [];
        setDescriptionUndoDepth(0);
    }, [taskId]);
    const {
        toggleDescriptionPreview,
        setEditDescription,
        addFileAttachment,
        addLinkAttachment,
        openAttachment,
        removeAttachment,
        setEditStartTime,
        setEditDueDate,
        setEditReviewAt,
        setEditStatus,
        setEditPriority,
        setEditEnergyLevel,
        setEditAssignedTo,
        setEditRecurrence,
        setEditRecurrenceStrategy,
        setEditRecurrenceRRule,
        openCustomRecurrence,
        setEditTimeEstimate,
        setEditContexts,
        setEditTags,
        updateTask,
        resetTaskChecklist,
    } = handlers;
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
        }
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
        const lowerKey = event.key.toLowerCase();
        if ((event.metaKey || event.ctrlKey) && !event.altKey) {
            if (lowerKey !== 'z') return;
            if (descriptionUndoRef.current.length === 0) return;
            event.preventDefault();
            handleDescriptionUndo();
            return;
        }

        if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
        const currentValue = event.currentTarget.value;
        const selection = {
            start: event.currentTarget.selectionStart ?? currentValue.length,
            end: event.currentTarget.selectionEnd ?? currentValue.length,
        };
        const next = continueMarkdownOnEnter(currentValue, selection);
        if (!next) return;

        event.preventDefault();
        applyDescriptionValue(next.value, {
            baseSelection: selection,
            nextSelection: next.selection,
        });
        descriptionSelectionRef.current = next.selection;
        requestAnimationFrame(() => {
            descriptionTextareaRef.current?.focus();
            descriptionTextareaRef.current?.setSelectionRange(next.selection.start, next.selection.end);
        });
    };
    const clearText = tFallback(t, 'common.clear', 'Clear');
    const dateInputClassName = 'min-w-0 flex-1 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground';
    const timeInputClassName = 'w-24 shrink-0 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground';
    const renderClearButton = (label: string, onClear: () => void, isVisible: boolean) => {
        if (!isVisible) {
            return <span aria-hidden="true" className="h-7 w-7 shrink-0" />;
        }

        return (
            <button
                type="button"
                onClick={onClear}
                className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={`${clearText} ${label}`}
            >
                <X className="h-4 w-4" />
            </button>
        );
    };
    const renderDateField = ({
        label,
        dateAriaLabel,
        dateValue,
        onDateChange,
        timeInput,
        onClear,
        hasValue,
    }: {
        label: string;
        dateAriaLabel: string;
        dateValue: string;
        onDateChange: (value: string) => void;
        timeInput: ReactNode;
        onClear: () => void;
        hasValue: boolean;
    }) => (
        <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground font-medium">{label}</label>
            <div className="flex w-full max-w-[min(22rem,100%)] items-center gap-2">
                <input
                    type="date"
                    lang={nativeDateInputLocale}
                    aria-label={dateAriaLabel}
                    value={dateValue}
                    onChange={(event) => onDateChange(event.target.value)}
                    className={dateInputClassName}
                />
                {timeInput}
                {renderClearButton(label, onClear, hasValue)}
            </div>
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
                    onTogglePreview={toggleDescriptionPreview}
                    onExpand={() => setDescriptionExpanded(true)}
                    onCloseExpanded={() => setDescriptionExpanded(false)}
                    onDescriptionInput={(value, selection) => {
                        applyDescriptionValue(value);
                        descriptionSelectionRef.current = selection;
                    }}
                    onDescriptionChange={applyDescriptionValue}
                    onSelectionChange={(selection) => {
                        descriptionSelectionRef.current = selection;
                    }}
                    onUndo={handleDescriptionUndo}
                    onApplyAction={handleDescriptionApplyAction}
                    onKeyDown={handleDescriptionKeyDown}
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
                    openAttachment={openAttachment}
                    removeAttachment={removeAttachment}
                />
            );
        case 'startTime':
            {
                const hasTime = hasTimeComponent(editStartTime);
                const parsed = editStartTime ? safeParseDate(editStartTime) : null;
                const dateValue = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
                const timeValue = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                const handleDateChange = (value: string) => {
                    const normalizedDate = normalizeDateInputValue(value);
                    if (!normalizedDate) {
                        setEditStartTime('');
                        return;
                    }
                    if (hasTime && timeValue) {
                        setEditStartTime(`${normalizedDate}T${timeValue}`);
                        return;
                    }
                    if (defaultScheduleTime) {
                        setEditStartTime(`${normalizedDate}T${defaultScheduleTime}`);
                        return;
                    }
                    setEditStartTime(normalizedDate);
                };
                const handleTimeChange = (value: string) => {
                    if (!value) {
                        if (dateValue) setEditStartTime(dateValue);
                        else setEditStartTime('');
                        return;
                    }
                    const datePart = dateValue || safeFormatDate(new Date(), 'yyyy-MM-dd');
                    setEditStartTime(`${datePart}T${value}`);
                };
                return renderDateField({
                    label: t('taskEdit.startDateLabel'),
                    dateAriaLabel: t('task.aria.startDate'),
                    dateValue,
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
                    onClear: () => setEditStartTime(''),
                    hasValue: Boolean(editStartTime),
                });
            }
        case 'dueDate':
            {
                const hasTime = hasTimeComponent(editDueDate);
                const parsed = editDueDate ? safeParseDate(editDueDate) : null;
                const dateValue = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
                const timeValue = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                const handleDateChange = (value: string) => {
                    const normalizedDate = normalizeDateInputValue(value);
                    if (!normalizedDate) {
                        setEditDueDate('');
                        return;
                    }
                    if (hasTime && timeValue) {
                        setEditDueDate(`${normalizedDate}T${timeValue}`);
                        return;
                    }
                    if (defaultScheduleTime) {
                        setEditDueDate(`${normalizedDate}T${defaultScheduleTime}`);
                        return;
                    }
                    setEditDueDate(normalizedDate);
                };
                const handleTimeChange = (value: string) => {
                    if (!value) {
                        if (dateValue) setEditDueDate(dateValue);
                        else setEditDueDate('');
                        return;
                    }
                    const datePart = dateValue || safeFormatDate(new Date(), 'yyyy-MM-dd');
                    setEditDueDate(`${datePart}T${value}`);
                };
                return renderDateField({
                    label: t('taskEdit.dueDateLabel'),
                    dateAriaLabel: t('task.aria.dueDate'),
                    dateValue,
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
                    onClear: () => setEditDueDate(''),
                    hasValue: Boolean(editDueDate),
                });
            }
        case 'reviewAt':
            {
                const hasTime = hasTimeComponent(editReviewAt);
                const parsed = editReviewAt ? safeParseDate(editReviewAt) : null;
                const dateValue = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
                const timeValue = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                const handleDateChange = (value: string) => {
                    const normalizedDate = normalizeDateInputValue(value);
                    if (!normalizedDate) {
                        setEditReviewAt('');
                        return;
                    }
                    if (hasTime && timeValue) {
                        setEditReviewAt(`${normalizedDate}T${timeValue}`);
                        return;
                    }
                    if (defaultScheduleTime) {
                        setEditReviewAt(`${normalizedDate}T${defaultScheduleTime}`);
                        return;
                    }
                    setEditReviewAt(normalizedDate);
                };
                const handleTimeChange = (value: string) => {
                    if (!value) {
                        if (dateValue) setEditReviewAt(dateValue);
                        else setEditReviewAt('');
                        return;
                    }
                    const datePart = dateValue || safeFormatDate(new Date(), 'yyyy-MM-dd');
                    setEditReviewAt(`${datePart}T${value}`);
                };
                return renderDateField({
                    label: t('taskEdit.reviewDateLabel'),
                    dateAriaLabel: t('task.aria.reviewDate'),
                    dateValue,
                    onDateChange: handleDateChange,
                    timeInput: (
                        <input
                            type="text"
                            aria-label={t('task.aria.reviewTime')}
                            value={reviewTimeDraft}
                            inputMode="numeric"
                            placeholder="HH:MM"
                            onChange={(event) => setReviewTimeDraft(event.target.value)}
                            onBlur={() => {
                                const normalized = normalizeClockTimeInput(reviewTimeDraft);
                                if (normalized === null) {
                                    setReviewTimeDraft(timeValue);
                                    return;
                                }
                                setReviewTimeDraft(normalized);
                                handleTimeChange(normalized);
                            }}
                            className={timeInputClassName}
                        />
                    ),
                    onClear: () => setEditReviewAt(''),
                    hasValue: Boolean(editReviewAt),
                });
            }
        case 'status':
            return <StatusField t={t} value={editStatus} onChange={setEditStatus} />;
        case 'priority':
            return <PriorityField t={t} value={editPriority} onChange={setEditPriority} />;
        case 'energyLevel':
            return <EnergyLevelField t={t} value={editEnergyLevel} onChange={setEditEnergyLevel} />;
        case 'assignedTo':
            return <AssignedToField t={t} value={editAssignedTo} onChange={setEditAssignedTo} />;
        case 'recurrence':
            return (
                <RecurrenceField
                    t={t}
                    editRecurrence={editRecurrence}
                    editRecurrenceStrategy={editRecurrenceStrategy}
                    editRecurrenceRRule={editRecurrenceRRule}
                    monthlyRecurrence={monthlyRecurrence}
                    parsedRecurrenceRRule={parsedRecurrenceRRule}
                    recurrenceEndMode={recurrenceEndMode}
                    recurrenceDefaultEndDate={recurrenceDefaultEndDate}
                    onRecurrenceChange={setEditRecurrence}
                    onRecurrenceStrategyChange={setEditRecurrenceStrategy}
                    onRecurrenceRRuleChange={setEditRecurrenceRRule}
                    openCustomRecurrence={openCustomRecurrence}
                    buildRecurrenceRRule={buildRecurrenceRRule}
                />
            );
        case 'timeEstimate':
            return <TimeEstimateField t={t} value={editTimeEstimate} onChange={setEditTimeEstimate} />;
        case 'contexts':
            return <ContextsField t={t} value={editContexts} options={popularContextOptions} onChange={setEditContexts} />;
        case 'tags':
            return <TagsField t={t} value={editTags} options={popularTagOptions} onChange={setEditTags} />;
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
