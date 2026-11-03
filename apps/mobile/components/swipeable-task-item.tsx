import { Swipeable } from 'react-native-gesture-handler';
import {
    formatTaskMarkedDoneMessage,
    getFocusStarBlockedText,
    getProjectNextActionPromptData,
    isTaskFinished,
    isTaskActionable,
    normalizeFocusTaskLimit,
    buildQuickAddParseOptions,
    buildTaskMovePatch,
    buildTaskRowMeta,
    buildTaskRowSwipeActions,
    canMoveTaskToChecklist,
    resolveQuickCaptureDefaultAreaId,
    flushPendingSave,
    getDateFormattingConfig,
    parseProjectNextActionInput,
    resolveTaskRowFeatures,
    resolveTaskRowLookup,
    shallow,
    tFallback,
    undoTaskCompletion,
    useTaskStore,
} from '@mindwtr/core';
import type { Area, Project, ProjectSequenceTaskCue, Section, Task, TaskMoveDestination, TaskRowSwipeAction, TaskStatus } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import * as Haptics from 'expo-haptics';
import { ThemeColors } from '../hooks/use-theme-colors';
import { useStatusColors } from '../hooks/use-status-colors';
import { useTaskDisplayClock } from '../hooks/use-task-display-clock';
import { useToast } from '../contexts/toast-context';
import { logNextActionSavedForEditing, presentProjectNextActionPrompt, ProjectNextActionEditor } from './project-next-action-prompt';
import { SwipeableTaskItemContent } from './swipeable-task-item/SwipeableTaskItemContent';
import { ProjectNextActionPromptModal } from './swipeable-task-item/ProjectNextActionPromptModal';
import { SwipeableTaskItemStatusMenu } from './swipeable-task-item/SwipeableTaskItemStatusMenu';
import { SwipeableTaskItemTray } from './swipeable-task-item/SwipeableTaskItemTray';
import { SwipeableTaskItemDatesSheet } from './swipeable-task-item/SwipeableTaskItemDatesSheet';
import { CompletedAtPicker } from './completed-at-picker';
import { useSwipeableChecklist } from './swipeable-task-item/useSwipeableChecklist';
import { settleStoreAction } from './store-action-result';
import { TaskEditDestinationPicker } from './task-edit/TaskEditDestinationPicker';
import { ChecklistTargetPicker } from './swipeable-task-item/ChecklistTargetPicker';


export type TaskRowActions = {
    edit: (task: Task) => void;
    changeStatus: (task: Task, status: TaskStatus) => void | Promise<unknown>;
    remove: (task: Task) => void | Promise<unknown>;
    moveToSection?: (task: Task) => void;

    toggleSelect?: (task: Task) => void;
};

export interface SwipeableTaskItemProps {
    task: Task;
    isDark: boolean;

    tc: ThemeColors;

    actions?: TaskRowActions;
    onPress?: () => void;
    onStatusChange?: (status: TaskStatus) => void | Promise<unknown>;
    onDelete?: () => void | Promise<unknown>;
    onMoveToSection?: () => void;

    onLongPressAction?: (task: Task) => void;
    onLongPressActionLabel?: string;

    hideContexts?: boolean;

    selectionMode?: boolean;
    isMultiSelected?: boolean;
    onToggleSelect?: () => void;
    isHighlighted?: boolean;
    showFocusToggle?: boolean;


    focusToggleDisabledLabel?: string;

    showFocusHighlight?: boolean;
    hideStatusBadge?: boolean;

    statusBadgeAsIcon?: boolean;
    sequenceCue?: ProjectSequenceTaskCue;
    sequenceLabel?: string;
    disableSwipe?: boolean;
    interactionDisabled?: boolean;

    allowInspectionWhenDisabled?: boolean;
    hideChecklistProgress?: boolean;
    hideProjectMeta?: boolean;

    hideDetails?: boolean;
    onProjectPress?: (projectId: string) => void;
    onContextPress?: (context: string) => void;
    onTagPress?: (tag: string) => void;
    projectDeadlineLabel?: string;

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
    sectionById: Map<string, Section>;
    areas: Area[];
    focusedCount: number;
    focusTaskLimit: number;
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
    timeSpentEnabled: boolean;
    showTaskAge: boolean;
    showStatusBadge: boolean;
};


const TASK_SWIPE_FRICTION = 1.25;
const TASK_SWIPE_OPEN_THRESHOLD = 72;
const TASK_SWIPE_DRAG_OFFSET = 28;
const TRAY_LABEL_MAX_FONT_SCALE = 1.2;

type ResolvedRowCallbacks = {
    onPress: () => void;
    onStatusChange: (status: TaskStatus) => void | Promise<unknown>;
    onDelete: () => void | Promise<unknown>;
    onMoveToSection?: () => void;
    onToggleSelect?: () => void;
};

type SwipeableTaskItemResolvedProps =
    Omit<SwipeableTaskItemProps, 'actions' | keyof ResolvedRowCallbacks> & ResolvedRowCallbacks;

type SwipeableTaskItemInnerProps = Omit<SwipeableTaskItemResolvedProps, 'rowContext'> & {
    rowContext: SwipeableTaskItemRowContext;
};

const noop = () => {};


function resolveRowCallbacks(props: SwipeableTaskItemProps): ResolvedRowCallbacks {
    const { actions, task } = props;
    const toggleSelect = actions?.toggleSelect;
    return {
        onPress: props.onPress ?? (actions ? () => actions.edit(task) : noop),
        onStatusChange: props.onStatusChange
            ?? (actions ? (status: TaskStatus) => actions.changeStatus(task, status) : noop),
        onDelete: props.onDelete ?? (actions ? () => actions.remove(task) : noop),
        onMoveToSection: props.onMoveToSection
            ?? (actions?.moveToSection ? () => actions.moveToSection?.(task) : undefined),
        onToggleSelect: props.onToggleSelect ?? (toggleSelect ? () => toggleSelect(task) : undefined),
    };
}


let taskRowRenderCount = 0;

export const readTaskRowRenderCount = (): number => taskRowRenderCount;


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
        const features = resolveTaskRowFeatures(state.settings);
        return {
            addTask: state.addTask,
            updateTask: state.updateTask,
            restoreTask: state.restoreTask,
            projects: state.projects,
            sectionById: state._sectionsById,
            areas: state.areas,
            focusedCount: state.getFocusedCount(),
            focusTaskLimit: normalizeFocusTaskLimit(state.settings?.gtd?.focusTaskLimit),
            prioritiesEnabled: features.priorities,
            timeEstimatesEnabled: features.timeEstimates,
            timeSpentEnabled: features.timeSpent,
            showTaskAge: features.taskAge,
            showStatusBadge: !state.settings?.gtd?.taskEditor?.hidden?.includes('status'),
        };
    }, shallow);
    return <SwipeableTaskItemInner {...props} rowContext={rowContext} />;
}


function SwipeableTaskItemInner({
    task,
    isDark,
    tc,
    onPress,
    onStatusChange,
    onDelete,
    onMoveToSection,
    onLongPressAction,
    onLongPressActionLabel,
    hideContexts = false,
    selectionMode = false,
    isMultiSelected = false,
    onToggleSelect,
    isHighlighted = false,
    showFocusToggle = false,
    focusToggleDisabledLabel,
    showFocusHighlight = true,
    hideStatusBadge = false,
    statusBadgeAsIcon = false,
    sequenceCue,
    sequenceLabel,
    disableSwipe = false,
    interactionDisabled = false,
    allowInspectionWhenDisabled = false,
    hideChecklistProgress = false,
    hideProjectMeta = false,
    hideDetails = false,
    onProjectPress,
    onContextPress,
    onTagPress,
    projectDeadlineLabel,
    footerContent,
    rowContext,
}: SwipeableTaskItemInnerProps) {
    const swipeableRef = useRef<Swipeable>(null);
    const { fontScale } = useWindowDimensions();
    const ignorePressUntil = useRef<number>(0);
    const { t, language } = useLanguage();
    const { showToast } = useToast();
    const statusColors = useStatusColors();
    const {
        addTask,
        updateTask,
        restoreTask,
        projects,
        sectionById,
        areas,
        focusedCount,
        focusTaskLimit,
        prioritiesEnabled,
        timeEstimatesEnabled,
        timeSpentEnabled,
        showTaskAge,
        showStatusBadge,
    } = rowContext;
    const isReference = task.status === 'reference';
    const {
        addChecklistItem,
        cancelPendingChecklist,
        localChecklist,
        showChecklist,
        toggleChecklist,
        toggleChecklistItem,
    } = useSwipeableChecklist(task, updateTask, interactionDisabled);

    const lookup = useMemo(() => resolveTaskRowLookup(
        { projectId: task.projectId, areaId: task.areaId, sectionId: task.sectionId },
        projects,
        areas,
        sectionById,
    ), [areas, projects, sectionById, task.areaId, task.projectId, task.sectionId]);
    const displayRevision = useTaskDisplayClock(isTaskActionable(task) && Boolean(task.dueDate || showTaskAge));

    const dateFormatting = getDateFormattingConfig();
    const meta = useMemo(() => {
        void displayRevision;
        return buildTaskRowMeta({
            task: { ...task, checklist: localChecklist },
            lookup,
            features: {
                priorities: prioritiesEnabled,
                timeEstimates: timeEstimatesEnabled,
                timeSpent: timeSpentEnabled,
                taskAge: showTaskAge,
            },
            language,
            dateFormatting,
            t,
            hideProjectMeta,
            hideContexts,
            hideChecklistProgress,
            projectDeadlineLabel,
            sequenceCue,
            sequenceLabel,
        });
    }, [
        dateFormatting,
        hideChecklistProgress,
        hideContexts,
        hideProjectMeta,
        language,
        localChecklist,
        lookup,
        displayRevision,
        prioritiesEnabled,
        projectDeadlineLabel,
        sequenceCue,
        sequenceLabel,
        showTaskAge,
        t,
        task,
        timeEstimatesEnabled,
        timeSpentEnabled,
    ]);
    const canShowFocusToggle = !interactionDisabled
        && showFocusToggle
        && meta.canFocus;
    const swipeActions = useMemo(() => buildTaskRowSwipeActions({
        task: { status: task.status, isFocusedToday: task.isFocusedToday },
        t,
        selectionMode,
        interactionDisabled,
    }), [interactionDisabled, selectionMode, t, task.isFocusedToday, task.status]);
    const [showStatusMenu, setShowStatusMenu] = useState(false);
    const [showDatesSheet, setShowDatesSheet] = useState(false);
    const [showDestinationPicker, setShowDestinationPicker] = useState(false);
    const [showChecklistPicker, setShowChecklistPicker] = useState(false);
    const [projectNextActionPrompt, setProjectNextActionPrompt] = useState<ProjectNextActionPromptState | null>(null);
    const [projectNextActionTitle, setProjectNextActionTitle] = useState('');
    const [isProjectNextActionSubmitting, setIsProjectNextActionSubmitting] = useState(false);
    const [nextActionEditorId, setNextActionEditorId] = useState<string | null>(null);
    const [pendingNextActionEditorId, setPendingNextActionEditorId] = useState<string | null>(null);
    const addingNextActionRef = useRef(false);
    const nextActionOwnerRef = useRef(0);
    const createdNextActionRef = useRef<string | null>(null);
    const [nextActionTitleLocked, setNextActionTitleLocked] = useState(false);

    useEffect(() => () => { nextActionOwnerRef.current += 1; }, []);

    const closeProjectNextActionPrompt = useCallback(() => {
        nextActionOwnerRef.current += 1;
        createdNextActionRef.current = null;
        setNextActionTitleLocked(false);
        setProjectNextActionPrompt(null);
        setProjectNextActionTitle('');
        setIsProjectNextActionSubmitting(false);
        setPendingNextActionEditorId(null);
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
        const allSections = Array.isArray(storeState.sections) ? storeState.sections : [];
        const promptData = getProjectNextActionPromptData(completedTask, promptTasks, allProjects, allSections);
        if (!promptData) return;
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
        if (interactionDisabled) return;
        const previousStatus = task.status;
        const wasFocusedToday = task.isFocusedToday === true;
        void settleStoreAction(() => onStatusChange(status))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                if (status === 'done' && previousStatus !== 'done') {


                    showToast({
                        message: formatTaskMarkedDoneMessage(t, task.title),
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
    }, [interactionDisabled, onStatusChange, openProjectNextActionPromptIfNeeded, showActionFailure, showToast, t, task.id, task.isFocusedToday, task.status, task.title]);

    const handleMoveToDestination = useCallback((destination: TaskMoveDestination) => {
        if (interactionDisabled) return;
        const updates = buildTaskMovePatch(destination, {
            projectId: task.projectId,
            sectionId: task.sectionId,
        });
        void settleStoreAction(() => updateTask(task.id, updates)).then((outcome) => {
            if (!outcome.ok) showActionFailure(outcome.message);
        });
    }, [interactionDisabled, showActionFailure, task.id, task.projectId, task.sectionId, updateTask]);

    const [completedAtPicker, setCompletedAtPicker] = useState<null | 'complete' | 'edit'>(null);
    useEffect(() => {
        if (!interactionDisabled) return;
        setShowStatusMenu(false);
        setShowDatesSheet(false);
        setCompletedAtPicker(null);
        closeProjectNextActionPrompt();
    }, [closeProjectNextActionPrompt, interactionDisabled]);

    const applyCompletedAt = useCallback((iso: string, timeSpentMinutes?: number) => {
        const mode = completedAtPicker;
        setCompletedAtPicker(null);
        if (!mode || interactionDisabled) return;
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
    }, [completedAtPicker, interactionDisabled, openProjectNextActionPromptIfNeeded, showActionFailure, task.id, task.status, timeSpentEnabled, updateTask]);

    const handlePromoteProjectNextAction = useCallback((nextTaskId: string) => {
        if (interactionDisabled || isProjectNextActionSubmitting) return;
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
    }, [closeProjectNextActionPrompt, interactionDisabled, isProjectNextActionSubmitting, showActionFailure, updateTask]);

    const handleCompleteProjectNextAction = useCallback(() => {
        if (interactionDisabled || !projectNextActionPrompt || isProjectNextActionSubmitting) return;
        const { projectId } = projectNextActionPrompt;
        setIsProjectNextActionSubmitting(true);


        void settleStoreAction(() => useTaskStore.getState().updateProject(projectId, { status: 'archived' }))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                closeProjectNextActionPrompt();
            })
            .finally(() => setIsProjectNextActionSubmitting(false));
    }, [closeProjectNextActionPrompt, interactionDisabled, isProjectNextActionSubmitting, projectNextActionPrompt, showActionFailure]);

    const handleAddProjectNextAction = useCallback((editAfterSave = false) => {
        if (interactionDisabled || !projectNextActionPrompt || isProjectNextActionSubmitting || addingNextActionRef.current) return;
        const rawTitle = projectNextActionTitle.trim();
        if (!rawTitle) return;
        addingNextActionRef.current = true;
        const owner = nextActionOwnerRef.current;
        setIsProjectNextActionSubmitting(true);
        const state = useTaskStore.getState();
        const { title, props } = parseProjectNextActionInput(rawTitle, {
            projectId: projectNextActionPrompt.projectId,
            sectionId: projectNextActionPrompt.sectionId,
            projects: state.projects,
            areas: state.areas,
            parseOptions: buildQuickAddParseOptions(state.settings, state),
        });
        void settleStoreAction(async () => {
            if (createdNextActionRef.current) {
                await useTaskStore.getState().persistSnapshot();
                await flushPendingSave();
                return { success: true, id: createdNextActionRef.current };
            }
            const result = await addTask(title, props);
            if (result.success && editAfterSave && result.id) {
                if (nextActionOwnerRef.current === owner) {
                    createdNextActionRef.current = result.id;
                    setNextActionTitleLocked(true);
                }
                await flushPendingSave();
            }
            return result;
        })
            .then((outcome) => {
                if (nextActionOwnerRef.current !== owner) return;
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                if (editAfterSave && outcome.result?.id && Platform.OS === 'ios') {
                    logNextActionSavedForEditing();
                    setPendingNextActionEditorId(outcome.result.id);
                } else {
                    closeProjectNextActionPrompt();
                    if (editAfterSave && outcome.result?.id) {
                        logNextActionSavedForEditing();
                        setNextActionEditorId(outcome.result.id);
                    }
                }
            })
            .finally(() => {
                addingNextActionRef.current = false;
                setIsProjectNextActionSubmitting(false);
            });
    }, [
        addTask,
        closeProjectNextActionPrompt,
        interactionDisabled,
        isProjectNextActionSubmitting,
        projectNextActionPrompt,
        projectNextActionTitle,
        showActionFailure,
    ]);


    const toggleFocus = (promoteInbox: boolean) => {
        if (interactionDisabled || selectionMode) return;
        const action = useTaskStore.getState().getFocusStarAction(task, { promoteInbox });
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

    const swipeAccessibilityHint = interactionDisabled
        ? (allowInspectionWhenDisabled
            ? tFallback(t, 'projects.archivedTaskInspectionHint', 'Double-tap to inspect this task. Reactivate the project to edit it.')
            : tFallback(t, 'projects.taskOrder', 'Task order'))
        : selectionMode
            ? tFallback(t, 'task.aria.selectionHint', 'Double-tap to toggle task selection.')
            : tFallback(
                t,
                'task.aria.actionsHint',
                'Double-tap to edit task details. More actions are available in the accessibility actions menu.',
            );

    const handleDatesSave = (patch: Partial<Task>) => {
        setShowDatesSheet(false);
        if (interactionDisabled) return;
        void settleStoreAction(() => updateTask(task.id, patch)).then((outcome) => {
            if (!outcome.ok) showActionFailure(outcome.message);
        });
    };


    const runSwipeAction = (action: TaskRowSwipeAction) => {
        if (interactionDisabled || selectionMode || !action.enabled) return;
        switch (action.id) {
            case 'focus':
                toggleFocus(true);
                return;
            case 'organize':
                setShowStatusMenu(true);
                return;
            case 'dates':
                setShowDatesSheet(true);
                return;
            case 'delete':
                handleDelete();
                return;
            default:
                if (action.status) handleStatusChange(action.status);
        }
    };

    const pressTrayAction = (action: TaskRowSwipeAction) => {
        swipeableRef.current?.close();
        if (action.id === 'done' || action.id === 'restore' || action.id === 'next') {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        }
        runSwipeAction(action);
    };

    const canBackdateCompletion = !interactionDisabled && !selectionMode && task.status !== 'done';

    const longPressTrayDone = canBackdateCompletion ? () => {
        swipeableRef.current?.close();
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
        setCompletedAtPicker('complete');
    } : undefined;

    const showTrayLabels = fontScale <= TRAY_LABEL_MAX_FONT_SCALE;

    const renderLeftActions = () => (
        <SwipeableTaskItemTray
            actions={swipeActions.swipeRight}
            side="left"
            showLabels={showTrayLabels}
            statusColors={statusColors}
            t={t}
            onAction={pressTrayAction}
            onLongPressDone={longPressTrayDone}
        />
    );

    const renderRightActions = () => (
        <SwipeableTaskItemTray
            actions={swipeActions.swipeLeft}
            side="right"
            showLabels={showTrayLabels}
            statusColors={statusColors}
            t={t}
            onAction={pressTrayAction}
        />
    );

    const handlePress = () => {
        if (interactionDisabled) {
            if (allowInspectionWhenDisabled) onPress();
            return;
        }
        if (Date.now() < ignorePressUntil.current) return;
        if (selectionMode && onToggleSelect) {
            onToggleSelect();
            return;
        }
        onPress();
    };


    const handleDelete = () => {
        if (interactionDisabled) return;
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


    const handleMoveToChecklist = (targetId: string) => {
        if (interactionDisabled) return;
        void settleStoreAction(() => useTaskStore.getState().moveTaskToChecklist(task.id, targetId))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                showToast({
                    message: tFallback(t, 'task.addedToChecklist', 'Added to checklist'),
                    tone: 'info',
                    actionLabel: tFallback(t, 'common.undo', 'Undo'),
                    onAction: () => {
                        void settleStoreAction(() => useTaskStore.getState().undoMoveTaskToChecklist(task.id, targetId))
                            .then((undoOutcome) => {
                                if (!undoOutcome.ok) showActionFailure(undoOutcome.message);
                            });
                    },
                    durationMs: 5200,
                });
            });
    };

    const handleLongPress = () => {
        if (interactionDisabled) return;
        ignorePressUntil.current = Date.now() + 500;

        if (onLongPressAction) {
            onLongPressAction(task);
            return;
        }
        if (onToggleSelect) onToggleSelect();
    };

    const accessibilityActions = interactionDisabled
        ? (allowInspectionWhenDisabled
            ? [{ name: 'activate', label: tFallback(t, 'common.view', 'View') }]
            : [])
        : [
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
                ...[...swipeActions.swipeRight, ...swipeActions.swipeLeft].map((action) => ({ name: action.id, label: action.label })),
                ...(onLongPressAction && onLongPressActionLabel
                    ? [{ name: 'longPressAction', label: onLongPressActionLabel }]
                    : []),
            ]
            : []),
    ];

    const handleAccessibilityAction = (event: { nativeEvent: { actionName: string } }) => {
        const { actionName } = event.nativeEvent;
        if (interactionDisabled) {
            if (allowInspectionWhenDisabled && actionName === 'activate') handlePress();
            return;
        }
        if (actionName === 'activate') {
            handlePress();
            return;
        }
        if (selectionMode) return;
        if (actionName === 'longPressAction' && onLongPressAction) {
            onLongPressAction(task);
            return;
        }
        const action = [...swipeActions.swipeRight, ...swipeActions.swipeLeft].find((item) => item.id === actionName);
        if (action) runSwipeAction(action);
    };

    const content = (
        <SwipeableTaskItemContent
            accessibilityActions={accessibilityActions}
            accessibilityHint={swipeAccessibilityHint}
            canShowFocusToggle={canShowFocusToggle}
            hideStatusBadge={hideStatusBadge || !showStatusBadge}
            hideDetails={hideDetails}
            statusBadgeAsIcon={statusBadgeAsIcon}
            isDark={isDark}
            isHighlighted={isHighlighted}
            isMultiSelected={isMultiSelected}
            showFocusHighlight={showFocusHighlight}
            interactionDisabled={interactionDisabled}
            allowInspectionWhenDisabled={allowInspectionWhenDisabled}
            localChecklist={localChecklist}
            meta={meta}
            onAccessibilityAction={handleAccessibilityAction}
            onAddChecklistItem={addChecklistItem}
            onContextPress={onContextPress}
            onEditCompletedAt={!interactionDisabled && isTaskFinished(task) && !selectionMode
                ? () => setCompletedAtPicker('edit')
                : undefined}
            onLongPress={handleLongPress}
            onOpenStatusMenu={() => {
                if (!interactionDisabled) setShowStatusMenu(true);
            }}
            onPress={handlePress}
            onProjectPress={onProjectPress}
            onTagPress={onTagPress}
            footerContent={footerContent}
            onToggleChecklist={toggleChecklist}
            onToggleChecklistItem={toggleChecklistItem}
            onToggleFocus={() => toggleFocus(false)}
            focusToggleDisabledLabel={task.isFocusedToday ? undefined : focusToggleDisabledLabel}
            selectionMode={selectionMode}
            sequenceCue={sequenceCue}
            showChecklist={!isReference && showChecklist}
            t={t}
            task={task}
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
                visible={!interactionDisabled && showStatusMenu}
                onClose={() => setShowStatusMenu(false)}
                onStatusChange={handleStatusChange}
                onMoveToDestination={() => setShowDestinationPicker(true)}
                onMoveToSection={onMoveToSection}
                onAddToChecklist={canMoveTaskToChecklist(task, resolveQuickCaptureDefaultAreaId(useTaskStore.getState().settings, useTaskStore.getState().areas)) ? () => setShowChecklistPicker(true) : undefined}
                onBackdatedComplete={canBackdateCompletion ? () => setCompletedAtPicker('complete') : undefined}
                taskId={task.id}
                taskStatus={task.status}
                tc={tc}
                t={t}
            />
            {!interactionDisabled && showDatesSheet ? (
                <SwipeableTaskItemDatesSheet
                    task={task}
                    tc={tc}
                    t={t}
                    onClose={() => setShowDatesSheet(false)}
                    onSave={handleDatesSave}
                />
            ) : null}
            {!interactionDisabled && showDestinationPicker ? (
                <TaskEditDestinationPicker
                    visible
                    projects={projects}
                    areas={areas}
                    selectedProjectId={task.projectId}
                    selectedAreaId={task.areaId}
                    tc={tc}
                    t={t}
                    onClose={() => setShowDestinationPicker(false)}
                    onSelect={handleMoveToDestination}
                />
            ) : null}
            {!interactionDisabled && showChecklistPicker ? (
                <ChecklistTargetPicker
                    sourceId={task.id}
                    tc={tc}
                    t={t}
                    onClose={() => setShowChecklistPicker(false)}
                    onSelect={handleMoveToChecklist}
                />
            ) : null}
            {!interactionDisabled && completedAtPicker ? (
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
            {!interactionDisabled && projectNextActionPrompt ? (
                <ProjectNextActionPromptModal
                    visible={!pendingNextActionEditorId}
                    onDismiss={() => {
                        if (!pendingNextActionEditorId) return;
                        setNextActionEditorId(pendingNextActionEditorId);
                        closeProjectNextActionPrompt();
                    }}
                    candidates={projectNextActionPrompt.candidates}
                    projectTitle={projectNextActionPrompt.projectTitle}
                    scope={projectNextActionPrompt.scope}
                    sectionTitle={projectNextActionPrompt.sectionTitle}
                    newTitle={projectNextActionTitle}
                    submitting={isProjectNextActionSubmitting}
                    titleLocked={nextActionTitleLocked}
                    tc={tc}
                    t={t}
                    onAddTask={() => handleAddProjectNextAction()}
                    onSaveAndEdit={() => handleAddProjectNextAction(true)}
                    onCancel={closeProjectNextActionPrompt}
                    onChooseTask={handlePromoteProjectNextAction}
                    onCompleteProject={handleCompleteProjectNextAction}
                    onNewTitleChange={setProjectNextActionTitle}
                />
            ) : null}
            {nextActionEditorId ? <ProjectNextActionEditor taskId={nextActionEditorId} onClose={() => setNextActionEditorId(null)} /> : null}
        </>
    );
}
