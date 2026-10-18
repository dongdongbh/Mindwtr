import { useCallback, useEffect, useRef, useState } from 'react';
import { generateUUID, getChecklistEditStatus, runStoreCommand, Task, useTaskStore } from '@mindwtr/core';
import { logError } from '../../lib/app-log';
import { settleStoreAction } from '../store-action-result';

type UpdateTask = ReturnType<typeof useTaskStore.getState>['updateTask'];
type ChecklistItem = NonNullable<Task['checklist']>[number];
// The row's edits by item id, replayed on the list as stored when the save is admitted: a sync save admitted
// first may have published another device's item, and a list built from the row on screen would drop it.
type PendingChecklist = { taskId: string; completed: Map<string, boolean>; added: ChecklistItem[] };

export function useSwipeableChecklist(
    task: Task,
    updateTask: UpdateTask,
    interactionDisabled = false,
) {
    const [showChecklist, setShowChecklist] = useState(false);
    const [localChecklist, setLocalChecklist] = useState(task.checklist || []);
    const checklistUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingChecklist = useRef<PendingChecklist | null>(null);
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
        pendingChecklist.current = null;
        const { taskId, completed, added } = pending;
        // Deliberately not toasted: this also flushes from the unmount cleanup, and
        // a toast fired during teardown lands on whatever screen the user moved to.
        // Logged so a dropped checklist tick is at least diagnosable.
        void settleStoreAction(() => runStoreCommand(async () => {
            const latestTask = useTaskStore.getState()._allTasks.find((item) => item.id === taskId);
            if (!latestTask || latestTask.deletedAt) return undefined;
            const stored = latestTask.checklist ?? [];
            const storedIds = new Set(stored.map((item) => item.id));
            const checklist = [...stored, ...added.filter((item) => !storedIds.has(item.id))].map((item) => (
                completed.has(item.id) ? { ...item, isCompleted: completed.get(item.id)! } : item
            ));
            const status = getChecklistEditStatus({ taskMode: latestTask.taskMode, status: latestTask.status, checklist });
            const nextStatus = status !== latestTask.status ? status : undefined;
            return updateTask(taskId, { checklist, ...(nextStatus ? { status: nextStatus } : {}) });
        })).then((outcome) => {
            if (outcome.ok) return;
            const error = 'cause' in outcome
                ? outcome.cause
                : outcome.message ?? 'checklist update failed';
            void logError(error, { scope: 'swipeable-checklist' });
        });
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

    const scheduleChecklistUpdate = useCallback((taskId: string, edit: (pending: PendingChecklist) => void) => {
        const current = pendingChecklist.current;
        const pending = current?.taskId === taskId ? current : { taskId, completed: new Map(), added: [] };
        edit(pending);
        pendingChecklist.current = pending;
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
            const target = (currentChecklist || [])[index];
            if (!target) return currentChecklist;
            const isCompleted = !target.isCompleted;
            scheduleChecklistUpdate(taskId, (pending) => { pending.completed.set(target.id, isCompleted); });
            return (currentChecklist || []).map((item) => (item.id === target.id ? { ...item, isCompleted } : item));
        });
    }, [interactionDisabled, scheduleChecklistUpdate, task.id]);

    const addChecklistItem = useCallback((title: string) => {
        if (interactionDisabled) return;
        const trimmed = title.trim();
        if (!trimmed) return;
        const taskId = task.id;
        const item = { id: generateUUID(), title: trimmed, isCompleted: false };
        setLocalChecklist((currentChecklist) => {
            scheduleChecklistUpdate(taskId, (pending) => {
                if (!pending.added.some((entry) => entry.id === item.id)) pending.added.push(item);
            });
            return [...(currentChecklist || []), item];
        });
    }, [interactionDisabled, scheduleChecklistUpdate, task.id]);

    return {
        addChecklistItem,
        cancelPendingChecklist,
        localChecklist,
        showChecklist,
        toggleChecklist,
        toggleChecklistItem,
    };
}
