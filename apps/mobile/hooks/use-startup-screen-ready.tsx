import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState, type LayoutChangeEvent } from 'react-native';
import { afterPaint } from '@mindwtr/core';
import { logInfo } from '@/lib/app-log';
import { markStartupPhase, startupElapsedMs, startupNow } from '@/lib/startup-profiler';
import { reportFullyDrawn } from '../modules/startup-metrics';

export type StartupScreen = 'focus' | 'inbox' | 'projects';
export const StartupReadinessContext = createContext<{ canonicalDataReady: boolean; pathname: string } | null>(null);
let initialScreenReported = false;

/** Only the active, laid-out screen may report readiness; locks do not mount it. */
export function useStartupScreenReady(screen: StartupScreen) {
    const context = useContext(StartupReadinessContext);
    const hasContext = context !== null;
    const [laidOut, setLaidOut] = useState(false);
    const [foreground, setForeground] = useState(AppState.currentState === 'active');
    const [resume, setResume] = useState(0);
    const resumedAt = useRef<number | null>(null);
    const active = context?.canonicalDataReady === true && context.pathname.replace(/\/$/, '').endsWith(`/${screen}`);
    const activeRef = useRef(active);
    activeRef.current = active;

    useEffect(() => {
        if (!hasContext) return;
        const subscription = AppState.addEventListener('change', (state) => {
            setForeground(state === 'active');
            if (state === 'active' && activeRef.current) {
                resumedAt.current = startupNow();
                setResume((value) => value + 1);
            } else resumedAt.current = null;
        });
        return () => subscription.remove();
    }, [hasContext]);

    useEffect(() => {
        if (!active || !laidOut || !foreground) {
            if (!active) resumedAt.current = null;
            return;
        }
        return afterPaint(() => {
            if (!activeRef.current || AppState.currentState !== 'active') return;
            // Native reporting is idempotent per Activity, including recreation.
            void reportFullyDrawn();
            if (!initialScreenReported) {
                initialScreenReported = true;
                markStartupPhase('js.interactive_ready', { route: screen });
                void logInfo('Startup screen ready', {
                    scope: 'performance',
                    extra: { releaseCheck: 'v1.3.0/startup-readiness', route: screen, elapsedMs: startupElapsedMs() },
                }).catch(() => undefined);
            }
            if (resumedAt.current !== null) {
                markStartupPhase('js.resume_ready', { route: screen, durationMs: Math.round(startupNow() - resumedAt.current) });
                resumedAt.current = null;
            }
        });
    }, [active, laidOut, foreground, resume, screen]);

    return useCallback((event: LayoutChangeEvent) => {
        if (hasContext) setLaidOut(event.nativeEvent.layout.width > 0 && event.nativeEvent.layout.height > 0);
    }, [hasContext]);
}
