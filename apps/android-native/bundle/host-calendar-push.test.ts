import { afterEach, describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { setLogger } from '../../../packages/core/src/logger';
import type { NativeCalendarPushLifecycle } from '../../../packages/core/src/native-host-contract-settings-calendar';
import { openSqliteHost } from '../../../packages/core/src/screen-parity.replay';
import { flushPendingSave, getStorageAdapter, useTaskStore } from '../../../packages/core/src/store';
import type { SqliteAdapter } from '../../../packages/core/src/sqlite-adapter';
import type { Task } from '../../../packages/core/src/types';
import { createNativeCalendar } from './host-calendar';


const KEY = {
    enabled: 'mindwtr:calendar-push-sync:enabled',
    calendarId: 'mindwtr:calendar-push-sync:calendar-id',
    target: 'mindwtr:calendar-push-sync:target-calendar-id',
    color: 'mindwtr:calendar-push-sync:color',
    pending: 'mindwtr:calendar-push-sync:pending-calendar',
};
const at = '2026-10-28T00:00:00.000Z';
const task = (id: string, extra: Partial<Task> = {}): Task => ({ id, title: `PRIVATE ${id}`, status: 'next', contexts: [], tags: [],
    dueDate: '2026-10-30', createdAt: at, updatedAt: at, ...extra });
type Calendar = { id: string; title: string; name: string; color: string; ownerAccount: string; accessLevel: string;
    allowsModifications: boolean; source: { name: string; type: string; isLocalAccount: boolean } };
const calendar = (id: string, extra: Partial<Calendar> = {}): Calendar => ({ id, title: 'Personal', name: 'me@example.com', color: '#0B8043',
    ownerAccount: 'me@example.com', accessLevel: 'owner', allowsModifications: true,
    source: { name: 'me@example.com', type: 'com.google', isLocalAccount: false }, ...extra });
const MARKER = '0f0e0d0c-0b0a-4908-8706-050403020100';

function phone(calendars: Calendar[], events: Record<string, { calendarId: string; title: string }> = {}) {
    const state = { calendars: calendars.map((entry) => structuredClone(entry)), events: new Map(Object.entries(events)), next: 500,
        calls: [] as Record<string, unknown>[], refuse: new Set<string>(), unreadable: false };
    const call = async (request: Record<string, unknown>): Promise<unknown> => {
        state.calls.push(structuredClone(request));
        const op = request.op as string;
        if (state.refuse.has(op)) throw new Error(`Calendar with id ${String(request.calendarId)} could not be deleted`);
        switch (op) {
            case 'getPermissions': return { status: 'granted' };
            case 'getCalendars':
                if (state.unreadable) throw new Error('CALENDAR permission is required to do this operation.');
                return structuredClone(state.calendars);
            case 'getEvents': return [];
            case 'createCalendar': {
                const details = request.details as Record<string, any>;
                const id = String(state.next++);
                state.calendars.push({ id, title: details.title, name: details.name, color: details.color.toUpperCase(), ownerAccount: details.ownerAccount,
                    accessLevel: 'owner', allowsModifications: true, source: { name: details.source.name, type: details.source.type, isLocalAccount: false } });
                return id;
            }
            case 'deleteCalendar': {
                const index = state.calendars.findIndex((entry) => entry.id === request.calendarId);
                if (index < 0) throw new Error(`Calendar with id ${String(request.calendarId)} could not be deleted`);
                state.calendars.splice(index, 1);
                for (const [id, event] of state.events) if (event.calendarId === request.calendarId) state.events.delete(id);
                return null;
            }
            case 'createEvent': {
                if (!state.calendars.some((entry) => entry.id === request.calendarId)) throw new Error(`Couldn't find calendar with given id: ${String(request.calendarId)}`);
                const id = String(state.next++);
                state.events.set(id, { calendarId: request.calendarId as string, title: (request.details as { title: string }).title });
                return id;
            }
            case 'updateEvent': {
                const event = state.events.get(request.eventId as string);
                if (!event || (request.calendarId && event.calendarId !== request.calendarId)) throw new Error('Calendar event not found');
                event.title = (request.details as { title: string }).title;
                return null;
            }
            case 'deleteEvent': {
                const event = state.events.get(request.eventId as string);
                if (!event || (request.calendarId && event.calendarId !== request.calendarId)) throw new Error('Calendar event not found');
                state.events.delete(request.eventId as string);
                return null;
            }
            default: throw new Error(`Unsupported calendar call ${op}`);
        }
    };
    const writes = () => state.calls.filter((entry) => !['getPermissions', 'getCalendars', 'getEvents'].includes(entry.op as string))
        .map((entry) => entry.op);
    return { state, call, writes };
}

const lines: { message: string; context?: Record<string, string> }[] = [];
setLogger((entry) => { lines.push({ message: entry.message, context: entry.context as Record<string, string> | undefined }); });

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const host of opened.splice(0)) await host.close(); lines.length = 0; });

async function upgrade(options: { tasks: Task[]; kv: Record<string, string>; device: ReturnType<typeof phone>;
    rows?: { taskId: string; eventId: string; calendarId: string }[] }) {
    const kv = new Map(Object.entries(options.kv));
    const keyValue = {
        get: async (name: string) => kv.get(name) ?? null,
        set: async (name: string, value: string) => { kv.set(name, value); },
        remove: async (name: string) => { kv.delete(name); },
    };
    let lifecycle: NativeCalendarPushLifecycle | null = null;
    const host = createNativeCalendar(keyValue, () => options.device.call, () => async () => new Uint8Array(),
        () => getStorageAdapter() as unknown as SqliteAdapter);
    const bind = host.bindPushLifecycle!;
    host.bindPushLifecycle = (bound) => { lifecycle = bound; bind(bound); };
    const sqlite = await openSqliteHost({ tasks: options.tasks }, undefined, { calendar: host });
    opened.push(sqlite);
    for (const row of options.rows ?? []) {
        await sqlite.client().run('INSERT INTO calendar_sync (task_id, calendar_event_id, calendar_id, platform, last_synced_at) VALUES (?, ?, ?, ?, ?)',
            [row.taskId, row.eventId, row.calendarId, 'android', at]);
    }
    const rows = async () => (await sqlite.sql<{ task_id: string; calendar_event_id: string; calendar_id: string }>(
        "SELECT task_id, calendar_event_id, calendar_id FROM calendar_sync WHERE platform = 'android' ORDER BY task_id"))
        .map((row) => [row.task_id, row.calendar_event_id, row.calendar_id]);
    return { sqlite, host, kv, rows, lifecycle: () => lifecycle!, contract: () => sqlite.host };
}

const started = () => lines.find((line) => line.message === 'Native Android calendar push started')?.context;

describe('an upgrade from RN keeps RN\'s Mindwtr calendar and its events', () => {
    it('reuses the saved calendar: done tasks lose their event, the rest update in place, and none is made (e98b4e796)', async () => {
        const device = phone([calendar('1'), calendar('7', { title: 'Mindwtr', name: `mindwtr:${MARKER}`, color: '#3B82F6' })],
            { 70: { calendarId: '7', title: 'old' }, 71: { calendarId: '7', title: 'old' } });
        const app = await upgrade({ tasks: [task('t1'), task('t2', { status: 'done', completedAt: at }), task('t3')],
            kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' }, device,
            rows: [{ taskId: 't1', eventId: '70', calendarId: '7' }, { taskId: 't2', eventId: '71', calendarId: '7' }] });
        await app.host.startPush();
        expect(device.state.calendars.filter((entry) => entry.title === 'Mindwtr').map((entry) => entry.id)).toEqual(['7']);
        expect(device.writes()).not.toContain('createCalendar');
        expect(await app.rows()).toEqual([['t1', '70', '7'], ['t3', '500', '7']]);
        expect([...device.state.events.keys()].sort()).toEqual(['500', '70']);
        expect(device.state.events.get('70')!.title).toBe('PRIVATE t1');
        expect(started()).toEqual({ releaseCheck: 'v1.3.8/native-calendar-push', outcome: 'pushed', adopted: 'existing', rowsBefore: '2', rowsAfter: '2' });
    });

    it('adopts the calendar a cut-short RN creation made, by its pending marker, and never makes a second (38368fa80)', async () => {
        const device = phone([calendar('1'), calendar('9', { title: 'Mindwtr', name: `mindwtr:${MARKER}`, color: '#3B82F6' })]);
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '1', [KEY.pending]: MARKER }, device });
        await app.host.startPush();
        expect(device.writes()).toEqual(['createEvent']);
        expect(app.kv.get(KEY.calendarId)).toBe('9');
        expect(app.kv.has(KEY.pending)).toBe(false);
        expect(await app.rows()).toEqual([['t1', '500', '9']]);
        expect(started()).toMatchObject({ outcome: 'pushed', adopted: 'marker', rowsBefore: '0', rowsAfter: '1' });
    });

    it('makes the Mindwtr calendar on an owned calendar\'s account with the marker name when RN left none (236d4fc47)', async () => {
        const device = phone([calendar('1')]);
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '1' }, device });
        await app.host.startPush();
        const create = device.state.calls.find((entry) => entry.op === 'createCalendar')!.details as Record<string, any>;
        expect(create).toMatchObject({ title: 'Mindwtr', color: '#3B82F6', ownerAccount: 'me@example.com', accessLevel: 'owner',
            source: { name: 'me@example.com', type: 'com.google', isLocalAccount: false } });
        expect(create.name).toMatch(/^mindwtr:[0-9a-f-]{36}$/);
        expect(app.kv.has(KEY.pending)).toBe(false);
        expect(started()).toMatchObject({ adopted: 'new' });
    });

    it('a stale saved ID gives way to the marked calendar (95c08e607)', async () => {
        const device = phone([calendar('1'), calendar('9', { title: 'Mindwtr', name: `mindwtr:${MARKER}` })]);
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '4', [KEY.pending]: MARKER }, device });
        await app.host.startPush();
        expect(app.kv.get(KEY.calendarId)).toBe('9');
        expect(device.writes()).toEqual(['createEvent']);
    });

    it('clears nothing and makes nothing when the calendars cannot be read (95c08e607)', async () => {
        const device = phone([calendar('7', { title: 'Mindwtr', name: `mindwtr:${MARKER}` })], { 70: { calendarId: '7', title: 'old' } });
        device.state.unreadable = true;
        const app = await upgrade({ tasks: [task('t1', { status: 'done', completedAt: at })], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' },
            device, rows: [{ taskId: 't1', eventId: '70', calendarId: '7' }] });
        await app.host.startPush();
        expect(device.writes()).toEqual([]);
        expect(app.kv.get(KEY.calendarId)).toBe('7');
        expect(await app.rows()).toEqual([['t1', '70', '7']]);
    });

    it('pushes nothing while push is off', async () => {
        const device = phone([calendar('1')]);
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '0' }, device });
        await app.host.startPush();
        expect(device.writes()).toEqual([]);
        expect(started()).toBeUndefined();
    });
});

describe('missing events (RN bugs 1 and 2, fixed in CalendarPushWrites.kt)', () => {
    it('an event deleted in the calendar app is made again', async () => {
        const device = phone([calendar('7', { title: 'Mindwtr', name: `mindwtr:${MARKER}` })]);
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' }, device,
            rows: [{ taskId: 't1', eventId: '70', calendarId: '7' }] });
        await app.host.startPush();
        expect(await app.rows()).toEqual([['t1', '500', '7']]);
        expect(device.state.events.get('500')).toEqual({ calendarId: '7', title: 'PRIVATE t1' });
    });

    it('after the Mindwtr calendar is deleted in the system app, its tasks go to the new one', async () => {
        const device = phone([calendar('1')]);
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' }, device,
            rows: [{ taskId: 't1', eventId: '70', calendarId: '7' }] });
        await app.host.startPush();
        const made = device.state.calendars.find((entry) => entry.title === 'Mindwtr')!.id;
        expect(await app.rows()).toEqual([['t1', '501', made]]);
    });
});

describe('an event ID the provider reused (review N9: the S23 hands a deleted _id to the next event)', () => {
    it('never writes or deletes the user\'s event that took a pushed event\'s ID: core makes its own event and forgets the row', async () => {
        const device = phone([calendar('1'), calendar('7', { title: 'Mindwtr', name: `mindwtr:${MARKER}` })],
            { 70: { calendarId: '1', title: 'Dentist' }, 71: { calendarId: '1', title: 'Gym' } });
        const app = await upgrade({ tasks: [task('t1'), task('t2', { status: 'done', completedAt: at })], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' },
            device, rows: [{ taskId: 't1', eventId: '70', calendarId: '7' }, { taskId: 't2', eventId: '71', calendarId: '7' }] });
        await app.host.startPush();
        expect(device.state.events.get('70')).toEqual({ calendarId: '1', title: 'Dentist' });
        expect(device.state.events.get('71')).toEqual({ calendarId: '1', title: 'Gym' });
        expect(await app.rows()).toEqual([['t1', '500', '7']]);
        expect(device.state.events.get('500')).toEqual({ calendarId: '7', title: 'PRIVATE t1' });
    });
});

describe('both the calendar ID and an event ID reused (correction review BLOCK 1)', () => {
    it('keeps the user\'s event in the calendar that took the deleted Mindwtr calendar\'s ID', async () => {
        const device = phone([calendar('1'), calendar('7', { title: 'Work', name: 'work@example.com' })], { 70: { calendarId: '7', title: 'Dentist' } });
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' },
            device, rows: [{ taskId: 't1', eventId: '70', calendarId: '7' }] });
        await app.host.startPush();
        expect(device.state.events.get('70')).toEqual({ calendarId: '7', title: 'Dentist' });
        expect(device.state.calls.filter((call) => call.eventId === '70')).toEqual([]);
        expect(await app.rows()).toEqual([['t1', '501', '500']]);
    });

    it('keeps it when the user had chosen the Mindwtr calendar, whose ID the other calendar took, as the push target', async () => {
        const device = phone([calendar('1'), calendar('7', { title: 'Work', name: 'work@example.com' })], { 70: { calendarId: '7', title: 'Dentist' } });
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7', [KEY.target]: '7' },
            device, rows: [{ taskId: 't1', eventId: '70', calendarId: '7' }] });
        await app.host.startPush();
        expect(device.state.events.get('70')).toEqual({ calendarId: '7', title: 'Dentist' });
        expect(device.state.calls.filter((call) => call.eventId === '70' || (call.op === 'createEvent' && call.calendarId === '7'))).toEqual([]);
    });

    it('gives each task its own event when the new Mindwtr calendar and its events get the old IDs back', async () => {
        const device = phone([calendar('1')]);
        const ids = ['t1', 't2', 't3', 't4', 't5'];
        const app = await upgrade({ tasks: ids.map((id) => task(id)), kv: { [KEY.enabled]: '1', [KEY.calendarId]: '500' }, device,
            rows: [...ids.slice(0, 4).map((id, index) => ({ taskId: id, eventId: String(900 + index), calendarId: '500' })),
                { taskId: 't5', eventId: '501', calendarId: '500' }] });
        await app.host.startPush();
        const rows = await app.rows();
        expect(new Set(rows.map((row) => row[1])).size).toBe(5);
        for (const [taskId, eventId] of rows) expect(device.state.events.get(eventId)?.title).toBe(`PRIVATE ${taskId}`);
    });
});

describe('Settings › Calendar on the Android host', () => {
    const mindwtr = () => calendar('7', { title: 'Mindwtr', name: `mindwtr:${MARKER}`, color: '#3B82F6' });
    const open = async (app: Awaited<ReturnType<typeof upgrade>>) => {
        const opening = app.contract().openCalendarSettings();
        const answer = await opening;
        if (!answer.ok) throw new Error(answer.error.message);
        const view = app.contract().getCalendarSettings();
        if (!view.ok) throw new Error(view.error.message);
        return view.value;
    };
    const send = async (app: Awaited<ReturnType<typeof upgrade>>, edit: unknown, requestId = crypto.randomUUID()) => {
        const answer = await app.contract().setCalendarSetting({ requestId, edit: edit as never });
        await flushPendingSave();
        return answer;
    };

    it('shows RN\'s push card with core\'s text (983b63406)', async () => {
        const app = await upgrade({ tasks: [], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' }, device: phone([mindwtr()]) });
        const view = await open(app);
        expect(view.push).not.toBeNull();
        expect(view.push!.title).toBe('Push tasks to calendar');
        expect(view.push!.target!.delete.description).toStartWith('Remove the dedicated calendar and its pushed events');
    });

    it('a delete the phone refuses keeps the saved ID, the chosen calendar and the rows (0c2782b76)', async () => {
        const device = phone([mindwtr()], { 70: { calendarId: '7', title: 'old' } });
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7', [KEY.target]: '7' }, device,
            rows: [{ taskId: 't1', eventId: '70', calendarId: '7' }] });
        const view = await open(app);
        device.state.refuse.add('deleteCalendar');
        const answer = await send(app, view.push!.target!.delete.edit);
        expect(answer.ok ? null : answer.error.code).toBe('ACTION_FAILED');
        expect(app.kv.get(KEY.calendarId)).toBe('7');
        expect(app.kv.get(KEY.target)).toBe('7');
        expect(await app.rows()).toEqual([['t1', '70', '7']]);
    });

    it('a Delete cut short after the calendar went finishes on its replay (0da428670, ef2c20fc8)', async () => {
        const device = phone([mindwtr()], { 70: { calendarId: '7', title: 'old' } });
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' }, device,
            rows: [{ taskId: 't1', eventId: '70', calendarId: '7' }] });
        const edit = (await open(app)).push!.target!.delete.edit;
        const requestId = crypto.randomUUID();
        const remove = app.kv.delete.bind(app.kv);
        app.kv.delete = (name: string) => { if (name === KEY.calendarId) throw new Error('process died'); return remove(name); };
        expect((await send(app, edit, requestId)).ok).toBe(false);
        app.kv.delete = remove;
        expect(app.kv.get(KEY.calendarId)).toBe('7');
        await open(app);
        expect((await send(app, edit, requestId)).ok).toBe(true);
        expect(app.kv.has(KEY.calendarId)).toBe(false);
        expect(device.state.calendars).toEqual([]);
        expect(await app.rows()).toEqual([]);
    });

    it('deletes only its own calendar, never another install\'s Mindwtr calendar (bca501b1a)', async () => {
        const other = calendar('8', { title: 'Mindwtr', name: 'mindwtr:another-install' });
        const device = phone([mindwtr(), other]);
        const app = await upgrade({ tasks: [], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' }, device });
        expect((await send(app, (await open(app)).push!.target!.delete.edit)).ok).toBe(true);
        expect(device.state.calendars.map((entry) => entry.id)).toEqual(['8']);
    });

    it('a color the phone refuses stores nothing, and the same request retries it (6e1544780); Android recolors by a new calendar (145a8c1c0)', async () => {
        const device = phone([calendar('1'), mindwtr()]);
        const app = await upgrade({ tasks: [task('t1')], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' }, device });
        const pink = (await open(app)).push!.target!.colors!.options.find((option) => option.color === '#DB2777')!.edit;
        const requestId = crypto.randomUUID();
        device.state.refuse.add('deleteCalendar');
        const refused = await send(app, pink, requestId);
        expect(refused.ok ? null : refused.error.code).toBe('ACTION_FAILED');
        expect(app.kv.has(KEY.color)).toBe(false);
        device.state.refuse.delete('deleteCalendar');
        expect((await send(app, pink, requestId)).ok).toBe(true);
        expect(app.kv.get(KEY.color)).toBe('#DB2777');
        expect(device.state.calendars.filter((entry) => entry.title === 'Mindwtr').map((entry) => entry.color)).toEqual(['#DB2777']);
        expect(device.writes()).not.toContain('updateCalendar');
    });

    it('picking the same color again writes nothing (32a65a41d)', async () => {
        const device = phone([mindwtr()]);
        const app = await upgrade({ tasks: [], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7', [KEY.color]: '#3B82F6' }, device });
        const same = (await open(app)).push!.target!.colors!.options.find((option) => option.color === '#3B82F6')!.edit;
        expect((await send(app, same)).ok).toBe(true);
        expect(device.writes()).toEqual([]);
    });

    it('a death after the new calendar has the color, before it is stored: the retry stores it and makes no third calendar (321013824)', async () => {
        const device = phone([calendar('1'), mindwtr()]);
        const app = await upgrade({ tasks: [], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' }, device });
        const pink = (await open(app)).push!.target!.colors!.options.find((option) => option.color === '#DB2777')!.edit;
        const set = app.kv.set.bind(app.kv);
        app.kv.set = (name: string, value: string) => { if (name === KEY.color) throw new Error('process died'); return set(name, value); };
        expect((await send(app, pink)).ok).toBe(false);
        app.kv.set = set;
        await open(app);
        expect((await send(app, pink)).ok).toBe(true);
        expect(app.kv.get(KEY.color)).toBe('#DB2777');
        expect(device.writes().filter((op) => op === 'createCalendar')).toHaveLength(1);
        expect(device.state.calendars.filter((entry) => entry.title === 'Mindwtr')).toHaveLength(1);
    });
});

describe('the push queue', () => {
    it('a full push and a task change at once make one event per task (#743, 7927261f6)', async () => {
        const device = phone([calendar('7', { title: 'Mindwtr', name: `mindwtr:${MARKER}` })]);
        const app = await upgrade({ tasks: [task('t1'), task('t2')], kv: { [KEY.enabled]: '1', [KEY.calendarId]: '7' }, device });
        expect(await app.lifecycle().start()).toBe(true);
        await Promise.all([app.lifecycle().run(), app.lifecycle().run(['t1']), app.lifecycle().run(['t2', 't1'])]);
        app.lifecycle().stop();
        expect(device.writes().filter((op) => op === 'createEvent')).toHaveLength(2);
        expect(device.state.events.size).toBe(2);
    });

    it('React Native\'s push keys appear only in core, so no Android copy of a push rule exists (3390bcb99)', () => {
        const roots = [new URL('./', import.meta.url), new URL('../android/app/src/main/java/tech/dongdongbh/mindwtr/pilot/', import.meta.url)];
        const files = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
            ? files(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)]);
        const holders = roots.flatMap(files).filter((file) => /\.(ts|kt)$/.test(file.pathname) && !/\.test\.ts$/.test(file.pathname))
            .filter((file) => readFileSync(file, 'utf8').includes('mindwtr:calendar-push-sync'));
        expect(holders).toEqual([]);
    });
});

it('the harness store holds the seeded tasks', async () => {
    await upgrade({ tasks: [task('t1')], kv: {}, device: phone([]) });
    expect(useTaskStore.getState()._allTasks.map((entry) => entry.id)).toEqual(['t1']);
});
