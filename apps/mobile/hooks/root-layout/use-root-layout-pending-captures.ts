import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useTaskStore } from '@mindwtr/core';

import { logError, logInfo } from '@/lib/app-log';
import { drainPendingCapturesFromStore } from '@/lib/pending-capture-drain';
import { flushPendingTaskActionSave } from '@/lib/pending-capture-persistence';
import { ingestIosWidgetCompletions } from '@/lib/ios-widget-completions';
import { updateMobileWidgetFromStore } from '@/lib/widget-service';
import { getNextPendingCompletionAt } from '../../modules/ios-widget';
import { mobilePomodoroController } from '@/lib/pomodoro-controller';
import { transcribePendingAudio } from '@/lib/watch-audio';


export function useRootLayoutPendingCaptures({ canonicalDataReady, disabled = false }: { canonicalDataReady: boolean; disabled?: boolean }) {
    const drainRunningRef = useRef(false);
    const drainRequestedRef = useRef(false);
    const appActiveRef = useRef(false);
    const widgetCompletionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedAtRef = useRef(Date.now());
    const firstDrainLoggedRef = useRef(false);
    const canonicalDrainEnabledRef = useRef(canonicalDataReady && !disabled);
    canonicalDrainEnabledRef.current = canonicalDataReady && !disabled;

    const clearWidgetCompletionTimer = useCallback(() => {
        if (widgetCompletionTimerRef.current !== null) clearTimeout(widgetCompletionTimerRef.current);
        widgetCompletionTimerRef.current = null;
    }, []);

    const drainQueue = useCallback(async () => {
        if (!canonicalDrainEnabledRef.current) return;
        clearWidgetCompletionTimer();
        drainRequestedRef.current = true;
        if (drainRunningRef.current) return;
        drainRunningRef.current = true;
        try {
            do {
                drainRequestedRef.current = false;
                const ingested = await drainPendingCapturesFromStore({
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
                if (!firstDrainLoggedRef.current) {
                    firstDrainLoggedRef.current = true;
                    void logInfo('Startup capture drain ran after canonical data load', {
                        scope: 'capture',
                        extra: {
                            releaseCheck: 'v1.3.3/mobile-startup-writes-after-canonical-load',
                            elapsedMs: Date.now() - mountedAtRef.current,
                            count: ingested,
                        },
                    });
                }


                if (ingested > 0 && canonicalDrainEnabledRef.current) {
                    try {
                        if (await updateMobileWidgetFromStore()) {
                            void logInfo('Widgets refreshed after pending capture import', {
                                scope: 'widget',
                                extra: { releaseCheck: 'v1.3.1/pending-capture-widget-refresh', count: ingested },
                            });
                        }
                    } catch (error) {


                        void logError(error, { scope: 'widget', extra: { message: 'Post-import widget refresh failed' } });
                    }
                }
                if (canonicalDrainEnabledRef.current) {
                    const { updateTask, tasks } = useTaskStore.getState();
                    await ingestIosWidgetCompletions({
                        updateTask,
                        tasks,
                        getTasks: () => useTaskStore.getState()._allTasks,
                        flushPendingSave: flushPendingTaskActionSave,
                        refreshWidgets: updateMobileWidgetFromStore,
                    });
                }
            } while (drainRequestedRef.current && canonicalDrainEnabledRef.current);


            if (appActiveRef.current && canonicalDrainEnabledRef.current) {
                const nextWidgetCompletionAt = await getNextPendingCompletionAt();
                if (appActiveRef.current && canonicalDrainEnabledRef.current && nextWidgetCompletionAt !== null) {
                    widgetCompletionTimerRef.current = setTimeout(() => {
                        widgetCompletionTimerRef.current = null;
                        void drainQueue();
                    }, Math.max(0, Math.min(nextWidgetCompletionAt - Date.now(), 2_147_483_647)));
                }
            }
        } catch (error) {
            void logError(error, { scope: 'shortcuts', extra: { message: 'Pending capture ingest failed' } });
        } finally {
            drainRunningRef.current = false;
            if (drainRequestedRef.current && canonicalDrainEnabledRef.current) void drainQueue();
        }
    }, [clearWidgetCompletionTimer]);

    useEffect(() => {
        if (!canonicalDataReady || disabled) return;
        appActiveRef.current = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
        void drainQueue();
        const subscription = AppState.addEventListener('change', (state) => {
            appActiveRef.current = state === 'active';
            clearWidgetCompletionTimer();
            if (state === 'active') void drainQueue();
        });
        return () => {
            appActiveRef.current = false;
            clearWidgetCompletionTimer();
            subscription.remove();
        };
    }, [canonicalDataReady, disabled, drainQueue, clearWidgetCompletionTimer]);

    return drainQueue;
}
