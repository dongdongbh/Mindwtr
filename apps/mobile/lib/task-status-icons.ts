import {
    Archive,
    ArrowRight,
    ArrowUpCircle,
    Book,
    Check,
    Clock3,
    Inbox,
    PauseCircle,
    CalendarClock,
    type LucideIcon,
} from 'lucide-react-native';
import type { TaskStatus } from '@mindwtr/core';


export const TASK_STATUS_ICONS: Record<TaskStatus, LucideIcon> = {
    inbox: Inbox,
    next: ArrowRight,
    waiting: PauseCircle,
    someday: ArrowUpCircle,
    reference: Book,
    done: Check,
    archived: Archive,
};


export const START_LATER_ICON: LucideIcon = Clock3;


export const INCUBATE_ICON: LucideIcon = CalendarClock;
