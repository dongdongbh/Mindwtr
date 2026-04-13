import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Maximize2, X } from 'lucide-react';
import {
    applyMarkdownToolbarAction,
    buildRRuleString,
    continueMarkdownOnEnter,
    hasTimeComponent,
    parseRRuleString,
    resolveAutoTextDirection,
    safeFormatDate,
    safeParseDate,
    type Attachment,
    type MarkdownSelection,
    type MarkdownToolbarActionId,
    type MarkdownToolbarResult,
    type RecurrenceRule,
    type RecurrenceStrategy,
    type Task,
    type TaskEditorFieldId,
    type TaskEnergyLevel,
    type TaskPriority,
    type TaskStatus,
    type TimeEstimate,
} from '@mindwtr/core';

import { cn } from '../../lib/utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExpandedMarkdownEditor } from '../ExpandedMarkdownEditor';
import { MarkdownFormatToolbar } from '../MarkdownFormatToolbar';
import { WeekdaySelector } from './TaskForm/WeekdaySelector';
import { AttachmentsField } from './TaskForm/AttachmentsField';
import { ChecklistField } from './TaskForm/ChecklistField';
import { normalizeDateInputValue } from './task-item-helpers';
import { AutosizeTextarea } from '../ui/AutosizeTextarea';

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
    const handleDescriptionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
    const clearText = t('common.clear') === 'common.clear' ? 'Clear' : t('common.clear');
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
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.descriptionLabel')}</label>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={toggleDescriptionPreview}
                                className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                            >
                                {showDescriptionPreview ? t('markdown.edit') : t('markdown.preview')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setDescriptionExpanded(true)}
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                aria-label={t('markdown.expand')}
                            >
                                <Maximize2 className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                    {showDescriptionPreview ? (
                        <div className={cn("text-xs bg-muted/30 border border-border rounded px-2 py-2", isRtl && "text-right")} dir={resolvedDirection}>
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                disallowedElements={['img']}
                                components={{
                                    a: ({ className, ...props }: any) => (
                                        <a
                                            className={cn("text-primary underline hover:text-primary/80", className)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            {...props}
                                        />
                                    ),
                                    ul: ({ className, ...props }: any) => (
                                        <ul className={cn("list-disc pl-4 py-1 space-y-0.5", className)} {...props} />
                                    ),
                                    ol: ({ className, ...props }: any) => (
                                        <ol className={cn("list-decimal pl-4 py-1 space-y-0.5", className)} {...props} />
                                    ),
                                    li: ({ className, ...props }: any) => (
                                        <li className={cn("pl-1", className)} {...props} />
                                    ),
                                    p: ({ className, children, ...props }: any) => (
                                        <p className={cn("mb-1 last:mb-0 leading-relaxed", className)} {...props}>
                                            {children}
                                        </p>
                                    ),
                                    code: ({ className, ...props }: any) => (
                                        <code className={cn("bg-muted px-1 py-0.5 rounded text-[0.9em] font-mono", className)} {...props} />
                                    ),
                                    pre: ({ className, ...props }: any) => (
                                        <pre className={cn("bg-muted p-2 rounded-md overflow-x-auto my-1", className)} {...props} />
                                    ),
                                    blockquote: ({ className, ...props }: any) => (
                                        <blockquote className={cn("border-l-2 border-primary/50 pl-3 italic my-1 text-muted-foreground/80", className)} {...props} />
                                    ),
                                    table: ({ className, ...props }: any) => (
                                        <div className="overflow-x-auto my-2">
                                            <table className={cn("min-w-full divide-y divide-border", className)} {...props} />
                                        </div>
                                    ),
                                    th: ({ className, ...props }: any) => (
                                        <th className={cn("px-2 py-1 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider bg-muted/50", className)} {...props} />
                                    ),
                                    td: ({ className, ...props }: any) => (
                                        <td className={cn("px-2 py-1 text-sm border-b border-border/50", className)} {...props} />
                                    ),
                                    // Handle task lists (GFM)
                                    input: ({ type, ...props }: any) => {
                                        if (type === 'checkbox') {
                                            return <input type="checkbox" className="mr-2 accent-primary" {...props} />;
                                        }
                                        return <input type={type} {...props} />;
                                    }
                                }}
                            >
                                {editDescription || ''}
                            </ReactMarkdown>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <MarkdownFormatToolbar
                                textareaRef={descriptionTextareaRef}
                                t={t}
                                canUndo={descriptionUndoDepth > 0}
                                onUndo={handleDescriptionUndo}
                                onApplyAction={handleDescriptionApplyAction}
                            />
                            <AutosizeTextarea
                                ref={descriptionTextareaRef}
                                aria-label={t('task.aria.description')}
                                value={editDescription}
                                onChange={(event) => {
                                    applyDescriptionValue(event.target.value);
                                    descriptionSelectionRef.current = {
                                        start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                        end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                                    };
                                }}
                                onSelect={(event) => {
                                    descriptionSelectionRef.current = {
                                        start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                        end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                                    };
                                }}
                                onKeyDown={handleDescriptionKeyDown}
                                minHeight={112}
                                focusedMinHeight={208}
                                maxHeight={480}
                                className={cn(
                                    "w-full text-sm leading-6 bg-muted/50 border border-border rounded px-3 py-2 resize-none transition-[border-color,box-shadow] focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40",
                                    isRtl && "text-right"
                                )}
                                placeholder={t('taskEdit.descriptionPlaceholder')}
                                dir={resolvedDirection}
                            />
                        </div>
                    )}
                    <ExpandedMarkdownEditor
                        isOpen={descriptionExpanded}
                        onClose={() => setDescriptionExpanded(false)}
                        value={editDescription}
                        onChange={applyDescriptionValue}
                        title={t('taskEdit.descriptionLabel')}
                        headerTitle={task.title?.trim() || t('taskEdit.descriptionLabel')}
                        placeholder={t('taskEdit.descriptionPlaceholder')}
                        t={t}
                        initialMode="edit"
                        direction={resolvedDirection}
                        canUndo={descriptionUndoDepth > 0}
                        onUndo={handleDescriptionUndo}
                        onApplyAction={handleDescriptionApplyAction}
                        onSelectionChange={(selection) => {
                            descriptionSelectionRef.current = selection;
                        }}
                        onEditorKeyDown={handleDescriptionKeyDown}
                    />
                </div>
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
                const normalizeTimeInput = (value: string): string | null => {
                    const trimmed = value.trim();
                    if (!trimmed) return '';
                    const compact = trimmed.replace(/\s+/g, '');
                    let hours: number;
                    let minutes: number;
                    if (/^\d{1,2}:\d{2}$/.test(compact)) {
                        const [h, m] = compact.split(':');
                        hours = Number(h);
                        minutes = Number(m);
                    } else if (/^\d{3,4}$/.test(compact)) {
                        if (compact.length === 3) {
                            hours = Number(compact.slice(0, 1));
                            minutes = Number(compact.slice(1));
                        } else {
                            hours = Number(compact.slice(0, 2));
                            minutes = Number(compact.slice(2));
                        }
                    } else {
                        return null;
                    }
                    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
                    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
                    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
                };
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
                                const normalized = normalizeTimeInput(reviewTimeDraft);
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
            return (
                <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.statusLabel')}</label>
                    <select
                        value={editStatus}
                        aria-label={t('task.aria.status')}
                        onChange={(event) => setEditStatus(event.target.value as TaskStatus)}
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground w-full max-w-[min(18rem,40vw)]"
                    >
                        <option value="inbox">{t('status.inbox')}</option>
                        <option value="next">{t('status.next')}</option>
                        <option value="waiting">{t('status.waiting')}</option>
                        <option value="someday">{t('status.someday')}</option>
                        {editStatus === 'reference' && (
                            <option value="reference">{t('status.reference')}</option>
                        )}
                        <option value="done">{t('status.done')}</option>
                        <option value="archived">{t('status.archived')}</option>
                    </select>
                </div>
            );
        case 'priority':
            return (
                <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.priorityLabel')}</label>
                    <select
                        value={editPriority}
                        aria-label={t('taskEdit.priorityLabel')}
                        onChange={(e) => setEditPriority(e.target.value as TaskPriority | '')}
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                    >
                        <option value="">{t('common.none')}</option>
                        <option value="low">{t('priority.low')}</option>
                        <option value="medium">{t('priority.medium')}</option>
                        <option value="high">{t('priority.high')}</option>
                        <option value="urgent">{t('priority.urgent')}</option>
                    </select>
                </div>
            );
        case 'energyLevel':
            return (
                <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.energyLevel')}</label>
                    <select
                        value={editEnergyLevel}
                        aria-label={t('taskEdit.energyLevel')}
                        onChange={(e) => setEditEnergyLevel(e.target.value as TaskEnergyLevel | '')}
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                    >
                        <option value="">{t('common.none')}</option>
                        <option value="low">{t('energyLevel.low')}</option>
                        <option value="medium">{t('energyLevel.medium')}</option>
                        <option value="high">{t('energyLevel.high')}</option>
                    </select>
                </div>
            );
        case 'assignedTo':
            return (
                <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.assignedTo')}</label>
                    <input
                        type="text"
                        value={editAssignedTo}
                        aria-label={t('taskEdit.assignedTo')}
                        onChange={(event) => setEditAssignedTo(event.target.value)}
                        placeholder={t('taskEdit.assignedToPlaceholder')}
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                    />
                </div>
            );
        case 'recurrence':
            return (
                <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.recurrenceLabel')}</label>
                    <select
                        value={editRecurrence}
                        aria-label={t('task.aria.recurrence')}
                        onChange={(e) => {
                            const value = e.target.value as RecurrenceRule | '';
                            setEditRecurrence(value);
                            if (value === 'daily') {
                                const parsed = parseRRuleString(editRecurrenceRRule);
                                if (!editRecurrenceRRule || parsed.rule !== 'daily') {
                                    setEditRecurrenceRRule(buildRRuleString('daily'));
                                }
                            }
                            if (value === 'weekly') {
                                const parsed = parseRRuleString(editRecurrenceRRule);
                                if (!editRecurrenceRRule || parsed.rule !== 'weekly') {
                                    setEditRecurrenceRRule(buildRRuleString('weekly'));
                                }
                            }
                            if (value === 'monthly') {
                                const parsed = parseRRuleString(editRecurrenceRRule);
                                if (!editRecurrenceRRule || parsed.rule !== 'monthly') {
                                    setEditRecurrenceRRule(buildRRuleString('monthly'));
                                }
                            }

                            if (!value) {
                                setEditRecurrenceRRule('');
                            }
                        }}
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground"
                    >
                        <option value="">{t('recurrence.none')}</option>
                        <option value="daily">{t('recurrence.daily')}</option>
                        <option value="weekly">{t('recurrence.weekly')}</option>
                        <option value="monthly">{t('recurrence.monthly')}</option>
                        <option value="yearly">{t('recurrence.yearly')}</option>
                    </select>
                    {editRecurrence === 'daily' && (
                        <div className="flex items-center gap-2 pt-1">
                            <span className="text-[10px] text-muted-foreground">{t('recurrence.repeatEvery')}</span>
                            <input
                                type="number"
                                min={1}
                                max={365}
                                value={Math.max(parseRRuleString(editRecurrenceRRule).interval ?? 1, 1)}
                                onChange={(event) => {
                                    const intervalValue = Number(event.target.valueAsNumber);
                                    const safeInterval = Number.isFinite(intervalValue) && intervalValue > 0
                                        ? Math.min(Math.round(intervalValue), 365)
                                        : 1;
                                    setEditRecurrenceRRule(buildRRuleString('daily', undefined, safeInterval));
                                }}
                                className="w-20 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                            />
                            <span className="text-[10px] text-muted-foreground">{t('recurrence.dayUnit')}</span>
                        </div>
                    )}
                    {editRecurrence && (
                        <label className="flex items-center gap-2 pt-1 text-[10px] text-muted-foreground">
                            <input
                                type="checkbox"
                                checked={editRecurrenceStrategy === 'fluid'}
                                onChange={(e) => setEditRecurrenceStrategy(e.target.checked ? 'fluid' : 'strict')}
                                className="accent-primary"
                            />
                            {t('recurrence.afterCompletion')}
                        </label>
                    )}
                    {editRecurrence === 'weekly' && (
                        <div className="pt-1">
                            <span className="text-[10px] text-muted-foreground">{t('recurrence.repeatOn')}</span>
                            <WeekdaySelector
                                value={editRecurrenceRRule || buildRRuleString('weekly')}
                                onChange={(rrule) => setEditRecurrenceRRule(rrule)}
                                className="pt-1"
                            />
                        </div>
                    )}
                    {editRecurrence === 'monthly' && (
                        <div className="pt-1 space-y-2">
                            <span className="text-[10px] text-muted-foreground">{t('recurrence.repeatOn')}</span>
                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => setEditRecurrenceRRule(buildRRuleString('monthly'))}
                                    className={cn(
                                        'text-[10px] px-2 py-1 rounded border transition-colors',
                                        monthlyRecurrence.pattern === 'date'
                                            ? 'bg-primary text-primary-foreground border-primary'
                                            : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
                                    )}
                                >
                                    {t('recurrence.monthlyOnDay')}
                                </button>
                                <button
                                    type="button"
                                    onClick={openCustomRecurrence}
                                    className={cn(
                                        'text-[10px] px-2 py-1 rounded border transition-colors',
                                        monthlyRecurrence.pattern === 'custom'
                                            ? 'bg-primary text-primary-foreground border-primary'
                                            : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
                                    )}
                                >
                                    {t('recurrence.custom')}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            );
        case 'timeEstimate':
            return (
                <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.timeEstimateLabel')}</label>
                    <select
                        value={editTimeEstimate}
                        aria-label={t('task.aria.timeEstimate')}
                        onChange={(e) => setEditTimeEstimate(e.target.value as TimeEstimate | '')}
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground"
                    >
                        <option value="">{t('common.none')}</option>
                        <option value="5min">5m</option>
                        <option value="10min">10m</option>
                        <option value="15min">15m</option>
                        <option value="30min">30m</option>
                        <option value="1hr">1h</option>
                        <option value="2hr">2h</option>
                        <option value="3hr">3h</option>
                        <option value="4hr">4h</option>
                        <option value="4hr+">4h+</option>
                    </select>
                </div>
            );
        case 'contexts':
            return (
                <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.contextsLabel')}</label>
                    <input
                        type="text"
                        aria-label={t('task.aria.contexts')}
                        value={editContexts}
                        onChange={(e) => setEditContexts(e.target.value)}
                        placeholder="@home, @work"
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground placeholder:text-muted-foreground"
                    />
                    <div className="flex flex-wrap gap-2 pt-1">
                        {popularContextOptions.map(tag => {
                            const currentTags = editContexts.split(',').map(t => t.trim()).filter(Boolean);
                            const isActive = currentTags.includes(tag);
                            return (
                                <button
                                    key={tag}
                                    type="button"
                                    onClick={() => {
                                        let newTags;
                                        if (isActive) {
                                            newTags = currentTags.filter(t => t !== tag);
                                        } else {
                                            newTags = [...currentTags, tag];
                                        }
                                        setEditContexts(newTags.join(', '));
                                    }}
                                    className={cn(
                                        "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                                        isActive
                                            ? "bg-primary/10 border-primary text-primary"
                                            : "bg-transparent border-border text-muted-foreground hover:border-primary/50"
                                    )}
                                >
                                    {tag}
                                </button>
                            );
                        })}
                    </div>
                </div>
            );
        case 'tags':
            return (
                <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.tagsLabel')}</label>
                    <input
                        type="text"
                        aria-label={t('task.aria.tags')}
                        value={editTags}
                        onChange={(e) => setEditTags(e.target.value)}
                        placeholder="#urgent, #idea"
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground placeholder:text-muted-foreground"
                    />
                    <div className="flex flex-wrap gap-2 pt-1">
                        {popularTagOptions.map(tag => {
                            const currentTags = editTags.split(',').map(t => t.trim()).filter(Boolean);
                            const isActive = currentTags.includes(tag);
                            return (
                                <button
                                    key={tag}
                                    type="button"
                                    onClick={() => {
                                        let newTags;
                                        if (isActive) {
                                            newTags = currentTags.filter(t => t !== tag);
                                        } else {
                                            newTags = [...currentTags, tag];
                                        }
                                        setEditTags(newTags.join(', '));
                                    }}
                                    className={cn(
                                        "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                                        isActive
                                            ? "bg-primary/10 border-primary text-primary"
                                            : "bg-transparent border-border text-muted-foreground hover:border-primary/50"
                                    )}
                                >
                                    {tag}
                                </button>
                            );
                        })}
                    </div>
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
