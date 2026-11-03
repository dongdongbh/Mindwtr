import { flushPendingSave, isSandboxMode, useTaskStore } from '@mindwtr/core';

import { logInfo } from './app-log';

const NATIVE_COMMAND_SAVE_RECOVERY_RELEASE_CHECK = 'v1.3.0/native-command-save-recovery';
const SANDBOX_SAVE_ERROR = 'Pending task action save deferred in sandbox';


export async function flushPendingTaskActionSave(): Promise<void> {
    if (isSandboxMode()) throw new Error(SANDBOX_SAVE_ERROR);
    await flushPendingSave();

    if (!useTaskStore.getState().persistenceFailure) return;
    if (isSandboxMode()) throw new Error(SANDBOX_SAVE_ERROR);

    await useTaskStore.getState().retryPersistence();
    if (useTaskStore.getState().persistenceFailure) {
        throw new Error('Pending task action save recovery failed');
    }

    void logInfo('Native command save recovered', {
        scope: 'capture',
        extra: {
            releaseCheck: NATIVE_COMMAND_SAVE_RECOVERY_RELEASE_CHECK,
            outcome: 'recovered',
        },
    });
}
