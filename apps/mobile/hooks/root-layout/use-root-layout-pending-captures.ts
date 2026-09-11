import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { flushPendingSave, useTaskStore } from '@mindwtr/core';

import { logError } from '@/lib/app-log';
import { ingestPendingCaptures } from '@/lib/pending-captures';
import { mobilePomodoroController } from '@/lib/pomodoro-controller';
import { transcribePendingAudio } from '@/lib/watch-audio';

// Drains background Shortcuts captures (#845) into the store on startup and
// on every return to the foreground; the queue directory is empty on every
// platform and flow that never enqueues, so this is a single stat call.
export function useRootLayoutPendingCaptures({ dataReady, disabled = false }: { dataReady: boolean; disabled?: boolean }) {
    const runningRef = useRef(false);
    const pendingRef = useRef(false);

    const drainQueue = useCallback(async () => {
        if (disabled) return;
        pendingRef.current = true;
        if (runningRef.current) return;
        runningRef.current = true;
        try {
            do {
                pendingRef.current = false;
                const { addTask, updateTask, addProject, projects, areas, tasks, people, settings } = useTaskStore.getState();
                await ingestPendingCaptures({
                    addTask,
                    updateTask,
                    addProject,
                    projects,
                    areas,
                    tasks,
                    people,
                    settings,
                    getTasks: () => useTaskStore.getState()._allTasks,
                    flushPendingSave,
                    transcribeAudio: transcribePendingAudio,
                    applyPomodoroCommand: (command) => {
                        const pomodoroSettings = useTaskStore.getState().settings.gtd?.pomodoro;
                        return mobilePomodoroController.applyWatchCommand(command, {
                            autoStartBreaks: pomodoroSettings?.autoStartBreaks === true,
                            autoStartFocus: pomodoroSettings?.autoStartFocus === true,
                        }, {
                            linkTaskEnabled: pomodoroSettings?.linkTask === true,
                        });
                    },
                });
            } while (pendingRef.current);
        } catch (error) {
            void logError(error, { scope: 'shortcuts', extra: { message: 'Pending capture ingest failed' } });
        } finally {
            runningRef.current = false;
            if (pendingRef.current) void drainQueue();
        }
    }, [disabled]);

    useEffect(() => {
        if (!dataReady || disabled) return;
        void drainQueue();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') void drainQueue();
        });
        return () => subscription.remove();
    }, [dataReady, disabled, drainQueue]);

    return drainQueue;
}
