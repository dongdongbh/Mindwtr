import React from 'react';
import { Flag } from 'lucide-react-native';
import { TASK_PRIORITY_COLORS, type TaskPriority } from '@mindwtr/core';


export function PriorityFlag({ priority, size = 12, color }: { priority: TaskPriority | null; size?: number; color?: string }) {
    return (
        <Flag
            size={size}

            color={priority ? TASK_PRIORITY_COLORS[priority] : color}
            aria-hidden
            accessible={false}
            pointerEvents="none"
            testID={`priority-flag-${priority ?? 'clear'}`}
        />
    );
}
