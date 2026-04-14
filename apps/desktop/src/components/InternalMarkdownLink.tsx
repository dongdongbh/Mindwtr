import React from 'react';
import { parseMarkdownReferenceHref, useTaskStore, shallow } from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import { dispatchNavigateEvent } from '../lib/navigation-events';
import { cn } from '../lib/utils';
import { resolveTaskNavigationView } from '../lib/task-navigation';
import { useUiStore } from '../store/ui-store';

type InternalMarkdownLinkProps = {
    href?: string;
    className?: string;
    children: React.ReactNode;
};

function isSafeExternalHref(href: string): boolean {
    try {
        const url = new URL(href);
        return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol);
    } catch {
        return false;
    }
}

export function InternalMarkdownLink({ href, className, children }: InternalMarkdownLinkProps) {
    const { t } = useLanguage();
    const { tasks, projects, restoreTask, restoreProject, setHighlightTask } = useTaskStore((state) => ({
        tasks: state._allTasks,
        projects: state._allProjects,
        restoreTask: state.restoreTask,
        restoreProject: state.restoreProject,
        setHighlightTask: state.setHighlightTask,
    }), shallow);
    const setProjectView = useUiStore((state) => state.setProjectView);

    if (!href) {
        return <>{children}</>;
    }

    const reference = parseMarkdownReferenceHref(href);
    if (!reference) {
        if (!isSafeExternalHref(href)) {
            return <>{children}</>;
        }
        return (
            <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className={cn('text-primary underline underline-offset-2 hover:opacity-90', className)}
                onClick={(event) => {
                    event.stopPropagation();
                }}
            >
                {children}
            </a>
        );
    }

    const taskLabel = (() => {
        const translated = t('taskEdit.tab.task');
        return translated === 'taskEdit.tab.task' ? 'Task' : translated;
    })();
    const projectLabel = (() => {
        const translated = t('taskEdit.projectLabel');
        return translated === 'taskEdit.projectLabel' ? 'Project' : translated;
    })();
    const deletedTaskLabel = (() => {
        const translated = t('markdown.referenceDeletedTask');
        return translated === 'markdown.referenceDeletedTask' ? 'deleted task' : translated;
    })();
    const deletedProjectLabel = (() => {
        const translated = t('markdown.referenceDeletedProject');
        return translated === 'markdown.referenceDeletedProject' ? 'deleted project' : translated;
    })();
    const restoreLabel = (() => {
        const translated = t('markdown.referenceRestore');
        return translated === 'markdown.referenceRestore' ? 'Restore' : translated;
    })();

    if (reference.entityType === 'project') {
        const project = projects.find((candidate) => candidate.id === reference.id && !candidate.deletedAt);
        const deletedProject = project ? null : projects.find((candidate) => candidate.id === reference.id && !!candidate.deletedAt);
        if (!project) {
            return (
                <span className={cn('text-muted-foreground', className)}>
                    <span className="line-through">{children}</span>
                    <span className="ml-1 text-[0.9em]">({deletedProjectLabel})</span>
                    {deletedProject ? (
                        <button
                            type="button"
                            className="ml-2 text-xs text-primary underline underline-offset-2 hover:opacity-90"
                            onClick={(event) => {
                                event.stopPropagation();
                                void restoreProject(deletedProject.id).then((result) => {
                                    if (!result.success) return;
                                    setProjectView({ selectedProjectId: deletedProject.id });
                                    dispatchNavigateEvent('projects');
                                }).catch(() => undefined);
                            }}
                        >
                            {restoreLabel}
                        </button>
                    ) : null}
                </span>
            );
        }
        const statusLabel = (() => {
            const key = `status.${project.status}` as const;
            const translated = t(key);
            return translated === key ? project.status : translated;
        })();
        return (
            <button
                type="button"
                className={cn('bg-transparent p-0 text-left [font:inherit] text-primary underline underline-offset-2 hover:opacity-90', className)}
                title={`${projectLabel} • ${statusLabel}${project.title ? ` • ${project.title}` : ''}`}
                onClick={(event) => {
                    event.stopPropagation();
                    setProjectView({ selectedProjectId: project.id });
                    dispatchNavigateEvent('projects');
                }}
            >
                {children}
            </button>
        );
    }

    const task = tasks.find((candidate) => candidate.id === reference.id && !candidate.deletedAt);
    const deletedTask = task ? null : tasks.find((candidate) => candidate.id === reference.id && !!candidate.deletedAt);
    if (!task) {
        return (
            <span className={cn('text-muted-foreground', className)}>
                <span className="line-through">{children}</span>
                <span className="ml-1 text-[0.9em]">({deletedTaskLabel})</span>
                {deletedTask ? (
                    <button
                        type="button"
                        className="ml-2 text-xs text-primary underline underline-offset-2 hover:opacity-90"
                        onClick={(event) => {
                            event.stopPropagation();
                            void restoreTask(deletedTask.id).then((result) => {
                                if (!result.success) return;
                                const restoredTask = useTaskStore.getState()._allTasks.find((candidate) =>
                                    candidate.id === deletedTask.id && !candidate.deletedAt
                                );
                                if (!restoredTask) return;
                                setHighlightTask(restoredTask.id);
                                if (restoredTask.projectId) {
                                    setProjectView({ selectedProjectId: restoredTask.projectId });
                                    dispatchNavigateEvent('projects');
                                    return;
                                }
                                dispatchNavigateEvent(resolveTaskNavigationView(restoredTask));
                            }).catch(() => undefined);
                        }}
                    >
                        {restoreLabel}
                    </button>
                ) : null}
            </span>
        );
    }

    const statusLabel = (() => {
        const key = `status.${task.status}` as const;
        const translated = t(key);
        return translated === key ? task.status : translated;
    })();
    const currentTitle = task.title?.trim();

    return (
        <button
            type="button"
            className={cn('bg-transparent p-0 text-left [font:inherit] text-primary underline underline-offset-2 hover:opacity-90', className)}
            title={`${taskLabel} • ${statusLabel}${currentTitle ? ` • ${currentTitle}` : ''}`}
            onClick={(event) => {
                event.stopPropagation();
                setHighlightTask(task.id);
                if (task.projectId) {
                    setProjectView({ selectedProjectId: task.projectId });
                    dispatchNavigateEvent('projects');
                    return;
                }
                dispatchNavigateEvent(resolveTaskNavigationView(task));
            }}
        >
            {children}
        </button>
    );
}
