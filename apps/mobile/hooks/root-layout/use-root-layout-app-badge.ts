import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { countTasksForIconBadge, isSandboxMode, useTaskStore } from '@mindwtr/core';

import { isIosAppBadgeSupported, refreshIosAppBadge, subscribeIosAppBadgeEnabled } from '@/lib/ios-app-badge';
import { getWorkspaceSwitching, subscribeWorkspaceSwitching } from '@/lib/sandbox-workspace';
import { logWarn } from '@/lib/app-log';

export function useRootLayoutAppBadge({ canonicalDataReady, disabled = false }: {
    canonicalDataReady: boolean;
    disabled?: boolean;
}) {
    const readiness = useRef({ canonicalDataReady, disabled });
    readiness.current = { canonicalDataReady, disabled };
    const refresh = useRef<(() => void) | null>(null);

    useEffect(() => {
        if (!isIosAppBadgeSupported()) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cached: { tasks: unknown; projects: unknown; sections: unknown; dayBoundary: number; count: number } | undefined;
        const getCount = () => {
            if (disposed) return null;
            if (readiness.current.disabled || isSandboxMode() || getWorkspaceSwitching()) return 0;
            const state = useTaskStore.getState();
            if (!readiness.current.canonicalDataReady || state.isLoading || state.error) return null;
            const now = new Date();
            // The UTC boundary changes on a timezone change even when the local date stays the same.
            const dayBoundary = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
            if (!cached || cached.tasks !== state._allTasks || cached.projects !== state._allProjects
                || cached.sections !== state._allSections || cached.dayBoundary !== dayBoundary) {
                cached = {
                    tasks: state._allTasks, projects: state._allProjects, sections: state._allSections, dayBoundary,
                    count: countTasksForIconBadge(state._allTasks, state._allProjects, state._allSections, now),
                };
            }
            return cached.count;
        };
        const run = (force = false) => {
            if (disposed) return;
            void refreshIosAppBadge(getCount, { canWrite: () => !disposed, force }).catch(() => {
                // Fixed fields only: native/storage exceptions may contain sensitive implementation details.
                void logWarn('iOS task badge refresh failed', {
                    scope: 'notifications',
                    extra: { releaseCheck: 'v1.3.7/ios-task-badge', result: 'failed' },
                });
            });
        };
        const scheduleMidnight = () => {
            if (timer) clearTimeout(timer);
            const now = new Date();
            const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
            timer = setTimeout(() => { run(); scheduleMidnight(); }, midnight.getTime() - now.getTime() + 50);
        };
        refresh.current = run;
        const unsubscribeStore = useTaskStore.subscribe((state, previous) => {
            if (state._allTasks !== previous._allTasks || state._allProjects !== previous._allProjects
                || state._allSections !== previous._allSections || state.isLoading !== previous.isLoading
                || state.error !== previous.error) run();
        });
        const unsubscribePreference = subscribeIosAppBadgeEnabled(run);
        const unsubscribeWorkspace = subscribeWorkspaceSwitching(run);
        const lifecycle = AppState.addEventListener('change', (state) => {
            if (state === 'active') { run(true); scheduleMidnight(); }
        });
        run(true);
        scheduleMidnight();
        return () => {
            disposed = true;
            refresh.current = null;
            if (timer) clearTimeout(timer);
            unsubscribeStore(); unsubscribePreference(); unsubscribeWorkspace(); lifecycle.remove();
        };
    }, []);

    useEffect(() => { refresh.current?.(); }, [canonicalDataReady, disabled]);
}
