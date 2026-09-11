import { useMemo } from 'react';
import type { Project, Task } from '@mindwtr/core';

import { cn } from '../lib/utils';
import { STATUS_PILL_CLASSES } from '../lib/status-colors';

type InboxSimilarTasksProps = {
    t: (key: string) => string;
    tasks: readonly Task[];
    projects: readonly Project[];
};

/** A quiet, read-only warning that the current Inbox title may already exist. */
export function InboxSimilarTasks({ t, tasks, projects }: InboxSimilarTasksProps) {
    const projectTitleById = useMemo(
        () => new Map(projects.map((project) => [project.id, project.title])),
        [projects],
    );

    if (tasks.length === 0) return null;

    return (
        <section
            aria-label={t('process.similarTasks')}
            aria-live="polite"
            className="border-t border-border/70 pt-2"
        >
            <h4 className="text-[11px] font-medium text-muted-foreground">
                {t('process.similarTasks')}
            </h4>
            <ul className="mt-1.5 space-y-1.5">
                {tasks.map((task) => {
                    const projectTitle = task.projectId
                        ? projectTitleById.get(task.projectId)
                        : undefined;
                    return (
                        <li key={task.id} className="min-w-0 text-xs">
                            <div className="flex min-w-0 items-start gap-2">
                                <span className="min-w-0 flex-1 whitespace-normal break-words text-foreground">
                                    {task.title}
                                </span>
                                <span className={cn(
                                    'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                                    STATUS_PILL_CLASSES[task.status],
                                )}>
                                    {t(`status.${task.status}`)}
                                </span>
                            </div>
                            {projectTitle ? (
                                <div className="mt-0.5 break-words text-[10px] text-muted-foreground">
                                    {projectTitle}
                                </div>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
