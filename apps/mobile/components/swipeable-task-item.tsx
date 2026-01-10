import { View, Text, Pressable, StyleSheet, Modal, Alert } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useTaskStore, Task, getChecklistProgress, getTaskAgeLabel, getTaskStaleness, getStatusColor, hasTimeComponent, safeFormatDate, safeParseDueDate, TaskStatus, Project } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useRef, useState, useEffect, useMemo, type ReactNode } from 'react';
import { ThemeColors } from '../hooks/use-theme-colors';

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
}: SwipeableTaskItemProps) {
    const swipeableRef = useRef<Swipeable>(null);
    const ignorePressUntil = useRef<number>(0);
    const { t, language } = useLanguage();
    const { updateTask, projects, areas, settings, tasks } = useTaskStore();
    const timeEstimatesEnabled = settings?.features?.timeEstimates === true;

    const focusedCount = useMemo(
        () => tasks.filter((taskItem) => taskItem.isFocusedToday && !taskItem.deletedAt && taskItem.status !== 'done').length,
        [tasks]
    );

    const toggleFocus = () => {
        if (selectionMode) return;
        if (task.isFocusedToday) {
            updateTask(task.id, { isFocusedToday: false });
            return;
        }
        if (focusedCount >= 3) {
            Alert.alert(t('digest.focus') || 'Focus', t('agenda.maxFocusItems') || 'Max 3 focus items.');
            return;
        }
        updateTask(task.id, { isFocusedToday: true });
    };

    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const project: Project | undefined = task.projectId ? projects.find(p => p.id === task.projectId) : undefined;
    const projectColor = project?.areaId ? areaById.get(project.areaId)?.color : undefined;

    // Status-aware left swipe action
    const getLeftAction = (): { label: string; color: string; action: TaskStatus } => {
        if (task.status === 'done') {
            return { label: `↩ ${t('archived.restoreToInbox')}`, color: getStatusColor('inbox').text, action: 'inbox' };
        } else if (task.status === 'next') {
            return { label: `✓ ${t('common.done')}`, color: getStatusColor('done').text, action: 'done' };
        } else if (task.status === 'waiting' || task.status === 'someday') {
            return { label: `▶️ ${t('status.next')}`, color: getStatusColor('next').text, action: 'next' };
        } else if (task.status === 'inbox') {
            return { label: `▶️ ${t('status.next')}`, color: getStatusColor('next').text, action: 'next' };
        } else {
            return { label: `✓ ${t('common.done')}`, color: getStatusColor('done').text, action: 'done' };
        }
    };

    const leftAction = getLeftAction();
    const [showStatusMenu, setShowStatusMenu] = useState(false);
    const [showChecklist, setShowChecklist] = useState(false);
    const [localChecklist, setLocalChecklist] = useState(task.checklist || []);
    const checklistUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingChecklist = useRef<Task['checklist'] | null>(null);
    const checklistTaskIdRef = useRef(task.id);
    const checklistVersionRef = useRef(0);

    useEffect(() => {
        setLocalChecklist(task.checklist || []);
    }, [task.checklist]);

    useEffect(() => {
        if (checklistTaskIdRef.current !== task.id) {
            checklistTaskIdRef.current = task.id;
            pendingChecklist.current = null;
            checklistVersionRef.current += 1;
            if (checklistUpdateTimer.current) {
                clearTimeout(checklistUpdateTimer.current);
                checklistUpdateTimer.current = null;
            }
        }
    }, [task.id]);

    useEffect(() => {
        return () => {
            if (checklistUpdateTimer.current) {
                clearTimeout(checklistUpdateTimer.current);
            }
            checklistVersionRef.current += 1;
        };
    }, []);

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
    const isStagnant = (task.pushCount ?? 0) > 3;
    const staleness = getTaskStaleness(task.createdAt);
    const showAge = task.status !== 'done' && (staleness === 'stale' || staleness === 'very-stale');

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

    if (project) {
        addMetaPart(
            <View key="project" style={styles.inlineMetaItem}>
                <View style={[styles.projectDot, { backgroundColor: projectColor || tc.tint }]} />
                <Text style={[styles.metaText, { color: tc.secondaryText }]} numberOfLines={1}>
                    {project.title}
                </Text>
            </View>,
            'project'
        );
    }

    if (!hideContexts && task.contexts?.length) {
        const ctx = task.contexts[0];
        const more = task.contexts.length - 1;
        addMetaPart(
            <View key="context" style={styles.inlineMetaItem}>
                <Text style={[styles.metaText, styles.contextText]} numberOfLines={1}>
                    {ctx}
                </Text>
                {more > 0 && (
                    <Text style={[styles.metaText, { color: tc.secondaryText }]}>+{more}</Text>
                )}
            </View>,
            'context'
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

    const renderLeftActions = () => (
        <Pressable
            style={[styles.swipeActionLeft, { backgroundColor: leftAction.color }]}
            onPress={() => {
                swipeableRef.current?.close();
                onStatusChange(leftAction.action);
            }}
            accessibilityLabel={`${leftAction.label} action`}
            accessibilityRole="button"
        >
            <Text style={styles.swipeActionText}>{leftAction.label}</Text>
        </Pressable>
    );

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeActionRight}
            onPress={() => {
                swipeableRef.current?.close();
                onDelete();
            }}
            accessibilityLabel="Delete task"
            accessibilityRole="button"
        >
            <Text style={styles.swipeActionText}>🗑️ {t('common.delete')}</Text>
        </Pressable>
    );

    const quickStatusOptions: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done'];

    const accessibilityLabel = [
        task.title,
        `Status: ${task.status}`,
        dueLabel ? `Due: ${dueLabel}` : null,
        task.contexts?.length ? `Contexts: ${task.contexts.join(', ')}` : null,
        timeEstimateLabel ? `Estimate: ${timeEstimateLabel}` : null,
    ].filter(Boolean).join(', ');

    const handlePress = () => {
        if (Date.now() < ignorePressUntil.current) return;
        if (selectionMode && onToggleSelect) {
            onToggleSelect();
            return;
        }
        onPress();
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

    const content = (
        <Pressable
            style={[
                styles.taskItem,
                { backgroundColor: tc.taskItemBg },
                showFocusToggle && task.isFocusedToday && !selectionMode && { borderWidth: 2, borderColor: tc.tint },
                isHighlighted && !selectionMode && { borderWidth: 2, borderColor: tc.tint },
                selectionMode && { borderWidth: 2, borderColor: isMultiSelected ? tc.tint : tc.border }
            ]}
            onPress={handlePress}
            onLongPress={handleLongPress}
            delayLongPress={120}
            accessibilityLabel={accessibilityLabel}
            accessibilityHint="Double tap to edit task details. Swipe left to change status, right to delete."
            accessibilityRole="button"
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
                                style={[styles.taskTitle, { color: tc.text }, showFocusToggle && styles.taskTitleFlex]}
                                numberOfLines={2}
                            >
                                {task.title}
                            </Text>
                            {showFocusToggle && !selectionMode && (
                                <Pressable
                                    onPress={(event) => {
                                        event.stopPropagation();
                                        toggleFocus();
                                    }}
                                    style={styles.focusButton}
                                    accessibilityRole="button"
                                    accessibilityLabel={task.isFocusedToday ? t('agenda.removeFromFocus') : t('agenda.addToFocus')}
                                >
                                    <Text style={[styles.focusButtonText, task.isFocusedToday && styles.focusButtonActive]}>
                                        {task.isFocusedToday ? '★' : '☆'}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                        {task.description && (
                            <Text style={[styles.taskDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                {task.description}
                            </Text>
                        )}
                        {metaParts.length > 0 && (
                            <View style={styles.inlineMeta}>
                                {metaParts}
                            </View>
                        )}
                        {checklistProgress && (
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
                                            pendingChecklist.current = newList;
                                            const scheduledVersion = checklistVersionRef.current + 1;
                                            checklistVersionRef.current = scheduledVersion;
                                            if (checklistUpdateTimer.current) {
                                                clearTimeout(checklistUpdateTimer.current);
                                            }
                                            checklistUpdateTimer.current = setTimeout(() => {
                                                if (checklistVersionRef.current !== scheduledVersion) return;
                                                if (checklistTaskIdRef.current !== taskId) return;
                                                const pending = pendingChecklist.current;
                                                if (!pending) return;
                                                const latestTask = useTaskStore.getState().tasks.find((t) => t.id === taskId) || task;
                                                const isListMode = latestTask.taskMode === 'list';
                                                const allComplete = pending.length > 0 && pending.every((entry) => entry.isCompleted);
                                                const nextStatus = isListMode
                                                    ? allComplete
                                                        ? 'done'
                                                        : latestTask.status === 'done'
                                                            ? 'next'
                                                            : undefined
                                                    : undefined;
                                                updateTask(taskId, { checklist: pending, ...(nextStatus ? { status: nextStatus } : {}) });
                                            }, 200);
                                        }}
                                        style={styles.checklistItem}
                                        accessibilityRole="button"
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
                            style={[
                                styles.statusBadge,
                                { backgroundColor: getStatusColor(task.status).text }
                            ]}
                            accessibilityLabel={`Change status. Current status: ${task.status}`}
                            accessibilityHint="Double tap to open status menu"
                            accessibilityRole="button"
                        >
                            <Text style={[
                                styles.statusText,
                                styles.textLight
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
            >
                <Pressable style={styles.modalOverlay} onPress={() => setShowStatusMenu(false)}>
                    <View style={[styles.menuContainer, { backgroundColor: tc.cardBg }]}>
                        <Text style={[styles.menuTitle, { color: tc.text }]}>{t('taskStatus.changeStatus')}</Text>
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
        padding: 12,
        borderRadius: 10,
        marginBottom: 8,
        position: 'relative',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0,
        shadowRadius: 0,
        elevation: 0,
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
        fontWeight: '600',
        lineHeight: 20,
    },
    taskTitleFlex: {
        flex: 1,
    },
    focusButton: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 10,
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
    },
    focusButtonText: {
        fontSize: 16,
        color: '#94A3B8',
    },
    focusButtonActive: {
        color: '#F59E0B',
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
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        marginLeft: 12,
        minWidth: 60,
        alignItems: 'center',
    },
    statusText: {
        fontSize: 10,
        fontWeight: '600',
        textTransform: 'capitalize',
    },
    textLight: {
        color: '#FFFFFF',
    },
    textDark: {
        color: '#374151',
    },
    swipeActionLeft: {
        backgroundColor: '#10B981',
        justifyContent: 'center',
        alignItems: 'center',
        width: 100,
        borderRadius: 12,
        marginBottom: 12,
        marginRight: 8,
    },
    swipeActionRight: {
        backgroundColor: '#EF4444',
        justifyContent: 'center',
        alignItems: 'center',
        width: 100,
        borderRadius: 12,
        marginBottom: 12,
        marginLeft: 8,
    },
    swipeActionText: {
        color: '#FFFFFF',
        fontWeight: '600',
        fontSize: 14,
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
