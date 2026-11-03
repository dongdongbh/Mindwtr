import React, { useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { getProjectRowStatus, isFocusedProjectMissingNextAction, tFallback, type Project } from '@mindwtr/core';
import * as Haptics from 'expo-haptics';
import { Copy, Trash2, AlertTriangle, MoreHorizontal } from 'lucide-react-native';
import { Swipeable } from 'react-native-gesture-handler';

import { FocusStarIcon } from '@/components/FocusStarIcon';
import { projectsScreenStyles as styles } from '@/components/projects-screen/projects-screen.styles';
import type { ProjectTaskSummary } from './project-list-model';

type ThemeColors = {
    cardBg: string;
    border?: string;
    secondaryText: string;
    text: string;
    tint: string;
};

type StatusPalette = Record<Project['status'], { text: string; bg: string; border: string }>;

type ProjectRowProps = {
    project: Project;
    taskSummary?: ProjectTaskSummary;
    tc: ThemeColors;
    focusedCount: number;
    statusPalette: StatusPalette;
    t: (key: string) => string;
    onDeleteProject: (projectId: string) => void;
    onDuplicateProject: (projectId: string) => void;
    onOpenProject: (project: Project) => void;
    onToggleProjectFocus: (projectId: string) => void;

    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onMoveToArea?: () => void;
};

const ROW_ACTION_HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 } as const;
const PROJECT_SWIPE_FRICTION = 1.25;
const PROJECT_SWIPE_OPEN_THRESHOLD = 72;
const PROJECT_SWIPE_DRAG_OFFSET = 28;

export function ProjectRow({
    project,
    taskSummary,
    tc,
    focusedCount,
    statusPalette,
    t,
    onDeleteProject,
    onDuplicateProject,
    onOpenProject,
    onToggleProjectFocus,
    onMoveUp,
    onMoveDown,
    onMoveToArea,
}: ProjectRowProps) {
    const nextAction = taskSummary?.nextAction;
    const taskCount = taskSummary?.activeTaskCount ?? 0;
    const taskCountLabel = `${taskCount} ${t('common.tasks')}`;
    const showFocusedWarning = isFocusedProjectMissingNextAction(project, taskSummary);
    const swipeableRef = useRef<Swipeable>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const pendingAction = useRef<(() => void) | null>(null);

    const handleDuplicate = () => {
        swipeableRef.current?.close();
        void Haptics.selectionAsync().catch(() => {});
        onDuplicateProject(project.id);
    };

    const confirmDelete = () => {
        swipeableRef.current?.close();
        void Haptics.selectionAsync().catch(() => {});
        Alert.alert(
            t('projects.title'),
            t('projects.deleteConfirm'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.delete'),
                    style: 'destructive',
                    onPress: () => {
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
                        onDeleteProject(project.id);
                    },
                },
            ],
        );
    };


    const moveActions = [
        onMoveUp && { name: 'moveUp', label: t('projects.moveUp'), run: onMoveUp },
        onMoveDown && { name: 'moveDown', label: t('projects.moveDown'), run: onMoveDown },
    ].filter((action): action is { name: string; label: string; run: () => void } => Boolean(action));

    const menuActions = [
        ...moveActions,
        ...(onMoveToArea ? [{ name: 'moveToArea', label: t('projects.areaLabel'), run: onMoveToArea }] : []),
    ];
    const showMoveMenu = () => {
        if (moveActions.length === 0) return;
        void Haptics.selectionAsync().catch(() => {});
        Alert.alert(project.title, undefined, [
            ...moveActions.map((action) => ({ text: action.label, onPress: action.run })),
            { text: t('common.cancel'), style: 'cancel' as const },
        ]);
    };

    const renderLeftActions = () => (
        <Pressable
            testID={`project-row-duplicate-${project.id}`}
            onPress={handleDuplicate}
            style={[styles.projectSwipeAction, styles.projectSwipeDuplicateAction]}
            accessibilityRole="button"
            accessibilityLabel={t('projects.duplicate')}
        >
            <Copy size={20} color="#FFFFFF" />
            <Text style={styles.projectSwipeActionText}>{t('projects.duplicate')}</Text>
        </Pressable>
    );

    const renderRightActions = () => (
        <Pressable
            testID={`project-row-delete-${project.id}`}
            onPress={confirmDelete}
            style={[styles.projectSwipeAction, styles.projectSwipeDeleteAction]}
            accessibilityRole="button"
            accessibilityLabel={t('common.delete')}
        >
            <Trash2 size={20} color="#FFFFFF" />
            <Text style={styles.projectSwipeActionText}>{t('common.delete')}</Text>
        </Pressable>
    );

    const rowContent = (
        <View
            testID={`project-row-${project.id}`}
            style={[
                styles.projectItem,
                { backgroundColor: tc.cardBg },
            ]}
        >
            <TouchableOpacity
                testID={`project-row-open-${project.id}`}
                style={styles.projectTouchArea}
                onPress={() => onOpenProject(project)}
                onLongPress={moveActions.length > 0 ? showMoveMenu : undefined}
                accessibilityRole="button"
                accessibilityActions={menuActions.map(({ name, label }) => ({ name, label }))}
                onAccessibilityAction={(event) => menuActions.find((action) => action.name === event.nativeEvent.actionName)?.run()}
            >
                <View style={styles.projectContent}>
                    <View style={styles.projectTitleRow}>
                        <View style={styles.projectTitleContent}>
                            <Text style={[styles.projectTitle, { color: tc.text }]} numberOfLines={1}>
                                {project.title}
                            </Text>
                        </View>
                    </View>
                    {nextAction ? (
                        <Text
                            testID={`project-row-next-action-${project.id}`}
                            style={[styles.projectMeta, { color: tc.secondaryText }]}
                            numberOfLines={1}
                        >
                            ↳ {nextAction.title}
                        </Text>
                    ) : showFocusedWarning ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <AlertTriangle size={12} color="#F59E0B" strokeWidth={2.5} />
                            <Text style={[styles.projectMeta, { color: '#F59E0B' }]}>{t('projects.noNextAction')}</Text>
                        </View>
                    ) : (
                        <Text
                            style={[
                                styles.projectMeta,
                                { color: statusPalette[project.status]?.text ?? tc.secondaryText },
                            ]}
                        >
                            {getProjectRowStatus(project, t).statusLabel}
                        </Text>
                    )}
                </View>
            </TouchableOpacity>
            <View testID={`project-row-trailing-${project.id}`} style={styles.projectTrailingControls}>
                {menuActions.length > 0 && project.status !== 'archived' ? (
                    <TouchableOpacity
                        testID={`project-row-menu-${project.id}`}
                        onPress={() => setMenuOpen(true)}
                        style={styles.focusButton}
                        accessibilityRole="button"
                        accessibilityLabel={`${t('common.more')}: ${project.title}`}
                    >
                        <MoreHorizontal size={18} color={tc.secondaryText} />
                    </TouchableOpacity>
                ) : null}
                <View
                    accessible
                    accessibilityLabel={taskCountLabel}
                    style={styles.projectTaskCount}
                >
                    <Text style={[styles.projectTaskCountText, { color: tc.secondaryText }]}>
                        {taskCount}
                    </Text>
                </View>
                <TouchableOpacity
                    testID={`project-row-focus-${project.id}`}
                    onPress={() => {
                        void Haptics.selectionAsync().catch(() => {});
                        onToggleProjectFocus(project.id);
                    }}
                    style={styles.focusButton}
                    disabled={!project.isFocused && focusedCount >= 5}
                    accessibilityRole="button"
                    accessibilityLabel={project.isFocused
                        ? tFallback(t, 'projects.removeFromFocus', 'Remove from focus')
                        : tFallback(t, 'projects.addToFocus', 'Add to focus')}
                    accessibilityState={{ selected: project.isFocused, disabled: !project.isFocused && focusedCount >= 5 }}
                    hitSlop={ROW_ACTION_HIT_SLOP}
                >
                    <FocusStarIcon
                        focused={project.isFocused === true}
                        inactiveColor={tc.secondaryText}
                        disabled={!project.isFocused && focusedCount >= 5}
                        size={18}
                    />
                </TouchableOpacity>
            </View>
        </View>
    );

    return (
        <>
        <Swipeable
            ref={swipeableRef}
            renderLeftActions={renderLeftActions}
            renderRightActions={renderRightActions}
            friction={PROJECT_SWIPE_FRICTION}
            leftThreshold={PROJECT_SWIPE_OPEN_THRESHOLD}
            rightThreshold={PROJECT_SWIPE_OPEN_THRESHOLD}
            dragOffsetFromLeftEdge={PROJECT_SWIPE_DRAG_OFFSET}
            dragOffsetFromRightEdge={PROJECT_SWIPE_DRAG_OFFSET}
            overshootLeft={false}
            overshootRight={false}
        >
            {rowContent}
        </Swipeable>
        <Modal
            visible={menuOpen}
            transparent
            animationType="fade"
            presentationStyle="overFullScreen"
            onRequestClose={() => setMenuOpen(false)}
            onDismiss={() => {
                const action = pendingAction.current;
                pendingAction.current = null;
                action?.();
            }}
        >
            <Pressable style={styles.overlay} onPress={() => setMenuOpen(false)}>
                <Pressable style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]} onPress={(event) => event.stopPropagation()}>
                    <Text testID={`project-menu-title-${project.id}`} numberOfLines={2} accessibilityLabel={project.title} style={[styles.linkModalTitle, { color: tc.text }]}>{project.title}</Text>
                    {menuActions.map((action) => (
                        <TouchableOpacity
                            key={action.name}
                            accessibilityRole="button"
                            accessibilityLabel={action.label}
                            style={[styles.pickerRow, { borderColor: tc.border, minHeight: 44 }]}
                            onPress={() => {
                                if (Platform.OS === 'ios') pendingAction.current = action.run;
                                setMenuOpen(false);
                                if (Platform.OS !== 'ios') action.run();
                            }}
                        >
                            <Text style={[styles.pickerRowText, { color: tc.text }]}>{action.label}</Text>
                        </TouchableOpacity>
                    ))}
                </Pressable>
            </Pressable>
        </Modal>
        </>
    );
}
