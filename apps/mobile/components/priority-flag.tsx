import React from 'react';
import { Flag } from 'lucide-react-native';
import { TASK_PRIORITY_COLORS, type TaskPriority } from '@mindwtr/core';

/**
 * Decorative priority flag, tinted with the fixed priority heat ramp. Text
 * labels remain the accessible priority identifier, so this is not an
 * accessibility element — color is never the sole signal.
 */
export function PriorityFlag({ priority, size = 12, color }: { priority: TaskPriority | null; size?: number; color?: string }) {
    return (
        <Flag
            size={size}
            // Unset priorities render uncolored: the caller's theme color wins.
            color={priority ? TASK_PRIORITY_COLORS[priority] : color}
            aria-hidden
            accessible={false}
            pointerEvents="none"
            testID={`priority-flag-${priority ?? 'clear'}`}
        />
    );
}
