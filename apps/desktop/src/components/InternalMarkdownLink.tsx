import React from 'react';
import { isSandboxMode, parseMarkdownReferenceHref, tFallback, useTaskStore, shallow, type Project, type Task } from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import { dispatchNavigateEvent } from '../lib/navigation-events';
import { reportError } from '../lib/report-error';
import { isTauriRuntime } from '../lib/runtime';
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
        if (task.deletedAt) {
            deletedTasksById.set(task.id, task);
        } else {
            tasksById.set(task.id, task);
        }
    });
    projects.forEach((project) => {
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
    try {
        const url = new URL(href);
        return ['http:', 'https:', 'mailto:', 'tel:', 'mid:'].includes(url.protocol);
    } catch {
        return false;
    }
}

async function openExternalHref(href: string): Promise<void> {
    if (isSandboxMode()) return;
    const nextHref = href.trim();
    let openError: unknown = null;

    if (isTauriRuntime()) {
        try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(nextHref);
            return;
        } catch (error) {
            openError = error;
        }
    }

    const opened = window.open(nextHref, '_blank', 'noopener,noreferrer');
    if (!opened) {
        reportError('Failed to open markdown link', openError ?? new Error('Popup blocked'));
    }
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
        // No `href` on purpose: an anchor carrying the real URL is what the
        // engine's speculative preconnect keys on — WebView2 dialed the linked
        // host's servers on hover/click even though the click handler opens the
        // URL externally (#913). A button with role="link" keeps the link
        // semantics and keyboard behavior with nothing left to preconnect to.
        return (
            <button
                type="button"
                role="link"
                title={isSandboxMode() ? t('sandbox.unavailable') : href}
                disabled={isSandboxMode()}
                className={cn('bg-transparent p-0 text-left [font:inherit] text-primary underline underline-offset-2 hover:opacity-90', className)}
                onClick={(event) => {
                    event.stopPropagation();
                    void openExternalHref(href);
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
