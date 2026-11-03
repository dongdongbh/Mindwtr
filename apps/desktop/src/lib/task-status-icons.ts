import {
    Archive,
    ArrowRight,
    Book,
    Calendar,
    Check,
    Clock3,
    Inbox,
    PauseCircle,
    CalendarClock,
    type LucideIcon,
} from 'lucide-react';
import type { TaskStatus } from '@mindwtr/core';


export const TASK_STATUS_ICONS: Record<TaskStatus, LucideIcon> = {
    inbox: Inbox,
    next: ArrowRight,
    waiting: PauseCircle,
    someday: Clock3,
    reference: Book,
    done: Check,
    archived: Archive,
};


export const START_LATER_ICON: LucideIcon = Calendar;


export const INCUBATE_ICON: LucideIcon = CalendarClock;
