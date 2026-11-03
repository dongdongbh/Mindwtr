import { Flag } from 'lucide-react';
import type { TaskPriority } from '@mindwtr/core';
import { TASK_PRIORITY_COLORS } from '@mindwtr/core';

import { cn } from '../../lib/utils';


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
