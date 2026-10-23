import { AppState } from 'react-native';
import {
    flushPendingSave,
    getStorageAdapter,
    isSandboxMode,
    isWorkspaceTransitionActive,
    noopStorage,
    setStorageAdapter,
    useTaskStore,
} from '@mindwtr/core';

import { documentDirectory, getInfoAsync, readDirectoryAsync } from './file-system';
import { logWarn } from './app-log';
import { flushPendingTaskActionSave } from './pending-capture-persistence';
import { ingestPendingCaptures, PENDING_CAPTURES_DIRECTORY } from './pending-captures';
import { peekPendingNotificationCompletions } from '../modules/notification-open-intents';
import { replayNotificationCompletions } from './notification-completion-drain';
import { mobileStorage } from './storage-adapter';

type IngestDeps = Parameters<typeof ingestPendingCaptures>[0];
type DrainExtras = Pick<IngestDeps, 'transcribeAudio' | 'applyPomodoroCommand'>;

// The foreground hook and the background runs share this queue, and the ingest
// reads a file, writes the store, then deletes the file. One at a time.
let drainChain: Promise<unknown> = Promise.resolve();

/** Drains the native queue through the store this runtime has hydrated. */
export function drainPendingCapturesFromStore(extras: DrainExtras = {}): Promise<number> {
    const run = drainChain.then(() => {
        const { addTask, updateTask, addProject, projects, areas, tasks, people, settings } = useTaskStore.getState();
        return ingestPendingCaptures({
            addTask,
            updateTask,
            addProject,
            projects,
            areas,
            tasks,
            people,
            settings,
            getTasks: () => useTaskStore.getState()._allTasks,
            getProjects: () => useTaskStore.getState()._allProjects,
            flushPendingSave: flushPendingTaskActionSave,
            ...extras,
        });
    });
    drainChain = run.catch(() => undefined);
    return run;
}

const hasQueuedCaptureFiles = async (): Promise<boolean> => {
    if (!documentDirectory) return false;
    const dir = `${documentDirectory}${PENDING_CAPTURES_DIRECTORY}`;
    try {
        if (!(await getInfoAsync(dir)).exists) return false;
        return (await readDirectoryAsync(dir)).some((name) => name.endsWith('.json'));
    } catch {
        return false;
    }
};

/**
 * Turns queued captures and widget check-offs into store writes while the app is
 * closed (#1257), so the sync that follows has something to send. Audio stays
 * queued: transcription is foreground work.
 *
 * A headless runtime starts on core's no-op storage. Ingesting there would
 * "save" to nothing and then delete the queue file, so storage is connected and
 * the store hydrated before the first write.
 */
export async function drainPendingCapturesInBackground(trigger: 'scheduled' | 'capture'): Promise<number> {
    // A visible app drains the queue itself, with transcription and widgets.
    if (AppState.currentState === 'active') return 0;
    if (isSandboxMode() || isWorkspaceTransitionActive()) return 0;
    const hasCaptures = await hasQueuedCaptureFiles();
    let hasCompletions = false;
    try {
        hasCompletions = (await peekPendingNotificationCompletions()).length > 0;
    } catch {
        // An unreadable receipt queue must not strand the independent capture files.
        await logWarn('[Local Notifications] Done queue unreadable; retained for retry', {
            scope: 'notifications',
        }).catch(() => undefined);
    }
    if (!hasCaptures && !hasCompletions) return 0;

    if (getStorageAdapter() === noopStorage) setStorageAdapter(mobileStorage);
    await flushPendingSave();
    await useTaskStore.getState().fetchData({ silent: true });
    // fetchData reports a failed load through `error`; never write into a store that did not load.
    if (useTaskStore.getState().error || isSandboxMode()) return 0;

    const completed = hasCompletions ? await replayNotificationCompletions() : 0;
    const count = completed + (hasCaptures ? await drainPendingCapturesFromStore() : 0);
    if (count > 0) {
        const { reconcileLocalMobileNotificationsInBackground } = await import('./notification-service-local');
        await reconcileLocalMobileNotificationsInBackground('capture');
    }
    return count;
}
