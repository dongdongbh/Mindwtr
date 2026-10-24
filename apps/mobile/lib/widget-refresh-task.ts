import { AppRegistry, AppState, Platform } from 'react-native';
import { flushPendingSave, getStorageAdapter, isSandboxMode, isWorkspaceTransitionActive,
    noopStorage, setStorageAdapter, useTaskStore } from '@mindwtr/core';
import { mobileStorage, quiesceMobileStorage } from './storage-adapter';
import { logInfo, logWarn } from './app-log';
import { updateMobileWidgetFromStore } from './widget-service';

// Selection changes need a fresh projection, even with sync disabled.
export const WIDGET_REFRESH_TASK_NAME = 'MindwtrWidgetRefresh';
let pending: Promise<void> = Promise.resolve();
export function runWidgetRefreshTask(): Promise<void> {
    const run = pending.then(async () => {
        if (isSandboxMode() || isWorkspaceTransitionActive()) return;
        try {
            const cold = getStorageAdapter() === noopStorage;
            if (cold) setStorageAdapter(mobileStorage);
            if (cold || (useTaskStore.getState().error && AppState.currentState !== 'active')) {
                await flushPendingSave();
                await useTaskStore.getState().fetchData({ silent: true });
            }
            const state = useTaskStore.getState();
            if (state.error || state.isLoading || isSandboxMode() || isWorkspaceTransitionActive()) return;
            if (await updateMobileWidgetFromStore()) {
                await logInfo('Widget selection refreshed', { scope: 'widget', extra: {
                    releaseCheck: 'v1.3.8/widget-selection-refresh', outcome: 'published',
                }, force: true });
            }
        } finally {
            try {
                await flushPendingSave();
            } finally {
                await quiesceMobileStorage();
            }
        }
    }).catch(async () => {
        await logWarn('Widget selection refresh failed', { scope: 'widget' });
    });
    pending = run.catch(() => undefined);
    return run;
}

if (Platform.OS === 'android') {
    AppRegistry.registerHeadlessTask(WIDGET_REFRESH_TASK_NAME, () => runWidgetRefreshTask);
}
