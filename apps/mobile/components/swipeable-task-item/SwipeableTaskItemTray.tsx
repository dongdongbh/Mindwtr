import React from 'react';
import { View } from 'react-native';
import { ArrowRight, CalendarDays, Circle, FolderOpen, RotateCcw, Star, Trash2, type LucideIcon } from 'lucide-react-native';
import { formatI18nTemplate, tFallback, type TaskRowSwipeAction, type TaskRowSwipeActionId } from '@mindwtr/core';
import { useEinkSafeColor } from '../../hooks/use-eink-safe-color';

import { AppPressable } from '../app-pressable';
import { CompactText } from '../compact-text';
import { FOCUS_STAR_COLOR } from '../FocusStarIcon';
import type { StatusPalette } from '../../hooks/use-status-colors';
import { styles } from './swipeable-task-item.styles';

const ICONS: Record<TaskRowSwipeActionId, LucideIcon> = {
    done: Circle,
    focus: Star,
    organize: FolderOpen,
    dates: CalendarDays,
    delete: Trash2,
    restore: RotateCcw,
    next: ArrowRight,
};

const DELETE_COLOR = '#EF4444';

const colorFor = (id: TaskRowSwipeActionId, statusColors: StatusPalette, safeColors: (color: string) => string): string => {
    switch (id) {
        case 'done': return statusColors.done.text;
        case 'focus': return safeColors(FOCUS_STAR_COLOR);
        case 'organize': return statusColors.next.text;
        case 'dates': return statusColors.someday.text;
        case 'restore': return statusColors.inbox.text;
        case 'next': return statusColors.next.text;
        default: return safeColors(DELETE_COLOR);
    }
};

type Props = {
    actions: TaskRowSwipeAction[];
    side: 'left' | 'right';

    showLabels: boolean;
    statusColors: StatusPalette;
    t: (key: string) => string;
    onAction: (action: TaskRowSwipeAction) => void;

    onLongPressDone?: () => void;
};


export function SwipeableTaskItemTray({ actions, side, showLabels, statusColors, t, onAction, onLongPressDone }: Props) {
    const einkSafe = useEinkSafeColor();
    return (
        <View style={side === 'left' ? styles.swipeTrayLeft : styles.swipeTrayRight}>
            {actions.map((action) => {
                const Icon = ICONS[action.id];
                const onLongPress = action.id === 'done' ? onLongPressDone : undefined;
                return (
                    <AppPressable
                        key={action.id}
                        style={[styles.swipeTrayButton, { backgroundColor: colorFor(action.id, statusColors, einkSafe) }]}
                        pressedColor="rgba(0, 0, 0, 0.18)"
                        onPress={() => onAction(action)}
                        onLongPress={onLongPress}
                        accessibilityHint={onLongPress
                            ? tFallback(t, 'task.completeBackdateHintMobile', 'Long-press to complete with a different time')
                            : undefined}
                        accessibilityLabel={action.id === 'delete'
                            ? tFallback(t, 'task.aria.delete', 'Delete task')
                            : formatI18nTemplate(tFallback(t, 'task.aria.action', '{action} action'), { action: action.label })}
                        accessibilityRole="button"
                    >
                        <Icon
                            size={20}
                            color="#FFFFFF"
                            fill={action.id === 'focus' && action.focused ? '#FFFFFF' : 'transparent'}
                        />
                        {showLabels ? (
                            <CompactText style={styles.swipeActionText} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.8}>
                                {action.label}
                            </CompactText>
                        ) : null}
                    </AppPressable>
                );
            })}
        </View>
    );
}
