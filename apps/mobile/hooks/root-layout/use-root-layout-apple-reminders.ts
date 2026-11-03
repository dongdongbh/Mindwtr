import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { resolveI18nText, useTaskStore } from '@mindwtr/core';

import { runAppleRemindersAutoImport } from '@/lib/apple-reminders-import';
import { logError } from '@/lib/app-log';
import { createMobileRecoverySnapshot } from '@/lib/data-transfer';
import { flushPendingTaskActionSave } from '@/lib/pending-capture-persistence';

type ToastOptions = {
    title: string;
    message: string;
    tone: 'warning' | 'error' | 'success' | 'info';
    durationMs?: number;
};


const MIN_RUN_GAP_MS = 30_000;


export function useRootLayoutAppleRemindersAutoImport({
    canonicalDataReady,
    disabled = false,
    showToast,
    t,
}: {
    canonicalDataReady: boolean;
    disabled?: boolean;
    showToast: (options: ToastOptions) => void;
    t: (key: string) => string;
}) {
    const runningRef = useRef(false);
    const lastRunAtRef = useRef(0);
    const enabledRef = useRef(canonicalDataReady && !disabled);
    enabledRef.current = canonicalDataReady && !disabled;
    const showToastRef = useRef(showToast);
    showToastRef.current = showToast;
    const tRef = useRef(t);
    tRef.current = t;

    const run = useCallback(async () => {
        if (!enabledRef.current || runningRef.current) return;
        if (Date.now() - lastRunAtRef.current < MIN_RUN_GAP_MS) return;
        runningRef.current = true;
        lastRunAtRef.current = Date.now();
        try {
            const result = await runAppleRemindersAutoImport({
                addTask: useTaskStore.getState().addTask,
                createRecoverySnapshot: createMobileRecoverySnapshot,
                flushPendingSave: flushPendingTaskActionSave,
                getTaskById: (id) => useTaskStore.getState()._tasksById.get(id),
            });
            if (!result || !enabledRef.current) return;
            if (result.importedCount > 0) {
                showToastRef.current({
                    title: resolveI18nText(tRef.current, 'settings.appleRemindersImport.appleReminders'),
                    message: resolveI18nText(tRef.current, 'settings.appleRemindersImport.importedCount', {
                        values: { taskCount: result.importedCount },
                    }),
                    tone: 'success',
                    durationMs: 4200,
                });
            }
        } catch (error) {


            void logError(error, { scope: 'import', extra: { message: 'Apple Reminders auto-import failed' } });
        } finally {
            runningRef.current = false;
        }
    }, []);

    useEffect(() => {
        if (!canonicalDataReady || disabled) return;
        void run();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') void run();
        });
        return () => subscription.remove();
    }, [canonicalDataReady, disabled, run]);
}
