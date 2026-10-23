import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { buildQuickAddParseOptions, flushPendingSave, getProjectNextActionPromptData, parseProjectNextActionInput, shallow, tFallback, useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import { useToast } from '../contexts/toast-context';
import { useThemeColors } from '../hooks/use-theme-colors';
import { ProjectNextActionPromptModal } from './swipeable-task-item/ProjectNextActionPromptModal';
import { settleStoreAction } from './store-action-result';

const TaskEditModal = lazy(async () => ({ default: (await import('./task-edit-modal')).TaskEditModal }));

export function logNextActionSavedForEditing() {
    void import('../lib/app-log').then(({ logInfo }) => logInfo('Project next action saved for editing', {
        scope: 'project-next-action',
        extra: { releaseCheck: 'v1.3.1/next-action-save-edit', stage: 'persisted' },
    })).catch(() => undefined);
}

/** Keep the editor above task rows so completing a row cannot dismiss it. */
export function ProjectNextActionEditor({ taskId, onClose }: { taskId: string; onClose: () => void }) {
    const task = useTaskStore((state) => state._tasksById.get(taskId));
    const updateTask = useTaskStore((state) => state.updateTask);
    useEffect(() => {
        if (!task || task.deletedAt) onClose();
    }, [onClose, task]);
    if (!task || task.deletedAt) return null;
    return (
        <Suspense fallback={null}>
            <TaskEditModal visible task={task} defaultTab="task" onClose={onClose} onSave={updateTask} />
        </Suspense>
    );
}

type ProjectNextActionPromptState = {
    candidates: Task[];
    projectId: string;
    projectTitle: string;
    sectionId?: string;
    scope: 'project' | 'section';
    sectionTitle?: string;
};

type ProjectNextActionPromptPresenter = (completedTask: Task) => boolean;

let activePresenter: ProjectNextActionPromptPresenter | null = null;

const getAllTasksForPrompt = (completedTask: Task, allTasks: Task[]): Task[] => {
    if (allTasks.some((task) => task.id === completedTask.id)) {
        return allTasks.map((task) => (task.id === completedTask.id ? completedTask : task));
    }
    return [...allTasks, completedTask];
};

export function buildProjectNextActionPromptState(completedTask: Task): ProjectNextActionPromptState | null {
    const storeState = useTaskStore.getState();
    const taskLookup = storeState._tasksById instanceof Map ? storeState._tasksById : null;
    const allTasks = Array.isArray(storeState._allTasks) ? storeState._allTasks : storeState.tasks;
    const allProjects = Array.isArray(storeState._allProjects) ? storeState._allProjects : storeState.projects;
    const latestTask = taskLookup?.get(completedTask.id)
        ?? allTasks.find((candidate) => candidate.id === completedTask.id)
        ?? completedTask;
    const completedSnapshot: Task = {
        ...latestTask,
        ...completedTask,
        status: 'done',
    };
    const allSections = Array.isArray(storeState.sections) ? storeState.sections : [];
    const promptData = getProjectNextActionPromptData(
        completedSnapshot,
        getAllTasksForPrompt(completedSnapshot, allTasks),
        allProjects,
        allSections,
    );

    if (!promptData) return null;

    return {
        candidates: promptData.candidates,
        projectId: promptData.project.id,
        projectTitle: promptData.project.title,
        sectionId: completedSnapshot.sectionId,
        scope: promptData.scope,
        sectionTitle: promptData.scope === 'section' && completedSnapshot.sectionId
            ? allSections.find((section) => section.id === completedSnapshot.sectionId)?.title
            : undefined,
    };
}

export function presentProjectNextActionPrompt(completedTask: Task): boolean | null {
    if (!activePresenter) return null;
    return activePresenter(completedTask);
}

export function ProjectNextActionPromptProvider({ children }: { children: React.ReactNode }) {
    const { addTask, updateTask } = useTaskStore((state) => ({
        addTask: state.addTask,
        updateTask: state.updateTask,
    }), shallow);
    const tc = useThemeColors();
    const { t } = useLanguage();
    const { showToast } = useToast();
    const [prompt, setPrompt] = useState<ProjectNextActionPromptState | null>(null);
    const [newTitle, setNewTitle] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
    const [pendingEditorId, setPendingEditorId] = useState<string | null>(null);
    const addingRef = useRef(false);
    const promptOwnerRef = useRef(0);
    const createdTaskRef = useRef<string | null>(null);
    const [titleLocked, setTitleLocked] = useState(false);

    const closePrompt = useCallback(() => {
        promptOwnerRef.current += 1;
        createdTaskRef.current = null;
        setTitleLocked(false);
        setPrompt(null);
        setNewTitle('');
        setIsSubmitting(false);
        setPendingEditorId(null);
    }, []);

    const presentPrompt = useCallback((completedTask: Task) => {
        // Do not replace a draft or put another native modal over its editor.
        if (addingRef.current || pendingEditorId || editingTaskId) return false;
        const nextPrompt = buildProjectNextActionPromptState(completedTask);
        if (!nextPrompt) return false;
        promptOwnerRef.current += 1;
        createdTaskRef.current = null;
        setTitleLocked(false);
        setNewTitle('');
        setPrompt(nextPrompt);
        return true;
    }, [editingTaskId, pendingEditorId]);

    useEffect(() => {
        activePresenter = presentPrompt;
        return () => {
            if (activePresenter === presentPrompt) {
                activePresenter = null;
            }
            promptOwnerRef.current += 1;
        };
    }, [presentPrompt]);

    const showActionFailure = useCallback((message?: string) => {
        showToast({
            title: tFallback(t, 'common.error', 'Error'),
            message: message || tFallback(t, 'projects.nextActionPromptFailed', 'Could not update the next action.'),
            tone: 'error',
            durationMs: 4200,
        });
    }, [showToast, t]);

    const handleChooseTask = useCallback((taskId: string) => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        void settleStoreAction(() => updateTask(taskId, { status: 'next' }))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                closePrompt();
            })
            .finally(() => setIsSubmitting(false));
    }, [closePrompt, isSubmitting, showActionFailure, updateTask]);

    const handleCompleteProject = useCallback(() => {
        if (!prompt || isSubmitting) return;
        const { projectId } = prompt;
        setIsSubmitting(true);
        // Archiving completes the project's remaining tasks in core and is
        // reversible from the editor (Reactivate); no confirmation, matching
        // the Archive button.
        void settleStoreAction(() => useTaskStore.getState().updateProject(projectId, { status: 'archived' }))
            .then((outcome) => {
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                closePrompt();
            })
            .finally(() => setIsSubmitting(false));
    }, [closePrompt, isSubmitting, prompt, showActionFailure]);

    const handleAddTask = useCallback((editAfterSave = false) => {
        if (!prompt || isSubmitting || addingRef.current) return;
        const rawTitle = newTitle.trim();
        if (!rawTitle) return;
        addingRef.current = true;
        const owner = promptOwnerRef.current;
        setIsSubmitting(true);
        // Same quick-add grammar as the capture sheet, so "/waiting" and
        // friends work from this prompt too (#859).
        const state = useTaskStore.getState();
        const { title, props } = parseProjectNextActionInput(rawTitle, {
            projectId: prompt.projectId,
            sectionId: prompt.sectionId,
            projects: state.projects,
            areas: state.areas,
            parseOptions: buildQuickAddParseOptions(state.settings, state),
        });
        void settleStoreAction(async () => {
            if (createdTaskRef.current) {
                // A failed flush leaves an optimistic task. Retry that same
                // snapshot, never create a duplicate or silently change its title.
                await useTaskStore.getState().persistSnapshot();
                await flushPendingSave();
                return { success: true, id: createdTaskRef.current };
            }
            const result = await addTask(title, props);
            if (result.success && editAfterSave && result.id) {
                if (promptOwnerRef.current === owner) {
                    createdTaskRef.current = result.id;
                    setTitleLocked(true);
                }
                await flushPendingSave();
            }
            return result;
        })
            .then((outcome) => {
                if (promptOwnerRef.current !== owner) return;
                if (!outcome.ok) {
                    showActionFailure(outcome.message);
                    return;
                }
                if (editAfterSave && outcome.result?.id) logNextActionSavedForEditing();
                if (editAfterSave && outcome.result?.id && Platform.OS === 'ios') {
                    // UIKit cannot present the editor until the prompt finishes dismissing.
                    setPendingEditorId(outcome.result.id);
                } else {
                    closePrompt();
                    if (editAfterSave && outcome.result?.id) setEditingTaskId(outcome.result.id);
                }
            })
            .finally(() => {
                addingRef.current = false;
                setIsSubmitting(false);
            });
    }, [addTask, closePrompt, isSubmitting, newTitle, prompt, showActionFailure]);

    return (
        <>
            {children}
            {prompt ? (
                <ProjectNextActionPromptModal
                    visible={!pendingEditorId}
                    onDismiss={() => {
                        if (!pendingEditorId) return;
                        setEditingTaskId(pendingEditorId);
                        closePrompt();
                    }}
                    candidates={prompt.candidates}
                    projectTitle={prompt.projectTitle}
                    scope={prompt.scope}
                    sectionTitle={prompt.sectionTitle}
                    newTitle={newTitle}
                    submitting={isSubmitting}
                    titleLocked={titleLocked}
                    tc={tc}
                    t={t}
                    onAddTask={() => handleAddTask()}
                    onSaveAndEdit={() => handleAddTask(true)}
                    onCancel={closePrompt}
                    onChooseTask={handleChooseTask}
                    onCompleteProject={handleCompleteProject}
                    onNewTitleChange={setNewTitle}
                />
            ) : null}
            {editingTaskId ? <ProjectNextActionEditor taskId={editingTaskId} onClose={() => setEditingTaskId(null)} /> : null}
        </>
    );
}
