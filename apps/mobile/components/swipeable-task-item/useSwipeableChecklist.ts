import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getChecklistProgress, Task, useTaskStore } from '@mindwtr/core';

type UpdateTask = ReturnType<typeof useTaskStore.getState>['updateTask'];

export function useSwipeableChecklist(task: Task, updateTask: UpdateTask) {
    const [showChecklist, setShowChecklist] = useState(false);
    const [localChecklist, setLocalChecklist] = useState(task.checklist || []);
    const checklistUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingChecklist = useRef<{ taskId: string; checklist: Task['checklist'] } | null>(null);
    const checklistTaskIdRef = useRef(task.id);

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
        const pending = pendingChecklist.current;
        if (!pending) return;
        const { taskId } = pending;
        const checklist = pending.checklist ?? [];
        const latestTask = useTaskStore.getState().tasks.find((item) => item.id === taskId);
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
        updateTask(taskId, { checklist, ...(nextStatus ? { status: nextStatus } : {}) });
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

    useEffect(() => () => {
        clearChecklistTimer();
        flushPendingChecklist();
    }, [clearChecklistTimer, flushPendingChecklist]);

    const toggleChecklist = useCallback(() => {
        setShowChecklist((value) => !value);
    }, []);

    const toggleChecklistItem = useCallback((index: number) => {
        const taskId = task.id;
        setLocalChecklist((currentChecklist) => {
            const nextChecklist = (currentChecklist || []).map((item, itemIndex) =>
                itemIndex === index ? { ...item, isCompleted: !item.isCompleted } : item
            );
            pendingChecklist.current = { taskId, checklist: nextChecklist };
            clearChecklistTimer();
            checklistUpdateTimer.current = setTimeout(() => {
                const pending = pendingChecklist.current;
                if (!pending || pending.taskId !== taskId) return;
                flushPendingChecklist();
                checklistUpdateTimer.current = null;
            }, 200);
            return nextChecklist;
        });
    }, [clearChecklistTimer, flushPendingChecklist, task.id]);

    const checklistProgress = useMemo(
        () => getChecklistProgress({ ...task, checklist: localChecklist }),
        [task, localChecklist]
    );

    return {
        cancelPendingChecklist,
        checklistProgress,
        localChecklist,
        showChecklist,
        toggleChecklist,
        toggleChecklistItem,
    };
}
