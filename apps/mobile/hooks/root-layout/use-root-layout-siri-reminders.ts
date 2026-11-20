import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import {
    flushPendingSave,
    getStorageAdapter,
    isSandboxMode,
    isWorkspaceTransitionActive,
    useTaskStore,
} from '@mindwtr/core';

import { logWarn } from '@/lib/app-log';
import { getWorkspaceSwitching, subscribeWorkspaceSwitching } from '@/lib/sandbox-workspace';
import { drainSiriReminderActions, projectSiriReminders } from '@/lib/siri-reminders';
import { mobileStorage } from '@/lib/storage-adapter';
import {
    clearSnapshot,
    isAvailable,
    publishSnapshot,
    setAccessAllowed,
    subscribePendingActionsChanged,
} from '../../modules/ios-siri-actions';

const SNAPSHOT_REFRESH_MS = 23 * 60 * 60 * 1000;

export function useRootLayoutSiriReminders({ canonicalDataReady, disabled }: { canonicalDataReady: boolean; disabled: boolean }) {
    const clearing = useRef(Promise.resolve());
    useEffect(() => {
        if (!isAvailable()) return;

        let disposed = false;
        let appState = AppState.currentState;
        let allowed: boolean | undefined;
        let generation = 0;
        let snapshotRequired = true;
        let preferredTaskId: string | undefined;
        let accessGranted = false;
        let observedProjection: string | undefined;
        let snapshotPublishedAt = 0;
        let renewTimer: ReturnType<typeof setTimeout> | undefined;
        let wakeRequested = false;
        let drainRequested = false;
        let running = false;
        let retryAvailable = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const canUse = () => canonicalDataReady && !disabled && !disposed && appState === 'active'
            && !isSandboxMode() && !isWorkspaceTransitionActive() && !getWorkspaceSwitching()
            && getStorageAdapter() === mobileStorage
            && useTaskStore.getState().settings.security?.mobileAppLockEnabled !== true;
        const reportUnavailable = () => {
            void logWarn('Siri Reminder transport unavailable', { scope: 'shortcuts' }).catch(() => undefined);
        };
        const clearTimer = () => {
            clearTimeout(timer);
            timer = undefined;
        };
        const revoke = () => {
            generation += 1;
            accessGranted = false;
            snapshotRequired = true;
            preferredTaskId = undefined;
            wakeRequested = false;
            drainRequested = false;
            observedProjection = undefined;
            clearTimeout(renewTimer);
            clearTimer();
            const revoking = setAccessAllowed(false).catch(reportUnavailable);
            clearing.current = clearing.current.then(() => revoking).then(clearSnapshot).catch(reportUnavailable);
        };

        const storeProjection = () => JSON.stringify(projectSiriReminders(useTaskStore.getState()._allTasks, preferredTaskId));
        const publishCurrentSnapshot = async (canWrite: () => boolean) => {
            snapshotRequired = false;
            await clearing.current;
            if (!canWrite()) return;
            const observedTasks = useTaskStore.getState()._allTasks;
            await flushPendingSave();
            if (!canWrite()) return;
            const { tasks } = await mobileStorage.getData({ requireCanonical: true, rawTasks: true });
            if (!canWrite()) return;
            const now = new Date();
            await publishSnapshot(JSON.stringify({ version: 1, generatedAt: now.toISOString(), ...projectSiriReminders(tasks, preferredTaskId) }));
            if (!canWrite()) return;
            observedProjection = observedTasks === useTaskStore.getState()._allTasks ? storeProjection() : undefined;
            snapshotPublishedAt = now.getTime();
            clearTimeout(renewTimer);
            renewTimer = setTimeout(() => {
                snapshotRequired = true;
                retryAvailable = true;
                void wake();
            }, SNAPSHOT_REFRESH_MS);
        };

        const wake = async (requestDrain = false) => {
            if (!canUse()) return;
            drainRequested ||= requestDrain;
            wakeRequested = true;
            if (running) return;
            running = true;
            try {
                do {
                    wakeRequested = false;
                    const session = generation;
                    const canWrite = () => canUse() && generation === session;
                    const shouldDrain = drainRequested;
                    drainRequested = false;
                    if (snapshotRequired) {
                        snapshotRequired = false;
                        try {
                            const age = Date.now() - snapshotPublishedAt;
                            if (!accessGranted || age < 0 || age >= SNAPSHOT_REFRESH_MS || storeProjection() !== observedProjection) {
                                await publishCurrentSnapshot(canWrite);
                            }
                            if (!canWrite()) continue;
                            if (!accessGranted) {
                                await setAccessAllowed(true);
                                if (!canWrite()) continue;
                                accessGranted = true;
                            }
                        } catch (error) {
                            if (canWrite()) revoke();
                            throw error;
                        }
                    }
                    if (shouldDrain) {
                        await drainSiriReminderActions(canWrite, async (id) => {
                            preferredTaskId = id;
                            await publishCurrentSnapshot(canWrite);
                        });
                    }
                } while (wakeRequested && canUse());
            } catch {
                reportUnavailable();
                if (canUse() && retryAvailable) {
                    retryAvailable = false;
                    clearTimer();
                    timer = setTimeout(() => {
                        timer = undefined;
                        void wake(true);
                    }, 500);
                }
            } finally {
                running = false;
            }
        };

        const reconcile = () => {
            const nextAllowed = canUse();
            if (nextAllowed === allowed) return;
            allowed = nextAllowed;
            if (allowed) {
                retryAvailable = true;
                void wake(true);
            } else {
                revoke();
            }
        };
        const appStateSubscription = AppState.addEventListener('change', (nextState) => {
            appState = nextState;
            reconcile();
        });
        const pendingSubscription = subscribePendingActionsChanged(() => {
            retryAvailable = true;
            void wake(true);
        });
        const unsubscribeWorkspace = subscribeWorkspaceSwitching(reconcile);
        const unsubscribeStore = useTaskStore.subscribe((next, previous) => {
            reconcile();
            if (!allowed || next._allTasks === previous._allTasks) return;
            snapshotRequired = true;
            if (timer === undefined) {
                timer = setTimeout(() => {
                    timer = undefined;
                    retryAvailable = true;
                    void wake();
                }, 250);
            }
        });
        reconcile();
        return () => {
            disposed = true;
            appStateSubscription.remove();
            pendingSubscription.remove();
            unsubscribeWorkspace();
            unsubscribeStore();
            revoke();
        };
    }, [canonicalDataReady, disabled]);
}
