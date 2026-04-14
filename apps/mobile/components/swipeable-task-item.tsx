import { Text, Pressable, Alert } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useTaskStore, getStatusColor, hasTimeComponent, safeFormatDate, safeParseDueDate, shallow } from '@mindwtr/core';
import type { Task, TaskStatus } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import React, { useRef, useState } from 'react';
import { ArrowRight, Check, RotateCcw, Trash2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { ThemeColors } from '../hooks/use-theme-colors';
import { useToast } from '../contexts/toast-context';
import { SwipeableTaskItemContent } from './swipeable-task-item/SwipeableTaskItemContent';
import { SwipeableTaskItemStatusMenu } from './swipeable-task-item/SwipeableTaskItemStatusMenu';
import { styles } from './swipeable-task-item/swipeable-task-item.styles';
import { useSwipeableChecklist } from './swipeable-task-item/useSwipeableChecklist';

export interface SwipeableTaskItemProps {
    task: Task;
    isDark: boolean;
    /** Theme colors object from useThemeColors hook */
    tc: ThemeColors;
    onPress: () => void;
    onStatusChange: (status: TaskStatus) => void;
    onDelete: () => void;
    onLongPressAction?: () => void;
    /** Hide context tags (useful when viewing a specific context) */
    hideContexts?: boolean;
    /** Multi-select mode for bulk actions */
    selectionMode?: boolean;
    isMultiSelected?: boolean;
    onToggleSelect?: () => void;
    isHighlighted?: boolean;
    showFocusToggle?: boolean;
    hideStatusBadge?: boolean;
    disableSwipe?: boolean;
    hideChecklistProgress?: boolean;
    onProjectPress?: (projectId: string) => void;
    onContextPress?: (context: string) => void;
    onTagPress?: (tag: string) => void;
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
export function SwipeableTaskItem({
    task,
    isDark,
    tc,
    onPress,
    onStatusChange,
    onDelete,
    onLongPressAction,
    hideContexts = false,
    selectionMode = false,
    isMultiSelected = false,
    onToggleSelect,
    isHighlighted = false,
    showFocusToggle = false,
    hideStatusBadge = false,
    disableSwipe = false,
    hideChecklistProgress = false,
    onProjectPress,
    onContextPress,
    onTagPress,
}: SwipeableTaskItemProps) {
    const swipeableRef = useRef<Swipeable>(null);
    const ignorePressUntil = useRef<number>(0);
    const { t, language } = useLanguage();
    const { showToast } = useToast();
    const {
        updateTask,
        projects,
        areas,
        focusedCount,
        timeEstimatesEnabled,
    } = useTaskStore((state) => ({
        updateTask: state.updateTask,
        projects: state.projects,
        areas: state.areas,
        focusedCount: state.getDerivedState().focusedCount,
        timeEstimatesEnabled: state.settings?.features?.timeEstimates !== false,
    }), shallow);
    const canShowFocusToggle = showFocusToggle
        && task.status !== 'done'
        && task.status !== 'reference'
        && task.status !== 'archived';
    const {
        cancelPendingChecklist,
        checklistProgress,
        localChecklist,
        showChecklist,
        toggleChecklist,
        toggleChecklistItem,
    } = useSwipeableChecklist(task, updateTask);
    const [showStatusMenu, setShowStatusMenu] = useState(false);

    const toggleFocus = () => {
        if (selectionMode) return;
        if (task.isFocusedToday) {
            updateTask(task.id, { isFocusedToday: false });
            return;
        }
        if (focusedCount >= 3) {
            showToast({
                title: t('digest.focus') || 'Focus',
                message: t('agenda.maxFocusItems') || 'Max 3 focus items.',
                tone: 'warning',
            });
            return;
        }
        const updates: Partial<Task> = {
            isFocusedToday: true,
            ...(task.status !== 'next' ? { status: 'next' } : {}),
        };
        updateTask(task.id, updates);
    };

    // Status-aware left swipe action
    const getLeftAction = (): { label: string; color: string; action: TaskStatus } => {
        if (task.status === 'done') {
            return { label: t('archived.restoreToInbox') || 'Restore', color: getStatusColor('inbox').text, action: 'inbox' };
        } else if (task.status === 'next') {
            return { label: t('common.done') || 'Done', color: getStatusColor('done').text, action: 'done' };
        } else if (task.status === 'waiting' || task.status === 'someday' || task.status === 'reference') {
            return { label: t('status.next') || 'Next', color: getStatusColor('next').text, action: 'next' };
        } else if (task.status === 'inbox') {
            return { label: t('status.next') || 'Next', color: getStatusColor('next').text, action: 'next' };
        } else {
            return { label: t('common.done') || 'Done', color: getStatusColor('done').text, action: 'done' };
        }
    };

    const leftAction = getLeftAction();
    const swipeAccessibilityHint = selectionMode || disableSwipe
        ? 'Double tap to edit task details. Additional actions are available in the accessibility actions menu.'
        : `Double tap to edit task details. Swipe right to ${leftAction.label.toLowerCase()} and swipe left to delete. Additional actions are available in the accessibility actions menu.`;

    const renderLeftActions = () => {
        const LeftIcon = leftAction.action === 'inbox' ? RotateCcw : leftAction.action === 'done' ? Check : ArrowRight;
        return (
            <Pressable
                style={[styles.swipeActionLeft, { backgroundColor: leftAction.color }]}
                onPress={() => {
                    swipeableRef.current?.close();
                    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
                    onStatusChange(leftAction.action);
                }}
                accessibilityLabel={`${leftAction.label} action`}
                accessibilityRole="button"
            >
                <LeftIcon size={20} color="#FFFFFF" />
                <Text style={styles.swipeActionText}>{leftAction.label}</Text>
            </Pressable>
        );
    };

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeActionRight}
            onPress={() => {
                swipeableRef.current?.close();
                confirmDelete();
            }}
            accessibilityLabel={t('task.aria.delete') || 'Delete task'}
            accessibilityRole="button"
        >
            <Trash2 size={20} color="#FFFFFF" />
            <Text style={styles.swipeActionText}>{t('common.delete')}</Text>
        </Pressable>
    );

    const accessibilityLabel = [
        task.title,
        `Status: ${t(`status.${task.status}`)}`,
        (() => {
            const due = safeParseDueDate(task.dueDate);
            if (!due) return null;
            const hasTime = hasTimeComponent(task.dueDate);
            return `Due: ${safeFormatDate(due, hasTime ? 'Pp' : 'P')}`;
        })(),
    ].filter(Boolean).join('. ');

    const handlePress = () => {
        if (Date.now() < ignorePressUntil.current) return;
        if (selectionMode && onToggleSelect) {
            onToggleSelect();
            return;
        }
        onPress();
    };

    const confirmDelete = () => {
        Alert.alert(
            task.title,
            t('task.deleteConfirmBody') || 'Move this task to Trash?',
            [
                { text: t('common.cancel') || 'Cancel', style: 'cancel' },
                {
                    text: t('common.delete') || 'Delete',
                    style: 'destructive',
                    onPress: () => {
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
                        cancelPendingChecklist();
                        onDelete();
                    },
                },
            ],
            { cancelable: true }
        );
    };

    const handleLongPress = () => {
        ignorePressUntil.current = Date.now() + 500;
        // Note: onDragStart is handled by the drag handle directly, not here
        if (onLongPressAction) {
            onLongPressAction();
            return;
        }
        if (onToggleSelect) onToggleSelect();
    };

    const accessibilityActions = [
        { name: 'activate', label: t('common.edit') || 'Edit' },
        ...(!selectionMode
            ? [
                { name: 'changeStatus', label: leftAction.label },
                { name: 'delete', label: t('common.delete') || 'Delete' },
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
            onStatusChange(leftAction.action);
            return;
        }
        if (actionName === 'delete') {
            confirmDelete();
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
            hideChecklistProgress={hideChecklistProgress}
            hideContexts={hideContexts}
            hideStatusBadge={hideStatusBadge}
            isDark={isDark}
            isHighlighted={isHighlighted}
            isMultiSelected={isMultiSelected}
            language={language}
            localChecklist={localChecklist}
            onAccessibilityAction={handleAccessibilityAction}
            onContextPress={onContextPress}
            onLongPress={handleLongPress}
            onOpenStatusMenu={() => setShowStatusMenu(true)}
            onPress={handlePress}
            onProjectPress={onProjectPress}
            onTagPress={onTagPress}
            onToggleChecklist={toggleChecklist}
            onToggleChecklistItem={toggleChecklistItem}
            onToggleFocus={toggleFocus}
            projects={projects}
            selectionMode={selectionMode}
            showChecklist={showChecklist}
            t={t}
            task={{
                ...task,
                timeEstimate: timeEstimatesEnabled ? task.timeEstimate : undefined,
            }}
            tc={tc}
        />
    );

    return (
        <>
            {disableSwipe ? (
                content
            ) : (
                <Swipeable
                    ref={swipeableRef}
                    renderLeftActions={renderLeftActions}
                    renderRightActions={renderRightActions}
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
                onStatusChange={onStatusChange}
                taskStatus={task.status}
                tc={tc}
                t={t}
            />
        </>
    );
}
