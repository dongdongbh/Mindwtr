import type { TaskStatus } from '@mindwtr/core';

// Status tints from the same theme-aware `--status-*` variables the Board
// columns use, so a status wears one color everywhere. Full literal strings:
// Tailwind's scanner cannot see composed arbitrary values.
export const STATUS_PILL_CLASSES: Record<TaskStatus, string> = {
    inbox: 'bg-[hsl(var(--status-inbox)/0.14)] text-[hsl(var(--status-inbox))]',
    next: 'bg-[hsl(var(--status-next)/0.14)] text-[hsl(var(--status-next))]',
    waiting: 'bg-[hsl(var(--status-waiting)/0.14)] text-[hsl(var(--status-waiting))]',
    someday: 'bg-[hsl(var(--status-someday)/0.14)] text-[hsl(var(--status-someday))]',
    reference: 'bg-[hsl(var(--status-reference)/0.14)] text-[hsl(var(--status-reference))]',
    done: 'bg-[hsl(var(--status-done)/0.14)] text-[hsl(var(--status-done))]',
    archived: 'bg-[hsl(var(--status-archived)/0.14)] text-[hsl(var(--status-archived))]',
};

export const STATUS_PILL_ACTIVE_CLASSES: Record<TaskStatus, string> = {
    inbox: 'border-[hsl(var(--status-inbox))] bg-[hsl(var(--status-inbox)/0.16)] text-[hsl(var(--status-inbox))]',
    next: 'border-[hsl(var(--status-next))] bg-[hsl(var(--status-next)/0.16)] text-[hsl(var(--status-next))]',
    waiting: 'border-[hsl(var(--status-waiting))] bg-[hsl(var(--status-waiting)/0.16)] text-[hsl(var(--status-waiting))]',
    someday: 'border-[hsl(var(--status-someday))] bg-[hsl(var(--status-someday)/0.16)] text-[hsl(var(--status-someday))]',
    reference: 'border-[hsl(var(--status-reference))] bg-[hsl(var(--status-reference)/0.16)] text-[hsl(var(--status-reference))]',
    done: 'border-[hsl(var(--status-done))] bg-[hsl(var(--status-done)/0.16)] text-[hsl(var(--status-done))]',
    archived: 'border-[hsl(var(--status-archived))] bg-[hsl(var(--status-archived)/0.16)] text-[hsl(var(--status-archived))]',
};
