import React from 'react';
import { Flag } from 'lucide-react-native';
import { type TaskPriority } from '@mindwtr/core';
import { usePriorityColors } from '../hooks/use-priority-colors';


export function PriorityFlag({ priority, size = 12, color }: { priority: TaskPriority | null; size?: number; color?: string }) {
    const priorityColors = usePriorityColors();
    return (
        <Flag
            size={size}

            color={priority ? priorityColors[priority] : color}
            aria-hidden
            accessible={false}
            pointerEvents="none"
            testID={`priority-flag-${priority ?? 'clear'}`}
        />
    );
}
