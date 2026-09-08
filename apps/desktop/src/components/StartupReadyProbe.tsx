import { useEffect } from 'react';
import { afterPaint } from '@mindwtr/core';
import { markDesktopStartup } from '../lib/startup-profiler';

/** Inside Suspense, after successful hydration: a fallback must never report ready. */
export function StartupReadyProbe({ ready }: { ready: boolean }) {
    useEffect(() => {
        if (!ready) return;
        let cancel: (() => void) | undefined;
        const schedule = () => {
            cancel?.();
            cancel = document.visibilityState === 'hidden'
                ? undefined
                : afterPaint(() => markDesktopStartup('interactive_ready'));
        };
        schedule();
        document.addEventListener('visibilitychange', schedule);
        return () => {
            cancel?.();
            document.removeEventListener('visibilitychange', schedule);
        };
    }, [ready]);
    return null;
}
