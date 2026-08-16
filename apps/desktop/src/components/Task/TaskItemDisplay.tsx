import { AlertTriangle, Calendar as CalendarIcon, Tag, Trash2, ArrowRight, Repeat, Check, Clock, Timer, Link2, Paperclip, RotateCcw, Copy, MapPin, History, Hourglass, Play, Zap, MoreHorizontal } from 'lucide-react';
import type { Area, Attachment, Project, RangeSelectionOptions, Task, TaskStatus, RecurrenceRule, RecurrenceStrategy, Language } from '@mindwtr/core';
import { DEFAULT_AREA_COLOR, formatRecurrenceLabel, formatTimeEstimateLabel, formatTimeSpentLabel, getChecklistProgress, getContextColor, getInlineMarkdownPreview, getRecurringTaskPreviewDate, getTaskAgeLabel, getTaskDateCoherenceIssues, getTaskStaleness, getTaskUrgency, hasTimeComponent, isTaskActionable, isTaskFinished, safeFormatDate, resolveTaskTextDirection, tFallback } from '@mindwtr/core';
import { cn } from '../../lib/utils';
import { useBareFileReferenceCheck } from '../../lib/attachment-reference';
import { getAttachmentDisplayTitle } from '../../lib/attachment-utils';
import { MetadataBadge } from '../ui/MetadataBadge';
import { AttachmentProgressIndicator } from '../AttachmentProgressIndicator';
import { RichMarkdown } from '../RichMarkdown';
import { InlineMarkdown } from '../Markdown';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { isImageAttachment } from './task-item-attachment-utils';
import { AttachmentImage } from './AttachmentImage';
import { FocusStarIcon } from '../FocusStarIcon';

interface TaskItemDisplayActions {
    onToggleSelect?: (options?: RangeSelectionOptions) => void;
    onToggleView: () => void;
    onEdit: () => void;
    onRenameTitle?: (title: string) => void;
    onDelete: () => void;
    onDuplicate: () => void;
    onStatusChange: (status: TaskStatus) => void;
    onRequestBackdatedComplete?: () => void;
    onEditCompletedAt?: () => void;
    onOpenQuickActions?: (event: MouseEvent<HTMLButtonElement>) => void;
    onOpenProject?: (projectId: string) => void;
    onOpenContextToken?: (token: string) => void;
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
    pomodoroQuickStart?: {
        onStart: () => void;
        sessionCount: number;
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
    timeSpentEnabled?: boolean;
    isStagnant: boolean;
    showQuickDone: boolean;
    showStatusSelect?: boolean;
    showProjectBadgeInActions?: boolean;
    showProjectBadgeInMetadata?: boolean;
    readOnly: boolean;
    compactMetaEnabled?: boolean;
    dense?: boolean;
    actionsOverlay?: boolean;
    dragHandle?: ReactNode;
    showTaskAge?: boolean;
    showHoverHint?: boolean;
    projectDeadlineLabel?: string;
    renameRequestToken?: number;
    /** Active theme, for the context swatch palette only (#974). */
    theme?: string;
    t: (key: string) => string;
}

// Red is reserved for a date that has passed. A due date coming up is a
// warning, not a failure — and mobile already reads that way, so painting
// "due within 24h" destructive here made the same task look overdue on one
// device and not the other (#640).
export const getUrgencyColor = (task: Task) => {
    const urgency = getTaskUrgency(task);
    switch (urgency) {
        case 'overdue': return 'text-destructive font-bold';
        case 'urgent': return 'text-warning font-medium';
        case 'upcoming': return 'text-warning';
        default: return 'text-muted-foreground';
    }
};

const formatTimeEstimate = formatTimeEstimateLabel;

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
    prioritiesEnabled,
    timeEstimatesEnabled,
    timeSpentEnabled = false,
    isStagnant,
    showQuickDone,
    showStatusSelect = true,
    showProjectBadgeInActions = true,
    showProjectBadgeInMetadata = true,
    readOnly,
    compactMetaEnabled = true,
    dense = false,
    actionsOverlay = false,
    dragHandle,
    showTaskAge = false,
    showHoverHint = true,
    projectDeadlineLabel,
    renameRequestToken = 0,
    theme,
    t,
}: TaskItemDisplayProps) {
    const {
        onToggleSelect,
        onToggleView,
        onEdit,
        onRenameTitle,
        onDelete,
        onDuplicate,
        onStatusChange,
        onRequestBackdatedComplete,
        onEditCompletedAt,
        onOpenQuickActions,
        onOpenProject,
        onOpenContextToken,
        openAttachment,
        onToggleChecklistItem,
        focusToggle,
        pomodoroQuickStart,
    } = actions;
    const pomodoroQuickStartTitle = pomodoroQuickStart
        ? tFallback(t, 'pomodoro.startForTask', 'Start focus session')
            + (pomodoroQuickStart.sessionCount > 0
                ? ` · ${tFallback(t, 'pomodoro.sessionsDone', 'Focus sessions completed')}: ${pomodoroQuickStart.sessionCount}`
                : '')
        : '';
    const isReference = task.status === 'reference';
    const checklistProgress = isReference ? null : getChecklistProgress(task);
    const recurrenceLabel = formatRecurrenceLabel({ recurrence: task.recurrence, t });
    const projectedRecurrenceDateLabel = recurrenceLabel
        ? safeFormatDate(getRecurringTaskPreviewDate(task), 'PP')
        : '';
    const recurrencePreviewLabel = recurrenceLabel && projectedRecurrenceDateLabel
        ? `${recurrenceLabel} · ${tFallback(t, 'recurrence.nextCalendarPreview', 'Next calendar preview')}: ${projectedRecurrenceDateLabel}`
        : recurrenceLabel;
    const ageLabel = getTaskAgeLabel(task.createdAt, language);
    const isBareFileReference = useBareFileReferenceCheck();
    const showCompactMeta = compactMetaEnabled && !isViewOpen;
    const descriptionPreview = useMemo(
        () => getInlineMarkdownPreview(task.description ?? ''),
        [task.description],
    );
    // The age badge nudges about work that has been sitting unfinished, so it stays
    // off completed rows — archived as well as done, which Archive started showing
    // when its rows became the shared read-only row (#968).
    const showAgeBadge = showTaskAge
        && !isTaskFinished(task)
        && Boolean(ageLabel);
    const completionTimestamp = isTaskFinished(task)
        ? task.completedAt || task.updatedAt
        : undefined;
    const completionLabel = completionTimestamp
        ? safeFormatDate(completionTimestamp, 'Pp', completionTimestamp)
        : '';
    const dateIssueLabel = getTaskDateCoherenceIssues(task).some((issue) => issue.code === 'start_after_due')
        ? tFallback(t, 'task.dateIssue.startAfterDue', 'Starts after due date')
        : '';
    const hasMetadata = Boolean(
        (showProjectBadgeInMetadata && project)
        || area
        || projectDeadlineLabel
        || completionLabel
        || task.startTime
        || task.dueDate
        || dateIssueLabel
        || task.location
        || recurrencePreviewLabel
        || (prioritiesEnabled && task.priority)
        || (!isReference && task.energyLevel)
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
    const openContextFilterLabel = tFallback(t, 'contexts.filter', 'Filter tasks');
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
    const [renameDraft, setRenameDraft] = useState<string | null>(null);
    const canInlineRename = !readOnly && !selectionMode && Boolean(onRenameTitle);
    // Rename is requested from the quick-actions menu (TaskItem bumps the token);
    // double-click stays reserved for opening the full editor.
    const lastRenameTokenRef = useRef(renameRequestToken);
    useEffect(() => {
        if (renameRequestToken === lastRenameTokenRef.current) return;
        lastRenameTokenRef.current = renameRequestToken;
        if (canInlineRename) setRenameDraft(task.title);
    }, [renameRequestToken, canInlineRename, task.title]);
    const commitInlineRename = () => {
        if (renameDraft === null) return;
        const next = renameDraft.replace(/\s+/g, ' ').trim();
        setRenameDraft(null);
        if (next && next !== task.title) onRenameTitle?.(next);
    };
    const cancelInlineRename = () => setRenameDraft(null);
    const handleTitleClick = (event: MouseEvent<HTMLButtonElement>) => {
        if (selectionMode) {
            onToggleSelect?.({ range: event.shiftKey });
            return;
        }
        // Keyboard activation should not be delayed.
        if (event.detail === 0) {
            onToggleView();
            return;
        }
        if (!readOnly && event.detail >= 2) {
            event.stopPropagation();
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
    const handleTitleDoubleClick = (event: MouseEvent<HTMLButtonElement>) => {
        if (selectionMode || readOnly) return;
        event.stopPropagation();
        clearClickTimer();
        onEdit();
    };
    const handleProjectClick = (event: MouseEvent<HTMLSpanElement>, projectId: string) => {
        event.stopPropagation();
        onOpenProject?.(projectId);
    };
    const handleProjectKeyDown = (event: KeyboardEvent<HTMLSpanElement>, projectId: string) => {
        // Shift+Enter belongs to the list shortcut layer (edit selected task);
        // swallowing it here made the chip activate instead (#847).
        if (event.shiftKey) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onOpenProject?.(projectId);
        }
    };
    const handleTokenClick = (event: MouseEvent<HTMLSpanElement>, token: string) => {
        event.stopPropagation();
        onOpenContextToken?.(token);
    };
    const handleTokenKeyDown = (event: KeyboardEvent<HTMLSpanElement>, token: string) => {
        if (event.shiftKey) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onOpenContextToken?.(token);
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
                aria-label={`${tFallback(t, 'projects.title', 'Project')}: ${project.title}`}
            >
                <MetadataBadge
                    variant="project"
                    label={project.title}
                    dotColor={projectColor || DEFAULT_AREA_COLOR}
                />
            </span>
        );
    };
    const renderContextBadge = (ctx: string) => {
        const badge = (
            <MetadataBadge
                key={ctx}
                variant="context"
                label={ctx}
                dotColor={getContextColor(ctx, theme)}
            />
        );
        if (!onOpenContextToken) return badge;
        return (
            <span
                key={ctx}
                role="button"
                tabIndex={0}
                onClick={(event) => handleTokenClick(event, ctx)}
                onKeyDown={(event) => handleTokenKeyDown(event, ctx)}
                className="inline-flex metadata-badge--interactive"
                aria-label={`${openContextFilterLabel}: ${ctx}`}
            >
                {badge}
            </span>
        );
    };
    const renderTagBadge = (tag: string) => {
        const badge = (
            <MetadataBadge
                key={tag}
                variant="tag"
                icon={Tag}
                label={tag}
            />
        );
        if (!onOpenContextToken) return badge;
        return (
            <span
                key={tag}
                role="button"
                tabIndex={0}
                onClick={(event) => handleTokenClick(event, tag)}
                onKeyDown={(event) => handleTokenKeyDown(event, tag)}
                className="inline-flex metadata-badge--interactive"
                aria-label={`${openContextFilterLabel}: ${tag}`}
            >
                {badge}
            </span>
        );
    };

    const showQuickDoneButton = showQuickDone
        && !selectionMode
        && !readOnly
        && isTaskActionable(task);
    const canEditCompletedAt = Boolean(completionLabel && onEditCompletedAt) && !selectionMode;
    // A read-only row restores to where the task belongs: an archived task goes
    // back to the Inbox to be re-clarified, which is what Archive's bulk action
    // and mobile already do; anything else picks up as the next action.
    const readOnlyRestoreStatus: TaskStatus = task.status === 'archived' ? 'inbox' : 'next';
    const readOnlyRestoreLabel = task.status === 'archived'
        ? tFallback(t, 'archived.restoreToInbox', 'Restore to Inbox')
        : t('waiting.moveToNext');
    const renderCompletionMetadataBadge = () => {
        if (!completionLabel) return null;
        const badge = (
            <MetadataBadge
                variant="info"
                icon={Check}
                label={`${tFallback(t, 'list.done', 'Completed')}: ${completionLabel}`}
            />
        );
        // Done/archived rows are readOnly by design, but correcting the completion
        // timestamp is exactly for those rows — only selection mode disables it.
        if (!canEditCompletedAt || !onEditCompletedAt) return badge;
        const editCompletedAtLabel = tFallback(t, 'task.editCompletedAt', 'Edit completion time');
        return (
            <button
                type="button"
                onClick={(event) => {
                    event.stopPropagation();
                    onEditCompletedAt();
                }}
                title={editCompletedAtLabel}
                aria-label={editCompletedAtLabel}
                className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 hover:opacity-80 transition-opacity"
            >
                {badge}
            </button>
        );
    };
    const renderProjectDeadlineMetadataBadge = () => {
        if (!projectDeadlineLabel) return null;
        return (
            <MetadataBadge
                variant="info"
                icon={CalendarIcon}
                label={projectDeadlineLabel}
                className="text-warning"
            />
        );
    };
    const renderMetadataRow = (className?: string) => (
        <div className={cn("flex flex-wrap items-center text-xs", className)}>
            {showProjectBadgeInMetadata && renderProjectBadge()}
            {renderProjectDeadlineMetadataBadge()}
            {!project && area && (
                <MetadataBadge
                    variant="project"
                    label={area.name}
                    dotColor={area.color || DEFAULT_AREA_COLOR}
                />
            )}
            {renderCompletionMetadataBadge()}
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
            {dateIssueLabel && (
                <MetadataBadge
                    variant="info"
                    icon={AlertTriangle}
                    label={dateIssueLabel}
                    className="text-warning"
                />
            )}
            {task.location && (
                <MetadataBadge
                    variant="info"
                    icon={MapPin}
                    label={task.location}
                />
            )}
            {recurrencePreviewLabel && (
                <MetadataBadge
                    variant="info"
                    icon={Repeat}
                    label={recurrencePreviewLabel}
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
                <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
                    {task.contexts.map((ctx) => renderContextBadge(ctx))}
                </div>
            )}
            {task.tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
                    {task.tags.map((tag) => renderTagBadge(tag))}
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
            {timeSpentEnabled && formatTimeSpentLabel(task.timeSpentMinutes) && (
                <MetadataBadge
                    variant="estimate"
                    icon={History}
                    label={formatTimeSpentLabel(task.timeSpentMinutes)!}
                    ariaLabel={`${t('taskEdit.timeSpentLabel')}: ${formatTimeSpentLabel(task.timeSpentMinutes)}`}
                />
            )}
        </div>
    );
    // Focused Next tasks stay marked even where no toggle renders or the
    // hover-gated actions cluster is hidden (it collapses entirely below 560px
    // containers, e.g. board columns), so the indicator rides the title. Views
    // with an always-visible toggle (Focus page) already show the state.
    const showPinnedFocusStar = task.isFocusedToday === true
        && task.status === 'next'
        && !focusToggle?.alwaysVisible;
    const overlayDragHandle = actionsOverlay && !!dragHandle;
    const overlayQuickDone = actionsOverlay && showQuickDoneButton;
    const inlineLeftControls = !actionsOverlay && (showQuickDoneButton || dragHandle);
    const showActionTags = !actionsOverlay && !isViewOpen && task.tags.length > 0;

    // Inbox items are unprocessed captures, not a done/not-done checklist, so the
    // quick-complete check stays hidden at rest and only reveals on row hover (for the
    // 2-minute rule). Actionable lists (next, projects, focus) show it at rest.
    const isInboxItem = task.status === 'inbox';
    // Waiting/Someday tasks promote to Next instead of completing — the natural
    // transition when an item unblocks, matching the mobile swipe action.
    const quickActionIsPromote = task.status === 'waiting' || task.status === 'someday';
    const canBackdateComplete = !quickActionIsPromote && Boolean(onRequestBackdatedComplete);
    const quickDoneButton = (
        <button
            type="button"
            onClick={(event) => {
                event.stopPropagation();
                onStatusChange(quickActionIsPromote ? 'next' : 'done');
            }}
            onContextMenu={canBackdateComplete ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                onRequestBackdatedComplete?.();
            } : undefined}
            title={canBackdateComplete
                ? tFallback(t, 'task.completeBackdateHint', 'Right-click to complete with a different time')
                : undefined}
            aria-label={quickActionIsPromote ? t('status.next') : t('status.done')}
            className={cn(
                quickActionIsPromote
                    ? "text-info hover:text-info/80 p-1 rounded hover:bg-info/20"
                    : "text-success hover:text-success/80 p-1 rounded hover:bg-success/20",
                isInboxItem && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity motion-reduce:transition-none",
            )}
        >
            {quickActionIsPromote ? <ArrowRight className="w-4 h-4" /> : <Check className="w-4 h-4" />}
        </button>
    );

    return (
        // `isolate` keeps the row's internal z-10/z-20 layers (overlays, the
        // hover action cluster) from joining the page stacking context, where
        // they painted over open toolbar menus in views whose toolbar sits at
        // a lower z-index (#1040).
        <div className={cn("task-item-display isolate flex-1 min-w-0 flex items-start gap-3", actionsOverlay && "relative")}>
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
                    {quickDoneButton}
                </div>
            )}
            <div className={cn("task-item-display__main flex min-w-0 flex-1 items-start gap-2")}>
                {inlineLeftControls && (
                    <div
                        className={cn(
                            "flex items-center gap-1 mt-1 shrink-0",
                            actionsOverlay && dragHandle && "-ml-2"
                        )}
                    >
                        {dragHandle}
                        {showQuickDoneButton && quickDoneButton}
                    </div>
                )}
                <div
                    className={cn(
                        "group/content relative rounded -ml-2 pl-2 pr-1 py-1 transition-colors flex-1 min-w-0",
                        selectionMode ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
                    )}
                >
                    {/*
                      * What the list's `e` shortcut clicks. A read-only row has no
                      * editor to open, but correcting the completion timestamp is
                      * the one edit it does allow — without this `e` is silently
                      * dead on every Done and Archived row.
                      */}
                    <button
                        type="button"
                        data-task-edit-trigger
                        onClick={readOnly && canEditCompletedAt ? onEditCompletedAt : onEdit}
                        className="sr-only"
                        aria-label={t('common.edit')}
                        tabIndex={-1}
                    />
                    {renameDraft !== null ? (
                        <input
                            type="text"
                            value={renameDraft}
                            autoFocus
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    commitInlineRename();
                                } else if (event.key === 'Escape') {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    cancelInlineRename();
                                }
                            }}
                            onBlur={commitInlineRename}
                            aria-label={tFallback(t, 'task.renameTitle', 'Rename task')}
                            className={cn(
                                "w-full rounded border border-border bg-background px-0.5 py-0.5 font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40",
                                dense ? "text-sm" : "text-base",
                                isRtl && "text-right"
                            )}
                            dir={resolvedDirection}
                        />
                    ) : (
                    <button
                        type="button"
                        data-task-view-toggle
                        onClick={handleTitleClick}
                        onDoubleClick={handleTitleDoubleClick}
                        className={cn(
                            "block w-full text-left rounded px-0.5 py-0.5 transition-colors focus:outline-none",
                            selectionMode ? "cursor-pointer" : "cursor-default",
                            isRtl && "text-right"
                        )}
                        aria-expanded={isViewOpen}
                        aria-label={tFallback(t, 'task.toggleDetails', 'Toggle task details')}
                        title={!selectionMode && !readOnly && showHoverHint ? hoverHintText : undefined}
                        dir={resolvedDirection}
                    >
                        <div
                            className={cn(
                                "task-item-display__title font-semibold whitespace-normal break-words text-foreground group-hover/content:text-primary transition-colors",
                                dense ? "text-sm" : "text-base",
                                // Archived work is finished work, so it reads struck
                                // through the same way Done does.
                                isTaskFinished(task) && "line-through text-muted-foreground",
                                actionsOverlay && "pr-20",
                                (overlayDragHandle || overlayQuickDone) && "pl-12"
                            )}
                        >
                            {task.title}
                            {showPinnedFocusStar && (
                                <FocusStarIcon
                                    filled
                                    aria-hidden="true"
                                    data-focus-star-pinned
                                    className="ms-1 inline-block h-3.5 w-3.5 shrink-0 align-[-2px]"
                                />
                            )}
                        </div>
                    </button>
                    )}
                    {showCompactMeta && descriptionPreview && (
                        <div
                            className={cn(
                                "task-item-display__description-preview mt-0.5 truncate text-xs font-normal text-muted-foreground",
                                (overlayDragHandle || overlayQuickDone) && "pl-12",
                                isRtl && "text-right"
                            )}
                            dir={resolvedDirection}
                        >
                            <InlineMarkdown markdown={descriptionPreview} interactiveLinks={false} />
                        </div>
                    )}
                    {showCompactMeta && hasMetadata && renderMetadataRow(cn(
                        "gap-2 text-muted-foreground",
                        dense ? "mt-0.5" : "mt-1",
                        (overlayDragHandle || overlayQuickDone) && "pl-12"
                    ))}
                    {!showCompactMeta && !isViewOpen && (completionLabel || projectDeadlineLabel) && (
                        <div className={cn(
                            "flex flex-wrap items-center gap-2 text-xs text-muted-foreground",
                            dense ? "mt-0.5" : "mt-1",
                            (overlayDragHandle || overlayQuickDone) && "pl-12"
                        )}>
                            {renderCompletionMetadataBadge()}
                            {renderProjectDeadlineMetadataBadge()}
                        </div>
                    )}

                    {isViewOpen && (
                        <div onClick={(e) => e.stopPropagation()}>
                            {task.description && (
                                <div
                                    className={cn(
                                        "font-normal text-muted-foreground mt-1 w-full break-words select-text cursor-text",
                                        dense ? "text-xs" : "text-sm",
                                        isRtl && "text-right"
                                    )}
                                    dir={resolvedDirection}
                                    onMouseDown={(event) => event.stopPropagation()}
                                >
                                    <RichMarkdown markdown={task.description} />
                                </div>
                            )}
                            {visibleAttachments.length > 0 && (
                                <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                                    <Paperclip className="w-3 h-3" aria-hidden="true" />
                                    <span className="sr-only">{tFallback(t, 'attachments.title', 'Attachments')}</span>
                                    {imageAttachments.length > 0 ? (
                                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                                            {imageAttachments.map((attachment) => {
                                                const displayTitle = getAttachmentDisplayTitle(attachment);
                                                const fullTitle = attachment.uri || attachment.title;
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
                                                        aria-label={`${tFallback(t, 'attachments.open', 'Open')}: ${displayTitle}`}
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
                                        const isPointer = attachment.kind === 'link' || isBareFileReference(attachment);
                                        const fullTitle = attachment.uri || attachment.title;
                                        return (
                                            <div key={attachment.id} className="flex items-center gap-2">
                                                {isPointer && <Link2 className="w-3 h-3 shrink-0" aria-hidden="true" />}
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        openAttachment(attachment);
                                                    }}
                                                    className="truncate hover:underline"
                                                    title={fullTitle || displayTitle}
                                                    aria-label={`${tFallback(t, 'attachments.open', 'Open')}: ${displayTitle}`}
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

                            {!isReference && (task.checklist || []).length > 0 && (
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
                                                    "w-3 h-3 shrink-0 border rounded flex items-center justify-center",
                                                    item.isCompleted
                                                        ? "bg-primary border-primary text-primary-foreground"
                                                        : "border-muted-foreground"
                                                )}
                                            >
                                                {item.isCompleted && <Check className="w-2 h-2" />}
                                            </span>
                                            <InlineMarkdown
                                                markdown={item.title}
                                                className={cn(item.isCompleted && "line-through")}
                                                interactiveLinks={false}
                                            />
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
                        "task-item-display__actions relative z-20 flex shrink-0 items-center gap-2",
                        actionsOverlay && "absolute top-1 right-1 z-10"
                    )}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                >
                    {showActionTags && (
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
                    {pomodoroQuickStart && (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                pomodoroQuickStart.onStart();
                            }}
                            title={pomodoroQuickStartTitle}
                            aria-label={pomodoroQuickStartTitle}
                            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-primary p-1 rounded hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 inline-flex items-center gap-0.5"
                        >
                            <Play className="w-4 h-4" />
                            {pomodoroQuickStart.sessionCount > 0 && (
                                <span className="text-[10px] font-medium tabular-nums">
                                    {pomodoroQuickStart.sessionCount}
                                </span>
                            )}
                        </button>
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
                                    ? "text-warning hover:bg-warning/10"
                                    : focusToggle.canToggle
                                        ? "text-muted-foreground hover:text-warning hover:bg-muted"
                                        : "text-muted-foreground/30 cursor-not-allowed"
                            )}
                        >
                            <FocusStarIcon className="w-4 h-4" filled={focusToggle.isFocused} />
                        </button>
                    )}
                    {/*
                      * A read-only row's menu holds only Duplicate and Delete, and both
                      * are buttons right here — "More options" with nothing more in it is
                      * noise (#968). Right-click still opens the menu. Restore the trigger
                      * if the read-only menu ever gains an action this cluster lacks.
                      */}
                    {onOpenQuickActions && !readOnly && (
                        <button
                            type="button"
                            onClick={onOpenQuickActions}
                            data-task-quick-actions-trigger
                            aria-haspopup="menu"
                            aria-expanded={quickActionsOpen}
                            aria-label={moreOptionsLabel}
                            title={moreOptionsLabel}
                            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
                                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                                <Copy className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => onStatusChange(readOnlyRestoreStatus)}
                                aria-label={readOnlyRestoreLabel}
                                title={readOnlyRestoreLabel}
                                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                                <RotateCcw className="w-4 h-4" />
                            </button>
                            <button
                                onClick={onDelete}
                                aria-label={t('task.aria.delete')}
                                title={t('task.aria.delete')}
                                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-muted-foreground/70 p-1 rounded hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </>
                    ) : (
                        <>
                            {showStatusSelect && (
                                <select
                                    value={task.status}
                                    aria-label={t('task.aria.status')}
                                onChange={(e) => {
                                    const nextStatus = e.target.value as TaskStatus;
                                    if (nextStatus === 'waiting' && task.status !== 'waiting') {
                                        e.currentTarget.blur();
                                    }
                                    onStatusChange(nextStatus);
                                }}
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
                        </>
                    )}
                </div>
            )}
        </div>
    );
});
