import { Check, Link2, Paperclip, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    buildRRuleString,
    generateUUID,
    hasTimeComponent,
    parseRRuleString,
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
import { Markdown } from '../Markdown';
import { WeekdaySelector } from './TaskForm/WeekdaySelector';

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
        popularTagOptions,
    } = data;
    const {
        toggleDescriptionPreview,
        setEditDescription,
        addFileAttachment,
        addLinkAttachment,
        openAttachment,
        removeAttachment,
        setEditStartTime,
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

    const [checklistDraft, setChecklistDraft] = useState<Task['checklist']>(task.checklist || []);
    const checklistDraftRef = useRef<Task['checklist']>(task.checklist || []);
    const checklistDirtyRef = useRef(false);
    const checklistInputRefs = useRef<Array<HTMLInputElement | null>>([]);

    useEffect(() => {
        setChecklistDraft(task.checklist || []);
        checklistDraftRef.current = task.checklist || [];
        checklistDirtyRef.current = false;
        checklistInputRefs.current = [];
    }, [task.id, task.checklist]);

    const updateChecklistDraft = useCallback((next: Task['checklist']) => {
        setChecklistDraft(next);
        checklistDraftRef.current = next;
        checklistDirtyRef.current = true;
    }, []);

    const commitChecklistDraft = useCallback((next?: Task['checklist']) => {
        const payload = next ?? checklistDraftRef.current;
        if (!checklistDirtyRef.current && next === undefined) return;
        checklistDirtyRef.current = false;
        updateTask(taskId, { checklist: payload });
    }, [taskId, updateTask]);

    useEffect(() => () => {
        if (checklistDirtyRef.current) {
            updateTask(taskId, { checklist: checklistDraftRef.current });
        }
    }, [taskId, updateTask]);

    const focusChecklistIndex = useCallback((index: number) => {
        window.requestAnimationFrame(() => {
            checklistInputRefs.current[index]?.focus();
        });
    }, []);

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
                        <div className="text-xs bg-muted/30 border border-border rounded px-2 py-2">
                            <Markdown markdown={editDescription || ''} />
                        </div>
                        ) : (
                            <textarea
                                aria-label={t('task.aria.description')}
                                value={editDescription}
                                onChange={(e) => setEditDescription(e.target.value)}
                                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 min-h-[60px] resize-y"
                                placeholder={t('taskEdit.descriptionPlaceholder')}
                            />
                        )}
                    </div>
            );
        case 'attachments':
            return (
                <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <label className="text-xs text-muted-foreground font-medium">{t('attachments.title')}</label>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={addFileAttachment}
                                    className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors flex items-center gap-1"
                                >
                                    <Paperclip className="w-3 h-3" />
                                    {t('attachments.addFile')}
                                </button>
                                <button
                                    type="button"
                                    onClick={addLinkAttachment}
                                    className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors flex items-center gap-1"
                                >
                                    <Link2 className="w-3 h-3" />
                                    {t('attachments.addLink')}
                            </button>
                        </div>
                    </div>
                    {attachmentError && (
                        <div className="text-xs text-red-400">{attachmentError}</div>
                    )}
                    {visibleEditAttachments.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t('common.none')}</p>
                    ) : (
                        <div className="space-y-1">
                            {visibleEditAttachments.map((attachment) => (
                                <div key={attachment.id} className="flex items-center justify-between gap-2 text-xs">
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            openAttachment(attachment);
                                        }}
                                        className="truncate text-primary hover:underline"
                                        title={attachment.title}
                                    >
                                        {attachment.title}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => removeAttachment(attachment.id)}
                                        className="text-muted-foreground hover:text-foreground"
                                    >
                                        {t('attachments.remove')}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            );
        case 'startTime':
            {
                const hasTime = hasTimeComponent(editStartTime);
                const parsed = editStartTime ? safeParseDate(editStartTime) : null;
                const dateValue = parsed ? safeFormatDate(parsed, 'yyyy-MM-dd') : '';
                const timeValue = hasTime && parsed ? safeFormatDate(parsed, 'HH:mm') : '';
                const handleDateChange = (value: string) => {
                    if (!value) {
                        setEditStartTime('');
                        return;
                    }
                    if (hasTime && timeValue) {
                        setEditStartTime(`${value}T${timeValue}`);
                        return;
                    }
                    setEditStartTime(value);
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
        case 'reviewAt':
            return (
                <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.reviewDateLabel')}</label>
                    <input
                        type="datetime-local"
                        aria-label={t('task.aria.reviewDate')}
                        value={editReviewAt}
                        onChange={(e) => setEditReviewAt(e.target.value)}
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                    />
                </div>
            );
        case 'status':
            return (
                <div className="flex flex-col gap-1">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.statusLabel')}</label>
                    <select
                            value={editStatus}
                            aria-label={t('task.aria.status')}
                            onChange={(event) => setEditStatus(event.target.value as TaskStatus)}
                            className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                        >
                            <option value="inbox">{t('status.inbox')}</option>
                            <option value="next">{t('status.next')}</option>
                        <option value="waiting">{t('status.waiting')}</option>
                        <option value="someday">{t('status.someday')}</option>
                        <option value="done">{t('status.done')}</option>
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
                            <span className="text-[10px] text-muted-foreground">Repeat on</span>
                            <WeekdaySelector
                                value={editRecurrenceRRule || buildRRuleString('weekly')}
                                onChange={(rrule) => setEditRecurrenceRRule(rrule)}
                                className="pt-1"
                            />
                        </div>
                    )}
                    {editRecurrence === 'monthly' && (
                        <div className="pt-1 space-y-2">
                            <span className="text-[10px] text-muted-foreground">Repeat on</span>
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
                        {['@home', '@work', '@errands', '@computer', '@phone'].map(tag => {
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
                <div className="flex flex-col gap-2 w-full pt-2 border-t border-border/50">
                    <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.checklist')}</label>
                    <div className="space-y-2">
                        {(checklistDraft || []).map((item, index) => (
                            <div key={item.id || index} className="flex items-center gap-2 group/item">
                                <button
                                    type="button"
                                    onClick={() => {
                                        const newList = (checklistDraft || []).map((entry, i) =>
                                            i === index ? { ...entry, isCompleted: !entry.isCompleted } : entry
                                        );
                                        setChecklistDraft(newList);
                                        checklistDraftRef.current = newList;
                                        checklistDirtyRef.current = false;
                                        updateTask(taskId, { checklist: newList });
                                    }}
                                    className={cn(
                                        "w-4 h-4 border rounded flex items-center justify-center transition-colors",
                                        item.isCompleted
                                            ? "bg-primary border-primary text-primary-foreground"
                                            : "border-muted-foreground hover:border-primary"
                                    )}
                                >
                                    {item.isCompleted && <Check className="w-3 h-3" />}
                                </button>
                                <input
                                    type="text"
                                    value={item.title}
                                    ref={(node) => {
                                        checklistInputRefs.current[index] = node;
                                    }}
                                    onChange={(e) => {
                                        const newList = (checklistDraft || []).map((entry, i) =>
                                            i === index ? { ...entry, title: e.target.value } : entry
                                        );
                                        updateChecklistDraft(newList);
                                    }}
                                    onBlur={() => {
                                        commitChecklistDraft();
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            const newItem = {
                                                id: generateUUID(),
                                                title: '',
                                                isCompleted: false,
                                            };
                                            const nextList = [...(checklistDraft || [])];
                                            nextList.splice(index + 1, 0, newItem);
                                            setChecklistDraft(nextList);
                                            checklistDraftRef.current = nextList;
                                            checklistDirtyRef.current = false;
                                            updateTask(taskId, { checklist: nextList });
                                            focusChecklistIndex(index + 1);
                                            return;
                                        }
                                        if (e.key === 'Tab') {
                                            const nextIndex = e.shiftKey ? index - 1 : index + 1;
                                            if (nextIndex >= 0 && nextIndex < (checklistDraft || []).length) {
                                                e.preventDefault();
                                                focusChecklistIndex(nextIndex);
                                            } else {
                                                commitChecklistDraft();
                                            }
                                        }
                                    }}
                                    className={cn(
                                        "flex-1 bg-transparent text-sm focus:outline-none border-b border-transparent focus:border-primary/50 px-1",
                                        item.isCompleted && "text-muted-foreground line-through"
                                    )}
                                    placeholder={t('taskEdit.itemNamePlaceholder')}
                                />
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    onClick={() => {
                                        const newList = (checklistDraft || []).filter((_, i) => i !== index);
                                        setChecklistDraft(newList);
                                        checklistDraftRef.current = newList;
                                        checklistDirtyRef.current = false;
                                        updateTask(taskId, { checklist: newList });
                                    }}
                                    className="opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive p-1"
                                >
                                    <Trash2 className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                        <button
                            type="button"
                            tabIndex={-1}
                            onClick={() => {
                                const newItem = {
                                    id: generateUUID(),
                                    title: '',
                                    isCompleted: false,
                                };
                                const nextList = [...(checklistDraft || []), newItem];
                                setChecklistDraft(nextList);
                                checklistDraftRef.current = nextList;
                                checklistDirtyRef.current = false;
                                updateTask(taskId, { checklist: nextList });
                                focusChecklistIndex(nextList.length - 1);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const newItem = {
                                        id: generateUUID(),
                                        title: '',
                                        isCompleted: false,
                                    };
                                    const nextList = [...(checklistDraft || []), newItem];
                                    setChecklistDraft(nextList);
                                    checklistDraftRef.current = nextList;
                                    checklistDirtyRef.current = false;
                                    updateTask(taskId, { checklist: nextList });
                                    focusChecklistIndex(nextList.length - 1);
                                }
                            }}
                            className="text-xs text-blue-500 hover:text-blue-600 font-medium flex items-center gap-1"
                        >
                            <Plus className="w-3 h-3" />
                            {t('taskEdit.addItem')}
                        </button>
                        {(checklistDraft || []).length > 0 && (
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    onClick={() => resetTaskChecklist(taskId)}
                                    className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                                >
                                    {t('taskEdit.resetChecklist')}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            );
        default:
            return null;
    }
}
