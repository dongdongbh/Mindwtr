import { Calendar as CalendarIcon, Tag, Trash2, ArrowRight, Repeat, Check, Clock, Timer, Paperclip, Pencil } from 'lucide-react';
import type { Attachment, Project, Task, TaskPriority, TaskStatus, RecurrenceRule, RecurrenceStrategy } from '@mindwtr/core';
import { getChecklistProgress, getTaskAgeLabel, getTaskStaleness, getTaskUrgency, safeFormatDate, stripMarkdown } from '@mindwtr/core';
import { cn } from '../../lib/utils';

interface TaskItemDisplayProps {
    task: Task;
    project?: Project;
    projectColor?: string;
    selectionMode: boolean;
    isViewOpen: boolean;
    onToggleSelect?: () => void;
    onToggleView: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onStatusChange: (status: TaskStatus) => void;
    openAttachment: (attachment: Attachment) => void;
    visibleAttachments: Attachment[];
    recurrenceRule: RecurrenceRule | '';
    recurrenceStrategy: RecurrenceStrategy;
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    isStagnant: boolean;
    showQuickDone: boolean;
    t: (key: string) => string;
}

const getUrgencyColor = (task: Task) => {
    const urgency = getTaskUrgency(task);
    switch (urgency) {
        case 'overdue': return 'text-destructive font-bold';
        case 'urgent': return 'text-orange-500 font-medium';
        case 'upcoming': return 'text-yellow-600';
        default: return 'text-muted-foreground';
    }
};

const getPriorityBadge = (priority: TaskPriority) => {
    switch (priority) {
        case 'low':
            return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
        case 'medium':
            return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
        case 'high':
            return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400';
        case 'urgent':
            return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
        default:
            return 'bg-muted text-muted-foreground';
    }
};

export function TaskItemDisplay({
    task,
    project,
    projectColor,
    selectionMode,
    isViewOpen,
    onToggleSelect,
    onToggleView,
    onEdit,
    onDelete,
    onStatusChange,
    openAttachment,
    visibleAttachments,
    recurrenceRule,
    recurrenceStrategy,
    prioritiesEnabled,
    timeEstimatesEnabled,
    isStagnant,
    showQuickDone,
    t,
}: TaskItemDisplayProps) {
    const checklistProgress = getChecklistProgress(task);
    const ageLabel = getTaskAgeLabel(task.createdAt);
    const showCompactMeta = !isViewOpen
        && ['inbox', 'next', 'someday', 'waiting'].includes(task.status)
        && (project || (task.contexts?.length ?? 0) > 0);

    return (
        <div className="flex-1 min-w-0 flex items-start justify-between gap-3">
            <div
                className={cn(
                    "group/content rounded -ml-2 pl-2 pr-1 py-1 transition-colors",
                    selectionMode ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
                )}
            >
                <button
                    type="button"
                    data-task-edit-trigger
                    onClick={onEdit}
                    className="sr-only"
                    aria-hidden="true"
                    tabIndex={-1}
                />
                <button
                    type="button"
                    onClick={() => {
                        if (selectionMode) {
                            onToggleSelect?.();
                            return;
                        }
                        onToggleView();
                    }}
                    onDoubleClick={() => {
                        if (!selectionMode) {
                            onEdit();
                        }
                    }}
                    className={cn(
                        "w-full text-left rounded px-0.5 py-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40",
                        selectionMode ? "cursor-pointer" : "cursor-default"
                    )}
                    aria-expanded={isViewOpen}
                    aria-label="Toggle task details"
                >
                    <div
                        className={cn(
                            "text-base font-medium truncate group-hover/content:text-primary transition-colors",
                            task.status === 'done' && "line-through text-muted-foreground"
                        )}
                    >
                        {task.title}
                    </div>
                    {task.description && (
                        <p className="text-sm text-muted-foreground mt-1">
                            {stripMarkdown(task.description)}
                        </p>
                    )}
                    {showCompactMeta && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {project && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-foreground">
                                    <span
                                        className="inline-block h-2 w-2 rounded-full"
                                        style={{ backgroundColor: projectColor || '#94a3b8' }}
                                    />
                                    {project.title}
                                </span>
                            )}
                            {(task.contexts ?? []).slice(0, 3).map((ctx) => (
                                <span key={ctx} className="truncate">
                                    {ctx}
                                </span>
                            ))}
                        </div>
                    )}
                </button>

                {isViewOpen && (
                    <div onClick={(e) => e.stopPropagation()}>
                        {visibleAttachments.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-muted-foreground">
                                <Paperclip className="w-3 h-3" />
                                {visibleAttachments.map((attachment) => (
                                    <button
                                        key={attachment.id}
                                        type="button"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            openAttachment(attachment);
                                        }}
                                        className="truncate hover:underline"
                                        title={attachment.title}
                                    >
                                        {attachment.title}
                                    </button>
                                ))}
                            </div>
                        )}

                        <div className="flex flex-wrap items-center gap-4 mt-2 text-xs">
                            {project && (
                                <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/50 text-accent-foreground font-medium text-[10px]">
                                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: projectColor || '#94a3b8' }} />
                                    {project.title}
                                </div>
                            )}
                            {task.startTime && (
                                <div className="flex items-center gap-1 text-blue-500/80" title={t('taskEdit.startDateLabel')}>
                                    <ArrowRight className="w-3 h-3" />
                                    {safeFormatDate(task.startTime, 'MMM d, HH:mm')}
                                </div>
                            )}
                            {task.dueDate && (
                                <div
                                    className={cn("flex items-center gap-1", getUrgencyColor(task), isStagnant && "text-muted-foreground/70")}
                                    title={t('taskEdit.dueDateLabel')}
                                >
                                    <CalendarIcon className="w-3 h-3" />
                                    {safeFormatDate(task.dueDate, 'MMM d, HH:mm')}
                                    {isStagnant && (
                                        <span
                                            className="ml-1 text-[10px] text-muted-foreground"
                                            title={`${t('taskEdit.pushCountHint')}: ${task.pushCount ?? 0}`}
                                        >
                                            ⏳ {task.pushCount}
                                        </span>
                                    )}
                                </div>
                            )}
                            {task.location && (
                                <div className="flex items-center gap-1 text-muted-foreground" title={t('taskEdit.locationLabel')}>
                                    <span className="font-medium">📍 {task.location}</span>
                                </div>
                            )}
                            {recurrenceRule && (
                                <div className="flex items-center gap-1 text-purple-600" title={t('taskEdit.recurrenceLabel')}>
                                    <Repeat className="w-3 h-3" />
                                    <span>
                                        {t(`recurrence.${recurrenceRule}`)}
                                        {recurrenceStrategy === 'fluid' ? ` · ${t('recurrence.afterCompletionShort')}` : ''}
                                    </span>
                                </div>
                            )}
                            {prioritiesEnabled && task.priority && (
                                <div
                                    className={cn(
                                        "flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide",
                                        getPriorityBadge(task.priority)
                                    )}
                                    title={t('taskEdit.priorityLabel')}
                                >
                                    {t(`priority.${task.priority}`)}
                                </div>
                            )}
                            {task.contexts?.length > 0 && (
                                <div className="flex items-center gap-2">
                                    {task.contexts.map(ctx => (
                                        <span key={ctx} className="text-muted-foreground hover:text-foreground transition-colors">
                                            {ctx}
                                        </span>
                                    ))}
                                </div>
                            )}
                            {task.tags.length > 0 && (
                                <div className="flex items-center gap-1 text-muted-foreground">
                                    <Tag className="w-3 h-3" />
                                    {task.tags.join(', ')}
                                </div>
                            )}
                            {checklistProgress && (
                                <div
                                    className="flex items-center gap-2 text-muted-foreground"
                                    title={t('checklist.progress')}
                                >
                                    <span className="font-medium">
                                        {checklistProgress.completed}/{checklistProgress.total}
                                    </span>
                                    <div className="w-16 h-1 bg-muted rounded overflow-hidden">
                                        <div
                                            className="h-full bg-primary"
                                            style={{ width: `${Math.round(checklistProgress.percent * 100)}%` }}
                                        />
                                    </div>
                                </div>
                            )}
                            {task.status !== 'done' && ageLabel && (
                                <div className={cn(
                                    "flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full",
                                    getTaskStaleness(task.createdAt) === 'fresh' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
                                    getTaskStaleness(task.createdAt) === 'aging' && 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
                                    getTaskStaleness(task.createdAt) === 'stale' && 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
                                    getTaskStaleness(task.createdAt) === 'very-stale' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                )} title="Task age">
                                    <Clock className="w-3 h-3" />
                                    {ageLabel}
                                </div>
                            )}
                            {timeEstimatesEnabled && task.timeEstimate && (
                                <div className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" title="Estimated time">
                                    <Timer className="w-3 h-3" />
                                    {String(task.timeEstimate).endsWith('min')
                                        ? String(task.timeEstimate).replace('min', 'm')
                                        : String(task.timeEstimate).endsWith('hr+')
                                            ? String(task.timeEstimate).replace('hr+', 'h+')
                                            : String(task.timeEstimate).endsWith('hr')
                                                ? String(task.timeEstimate).replace('hr', 'h')
                                                : String(task.timeEstimate)}
                                </div>
                            )}
                        </div>

                        {(task.checklist || []).length > 0 && (
                            <div
                                className="mt-3 space-y-1 pl-1"
                                onPointerDown={(e) => e.stopPropagation()}
                            >
                                {(task.checklist || []).map((item, index) => (
                                    <div key={item.id || index} className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <span
                                            className={cn(
                                                "w-3 h-3 border rounded flex items-center justify-center",
                                                item.isCompleted
                                                    ? "bg-primary border-primary text-primary-foreground"
                                                    : "border-muted-foreground"
                                            )}
                                        >
                                            {item.isCompleted && <Check className="w-2 h-2" />}
                                        </span>
                                        <span className={cn(item.isCompleted && "line-through")}>{item.title}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {!selectionMode && (
                <div
                    className="relative flex items-center gap-2"
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={onEdit}
                        aria-label={t('common.edit')}
                        className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50"
                    >
                        <Pencil className="w-4 h-4" />
                    </button>
                    {showQuickDone && task.status !== 'done' && (
                        <button
                            type="button"
                            onClick={() => onStatusChange('done')}
                            aria-label={t('status.done')}
                            className="text-emerald-400 hover:text-emerald-300 p-1 rounded hover:bg-emerald-500/20"
                        >
                            <Check className="w-4 h-4" />
                        </button>
                    )}
                    <select
                        value={task.status}
                        aria-label="Task status"
                        onChange={(e) => onStatusChange(e.target.value as TaskStatus)}
                        className="text-xs px-2 py-1 rounded cursor-pointer bg-muted/50 text-foreground border border-border hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                        <option value="inbox">{t('status.inbox')}</option>
                        <option value="next">{t('status.next')}</option>
                        <option value="waiting">{t('status.waiting')}</option>
                        <option value="someday">{t('status.someday')}</option>
                        <option value="done">{t('status.done')}</option>
                    </select>
                    <button
                        onClick={onDelete}
                        aria-label="Delete task"
                        className="text-red-400 hover:text-red-300 p-1 rounded hover:bg-red-500/20"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            )}
        </div>
    );
}
