import { View, Text, Pressable, StyleSheet, Modal, Alert } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useTaskStore, Task, getChecklistProgress, getTaskAgeLabel, getTaskStaleness, getStatusColor, hasTimeComponent, safeFormatDate, safeParseDueDate, TaskStatus, Project, resolveTaskTextDirection, shallow } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import React, { useRef, useState, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { ArrowRight, Check, RotateCcw, Trash2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { ThemeColors } from '../hooks/use-theme-colors';
import { useToast } from '../contexts/toast-context';

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

    const { project, projectColor } = useMemo((): { project: Project | undefined; projectColor: string | undefined } => {
        const project = task.projectId ? projects.find((item) => item.id === task.projectId) : undefined;
        const projectArea = project?.areaId
            ? areas.find((area) => area.id === project.areaId)
            : undefined;
        return {
            project,
            projectColor: projectArea?.color,
        };
    }, [areas, projects, task.projectId]);
    const resolvedDirection = resolveTaskTextDirection(task);
    const textDirection = resolvedDirection === 'rtl' ? 'rtl' : 'ltr';
    const textAlign = resolvedDirection === 'rtl' ? 'right' : 'left';

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
    const [showStatusMenu, setShowStatusMenu] = useState(false);
    const [showChecklist, setShowChecklist] = useState(false);
    const [localChecklist, setLocalChecklist] = useState(task.checklist || []);
    const checklistUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingChecklist = useRef<{ taskId: string; checklist: Task['checklist'] } | null>(null);
    const checklistTaskIdRef = useRef(task.id);
    const clearChecklistTimer = useCallback(() => {
        if (checklistUpdateTimer.current) {
            clearTimeout(checklistUpdateTimer.current);
            checklistUpdateTimer.current = null;
        }
    }, []);
    const cancelPendingChecklist = useCallback(() => {
        clearChecklistTimer();
        pendingChecklist.current = null;
    }, [clearChecklistTimer]);

    const flushPendingChecklist = useCallback(() => {
        const pending = pendingChecklist.current;
        if (!pending) return;
        const { taskId } = pending;
        const checklist = pending.checklist ?? [];
        const latestTask = useTaskStore.getState().tasks.find((t) => t.id === taskId);
        if (!latestTask || latestTask.deletedAt) {
            pendingChecklist.current = null;
            return;
        }
        const isListMode = latestTask.taskMode === 'list';
        const allComplete = checklist.length > 0 && checklist.every((entry) => entry.isCompleted);
        const nextStatus = isListMode
            ? allComplete
                ? 'done'
                : latestTask.status === 'done'
                    ? 'next'
                    : undefined
            : undefined;
        updateTask(taskId, { checklist, ...(nextStatus ? { status: nextStatus } : {}) });
        pendingChecklist.current = null;
    }, [updateTask]);

    useEffect(() => {
        setLocalChecklist(task.checklist || []);
    }, [task.checklist]);

    useEffect(() => {
        if (checklistTaskIdRef.current !== task.id) {
            flushPendingChecklist();
            checklistTaskIdRef.current = task.id;
            clearChecklistTimer();
        }
    }, [task.id, clearChecklistTimer, flushPendingChecklist]);

    useEffect(() => {
        if (task.deletedAt) {
            cancelPendingChecklist();
        }
    }, [task.deletedAt, cancelPendingChecklist]);

    useEffect(() => {
        return () => {
            clearChecklistTimer();
            flushPendingChecklist();
        };
    }, [clearChecklistTimer, flushPendingChecklist]);

    const checklistProgress = useMemo(
        () => getChecklistProgress({ ...task, checklist: localChecklist }),
        [task, localChecklist]
    );

    const timeEstimateLabel = (() => {
        if (!timeEstimatesEnabled || !task.timeEstimate) return null;
        if (task.timeEstimate === '5min') return '5m';
        if (task.timeEstimate === '10min') return '10m';
        if (task.timeEstimate === '15min') return '15m';
        if (task.timeEstimate === '30min') return '30m';
        if (task.timeEstimate === '1hr') return '1h';
        if (task.timeEstimate === '2hr') return '2h';
        if (task.timeEstimate === '3hr') return '3h';
        if (task.timeEstimate === '4hr') return '4h';
        return '4h+';
    })();

    const dueLabel = (() => {
        const due = safeParseDueDate(task.dueDate);
        if (!due) return null;
        const hasTime = hasTimeComponent(task.dueDate);
        return safeFormatDate(due, hasTime ? 'Pp' : 'P');
    })();
    const staleness = getTaskStaleness(task.createdAt);
    const showAge = task.status !== 'done' && task.status !== 'reference' && (staleness === 'stale' || staleness === 'very-stale');

    const metaParts: ReactNode[] = [];
    const addMetaPart = (node: ReactNode, key: string) => {
        if (metaParts.length > 0) {
            metaParts.push(
                <Text key={`sep-${key}`} style={[styles.metaSeparator, { color: tc.secondaryText }]}>
                    ·
                </Text>
            );
        }
        metaParts.push(node);
    };
    const canNavigateMeta = !selectionMode;
    const renderMetaItem = ({
        key,
        onPress,
        accessibilityLabel,
        children,
    }: {
        key: string;
        onPress?: () => void;
        accessibilityLabel?: string;
        children: ReactNode;
    }) => {
        if (!onPress) {
            return (
                <View key={key} style={styles.inlineMetaItem}>
                    {children}
                </View>
            );
        }
        return (
            <Pressable
                key={key}
                onPress={(event) => {
                    event.stopPropagation();
                    onPress();
                }}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                style={styles.inlineMetaButton}
            >
                <View style={styles.inlineMetaItem}>
                    {children}
                </View>
            </Pressable>
        );
    };

    if (project) {
        addMetaPart(
            renderMetaItem({
                key: 'project',
                onPress: canNavigateMeta && onProjectPress ? () => onProjectPress(project.id) : undefined,
                accessibilityLabel: `Open project ${project.title}`,
                children: (
                    <>
                        <View style={[styles.projectDot, { backgroundColor: projectColor || tc.tint }]} />
                        <Text style={[styles.metaText, { color: tc.secondaryText }]} numberOfLines={1}>
                            {project.title}
                        </Text>
                    </>
                ),
            }),
            'project'
        );
    }

    if (!hideContexts && task.contexts?.length) {
        const ctx = task.contexts[0];
        const more = task.contexts.length - 1;
        addMetaPart(
            renderMetaItem({
                key: 'context',
                onPress: canNavigateMeta && onContextPress ? () => onContextPress(ctx) : undefined,
                accessibilityLabel: `Open context ${ctx}`,
                children: (
                    <>
                        <Text style={[styles.metaText, styles.contextText]} numberOfLines={1}>
                            {ctx}
                        </Text>
                        {more > 0 && (
                            <Text style={[styles.metaText, { color: tc.secondaryText }]}>+{more}</Text>
                        )}
                    </>
                ),
            }),
            'context'
        );
    }

    if (task.tags?.length) {
        const tag = task.tags[0];
        const more = task.tags.length - 1;
        addMetaPart(
            renderMetaItem({
                key: 'tag',
                onPress: canNavigateMeta && onTagPress ? () => onTagPress(tag) : undefined,
                accessibilityLabel: `Open tag ${tag}`,
                children: (
                    <>
                        <Text style={[styles.metaText, styles.tagText]} numberOfLines={1}>
                            {tag}
                        </Text>
                        {more > 0 && (
                            <Text style={[styles.metaText, { color: tc.secondaryText }]}>+{more}</Text>
                        )}
                    </>
                ),
            }),
            'tag'
        );
    }

    if (dueLabel) {
        addMetaPart(
            <Text key="due" style={[styles.metaText, styles.dueText]}>
                {dueLabel}
            </Text>,
            'due'
        );
    }

    if (timeEstimateLabel) {
        addMetaPart(
            <Text key="estimate" style={[styles.metaText, { color: tc.secondaryText }]}>
                {timeEstimateLabel}
            </Text>,
            'estimate'
        );
    }

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

    const quickStatusOptions: TaskStatus[] = task.status === 'reference'
        ? ['inbox', 'next', 'waiting', 'someday', 'reference', 'done']
        : ['inbox', 'next', 'waiting', 'someday', 'done'];

    const accessibilityLabel = [
        task.title,
        `Status: ${t(`status.${task.status}`)}`,
        dueLabel ? `Due: ${dueLabel}` : null,
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

    const statusColors = getStatusColor(task.status);
    const content = (
        <Pressable
            style={[
                styles.taskItem,
                { backgroundColor: tc.taskItemBg },
                { borderWidth: StyleSheet.hairlineWidth, borderColor: tc.border },
                !isDark && {
                    shadowColor: '#0F172A',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.06,
                    shadowRadius: 6,
                    elevation: 2,
                },
                canShowFocusToggle && task.isFocusedToday && !selectionMode && { borderWidth: 2, borderColor: tc.tint },
                isHighlighted && !selectionMode && { borderWidth: 2, borderColor: tc.tint },
                selectionMode && { borderWidth: 2, borderColor: isMultiSelected ? tc.tint : tc.border }
            ]}
            onPress={handlePress}
            onLongPress={handleLongPress}
            delayLongPress={300}
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={swipeAccessibilityHint}
            accessibilityRole="button"
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={handleAccessibilityAction}
        >
            {selectionMode && (
                <View
                    style={[
                        styles.selectionIndicator,
                        {
                            borderColor: tc.tint,
                            backgroundColor: isMultiSelected ? tc.tint : 'transparent'
                        }
                    ]}
                    pointerEvents="none"
                >
                    {isMultiSelected && <Text style={styles.selectionIndicatorText}>✓</Text>}
                </View>
            )}
            <View style={styles.taskContent}>
                        <View style={styles.titleRow}>
                            <Text
                                style={[
                                    styles.taskTitle,
                                    { color: tc.text, writingDirection: textDirection, textAlign },
                                    canShowFocusToggle && styles.taskTitleFlex,
                                ]}
                                numberOfLines={2}
                            >
                                {task.title}
                            </Text>
                            {canShowFocusToggle && !selectionMode && (
                                <Pressable
                                    onPress={(event) => {
                                        event.stopPropagation();
                                        toggleFocus();
                                    }}
                                    hitSlop={8}
                                    style={[
                                        styles.focusButton,
                                        { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.08)' }
                                    ]}
                                    accessibilityRole="button"
                                    accessibilityLabel={task.isFocusedToday ? t('agenda.removeFromFocus') : t('agenda.addToFocus')}
                                >
                                    <Text
                                        style={[
                                            styles.focusButtonText,
                                            { color: task.isFocusedToday ? tc.warning : tc.secondaryText }
                                        ]}
                                    >
                                        {task.isFocusedToday ? '★' : '☆'}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                        {task.description && (
                            <Text
                                style={[styles.taskDescription, { color: tc.secondaryText, writingDirection: textDirection, textAlign }]}
                                numberOfLines={1}
                            >
                                {task.description}
                            </Text>
                        )}
                        {metaParts.length > 0 && (
                            <View style={styles.inlineMeta}>
                                {metaParts}
                            </View>
                        )}
                        {!hideChecklistProgress && checklistProgress && (
                            <Pressable
                                onPress={() => setShowChecklist((v) => !v)}
                                style={styles.checklistRow}
                                accessibilityRole="button"
                                accessibilityLabel={t('checklist.progress')}
                            >
                                <Text style={[styles.checklistText, { color: tc.secondaryText }]}>
                                    {checklistProgress.completed}/{checklistProgress.total}
                                </Text>
                                <View style={[styles.checklistBar, { backgroundColor: tc.border }]}>
                                    <View
                                        style={[
                                            styles.checklistBarFill,
                                            { width: `${Math.round(checklistProgress.percent * 100)}%`, backgroundColor: tc.tint }
                                        ]}
                                    />
                                </View>
                            </Pressable>
                        )}
                        {showChecklist && (localChecklist || []).length > 0 && (
                            <View style={styles.checklistItems}>
                                {(localChecklist || []).map((item, index) => (
                                    <Pressable
                                        key={item.id || index}
                                        onPress={() => {
                                            const taskId = task.id;
                                            const newList = (localChecklist || []).map((it, i) =>
                                                i === index ? { ...it, isCompleted: !it.isCompleted } : it
                                            );
                                            setLocalChecklist(newList);
                                            pendingChecklist.current = { taskId, checklist: newList };
                                            clearChecklistTimer();
                                            checklistUpdateTimer.current = setTimeout(() => {
                                                const pending = pendingChecklist.current;
                                                if (!pending || pending.taskId !== taskId) return;
                                                flushPendingChecklist();
                                                checklistUpdateTimer.current = null;
                                            }, 200);
                                        }}
                                        style={styles.checklistItem}
                                        accessibilityRole="button"
                                        accessibilityLabel={item.title}
                                        accessibilityState={{ checked: item.isCompleted }}
                                    >
                                        <Text
                                            style={[
                                                styles.checklistItemText,
                                                { color: tc.secondaryText },
                                                item.isCompleted && styles.checklistItemCompleted
                                            ]}
                                            numberOfLines={1}
                                        >
                                            {item.isCompleted ? '✓ ' : '○ '} {item.title}
                                        </Text>
                                    </Pressable>
                                ))}
                            </View>
                        )}
                        {/* Task Age Indicator */}
                        {showAge && getTaskAgeLabel(task.createdAt, language) && (
                            <Text style={[styles.staleText, { color: tc.secondaryText }]}>
                                ⏱ {getTaskAgeLabel(task.createdAt, language)}
                            </Text>
                        )}
                    </View>
                    {!hideStatusBadge && (
                        <Pressable
                            onPress={(e) => {
                                e.stopPropagation();
                                setShowStatusMenu(true);
                            }}
                            hitSlop={8}
                            style={[
                                styles.statusBadge,
                                { backgroundColor: statusColors.bg, borderColor: statusColors.border }
                            ]}
                            accessibilityLabel={`Change status. Current status: ${task.status}`}
                            accessibilityHint="Double tap to open status menu"
                            accessibilityRole="button"
                        >
                            <Text style={[
                                styles.statusText,
                                { color: statusColors.text }
                            ]}>
                                {t(`status.${task.status}`)}
                            </Text>
                        </Pressable>
                    )}
        </Pressable>
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

            <Modal
                visible={showStatusMenu}
                transparent
                animationType="fade"
                onRequestClose={() => setShowStatusMenu(false)}
                accessibilityViewIsModal
            >
                <Pressable style={styles.modalOverlay} onPress={() => setShowStatusMenu(false)}>
                    <View style={[styles.menuContainer, { backgroundColor: tc.cardBg }]}>
                        <Text style={[styles.menuTitle, { color: tc.text }]} accessibilityRole="header">
                            {t('taskStatus.changeStatus')}
                        </Text>
                        <View style={styles.menuGrid}>
                            {quickStatusOptions.map(status => {
                                const colors = getStatusColor(status as TaskStatus);
                                return (
                                    <Pressable
                                        key={status}
                                        style={[
                                            styles.menuItem,
                                            task.status === status && { backgroundColor: colors.bg },
                                            { borderColor: colors.text }
                                        ]}
                                        onPress={() => {
                                            onStatusChange(status);
                                            setShowStatusMenu(false);
                                        }}
                                        accessibilityRole="button"
                                        accessibilityLabel={t(`status.${status}`)}
                                        accessibilityState={{ selected: task.status === status }}
                                    >
                                        <View style={[styles.menuDot, { backgroundColor: colors.text }]} />
                                        <Text style={[styles.menuText, { color: tc.text }]}>{t(`status.${status}`)}</Text>
                                    </Pressable>
                                );
                            })}
                        </View>
                    </View>
                </Pressable>
            </Modal>
        </>
    );
}

const styles = StyleSheet.create({
    taskItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderRadius: 14,
        marginBottom: 8,
        position: 'relative',
    },
    selectionIndicator: {
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    selectionIndicatorText: {
        color: '#FFFFFF',
        fontSize: 12,
        fontWeight: '700',
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    taskContent: {
        flex: 1,
    },
    taskTitle: {
        fontSize: 15,
        fontWeight: '500',
        lineHeight: 20,
    },
    taskTitleFlex: {
        flex: 1,
    },
    focusButton: {
        minWidth: 44,
        minHeight: 44,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 10,
        justifyContent: 'center',
        alignItems: 'center',
    },
    focusButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    taskDescription: {
        fontSize: 12,
        marginTop: 2,
    },
    inlineMeta: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 4,
        marginTop: 4,
    },
    inlineMetaItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        maxWidth: '100%',
    },
    inlineMetaButton: {
        maxWidth: '100%',
    },
    metaText: {
        fontSize: 12,
        fontWeight: '500',
    },
    metaSeparator: {
        fontSize: 12,
        fontWeight: '600',
        marginHorizontal: 2,
    },
    contextText: {
        color: '#3B82F6',
    },
    tagText: {
        color: '#7C3AED',
    },
    dueText: {
        color: '#EF4444',
        fontWeight: '600',
    },
    projectDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    staleText: {
        fontSize: 11,
        marginTop: 4,
    },
    metaPill: {
        borderWidth: 1,
        paddingHorizontal: 8,
        paddingVertical: 0,
        borderRadius: 999,
        fontSize: 10,
        lineHeight: 13,
        includeFontPadding: false,
        textAlignVertical: 'center',
        overflow: 'hidden',
    },
    tagsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
        marginTop: 8,
    },
    tagChip: {
        fontSize: 10,
        paddingHorizontal: 8,
        paddingVertical: 0,
        borderRadius: 9,
        lineHeight: 13,
        includeFontPadding: false,
        textAlignVertical: 'center',
    },
    tagChipLight: {
        color: '#6D28D9',
        backgroundColor: '#F5F3FF',
    },
    tagChipDark: {
        color: '#C4B5FD',
        backgroundColor: 'rgba(139,92,246,0.18)',
        borderWidth: 1,
        borderColor: 'rgba(139,92,246,0.35)',
    },
    contextsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
        marginTop: 8,
    },
    contextTag: {
        fontSize: 10,
        paddingHorizontal: 8,
        paddingVertical: 0,
        borderRadius: 9,
        lineHeight: 13,
        includeFontPadding: false,
        textAlignVertical: 'center',
    },
    contextTagLight: {
        color: '#1D4ED8',
        backgroundColor: '#EFF6FF',
    },
    contextTagDark: {
        color: '#93C5FD',
        backgroundColor: 'rgba(59,130,246,0.18)',
        borderWidth: 1,
        borderColor: 'rgba(59,130,246,0.35)',
    },
    checklistRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 8,
    },
    checklistText: {
        fontSize: 11,
        fontWeight: '600',
    },
    checklistBar: {
        flex: 1,
        height: 4,
        borderRadius: 2,
        overflow: 'hidden',
    },
    checklistBarFill: {
        height: '100%',
        backgroundColor: '#3B82F6',
    },
    checklistItems: {
        marginTop: 6,
        gap: 4,
    },
    checklistItem: {
        paddingVertical: 2,
    },
    checklistItemText: {
        fontSize: 11,
    },
    checklistItemCompleted: {
        textDecorationLine: 'line-through',
        opacity: 0.6,
    },
    statusBadge: {
        minHeight: 44,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        marginLeft: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    statusText: {
        fontSize: 10,
        fontWeight: '600',
        textTransform: 'capitalize',
    },
    swipeActionLeft: {
        backgroundColor: '#10B981',
        justifyContent: 'center',
        alignItems: 'center',
        width: 90,
        borderRadius: 14,
        marginBottom: 8,
        marginRight: 8,
        gap: 4,
    },
    swipeActionRight: {
        backgroundColor: '#EF4444',
        justifyContent: 'center',
        alignItems: 'center',
        width: 90,
        borderRadius: 14,
        marginBottom: 8,
        marginLeft: 8,
        gap: 4,
    },
    swipeActionText: {
        color: '#FFFFFF',
        fontWeight: '600',
        fontSize: 12,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    menuContainer: {
        width: '100%',
        maxWidth: 340,
        borderRadius: 16,
        padding: 20,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
        elevation: 5,
    },
    menuTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 16,
        textAlign: 'center',
    },
    menuGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
        justifyContent: 'center',
    },
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 20,
        borderWidth: 1,
        minWidth: '40%',
    },
    menuDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 8,
    },
    menuText: {
        fontSize: 14,
        fontWeight: '500',
        textTransform: 'capitalize',
    },
    // Task Age Indicator styles
    ageBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
        marginTop: 6,
        alignSelf: 'flex-start',
    },
    ageFresh: {
        backgroundColor: '#D1FAE5',
    },
    ageAging: {
        backgroundColor: '#FEF3C7',
    },
    ageStale: {
        backgroundColor: '#FFEDD5',
    },
    ageVeryStale: {
        backgroundColor: '#FEE2E2',
    },
    ageText: {
        fontSize: 10,
        fontWeight: '500',
    },
    ageTextFresh: {
        color: '#047857',
    },
    ageTextAging: {
        color: '#B45309',
    },
    ageTextStale: {
        color: '#C2410C',
    },
    ageTextVeryStale: {
        color: '#DC2626',
    },
    timeBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
        marginTop: 6,
        marginLeft: 6,
        alignSelf: 'flex-start',
        backgroundColor: '#DBEAFE',
    },
    timeText: {
        fontSize: 10,
        fontWeight: '500',
        color: '#1D4ED8',
    },
});
