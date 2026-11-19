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
import { logInfo, logWarn } from './app-log';
import { flushPendingTaskActionSave } from './pending-capture-persistence';
import { ingestPendingCaptures, PENDING_CAPTURES_DIRECTORY } from './pending-captures';
import { peekPendingNotificationCompletions } from '../modules/notification-open-intents';
import { replayNotificationCompletions } from './notification-completion-drain';
import { mobileStorage } from './storage-adapter';

type IngestDeps = Parameters<typeof ingestPendingCaptures>[0];
type DrainExtras = Pick<IngestDeps, 'transcribeAudio' | 'applyPomodoroCommand'>;


let drainChain: Promise<unknown> = Promise.resolve();
const PENDING_CAPTURE_DRAIN_RELEASE_CHECK = 'v1.3.9/pending-capture-drain';

const countQueuedCaptureFiles = async (): Promise<number> => {
    if (!documentDirectory) return 0;
    const dir = `${documentDirectory}${PENDING_CAPTURES_DIRECTORY}`;
    try {
        if (!(await getInfoAsync(dir)).exists) return 0;
        return (await readDirectoryAsync(dir)).filter((name) => name.endsWith('.json')).length;
    } catch {
        return 0;
    }
};


export function drainPendingCapturesFromStore(extras: DrainExtras = {}): Promise<number> {
    const run = drainChain.then(async () => {
        const queued = await countQueuedCaptureFiles();
        let saved = 0;
        let outcome: 'drained' | 'failed' = 'failed';
        try {
            const { addTask, updateTask, addProject, projects, areas, tasks, people, settings } = useTaskStore.getState();
            saved = await ingestPendingCaptures({
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
            outcome = 'drained';
            return saved;
        } finally {
            if (queued > 0) {
                void logInfo('Pending capture queue drained', {
                    scope: 'capture',
                    force: true,
                    extra: { releaseCheck: PENDING_CAPTURE_DRAIN_RELEASE_CHECK, outcome, queued, saved, left: await countQueuedCaptureFiles() },
                });
            }
        }
    });
    drainChain = run.catch(() => undefined);
    return run;
}



export async function drainPendingCapturesInBackground(trigger: 'scheduled' | 'capture'): Promise<number> {

    if (AppState.currentState === 'active') return 0;
    if (isSandboxMode() || isWorkspaceTransitionActive()) return 0;
    const hasCaptures = (await countQueuedCaptureFiles()) > 0;
    let hasCompletions = false;
    try {
        hasCompletions = (await peekPendingNotificationCompletions()).length > 0;
    } catch {

        await logWarn('[Local Notifications] Done queue unreadable; retained for retry', {
            scope: 'notifications',
        }).catch(() => undefined);
    }
    if (!hasCaptures && !hasCompletions) return 0;

    if (getStorageAdapter() === noopStorage) setStorageAdapter(mobileStorage);
    await flushPendingSave();
    await useTaskStore.getState().fetchData({ silent: true });

    if (useTaskStore.getState().error || isSandboxMode()) return 0;

    const completed = hasCompletions ? await replayNotificationCompletions() : 0;
    const count = completed + (hasCaptures ? await drainPendingCapturesFromStore() : 0);
    if (count > 0) {
        const { reconcileLocalMobileNotificationsInBackground } = await import('./notification-service-local');
        await reconcileLocalMobileNotificationsInBackground('capture');
    }
    return count;
}
