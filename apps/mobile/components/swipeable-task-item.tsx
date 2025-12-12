import { View, Text, Pressable, StyleSheet, Modal } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useTaskStore, Task, getChecklistProgress, DeferPreset, getTaskAgeLabel, getTaskStaleness, getTaskUrgency, getStatusColor, safeFormatDate, TaskStatus } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useRef, useState } from 'react';
import { ThemeColors } from '../hooks/use-theme-colors';

export interface SwipeableTaskItemProps {
    task: Task;
    isDark: boolean;
    /** Theme colors object with cardBg, text, secondaryText */
    /** Theme colors object from useThemeColors hook */
    tc: ThemeColors;
    onPress: () => void;
    onStatusChange: (status: TaskStatus) => void;
    onDelete: () => void;
    /** Hide context tags (useful when viewing a specific context) */
    hideContexts?: boolean;
    /** Multi-select mode for bulk actions */
    selectionMode?: boolean;
    isMultiSelected?: boolean;
    onToggleSelect?: () => void;
}

/**
 * A swipeable task item with context-aware left swipe actions:
 * - Done tasks: swipe to Archive
 * - Next/Todo tasks: swipe to Start (in-progress)
 * - In-progress tasks: swipe to Done
 * - Other: swipe to Done (default)
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
    hideContexts = false,
    selectionMode = false,
    isMultiSelected = false,
    onToggleSelect
}: SwipeableTaskItemProps) {
    const swipeableRef = useRef<Swipeable>(null);
    const { t, language } = useLanguage();
    const { updateTask, deferTask } = useTaskStore();

    // Status-aware left swipe action
    const getLeftAction = (): { label: string; color: string; action: TaskStatus } => {
        if (task.status === 'done') {
            return { label: `📦 ${t('projects.archive')}`, color: getStatusColor('archived').text, action: 'archived' };
        } else if (task.status === 'next' || task.status === 'todo') {
            return { label: `▶️ ${t('taskEdit.start')}`, color: getStatusColor('in-progress').text, action: 'in-progress' };
        } else if (task.status === 'in-progress') {
            return { label: `✓ ${t('common.done')}`, color: getStatusColor('done').text, action: 'done' };
        } else if (task.status === 'waiting' || task.status === 'someday') {
            return { label: `▶️ ${t('status.next')}`, color: getStatusColor('next').text, action: 'next' };
        } else if (task.status === 'inbox') {
            return { label: `✓ ${t('common.done')}`, color: getStatusColor('done').text, action: 'done' };
        } else {
            return { label: `✓ ${t('common.done')}`, color: getStatusColor('done').text, action: 'done' };
        }
    };

    const leftAction = getLeftAction();
    const [showStatusMenu, setShowStatusMenu] = useState(false);
    const [showDeferMenu, setShowDeferMenu] = useState(false);
    const [showChecklist, setShowChecklist] = useState(false);

    const checklistProgress = getChecklistProgress(task);

    const deferPresets: { preset: DeferPreset; labelKey: string }[] = [
        { preset: 'tomorrow', labelKey: 'defer.tomorrow' },
        { preset: 'nextWeek', labelKey: 'defer.nextWeek' },
        { preset: 'weekend', labelKey: 'defer.weekend' },
        { preset: 'nextMonth', labelKey: 'defer.nextMonth' },
        { preset: 'pickDate', labelKey: 'defer.pickDate' },
    ];

    const handleDefer = async (preset: DeferPreset) => {
        setShowDeferMenu(false);
        if (preset === 'pickDate') {
            onPress();
            return;
        }
        await deferTask(task.id, preset);
    };

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

    const quickStatusOptions: TaskStatus[] = ['inbox', 'todo', 'next', 'in-progress', 'waiting', 'someday', 'done', 'archived'];

    const accessibilityLabel = [
        task.title,
        `Status: ${task.status}`,
        task.dueDate ? `Due: ${safeFormatDate(task.dueDate, 'P')}` : null,
        task.contexts?.length ? `Contexts: ${task.contexts.join(', ')}` : null,
        task.timeEstimate ? `Estimate: ${task.timeEstimate}` : null,
    ].filter(Boolean).join(', ');

    const handlePress = () => {
        if (selectionMode && onToggleSelect) {
            onToggleSelect();
            return;
        }
        onPress();
    };

    const handleLongPress = () => {
        if (selectionMode && onToggleSelect) {
            onToggleSelect();
            return;
        }
        setShowDeferMenu(true);
    };

    return (
        <>
            <Swipeable
                ref={swipeableRef}
                renderLeftActions={renderLeftActions}
                renderRightActions={renderRightActions}
                overshootLeft={false}
                overshootRight={false}
                enabled={!selectionMode}
            >
                <Pressable
                    style={[
                        styles.taskItem,
                        { backgroundColor: tc.cardBg },
                        selectionMode && { borderWidth: 2, borderColor: isMultiSelected ? tc.tint : tc.border }
                    ]}
                    onPress={handlePress}
                    onLongPress={handleLongPress}
                    accessibilityLabel={accessibilityLabel}
                    accessibilityHint="Double tap to edit task details. Swipe left to change status, right to delete."
                    accessibilityRole="button"
                >
                    {selectionMode && (
                        <View
                            style={[
                                styles.selectionBadge,
                                {
                                    borderColor: tc.tint,
                                    backgroundColor: isMultiSelected ? tc.tint : 'transparent'
                                }
                            ]}
                            pointerEvents="none"
                        >
                            {isMultiSelected && <Text style={styles.selectionBadgeText}>✓</Text>}
                        </View>
                    )}
                    <View style={styles.taskContent}>
                        <Text style={[styles.taskTitle, { color: tc.text }]} numberOfLines={2}>
                            {task.title}
                        </Text>
                        {task.description && (
                            <Text style={[styles.taskDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                {task.description}
                            </Text>
                        )}
                        {task.dueDate && (
                            <Text style={styles.taskDueDate}>
                                {t('taskEdit.dueDateLabel')}: {safeFormatDate(task.dueDate, 'P')}
                            </Text>
                        )}
                        {!hideContexts && task.contexts && task.contexts.length > 0 && (
                            <View style={styles.contextsRow}>
                                {task.contexts.map((ctx, idx) => (
                                    <Text key={idx} style={[styles.contextTag, { color: tc.tint }]}>
                                        {ctx}
                                    </Text>
                                ))}
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
                        {showChecklist && (task.checklist || []).length > 0 && (
                            <View style={styles.checklistItems}>
                                {(task.checklist || []).map((item, index) => (
                                    <Pressable
                                        key={item.id || index}
                                        onPress={() => {
                                            const newList = (task.checklist || []).map((it, i) =>
                                                i === index ? { ...it, isCompleted: !it.isCompleted } : it
                                            );
                                            updateTask(task.id, { checklist: newList });
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
                        {task.status !== 'done' && task.status !== 'archived' && getTaskAgeLabel(task.createdAt, language) && (
                            <View style={[
                                styles.ageBadge,
                                getTaskStaleness(task.createdAt) === 'fresh' && styles.ageFresh,
                                getTaskStaleness(task.createdAt) === 'aging' && styles.ageAging,
                                getTaskStaleness(task.createdAt) === 'stale' && styles.ageStale,
                                getTaskStaleness(task.createdAt) === 'very-stale' && styles.ageVeryStale,
                            ]}>
                                <Text style={[
                                    styles.ageText,
                                    getTaskStaleness(task.createdAt) === 'fresh' && styles.ageTextFresh,
                                    getTaskStaleness(task.createdAt) === 'aging' && styles.ageTextAging,
                                    getTaskStaleness(task.createdAt) === 'stale' && styles.ageTextStale,
                                    getTaskStaleness(task.createdAt) === 'very-stale' && styles.ageTextVeryStale,
                                ]}>⏱ {getTaskAgeLabel(task.createdAt, language)}</Text>
                            </View>
                        )}
                        {/* Time Estimate Badge */}
                        {task.timeEstimate && (
                            <View style={styles.timeBadge}>
                                <Text style={styles.timeText}>
                                    ⏱ {task.timeEstimate === '5min' ? '5m' :
                                        task.timeEstimate === '15min' ? '15m' :
                                            task.timeEstimate === '30min' ? '30m' :
                                                task.timeEstimate === '1hr' ? '1h' : '2h+'}
                                </Text>
                            </View>
                        )}
                    </View>
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
                            ['todo', 'inbox'].includes(task.status) ? styles.textDark : styles.textLight
                        ]}>
                            {t(`status.${task.status}`)}
                        </Text>
                    </Pressable>
                </Pressable>
            </Swipeable>

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

            <Modal
                visible={showDeferMenu}
                transparent
                animationType="fade"
                onRequestClose={() => setShowDeferMenu(false)}
            >
                <Pressable style={styles.modalOverlay} onPress={() => setShowDeferMenu(false)}>
                    <View style={[styles.menuContainer, { backgroundColor: tc.cardBg }]}>
                        <Text style={[styles.menuTitle, { color: tc.text }]}>{t('defer.title')}</Text>
                        <View style={styles.deferList}>
                            {deferPresets.map(({ preset, labelKey }) => (
                                <Pressable
                                    key={preset}
                                    style={[styles.deferItem, { borderColor: tc.border }]}
                                    onPress={() => handleDefer(preset)}
                                    accessibilityRole="button"
                                >
                                    <Text style={[styles.deferText, { color: tc.text }]}>{t(labelKey)}</Text>
                                </Pressable>
                            ))}
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
        padding: 16,
        borderRadius: 12,
        marginBottom: 12,
        position: 'relative',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 2,
    },
    selectionBadge: {
        position: 'absolute',
        top: 8,
        right: 8,
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 1.5,
        alignItems: 'center',
        justifyContent: 'center',
    },
    selectionBadgeText: {
        color: '#FFFFFF',
        fontSize: 12,
        fontWeight: '700',
    },
    taskContent: {
        flex: 1,
    },
    taskTitle: {
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 4,
    },
    taskDescription: {
        fontSize: 14,
        marginBottom: 4,
    },
    taskDueDate: {
        fontSize: 12,
        color: '#EF4444',
        marginTop: 4,
    },
    contextsRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
        marginTop: 8,
    },
    contextTag: {
        fontSize: 11,
        color: '#3B82F6',
        backgroundColor: '#EFF6FF',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
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
    deferList: {
        gap: 8,
    },
    deferItem: {
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: 1,
    },
    deferText: {
        fontSize: 14,
        fontWeight: '500',
        textAlign: 'center',
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
