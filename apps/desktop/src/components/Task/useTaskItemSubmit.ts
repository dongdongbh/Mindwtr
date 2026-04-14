import { useCallback } from 'react';
import {
    DEFAULT_PROJECT_COLOR,
    extractChecklistFromMarkdown,
    parseQuickAdd,
    parseRRuleString,
    type Area,
    type Project,
    type Recurrence,
    type Task,
    type TaskEnergyLevel,
    type TaskPriority,
    type TimeEstimate,
} from '@mindwtr/core';

import { reportError } from '../../lib/report-error';
import { mergeMarkdownChecklist } from './task-item-checklist';

type UseTaskItemSubmitParams = {
    addProject: (title: string, color: string, options?: { areaId?: string }) => Promise<{ id: string } | null | undefined>;
    areas: Area[];
    editAreaId: string;
    editAssignedTo: string;
    editAttachments: Task['attachments'] | undefined;
    editContexts: string;
    editDescription: string;
    editDueDate: string;
    editEnergyLevel: TaskEnergyLevel | '';
    editLocation: string;
    editPriority: TaskPriority | '';
    editProjectId: string;
    editRecurrence: Task['recurrence'] extends infer R ? R extends { rule?: infer Rule } ? Rule | '' : '' : '';
    editRecurrenceRRule: string;
    editRecurrenceStrategy: Task['recurrence'] extends infer R ? R extends { strategy?: infer Strategy } ? Strategy : never : never;
    editReviewAt: string;
    editSectionId: string;
    editStartTime: string;
    editStatus: Task['status'];
    editTags: string;
    editTimeEstimate: TimeEstimate | '';
    editTitle: string;
    editingTaskId: string | null;
    projects: Project[];
    setEditingTaskId: (id: string | null) => void;
    setIsEditing: (value: boolean) => void;
    showToast: (message: string, tone?: 'info' | 'error' | 'success') => void;
    t: (key: string) => string;
    task: Task;
    updateTask: (id: string, patch: Partial<Task>) => Promise<unknown>;
};

export function useTaskItemSubmit({
    addProject,
    areas,
    editAreaId,
    editAssignedTo,
    editAttachments,
    editContexts,
    editDescription,
    editDueDate,
    editEnergyLevel,
    editLocation,
    editPriority,
    editProjectId,
    editRecurrence,
    editRecurrenceRRule,
    editRecurrenceStrategy,
    editReviewAt,
    editSectionId,
    editStartTime,
    editStatus,
    editTags,
    editTimeEstimate,
    editTitle,
    editingTaskId,
    projects,
    setEditingTaskId,
    setIsEditing,
    showToast,
    t,
    task,
    updateTask,
}: UseTaskItemSubmitParams) {
    return useCallback(async (event: React.FormEvent) => {
        event.preventDefault();
        const { title: parsedTitle, props: parsedProps, projectTitle, invalidDateCommands } = parseQuickAdd(editTitle, projects, new Date(), areas);
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
            return;
        }
        const cleanedTitle = parsedTitle.trim() ? parsedTitle : task.title;
        if (!cleanedTitle.trim()) return;

        const hasProjectCommand = Boolean(parsedProps.projectId || projectTitle);
        let resolvedProjectId = parsedProps.projectId || undefined;
        if (!resolvedProjectId && projectTitle) {
            try {
                const initialAreaId = editAreaId || undefined;
                const created = await addProject(
                    projectTitle,
                    DEFAULT_PROJECT_COLOR,
                    initialAreaId ? { areaId: initialAreaId } : undefined
                );
                resolvedProjectId = created?.id;
                if (!resolvedProjectId) {
                    const projectCreateFailed = t('projects.createFailed');
                    showToast(
                        projectCreateFailed === 'projects.createFailed'
                            ? 'Failed to create project from quick add.'
                            : projectCreateFailed,
                        'error'
                    );
                }
            } catch (error) {
                reportError('Failed to create project from quick add', error);
                const projectCreateFailed = t('projects.createFailed');
                showToast(
                    projectCreateFailed === 'projects.createFailed'
                        ? 'Failed to create project from quick add.'
                        : projectCreateFailed,
                    'error'
                );
            }
        }
        if (!resolvedProjectId) {
            resolvedProjectId = editProjectId || undefined;
        }
        const recurrenceValue: Recurrence | undefined = editRecurrence
            ? { rule: editRecurrence, strategy: editRecurrenceStrategy }
            : undefined;
        if (recurrenceValue && editRecurrenceRRule) {
            const parsed = parseRRuleString(editRecurrenceRRule);
            if (parsed.byDay && parsed.byDay.length > 0) {
                recurrenceValue.byDay = parsed.byDay;
            }
            recurrenceValue.rrule = editRecurrenceRRule;
        }
        const currentContexts = editContexts.split(',').map((context) => context.trim()).filter(Boolean);
        const mergedContexts = Array.from(new Set([...currentContexts, ...(parsedProps.contexts || [])]));
        const currentTags = editTags.split(',').map((tag) => tag.trim()).filter(Boolean);
        const mergedTags = Array.from(new Set([...currentTags, ...(parsedProps.tags || [])]));
        const resolvedDescription = parsedProps.description
            ? (editDescription ? `${editDescription}\n${parsedProps.description}` : parsedProps.description)
            : (editDescription || undefined);
        const markdownChecklist = extractChecklistFromMarkdown(String(resolvedDescription ?? ''));
        const resolvedChecklist = markdownChecklist.length > 0
            ? mergeMarkdownChecklist(markdownChecklist, task.checklist)
            : undefined;
        const projectChangedByCommand = hasProjectCommand && resolvedProjectId !== (editProjectId || undefined);
        const resolvedSectionId = projectChangedByCommand
            ? undefined
            : (resolvedProjectId ? (editSectionId || undefined) : undefined);
        const resolvedAreaId = projectChangedByCommand
            ? undefined
            : (resolvedProjectId ? undefined : (editAreaId || undefined));

        await updateTask(task.id, {
            title: cleanedTitle,
            status: parsedProps.status || editStatus,
            dueDate: parsedProps.dueDate || editDueDate || undefined,
            startTime: parsedProps.startTime || editStartTime || undefined,
            projectId: resolvedProjectId,
            sectionId: resolvedSectionId,
            areaId: resolvedAreaId,
            contexts: mergedContexts,
            tags: mergedTags,
            description: resolvedDescription,
            ...(resolvedChecklist ? { checklist: resolvedChecklist } : {}),
            location: editLocation || undefined,
            recurrence: recurrenceValue,
            timeEstimate: editTimeEstimate || undefined,
            priority: editPriority || undefined,
            energyLevel: editEnergyLevel || undefined,
            assignedTo: editAssignedTo.trim() || undefined,
            reviewAt: parsedProps.reviewAt || editReviewAt || undefined,
            attachments: (editAttachments?.length ?? 0) > 0 ? editAttachments : undefined,
        });
        setIsEditing(false);
        if (editingTaskId === task.id) {
            setEditingTaskId(null);
        }
    }, [
        addProject,
        areas,
        editAreaId,
        editAssignedTo,
        editAttachments,
        editContexts,
        editDescription,
        editDueDate,
        editEnergyLevel,
        editLocation,
        editPriority,
        editProjectId,
        editRecurrence,
        editRecurrenceRRule,
        editRecurrenceStrategy,
        editReviewAt,
        editSectionId,
        editStartTime,
        editStatus,
        editTags,
        editTimeEstimate,
        editTitle,
        editingTaskId,
        projects,
        setEditingTaskId,
        setIsEditing,
        showToast,
        t,
        task,
        updateTask,
    ]);
}
