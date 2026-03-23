import { useEffect, useState } from 'react';
import {
    buildRRuleString,
    hasTimeComponent,
    parseRRuleString,
    resolveAutoTextDirection,
    safeFormatDate,
    safeParseDate,
    type Attachment,
    type RecurrenceRule,
    type RecurrenceStrategy,
    type Task,
    type TaskEditorFieldId,
    type TaskPriority,
    type TaskStatus,
    type TimeEstimate,
} from '@mindwtr/core';

import { cn } from '../../lib/utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { WeekdaySelector } from './TaskForm/WeekdaySelector';
import { AttachmentsField } from './TaskForm/AttachmentsField';
import { ChecklistField } from './TaskForm/ChecklistField';
import { normalizeDateInputValue } from './task-item-helpers';

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
    useEffect(() => {
        const parsed = editReviewAt ? safeParseDate(editReviewAt) : null;
        const hasTime = hasTimeComponent(editReviewAt);
        const next = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
        setReviewTimeDraft(next);
    }, [editReviewAt]);
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

    switch (fieldId) {
        case 'description':
            return (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.descriptionLabel')}</label>
                        <button
                            type="button"
                            onClick={toggleDescriptionPreview}
                            className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                        >
                            {showDescriptionPreview ? t('markdown.edit') : t('markdown.preview')}
                        </button>
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
                        <textarea
                            aria-label={t('task.aria.description')}
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            className={cn("text-xs bg-muted/50 border border-border rounded px-2 py-1 min-h-[60px] resize-y", isRtl && "text-right")}
                            placeholder={t('taskEdit.descriptionPlaceholder')}
                            dir={resolvedDirection}
                        />
                    )}
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
                return (
                    <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.startDateLabel')}</label>
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                aria-label={t('task.aria.startDate')}
                                value={dateValue}
                                onChange={(e) => handleDateChange(e.target.value)}
                                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                            />
                            <input
                                type="time"
                                aria-label={t('task.aria.startTime')}
                                value={timeValue}
                                onChange={(e) => handleTimeChange(e.target.value)}
                                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                            />
                        </div>
                    </div>
                );
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
                return (
                    <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.dueDateLabel')}</label>
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                aria-label={t('task.aria.dueDate')}
                                value={dateValue}
                                onChange={(e) => handleDateChange(e.target.value)}
                                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                            />
                            <input
                                type="time"
                                aria-label={t('task.aria.dueTime')}
                                value={timeValue}
                                onChange={(e) => handleTimeChange(e.target.value)}
                                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                            />
                        </div>
                    </div>
                );
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
                return (
                    <div className="flex flex-col gap-1">
                        <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.reviewDateLabel')}</label>
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                aria-label={t('task.aria.reviewDate')}
                                value={dateValue}
                                onChange={(e) => handleDateChange(e.target.value)}
                                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                            />
                            <input
                                type="text"
                                aria-label={t('task.aria.reviewTime')}
                                value={reviewTimeDraft}
                                inputMode="numeric"
                                placeholder="HH:MM"
                                onChange={(e) => setReviewTimeDraft(e.target.value)}
                                onBlur={() => {
                                    const normalized = normalizeTimeInput(reviewTimeDraft);
                                    if (normalized === null) {
                                        setReviewTimeDraft(timeValue);
                                        return;
                                    }
                                    setReviewTimeDraft(normalized);
                                    handleTimeChange(normalized);
                                }}
                                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                            />
                        </div>
                    </div>
                );
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
