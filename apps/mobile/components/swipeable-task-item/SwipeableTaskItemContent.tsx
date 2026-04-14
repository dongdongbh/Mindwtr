import React, { type ReactNode, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
    getTaskAgeLabel,
    getTaskStaleness,
    getStatusColor,
    hasTimeComponent,
    resolveTaskTextDirection,
    safeFormatDate,
    safeParseDueDate,
} from '@mindwtr/core';
import type { Area, Language, Project, Task } from '@mindwtr/core';
import type { ThemeColors } from '../../hooks/use-theme-colors';
import { styles } from './swipeable-task-item.styles';

interface SwipeableTaskItemContentProps {
    accessibilityActions: { label: string; name: string }[];
    accessibilityHint: string;
    accessibilityLabel: string;
    canShowFocusToggle: boolean;
    checklistProgress: { completed: number; percent: number; total: number } | null;
    hideChecklistProgress: boolean;
    hideContexts: boolean;
    hideStatusBadge: boolean;
    isDark: boolean;
    isHighlighted: boolean;
    isMultiSelected: boolean;
    language: string;
    localChecklist: Task['checklist'];
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => void;
    onContextPress?: (context: string) => void;
    onLongPress: () => void;
    onOpenStatusMenu: () => void;
    onPress: () => void;
    onProjectPress?: (projectId: string) => void;
    onTagPress?: (tag: string) => void;
    onToggleChecklist: () => void;
    onToggleChecklistItem: (index: number) => void;
    onToggleFocus: () => void;
    projects: Project[];
    areas: Area[];
    selectionMode: boolean;
    showChecklist: boolean;
    t: (key: string) => string;
    task: Task;
    tc: ThemeColors;
}

export function SwipeableTaskItemContent({
    accessibilityActions,
    accessibilityHint,
    accessibilityLabel,
    areas,
    canShowFocusToggle,
    checklistProgress,
    hideChecklistProgress,
    hideContexts,
    hideStatusBadge,
    isDark,
    isHighlighted,
    isMultiSelected,
    language,
    localChecklist,
    onAccessibilityAction,
    onContextPress,
    onLongPress,
    onOpenStatusMenu,
    onPress,
    onProjectPress,
    onTagPress,
    onToggleChecklist,
    onToggleChecklistItem,
    onToggleFocus,
    projects,
    selectionMode,
    showChecklist,
    t,
    task,
    tc,
}: SwipeableTaskItemContentProps) {
    const { project, projectColor } = useMemo(() => {
        const activeProject = task.projectId ? projects.find((item) => item.id === task.projectId) : undefined;
        const projectArea = activeProject?.areaId
            ? areas.find((area) => area.id === activeProject.areaId)
            : undefined;
        return {
            project: activeProject,
            projectColor: projectArea?.color,
        };
    }, [areas, projects, task.projectId]);

    const resolvedDirection = resolveTaskTextDirection(task);
    const textDirection = resolvedDirection === 'rtl' ? 'rtl' : 'ltr';
    const textAlign = resolvedDirection === 'rtl' ? 'right' : 'left';
    const timeEstimateLabel = (() => {
        if (!task.timeEstimate) return null;
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
    const ageLabel = getTaskAgeLabel(task.createdAt, language as Language);
    const showAge = task.status !== 'done'
        && task.status !== 'reference'
        && (staleness === 'stale' || staleness === 'very-stale')
        && !!ageLabel;
    const statusColors = getStatusColor(task.status);
    const metaParts: ReactNode[] = [];
    const canNavigateMeta = !selectionMode;

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

    const renderMetaItem = ({
        accessibilityLabel: metaAccessibilityLabel,
        children,
        key,
        onPress: onMetaPress,
    }: {
        accessibilityLabel?: string;
        children: ReactNode;
        key: string;
        onPress?: () => void;
    }) => {
        if (!onMetaPress) {
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
                    onMetaPress();
                }}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={metaAccessibilityLabel}
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
        const context = task.contexts[0];
        const moreContexts = task.contexts.length - 1;
        addMetaPart(
            renderMetaItem({
                key: 'context',
                onPress: canNavigateMeta && onContextPress ? () => onContextPress(context) : undefined,
                accessibilityLabel: `Open context ${context}`,
                children: (
                    <>
                        <Text style={[styles.metaText, styles.contextText]} numberOfLines={1}>
                            {context}
                        </Text>
                        {moreContexts > 0 && (
                            <Text style={[styles.metaText, { color: tc.secondaryText }]}>+{moreContexts}</Text>
                        )}
                    </>
                ),
            }),
            'context'
        );
    }

    if (task.tags?.length) {
        const tag = task.tags[0];
        const moreTags = task.tags.length - 1;
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
                        {moreTags > 0 && (
                            <Text style={[styles.metaText, { color: tc.secondaryText }]}>+{moreTags}</Text>
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

    return (
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
                selectionMode && { borderWidth: 2, borderColor: isMultiSelected ? tc.tint : tc.border },
            ]}
            onPress={onPress}
            onLongPress={onLongPress}
            delayLongPress={300}
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={accessibilityHint}
            accessibilityRole="button"
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
        >
            {selectionMode && (
                <View
                    style={[
                        styles.selectionIndicator,
                        {
                            borderColor: tc.tint,
                            backgroundColor: isMultiSelected ? tc.tint : 'transparent',
                        },
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
                                onToggleFocus();
                            }}
                            hitSlop={8}
                            style={[
                                styles.focusButton,
                                { backgroundColor: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.08)' },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={task.isFocusedToday ? t('agenda.removeFromFocus') : t('agenda.addToFocus')}
                        >
                            <Text
                                style={[
                                    styles.focusButtonText,
                                    { color: task.isFocusedToday ? tc.warning : tc.secondaryText },
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
                        onPress={onToggleChecklist}
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
                                    { width: `${Math.round(checklistProgress.percent * 100)}%`, backgroundColor: tc.tint },
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
                                onPress={() => onToggleChecklistItem(index)}
                                style={styles.checklistItem}
                                accessibilityRole="button"
                                accessibilityLabel={item.title}
                                accessibilityState={{ checked: item.isCompleted }}
                            >
                                <Text
                                    style={[
                                        styles.checklistItemText,
                                        { color: tc.secondaryText },
                                        item.isCompleted && styles.checklistItemCompleted,
                                    ]}
                                    numberOfLines={1}
                                >
                                    {item.isCompleted ? '✓ ' : '○ '} {item.title}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                )}
                {showAge && (
                    <Text style={[styles.staleText, { color: tc.secondaryText }]}>
                        ⏱ {ageLabel}
                    </Text>
                )}
            </View>
            {!hideStatusBadge && (
                <Pressable
                    onPress={(event) => {
                        event.stopPropagation();
                        onOpenStatusMenu();
                    }}
                    hitSlop={8}
                    style={[
                        styles.statusBadge,
                        { backgroundColor: statusColors.bg, borderColor: statusColors.border },
                    ]}
                    accessibilityLabel={`Change status. Current status: ${task.status}`}
                    accessibilityHint="Double tap to open status menu"
                    accessibilityRole="button"
                >
                    <Text style={[styles.statusText, { color: statusColors.text }]}>
                        {t(`status.${task.status}`)}
                    </Text>
                </Pressable>
            )}
        </Pressable>
    );
}
