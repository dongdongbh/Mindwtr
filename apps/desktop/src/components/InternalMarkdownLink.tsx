import React from 'react';
import { isSandboxMode, isSafeMarkdownExternalHref, parseMarkdownReferenceHref, tFallback, useTaskStore, shallow, type Project, type Task } from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import { dispatchNavigateEvent } from '../lib/navigation-events';
import { openExternalLink, showExternalLinkFailure } from '../lib/external-link';
import { cn } from '../lib/utils';
import { resolveTaskNavigationView } from '../lib/task-navigation';
import { useUiStore } from '../store/ui-store';

type InternalMarkdownLinkProps = {
    href?: string;
    className?: string;
    children: React.ReactNode;
    linkContext: InternalMarkdownLinkContext;
};

type TaskStoreSnapshot = ReturnType<typeof useTaskStore.getState>;
type UiStoreSnapshot = ReturnType<typeof useUiStore.getState>;

export type InternalMarkdownLinkContext = {
    tasksById: Map<string, Task>;
    deletedTasksById: Map<string, Task>;
    projectsById: Map<string, Project>;
    deletedProjectsById: Map<string, Project>;
    restoreTask: TaskStoreSnapshot['restoreTask'];
    restoreProject: TaskStoreSnapshot['restoreProject'];
    setHighlightTask: TaskStoreSnapshot['setHighlightTask'];
    setProjectView: UiStoreSnapshot['setProjectView'];
};

type CreateInternalMarkdownLinkContextParams = {
    tasks: Task[];
    projects: Project[];
    restoreTask: TaskStoreSnapshot['restoreTask'];
    restoreProject: TaskStoreSnapshot['restoreProject'];
    setHighlightTask: TaskStoreSnapshot['setHighlightTask'];
    setProjectView: UiStoreSnapshot['setProjectView'];
};

export function createInternalMarkdownLinkContext({
    tasks,
    projects,
    restoreTask,
    restoreProject,
    setHighlightTask,
    setProjectView,
}: CreateInternalMarkdownLinkContextParams): InternalMarkdownLinkContext {
    const tasksById = new Map<string, Task>();
    const deletedTasksById = new Map<string, Task>();
    const projectsById = new Map<string, Project>();
    const deletedProjectsById = new Map<string, Project>();


    tasks.forEach((task) => {
        if (task.purgedAt) return;
        if (task.deletedAt) {
            deletedTasksById.set(task.id, task);
        } else {
            tasksById.set(task.id, task);
        }
    });
    projects.forEach((project) => {
        if (project.purgedAt) return;
        if (project.deletedAt) {
            deletedProjectsById.set(project.id, project);
        } else {
            projectsById.set(project.id, project);
        }
    });

    return {
        tasksById,
        deletedTasksById,
        projectsById,
        deletedProjectsById,
        restoreTask,
        restoreProject,
        setHighlightTask,
        setProjectView,
    };
}

export function useInternalMarkdownLinkContext(): InternalMarkdownLinkContext {
    const { tasks, projects, restoreTask, restoreProject, setHighlightTask } = useTaskStore((state) => ({
        tasks: state._allTasks,
        projects: state._allProjects,
        restoreTask: state.restoreTask,
        restoreProject: state.restoreProject,
        setHighlightTask: state.setHighlightTask,
    }), shallow);
    const setProjectView = useUiStore((state) => state.setProjectView);

    return React.useMemo(() => createInternalMarkdownLinkContext({
        tasks,
        projects,
        restoreTask,
        restoreProject,
        setHighlightTask,
        setProjectView,
    }), [tasks, projects, restoreTask, restoreProject, setHighlightTask, setProjectView]);
}

function isSafeExternalHref(href: string): boolean {

    return isSafeMarkdownExternalHref(href) || /^mid:[^\s]+$/i.test(href);
}

export function InternalMarkdownLink({ href, className, children, linkContext }: InternalMarkdownLinkProps) {
    const { t } = useLanguage();
    const {
        tasksById,
        deletedTasksById,
        projectsById,
        deletedProjectsById,
        restoreTask,
        restoreProject,
        setHighlightTask,
        setProjectView,
    } = linkContext;

    if (!href) {
        return <>{children}</>;
    }

    const reference = parseMarkdownReferenceHref(href);
    if (!reference) {
        if (!isSafeExternalHref(href)) {
            return <>{children}</>;
        }


        return (
            <button
                type="button"
                role="link"
                title={isSandboxMode() ? t('sandbox.unavailable') : href}
                disabled={isSandboxMode()}
                className={cn('bg-transparent p-0 text-left [font:inherit] text-primary underline underline-offset-2 hover:opacity-90', className)}
                onClick={(event) => {
                    event.stopPropagation();
                    void openExternalLink(href, 'markdown').catch(() => showExternalLinkFailure(href, t));
                }}
            >
                {children}
            </button>
        );
    }

    const taskLabel = tFallback(t, 'taskEdit.tab.task', 'Task');
    const projectLabel = tFallback(t, 'taskEdit.projectLabel', 'Project');
    const deletedTaskLabel = tFallback(t, 'markdown.referenceDeletedTask', 'deleted task');
    const deletedProjectLabel = tFallback(t, 'markdown.referenceDeletedProject', 'deleted project');
    const restoreLabel = tFallback(t, 'markdown.referenceRestore', 'Restore');

    if (reference.entityType === 'project') {
        const project = projectsById.get(reference.id);
        const deletedProject = project ? null : deletedProjectsById.get(reference.id);
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
            return tFallback(t, key, project.status);
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

    const task = tasksById.get(reference.id);
    const deletedTask = task ? null : deletedTasksById.get(reference.id);
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
        return tFallback(t, key, task.status);
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
