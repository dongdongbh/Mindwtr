import { safeFormatDate, safeParseDate } from './date';
import { tFallback } from './i18n';
import { getCompletionDateGroup, type CompletionDateGroup } from './task-utils';
import type { Task } from './types';


export interface CompletionDateSection<T> {
    id: string;
    title: string;
    tasks: T[];
    muted: boolean;
}

const COMPLETION_GROUP_FALLBACKS: Record<CompletionDateGroup, string> = {
    today: 'Today',
    yesterday: 'Yesterday',
    previous7Days: 'Previous 7 days',
    earlier: 'Earlier',
    notCompleted: 'Not completed',
};


const RECENT_GROUPS = ['today', 'yesterday', 'previous7Days'] as const;

const monthKey = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

export function buildCompletionDateSections<T extends Pick<Task, 'completedAt'>>({
    tasks,
    t,
    now,
}: {

    tasks: readonly T[];
    t: (key: string) => string;
    now?: Date;
}): CompletionDateSection<T>[] {
    const reference = now ?? new Date();
    const fixed = new Map<CompletionDateGroup, T[]>();
    const months = new Map<string, { start: Date; tasks: T[] }>();

    tasks.forEach((task) => {
        const group = getCompletionDateGroup(task, reference);


        const completedAt = group === 'earlier' ? safeParseDate(task.completedAt) : null;
        if (!completedAt) {
            const items = fixed.get(group) ?? [];
            items.push(task);
            fixed.set(group, items);
            return;
        }
        const start = new Date(completedAt.getFullYear(), completedAt.getMonth(), 1);
        const bucket = months.get(monthKey(start)) ?? { start, tasks: [] };
        bucket.tasks.push(task);
        months.set(monthKey(start), bucket);
    });


    const section = (id: string, title: string, items: T[], muted = false): CompletionDateSection<T>[] =>
        items.length > 0 ? [{ id, title, tasks: items, muted }] : [];
    const fixedSection = (group: CompletionDateGroup, muted = false) => section(
        `completedDate:${group}`,
        tFallback(t, `list.completedGroup.${group}`, COMPLETION_GROUP_FALLBACKS[group]),
        fixed.get(group) ?? [],
        muted,
    );

    return [
        ...RECENT_GROUPS.flatMap((group) => fixedSection(group)),
        ...[...months.entries()]

            .sort(([a], [b]) => b.localeCompare(a))
            .flatMap(([key, bucket]) => section(
                `completedDate:${key}`,
                safeFormatDate(bucket.start, 'LLLL yyyy', key),
                bucket.tasks,
            )),
        ...fixedSection('earlier'),
        ...fixedSection('notCompleted', true),
    ];
}
