import { tFallback } from './i18n';

type CountKind = 'task' | 'project' | 'event' | 'day';


export function formatListItemCount(count: number, kind: CountKind, t: (key: string) => string): string {
    return `${count} ${formatListItemCountNoun(count, kind, t)}`;
}

export function formatListItemCountNoun(count: number, kind: CountKind, t: (key: string) => string): string {
    const key = kind === 'task'
        ? count === 1 ? 'list.countTaskSingular' : 'common.tasks'
        : kind === 'project'
            ? count === 1 ? 'list.countProjectSingular' : 'projects.count'
            : kind === 'day'
                ? count === 1 ? 'common.day' : 'common.days'
                : count === 1 ? 'calendar.eventSingular' : 'calendar.eventPlural';
    return tFallback(t, key, count === 1 ? kind : `${kind}s`);
}
