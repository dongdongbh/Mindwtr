import { afterEach, describe, expect, it } from 'vitest';
import { createProjectCalendarReferenceMethods, type NativeProjectCalendarReferenceRequest } from './native-host-contract-project-calendar-reference';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { NativeCalendarFeed } from './native-host-contract-calendar';
import type { AppData, Project } from './types';
import type { ExternalCalendarEvent } from './ics';

const at = '2026-11-01T10:00:00.000Z';
const project = (change: Partial<Project> = {}): Project => ({ id: 'target', title: 'Project', status: 'active',
    color: '#6b7280', tagIds: [], order: 0, rev: 1, revBy: 'old', createdAt: at, updatedAt: at, ...change });
const calendars = [{ id: 'feed', name: 'Calendar', url: 'https://example.invalid/calendar.ics', enabled: true }];
const event = (index = 0): ExternalCalendarEvent => ({ id: `event-${index}`, sourceId: 'feed', calendarSourceId: 'feed', uid: `uid-${index}`,
    title: `Meeting ${index}`, start: new Date(Date.now() + (index + 1) * 60_000).toISOString(),
    end: new Date(Date.now() + (index + 2) * 60_000).toISOString(), allDay: false });

async function open(change: Partial<Project> = {}, events = [event()]) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [], projects: [project(change)], sections: [], areas: [], people: [],
        settings: { deviceId: 'calendar-device', externalCalendars: calendars } };
    let rejected = false;
    let feed: NativeCalendarFeed = { status: 'ready', calendars, events };
    const adapter = { getData: async () => data, saveData: async (value: AppData) => {
        if (rejected) throw new Error('disk unavailable'); data = structuredClone(value);
    } };
    setStorageAdapter(adapter);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    const methods = createProjectCalendarReferenceMethods({ readiness: () => ({ ok: true, value: null }), revision: () => 'revision', formatDate: (reference) => `label:${reference.start}`,
        load: async () => ({ ok: true, value: feed }), save: async () => {
            try { await flushPendingSave(); return { ok: true as const, value: null }; }
            catch { return { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'disk unavailable' } }; }
        } });
    const options = async (query?: string) => {
        const answer = await methods.getProjectCalendarReferenceOptions({ projectId: 'target', ...(query === undefined ? {} : { query }) });
        if (!answer.ok) throw new Error(JSON.stringify(answer)); return answer.value;
    };
    const request = async (clear = false): Promise<NativeProjectCalendarReferenceRequest> => {
        const value = await options();
        const { id: _id, ...expected } = value.project;
        return { requestId: '73799899-d143-40c1-84bd-a09172bba5a4', projectId: 'target', pickerId: value.pickerId,
            value: clear ? null : value.candidates[0], expected };
    };
    return { methods, options, request, data: () => data, adapter, reject: (value: boolean) => { rejected = value; },
        feed: (value: NativeCalendarFeed) => { feed = value; } };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('native Project calendar reference command', () => {
    it('persists linking and replacement once, replays the frozen command and preserves unrelated fields', async () => {
        const fixture = await open({ supportNotes: 'Untouched notes', dueDate: '2026-12-01' });
        const request = await fixture.request(), prepared = fixture.methods.prepareProjectCalendarReference(request);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error('prepare failed');
        const envelope = { request, prepared: prepared.value.prepared };
        expect(fixture.methods.validatePreparedProjectCalendarReference(envelope).ok).toBe(true);
        expect(await fixture.methods.commitPreparedProjectCalendarReference(envelope)).toEqual({ ok: true, value: { id: 'target', value: request.value } });
        const first = structuredClone(fixture.data());
        expect(first.projects[0]).toMatchObject({ calendarReference: request.value, supportNotes: 'Untouched notes', dueDate: '2026-12-01', rev: 2 });
        expect(first.tasks).toEqual([]);
        expect(await fixture.methods.commitPreparedProjectCalendarReference(envelope)).toMatchObject({ ok: true });
        expect(fixture.data()).toEqual(first);
        const next = event(2);
        fixture.feed({ status: 'ready', calendars, events: [next] });
        const replacement = await fixture.request(), plan = fixture.methods.prepareProjectCalendarReference(replacement);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error('replacement prepare failed');
        expect(await fixture.methods.commitPreparedProjectCalendarReference({ request: replacement, prepared: plan.value.prepared })).toMatchObject({ ok: true });
        expect(fixture.data().projects[0].calendarReference?.uid).toBe(next.uid);
        expect(fixture.data().projects[0].rev).toBe(3);
    });

    it('clears with explicit null and preserves the removal through a cold read', async () => {
        const fixture = await open();
        const options = await fixture.options();
        await useTaskStore.getState().updateProject('target', { calendarReference: options.candidates[0] });
        await flushPendingSave();
        const request = await fixture.request(true), prepared = fixture.methods.prepareProjectCalendarReference(request);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(await fixture.methods.commitPreparedProjectCalendarReference({ request, prepared: prepared.value.prepared })).toMatchObject({ ok: true });
        await useTaskStore.getState().fetchData({ throwOnError: true });
        expect(useTaskStore.getState()._projectsById.get('target')?.calendarReference).toBeNull();
    });

    it('rejects tampered candidates, changed Projects, changed feed settings and switched adapters before mutation', async () => {
        const fixture = await open(), request = await fixture.request();
        expect(fixture.methods.prepareProjectCalendarReference({ ...request, value: { ...request.value!, title: 'Not issued' } }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, externalCalendars: [] } });
        expect(fixture.methods.prepareProjectCalendarReference(request)).toMatchObject({ ok: false });
        useTaskStore.setState({ settings: { ...useTaskStore.getState().settings, externalCalendars: calendars } });
        setStorageAdapter({ ...fixture.adapter });
        expect(fixture.methods.prepareProjectCalendarReference(request)).toMatchObject({ ok: false });
        setStorageAdapter(fixture.adapter);
        await useTaskStore.getState().updateProject('target', { title: 'Changed' });
        expect(fixture.methods.prepareProjectCalendarReference(request)).toMatchObject({ ok: false });
        expect(fixture.data().projects[0].calendarReference).toBeUndefined();
    });

    it('keeps one revision across a failed save and exact retry, and refuses a forged frozen effect', async () => {
        const fixture = await open(), request = await fixture.request(), prepared = fixture.methods.prepareProjectCalendarReference(request);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error('prepare failed');
        const envelope = { request, prepared: prepared.value.prepared };
        const forged = structuredClone(envelope); forged.prepared.effect.project.after.title = 'Changed';
        expect(fixture.methods.validatePreparedProjectCalendarReference(forged)).toMatchObject({ ok: false });
        fixture.reject(true);
        expect(await fixture.methods.commitPreparedProjectCalendarReference(envelope)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(fixture.data().projects[0].calendarReference).toBeUndefined();
        fixture.reject(false);
        expect(await fixture.methods.commitPreparedProjectCalendarReference(envelope)).toMatchObject({ ok: true });
        expect(fixture.data().projects[0].rev).toBe(2);
    });

    it('excludes ambiguous identities and refuses ready feeds with warnings', async () => {
        const selected = event();
        const fixture = await open({}, [selected, { ...selected, id: 'duplicate' }]);
        expect((await fixture.options()).candidates).toEqual([]);
        fixture.feed({ status: 'ready', calendars, events: [selected], warning: 'Partial read' });
        expect(await fixture.options()).toMatchObject({ available: false, candidates: [] });
    });

    it('searches all candidates before the response cap and blocks archived Projects', async () => {
        const fixture = await open({}, Array.from({ length: 205 }, (_, index) => event(index)));
        const first = await fixture.options();
        expect(first.candidates).toHaveLength(200); expect(first.total).toBe(205);
        expect(first.candidateDateLabels).toEqual(first.candidates.map((reference) => `label:${reference.start}`));
        expect(first.currentDateLabel).toBeNull();
        expect((await fixture.options('Meeting 204')).candidates).toHaveLength(1);
        const request = await fixture.request();
        useTaskStore.setState({ _allProjects: [project({ status: 'archived' })] });
        const current = await fixture.options();
        const { id: _id, ...expected } = current.project;
        expect(fixture.methods.prepareProjectCalendarReference({ ...request, expected })).toMatchObject({ ok: true, value: { kind: 'blocked' } });
    });
});
