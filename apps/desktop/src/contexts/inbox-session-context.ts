import { createContext, useCallback, useContext } from 'react';
import { flushPendingSave, useTaskStore } from '@mindwtr/core';
import { create } from 'zustand';
import { getActiveWorkspaceId } from '../lib/workspace-storage-scope';
import { logInfo } from '../lib/app-log';

export const InboxSessionContext = createContext(false);

const useInboxSession = create<{ workspaceId: string; taskIds: string[] }>(() => ({
    workspaceId: getActiveWorkspaceId(),
    taskIds: [],
}));

useTaskStore.subscribe((state) => {
    const session = useInboxSession.getState();
    if (session.taskIds.length === 0) return;
    const workspaceId = getActiveWorkspaceId();
    const taskIds = session.workspaceId === workspaceId
        ? session.taskIds.filter((id) => {
            const task = state._tasksById.get(id);
            return task?.status === 'done' && !task.deletedAt;
        })
        : [];
    if (taskIds.length !== session.taskIds.length) useInboxSession.setState({ workspaceId, taskIds });
});

export type InboxCompletionTracker = <T>(taskIds: string[], write: () => T | Promise<T>) => Promise<T>;

const trackInboxCompletion: InboxCompletionTracker = async (taskIds, write) => {
    const workspaceId = getActiveWorkspaceId();
    const session = useInboxSession.getState();
    if (session.workspaceId !== workspaceId) useInboxSession.setState({ workspaceId, taskIds: [] });
    const before = useTaskStore.getState()._tasksById;
    const eligibleIds = taskIds.filter((id) => {
        const task = before.get(id);
        return task?.status === 'inbox' && !task.deletedAt;
    });
    const result = await write();
    if (getActiveWorkspaceId() !== workspaceId
        || !result || typeof result !== 'object' || !('success' in result) || result.success !== true) return result;
    if (eligibleIds.length === 0) return result;
    await flushPendingSave();
    if (getActiveWorkspaceId() !== workspaceId) return result;
    const current = useTaskStore.getState()._tasksById;
    const completedIds = eligibleIds.filter((id) => {
        const task = current.get(id);
        return task?.status === 'done' && !task.deletedAt;
    });
    if (completedIds.length > 0) {
        useInboxSession.setState((state) => ({
            workspaceId,
            taskIds: [...new Set([...state.taskIds, ...completedIds])],
        }));
        void logInfo('Inbox session completions recorded', {
            scope: 'inbox',
            extra: { releaseCheck: 'v1.3.9/inbox-session-recap', entries: completedIds.length },
        });
    }
    return result;
};

const writeWithoutRecap: InboxCompletionTracker = async (_taskIds, write) => write();

export function useInboxCompletion(): InboxCompletionTracker {
    const enabled = useContext(InboxSessionContext);
    const workspaceId = getActiveWorkspaceId();
    return useCallback((taskIds, write) => enabled && getActiveWorkspaceId() === workspaceId
        ? trackInboxCompletion(taskIds, write)
        : writeWithoutRecap(taskIds, write), [enabled, workspaceId]);
}

export function useInboxSessionTaskIds(): string[] {
    const session = useInboxSession();
    return session.workspaceId === getActiveWorkspaceId() ? session.taskIds : [];
}
