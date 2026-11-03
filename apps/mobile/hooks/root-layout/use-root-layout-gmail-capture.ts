import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useTaskStore } from '@mindwtr/core';

import { createGmailCaptureController, registerGmailCaptureController, type GmailCaptureController } from '@/lib/gmail-capture';
import { flushPendingTaskActionSave } from '@/lib/pending-capture-persistence';
import { logInfo } from '@/lib/app-log';

export function useRootLayoutGmailCapture({ canonicalDataReady, disabled = false }: { canonicalDataReady: boolean; disabled?: boolean }) {
    useEffect(() => {
        if (!canonicalDataReady || disabled) return;
        let controller: GmailCaptureController | null = null;
        const stop = () => {
            registerGmailCaptureController(null);
            controller?.pause();
            controller?.dispose();
            controller = null;
        };
        const start = () => {
            if (controller) return;
            controller = createGmailCaptureController({
                addTasks: (items) => useTaskStore.getState().addTasks(items),
                flushPendingSave: flushPendingTaskActionSave,
                initialDelayMs: 1_000,
                logInfo: (message, extra) => { void logInfo(message, { scope: 'gmail-capture', extra }); },
            });
            registerGmailCaptureController(controller);
            controller.start();
        };
        if (AppState.currentState === 'active') start();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') start();
            else stop();
        });
        return () => { stop(); subscription.remove(); };
    }, [canonicalDataReady, disabled]);
}
