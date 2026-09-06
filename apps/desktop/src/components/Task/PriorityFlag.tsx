import { Flag } from 'lucide-react';
import type { TaskPriority } from '@mindwtr/core';
import { TASK_PRIORITY_COLORS } from '@mindwtr/core';

import { cn } from '../../lib/utils';

/**
 * Decorative priority flag, tinted with the fixed priority heat ramp. Text
 * labels remain the accessible priority identifier, so this never reaches the
 * accessibility tree — color is never the sole signal.
 */
export function PriorityFlag({ priority, className }: { priority: TaskPriority; className?: string }) {
    return (
        <Flag
            aria-hidden
            data-priority-flag={priority}
            className={cn('h-3 w-3 shrink-0', className)}
            color={TASK_PRIORITY_COLORS[priority]}
        />
    );
}
