import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectCalendarReference, flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore, type ExternalCalendarEvent, type Project, type ProjectCalendarReference } from '@mindwtr/core';
import { ProjectCalendarReference as ProjectCalendarReferenceView } from './ProjectCalendarReference';
import { fetchExternalCalendarEvents } from '../../../lib/external-calendar-events';
import { logInfo } from '../../../lib/app-log';

vi.mock('../../../lib/external-calendar-events', () => ({ fetchExternalCalendarEvents: vi.fn() }));
vi.mock('../../../lib/app-log', () => ({ logInfo: vi.fn().mockResolvedValue(null) }));
const t = (value: string) => value;
const initial = useTaskStore.getState();
const initialStorage = getStorageAdapter();
const calendar = { id: 'feed', name: 'Work calendar', url: 'https://example.test/calendar.ics', enabled: true };
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const event: ExternalCalendarEvent = { id: 'event', sourceId: 'feed', calendarSourceId: 'feed', uid: 'uid', title: 'Client appointment', start: tomorrow.toISOString(), end: new Date(tomorrow.getTime() + 3600000).toISOString(), allDay: false };
const snapshot = createProjectCalendarReference(event, [calendar]);
if (!snapshot) throw new Error('Invalid calendar fixture');
const reference: ProjectCalendarReference = snapshot;
const project: Project = { id: 'project', title: 'Client project', status: 'active', color: '#fff', order: 0, tagIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const updateProject = vi.fn(async (id: string, updates: Partial<Project>) => {
    const state = useTaskStore.getState();
    const latest = state._projectsById.get(id);
    if (!latest) return { success: false };
    const next = { ...latest, ...updates };
    useTaskStore.setState({ _allProjects: [next], _projectsById: new Map([[id, next]]) });
    return { success: true, id };
});
const addTask = vi.fn();
function mount(value: Project = project, readOnly = false, realWrites = false) {
    useTaskStore.setState({ _allProjects: [value], _projectsById: new Map([[value.id, value]]), updateProject: realWrites ? initial.updateProject : updateProject, addTask });
    function Wrapper() {
        const current = useTaskStore(state => state._projectsById.get(value.id));
        return current ? <ProjectCalendarReferenceView key={current.id} project={current} readOnly={readOnly} t={t} /> : null;
    }
    return render(<Wrapper />);
}
beforeEach(() => {
    vi.clearAllMocks();
    useTaskStore.setState({ ...initial, persistenceFailure: null });
    vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ events: [event], calendars: [calendar], warnings: [] });
});
afterEach(async () => { cleanup(); vi.useRealTimers(); await flushPendingSave().catch(() => undefined); setStorageAdapter(initialStorage); resetForTests(); useTaskStore.setState(initial); });

describe('project calendar reference', () => {
    it('loads on opening, excludes unstable events, links and unlinks without creating tasks', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ events: [event, { ...event, id: 'native', title: 'Unstable event', uid: undefined }], calendars: [calendar], warnings: [] });
        mount();
        expect(fetchExternalCalendarEvents).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'projects.calendarLink' }));
        const choice = await screen.findByRole('button', { name: /Client appointment/ });
        expect(screen.queryByText('Unstable event')).toBeNull();
        fireEvent.click(choice);
        await waitFor(() => expect(screen.getByRole('button', { name: 'projects.calendarUnlink' })).toBeEnabled());
        expect(updateProject).toHaveBeenCalledWith(project.id, { calendarReference: reference });
        expect(logInfo).toHaveBeenCalledWith('Project calendar reference saved', expect.objectContaining({ extra: { releaseCheck: 'v1.3.9/project-calendar-reference', outcome: 'linked' } }));
        fireEvent.click(screen.getByRole('button', { name: 'projects.calendarUnlink' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'projects.calendarLink' })).toBeEnabled());
        expect(updateProject).toHaveBeenLastCalledWith(project.id, { calendarReference: null });
        expect(addTask).not.toHaveBeenCalled();
    });
    it('shows loading, failure and an empty picker without offering an event', async () => {
        let reject: (reason: Error) => void = () => {};
        vi.mocked(fetchExternalCalendarEvents).mockImplementationOnce(() => new Promise((_resolve, rejectLoad) => { reject = rejectLoad; }));
        mount();
        fireEvent.click(screen.getByRole('button', { name: 'projects.calendarLink' }));
        expect(screen.getByText('common.loading')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Client appointment/ })).toBeNull();
        await act(async () => { reject(new Error('Unavailable')); });
        expect(screen.getByText('projects.calendarLoadFailed')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValueOnce({ events: [], calendars: [], warnings: [] });
        fireEvent.click(screen.getByRole('button', { name: 'projects.calendarLink' }));
        await screen.findByText('projects.calendarEmpty');
        expect(updateProject).not.toHaveBeenCalled();
    });
    it('bounds rows and searches the complete candidate list before applying the display limit', async () => {
        const events = Array.from({ length: 250 }, (_, index) => ({ ...event, id: `event-${index}`, uid: `uid-${index}`, title: `Appointment ${index}` }));
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ events, calendars: [calendar], warnings: [] });
        mount();
        fireEvent.click(screen.getByRole('button', { name: 'projects.calendarLink' }));
        await screen.findByText('projects.calendarLimit');
        expect(screen.getAllByRole('button', { name: /Appointment/ })).toHaveLength(200);
        expect(screen.queryByText('Appointment 249')).toBeNull();
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Appointment 249' } });
        fireEvent.click(screen.getByRole('button', { name: /Appointment 249/ }));
        await waitFor(() => expect(updateProject).toHaveBeenCalledWith(project.id, { calendarReference: expect.objectContaining({ uid: 'uid-249' }) }));
    });
    it('updates the outcome-review label when the live event ends while details stay open', async () => {
        vi.useFakeTimers();
        const start = Date.now();
        const ending = { ...event, start: new Date(start - 1000).toISOString(), end: new Date(start + 2000).toISOString() };
        const endingReference = createProjectCalendarReference(ending, [calendar]);
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ events: [ending], calendars: [calendar], warnings: [] });
        await act(async () => { mount({ ...project, calendarReference: endingReference }); });
        expect(screen.queryByText('projects.calendarElapsed')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(2001); });
        expect(screen.getByText('projects.calendarElapsed')).toBeTruthy();
        expect(updateProject).not.toHaveBeenCalled();
    });
    it('disables mutations for archived and read-only projects', () => {
        const view = mount({ ...project, status: 'archived' });
        expect(screen.getByRole('button', { name: 'projects.calendarLink' })).toBeDisabled();
        view.unmount();
        mount(project, true);
        expect(screen.getByRole('button', { name: 'projects.calendarLink' })).toBeDisabled();
        expect(fetchExternalCalendarEvents).not.toHaveBeenCalled();
    });
    it('renders a rescheduled event without replacing the stored snapshot', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ events: [{ ...event, title: 'Rescheduled appointment', start: new Date(tomorrow.getTime() + 86400000).toISOString() }], calendars: [calendar], warnings: [] });
        mount({ ...project, calendarReference: reference });
        await screen.findByText('Rescheduled appointment');
        expect(useTaskStore.getState()._projectsById.get(project.id)?.calendarReference).toEqual(reference);
        expect(updateProject).not.toHaveBeenCalled();
    });
    it('preserves last known details on partial calendar failures', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ events: [{ ...event, title: 'Unverified appointment' }], calendars: [calendar], warnings: ['Failed calendar'] });
        mount({ ...project, calendarReference: reference });
        await waitFor(() => expect(fetchExternalCalendarEvents).toHaveBeenCalled());
        await act(async () => {});
        expect(screen.getByText('Client appointment')).toBeTruthy();
        expect(screen.getByText('projects.calendarUnavailable')).toBeTruthy();
        expect(screen.queryByText('Unverified appointment')).toBeNull();
        expect(updateProject).not.toHaveBeenCalled();
    });
    it('does not display an optimistic link before durable save or after failure', async () => {
        let finish: (result: { success: boolean }) => void = () => {};
        updateProject.mockImplementationOnce(async (id, updates) => {
            useTaskStore.setState({ _projectsById: new Map([[id, { ...project, ...updates }]]) });
            return await new Promise(resolve => { finish = resolve; });
        });
        mount();
        fireEvent.click(screen.getByRole('button', { name: 'projects.calendarLink' }));
        fireEvent.click(await screen.findByRole('button', { name: /Client appointment/ }));
        await waitFor(() => expect(updateProject).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: 'projects.calendarUnlink' })).toBeNull();
        await act(async () => { finish({ success: false }); });
        expect(screen.getByRole('alert').textContent).toBe('projects.calendarSaveFailed');
        expect(screen.queryByRole('button', { name: 'projects.calendarUnlink' })).toBeNull();
        expect(logInfo).not.toHaveBeenCalled();
    });
    it('waits for the real storage adapter before confirming a link', async () => {
        let finish: () => void = () => {};
        const held = new Promise<void>(resolve => { finish = resolve; });
        const saveData = vi.fn(async () => { await held; });
        setStorageAdapter({ getData: initialStorage.getData, saveData });
        try {
            mount(project, false, true);
            fireEvent.click(screen.getByRole('button', { name: 'projects.calendarLink' }));
            fireEvent.click(await screen.findByRole('button', { name: /Client appointment/ }));
            await waitFor(() => expect(saveData).toHaveBeenCalled());
            expect(useTaskStore.getState()._projectsById.get(project.id)?.calendarReference).toEqual(reference);
            expect(screen.queryByRole('button', { name: 'projects.calendarUnlink' })).toBeNull();
            expect(logInfo).not.toHaveBeenCalled();
            await act(async () => { finish(); });
            await waitFor(() => expect(screen.getByRole('button', { name: 'projects.calendarUnlink' })).toBeEnabled());
            expect(logInfo).toHaveBeenCalled();
        } finally { finish(); }
    });
    it('keeps the previous link when the real storage adapter rejects the unlink', async () => {
        const previousRetryFlag = Object.getOwnPropertyDescriptor(globalThis, '__mindwtrSkipSaveRetryWait');
        Object.defineProperty(globalThis, '__mindwtrSkipSaveRetryWait', { value: true, configurable: true, writable: true });
        const saveData = vi.fn(async () => { throw new Error('Disk unavailable'); });
        setStorageAdapter({ getData: initialStorage.getData, saveData });
        try {
            mount({ ...project, calendarReference: reference }, false, true);
            fireEvent.click(screen.getByRole('button', { name: 'projects.calendarUnlink' }));
            await screen.findByText('projects.calendarSaveFailed');
            expect(saveData).toHaveBeenCalledTimes(5);
            expect(screen.getByText('Client appointment')).toBeTruthy();
            expect(screen.getByRole('button', { name: 'projects.calendarUnlink' })).toBeEnabled();
            expect(logInfo).not.toHaveBeenCalled();
        } finally {
            if (previousRetryFlag) Object.defineProperty(globalThis, '__mindwtrSkipSaveRetryWait', previousRetryFlag);
            else Reflect.deleteProperty(globalThis, '__mindwtrSkipSaveRetryWait');
        }
    });
    it('rejects a delayed link after the project is unmounted', async () => {
        let release: () => void = () => {};
        const view = mount();
        useTaskStore.setState({
            persistenceFailure: { message: 'Disk unavailable', failedAt: new Date().toISOString(), retrying: false },
            retryPersistence: () => new Promise<void>(resolve => { release = resolve; }),
        });
        fireEvent.click(screen.getByRole('button', { name: 'projects.calendarLink' }));
        fireEvent.click(await screen.findByRole('button', { name: /Client appointment/ }));
        view.unmount();
        await act(async () => { release(); });
        expect(updateProject).not.toHaveBeenCalled();
    });
    it('shows elapsed events for outcome review without changing project or task status', async () => {
        const past = { ...event, start: new Date(Date.now() - 7200000).toISOString(), end: new Date(Date.now() - 3600000).toISOString() };
        const pastReference = createProjectCalendarReference(past, [calendar]);
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ events: [past], calendars: [calendar], warnings: [] });
        mount({ ...project, calendarReference: pastReference });
        await screen.findByText('projects.calendarElapsed');
        expect(updateProject).not.toHaveBeenCalled();
        expect(addTask).not.toHaveBeenCalled();
    });
});
