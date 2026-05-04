import { Calendar as CalendarIcon, Tag, Trash2, ArrowRight, Repeat, Check, Clock, Timer, Paperclip, RotateCcw, Copy, MapPin, Hourglass, BookOpen, PauseCircle, Star, Zap, MoreHorizontal } from 'lucide-react';
import type { Area, Attachment, Project, Task, TaskStatus, RecurrenceRule, RecurrenceStrategy, Language } from '@mindwtr/core';
import { DEFAULT_AREA_COLOR, getChecklistProgress, getRecurrenceCountValue, getRecurrenceUntilValue, getTaskAgeLabel, getTaskStaleness, getTaskUrgency, hasTimeComponent, parseRRuleString, safeFormatDate, resolveTaskTextDirection, tFallback } from '@mindwtr/core';
import { cn } from '../../lib/utils';
import { getAttachmentDisplayTitle } from '../../lib/attachment-utils';
import { getContextColor } from '../../lib/context-color';
import { MetadataBadge } from '../ui/MetadataBadge';
import { AttachmentProgressIndicator } from '../AttachmentProgressIndicator';
import { RichMarkdown } from '../RichMarkdown';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { memo, useEffect, useRef } from 'react';
import { isImageAttachment } from './task-item-attachment-utils';
import { AttachmentImage } from './AttachmentImage';

interface TaskItemDisplayActions {
    onToggleSelect?: () => void;
    onToggleView: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onDuplicate: () => void;
    onStatusChange: (status: TaskStatus) => void;
    onOpenQuickActions?: (event: MouseEvent<HTMLButtonElement>) => void;
    onMoveToWaitingWithPrompt?: () => void;
    onOpenProject?: (projectId: string) => void;
    openAttachment: (attachment: Attachment) => void;
    onToggleChecklistItem?: (index: number) => void;
    focusToggle?: {
        isFocused: boolean;
        canToggle: boolean;
        onToggle: () => void;
        title: string;
        ariaLabel: string;
        alwaysVisible?: boolean;
    };
}

interface TaskItemDisplayProps {
    task: Task;
    language: Language;
    project?: Project;
    area?: Area;
    projectColor?: string;
    selectionMode: boolean;
    isViewOpen: boolean;
    quickActionsOpen?: boolean;
    actions: TaskItemDisplayActions;
    visibleAttachments: Attachment[];
    recurrenceRule: RecurrenceRule | '';
    recurrenceStrategy: RecurrenceStrategy;
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    isStagnant: boolean;
    showQuickDone: boolean;
    showStatusSelect?: boolean;
    showProjectBadgeInActions?: boolean;
    readOnly: boolean;
    compactMetaEnabled?: boolean;
    dense?: boolean;
    actionsOverlay?: boolean;
    dragHandle?: ReactNode;
    showTaskAge?: boolean;
    showHoverHint?: boolean;
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

const formatTimeEstimate = (estimate: string) => {
    const value = String(estimate);
    if (value.endsWith('min')) return value.replace('min', 'm');
    if (value.endsWith('hr+')) return value.replace('hr+', 'h+');
    if (value.endsWith('hr')) return value.replace('hr', 'h');
    return value;
};

export const TaskItemDisplay = memo(function TaskItemDisplay({
    task,
    language,
    project,
    area,
    projectColor,
    selectionMode,
    isViewOpen,
    quickActionsOpen = false,
    actions,
    visibleAttachments,
    recurrenceRule,
    recurrenceStrategy,
    prioritiesEnabled,
    timeEstimatesEnabled,
    isStagnant,
    showQuickDone,
    showStatusSelect = true,
    showProjectBadgeInActions = true,
    readOnly,
    compactMetaEnabled = true,
    dense = false,
    actionsOverlay = false,
    dragHandle,
    showTaskAge = false,
    showHoverHint = true,
    t,
}: TaskItemDisplayProps) {
    const {
        onToggleSelect,
        onToggleView,
        onEdit,
        onDelete,
        onDuplicate,
        onStatusChange,
        onOpenQuickActions,
        onMoveToWaitingWithPrompt,
        onOpenProject,
        openAttachment,
        onToggleChecklistItem,
        focusToggle,
    } = actions;
    const checklistProgress = getChecklistProgress(task);
    const recurrenceCount = getRecurrenceCountValue(task.recurrence);
    const recurrenceUntil = getRecurrenceUntilValue(task.recurrence);
    const recurrenceInterval = task.recurrence && typeof task.recurrence === 'object' && task.recurrence.rrule
        ? parseRRuleString(task.recurrence.rrule).interval
        : undefined;
    const recurrenceLabel = recurrenceRule
        ? [
            `${t(`recurrence.${recurrenceRule}`)}${recurrenceStrategy === 'fluid' ? ` · ${t('recurrence.afterCompletionShort')}` : ''}`,
            recurrenceRule === 'weekly' && recurrenceInterval && recurrenceInterval > 1
                ? `${t('recurrence.repeatEvery')} ${recurrenceInterval} ${t('recurrence.weekUnit')}`
                : undefined,
            recurrenceRule === 'monthly' && recurrenceInterval && recurrenceInterval > 1
                ? `${t('recurrence.repeatEvery')} ${recurrenceInterval} ${t('recurrence.monthUnit')}`
                : undefined,
            recurrenceUntil ? `${t('recurrence.endsOnDate')} ${safeFormatDate(recurrenceUntil, 'P')}` : undefined,
            recurrenceCount ? `${t('recurrence.endsAfterCount')} ${recurrenceCount} ${t('recurrence.occurrenceUnit')}` : undefined,
        ].filter(Boolean).join(' · ')
        : '';
    const ageLabel = getTaskAgeLabel(task.createdAt, language);
    const showCompactMeta = compactMetaEnabled && !isViewOpen;
    const showAgeBadge = showTaskAge && task.status !== 'done' && Boolean(ageLabel);
    const hasMetadata = Boolean(
        project
        || area
        || task.startTime
        || task.dueDate
        || task.location
        || recurrenceRule
        || (prioritiesEnabled && task.priority)
        || (task.status !== 'reference' && task.energyLevel)
        || task.assignedTo
        || (task.contexts?.length ?? 0) > 0
        || task.tags.length > 0
        || checklistProgress
        || showAgeBadge
        || (timeEstimatesEnabled && task.timeEstimate)
    );
    const resolvedDirection = resolveTaskTextDirection(task);
    const isRtl = resolvedDirection === 'rtl';
    const hoverHintText = showHoverHint
        ? tFallback(t, 'task.hoverHint', 'Click to toggle details / Double-click to edit')
        : '';
    const moreOptionsLabel = tFallback(t, 'taskEdit.moreOptions', 'More options');
    const moveToWaitingWithDueLabel = tFallback(t, 'task.moveToWaitingWithDue', 'Move to Waiting and set due date');
    const imageAttachments = visibleAttachments.filter((attachment) => {
        if (!isImageAttachment(attachment)) return false;
        if (!attachment.uri) return false;
        return attachment.localStatus !== 'missing';
    });
    const otherAttachments = visibleAttachments.filter((attachment) => !imageAttachments.includes(attachment));
    const clickTimerRef = useRef<number | null>(null);
    const clearClickTimer = () => {
        if (clickTimerRef.current !== null) {
            window.clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
        }
    };
    useEffect(() => {
        return () => {
            clearClickTimer();
        };
    }, []);
    const handleTitleClick = (event: MouseEvent<HTMLButtonElement>) => {
        if (selectionMode) {
            onToggleSelect?.();
            return;
        }
        // Keyboard activation should not be delayed.
        if (event.detail === 0) {
            onToggleView();
            return;
        }
        if (!readOnly && event.detail >= 2) {
            clearClickTimer();
            onEdit();
            return;
        }
        clearClickTimer();
        clickTimerRef.current = window.setTimeout(() => {
            onToggleView();
            clickTimerRef.current = null;
        }, 180);
    };
    const handleTitleDoubleClick = () => {
        if (selectionMode || readOnly) return;
        clearClickTimer();
        onEdit();
    };
    const handleProjectClick = (event: MouseEvent<HTMLSpanElement>, projectId: string) => {
        event.stopPropagation();
        onOpenProject?.(projectId);
    };
    const handleProjectKeyDown = (event: KeyboardEvent<HTMLSpanElement>, projectId: string) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onOpenProject?.(projectId);
        }
    };
    const renderProjectBadge = () => {
        if (!project) return null;
        if (!onOpenProject) {
            return (
                <MetadataBadge
                    variant="project"
                    label={project.title}
                    dotColor={projectColor || DEFAULT_AREA_COLOR}
                />
            );
        }
        return (
            <span
                role="button"
                tabIndex={0}
                onClick={(event) => handleProjectClick(event, project.id)}
                onKeyDown={(event) => handleProjectKeyDown(event, project.id)}
                className="inline-flex metadata-badge--interactive"
                aria-label={`${t('projects.title') || 'Project'}: ${project.title}`}
            >
                <MetadataBadge
                    variant="project"
                    label={project.title}
                    dotColor={projectColor || DEFAULT_AREA_COLOR}
                />
            </span>
        );
    };

    const showQuickDoneButton = showQuickDone
        && !selectionMode
        && !readOnly
        && task.status !== 'done'
        && task.status !== 'archived'
        && task.status !== 'reference';
    const renderMetadataRow = (className?: string) => (
        <div className={cn("flex flex-wrap items-center text-xs", className)}>
            {renderProjectBadge()}
            {!project && area && (
                <MetadataBadge
                    variant="project"
                    label={area.name}
                    dotColor={area.color || DEFAULT_AREA_COLOR}
                />
            )}
            {task.startTime && (
                <MetadataBadge
                    variant="info"
                    icon={ArrowRight}
                    label={safeFormatDate(task.startTime, hasTimeComponent(task.startTime) ? 'Pp' : 'P')}
                />
            )}
            {task.dueDate && (
                <div className="flex items-center gap-2">
                    <MetadataBadge
                        variant="info"
                        icon={CalendarIcon}
                        label={safeFormatDate(task.dueDate, hasTimeComponent(task.dueDate) ? 'Pp' : 'P')}
                        className={cn(getUrgencyColor(task), isStagnant && "text-muted-foreground/70")}
                    />
                    {isStagnant && (
                        <MetadataBadge
                            variant="age"
                            icon={Hourglass}
                            label={`${task.pushCount ?? 0}`}
                        />
                    )}
                </div>
            )}
            {task.location && (
                <MetadataBadge
                    variant="info"
                    icon={MapPin}
                    label={task.location}
                />
            )}
            {recurrenceRule && (
                <MetadataBadge
                    variant="info"
                    icon={Repeat}
                    label={recurrenceLabel}
                />
            )}
            {prioritiesEnabled && task.priority && (
                <MetadataBadge
                    variant="priority"
                    label={t(`priority.${task.priority}`)}
                />
            )}
            {task.status !== 'reference' && task.energyLevel && (
                <MetadataBadge
                    variant="info"
                    icon={Zap}
                    label={t(`energyLevel.${task.energyLevel}`)}
                />
            )}
            {task.assignedTo && (
                <MetadataBadge
                    variant="info"
                    label={`${t('taskEdit.assignedTo')}: ${task.assignedTo}`}
                />
            )}
            {task.contexts?.length > 0 && (
                <div className="flex items-center gap-2">
                    {task.contexts.map((ctx) => (
                        <MetadataBadge key={ctx} variant="context" label={ctx} dotColor={getContextColor(ctx)} />
                    ))}
                </div>
            )}
            {task.tags.length > 0 && (
                <div className="flex items-center gap-2">
                    {task.tags.map((tag) => (
                        <MetadataBadge key={tag} variant="tag" icon={Tag} label={tag} />
                    ))}
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
            {showAgeBadge && (
                <MetadataBadge
                    variant="age"
                    icon={Clock}
                    label={ageLabel!}
                    className={cn(
                        getTaskStaleness(task.createdAt) === 'fresh' && 'metadata-badge--age-fresh',
                        getTaskStaleness(task.createdAt) === 'aging' && 'metadata-badge--age-aging',
                        getTaskStaleness(task.createdAt) === 'stale' && 'metadata-badge--age-stale',
                        getTaskStaleness(task.createdAt) === 'very-stale' && 'metadata-badge--age-very-stale'
                    )}
                />
            )}
            {timeEstimatesEnabled && task.timeEstimate && (
                <MetadataBadge
                    variant="estimate"
                    icon={Timer}
                    label={formatTimeEstimate(task.timeEstimate)}
                />
            )}
        </div>
    );
    const overlayDragHandle = actionsOverlay && !!dragHandle;
    const overlayQuickDone = actionsOverlay && showQuickDoneButton;
    const inlineLeftControls = !actionsOverlay && (showQuickDoneButton || dragHandle);

    return (
        <div className={cn("flex-1 min-w-0 flex items-start gap-3", actionsOverlay && "relative")}>
            {overlayDragHandle && (
                <div
                    className="absolute left-0 top-2 flex items-center -translate-x-2 z-10"
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    {dragHandle}
                </div>
            )}
            {overlayQuickDone && (
                <div
                    className="absolute left-4 top-2 flex items-center z-10"
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            onStatusChange('done');
                        }}
                        aria-label={t('status.done')}
                        className="text-emerald-400 hover:text-emerald-300 p-1 rounded hover:bg-emerald-500/20"
                    >
                        <Check className="w-4 h-4" />
                    </button>
                </div>
            )}
            <div className={cn("flex min-w-0 flex-1 items-start gap-2")}>
                {inlineLeftControls && (
                    <div
                        className={cn(
                            "flex items-center gap-1 mt-1 shrink-0",
                            actionsOverlay && dragHandle && "-ml-2"
                        )}
                    >
                        {dragHandle}
                        {showQuickDoneButton && (
                            <button
                                type="button"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onStatusChange('done');
                                }}
                                aria-label={t('status.done')}
                                className="text-emerald-400 hover:text-emerald-300 p-1 rounded hover:bg-emerald-500/20"
                            >
                                <Check className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                )}
                <div
                    className={cn(
                        "group/content relative rounded -ml-2 pl-2 pr-1 py-1 transition-colors flex-1 min-w-0",
                        selectionMode ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
                    )}
                >
                    {!selectionMode && !readOnly && showHoverHint && (
                        <span
                            className={cn(
                                "pointer-events-none absolute right-2 top-1 text-[10px] text-muted-foreground/70 opacity-0 transition-opacity group-hover/content:opacity-100",
                                isRtl && "left-2 right-auto"
                            )}
                        >
                            {hoverHintText}
                        </span>
                    )}
                    <button
                        type="button"
                        data-task-edit-trigger
                        onClick={onEdit}
                        className="sr-only"
                        aria-label={t('common.edit')}
                        tabIndex={-1}
                    />
                    <button
                        type="button"
                        onClick={handleTitleClick}
                        onDoubleClick={handleTitleDoubleClick}
                        className={cn(
                            "block w-full text-left rounded px-0.5 py-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40",
                            selectionMode ? "cursor-pointer" : "cursor-default",
                            isRtl && "text-right"
                        )}
                        aria-expanded={isViewOpen}
                        aria-label={t('task.toggleDetails') || 'Toggle task details'}
                        dir={resolvedDirection}
                    >
                        <div
                            className={cn(
                                "font-semibold truncate text-foreground group-hover/content:text-primary transition-colors",
                                dense ? "text-sm" : "text-base",
                                task.status === 'done' && "line-through text-muted-foreground",
                                actionsOverlay && "pr-20",
                                (overlayDragHandle || overlayQuickDone) && "pl-12"
                            )}
                        >
                            {task.title}
                        </div>
                    </button>
                    {showCompactMeta && hasMetadata && renderMetadataRow(cn(
                        "gap-2 text-muted-foreground",
                        dense ? "mt-0.5" : "mt-1",
                        (overlayDragHandle || overlayQuickDone) && "pl-12"
                    ))}

                    {isViewOpen && (
                        <div onClick={(e) => e.stopPropagation()}>
                            {task.description && (
                                <div
                                    className={cn(
                                        "font-normal text-muted-foreground mt-1 w-full break-words",
                                        dense ? "text-xs" : "text-sm",
                                        isRtl && "text-right"
                                    )}
                                    dir={resolvedDirection}
                                >
                                    <RichMarkdown markdown={task.description} />
                                </div>
                            )}
                            {visibleAttachments.length > 0 && (
                                <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                                    <Paperclip className="w-3 h-3" aria-hidden="true" />
                                    <span className="sr-only">{t('attachments.title') || 'Attachments'}</span>
                                    {imageAttachments.length > 0 ? (
                                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                                            {imageAttachments.map((attachment) => {
                                                const displayTitle = getAttachmentDisplayTitle(attachment);
                                                const fullTitle = attachment.kind === 'link' ? attachment.uri : attachment.title;
                                                const isDownloading = attachment.localStatus === 'downloading';
                                                return (
                                                    <button
                                                        key={attachment.id}
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            openAttachment(attachment);
                                                        }}
                                                        className="group rounded-lg border border-border bg-card overflow-hidden text-left hover:border-primary/40 hover:bg-muted/20 transition-colors"
                                                        title={fullTitle || displayTitle}
                                                        aria-label={`${t('attachments.open') || 'Open'}: ${displayTitle}`}
                                                    >
                                                        <AttachmentImage
                                                            attachment={attachment}
                                                            alt={displayTitle}
                                                            className="block h-28 w-full object-cover bg-muted/30"
                                                        />
                                                        <div className="flex items-start justify-between gap-2 px-2 py-1.5">
                                                            <div className="min-w-0">
                                                                <div className="truncate text-foreground">{displayTitle}</div>
                                                                {isDownloading ? (
                                                                    <div className="text-[11px] text-muted-foreground">{t('common.loading')}</div>
                                                                ) : null}
                                                            </div>
                                                            <AttachmentProgressIndicator attachmentId={attachment.id} />
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ) : null}
                                    {otherAttachments.map((attachment) => {
                                        const displayTitle = getAttachmentDisplayTitle(attachment);
                                        const fullTitle = attachment.kind === 'link' ? attachment.uri : attachment.title;
                                        return (
                                            <div key={attachment.id} className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        openAttachment(attachment);
                                                    }}
                                                    className="truncate hover:underline"
                                                    title={fullTitle || displayTitle}
                                                    aria-label={`${t('attachments.open') || 'Open'}: ${displayTitle}`}
                                                >
                                                    {displayTitle}
                                                </button>
                                                <AttachmentProgressIndicator attachmentId={attachment.id} />
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {hasMetadata && renderMetadataRow("gap-3 mt-2")}

                            {(task.checklist || []).length > 0 && (
                                <div
                                    className="mt-3 space-y-1 pl-1"
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    {(task.checklist || []).map((item, index) => (
                                        <button
                                            key={item.id || index}
                                            type="button"
                                            className={cn(
                                                "w-full flex items-center gap-2 text-left text-xs text-muted-foreground rounded px-1.5 py-1 hover:bg-muted/60 transition-colors",
                                                readOnly && "hover:bg-transparent cursor-default"
                                            )}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                if (readOnly) return;
                                                onToggleChecklistItem?.(index);
                                            }}
                                            aria-pressed={item.isCompleted}
                                            disabled={readOnly || !onToggleChecklistItem}
                                        >
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
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {!selectionMode && (
                <div
                    className={cn(
                        "relative flex items-center gap-2",
                        actionsOverlay && "absolute top-1 right-1 z-10"
                    )}
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    {!isViewOpen && task.tags.length > 0 && (
                        <div className="flex items-center gap-1 max-w-[240px] overflow-hidden">
                            {task.tags.slice(0, 2).map((tag) => (
                                <MetadataBadge
                                    key={tag}
                                    variant="tag"
                                    label={tag.replace(/^#/, '')}
                                />
                            ))}
                            {task.tags.length > 2 && (
                                <MetadataBadge
                                    variant="tag"
                                    label={`+${task.tags.length - 2}`}
                                />
                            )}
                        </div>
                    )}
                    {showProjectBadgeInActions && project && (
                        <div className="hidden md:flex items-center max-w-[180px]">
                            {renderProjectBadge()}
                        </div>
                    )}
                    {focusToggle && (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                focusToggle.onToggle();
                            }}
                            disabled={!focusToggle.canToggle && !focusToggle.isFocused}
                            title={focusToggle.title}
                            aria-label={focusToggle.ariaLabel}
                            className={cn(
                                "p-1.5 rounded-full transition-colors",
                                !focusToggle.alwaysVisible && "opacity-0 group-hover:opacity-100 focus:opacity-100",
                                focusToggle.isFocused
                                    ? "text-yellow-500 hover:bg-yellow-100 dark:hover:bg-yellow-900/30"
                                    : focusToggle.canToggle
                                        ? "text-muted-foreground hover:text-yellow-500 hover:bg-muted"
                                        : "text-muted-foreground/30 cursor-not-allowed"
                            )}
                        >
                            <Star className={cn("w-4 h-4", focusToggle.isFocused && "fill-current")} />
                        </button>
                    )}
                    {onOpenQuickActions && (
                        <button
                            type="button"
                            onClick={onOpenQuickActions}
                            data-task-quick-actions-trigger
                            aria-haspopup="dialog"
                            aria-expanded={quickActionsOpen}
                            aria-label={moreOptionsLabel}
                            title={moreOptionsLabel}
                            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50"
                        >
                            <MoreHorizontal className="w-4 h-4" />
                        </button>
                    )}
                    {readOnly ? (
                        <>
                            <button
                                type="button"
                                onClick={onDuplicate}
                                aria-label={t('taskEdit.duplicateTask')}
                                title={t('taskEdit.duplicateTask')}
                                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50"
                            >
                                <Copy className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => onStatusChange('next')}
                                aria-label={t('waiting.moveToNext')}
                                title={t('waiting.moveToNext')}
                                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50"
                            >
                                <RotateCcw className="w-4 h-4" />
                            </button>
                            <button
                                onClick={onDelete}
                                aria-label={t('task.aria.delete')}
                                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-muted-foreground/70 p-1 rounded hover:bg-muted/50"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </>
                    ) : (
                        <>
                            {task.status !== 'reference' && (
                                <button
                                    type="button"
                                    onClick={() => onStatusChange('reference')}
                                    aria-label={t('task.convertToReference')}
                                    title={t('task.convertToReference')}
                                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50"
                                >
                                    <BookOpen className="w-4 h-4" />
                                </button>
                            )}
                            {task.status === 'next' && onMoveToWaitingWithPrompt && (
                                <button
                                    type="button"
                                    onClick={onMoveToWaitingWithPrompt}
                                    aria-label={moveToWaitingWithDueLabel}
                                    title={moveToWaitingWithDueLabel}
                                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50"
                                >
                                    <PauseCircle className="w-4 h-4" />
                                </button>
                            )}
                            {showStatusSelect && (
                                <select
                                    value={task.status}
                                    aria-label={t('task.aria.status')}
                                    onChange={(e) => onStatusChange(e.target.value as TaskStatus)}
                                    className="text-[11px] font-medium px-2.5 py-0.5 rounded-full cursor-pointer appearance-none bg-primary/10 text-primary border-none hover:bg-primary/15 focus:outline-none focus:ring-2 focus:ring-primary/40"
                                >
                                    <option value="inbox">{t('status.inbox')}</option>
                                    <option value="next">{t('status.next')}</option>
                                    <option value="waiting">{t('status.waiting')}</option>
                                    <option value="someday">{t('status.someday')}</option>
                                    {task.status === 'reference' && (
                                        <option value="reference">{t('status.reference')}</option>
                                    )}
                                    <option value="done">{t('status.done')}</option>
                                    <option value="archived">{t('status.archived')}</option>
                                </select>
                            )}
                            <button
                                onClick={onDelete}
                                aria-label={t('task.aria.delete')}
                                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-muted-foreground/70 p-1 rounded hover:bg-muted/50"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
});
