import { Swipeable } from 'react-native-gesture-handler';
import {
    getFocusStarBlockedText,
    formatRecurrenceLabel,
    formatI18nTemplate,
    getProjectNextActionPromptData,
    hasTimeComponent,
    isTaskActionable,
    isTaskFinished,
    normalizeFocusTaskLimit,
    resolveFeatureFlags,
    safeFormatDate,
    safeParseDate,
    safeParseDueDate,
    shallow,
    tFallback,
    undoTaskCompletion,
    useTaskStore,
} from '@mindwtr/core';
import type { Area, Project, ProjectSequenceTaskCue, Task, TaskStatus } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import React, { useCallback, useRef, useState } from 'react';
import { ArrowRight, Check, RotateCcw, Trash2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { ThemeColors } from '../hooks/use-theme-colors';
import { useStatusColors } from '../hooks/use-status-colors';
import { useToast } from '../contexts/toast-context';
import { AppPressable } from './app-pressable';
import { presentProjectNextActionPrompt } from './project-next-action-prompt';
import { SwipeableTaskItemContent } from './swipeable-task-item/SwipeableTaskItemContent';
import { ProjectNextActionPromptModal } from './swipeable-task-item/ProjectNextActionPromptModal';
import { SwipeableTaskItemStatusMenu } from './swipeable-task-item/SwipeableTaskItemStatusMenu';
import { CompletedAtPicker } from './completed-at-picker';
import { styles } from './swipeable-task-item/swipeable-task-item.styles';
import { CompactText } from '@/components/compact-text';
import { useSwipeableChecklist } from './swipeable-task-item/useSwipeableChecklist';
import { settleStoreAction } from './store-action-result';

/**
 * Everything a row can mutate, on one object whose identity never changes
 * (#766). Rows bind their own task into these, so a list can hand every row the
 * same object instead of a fresh arrow per row per render — a fresh arrow is
 * what defeats the memo boundary below.
 */
export type TaskRowActions = {
    edit: (task: Task) => void;
    changeStatus: (task: Task, status: TaskStatus) => void | Promise<unknown>;
    remove: (task: Task) => void | Promise<unknown>;
    /** Omitted by lists without multi-select. */
    toggleSelect?: (task: Task) => void;
};

export interface SwipeableTaskItemProps {
    task: Task;
    isDark: boolean;
    /** Theme colors object from useThemeColors hook */
    tc: ThemeColors;
    /** Preferred over the per-row `onPress`/`onStatusChange`/`onDelete` arrows. */
    actions?: TaskRowActions;
    onPress?: () => void;
    onStatusChange?: (status: TaskStatus) => void | Promise<unknown>;
    onDelete?: () => void | Promise<unknown>;
    /** Receives the row's task so callers can pass one stable handler. */
    onLongPressAction?: (task: Task) => void;
    onLongPressActionLabel?: string;
    /** Hide context tags (useful when viewing a specific context) */
    hideContexts?: boolean;
    /** Multi-select mode for bulk actions */
    selectionMode?: boolean;
    isMultiSelected?: boolean;
    onToggleSelect?: () => void;
    isHighlighted?: boolean;
    showFocusToggle?: boolean;
    /** Keep the focus star while allowing context-specific lists to avoid a redundant card outline. */
    showFocusHighlight?: boolean;
    hideStatusBadge?: boolean;
    /** Render the status control as a compact icon button (no status-name label) for single-status lists */
    statusBadgeAsIcon?: boolean;
    sequenceCue?: ProjectSequenceTaskCue;
    sequenceLabel?: string;
    disableSwipe?: boolean;
    interactionDisabled?: boolean;
    hideChecklistProgress?: boolean;
    hideProjectMeta?: boolean;
    onProjectPress?: (projectId: string) => void;
    onContextPress?: (context: string) => void;
    onTagPress?: (tag: string) => void;
    projectDeadlineLabel?: string;
    /** Optional compact content rendered inside the task card below its metadata. */
    footerContent?: React.ReactNode;
    rowContext?: SwipeableTaskItemRowContext;
}

type ProjectNextActionPromptState = {
    candidates: Task[];
    projectId: string;
    projectTitle: string;
    sectionId?: string;
    scope: 'project' | 'section';
    sectionTitle?: string;
};

type TaskStoreActions = ReturnType<typeof useTaskStore.getState>;

export type SwipeableTaskItemRowContext = {
    addTask: TaskStoreActions['addTask'];
    updateTask: TaskStoreActions['updateTask'];
    restoreTask: TaskStoreActions['restoreTask'];
    projects: Project[];
    areas: Area[];
    focusedCount: number;
    focusTaskLimit: number;
    timeEstimatesEnabled: boolean;
    timeSpentEnabled: boolean;
    showTaskAge: boolean;
};


const TASK_SWIPE_FRICTION = 1.25;
const TASK_SWIPE_OPEN_THRESHOLD = 72;
const TASK_SWIPE_DRAG_OFFSET = 28;

type ResolvedRowCallbacks = {
    onPress: () => void;
    onStatusChange: (status: TaskStatus) => void | Promise<unknown>;
    onDelete: () => void | Promise<unknown>;
    onToggleSelect?: () => void;
};

type SwipeableTaskItemResolvedProps =
    Omit<SwipeableTaskItemProps, 'actions' | keyof ResolvedRowCallbacks> & ResolvedRowCallbacks;

type SwipeableTaskItemInnerProps = Omit<SwipeableTaskItemResolvedProps, 'rowContext'> & {
    rowContext: SwipeableTaskItemRowContext;
};

const noop = () => {};

/** Binds this row's task into the shared `actions`, inside the memo boundary. */
function resolveRowCallbacks(props: SwipeableTaskItemProps): ResolvedRowCallbacks {
    const { actions, task } = props;
    const toggleSelect = actions?.toggleSelect;
    return {
        onPress: props.onPress ?? (actions ? () => actions.edit(task) : noop),
        onStatusChange: props.onStatusChange
            ?? (actions ? (status: TaskStatus) => actions.changeStatus(task, status) : noop),
        onDelete: props.onDelete ?? (actions ? () => actions.remove(task) : noop),
        onToggleSelect: props.onToggleSelect ?? (toggleSelect ? () => toggleSelect(task) : undefined),
    };
}

// Renders of task rows, read by TaskList to report how many rows a commit
// actually re-rendered (#766). Shared across lists on purpose: it is a diff
// taken around one list's render, and a second list rendering in the same pass
// is itself the thing worth seeing.
let taskRowRenderCount = 0;

export const readTaskRowRenderCount = (): number => taskRowRenderCount;

// The memo boundary for a single row (#766). Any store change re-renders the
// list, but a row re-renders only when the task object it draws — or one of the
// flags it draws — actually changed. Every prop is compared by identity, which
// is why per-row callbacks belong in `actions`. `tc` included: resolveThemeTokens
// hands out one object per distinct theme, so it only changes when the theme does.
// Not core's `shallow`: that one is stubbed out in several suites, which would
// quietly turn the boundary off under test.
function areRowPropsEqual(prev: SwipeableTaskItemProps, next: SwipeableTaskItemProps): boolean {
    const keys = Object.keys(prev) as (keyof SwipeableTaskItemProps)[];
    if (keys.length !== Object.keys(next).length) return false;
    return keys.every((key) => Object.is(prev[key], next[key]));
}

function SwipeableTaskItemRow(props: SwipeableTaskItemProps) {
    taskRowRenderCount += 1;
    const { actions: _actions, ...rest } = props;
    const resolved: SwipeableTaskItemResolvedProps = { ...rest, ...resolveRowCallbacks(props) };
    if (props.rowContext) {
        return <SwipeableTaskItemInner {...resolved} rowContext={props.rowContext} />;
    }
    return <StoreBackedSwipeableTaskItem {...resolved} />;
}

export const SwipeableTaskItem = React.memo(SwipeableTaskItemRow, areRowPropsEqual);

function StoreBackedSwipeableTaskItem(props: Omit<SwipeableTaskItemInnerProps, 'rowContext'>) {
    const rowContext = useTaskStore((state): SwipeableTaskItemRowContext => {
        const resolvedFeatureFlags = resolveFeatureFlags(state.settings);
        return {
            addTask: state.addTask,
            updateTask: state.updateTask,
            restoreTask: state.restoreTask,
            projects: state.projects,
            areas: state.areas,
            focusedCount: state.getDerivedState().focusedCount,
            focusTaskLimit: normalizeFocusTaskLimit(state.settings?.gtd?.focusTaskLimit),
            timeEstimatesEnabled: resolvedFeatureFlags.timeEstimates,
            timeSpentEnabled: resolvedFeatureFlags.pomodoro
                && state.settings?.gtd?.pomodoro?.linkTask === true,
            showTaskAge: state.settings?.appearance?.showTaskAge === true,
        };
    }, shallow);
    return <SwipeableTaskItemInner {...props} rowContext={rowContext} />;
}

/**
 * A swipeable task item with context-aware left swipe actions:
 * - Inbox: swipe to Next
 * - Next: swipe to Done
 * - Waiting/Someday: swipe to Next
 * - Done: swipe to restore to Inbox
 * 
 * Right swipe always shows Delete action.
 */
function SwipeableTaskItemInner({
    task,
    isDark,
    tc,
    onPress,
    onStatusChange,
    onDelete,
    onLongPressAction,
    onLongPressActionLabel,
    hideContexts = false,
    selectionMode = false,
    isMultiSelected = false,
    onToggleSelect,
    isHighlighted = false,
    showFocusToggle = false,
    showFocusHighlight = true,
    hideStatusBadge = false,
    statusBadgeAsIcon = false,
    sequenceCue,
    sequenceLabel,
    disableSwipe = false,
    interactionDisabled = false,
    hideChecklistProgress = false,
    hideProjectMeta = false,
    onProjectPress,
    onContextPress,
    onTagPress,
    projectDeadlineLabel,
    footerContent,
    rowContext,
}: SwipeableTaskItemInnerProps) {
    const swipeableRef = useRef<Swipeable>(null);
    const ignorePressUntil = useRef<number>(0);
    const { t, language } = useLanguage();
    const { showToast } = useToast();
    const statusColors = useStatusColors();
    const {
        addTask,
        updateTask,
        restoreTask,
        projects,
        areas,
        focusedCount,
        focusTaskLimit,
        timeEstimatesEnabled,
        timeSpentEnabled,
        showTaskAge,
    } = rowContext;
    const canShowFocusToggle = showFocusToggle
        && isTaskActionable(task);
    const isReference = task.status === 'reference';
    const {
        cancelPendingChecklist,
        checklistProgress,
        localChecklist,
        showChecklist,
        toggleChecklist,
        toggleChecklistItem,
    } = useSwipeableChecklist(task, updateTask);
    const [showStatusMenu, setShowStatusMenu] = useState(false);
    const [projectNextActionPrompt, setProjectNextActionPrompt] = useState<ProjectNextActionPromptState | null>(null);
    const [projectNextActionTitle, setProjectNextActionTitle] = useState('');
    const [isProjectNextActionSubmitting, setIsProjectNextActionSubmitting] = useState(false);

    const closeProjectNextActionPrompt = useCallback(() => {
        setProjectNextActionPrompt(null);
        setProjectNextActionTitle('');
        setIsProjectNextActionSubmitting(false);
    }, []);

    const openProjectNextActionPromptIfNeeded = useCallback((completedTaskId: string) => {
        const storeState = useTaskStore.getState();
        const taskLookup = storeState._tasksById instanceof Map ? storeState._tasksById : null;
        const allTasks = Array.isArray(storeState._allTasks) ? storeState._allTasks : storeState.tasks;
        const allProjects = Array.isArray(storeState._allProjects) ? storeState._allProjects : storeState.projects;
        const latestTask = taskLookup?.get(completedTaskId)
            ?? allTasks.find((candidate) => candidate.id === completedTaskId)
            ?? task;
        const completedTask = { ...latestTask, status: 'done' as TaskStatus };
        const globalPromptResult = presentProjectNextActionPrompt(completedTask);
        if (globalPromptResult !== null) return;
        const promptTasks = allTasks.some((candidate) => candidate.id === completedTaskId)
            ? allTasks.map((candidate) => (candidate.id === completedTaskId ? completedTask : candidate))
            : [...allTasks, completedTask];
        const promptData = getProjectNextActionPromptData(completedTask, promptTasks, allProjects);
        if (!promptData) return;
        const allSections = Array.isArray(storeState.sections) ? storeState.sections : [];
        setProjectNextActionTitle('');
        setProjectNextActionPrompt({
            candidates: promptData.candidates,
            projectId: promptData.project.id,
            projectTitle: promptData.project.title,
            sectionId: completedTask.sectionId,
            scope: promptData.scope,
            sectionTitle: promptData.scope === 'section' && completedTask.sectionId
                ? allSections.find((section) => section.id === completedTask.sectionId)?.title
                : undefined,
        });
    }, [task]);

    const showActionFailure = useCallback((message?: string) => {
        showToast({
            title: tFallback(t, 'common.error', 'Error'),
            message: message || tFallback(t, 'task.updateFailed', 'Could not update task.'),
            tone: 'error',
            durationMs: 4200,
        });
    }, [showToast, t]);

    const handleStatusChange = useCallback((status: TaskStatus) => {
        const previousStatus = task.status;
        const wasFocusedToday = task.isFocusedToday === true;
        void settleStoreAction(() => onStatusChange(status))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                if (status === 'done' && previousStatus !== 'done') {
                    // Completing mirrors deleting: immediate, with an undo toast
                    // instead of a confirmation (matches the desktop undo).
                    // No title: the one-line message plus Undo is the whole point,
                    // and a "Notice" header just makes the toast taller (#1044).
                    showToast({
                        message: (tFallback(t, 'task.markedDone', '{title} marked Done')).replace('{title}', task.title),
                        tone: 'info',
                        actionLabel: tFallback(t, 'common.undo', 'Undo'),
                        onAction: () => {
                            void settleStoreAction(() => (
                                undoTaskCompletion(task.id, previousStatus, wasFocusedToday)
                            )).then((outcome) => {
                                if (!outcome.ok) showActionFailure(outcome.message);
                            });
                        },
                        durationMs: 5200,
                    });
                    openProjectNextActionPromptIfNeeded(task.id);
                }
            });
    }, [onStatusChange, openProjectNextActionPromptIfNeeded, showActionFailure, showToast, t, task.id, task.isFocusedToday, task.status, task.title]);

    const [completedAtPicker, setCompletedAtPicker] = useState<null | 'complete' | 'edit'>(null);
    const applyCompletedAt = useCallback((iso: string, timeSpentMinutes?: number) => {
        const mode = completedAtPicker;
        setCompletedAtPicker(null);
        if (!mode) return;
        const updates: Partial<Task> = mode === 'complete'
            ? { status: 'done', completedAt: iso }
            : { completedAt: iso };
        if (mode === 'complete' && timeSpentEnabled) {
            updates.timeSpentMinutes = timeSpentMinutes;
        }
        void settleStoreAction(() => updateTask(task.id, updates))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                if (mode === 'complete' && task.status !== 'done') {
                    openProjectNextActionPromptIfNeeded(task.id);
                }
            });
    }, [completedAtPicker, openProjectNextActionPromptIfNeeded, showActionFailure, task.id, task.status, timeSpentEnabled, updateTask]);

    const handlePromoteProjectNextAction = useCallback((nextTaskId: string) => {
        if (isProjectNextActionSubmitting) return;
        setIsProjectNextActionSubmitting(true);
        void settleStoreAction(() => updateTask(nextTaskId, { status: 'next' }))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                closeProjectNextActionPrompt();
            })
            .finally(() => setIsProjectNextActionSubmitting(false));
    }, [closeProjectNextActionPrompt, isProjectNextActionSubmitting, showActionFailure, updateTask]);

    const handleCompleteProjectNextAction = useCallback(() => {
        if (!projectNextActionPrompt || isProjectNextActionSubmitting) return;
        const { projectId } = projectNextActionPrompt;
        setIsProjectNextActionSubmitting(true);
        // Archiving completes the project's remaining tasks in core and is
        // reversible (Reactivate); no confirmation, matching the Archive button.
        void settleStoreAction(() => useTaskStore.getState().updateProject(projectId, { status: 'archived' }))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                closeProjectNextActionPrompt();
            })
            .finally(() => setIsProjectNextActionSubmitting(false));
    }, [closeProjectNextActionPrompt, isProjectNextActionSubmitting, projectNextActionPrompt, showActionFailure]);

    const handleAddProjectNextAction = useCallback(() => {
        if (!projectNextActionPrompt || isProjectNextActionSubmitting) return;
        const title = projectNextActionTitle.trim();
        if (!title) return;
        setIsProjectNextActionSubmitting(true);
        void settleStoreAction(() => addTask(title, {
            status: 'next',
            projectId: projectNextActionPrompt.projectId,
            sectionId: projectNextActionPrompt.sectionId,
        }))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                closeProjectNextActionPrompt();
            })
            .finally(() => setIsProjectNextActionSubmitting(false));
    }, [
        addTask,
        closeProjectNextActionPrompt,
        isProjectNextActionSubmitting,
        projectNextActionPrompt,
        projectNextActionTitle,
        showActionFailure,
    ]);

    const toggleFocus = () => {
        if (selectionMode) return;
        // Core focus-star module decides eligibility, cap, and the patch;
        // status promotion happens in the store's star↔status rules.
        const action = useTaskStore.getState().getFocusStarAction(task);
        if (!action.canToggle) {
            const blockedText = getFocusStarBlockedText(t, action, focusTaskLimit);
            if (blockedText) {
                showToast({
                    title: tFallback(t, 'digest.focus', 'Focus'),
                    message: blockedText,
                    tone: 'warning',
                });
            }
            return;
        }
        void settleStoreAction(() => updateTask(task.id, action.patch))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                }
            });
    };

    // Status-aware left swipe action
    const getLeftAction = (): { label: string; color: string; action: TaskStatus } => {
        if (task.status === 'done') {
            return { label: tFallback(t, 'archived.restoreToInbox', 'Restore'), color: statusColors.inbox.text, action: 'inbox' };
        } else if (task.status === 'next') {
            return { label: tFallback(t, 'common.done', 'Done'), color: statusColors.done.text, action: 'done' };
        } else if (task.status === 'waiting' || task.status === 'someday' || task.status === 'reference') {
            return { label: tFallback(t, 'status.next', 'Next'), color: statusColors.next.text, action: 'next' };
        } else if (task.status === 'inbox') {
            return { label: tFallback(t, 'status.next', 'Next'), color: statusColors.next.text, action: 'next' };
        } else {
            return { label: tFallback(t, 'common.done', 'Done'), color: statusColors.done.text, action: 'done' };
        }
    };

    const leftAction = getLeftAction();
    const recurrenceLabel = formatRecurrenceLabel({ recurrence: task.recurrence, t });
    const swipeAccessibilityHint = interactionDisabled
        ? tFallback(t, 'projects.taskOrder', 'Task order')
        : selectionMode
            ? tFallback(t, 'task.aria.selectionHint', 'Double-tap to toggle task selection.')
            : tFallback(
                t,
                'task.aria.actionsHint',
                'Double-tap to edit task details. More actions are available in the accessibility actions menu.',
            );

    const renderLeftActions = () => {
        const LeftIcon = leftAction.action === 'inbox' ? RotateCcw : leftAction.action === 'done' ? Check : ArrowRight;
        return (
            <AppPressable
                style={[styles.swipeActionLeft, { backgroundColor: leftAction.color }]}
                pressedColor="rgba(0, 0, 0, 0.18)"
                onPress={() => {
                    swipeableRef.current?.close();
                    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
                    handleStatusChange(leftAction.action);
                }}
                onLongPress={leftAction.action === 'done' ? () => {
                    swipeableRef.current?.close();
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
                    setCompletedAtPicker('complete');
                } : undefined}
                accessibilityLabel={formatI18nTemplate(
                    tFallback(t, 'task.aria.action', '{action} action'),
                    { action: leftAction.label },
                )}
                accessibilityRole="button"
                accessibilityHint={leftAction.action === 'done'
                    ? tFallback(t, 'task.completeBackdateHintMobile', 'Long-press to complete with a different time')
                    : undefined}
            >
                <LeftIcon size={20} color="#FFFFFF" />
                <CompactText style={styles.swipeActionText} numberOfLines={1}>
                    {leftAction.label}
                </CompactText>
            </AppPressable>
        );
    };

    const renderRightActions = () => (
        <AppPressable
            style={styles.swipeActionRight}
            pressedColor="rgba(0, 0, 0, 0.18)"
            onPress={() => {
                swipeableRef.current?.close();
                handleDelete();
            }}
            accessibilityLabel={tFallback(t, 'task.aria.delete', 'Delete task')}
            accessibilityRole="button"
        >
            <Trash2 size={20} color="#FFFFFF" />
            <CompactText style={styles.swipeActionText} numberOfLines={1}>
                {t('common.delete')}
            </CompactText>
        </AppPressable>
    );

    const accessibilityLabel = [
        task.title,
        `${tFallback(t, 'taskEdit.statusLabel', 'Status')}: ${t(`status.${task.status}`)}`,
        (() => {
            const start = safeParseDate(task.startTime);
            if (!start) return null;
            const hasTime = hasTimeComponent(task.startTime);
            return `${tFallback(t, 'taskEdit.startDateLabel', 'Start')}: ${safeFormatDate(start, hasTime ? 'Pp' : 'P')}`;
        })(),
        (() => {
            const due = safeParseDueDate(task.dueDate);
            if (!due) return null;
            const hasTime = hasTimeComponent(task.dueDate);
            return `${tFallback(t, 'taskEdit.dueDateLabel', 'Due')}: ${safeFormatDate(due, hasTime ? 'Pp' : 'P')}`;
        })(),
        sequenceCue === 'available' ? sequenceLabel : null,
        projectDeadlineLabel,
        recurrenceLabel ? `${tFallback(t, 'taskEdit.recurrenceLabel', 'Recurrence')}: ${recurrenceLabel}` : null,
    ].filter(Boolean).join('. ');

    const handlePress = () => {
        if (interactionDisabled) return;
        if (Date.now() < ignorePressUntil.current) return;
        if (selectionMode && onToggleSelect) {
            onToggleSelect();
            return;
        }
        onPress();
    };

    // Deleting is a recoverable move to Trash, so it happens immediately with
    // an undo toast instead of a confirmation alert. Permanent purge (in Trash)
    // keeps its confirmation.
    const handleDelete = () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
        cancelPendingChecklist();
        void settleStoreAction(() => onDelete())
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                showToast({
                    message: tFallback(t, 'list.taskDeleted', 'Task deleted'),
                    tone: 'info',
                    actionLabel: tFallback(t, 'common.undo', 'Undo'),
                    onAction: () => {
                        void settleStoreAction(() => restoreTask(task.id))
                            .then((restoreOutcome) => {
                                if (!restoreOutcome.ok) {
                                    showActionFailure(restoreOutcome.message);
                                }
                            });
                    },
                    durationMs: 5200,
                });
            });
    };

    const handleLongPress = () => {
        if (interactionDisabled) return;
        ignorePressUntil.current = Date.now() + 500;
        // Note: onDragStart is handled by the drag handle directly, not here
        if (onLongPressAction) {
            onLongPressAction(task);
            return;
        }
        if (onToggleSelect) onToggleSelect();
    };

    const accessibilityActions = interactionDisabled ? [] : [
        {
            name: 'activate',
            label: selectionMode
                ? isMultiSelected
                    ? tFallback(t, 'task.deselect', 'Deselect task')
                    : tFallback(t, 'task.select', 'Select task')
                : tFallback(t, 'common.edit', 'Edit'),
        },
        ...(!selectionMode
            ? [
                { name: 'changeStatus', label: leftAction.label },
                ...(onLongPressAction && onLongPressActionLabel
                    ? [{ name: 'longPressAction', label: onLongPressActionLabel }]
                    : []),
                { name: 'delete', label: tFallback(t, 'common.delete', 'Delete') },
            ]
            : []),
    ];

    const handleAccessibilityAction = (event: { nativeEvent: { actionName: string } }) => {
        const { actionName } = event.nativeEvent;
        if (actionName === 'activate') {
            handlePress();
            return;
        }
        if (selectionMode) return;
        if (actionName === 'changeStatus') {
            handleStatusChange(leftAction.action);
            return;
        }
        if (actionName === 'longPressAction' && onLongPressAction) {
            onLongPressAction(task);
            return;
        }
        if (actionName === 'delete') {
            handleDelete();
        }
    };

    const content = (
        <SwipeableTaskItemContent
            accessibilityActions={accessibilityActions}
            accessibilityHint={swipeAccessibilityHint}
            accessibilityLabel={accessibilityLabel}
            areas={areas}
            canShowFocusToggle={canShowFocusToggle}
            checklistProgress={checklistProgress}
            hideChecklistProgress={hideChecklistProgress || isReference}
            hideContexts={hideContexts}
            hideProjectMeta={hideProjectMeta}
            hideStatusBadge={hideStatusBadge}
            statusBadgeAsIcon={statusBadgeAsIcon}
            isDark={isDark}
            isHighlighted={isHighlighted}
            isMultiSelected={isMultiSelected}
            showFocusHighlight={showFocusHighlight}
            interactionDisabled={interactionDisabled}
            language={language}
            localChecklist={localChecklist}
            onAccessibilityAction={handleAccessibilityAction}
            onContextPress={onContextPress}
            onEditCompletedAt={isTaskFinished(task) && !selectionMode
                ? () => setCompletedAtPicker('edit')
                : undefined}
            onLongPress={handleLongPress}
            onOpenStatusMenu={() => setShowStatusMenu(true)}
            onPress={handlePress}
            onProjectPress={onProjectPress}
            onTagPress={onTagPress}
            projectDeadlineLabel={projectDeadlineLabel}
            footerContent={footerContent}
            recurrenceLabel={recurrenceLabel}
            onToggleChecklist={toggleChecklist}
            onToggleChecklistItem={toggleChecklistItem}
            onToggleFocus={toggleFocus}
            projects={projects}
            selectionMode={selectionMode}
            sequenceCue={sequenceCue}
            showChecklist={!isReference && showChecklist}
            showTaskAge={showTaskAge}
            t={t}
            task={{
                ...task,
                timeEstimate: timeEstimatesEnabled ? task.timeEstimate : undefined,
                timeSpentMinutes: timeSpentEnabled ? task.timeSpentMinutes : undefined,
            }}
            tc={tc}
        />
    );

    return (
        <>
            {disableSwipe || interactionDisabled ? (
                content
            ) : (
                <Swipeable
                    ref={swipeableRef}
                    renderLeftActions={renderLeftActions}
                    renderRightActions={renderRightActions}
                    friction={TASK_SWIPE_FRICTION}
                    leftThreshold={TASK_SWIPE_OPEN_THRESHOLD}
                    rightThreshold={TASK_SWIPE_OPEN_THRESHOLD}
                    dragOffsetFromLeftEdge={TASK_SWIPE_DRAG_OFFSET}
                    dragOffsetFromRightEdge={TASK_SWIPE_DRAG_OFFSET}
                    overshootLeft={false}
                    overshootRight={false}
                    enabled={!selectionMode && !disableSwipe}
                >
                    {content}
                </Swipeable>
            )}

            <SwipeableTaskItemStatusMenu
                visible={showStatusMenu}
                onClose={() => setShowStatusMenu(false)}
                onStatusChange={handleStatusChange}
                onBackdatedComplete={task.status === 'done' ? undefined : () => setCompletedAtPicker('complete')}
                taskStatus={task.status}
                tc={tc}
                t={t}
            />
            {completedAtPicker ? (
                <CompletedAtPicker
                    initialValue={completedAtPicker === 'edit' ? (task.completedAt || task.updatedAt) : undefined}
                    initialTimeSpentMinutes={task.timeSpentMinutes}
                    showTimeSpent={completedAtPicker === 'complete' && timeSpentEnabled}
                    onCancel={() => setCompletedAtPicker(null)}
                    onConfirm={applyCompletedAt}
                    t={t}
                    tc={tc}
                />
            ) : null}
            {projectNextActionPrompt ? (
                <ProjectNextActionPromptModal
                    visible={Boolean(projectNextActionPrompt)}
                    candidates={projectNextActionPrompt.candidates}
                    projectTitle={projectNextActionPrompt.projectTitle}
                    scope={projectNextActionPrompt.scope}
                    sectionTitle={projectNextActionPrompt.sectionTitle}
                    newTitle={projectNextActionTitle}
                    submitting={isProjectNextActionSubmitting}
                    tc={tc}
                    t={t}
                    onAddTask={handleAddProjectNextAction}
                    onCancel={closeProjectNextActionPrompt}
                    onChooseTask={handlePromoteProjectNextAction}
                    onCompleteProject={handleCompleteProjectNextAction}
                    onNewTitleChange={setProjectNextActionTitle}
                />
            ) : null}
        </>
    );
}
