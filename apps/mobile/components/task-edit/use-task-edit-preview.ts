import React from 'react';
import type { Task } from '@mindwtr/core';

type UseTaskEditPreviewParams = {
    editedProjectId?: string;
    onClose: () => void;
    onContextNavigate?: (context: string) => void;
    onProjectNavigate?: (projectId: string) => void;
    onTagNavigate?: (tag: string) => void;
    projectId?: string;
    projects: { id: string; title: string }[];
    task?: Task | null;
    tasks: Task[];
};

export function useTaskEditPreview({
    editedProjectId,
    onClose,
    onContextNavigate,
    onProjectNavigate,
    onTagNavigate,
    projectId,
    projects,
    task,
    tasks,
}: UseTaskEditPreviewParams) {
    const projectContext = React.useMemo(() => {
        const nextProjectId = editedProjectId ?? projectId;
        if (!nextProjectId) return null;
        const project = projects.find((item) => item.id === nextProjectId);
        const projectTasks = tasks
            .filter((item) => item.projectId === nextProjectId && item.id !== task?.id && !item.deletedAt)
            .map((item) => `${item.title}${item.status ? ` (${item.status})` : ''}`)
            .filter(Boolean)
            .slice(0, 20);
        return {
            projectTitle: project?.title || '',
            projectTasks,
        };
    }, [editedProjectId, projectId, projects, task?.id, tasks]);

    const handlePreviewProjectPress = React.useCallback((nextProjectId: string) => {
        onClose();
        onProjectNavigate?.(nextProjectId);
    }, [onClose, onProjectNavigate]);

    const handlePreviewContextPress = React.useCallback((context: string) => {
        onClose();
        onContextNavigate?.(context);
    }, [onClose, onContextNavigate]);

    const handlePreviewTagPress = React.useCallback((tag: string) => {
        onClose();
        onTagNavigate?.(tag);
    }, [onClose, onTagNavigate]);

    return {
        handlePreviewContextPress,
        handlePreviewProjectPress,
        handlePreviewTagPress,
        projectContext,
    };
}
