import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generateUUID, getChecklistProgress, Task, useTaskStore } from '@mindwtr/core';
import { logError } from '../../lib/app-log';
import { settleStoreAction } from '../store-action-result';

type UpdateTask = ReturnType<typeof useTaskStore.getState>['updateTask'];

export function useSwipeableChecklist(
    task: Task,
    updateTask: UpdateTask,
    interactionDisabled = false,
) {
    const [showChecklist, setShowChecklist] = useState(false);
    const [localChecklist, setLocalChecklist] = useState(task.checklist || []);
    const checklistUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingChecklist = useRef<{ taskId: string; checklist: Task['checklist'] } | null>(null);
    const checklistTaskIdRef = useRef(task.id);
    const interactionDisabledRef = useRef(interactionDisabled);
    interactionDisabledRef.current = interactionDisabled;

    const clearChecklistTimer = useCallback(() => {
        if (checklistUpdateTimer.current) {
            clearTimeout(checklistUpdateTimer.current);
            checklistUpdateTimer.current = null;
        }
    }, []);

    const cancelPendingChecklist = useCallback(() => {
        clearChecklistTimer();
        pendingChecklist.current = null;
    }, [clearChecklistTimer]);

    const flushPendingChecklist = useCallback(() => {
        if (interactionDisabledRef.current) {
            pendingChecklist.current = null;
            return;
        }
        const pending = pendingChecklist.current;
        if (!pending) return;
        const { taskId } = pending;
        const checklist = pending.checklist ?? [];
        const latestTask = useTaskStore.getState()._allTasks.find((item) => item.id === taskId);
        if (!latestTask || latestTask.deletedAt) {
            pendingChecklist.current = null;
            return;
        }
        const isListMode = latestTask.taskMode === 'list';
        const allComplete = checklist.length > 0 && checklist.every((entry) => entry.isCompleted);
        const nextStatus = isListMode
            ? allComplete
                ? 'done'
                : latestTask.status === 'done'
                    ? 'next'
                    : undefined
            : undefined;
        // Deliberately not toasted: this also flushes from the unmount cleanup, and
        // a toast fired during teardown lands on whatever screen the user moved to.
        // Logged so a dropped checklist tick is at least diagnosable.
        void settleStoreAction(() => (
            updateTask(taskId, { checklist, ...(nextStatus ? { status: nextStatus } : {}) })
        )).then((outcome) => {
            if (outcome.ok) return;
            const error = 'cause' in outcome
                ? outcome.cause
                : outcome.message ?? 'checklist update failed';
            void logError(error, { scope: 'swipeable-checklist' });
        });
        pendingChecklist.current = null;
    }, [updateTask]);

    useEffect(() => {
        setLocalChecklist(task.checklist || []);
    }, [task.checklist]);

    useEffect(() => {
        if (checklistTaskIdRef.current !== task.id) {
            flushPendingChecklist();
            checklistTaskIdRef.current = task.id;
            clearChecklistTimer();
        }
    }, [task.id, clearChecklistTimer, flushPendingChecklist]);

    useEffect(() => {
        if (task.deletedAt) {
            cancelPendingChecklist();
        }
    }, [task.deletedAt, cancelPendingChecklist]);

    useEffect(() => {
        if (!interactionDisabled) return;
        cancelPendingChecklist();
        setLocalChecklist(task.checklist || []);
    }, [cancelPendingChecklist, interactionDisabled, task.checklist]);

    useEffect(() => () => {
        clearChecklistTimer();
        flushPendingChecklist();
    }, [clearChecklistTimer, flushPendingChecklist]);

    const toggleChecklist = useCallback(() => {
        setShowChecklist((value) => !value);
    }, []);

    const scheduleChecklistUpdate = useCallback((taskId: string, checklist: Task['checklist']) => {
        pendingChecklist.current = { taskId, checklist };
        clearChecklistTimer();
        checklistUpdateTimer.current = setTimeout(() => {
            const pending = pendingChecklist.current;
            if (!pending || pending.taskId !== taskId) return;
            flushPendingChecklist();
            checklistUpdateTimer.current = null;
        }, 200);
    }, [clearChecklistTimer, flushPendingChecklist]);

    const toggleChecklistItem = useCallback((index: number) => {
        if (interactionDisabled) return;
        const taskId = task.id;
        setLocalChecklist((currentChecklist) => {
            const nextChecklist = (currentChecklist || []).map((item, itemIndex) =>
                itemIndex === index ? { ...item, isCompleted: !item.isCompleted } : item
            );
            scheduleChecklistUpdate(taskId, nextChecklist);
            return nextChecklist;
        });
    }, [interactionDisabled, scheduleChecklistUpdate, task.id]);

    const addChecklistItem = useCallback((title: string) => {
        if (interactionDisabled) return;
        const trimmed = title.trim();
        if (!trimmed) return;
        const taskId = task.id;
        setLocalChecklist((currentChecklist) => {
            const nextChecklist = [
                ...(currentChecklist || []),
                { id: generateUUID(), title: trimmed, isCompleted: false },
            ];
            scheduleChecklistUpdate(taskId, nextChecklist);
            return nextChecklist;
        });
    }, [interactionDisabled, scheduleChecklistUpdate, task.id]);

    const checklistProgress = useMemo(
        () => getChecklistProgress({ ...task, checklist: localChecklist }),
        [task, localChecklist]
    );

    return {
        addChecklistItem,
        cancelPendingChecklist,
        checklistProgress,
        localChecklist,
        showChecklist,
        toggleChecklist,
        toggleChecklistItem,
    };
}
