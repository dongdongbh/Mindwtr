import React, { type ReactNode, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { AlignLeft, Check, CircleDot, History, Hourglass, ListChecks, Paperclip, Repeat, UserRound } from 'lucide-react-native';
import { useThemeTokens } from '../../hooks/use-theme-tokens';
import { useStatusColors } from '../../hooks/use-status-colors';
import {
    formatI18nTemplate,
    tFallback,
    TASK_PRIORITY_COLORS,
} from '@mindwtr/core';
import type { ProjectSequenceTaskCue, Task, TaskRowMeta, TaskRowMetaPart } from '@mindwtr/core';
import type { ThemeColors } from '../../hooks/use-theme-colors';
import { AppPressable } from '../app-pressable';
import { FocusStarIcon } from '../FocusStarIcon';
import { MarkdownInlineText } from '../markdown-text';
import { styles } from './swipeable-task-item.styles';
import { CompactText } from '@/components/compact-text';

interface SwipeableTaskItemContentProps {
    accessibilityActions: { label: string; name: string }[];
    accessibilityHint: string;
    canShowFocusToggle: boolean;
    /** When set, the star renders disabled with this as its label. */
    focusToggleDisabledLabel?: string;
    hideStatusBadge: boolean;
    /** Title-only row: suppress the description preview, task age and detail meta parts. */
    hideDetails: boolean;
    /** Render the status control as a compact icon button (no status-name label) for single-status lists */
    statusBadgeAsIcon: boolean;
    isDark: boolean;
    isHighlighted: boolean;
    isMultiSelected: boolean;
    showFocusHighlight: boolean;
    localChecklist: Task['checklist'];
    interactionDisabled?: boolean;
    allowInspectionWhenDisabled?: boolean;
    /** The row's labels and meta line, computed by core. */
    meta: TaskRowMeta;
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => void;
    onAddChecklistItem: (title: string) => void;
    onContextPress?: (context: string) => void;
    onEditCompletedAt?: () => void;
    onLongPress: () => void;
    onOpenStatusMenu: () => void;
    onPress: () => void;
    onProjectPress?: (projectId: string) => void;
    onTagPress?: (tag: string) => void;
    onToggleChecklist: () => void;
    onToggleChecklistItem: (index: number) => void;
    onToggleFocus: () => void;
    footerContent?: ReactNode;
    sequenceCue?: ProjectSequenceTaskCue;
    selectionMode: boolean;
    showChecklist: boolean;
    t: (key: string) => string;
    task: Task;
    tc: ThemeColors;
}

export function SwipeableTaskItemContent({
    accessibilityActions,
    accessibilityHint,
    canShowFocusToggle,
    focusToggleDisabledLabel,
    hideStatusBadge,
    hideDetails,
    statusBadgeAsIcon,
    isDark,
    isHighlighted,
    isMultiSelected,
    showFocusHighlight,
    interactionDisabled = false,
    allowInspectionWhenDisabled = false,
    localChecklist,
    meta,
    onAccessibilityAction,
    onAddChecklistItem,
    onContextPress,
    onEditCompletedAt,
    onLongPress,
    onOpenStatusMenu,
    onPress,
    onProjectPress,
    onTagPress,
    onToggleChecklist,
    onToggleChecklistItem,
    onToggleFocus,
    footerContent,
    sequenceCue,
    selectionMode,
    showChecklist,
    t,
    task,
    tc,
}: SwipeableTaskItemContentProps) {
    const isReference = task.status === 'reference';

    // Draft text lives here, not in useSwipeableChecklist: it must never reach the
    // pending-checklist flush, so an unsubmitted line is discarded with the row.
    const [checklistDraft, setChecklistDraft] = useState('');
    const checklistDraftRef = useRef<TextInput>(null);

    const textDirection = meta.textDirection;
    const textAlign = textDirection === 'rtl' ? 'right' : 'left';
    // Age is detail: the Focus "hide details" toggle drops it with the rest.
    const ageLabel = hideDetails ? null : meta.ageLabel;
    const descriptionPreview = hideDetails ? null : meta.descriptionPreview;
    const compactRecurrence = hideDetails && meta.parts.some((part) => part.kind === 'recurrence');
    // Hidden details keep one cue that the task has more to read (#1287).
    const compactDescription = hideDetails && Boolean(meta.descriptionPreview);
    const statusColors = useStatusColors()[task.status];
    const isAvailableNextAction = sequenceCue === 'available';
    const canNavigateMeta = !selectionMode;

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

    // Items are separated by the row's gap alone. A "·" between them used to be
    // its own node, so a wrapped line could start with a lone dot (#1161).
    const renderMetaPart = (part: TaskRowMetaPart): ReactNode => {
        switch (part.kind) {
            case 'project':
                return renderMetaItem({
                    key: 'project',
                    onPress: canNavigateMeta && onProjectPress ? () => onProjectPress(part.projectId) : undefined,
                    accessibilityLabel: formatI18nTemplate(
                        tFallback(t, 'task.aria.openProject', 'Open project {name}'),
                        { name: part.text },
                    ),
                    children: (
                        <>
                            <View style={[styles.projectDot, { backgroundColor: part.dotColor || tc.tint }]} />
                            <CompactText
                                style={[styles.metaText, { color: tc.secondaryText }]}
                                numberOfLines={2}
                            >
                                {part.text}
                            </CompactText>
                        </>
                    ),
                });
            case 'area':
                return (
                    <View key="area" style={styles.inlineMetaItem}>
                        <View style={[styles.projectDot, { backgroundColor: part.dotColor || tc.tint }]} />
                        <CompactText
                            style={[styles.metaText, { color: tc.secondaryText }]}
                            numberOfLines={2}
                        >
                            {part.text}
                        </CompactText>
                    </View>
                );
            case 'projectDeadline':
                return (
                    <CompactText
                        key="project-deadline"
                        style={[styles.metaText, styles.projectDeadlineText]}
                        numberOfLines={2}
                    >
                        {part.text}
                    </CompactText>
                );
            case 'context':
            case 'tag': {
                const isContext = part.kind === 'context';
                const onNamePress = isContext ? onContextPress : onTagPress;
                return renderMetaItem({
                    key: part.kind,
                    onPress: canNavigateMeta && onNamePress ? () => onNamePress(part.text) : undefined,
                    accessibilityLabel: formatI18nTemplate(
                        isContext
                            ? tFallback(t, 'task.aria.openContext', 'Open context {name}')
                            : tFallback(t, 'task.aria.openTag', 'Open tag {name}'),
                        { name: part.text },
                    ),
                    children: (
                        <>
                            <CompactText
                                style={[styles.metaText, isContext ? styles.contextText : styles.tagText]}
                                numberOfLines={2}
                            >
                                {part.text}
                            </CompactText>
                            {part.overflowCount > 0 && (
                                <CompactText style={[styles.metaText, { color: tc.secondaryText }]}>+{part.overflowCount}</CompactText>
                            )}
                        </>
                    ),
                });
            }
            case 'assignedTo':
                return renderMetaItem({
                    key: 'assigned-to',
                    children: (
                        <>
                            <UserRound size={12} color={tc.secondaryText} strokeWidth={2} />
                            {/* The person is what a Waiting row is read for, so the name stands out (#1282). */}
                            <CompactText
                                style={[styles.metaText, { color: tc.text, fontWeight: '600' }]}
                                numberOfLines={2}
                            >
                                {part.text}
                            </CompactText>
                        </>
                    ),
                });
            case 'completed':
            case 'cancelled': {
                const editable = part.kind === 'completed';
                return renderMetaItem({
                    key: part.kind,
                    onPress: editable && canNavigateMeta && onEditCompletedAt ? onEditCompletedAt : undefined,
                    accessibilityLabel: editable
                        ? tFallback(t, 'task.editCompletedAt', 'Edit completion time')
                        : undefined,
                    children: (
                        <CompactText
                            style={[styles.metaText, { color: tc.secondaryText }]}
                        >
                            {part.text}
                        </CompactText>
                    ),
                });
            }
            case 'due': {
                const dueColor = part.tone === 'overdue'
                    ? tc.danger
                    : part.tone === 'dueSoon' ? tc.warning : tc.secondaryText;
                return (
                    <CompactText
                        key="due"
                        style={[styles.metaText, styles.dueText, { color: dueColor }]}
                    >
                        {part.text}
                    </CompactText>
                );
            }
            case 'start':
                return (
                    <CompactText
                        key="start"
                        style={[styles.metaText, { color: tc.secondaryText }]}
                    >
                        {part.text}
                    </CompactText>
                );
            case 'dateIssue':
                return (
                    <CompactText
                        key="date-issue"
                        style={[styles.metaText, styles.dateIssueText]}
                        numberOfLines={1}
                    >
                        {part.text}
                    </CompactText>
                );
            case 'recurrence':
                return renderMetaItem({
                    key: 'recurrence',
                    children: (
                        <>
                            <Repeat size={12} color={tc.secondaryText} strokeWidth={2} />
                            <CompactText
                                key="recurrence-label"
                                style={[styles.metaText, { color: tc.secondaryText }]}
                                numberOfLines={2}
                            >
                                {part.text}
                            </CompactText>
                        </>
                    ),
                });
            case 'estimate':
                return (
                    <Text key="estimate" style={[styles.metaText, { color: tc.secondaryText }]}>
                        {part.text}
                    </Text>
                );
            case 'timeSpent':
                return renderMetaItem({
                    key: 'time-spent',
                    children: (
                        <>
                            <History size={12} color={tc.secondaryText} strokeWidth={2} />
                            <CompactText
                                style={[styles.metaText, { color: tc.secondaryText }]}
                                accessibilityLabel={part.accessibilityLabel}
                            >
                                {part.text}
                            </CompactText>
                        </>
                    ),
                });
            case 'checklist':
                return (
                    <Pressable
                        key="checklist"
                        onPress={onToggleChecklist}
                        hitSlop={4}
                        accessibilityRole="button"
                        accessibilityLabel={t('checklist.progress')}
                        style={styles.inlineMetaButton}
                    >
                        <View style={styles.inlineMetaItem}>
                            <ListChecks size={13} color={tc.secondaryText} strokeWidth={2} />
                            <Text style={[styles.metaText, { color: tc.secondaryText }]}>
                                {part.completed}/{part.total}
                            </Text>
                        </View>
                    </Pressable>
                );
            case 'attachments':
                return renderMetaItem({
                    key: 'attachments',
                    children: (
                        <>
                            <Paperclip size={12} color={tc.secondaryText} strokeWidth={2} />
                            <CompactText
                                style={[styles.metaText, { color: tc.secondaryText }]}
                                accessibilityLabel={part.accessibilityLabel}
                            >
                                {part.text}
                            </CompactText>
                        </>
                    ),
                });
        }
    };

    const { isMaterial, shape } = useThemeTokens();
    const visibleMetaParts = (hideDetails ? meta.parts.filter((part) => !part.detail) : meta.parts).map(renderMetaPart);

    return (
        <AppPressable
            style={[
                styles.taskItem,
                isMaterial ? { borderRadius: shape.large } : undefined,
                { backgroundColor: tc.taskItemBg },
                { borderWidth: 1, borderColor: tc.border },
                isAvailableNextAction && !selectionMode && {
                    backgroundColor: isDark ? 'rgba(59, 130, 246, 0.08)' : 'rgba(59, 130, 246, 0.05)',
                    borderColor: isDark ? 'rgba(59, 130, 246, 0.34)' : 'rgba(59, 130, 246, 0.24)',
                },
                showFocusHighlight && canShowFocusToggle && task.isFocusedToday && !selectionMode && { borderWidth: 2, borderColor: tc.tint },
                isHighlighted && !selectionMode && { borderWidth: 2, borderColor: tc.tint },
                selectionMode && { borderWidth: 2, borderColor: isMultiSelected ? tc.tint : tc.border },
            ]}
            onPress={onPress}
            onLongPress={onLongPress}
            delayLongPress={300}
            disabled={interactionDisabled && !allowInspectionWhenDisabled}
            accessibilityLabel={meta.accessibilityLabel}
            accessibilityHint={accessibilityHint}
            accessibilityRole="button"
            accessibilityState={(interactionDisabled && !allowInspectionWhenDisabled) || selectionMode
                ? {
                    ...(interactionDisabled && !allowInspectionWhenDisabled ? { disabled: true } : {}),
                    ...(selectionMode ? { selected: isMultiSelected } : {}),
                }
                : undefined}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
        >
            {meta.priority && (
                <View
                    style={[styles.priorityStrip, { backgroundColor: TASK_PRIORITY_COLORS[meta.priority] }]}
                    testID="task-priority-strip"
                    pointerEvents="none"
                />
            )}
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
                    {isMultiSelected && <Check size={12} color="#FFFFFF" strokeWidth={3} />}
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
                    {compactRecurrence && <Repeat size={12} color={tc.secondaryText} strokeWidth={2} />}
                    {compactDescription && <AlignLeft size={12} color={tc.secondaryText} strokeWidth={2} />}
                    {canShowFocusToggle && !selectionMode && (
                        <Pressable
                            onPress={(event) => {
                                event.stopPropagation();
                                onToggleFocus();
                            }}
                            disabled={Boolean(focusToggleDisabledLabel)}
                            hitSlop={8}
                            style={[styles.focusButton, focusToggleDisabledLabel ? styles.focusButtonDisabled : null]}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: Boolean(focusToggleDisabledLabel) }}
                            accessibilityLabel={focusToggleDisabledLabel
                                ?? (task.isFocusedToday ? t('agenda.removeFromFocus') : t('agenda.addToFocus'))}
                        >
                            <FocusStarIcon
                                focused={task.isFocusedToday === true}
                                inactiveColor={tc.secondaryText}
                            />
                        </Pressable>
                    )}
                </View>
                {descriptionPreview ? (
                    <MarkdownInlineText
                        markdown={descriptionPreview}
                        tc={tc}
                        direction={textDirection}
                        style={[styles.taskDescription, { color: tc.secondaryText }]}
                        numberOfLines={isReference ? 3 : 1}
                    />
                ) : null}
                {visibleMetaParts.length > 0 && (
                    <View style={styles.inlineMeta}>
                        {visibleMetaParts}
                    </View>
                )}
                {footerContent}
                {showChecklist && (localChecklist || []).length > 0 && (
                    <View style={styles.checklistItems}>
                        {(localChecklist || []).map((item, index) => (
                            <Pressable
                                key={item.id || index}
                                disabled={interactionDisabled}
                                onPress={interactionDisabled ? undefined : () => onToggleChecklistItem(index)}
                                style={styles.checklistItem}
                                accessibilityRole="button"
                                accessibilityLabel={item.title}
                                accessibilityState={{
                                    checked: item.isCompleted,
                                    ...(interactionDisabled ? { disabled: true } : {}),
                                }}
                            >
                                <MarkdownInlineText
                                    markdown={`${item.isCompleted ? '✓' : '○'} ${item.title}`}
                                    tc={tc}
                                    style={[
                                        styles.checklistItemText,
                                        { color: tc.secondaryText },
                                        item.isCompleted ? styles.checklistItemCompleted : undefined,
                                    ]}
                                    numberOfLines={1}
                                />
                            </Pressable>
                        ))}
                        {!selectionMode && !interactionDisabled && (
                            <TextInput
                                ref={checklistDraftRef}
                                value={checklistDraft}
                                onChangeText={setChecklistDraft}
                                onSubmitEditing={() => {
                                    if (!checklistDraft.trim()) {
                                        checklistDraftRef.current?.blur();
                                        return;
                                    }
                                    onAddChecklistItem(checklistDraft);
                                    setChecklistDraft('');
                                }}
                                placeholder={`+ ${t('taskEdit.addItem')}`}
                                placeholderTextColor={tc.secondaryText}
                                style={[styles.checklistAddInput, { color: tc.text }]}
                                accessibilityLabel={t('taskEdit.addItem')}
                                returnKeyType="done"
                                blurOnSubmit={false}
                                submitBehavior="submit"
                            />
                        )}
                    </View>
                )}
                {ageLabel && (
                    <View style={styles.staleRow}>
                        <Hourglass size={11} color={tc.secondaryText} accessible={false} />
                        <Text style={[styles.staleText, { color: tc.secondaryText }]}>{ageLabel}</Text>
                    </View>
                )}
            </View>
            {!hideStatusBadge && meta.statusLabel !== null && (
                <Pressable
                    disabled={interactionDisabled}
                    onPress={interactionDisabled ? undefined : (event) => {
                        event.stopPropagation();
                        onOpenStatusMenu();
                    }}
                    hitSlop={8}
                    style={
                        statusBadgeAsIcon
                            ? styles.statusIconButton
                            : [
                                styles.statusBadge,
                                { backgroundColor: statusColors.bg, borderColor: statusColors.border },
                            ]
                    }
                    accessibilityLabel={formatI18nTemplate(
                        tFallback(t, 'task.aria.changeStatus', 'Change status. Current status: {status}'),
                        { status: meta.statusLabel },
                    )}
                    accessibilityHint={tFallback(
                        t,
                        'task.aria.changeStatusHint',
                        'Double-tap to open status menu',
                    )}
                    accessibilityRole="button"
                    accessibilityState={interactionDisabled ? { disabled: true } : undefined}
                >
                    {statusBadgeAsIcon ? (
                        <CircleDot size={20} color={statusColors.text} strokeWidth={2} />
                    ) : (
                        <Text style={[styles.statusText, { color: statusColors.text }]}>
                            {meta.statusLabel}
                        </Text>
                    )}
                </Pressable>
            )}
        </AppPressable>
    );
}
