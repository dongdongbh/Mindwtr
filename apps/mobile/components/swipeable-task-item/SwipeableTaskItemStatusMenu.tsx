import React from 'react';
import { useToast } from '../../contexts/toast-context';
import { copyTaskReference } from '../../lib/task-reference-clipboard';
import { Modal, Pressable, Text, View } from 'react-native';
import { TaskStatus, tFallback } from '@mindwtr/core';
import type { ThemeColors } from '../../hooks/use-theme-colors';
import { useStatusColors } from '../../hooks/use-status-colors';
import { styles } from './swipeable-task-item.styles';

interface SwipeableTaskItemStatusMenuProps {
    /** Long-press on the Done option completes the task with a picked timestamp. */
    onBackdatedComplete?: () => void;
    onClose: () => void;
    onStatusChange: (status: TaskStatus) => void;
    onMoveToSection?: () => void;
    onMoveToDestination?: () => void;
    taskId: string;
    taskStatus: TaskStatus;
    tc: ThemeColors;
    t: (key: string) => string;
    visible: boolean;
}

const QUICK_STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'];

export function SwipeableTaskItemStatusMenu({
    onBackdatedComplete,
    onClose,
    onStatusChange,
    onMoveToSection,
    onMoveToDestination,
    taskId,
    taskStatus,
    tc,
    t,
    visible,
}: SwipeableTaskItemStatusMenuProps) {
    const statusColors = useStatusColors();
    const { showToast } = useToast();
    const moveToDestinationLabel = tFallback(t, 'task.moveToProjectOrArea', 'Move to project or area…');
    const moveToSectionLabel = tFallback(t, 'viewSections.moveToSection', 'Move to section…');
    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
            accessibilityViewIsModal
        >
            <Pressable style={styles.modalOverlay} onPress={onClose}>
                <View style={[styles.menuContainer, { backgroundColor: tc.cardBg }]}>
                    <Text style={[styles.menuTitle, { color: tc.text }]} accessibilityRole="header">
                        {t('taskStatus.changeStatus')}
                    </Text>
                    <View style={styles.menuGrid}>
                        {QUICK_STATUS_OPTIONS.map((status) => {
                            const colors = statusColors[status];
                            return (
                                <Pressable
                                    key={status}
                                    style={[
                                        styles.menuItem,
                                        taskStatus === status && { backgroundColor: colors.bg },
                                        { borderColor: colors.text },
                                    ]}
                                    onPress={() => {
                                        onStatusChange(status);
                                        onClose();
                                    }}
                                    onLongPress={status === 'done' && onBackdatedComplete ? () => {
                                        onBackdatedComplete();
                                        onClose();
                                    } : undefined}
                                    accessibilityRole="button"
                                    accessibilityLabel={t(`status.${status}`)}
                                    accessibilityHint={status === 'done' && onBackdatedComplete
                                        ? tFallback(t, 'task.completeBackdateHintMobile', 'Long-press to complete with a different time')
                                        : undefined}
                                    accessibilityState={{ selected: taskStatus === status }}
                                >
                                    <View style={[styles.menuDot, { backgroundColor: colors.text }]} />
                                    <Text style={[styles.menuText, { color: tc.text }]}>{t(`status.${status}`)}</Text>
                                </Pressable>
                            );
                        })}
                    </View>
                    <View style={styles.menuMoveActions}>
                        {(['link', 'id'] as const).map((kind) => {
                            const label = kind === 'link'
                                ? tFallback(t, 'task.copyTaskLink', 'Copy task link')
                                : tFallback(t, 'task.copyTaskId', 'Copy task ID');
                            return (
                                <Pressable
                                    key={`copy-${kind}`}
                                    style={[styles.menuMoveItem, { borderColor: tc.border }]}
                                    onPress={() => {
                                        void copyTaskReference(taskId, kind, t, showToast);
                                        onClose();
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={label}
                                >
                                    <Text style={[styles.menuMoveText, { color: tc.text }]}>{label}</Text>
                                </Pressable>
                            );
                        })}
                    </View>
                    {onMoveToDestination || onMoveToSection ? (
                        <View style={styles.menuMoveActions}>
                            {onMoveToDestination ? (
                                <Pressable
                                    style={[styles.menuMoveItem, { borderColor: tc.border }]}
                                    onPress={() => {
                                        onMoveToDestination();
                                        onClose();
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={moveToDestinationLabel}
                                >
                                    <Text style={[styles.menuMoveText, { color: tc.text }]}>{moveToDestinationLabel}</Text>
                                </Pressable>
                            ) : null}
                            {onMoveToSection ? (
                                <Pressable
                                    style={[styles.menuMoveItem, { borderColor: tc.border }]}
                                    onPress={() => {
                                        onMoveToSection();
                                        onClose();
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={moveToSectionLabel}
                                >
                                    <Text style={[styles.menuMoveText, { color: tc.text }]}>{moveToSectionLabel}</Text>
                                </Pressable>
                            ) : null}
                        </View>
                    ) : null}
                </View>
            </Pressable>
        </Modal>
    );
}
