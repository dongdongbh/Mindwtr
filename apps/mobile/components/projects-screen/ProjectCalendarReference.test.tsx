import React from 'react';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectCalendarReference, flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore, type ExternalCalendarEvent, type Project } from '@mindwtr/core';
import { ProjectCalendarReference } from './ProjectCalendarReference';
import { fetchExternalCalendarEvents } from '../../lib/external-calendar';
import { logInfo } from '../../lib/app-log';

vi.mock('../../lib/external-calendar', () => ({ fetchExternalCalendarEvents: vi.fn() }));
vi.mock('../../lib/app-log', () => ({ logInfo: vi.fn().mockResolvedValue(null) }));
vi.mock('../../hooks/use-theme-colors', () => ({ useThemeColors: () => ({ cardBg: '#fff', border: '#ddd', text: '#111', secondaryText: '#555', tint: '#00f', inputBg: '#fff', danger: '#f00', icon: '#555' }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
const t = (value: string) => value;
const initial = useTaskStore.getState();
const initialStorage = getStorageAdapter();
const calendar = { id: 'feed', name: 'Work calendar', url: 'https://example.test/calendar.ics', enabled: true };
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const event: ExternalCalendarEvent = { id: 'event', sourceId: 'feed', calendarSourceId: 'feed', uid: 'uid', title: 'Client appointment', start: tomorrow.toISOString(), end: new Date(tomorrow.getTime() + 3600000).toISOString(), allDay: false };
const reference = createProjectCalendarReference(event, [calendar]);
if (!reference) throw new Error('Invalid calendar fixture');
const project: Project = { id: 'project', title: 'Client project', status: 'active', color: '#fff', order: 0, tagIds: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const updateProject = vi.fn(async (id: string, updates: Partial<Project>) => {
    const latest = useTaskStore.getState()._projectsById.get(id);
    if (!latest) return { success: false };
    const next = { ...latest, ...updates };
    useTaskStore.setState({ _allProjects: [next], _projectsById: new Map([[id, next]]) });
    return { success: true, id };
});
const addTask = vi.fn();
let tree: ReturnType<typeof create>;
const button = (id: string) => tree.root.findAllByType(TouchableOpacity).find(node => node.props.testID === id);
const text = () => tree.root.findAllByType(Text).map(node => node.props.children).filter(value => typeof value === 'string').join(' ');
async function mount(value: Project = project, readOnly = false, realWrites = false) {
    useTaskStore.setState({ _allProjects: [value], _projectsById: new Map([[value.id, value]]), updateProject: realWrites ? initial.updateProject : updateProject, addTask });
    function Wrapper() {
        const current = useTaskStore(state => state._projectsById.get(value.id));
        return current ? <ProjectCalendarReference key={current.id} project={current} readOnly={readOnly} t={t} /> : null;
    }
    await act(async () => { tree = create(<Wrapper />); });
}
beforeEach(() => {
    vi.clearAllMocks();
    useTaskStore.setState({ ...initial, persistenceFailure: null });
    vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ events: [event], calendars: [calendar] });
});
afterEach(async () => { if (tree) await act(async () => { tree.unmount(); }); await flushPendingSave().catch(() => undefined); setStorageAdapter(initialStorage); resetForTests(); useTaskStore.setState(initial); });

describe('project calendar reference mobile', () => {
    it('loads on opening and explicitly links and unlinks without task creation', async () => {
        await mount();
        expect(fetchExternalCalendarEvents).not.toHaveBeenCalled();
        await act(async () => { button('project-calendar-link')?.props.onPress(); });
        expect(fetchExternalCalendarEvents).toHaveBeenCalled();
        await act(async () => { button('project-calendar-event-0')?.props.onPress(); });
        expect(updateProject).toHaveBeenCalledWith(project.id, { calendarReference: reference });
        expect(button('project-calendar-unlink')).toBeTruthy();
        await act(async () => { button('project-calendar-unlink')?.props.onPress(); });
        expect(updateProject).toHaveBeenLastCalledWith(project.id, { calendarReference: null });
        expect(button('project-calendar-unlink')).toBeUndefined();
        expect(addTask).not.toHaveBeenCalled();
        expect(logInfo).toHaveBeenLastCalledWith('Project calendar reference saved', expect.objectContaining({ extra: { releaseCheck: 'v1.3.9/project-calendar-reference', outcome: 'unlinked' } }));
    });
    it('searches beyond the first 200 displayed events', async () => {
        const events = Array.from({ length: 250 }, (_, index) => ({ ...event, id: `event-${index}`, uid: `uid-${index}`, title: `Appointment ${index}` }));
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ events, calendars: [calendar] });
        await mount();
        await act(async () => { button('project-calendar-link')?.props.onPress(); });
        expect(tree.root.findAllByType(TouchableOpacity).filter(node => node.props.testID?.startsWith('project-calendar-event-'))).toHaveLength(200);
        expect(text()).toContain('projects.calendarLimit');
        await act(async () => { tree.root.findByType(TextInput).props.onChangeText('Appointment 249'); });
        expect(text()).toContain('Appointment 249');
        await act(async () => { button('project-calendar-event-0')?.props.onPress(); });
        expect(updateProject).toHaveBeenCalledWith(project.id, { calendarReference: expect.objectContaining({ uid: 'uid-249' }) });
    });
    it('retains snapshot details when the feed reports an error', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockImplementation(async (_start, _end, options) => {
            options?.onFeedError?.('feed');
            return { events: [{ ...event, title: 'Unverified appointment' }], calendars: [calendar] };
        });
        await mount({ ...project, calendarReference: reference });
        expect(text()).toContain('Client appointment');
        expect(text()).toContain('projects.calendarUnavailable');
        expect(text()).not.toContain('Unverified appointment');
        expect(updateProject).not.toHaveBeenCalled();
    });
    it('shows fresh rescheduling without persisting the live event', async () => {
        vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ events: [{ ...event, title: 'Rescheduled appointment' }], calendars: [calendar] });
        await mount({ ...project, calendarReference: reference });
        expect(text()).toContain('Rescheduled appointment');
        expect(useTaskStore.getState()._projectsById.get(project.id)?.calendarReference).toEqual(reference);
        expect(updateProject).not.toHaveBeenCalled();
    });
    it('disables linking for archived projects', async () => {
        await mount({ ...project, status: 'archived' });
        expect(button('project-calendar-link')?.props.disabled).toBe(true);
        await act(async () => { button('project-calendar-link')?.props.onPress(); });
        await act(async () => { button('project-calendar-event-0')?.props.onPress(); });
        expect(updateProject).not.toHaveBeenCalled();
    });
    it('waits for the real storage adapter before confirming a link', async () => {
        let finish: () => void = () => {};
        const held = new Promise<void>(resolve => { finish = resolve; });
        const saveData = vi.fn(async () => { await held; });
        setStorageAdapter({ getData: initialStorage.getData, saveData });
        try {
            await mount(project, false, true);
            await act(async () => { button('project-calendar-link')?.props.onPress(); });
            await act(async () => { button('project-calendar-event-0')?.props.onPress(); });
            expect(saveData).toHaveBeenCalled();
            expect(button('project-calendar-unlink')).toBeUndefined();
            expect(logInfo).not.toHaveBeenCalled();
            await act(async () => { finish(); });
            expect(button('project-calendar-unlink')).toBeTruthy();
            expect(logInfo).toHaveBeenCalled();
        } finally { finish(); }
    });
    it('retains the prior link after a real storage rejection', async () => {
        const previousRetryFlag = Object.getOwnPropertyDescriptor(globalThis, '__mindwtrSkipSaveRetryWait');
        Object.defineProperty(globalThis, '__mindwtrSkipSaveRetryWait', { value: true, configurable: true, writable: true });
        const saveData = vi.fn(async () => { throw new Error('Disk unavailable'); });
        setStorageAdapter({ getData: initialStorage.getData, saveData });
        try {
            await mount({ ...project, calendarReference: reference }, false, true);
            await act(async () => { button('project-calendar-unlink')?.props.onPress(); });
            expect(saveData).toHaveBeenCalledTimes(5);
            expect(text()).toContain('Client appointment');
            expect(text()).toContain('projects.calendarSaveFailed');
            expect(logInfo).not.toHaveBeenCalled();
        } finally {
            if (previousRetryFlag) Object.defineProperty(globalThis, '__mindwtrSkipSaveRetryWait', previousRetryFlag);
            else Reflect.deleteProperty(globalThis, '__mindwtrSkipSaveRetryWait');
        }
    });
    it('retains the old reference on refused save', async () => {
        updateProject.mockResolvedValueOnce({ success: false });
        await mount({ ...project, calendarReference: reference });
        await act(async () => { button('project-calendar-unlink')?.props.onPress(); });
        expect(text()).toContain('Client appointment');
        expect(text()).toContain('projects.calendarSaveFailed');
        expect(logInfo).not.toHaveBeenCalled();
    });
});
