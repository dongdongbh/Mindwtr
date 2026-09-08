import { logInfo } from './app-log';

const enabled = import.meta.env.VITE_STARTUP_PROFILING === '1';
// navigationStart precedes module evaluation; these are WebView, not process timings.
const origin = typeof performance !== 'undefined' ? performance.now() : 0;
const milestones = new Map<string, number>();
let reported = false;

export function markDesktopStartup(phase: 'bootstrap' | 'storage_adapter_ready' | 'shell_ready' | 'local_data_ready' | 'interactive_ready') {
    if (milestones.has(phase)) return;
    const elapsedMs = Math.round(performance.now());
    milestones.set(phase, elapsedMs);
    if (enabled) {
        performance.mark(`mindwtr.${phase}`);
        console.info(`[MindwtrStartup] phase=desktop.${phase} sinceNavigationMs=${elapsedMs}`);
    }
    if (phase !== 'interactive_ready' || reported) return;
    reported = true;
    void logInfo('Startup screen ready', {
        scope: 'performance',
        extra: { releaseCheck: 'v1.3.0/startup-readiness', elapsedMs, moduleElapsedMs: Math.round(performance.now() - origin) },
    }).catch(() => undefined);
}
