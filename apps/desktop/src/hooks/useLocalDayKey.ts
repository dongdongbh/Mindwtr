import { useEffect, useState } from 'react';
import { getNextFutureStartRevealAt } from '@mindwtr/core';

export function getLocalDayKey(now: Date = new Date()): string {
    return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export function useLocalDayKey(enabled = true): string {
    const [dayKey, setDayKey] = useState(getLocalDayKey);

    useEffect(() => {
        if (!enabled) return;
        let timer: number | undefined;
        const scheduleNextDay = () => {
            if (timer) window.clearTimeout(timer);
            const now = new Date();
            const nextDay = new Date(now);
            nextDay.setHours(24, 0, 0, 0);
            timer = window.setTimeout(refresh, Math.max(1, nextDay.getTime() - now.getTime() + 50));
        };
        const refresh = () => {
            setDayKey(getLocalDayKey());
            scheduleNextDay();
        };

        scheduleNextDay();
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            if (timer) window.clearTimeout(timer);
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [enabled]);

    return dayKey;
}


export function useFutureStartRevealTick(
    tasks: ReadonlyArray<{ startTime?: string }>,
    enabled = true,
): number {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!enabled) return;
        const now = new Date();
        const nextDay = new Date(now);
        nextDay.setHours(24, 0, 0, 0);
        const revealAt = getNextFutureStartRevealAt(tasks);
        const wakeAt = revealAt === null ? nextDay.getTime() : Math.min(revealAt, nextDay.getTime());
        const timer = window.setTimeout(() => setTick((t) => t + 1), Math.max(1, wakeAt - now.getTime() + 50));
        return () => window.clearTimeout(timer);
    }, [enabled, tasks, tick]);
    return tick;
}
