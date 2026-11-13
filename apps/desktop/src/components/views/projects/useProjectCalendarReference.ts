import { useEffect, useMemo, useRef, useState } from 'react';
import {
    flushPendingSave, getProjectCalendarReferenceCandidates, isWorkspaceTransitionActive, resolveProjectCalendarReference, safeParseDate, updateProjectFromLatest, useTaskStore,
    type ExternalCalendarEvent, type ExternalCalendarSubscription, type Project, type ProjectCalendarReference,
} from '@mindwtr/core';
import { fetchExternalCalendarEvents } from '../../../lib/external-calendar-events';
import { logInfo } from '../../../lib/app-log';

type CalendarLoad = { status: 'idle' | 'loading' | 'error' } | {
    status: 'ready'; events: ExternalCalendarEvent[]; calendars: ExternalCalendarSubscription[]; available: boolean;
};

export function useProjectCalendarReference(project: Project, readOnly: boolean) {
    const [pickerOpen, setPickerOpen] = useState(false);
    const [currentTime, setCurrentTime] = useState(() => new Date());
    const [load, setLoad] = useState<CalendarLoad>({ status: 'idle' });
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(false);
    const [confirmed, setConfirmed] = useState<{ reference: ProjectCalendarReference | null }>();
    const current = useRef({ project, readOnly });
    current.current = { project, readOnly };
    const mounted = useRef(true);
    const savingRef = useRef(false);
    const subscriptions = useTaskStore(state => state.settings.externalCalendars);
    const reference = confirmed ? confirmed.reference : project.calendarReference;
    const hasReference = Boolean(reference);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => {
        if (!pickerOpen && !hasReference) return;
        let cancelled = false;
        setLoad({ status: 'loading' });
        const now = new Date();
        const horizon = new Date(now);
        horizon.setDate(horizon.getDate() + 90);
        const ranges: [Date, Date][] = [[now, horizon]];
        const referenceStart = safeParseDate(reference?.start);
        const referenceEnd = safeParseDate(reference?.end);
        if (referenceStart && referenceEnd && (referenceEnd.getTime() <= now.getTime() || referenceStart.getTime() >= horizon.getTime())) {
            const start = referenceStart;
            start.setDate(start.getDate() - 1);
            const end = referenceEnd;
            end.setDate(end.getDate() + 1);
            ranges.push([start, end]);
        }
        Promise.all(ranges.map(([start, end]) => fetchExternalCalendarEvents(start, end))).then(results => {
            if (cancelled) return;
            setCurrentTime(new Date());
            const upcomingIds = new Set(results[0].events.map(event => event.id));
            setLoad({ status: 'ready', events: results.flatMap((result, index) => index === 0 ? result.events : result.events.filter(event => !upcomingIds.has(event.id))),
                calendars: results[0].calendars, available: results.every(result => result.warnings.length === 0) });
        }).catch(() => { if (!cancelled) setLoad({ status: 'error' }); });
        return () => { cancelled = true; };
    }, [pickerOpen, hasReference, reference?.sourceId, reference?.uid, reference?.recurrenceId, reference?.start, reference?.end, subscriptions]);
    const resolved = reference ? resolveProjectCalendarReference(reference,
        load.status === 'ready' ? load.events : [], load.status === 'ready' && load.available, currentTime) : undefined;
    const eventEnd = resolved?.event?.end;
    useEffect(() => {
        if (!eventEnd) return;
        const end = Date.parse(eventEnd);
        const remaining = end - Date.now();
        if (remaining <= 0) {
            if (currentTime.getTime() < end) setCurrentTime(new Date());
            return;
        }
        const timer = setTimeout(() => setCurrentTime(new Date()), Math.min(remaining + 1, 2_147_483_647));
        return () => clearTimeout(timer);
    }, [eventEnd, currentTime]);
    const choices = useMemo(() => load.status === 'ready' && load.available
        ? getProjectCalendarReferenceCandidates(load.events, load.calendars, currentTime) : [], [load, currentTime]);
    const save = async (next: ProjectCalendarReference | null) => {
        if (readOnly || project.status === 'archived' || savingRef.current || isWorkspaceTransitionActive()) return;
        const projectId = project.id;
        const previous = reference ?? null;
        savingRef.current = true;
        setConfirmed({ reference: previous });
        setSaving(true);
        setSaveError(false);
        try {
            const state = useTaskStore.getState();
            if (state.persistenceFailure) await state.retryPersistence();
            const result = await updateProjectFromLatest(projectId, latest => {
                if (!mounted.current || current.current.project.id !== projectId || current.current.readOnly || isWorkspaceTransitionActive() || latest.status === 'archived' || latest.deletedAt) {
                    throw new Error('Project cannot be changed');
                }
                return { calendarReference: next };
            });
            if (!result.success) throw new Error('Reference could not be saved');
            await flushPendingSave();
            void logInfo('Project calendar reference saved', {
                scope: 'projects', extra: { releaseCheck: 'v1.3.9/project-calendar-reference', outcome: next ? 'linked' : 'unlinked' },
            }).catch(() => undefined);
            if (!mounted.current) return;
            setConfirmed(undefined);
            setPickerOpen(false);
        } catch {
            if (mounted.current) setSaveError(true);
        } finally {
            savingRef.current = false;
            if (mounted.current) setSaving(false);
        }
    };
    return { reference, resolved, choices, pickerOpen, setPickerOpen, load, saving, saveError, save };
}
