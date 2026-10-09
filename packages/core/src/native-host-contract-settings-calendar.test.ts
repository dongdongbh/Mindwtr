import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CALENDAR_PUSH_CREATION_INTENT_KEY, CALENDAR_PUSH_PENDING_KEY } from './calendar-push-service';
import type { DeviceCalendar } from './external-calendar-feeds';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import type { NativeCalendarFeed } from './native-host-contract-calendar';
import { createCalendarSettingsMethods, type NativeCalendarHost, type NativeCalendarSettings, type NativeCalendarSettingsEdit, type NativeCalendarToast } from './native-host-contract-settings-calendar';
import { loadNativeRequestReceipts, NATIVE_UNJOURNALED_COMMANDS, NativeReceiptSqliteAdapter, resetNativeRequestReceipts } from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { SqliteAdapter } from './sqlite-adapter';
import { flushPendingSave, getStorageAdapter, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings, Area } from './types';
import { deterministicHash128Hex, generateUUID } from './uuid';

/**
 * The frozen React Native Calendar settings screen
 * (calendar-settings-parity.fixtures.json, captured by
 * apps/mobile/components/settings/calendar-settings-screen.parity.test.tsx),
 * replayed through the native host contract. The replay plays the native screen:
 * it keeps the screen's own state (the open cards, the open Area choice, the
 * drafts, the confirmation), reads the view, sends each control's edit, and lays
 * the view out in the order React Native draws it. The device is the harness's:
 * the same calendars, feeds, storage and recorded writes.
 */
type Device = {
    os?: 'android' | 'ios';
    language?: string;
    storage?: Record<string, string>;
    permission?: string;
    requestAnswer?: string;
    calendars?: string[];
    failEvents?: boolean;
    picks?: ({ name: string; uri: string } | null)[];
};
type Scenario = { name: string; settings: string; device: Device; actions: [string, ...unknown[]][] };
type Fixture = {
    now: string;
    timeZone: string;
    areas: Area[];
    settings: Record<string, AppSettings>;
    calendars: Record<string, DeviceCalendar>;
    events: Record<string, unknown[]>;
    feeds: Record<string, string>;
    keys: Record<string, string>;
    scenarios: Scenario[];
    observations: Record<string, Record<string, unknown>[]>;
};
type Host = ReturnType<typeof createNativeHostContract>;

const fixture: Fixture = JSON.parse(readFileSync(new URL('./calendar-settings-parity.fixtures.json', import.meta.url), 'utf8'));

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const normalize = (entry: unknown): unknown => JSON.parse(JSON.stringify(entry, (_key, item) => (item === undefined ? '<undefined>' : item)));

// ---------------------------------------------------------------------------
// The store: the fixture's data, with settings writes recorded as the harness records them.

const writes: unknown[][] = [];
let realUpdateSettings: ((...args: unknown[]) => Promise<unknown>) | null = null;

/** Makes the store's saves fail while true. */
let failSaves = false;

async function seed(settings: AppSettings) {
    await flushPendingSave();
    resetForTests();
    realUpdateSettings ??= useTaskStore.getState().updateSettings as never;
    const real = realUpdateSettings!;
    let data = JSON.parse(JSON.stringify({ tasks: [], projects: [], sections: [], areas: fixture.areas, people: [], settings }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            if (failSaves) throw new Error('disk full');
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        updateSettings: real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    useTaskStore.setState({
        updateSettings: async (...args: unknown[]) => {
            writes.push(['updateSettings', ...(normalize(args) as unknown[])]);
            return real(...args);
        },
    } as never);
    writes.length = 0;
}

// ---------------------------------------------------------------------------
// The device: the harness's expo-calendar, AsyncStorage, fetch and picker.

/** The process died before a device write: the write did not happen, and every later one fails too. */
class Death extends Error {}

function phone(device: Device) {
    const life = { step: 0, dieAt: Infinity, died: false, refuse: new Set<string>() };
    const tick = () => {
        life.step += 1;
        if (life.died || life.step === life.dieAt) {
            life.died = true;
            throw new Death(`died before device write ${life.step}`);
        }
    };
    const state = {
        storage: new Map(Object.entries(device.storage ?? {})),
        permission: device.permission ?? 'granted',
        calendars: (device.calendars ?? []).map((key) => ({ ...fixture.calendars[key], source: fixture.calendars[key].source ? { ...fixture.calendars[key].source } : undefined })) as DeviceCalendar[],
        picks: [...(device.picks ?? [])],
        nextCalendar: 0,
        calendarWrites: [] as unknown[][],
        prompts: 0,
    };
    const read = async (url: string) => {
        const feed = fixture.feeds[url];
        if (typeof feed !== 'string') throw new Error(`Unreadable ${url}`);
        return feed;
    };
    const host: NativeCalendarHost = {
        platform: { os: device.os ?? 'android' },
        storage: {
            getItem: async (key) => state.storage.get(key) ?? null,
            setItem: async (key, entry) => { tick(); state.storage.set(key, entry); },
            removeItem: async (key) => { tick(); state.storage.delete(key); },
        },
        fetch: (async (url: string) => {
            const entry = fixture.feeds[String(url)];
            if (entry === undefined) return { ok: false, status: 404, text: async () => '' };
            return { ok: true, status: 200, text: async () => entry };
        }) as unknown as typeof fetch,
        readLocalFile: read,
        calendars: {
            getPermissions: async () => ({ status: state.permission }),
            requestPermissions: async () => {
                state.prompts += 1;
                state.permission = device.requestAnswer ?? 'granted';
                return { status: state.permission };
            },
            getCalendars: async () => state.calendars.map((calendar) => ({ ...calendar })),
            getEvents: async (ids) => {
                if (device.failEvents) throw new Error('Calendar provider unavailable');
                return ids.flatMap((id) => (fixture.events[id] ?? []) as never[]);
            },
            getSources: async () => [],
            createCalendar: async (details) => {
                tick();
                state.nextCalendar += 1;
                const id = `created-${state.nextCalendar}`;
                // The harness records the random install marker in the internal name as <marker>.
                state.calendarWrites.push(['createCalendar', { ...details, ...(typeof details.name === 'string' ? { name: details.name.replace(/[0-9a-f-]{36}$/, '<marker>') } : {}) }]);
                state.calendars.push({ ...(details as DeviceCalendar), id, allowsModifications: true });
                return id;
            },
            updateCalendar: async (id, details) => {
                tick();
                if (life.refuse.has('updateCalendar')) throw new Error('Calendar provider refused');
                state.calendarWrites.push(['updateCalendar', id, details]);
                return id;
            },
            deleteCalendar: async (id) => {
                tick();
                if (life.refuse.has('deleteCalendar')) throw new Error('Calendar provider refused');
                state.calendarWrites.push(['deleteCalendar', id]);
                const index = state.calendars.findIndex((calendar) => calendar.id === id);
                if (index >= 0) state.calendars.splice(index, 1);
            },
            createEvent: async (calendarId, details) => {
                tick();
                state.calendarWrites.push(['createEvent', calendarId, details.title]);
                return 'event-1';
            },
            updateEvent: async (id) => { tick(); state.calendarWrites.push(['updateEvent', id]); },
            deleteEvent: async (id) => { tick(); state.calendarWrites.push(['deleteEvent', id]); },
        },
        syncEntries: {
            ensureReady: async () => undefined,
            get: async () => null,
            upsert: async () => { tick(); },
            delete: async () => { tick(); },
            getAll: async () => [],
        },
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    const snapshot = () => Object.fromEntries(Object.values(fixture.keys).filter((key) => state.storage.has(key)).map((key) => [key, state.storage.get(key)]));
    return { host, state, snapshot, life };
}

async function openHost(host: NativeCalendarHost, language = 'en'): Promise<Host> {
    const contract = createNativeHostContract({ calendar: host });
    value(await contract.setLanguage({ storedLanguage: language, systemLocale: 'en-US' }));
    expect(await contract.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
    return contract;
}

const settle = async () => {
    for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPendingSave();
};

// ---------------------------------------------------------------------------
// The native screen.

type Control = { label: string; selected: boolean | null; disabled: boolean; press: () => Promise<void> };

let feedIds = 0;
const nextFeedId = () => `00000000-0000-4000-8000-${String(++feedIds).padStart(12, '0')}`;

function calendarDriver(contract: Host, device: ReturnType<typeof phone>, opening: NativeCalendarSettings & { toasts: NativeCalendarToast[] }, picks: Device['picks']) {
    const log = { toasts: [] as unknown[][], writes: 0, calendarWrites: 0, prompts: 0 };
    const screen = {
        pushOpen: false,
        deviceOpen: false,
        expanded: null as string | null,
        name: '',
        url: '',
        alert: null as null | { edit: NativeCalendarSettingsEdit; title: string; message: string; cancel: string; confirm: string },
    };
    const pending = [...(picks ?? [])];
    const addToasts = (toasts: NativeCalendarToast[]) => {
        for (const toast of toasts) log.toasts.push([toast.title, toast.message, toast.tone, toast.durationMs]);
    };
    addToasts(opening.toasts);
    let view: NativeCalendarSettings = opening;
    const refresh = () => { view = value(contract.getCalendarSettings({ draft: { name: screen.name, url: screen.url } })); };

    const send = async (edit: NativeCalendarSettingsEdit, requestId = generateUUID()) => {
        const answer = value(await contract.setCalendarSetting({ requestId, edit }));
        addToasts(answer.toasts);
        if (answer.open === 'push') screen.pushOpen = true;
        if (answer.open === 'device') screen.deviceOpen = true;
        if (answer.clearDraft) {
            screen.name = '';
            screen.url = '';
        }
    };
    const run = async (command: Promise<NativeHostResult<{ toasts: NativeCalendarToast[] }>>) => { addToasts(value(await command).toasts); };
    /** A new subscription: its own command, never journaled (its URL may carry a password). */
    const add = async (input: Parameters<Host['addCalendarFeed']>[0]) => {
        const answer = value(await contract.addCalendarFeed(input));
        addToasts(answer.toasts);
        if (answer.clearDraft) {
            screen.name = '';
            screen.url = '';
        }
    };

    /** React Native's layout, from the view and the screen state. */
    const layout = () => {
        const texts: string[] = [view.title];
        const controls: Control[] = [];
        const switches: { value: boolean; flip: () => Promise<void> }[] = [];
        const inputs: [string, string, (text: string) => void][] = [];
        let busy = 0;
        const control = (label: string, selected: boolean | null, disabled: boolean, press: () => Promise<void> | void) => {
            controls.push({ label, selected, disabled, press: async () => { await press(); } });
        };
        const header = (card: { title: string; description: string; enabled: boolean; toggle: NativeCalendarSettingsEdit }, open: boolean, toggleOpen: () => void) => {
            const chevron = open ? '▾' : '▸';
            texts.push(card.title, card.description, chevron);
            control([card.title, card.description, chevron].join('|'), null, false, toggleOpen);
            switches.push({ value: card.enabled, flip: () => send(card.toggle) });
        };
        const areas = (choice: NonNullable<NativeCalendarSettings['feeds']['items'][number]['areas']> | null) => {
            if (!choice) return;
            texts.push(choice.label);
            control(choice.label, null, false, () => { screen.expanded = screen.expanded === choice.key ? null : choice.key; });
            if (screen.expanded !== choice.key) return;
            for (const option of choice.options) {
                texts.push(option.label);
                control(option.label, option.checked, false, () => send(option.edit));
            }
        };

        header(view.push, screen.pushOpen, () => { screen.pushOpen = !screen.pushOpen; });
        if (screen.pushOpen && view.push.denied) texts.push(view.push.denied);
        const target = view.push.target;
        if (screen.pushOpen && target) {
            texts.push(target.title, target.description);
            if (target.localHint) texts.push(target.localHint);
            if (target.sharedAccountHint) texts.push(target.sharedAccountHint);
            if (target.loading) busy += 1;
            else {
                for (const option of target.options) {
                    texts.push(option.name, option.description);
                    control(option.accessibilityLabel, option.selected, false, () => send(option.edit));
                }
            }
            if (target.colors) {
                texts.push(target.colors.title, target.colors.description);
                for (const option of target.colors.options) control(option.accessibilityLabel, option.selected, false, () => send(option.edit));
            }
            texts.push(target.refresh.label, target.refresh.description);
            control(target.refresh.label, null, false, () => run(contract.refreshCalendarPushTargets()));
            texts.push(target.delete.label, target.delete.description);
            if (target.delete.busy) busy += 1;
            control(target.delete.label, null, target.delete.busy, () => {
                screen.alert = { edit: target.delete.edit, ...target.delete.confirm };
            });
        }

        header(view.device, screen.deviceOpen, () => { screen.deviceOpen = !screen.deviceOpen; });
        if (screen.deviceOpen && view.device.enabled) {
            if (view.device.access) {
                texts.push(view.device.access.text, view.device.access.grantLabel);
                control(view.device.access.grantLabel, null, false, () => run(contract.grantDeviceCalendarAccess()));
            } else if (view.device.loading) {
                busy += 1;
            } else if (view.device.empty) {
                texts.push(view.device.empty);
            } else {
                for (const calendar of view.device.calendars) {
                    texts.push(calendar.name, calendar.subtitle);
                    areas(calendar.areas);
                    switches.push({ value: calendar.selected, flip: async () => { if (calendar.edit) await send(calendar.edit); } });
                }
            }
        }

        const feeds = view.feeds;
        texts.push(feeds.title, feeds.description, feeds.guide.title);
        control(`${feeds.guide.title}. ${feeds.guide.description}`, null, false, () => undefined);
        texts.push(feeds.name.label);
        inputs.push([feeds.name.placeholder, screen.name, (text) => { screen.name = text; }]);
        texts.push(feeds.url.label);
        inputs.push([feeds.url.placeholder, screen.url, (text) => { screen.url = text; }]);
        texts.push(feeds.add.label);
        control(feeds.add.label, null, !feeds.add.enabled, () => add({ requestId: nextFeedId(), name: screen.name, url: screen.url, revision: feeds.revision }));
        texts.push(feeds.test.label);
        control(feeds.test.label, null, false, () => run(contract.testCalendarFeeds()));
        texts.push(feeds.chooseFile.label);
        control(feeds.chooseFile.label, null, false, async () => {
            const picked = pending.shift() ?? null;
            if (!picked) return;
            await add({ requestId: nextFeedId(), name: screen.name, fileName: picked.name, uri: picked.uri, revision: feeds.revision });
        });
        if (feeds.listTitle) texts.push(feeds.listTitle);
        for (const item of feeds.items) {
            texts.push(item.name, item.url);
            areas(item.areas);
            for (const color of item.colors) control(color.accessibilityLabel, color.selected, false, async () => { if (color.edit) await send(color.edit); });
            switches.push({ value: item.enabled, flip: () => send(item.toggle) });
            texts.push(item.remove.label);
            control(item.remove.label, null, false, () => send(item.remove.edit));
        }
        return { texts, controls, switches, inputs, busy };
    };

    const matches = (control: Control, label: string) => {
        const text = control.label;
        return text === label || text.split('|')[0] === label || text.startsWith(`${label}: `);
    };

    return {
        observe() {
            const drawn = layout();
            const calendarWrites = device.state.calendarWrites.slice(log.calendarWrites);
            const observation = normalize({
                texts: drawn.texts,
                controls: drawn.controls.map((entry) => [entry.label, entry.selected, entry.disabled]),
                switches: drawn.switches.map((entry) => entry.value),
                inputs: drawn.inputs.map(([placeholder, text]) => [placeholder, text]),
                busy: drawn.busy,
                alert: screen.alert ? [screen.alert.title, screen.alert.message, [[screen.alert.cancel, 'cancel'], [screen.alert.confirm, 'destructive']]] : null,
                storage: device.snapshot(),
                writes: writes.slice(log.writes),
                calendarWrites,
                prompts: device.state.prompts - log.prompts,
                toasts: log.toasts,
            });
            log.writes = writes.length;
            log.calendarWrites = device.state.calendarWrites.length;
            log.prompts = device.state.prompts;
            log.toasts = [];
            return observation;
        },
        async perform(action: [string, ...unknown[]], translate: (key: string) => string) {
            const [kind, target, extra] = action;
            const label = typeof target === 'string'
                ? target.replace(/k:([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g, (_match, key: string) => translate(key))
                : '';
            const drawn = layout();
            switch (kind) {
                case 'press': {
                    const found = drawn.controls.filter((entry) => matches(entry, label))[typeof extra === 'number' ? extra : 0];
                    if (!found) throw new Error(`No control ${label}`);
                    if (!found.disabled) await found.press();
                    break;
                }
                case 'switch':
                    await drawn.switches[target as number].flip();
                    break;
                case 'type':
                    drawn.inputs[target as number][2](extra as string);
                    break;
                case 'alert': {
                    const alert = screen.alert;
                    screen.alert = null;
                    if (alert && label === alert.confirm) await send(alert.edit);
                    break;
                }
                default:
                    throw new Error(`Unknown action ${kind}`);
            }
            await settle();
            refresh();
        },
    };
}

/**
 * A contract over the same store and device, as after a restart: no request receipts in
 * memory, and no screen open (the journal replays a write at boot before any screen).
 */
async function restart(device: ReturnType<typeof phone>, open = false) {
    await flushPendingSave();
    const contract = await openHost(device.host);
    if (open) value(await contract.openCalendarSettings());
    return contract;
}

const KEYS = fixture.keys;
const edit = async (contract: Host, change: NativeCalendarSettingsEdit, requestId = generateUUID()) => {
    const answer = await contract.setCalendarSetting({ requestId, edit: change });
    await settle();
    return answer;
};
/** Everything a replay could touch: the synced settings, the device keys, the device calendars. */
const everything = (device: ReturnType<typeof phone>) => normalize({
    settings: useTaskStore.getState().settings.externalCalendars ?? null,
    storage: device.snapshot(),
    calendars: device.state.calendars.map((calendar) => calendar.id),
    calendarWrites: device.state.calendarWrites.length,
    prompts: device.state.prompts,
});

describe('native host contract: Settings › Calendar', () => {
    const originalTz = process.env.TZ;
    let strings: Record<string, Record<string, string>> = {};
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        strings = { en: await loadTranslations('en'), zh: await loadTranslations('zh') };
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        failSaves = false;
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });
    const freezeClock = () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
    };

    it.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))(
        'replays the frozen React Native scenario through the contract: %s',
        async (name, scenario) => {
            freezeClock();
            feedIds = 0;
            await seed(fixture.settings[scenario.settings]);
            const device = phone(scenario.device);
            const language = scenario.device.language ?? 'en';
            const translate = (key: string) => strings[language]?.[key] || strings.en?.[key] || key;
            const contract = await openHost(device.host, language);
            const opening = value(await contract.openCalendarSettings());
            await settle();
            const driver = calendarDriver(contract, device, opening, scenario.device.picks);
            const observed = [driver.observe()];
            for (const action of scenario.actions) {
                await driver.perform(action, translate);
                observed.push(driver.observe());
            }
            value(contract.closeCalendarSettings());
            expect(observed).toEqual(fixture.observations[name]);
        },
    );
    describe('a replay after a restart writes nothing wrong', () => {
        const boot = async (device: Device, settings: AppSettings = {}) => {
            freezeClock();
            await seed(settings);
            const handset = phone(device);
            const contract = await openHost(handset.host);
            value(await contract.openCalendarSettings());
            return { handset, contract, view: () => value(contract.getCalendarSettings()) };
        };
        const replay = async (handset: ReturnType<typeof phone>, requestId: string, change: NativeCalendarSettingsEdit) => {
            const restarted = await restart(handset, true);
            const before = everything(handset);
            const answer = await edit(restarted, change, requestId);
            return { answer, before, after: everything(handset) };
        };

        it('push on: the replay prompts for nothing and makes no second Mindwtr calendar', async () => {
            const { handset, contract, view } = await boot({ calendars: ['primary'], permission: 'undetermined' });
            const requestId = generateUUID();
            const change = view().push.toggle;
            expect(value(await edit(contract, change, requestId))).toMatchObject({ changed: true, open: 'push' });
            expect(handset.state.calendarWrites).toHaveLength(1);
            const { answer, before, after } = await replay(handset, requestId, change);
            expect(value(answer)).toMatchObject({ changed: false, toasts: [] });
            expect(after).toEqual(before);
        });

        it('push off: the replay writes nothing', async () => {
            const { handset, contract, view } = await boot({ calendars: ['primary'], storage: { [KEYS.pushEnabled]: '1' } });
            const requestId = generateUUID();
            const change = view().push.toggle;
            expect(value(await edit(contract, change, requestId)).changed).toBe(true);
            const { answer, before, after } = await replay(handset, requestId, change);
            expect(value(answer).changed).toBe(false);
            expect(after).toEqual(before);
        });

        it('the push calendar: a replay after a later choice keeps the later choice', async () => {
            const { handset, contract, view } = await boot({ calendars: ['primary', 'phone'], storage: { [KEYS.pushEnabled]: '1' } });
            const pick = (id: string | null) => view().push.target!.options.find((option) => option.key === (id ?? 'mindwtr-managed'))!.edit;
            const requestId = generateUUID();
            const first = pick('g-primary');
            expect(value(await edit(contract, first, requestId)).changed).toBe(true);
            expect(value(await edit(contract, pick('local-phone'))).changed).toBe(true);
            const { answer, before, after } = await replay(handset, requestId, first);
            expect(answer).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(after).toEqual(before);
            expect(handset.state.storage.get(KEYS.pushTarget)).toBe('local-phone');
        });

        it('the Mindwtr calendar color: the replay does not recreate the calendar, and a later color stays', async () => {
            const { handset, contract, view } = await boot({ calendars: ['primary', 'managed'], storage: { [KEYS.pushEnabled]: '1', [KEYS.pushCalendar]: 'g-mindwtr' } });
            const color = (hex: string) => view().push.target!.colors!.options.find((option) => option.color === hex)!.edit;
            const requestId = generateUUID();
            const green = color('#059669');
            expect(value(await edit(contract, green, requestId)).changed).toBe(true);
            expect(handset.state.calendarWrites.map(([name]) => name)).toEqual(['deleteCalendar', 'createCalendar']);
            const { answer, before, after } = await replay(handset, requestId, green);
            expect(value(answer).changed).toBe(false);
            expect(after).toEqual(before);
            const restarted = await restart(handset, true);
            expect(value(await edit(restarted, value(restarted.getCalendarSettings()).push.target!.colors!.options.find((option) => option.color === '#DB2777')!.edit)).changed).toBe(true);
            const again = await replay(handset, requestId, green);
            expect(again.answer).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(again.after).toEqual(again.before);
        });

        it('a color change the device refuses answers ACTION_FAILED and stores nothing; the same request retries it', async () => {
            const { handset, contract, view } = await boot({ calendars: ['primary', 'managed'], storage: { [KEYS.pushEnabled]: '1', [KEYS.pushCalendar]: 'g-mindwtr' } });
            const change = view().push.target!.colors!.options.find((option) => option.color === '#059669')!.edit;
            const requestId = generateUUID();
            handset.life.refuse.add('deleteCalendar');
            expect(await edit(contract, change, requestId)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            expect(handset.snapshot()[KEYS.pushColor]).toBeUndefined();
            expect(handset.state.calendars.map((calendar) => calendar.id)).toEqual(['g-primary', 'g-mindwtr']);
            handset.life.refuse.clear();
            expect(value(await edit(contract, change, requestId)).changed).toBe(true);
            expect(handset.snapshot()[KEYS.pushColor]).toBe('#059669');
        });

        it('Delete Mindwtr calendar: the replay deletes nothing, not even a Mindwtr calendar made since', async () => {
            const { handset, contract, view } = await boot({ calendars: ['primary', 'managed'], storage: { [KEYS.pushEnabled]: '1', [KEYS.pushCalendar]: 'g-mindwtr' } });
            const requestId = generateUUID();
            const change = view().push.target!.delete.edit;
            expect(value(await edit(contract, change, requestId)).changed).toBe(true);
            expect(handset.state.calendars.map((calendar) => calendar.id)).toEqual(['g-primary']);
            const done = await replay(handset, requestId, change);
            expect(value(done.answer).changed).toBe(false);
            expect(done.after).toEqual(done.before);
            // Push on again makes a new Mindwtr calendar; the old request must not delete it.
            const restarted = await restart(handset, true);
            expect(value(await edit(restarted, value(restarted.getCalendarSettings()).push.toggle)).changed).toBe(true);
            expect(handset.state.calendars.map((calendar) => calendar.id)).toEqual(['g-primary', 'created-1']);
            const later = await replay(handset, requestId, change);
            expect(later.answer).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(later.after).toEqual(later.before);
        });

        const lostIOSCreation = async (bound = false) => {
            const { handset, contract, view } = await boot({ os: 'ios', calendars: ['primary', 'managed'] });
            handset.host.calendars.getSources = async () => [{ id: 'local', type: 'local', name: 'Local' }];
            const create = handset.host.calendars.createCalendar!;
            handset.host.calendars.createCalendar = async (details) => {
                await create(details);
                throw new Error('Native create response lost');
            };
            expect(value(await edit(contract, view().push.toggle)).changed).toBe(true);
            let intent = handset.state.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)!;
            expect(JSON.parse(intent)).toEqual({ title: handset.state.calendars.find((calendar) => calendar.id === 'created-1')!.title });
            expect(handset.state.storage.has(KEYS.pushCalendar)).toBe(false);
            expect(handset.state.storage.has(CALENDAR_PUSH_PENDING_KEY)).toBe(false);
            if (bound) {
                intent = JSON.stringify({ ...JSON.parse(intent), calendarId: 'created-1' });
                await handset.host.storage.setItem(CALENDAR_PUSH_CREATION_INTENT_KEY, intent);
                await handset.host.storage.setItem(KEYS.pushCalendar, 'created-1');
            }
            const restarted = await restart(handset, true);
            const change = value(restarted.getCalendarSettings()).push.target!.delete.edit;
            expect(value(await edit(restarted, value(restarted.getCalendarSettings()).push.toggle)).changed).toBe(true);
            expect(handset.state.storage.get(KEYS.pushEnabled)).toBe('0');
            return { handset, contract: restarted, change, intent };
        };

        it('Delete recovers an unbound iOS creation after a lost create response with push off', async () => {
            const { handset, contract, change } = await lostIOSCreation();
            const requestId = generateUUID();
            const info = vi.spyOn(handset.host.log, 'info');
            expect(value(await edit(contract, change, requestId)).changed).toBe(true);
            expect(handset.state.calendarWrites.filter(([name]) => name === 'deleteCalendar')).toEqual([['deleteCalendar', 'created-1']]);
            expect(handset.state.calendars.map((calendar) => calendar.id)).toEqual(['g-primary', 'g-mindwtr']);
            expect(handset.state.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
            expect(info).toHaveBeenCalledWith('Deleted Mindwtr calendar', {
                scope: 'calendar-push', extra: { releaseCheck: 'v1.3.4/calendar-push-owned-only', outcome: 'deleted' },
            });
            expect(info).toHaveBeenCalledWith('Native iOS calendar cleanup completed', {
                scope: 'calendar-settings', extra: { releaseCheck: 'v1.3.5/ios-calendar-cleanup', outcome: 'completed' },
            });
            const replayed = await replay(handset, requestId, change);
            expect(value(replayed.answer).changed).toBe(false);
            expect(replayed.after).toEqual(replayed.before);
        });

        it('a diagnostic failure does not revoke completed iOS cleanup', async () => {
            const { handset, contract, change } = await lostIOSCreation();
            vi.spyOn(handset.host.log, 'info').mockImplementation(async (message) => {
                if (message === 'Native iOS calendar cleanup completed') throw new Error('Log unavailable');
            });
            expect(value(await edit(contract, change)).changed).toBe(true);
            expect(handset.state.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
            expect(handset.state.calendars.map((calendar) => calendar.id)).toEqual(['g-primary', 'g-mindwtr']);
        });

        it.each([false, true])('exact iOS Delete cold replay completes after every cleanup write cut (bound: %s)', async (bound) => {
            for (let cut = 1; cut < 20; cut += 1) {
                const { handset, contract, change } = await lostIOSCreation(bound);
                const requestId = generateUUID();
                const entries = new Map([
                    ['owned', { taskId: 'owned', calendarId: 'created-1', calendarEventId: 'event', platform: 'ios', lastSyncedAt: '' }],
                    ['other', { taskId: 'other', calendarId: 'g-primary', calendarEventId: 'other-event', platform: 'ios', lastSyncedAt: '' }],
                ]);
                const removeEntry = handset.host.syncEntries!.delete;
                handset.host.syncEntries!.getAll = async () => [...entries.values()];
                handset.host.syncEntries!.delete = async (taskId, platform) => {
                    await removeEntry(taskId, platform);
                    entries.delete(taskId);
                };
                handset.state.storage.set(KEYS.pushTarget, 'created-1');
                handset.life.dieAt = handset.life.step + cut;
                await edit(contract, change, requestId).catch(() => undefined);
                const died = handset.life.died;
                handset.life.dieAt = Infinity;
                handset.life.died = false;
                if (died) {
                    const answer = await edit(await restart(handset), change, requestId);
                    expect({ cut, ok: answer.ok }).toEqual({ cut, ok: true });
                }
                expect({ cut, calendars: handset.state.calendars.map((calendar) => calendar.id), entries: [...entries.keys()] })
                    .toEqual({ cut, calendars: ['g-primary', 'g-mindwtr'], entries: ['other'] });
                expect(handset.state.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
                expect(handset.state.storage.has(KEYS.pushTarget)).toBe(false);
                expect(handset.state.calendarWrites.filter(([name]) => name === 'deleteCalendar')).toEqual([['deleteCalendar', 'created-1']]);
                if (!died) return;
            }
            throw new Error('iOS cleanup never completed within the write-cut bound');
        });

        it.each([false, true])('exact iOS Delete cold replay finishes after a lost provider-delete response and failed verification (bound: %s)', async (bound) => {
            const { handset, contract, change, intent } = await lostIOSCreation(bound);
            const requestId = generateUUID();
            const remove = handset.host.calendars.deleteCalendar!;
            const list = handset.host.calendars.getCalendars;
            handset.host.calendars.deleteCalendar = async (id) => {
                await remove(id);
                handset.host.calendars.getCalendars = async () => { throw new Error('Provider temporarily unavailable'); };
                throw new Error('Native delete response lost');
            };
            expect(await edit(contract, change, requestId)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            expect(JSON.parse(handset.state.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)!)).toMatchObject({
                calendarId: 'created-1', deletionRevision: deterministicHash128Hex(intent),
            });
            handset.host.calendars.getCalendars = list;
            expect(value(await edit(await restart(handset), change, requestId)).changed).toBe(true);
            expect(handset.state.calendarWrites.filter(([name]) => name === 'deleteCalendar')).toEqual([['deleteCalendar', 'created-1']]);
            expect(handset.state.calendars.map((calendar) => calendar.id)).toEqual(['g-primary', 'g-mindwtr']);
            expect(handset.state.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
        });

        it('Delete retains bound iOS deletion progress when refused, then retries the same request', async () => {
            const { handset, contract, change, intent } = await lostIOSCreation();
            const requestId = generateUUID();
            handset.life.refuse.add('deleteCalendar');
            expect(await edit(contract, change, requestId)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            expect(JSON.parse(handset.state.storage.get(CALENDAR_PUSH_CREATION_INTENT_KEY)!)).toEqual({
                ...JSON.parse(intent), calendarId: 'created-1', deletionRevision: deterministicHash128Hex(intent),
            });
            expect(handset.state.calendars.map((calendar) => calendar.id)).toEqual(['g-primary', 'g-mindwtr', 'created-1']);
            handset.life.refuse.clear();
            const restarted = await restart(handset);
            expect(value(await edit(restarted, change, requestId)).changed).toBe(true);
            expect(handset.state.calendars.map((calendar) => calendar.id)).toEqual(['g-primary', 'g-mindwtr']);
            expect(handset.state.storage.has(CALENDAR_PUSH_CREATION_INTENT_KEY)).toBe(false);
        });

        it('Delete requires an intent revision for pending iOS cleanup and permits legacy completion once gone', async () => {
            const { handset, contract, change } = await lostIOSCreation();
            const legacy = { type: 'deleteMindwtrCalendar', calendarId: null } as const;
            const before = { storage: Object.fromEntries(handset.state.storage), writes: handset.life.step };
            expect(await edit(contract, legacy)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect({ storage: Object.fromEntries(handset.state.storage), writes: handset.life.step }).toEqual(before);
            expect(value(await edit(contract, change)).changed).toBe(true);
            expect(value(await edit(await restart(handset), legacy)).changed).toBe(false);
        });

        it('Delete rejects malformed intent revisions before device writes', async () => {
            const { handset, contract } = await lostIOSCreation();
            const before = { storage: Object.fromEntries(handset.state.storage), writes: handset.life.step };
            for (const creationIntentRevision of ['a'.repeat(31), 'g'.repeat(32), 42]) {
                expect(await edit(contract, { type: 'deleteMindwtrCalendar', calendarId: null, creationIntentRevision } as never))
                    .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            }
            expect({ storage: Object.fromEntries(handset.state.storage), writes: handset.life.step }).toEqual(before);
        });

        it.each([false, true])('Delete refuses a changed unbound iOS intent before any effects (restart: %s)', async (cold) => {
            const { handset, contract, change } = await lostIOSCreation();
            const title = `Mindwtr (${generateUUID()})`;
            handset.state.storage.set(CALENDAR_PUSH_CREATION_INTENT_KEY, JSON.stringify({ title }));
            handset.state.storage.set(KEYS.pushEnabled, '1');
            handset.state.calendars.push({ id: 'replacement', title, allowsModifications: true });
            const info = vi.spyOn(handset.host.log, 'info');
            const active = cold ? await restart(handset) : contract;
            const before = { state: everything(handset), storage: Object.fromEntries(handset.state.storage), steps: handset.life.step };
            expect(await edit(active, change)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect({ state: everything(handset), storage: Object.fromEntries(handset.state.storage), steps: handset.life.step }).toEqual(before);
            expect(info).not.toHaveBeenCalledWith('Native iOS calendar cleanup completed', expect.anything());
        });

        it('Delete refuses a creation that binds its ID after the contract checks the displayed intent', async () => {
            const { handset, contract, view } = await boot({ os: 'ios', calendars: ['primary', 'managed'] });
            handset.host.calendars.getSources = async () => [{ id: 'local', type: 'local', name: 'Local' }];
            const create = handset.host.calendars.createCalendar!;
            let finishCreate: (() => void) | undefined;
            handset.host.calendars.createCalendar = async (details) => {
                await new Promise<void>((resolve) => { finishCreate = resolve; });
                return create(details);
            };
            value(await edit(contract, view().push.toggle));
            await vi.waitFor(() => expect(finishCreate).toBeTypeOf('function'));
            value(await contract.refreshCalendarPushTargets());
            const change = view().push.target!.delete.edit;
            const setItem = handset.host.storage.setItem;
            const info = vi.spyOn(handset.host.log, 'info');
            let finishDisable: (() => void) | undefined;
            handset.host.storage.setItem = async (key, entry) => {
                if (key === KEYS.pushEnabled && entry === '0') {
                    await new Promise<void>((resolve) => { finishDisable = resolve; });
                }
                await setItem(key, entry);
            };
            const deleting = contract.setCalendarSetting({ requestId: generateUUID(), edit: change });
            await vi.waitFor(() => expect(finishDisable).toBeTypeOf('function'));
            finishCreate!();
            await vi.waitFor(() => expect(handset.state.storage.get(KEYS.pushCalendar)).toBe('created-1'));
            finishDisable!();
            expect(await deleting).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(handset.state.calendars.map((calendar) => calendar.id)).toEqual(['g-primary', 'g-mindwtr', 'created-1']);
            expect(handset.state.calendarWrites.filter(([name]) => name === 'deleteCalendar')).toEqual([]);
            expect(handset.state.storage.get(KEYS.pushCalendar)).toBe('created-1');
            expect(handset.state.storage.get(KEYS.pushEnabled)).toBe('0');
            expect(info).not.toHaveBeenCalledWith('Native iOS calendar cleanup completed', expect.anything());
        });

        it('Delete Mindwtr calendar finishes on a replay after a death between any two of its steps', async () => {
            for (let dieAt = 1; ; dieAt += 1) {
                const { handset, contract, view } = await boot({
                    calendars: ['primary', 'managed'],
                    storage: { [KEYS.pushEnabled]: '1', [KEYS.pushCalendar]: 'g-mindwtr', [KEYS.pushTarget]: 'g-mindwtr' },
                });
                const requestId = generateUUID();
                const change = view().push.target!.delete.edit;
                handset.life.dieAt = dieAt;
                await edit(contract, change, requestId).catch(() => undefined);
                const died = handset.life.died;
                handset.life.dieAt = Infinity;
                handset.life.died = false;
                if (died) {
                    const replayed = await replay(handset, requestId, change);
                    expect({ dieAt, ok: replayed.answer.ok }).toEqual({ dieAt, ok: true });
                }
                expect({ dieAt, calendars: handset.state.calendars.map((calendar) => calendar.id), device: handset.snapshot() })
                    .toEqual({ dieAt, calendars: ['g-primary'], device: { [KEYS.pushEnabled]: '0' } });
                if (!died) break;
            }
        });

        it('the device calendar choices: a replay after a later change keeps it', async () => {
            const { handset, contract, view } = await boot({ calendars: ['primary', 'phone'], storage: { [KEYS.system]: JSON.stringify({ enabled: true }) } });
            const requestId = generateUUID();
            const first = view().device.calendars[0].edit!;
            expect(value(await edit(contract, first, requestId)).changed).toBe(true);
            const replayed = await replay(handset, requestId, first);
            expect(value(replayed.answer).changed).toBe(false);
            expect(replayed.after).toEqual(replayed.before);
            const restarted = await restart(handset, true);
            expect(value(await edit(restarted, value(restarted.getCalendarSettings()).device.toggle)).changed).toBe(true);
            const later = await replay(handset, requestId, first);
            expect(later.answer).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(later.after).toEqual(later.before);
            expect(JSON.parse(handset.state.storage.get(KEYS.system)!).enabled).toBe(false);
        });

        it.each(['url', 'file'] as const)('a new subscription (%s): a retry finds the subscription it made, and never adds one removed since', async (type) => {
            const { handset, contract, view } = await boot({ calendars: [] });
            const requestId = generateUUID();
            const revision = view().feeds.revision;
            const input = type === 'url'
                ? { requestId, name: 'Team', url: 'https://example.com/team.ics', revision }
                : { requestId, name: '', fileName: 'Plan.ics', uri: 'content://downloads/7', revision };
            const addAgain = async () => {
                const restarted = await restart(handset);
                const before = everything(handset);
                const answer = await restarted.addCalendarFeed(input);
                await settle();
                return { answer, before, after: everything(handset) };
            };
            expect(value(await contract.addCalendarFeed(input)).changed).toBe(true);
            const replayed = await addAgain();
            expect(value(replayed.answer)).toMatchObject({ changed: false, clearDraft: true });
            expect(replayed.after).toEqual(replayed.before);
            expect(useTaskStore.getState().settings.externalCalendars).toEqual([
                type === 'url'
                    ? { id: requestId, name: 'Team', url: 'https://example.com/team.ics', enabled: true }
                    : { id: requestId, name: 'Plan', url: 'content://downloads/7', enabled: true },
            ]);
            const restarted = await restart(handset, true);
            expect(value(await edit(restarted, value(restarted.getCalendarSettings()).feeds.items[0].remove.edit)).changed).toBe(true);
            const removed = await addAgain();
            expect(removed.answer).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(removed.after).toEqual(removed.before);
            expect(useTaskStore.getState().settings.externalCalendars).toEqual([]);
        });

        it.each([
            ['enabled', (item: NativeCalendarSettings['feeds']['items'][number]) => item.toggle, (item: NativeCalendarSettings['feeds']['items'][number]) => item.toggle],
            ['color', (item: NativeCalendarSettings['feeds']['items'][number]) => item.colors[2].edit!, (item: NativeCalendarSettings['feeds']['items'][number]) => item.colors[3].edit!],
            ['areaIds', (item: NativeCalendarSettings['feeds']['items'][number]) => item.areas!.options[0].edit, (item: NativeCalendarSettings['feeds']['items'][number]) => item.areas!.options[1].edit],
        ] as const)('a subscription\'s %s: a replay after a later change keeps it', async (_field, first, later) => {
            const { handset, contract, view } = await boot({ calendars: [] }, fixture.settings.synced);
            const requestId = generateUUID();
            const change = first(view().feeds.items[0]);
            expect(value(await edit(contract, change, requestId)).changed).toBe(true);
            const same = await replay(handset, requestId, change);
            expect(value(same.answer).changed).toBe(false);
            expect(same.after).toEqual(same.before);
            const restarted = await restart(handset, true);
            expect(value(await edit(restarted, later(value(restarted.getCalendarSettings()).feeds.items[0]))).changed).toBe(true);
            const stale = await replay(handset, requestId, change);
            expect(stale.answer).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(stale.after).toEqual(stale.before);
        });

        it('removing a subscription: the replay finds it gone, and a stale view removes nothing', async () => {
            const { handset, contract, view } = await boot({ calendars: [] }, fixture.settings.synced);
            const requestId = generateUUID();
            const change = view().feeds.items[0].remove.edit;
            expect(value(await edit(contract, change, requestId)).changed).toBe(true);
            const replayed = await replay(handset, requestId, change);
            expect(value(replayed.answer).changed).toBe(false);
            expect(replayed.after).toEqual(replayed.before);
            expect(useTaskStore.getState().settings.externalCalendars?.map((feed) => feed.id)).toEqual(['feed-b']);
            // A view from before a later edit (here: synced from another device) removes nothing.
            const staleRemove = value(contract.getCalendarSettings()).feeds.items[0].remove.edit;
            await useTaskStore.getState().updateSettings({ externalCalendars: [{ ...fixture.settings.synced.externalCalendars![1], name: 'Renamed' }] });
            expect(await edit(contract, staleRemove)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(useTaskStore.getState().settings.externalCalendars?.map((feed) => feed.name)).toEqual(['Renamed']);
        });

        it('an exact retry after a failed save only saves', async () => {
            freezeClock();
            await seed(fixture.settings.synced);
            const handset = phone({ calendars: [] });
            const contract = await openHost(handset.host);
            value(await contract.openCalendarSettings());
            const change = value(contract.getCalendarSettings()).feeds.items[1].toggle;
            const requestId = generateUUID();
            failSaves = true;
            const first = await contract.setCalendarSetting({ requestId, edit: change });
            failSaves = false;
            expect(first).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
            expect(writes).toHaveLength(1);
            expect(value(await contract.setCalendarSetting({ requestId, edit: change })).changed).toBe(true);
            expect(writes).toHaveLength(1);
            expect(useTaskStore.getState().settings.externalCalendars?.[1].enabled).toBe(true);
        });
    });

    describe('durable receipts', () => {
        afterEach(() => { resetNativeRequestReceipts(); });

        /** The native host over a real SQLite file with its request receipts, booted again by `restart` (process death). */
        async function receiptHost(settings: AppSettings, handset: ReturnType<typeof phone>) {
            const dir = mkdtempSync(join(tmpdir(), 'mindwtr-calendar-receipts-'));
            const { client, close } = openScratchSqlite(join(dir, 'mindwtr.db'));
            await new SqliteAdapter(client).saveData({ tasks: [], projects: [], sections: [], areas: fixture.areas, people: [], settings });
            const boot = async () => {
                resetForTests();
                resetNativeRequestReceipts();
                useTaskStore.setState({
                    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
                    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
                } as never);
                setStorageAdapter(new NativeReceiptSqliteAdapter(client));
                await loadNativeRequestReceipts(client);
                const contract = createNativeHostContract({ calendar: handset.host, replayTokens: 'required' });
                value(await contract.setLanguage({ storedLanguage: 'en', systemLocale: null }));
                value(await contract.activate({ writeSafetyReady: true }));
                return contract;
            };
            return {
                contract: await boot(),
                client,
                restart: async () => { await flushPendingSave(); return boot(); },
                close: () => { close(); rmSync(dir, { recursive: true, force: true }); },
            };
        }

        it('every write keeps a receipt: a replay after process death answers its first reply and writes nothing, even after a later opposite change', async () => {
            freezeClock();
            const handset = phone({
                calendars: ['primary', 'managed', 'phone'],
                storage: { [KEYS.pushEnabled]: '1', [KEYS.pushCalendar]: 'g-mindwtr', [KEYS.system]: JSON.stringify({ enabled: true }) },
            });
            const env = await receiptHost(fixture.settings.synced, handset);
            try {
                const contract = env.contract;
                value(await contract.openCalendarSettings());
                const view = () => value(contract.getCalendarSettings());
                const sent: { requestId: string; edit: NativeCalendarSettingsEdit; answer: unknown }[] = [];
                const send = async (edit: NativeCalendarSettingsEdit) => {
                    const requestId = generateUUID();
                    const answer = value(await contract.setCalendarSetting({ requestId, edit }));
                    await settle();
                    expect(answer.changed).toBe(true);
                    sent.push({ requestId, edit, answer });
                };
                // The switch carries the value it showed (compare-and-set where no receipt answers).
                expect(view().push.toggle).toEqual({ type: 'push', before: true, enabled: false });
                await send(view().push.target!.colors!.options.find((option) => option.color === '#059669')!.edit);
                await send(view().push.target!.options.find((option) => option.key === 'g-primary')!.edit);
                await send(view().device.calendars[0].edit!);
                await send(view().feeds.items[1].toggle);
                await send(view().push.target!.delete.edit);
                // Push off by the delete, then on and off again: a replay of an older toggle must not undo the later one.
                await send(view().push.toggle);
                await send(view().push.toggle);
                const rows = await env.client.all<{ request_id: string }>('SELECT request_id FROM native_request_receipts');
                expect(new Set(rows.map((row) => row.request_id))).toEqual(new Set(sent.map((entry) => entry.requestId)));

                const restarted = await env.restart();
                const before = { device: handset.snapshot(), calendars: handset.state.calendars.map((calendar) => calendar.id), writes: handset.state.calendarWrites.length,
                    settings: useTaskStore.getState().settings.externalCalendars };
                for (const entry of sent) {
                    const replay = value(await restarted.setCalendarSetting({ requestId: entry.requestId, edit: entry.edit }));
                    expect(replay).toEqual({ ...(entry.answer as object), toasts: [] });
                }
                await settle();
                expect({ device: handset.snapshot(), calendars: handset.state.calendars.map((calendar) => calendar.id), writes: handset.state.calendarWrites.length,
                    settings: useTaskStore.getState().settings.externalCalendars }).toEqual(before);
                expect(handset.snapshot()[KEYS.pushEnabled]).toBe('0');
            } finally {
                env.close();
            }
        });

    });

    describe('a subscription URL never reaches the disk', () => {
        afterEach(() => { resetNativeRequestReceipts(); });

        it('addCalendarFeed keeps no durable receipt and no journal entry, and setCalendarSetting takes no URL', async () => {
            freezeClock();
            expect(NATIVE_UNJOURNALED_COMMANDS.has('calendarFeedAdd')).toBe(true);
            const dir = mkdtempSync(join(tmpdir(), 'mindwtr-calendar-receipts-'));
            const { client, close } = openScratchSqlite(join(dir, 'mindwtr.db'));
            try {
                await new SqliteAdapter(client).saveData({ tasks: [], projects: [], sections: [], areas: fixture.areas, people: [], settings: fixture.settings.synced });
                resetForTests();
                useTaskStore.setState({
                    _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
                    settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
                } as never);
                setStorageAdapter(new NativeReceiptSqliteAdapter(client));
                await loadNativeRequestReceipts(client);
                const handset = phone({ calendars: [] });
                const contract = createNativeHostContract({ calendar: handset.host, replayTokens: 'required' });
                value(await contract.setLanguage({ storedLanguage: 'en', systemLocale: null }));
                value(await contract.activate({ writeSafetyReady: true }));
                const view = value(await contract.openCalendarSettings());
                const url = 'https://alex:s3cret@calendar.example.com/private.ics';
                const added = generateUUID();
                expect(value(await contract.addCalendarFeed({ requestId: added, name: 'Private', url, revision: view.feeds.revision })).changed).toBe(true);
                const toggled = generateUUID();
                expect(value(await contract.setCalendarSetting({ requestId: toggled, edit: value(contract.getCalendarSettings()).feeds.items[0].toggle })).changed).toBe(true);
                await flushPendingSave();
                const receipts = await client.all<{ request_id: string; method: string; reply: string }>('SELECT request_id, method, reply FROM native_request_receipts');
                expect(receipts.map((row) => row.request_id)).toEqual([toggled]);
                expect(JSON.stringify(receipts)).not.toContain('s3cret');
                // A URL is no setCalendarSetting edit.
                for (const edit of [
                    { type: 'addFeed', name: 'Private', url, revision: view.feeds.revision },
                    { type: 'addFile', name: '', fileName: 'x.ics', uri: 'content://x', revision: view.feeds.revision },
                ]) {
                    expect(await contract.setCalendarSetting({ requestId: generateUUID(), edit: edit as never })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
                }
            } finally {
                close();
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('passive device enumeration preserves saved choices on failure', () => {
        const selectedCalendarIds = ['é', 'e\u0301', ' opaque /漢+😀 '];
        const stored = { enabled: true, selectAll: false, selectedCalendarIds, areaIdsByCalendar: { 'é': ['a-work'] } };

        it.each([
            ['provider failure', 'en'], ['provider failure', 'zh'],
            ['permission revoked', 'en'], ['permission revoked', 'zh'],
        ])('keeps exact persisted choices after %s and shows the localized failure toast (%s)', async (failure, language) => {
            await seed({});
            const original = JSON.stringify(stored);
            const handset = phone({ storage: { [KEYS.system]: original } });
            const permissions = vi.fn().mockResolvedValue({ status: 'granted' });
            if (failure === 'permission revoked') {
                permissions.mockImplementation(async () => ({ status: permissions.mock.calls.length > 2 ? 'denied' : 'granted' }));
            } else {
                handset.host.calendars.getCalendars = async () => { throw new Error('PRIVATE PROVIDER https://private.example/calendar'); };
            }
            handset.host.calendars.getPermissions = permissions;
            const contract = await openHost(handset.host, language);
            const opening = value(await contract.openCalendarSettings());
            expect(permissions).toHaveBeenCalledTimes(3);
            expect(handset.state.storage.get(KEYS.system)).toBe(original);
            expect(opening.device.toggle.type === 'deviceCalendars' && opening.device.toggle.before.selectedCalendarIds).toEqual(selectedCalendarIds);
            expect(opening.toasts).toContainEqual({
                title: strings[language]['settings.syncMobile.error'],
                message: strings[language]['settings.calendarMobile.failedToLoadDeviceCalendarSettings'],
                tone: 'warning', durationMs: 4200,
            });
            expect(handset.state.prompts).toBe(0);
        });

        it('may prune saved choices after a genuinely empty successful enumeration', async () => {
            await seed({});
            const handset = phone({ storage: { [KEYS.system]: JSON.stringify(stored) } });
            const contract = await openHost(handset.host);
            const opening = value(await contract.openCalendarSettings());
            expect(JSON.parse(handset.state.storage.get(KEYS.system)!)).toEqual({ ...stored, selectedCalendarIds: [] });
            expect(opening.toasts).toEqual([]);
            expect(handset.state.prompts).toBe(0);
        });
    });

    describe('without calendar push bound (until the push pass)', () => {
        it('shows the stored push options and refuses the push commands', async () => {
            freezeClock();
            await seed({});
            const handset = phone({ calendars: ['primary', 'managed'], storage: { [KEYS.pushEnabled]: '1', [KEYS.pushCalendar]: 'g-mindwtr' } });
            const { syncEntries: _entries, ...readOnly } = handset.host;
            const contract = await openHost({ ...readOnly, calendars: { ...handset.host.calendars, createCalendar: undefined } });
            const view = value(await contract.openCalendarSettings());
            expect(view.push.enabled).toBe(true);
            expect(view.push.target?.options.map((option) => option.name)).toEqual(['Mindwtr calendar', 'alex@gmail.com']);
            for (const change of [view.push.target!.colors!.options[1].edit, view.push.target!.delete.edit]) {
                expect(await edit(contract, change)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            }
            // Off needs no calendar writes.
            expect(value(await edit(contract, view.push.toggle)).changed).toBe(true);
            expect(await edit(contract, value(contract.getCalendarSettings()).push.toggle)).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
            expect(handset.state.calendarWrites).toEqual([]);
        });
    });

    describe('Task471 Test-fetch ownership', () => {
        const deferred = <T,>() => {
            let resolve!: (value: T) => void;
            let reject!: (error: Error) => void;
            const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
            return { promise, resolve, reject };
        };
        const setup = async (options: { settings?: AppSettings; device?: Device; language?: 'en' | 'zh' } = {}) => {
            await seed(options.settings ?? { externalCalendars: fixture.settings.synced.externalCalendars });
            const handset = phone({ os: 'ios', permission: 'denied', ...options.device });
            handset.host.repairFeedDeviceCopyOnOpen = false;
            const fetches = vi.fn(handset.host.fetch);
            handset.host.fetch = fetches;
            let currentHost: NativeCalendarHost | null = handset.host;
            let ready = true;
            const language = options.language ?? 'en';
            const contract = createCalendarSettingsMethods({
                readiness: () => ready ? { ok: true, value: null } : { ok: false, error: { code: 'ACTION_FAILED', message: 'Library retired' } },
                save: async () => ({ ok: true, value: null }),
                t: () => (key) => strings[language][key] ?? key, language: () => language,
                requestIdPattern: /^[0-9a-f-]{36}$/, host: () => currentHost,
            });
            value(await contract.openCalendarSettings());
            freezeClock();
            return { handset, contract, fetches, replaceHost: (host: NativeCalendarHost) => { currentHost = host; },
                retire: () => { ready = false; }, restore: () => { ready = true; } };
        };
        const flushMicrotasks = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };
        const warning = () => ({ title: strings.en['settings.syncMobile.error'],
            message: strings.en['settings.calendarMobile.failedToLoadEvents'], tone: 'warning', durationMs: null });
        const success = (count: number) => ({ title: strings.en['common.success'], message: `Loaded ${count} events`, tone: 'success', durationMs: null });

        it('refuses a pre-aborted Test before source, HTTP or provider work', async () => {
            const { handset, contract, fetches } = await setup(), owner = new AbortController();
            const ports = [vi.spyOn(handset.host.storage, 'getItem'), fetches,
                vi.spyOn(handset.host.calendars, 'getPermissions')];
            owner.abort(new Error('PRIVATE caller reason'));
            expect(await contract.testCalendarFeeds({ signal: owner.signal, timeoutMs: 15_000 }))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            for (const port of ports) expect(port).not.toHaveBeenCalled();
            expect(writes).toEqual([]); expect(handset.state.prompts).toBe(0);
        });

        it('starts the logical deadline before a held first source read and observes its late rejection', async () => {
            const { handset, contract } = await setup(), gate = deferred<[string, string | null][]>();
            handset.host.storage.multiGet = () => gate.promise;
            const log = vi.spyOn(handset.host.log, 'error');
            const add = vi.spyOn(AbortSignal.prototype, 'addEventListener'), remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
            let settled = false;
            const pending = contract.testCalendarFeeds({ timeoutMs: 15_000 });
            void pending.then(() => { settled = true; });
            try {
                await vi.advanceTimersByTimeAsync(14_999); expect(settled).toBe(false);
                await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true);
                expect(value(await pending).toasts).toEqual([{
                    title: strings.en['settings.syncMobile.error'], message: strings.en['settings.calendarMobile.failedToLoadEvents'],
                    tone: 'warning', durationMs: null,
                }]);
                expect(vi.getTimerCount()).toBe(0);
                expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
                expect(remove.mock.calls[0]).toEqual(add.mock.calls[0].slice(0, 2));
            } finally {
                gate.reject(new Error('PRIVATE late cell failure'));
                await pending;
            }
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0][0]).not.toEqual(new Error('PRIVATE late cell failure'));
            expect(writes).toEqual([]); expect(handset.state.prompts).toBe(0);
        });

        it('lets caller cancellation win a fired deadline before its warning is published', async () => {
            const { handset, contract } = await setup(), gate = deferred<[string, string | null][]>(), owner = new AbortController();
            handset.host.storage.multiGet = () => gate.promise;
            const error = vi.spyOn(handset.host.log, 'error');
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
            const pending = contract.testCalendarFeeds({ signal: owner.signal, timeoutMs: 15_000 });
            vi.advanceTimersByTime(15_000);
            owner.abort(new Error('Screen retired before publication'));
            expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(error).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
            gate.reject(new Error('PRIVATE late failure')); await flushMicrotasks();
            expect(error).not.toHaveBeenCalled(); expect(writes).toEqual([]);
        });

        it.each([
            ['first source', 'abort'], ['final source', 'abort'], ['permission', 'abort'], ['events', 'abort'], ['HTTP', 'abort'],
            ['first source', 'deadline'], ['final source', 'deadline'], ['permission', 'deadline'], ['events', 'deadline'], ['HTTP', 'deadline'],
        ] as const)('terminalizes %s on %s while observing late rejection and allowing a fresh Test', async (phase, stop) => {
            const provider = phase === 'permission' || phase === 'events';
            const { handset, contract, fetches } = await setup({
                settings: { externalCalendars: provider ? [] : fixture.settings.synced.externalCalendars },
                device: { permission: 'granted', calendars: ['primary'],
                    storage: { [KEYS.system]: JSON.stringify({ enabled: provider }) } },
            });
            const gate = deferred<never>(), entered = deferred<void>(), owner = new AbortController();
            const info = vi.spyOn(handset.host.log, 'info'), error = vi.spyOn(handset.host.log, 'error');
            const oldPermission = handset.host.calendars.getPermissions, oldEvents = handset.host.calendars.getEvents;
            const originalFetch = fetches.getMockImplementation()!;
            let sourceReads = 0;
            handset.host.storage.multiGet = (names) => {
                if ((phase === 'first source' && ++sourceReads === 1) || (phase === 'final source' && ++sourceReads === 2)) {
                    entered.resolve(); return gate.promise;
                }
                return Promise.resolve(names.map((name) => [name, handset.state.storage.get(name) ?? null]));
            };
            if (phase === 'permission') handset.host.calendars.getPermissions = () => { entered.resolve(); return gate.promise; };
            if (phase === 'events') handset.host.calendars.getEvents = () => { entered.resolve(); return gate.promise; };
            if (phase === 'HTTP') fetches.mockImplementation(() => { entered.resolve(); return gate.promise; });
            const add = vi.spyOn(owner.signal, 'addEventListener'), remove = vi.spyOn(owner.signal, 'removeEventListener');
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
            vi.setSystemTime(new Date(fixture.now));
            const beforeSettings = JSON.parse(JSON.stringify(useTaskStore.getState().settings)), beforeDevice = handset.snapshot();
            const pending = contract.testCalendarFeeds({ signal: owner.signal, timeoutMs: 15_000 });
            await entered.promise;
            if (stop === 'abort') owner.abort(new Error('PRIVATE caller cancellation'));
            else await vi.advanceTimersByTimeAsync(15_000);
            if (stop === 'abort') expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            else expect(value(await pending).toasts).toEqual([warning()]);
            expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
            expect(info).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledTimes(stop === 'abort' ? 0 : 1);
            gate.reject(new Error('PRIVATE late rejected read')); await flushMicrotasks();
            expect(info).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledTimes(stop === 'abort' ? 0 : 1);
            expect(vi.getTimerCount()).toBe(0);
            delete handset.host.storage.multiGet;
            handset.host.calendars.getPermissions = oldPermission; handset.host.calendars.getEvents = oldEvents;
            fetches.mockImplementation(originalFetch);
            expect(value(await contract.testCalendarFeeds({ timeoutMs: 15_000 })).toasts).toEqual([success(2)]);
            expect(useTaskStore.getState().settings).toEqual(beforeSettings); expect(handset.snapshot()).toEqual(beforeDevice);
            expect(writes).toEqual([]); expect(handset.life.step).toBe(0); expect(handset.state.prompts).toBe(0);
            expect(handset.state.calendarWrites).toEqual([]);
        });

        it.each(['session', 'host', 'adapter', 'canonical', 'readiness'] as const)('refuses a rejected held read after %s retirement without a late toast or error log', async (kind) => {
            const state = await setup(), { handset, contract } = state;
            const gate = deferred<[string, string | null][]>(), entered = deferred<void>();
            handset.host.storage.multiGet = () => { entered.resolve(); return gate.promise; };
            const info = vi.spyOn(handset.host.log, 'info'), error = vi.spyOn(handset.host.log, 'error');
            const pending = contract.testCalendarFeeds({ timeoutMs: 15_000 }); await entered.promise;
            if (kind === 'session') value(contract.closeCalendarSettings());
            if (kind === 'host') state.replaceHost(phone({ permission: 'denied' }).host);
            if (kind === 'adapter') setStorageAdapter({ ...getStorageAdapter() });
            if (kind === 'canonical') useTaskStore.setState({ settings: { externalCalendars: [] } });
            if (kind === 'readiness') state.retire();
            gate.reject(new Error('PRIVATE retired source error'));
            expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(info).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
            delete handset.host.storage.multiGet; state.restore();
            expect(value(await contract.openCalendarSettings()).toasts).toEqual([]);
            expect(value(await contract.testCalendarFeeds({ timeoutMs: 15_000 })).toasts[0].tone).toBe('success');
            expect(writes).toEqual([]); expect(handset.state.prompts).toBe(0);
        });

        it.each(['fulfill', 'reject'] as const)('drops a %s HTTP result after the Settings visit closes and reopens', async (outcome) => {
            const { handset, contract, fetches } = await setup(), gate = deferred<Response>(), entered = deferred<void>();
            const original = fetches.getMockImplementation()!;
            fetches.mockImplementation(() => { entered.resolve(); return gate.promise; });
            const info = vi.spyOn(handset.host.log, 'info'), error = vi.spyOn(handset.host.log, 'error');
            const old = contract.testCalendarFeeds({ timeoutMs: 15_000 }); await entered.promise;
            value(contract.closeCalendarSettings());
            expect(value(await contract.openCalendarSettings()).toasts).toEqual([]);
            if (outcome === 'fulfill') gate.resolve(new Response(fixture.feeds[fixture.settings.synced.externalCalendars![0].url]));
            else gate.reject(new Error('PRIVATE old HTTP result'));
            expect(await old).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(info).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
            fetches.mockImplementation(original);
            expect(value(await contract.testCalendarFeeds({ timeoutMs: 15_000 })).toasts).toEqual([success(2)]);
            expect(writes).toEqual([]); expect(handset.life.step).toBe(0); expect(handset.state.prompts).toBe(0);
        });

        it.each([
            ['legacy', 'provider failure'], ['system', 'provider failure'],
            ['legacy', 'deadline'], ['system', 'deadline'],
        ] as const)('keeps a generic attempted-Test warning after %s cells change during held %s, without counts or repair', async (kind, stop) => {
            const { handset, contract } = await setup({
                settings: kind === 'legacy' ? {} : { externalCalendars: [] },
                device: { permission: 'granted', calendars: ['primary'], storage: {
                    [KEYS.feeds]: JSON.stringify(fixture.settings.synced.externalCalendars),
                    [KEYS.system]: JSON.stringify({ enabled: true }),
                } },
            });
            const gate = deferred<never>(), entered = deferred<void>();
            const cells = vi.fn((names: string[]) => Promise.resolve(names.map((name) => [name, handset.state.storage.get(name) ?? null] as [string, string | null])));
            handset.host.storage.multiGet = cells;
            handset.host.calendars.getEvents = () => { entered.resolve(); return gate.promise; };
            const info = vi.spyOn(handset.host.log, 'info'), error = vi.spyOn(handset.host.log, 'error');
            vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
            vi.setSystemTime(new Date(fixture.now));
            const beforeSettings = JSON.parse(JSON.stringify(useTaskStore.getState().settings));
            const pending = contract.testCalendarFeeds({ timeoutMs: 15_000 });
            await entered.promise;
            handset.state.storage.set(kind === 'legacy' ? KEYS.feeds : KEYS.system, kind === 'legacy' ? '[]' : JSON.stringify({ enabled: false }));
            const changedDevice = handset.snapshot();
            if (stop === 'provider failure') gate.reject(new Error('Calendar provider unavailable'));
            else await vi.advanceTimersByTimeAsync(15_000);
            expect(value(await pending)).toEqual({ toasts: [warning()] });
            expect(cells).toHaveBeenCalledTimes(1); // A failure warning does not claim a fresh source or start another read.
            expect(info).not.toHaveBeenCalled(); expect(error).toHaveBeenCalledTimes(1);
            if (stop === 'deadline') {
                expect(error.mock.calls[0][0]).toEqual(new Error('External calendar request timed out'));
                gate.reject(new Error('PRIVATE late provider failure'));
                await flushMicrotasks();
                expect(error).toHaveBeenCalledTimes(1);
            }
            expect(vi.getTimerCount()).toBe(0);
            expect(useTaskStore.getState().settings).toEqual(beforeSettings); expect(handset.snapshot()).toEqual(changedDevice);
            expect(writes).toEqual([]); expect(handset.life.step).toBe(0); expect(handset.state.prompts).toBe(0);
            expect(handset.state.calendarWrites).toEqual([]);
        });

        it.each(['legacy', 'system', 'canonical'] as const)('rejects a final captured-source mismatch for %s without publishing or repairing it', async (kind) => {
            const { handset, contract } = await setup({ settings: kind === 'legacy' ? {} : { externalCalendars: fixture.settings.synced.externalCalendars },
                device: { storage: { [KEYS.feeds]: JSON.stringify(fixture.settings.synced.externalCalendars) } } });
            const gate = deferred<[string, string | null][]>(), entered = deferred<void>();
            let reads = 0;
            handset.host.storage.multiGet = (names) => {
                if (++reads === 2) { entered.resolve(); return gate.promise; }
                return Promise.resolve(names.map((name) => [name, handset.state.storage.get(name) ?? null]));
            };
            const info = vi.spyOn(handset.host.log, 'info'), error = vi.spyOn(handset.host.log, 'error');
            const pending = contract.testCalendarFeeds({ timeoutMs: 15_000 }); await entered.promise;
            if (kind === 'legacy') handset.state.storage.set(KEYS.feeds, '[]');
            if (kind === 'system') handset.state.storage.set(KEYS.system, JSON.stringify({ enabled: true }));
            if (kind === 'canonical') useTaskStore.setState({ settings: { externalCalendars: [] } });
            gate.resolve((kind === 'legacy' ? [KEYS.feeds, KEYS.system] : [KEYS.system]).map((name) => [name, handset.state.storage.get(name) ?? null]));
            expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(info).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(writes).toEqual([]); expect(handset.life.step).toBe(0);
        });

        it.each(['canonical', 'legacy', 'empty'] as const)('uses saved %s authority without writes, repair, prompts or the draft URL', async (kind) => {
            const canonical = fixture.settings.synced.externalCalendars!;
            const { handset, contract, fetches } = await setup({ settings: kind === 'legacy' ? {} : { externalCalendars: kind === 'empty' ? [] : canonical },
                device: { storage: { [KEYS.feeds]: JSON.stringify(kind === 'legacy' ? canonical : [{ ...canonical[0], url: 'https://poison.invalid/old.ics' }]) } } });
            const beforeSettings = JSON.parse(JSON.stringify(useTaskStore.getState().settings)), beforeDevice = handset.snapshot();
            value(contract.getCalendarSettings({ draft: { name: 'Unsaved', url: 'https://unsaved.invalid/secret.ics' } }));
            const reads = vi.spyOn(handset.host.storage, 'getItem');
            expect(value(await contract.testCalendarFeeds({ timeoutMs: 15_000 })).toasts).toEqual([success(kind === 'empty' ? 0 : 2)]);
            expect(fetches.mock.calls.map(([url]) => String(url))).toEqual(kind === 'empty' ? [] : [canonical[0].url]);
            expect(reads.mock.calls.map(([name]) => name)).toEqual(kind === 'legacy' ? [KEYS.feeds, KEYS.system, KEYS.feeds, KEYS.system] : [KEYS.system, KEYS.system]);
            expect(useTaskStore.getState().settings).toEqual(beforeSettings); expect(handset.snapshot()).toEqual(beforeDevice);
            expect(writes).toEqual([]); expect(handset.life.step).toBe(0); expect(handset.state.prompts).toBe(0);
        });

        it('refetches on each Test without joining or populating the Calendar slot cache and detaches a successful owner', async () => {
            const { handset, contract, fetches } = await setup(), owner = new AbortController();
            freezeClock();
            const request = { slot: 'calendar' as const, start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z', refresh: true };
            const cached = value(await contract.loadExternalCalendarFeed(request));
            const ics = (count: number) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...Array.from({ length: count }, (_, index) =>
                ['BEGIN:VEVENT', `UID:changed-${index}`, 'DTSTART:20260910T090000Z', 'DURATION:PT1H', `SUMMARY:Changed ${index}`, 'END:VEVENT']).flat(), 'END:VCALENDAR'].join('\r\n');
            fetches.mockImplementation(async () => new Response(ics(1)));
            const remove = vi.spyOn(owner.signal, 'removeEventListener');
            expect(value(await contract.testCalendarFeeds({ signal: owner.signal, timeoutMs: 15_000 })).toasts).toEqual([success(1)]);
            expect(remove).toHaveBeenCalledTimes(1); owner.abort(new Error('A completed Test later retired'));
            fetches.mockImplementation(async () => new Response(ics(3)));
            expect(value(await contract.testCalendarFeeds({ timeoutMs: 15_000 })).toasts).toEqual([success(3)]);
            expect(value(await contract.loadExternalCalendarFeed(request))).toEqual(cached); expect(fetches).toHaveBeenCalledTimes(3);
            expect(writes).toEqual([]); expect(handset.state.prompts).toBe(0);
        });

        it('uses the exact local-month range, saved selection, shared count and a single generic partial warning', async () => {
            const { handset, contract, fetches } = await setup({ device: { permission: 'granted', calendars: ['primary'],
                storage: { [KEYS.system]: JSON.stringify({ enabled: true, selectAll: false, selectedCalendarIds: ['g-primary'] }) } } });
            freezeClock();
            const events = vi.spyOn(handset.host.calendars, 'getEvents');
            expect(value(await contract.testCalendarFeeds({ timeoutMs: 15_000 })).toasts).toEqual([success(4)]);
            expect(events.mock.calls[0][0]).toEqual(['g-primary']);
            expect(events.mock.calls[0][1].toISOString()).toBe('2026-09-01T00:00:00.000Z');
            expect(events.mock.calls[0][2].toISOString()).toBe('2026-09-30T23:59:59.999Z');
            useTaskStore.setState({ settings: { externalCalendars: [...fixture.settings.synced.externalCalendars!, {
                id: 'failed', name: 'Private name', url: 'https://synthetic-person:synthetic-secret@example.invalid/private.ics', enabled: true,
            }] } });
            expect(value(await contract.testCalendarFeeds({ timeoutMs: 15_000 })).toasts).toEqual([warning()]);
            expect(fetches).toHaveBeenCalledTimes(3); expect(writes).toEqual([]); expect(handset.state.prompts).toBe(0);
        });

        it.each(['en', 'zh'] as const)('keeps HTTP200 empty parsing and localized zero-count semantics (%s)', async (language) => {
            const { contract, fetches } = await setup({ language });
            fetches.mockImplementation(async () => new Response('Not a strict ICS document'));
            expect(value(await contract.testCalendarFeeds({ timeoutMs: 15_000 })).toasts).toEqual([{
                title: strings[language]['common.success'], message: language === 'zh' ? '已加载 0 个日程' : 'Loaded 0 events',
                tone: 'success', durationMs: null,
            }]);
            expect(writes).toEqual([]);
        });
    });

    describe('loadExternalCalendarFeed', () => {
        const range = { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' };
        it.each(['en', 'zh'])('retains successful ICS/device events and subscriptions with a failed local feed and localized warning (%s)', async (language) => {
            const feeds = [...fixture.settings.synced.externalCalendars!, {
                id: 'broken-local', name: 'Legacy local file', url: 'file:///private/unavailable.ics', enabled: true,
            }];
            await seed({ externalCalendars: feeds });
            const handset = phone({ calendars: ['primary'], storage: {
                [KEYS.feeds]: JSON.stringify(feeds), [KEYS.system]: JSON.stringify({ enabled: true }),
            } });
            const contract = await openHost(handset.host, language);
            const partial = value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range }));
            expect(partial.status).toBe('ready');
            if (partial.status !== 'ready') throw new Error('not ready');
            expect(partial.warning).toBe(strings[language]['settings.calendarMobile.failedToLoadEvents']);
            expect(partial.events.map((event) => event.title)).toEqual(['Planning', 'Stand-up', 'Review', 'Offsite']);
            for (const sourceId of ['feed-a', 'system:g-primary']) {
                const event = partial.events.find((entry) => entry.sourceId === sourceId)!;
                const projected = value(contract.getCalendarView({
                    state: { viewMode: 'month', selectedDate: event.start.slice(0, 10), visibleMonth: '2026-09-01' },
                    calendar: partial, offset: 0, limit: 100,
                }));
                expect(projected.items.some((entry) => entry.type === 'item' && entry.item.eventId === event.id)).toBe(true);
                expect(projected.content.mode === 'month' && projected.content.details?.events?.error).toBe(partial.warning);
            }
            expect(useTaskStore.getState().settings.externalCalendars).toEqual(feeds);
            expect(JSON.parse(handset.state.storage.get(KEYS.feeds)!)).toEqual(feeds);
        });

        it('answers the merged calendars, joins a load of the same range, and lets a newer range replace a running one', async () => {
            await seed({});
            // The fetch reads the device copy of the subscriptions (sync and the settings screen keep it).
            const handset = phone({ calendars: ['primary'], storage: {
                [KEYS.feeds]: JSON.stringify(fixture.settings.synced.externalCalendars),
                [KEYS.system]: JSON.stringify({ enabled: true }),
            } });
            let fetches = 0;
            let release: (() => void) | null = null;
            const fetchFeed = handset.host.fetch;
            handset.host.fetch = (async (...args: Parameters<typeof fetch>) => {
                fetches += 1;
                if (fetches === 1) {
                    await new Promise<void>((resolve, reject) => {
                        release = resolve;
                        args[1]?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                    });
                }
                return fetchFeed(...args);
            }) as typeof fetch;
            const contract = await openHost(handset.host);
            const first = contract.loadExternalCalendarFeed({ slot: 'calendar', ...range });
            const joined = contract.loadExternalCalendarFeed({ slot: 'calendar', ...range });
            // Source admission is call-owned; identical sources join one inner IO.
            await settle();
            expect(fetches).toBe(1); // One enabled subscription fetched once for both callers.
            const replacing = contract.loadExternalCalendarFeed({ slot: 'calendar', start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' });
            expect(await first).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await joined).toEqual(await first);
            (release as (() => void) | null)?.();
            const later = value(await replacing);
            expect(later.status).toBe('ready');
            const ready = value(await contract.loadExternalCalendarFeed({ slot: 'dailyReview', ...range, timeoutMs: 15_000 }));
            expect(ready).toMatchObject({ status: 'ready' });
            if (ready.status !== 'ready') throw new Error('not ready');
            expect(ready.calendars.map((calendar) => calendar.id)).toEqual(['feed-a', 'feed-b', 'system:g-primary']);
            expect(ready.events.map((event) => event.title)).toEqual(['Planning', 'Stand-up', 'Review', 'Offsite']);
        });

        it('reads canonical subscriptions without repairing an absent or stale device copy, including explicit empty', async () => {
            const canonical = [fixture.settings.synced.externalCalendars![0]];
            for (const stored of [undefined, JSON.stringify([{ id: 'poison', name: 'Poison', url: 'https://poison.invalid/old.ics', enabled: true }])]) {
                await seed({ externalCalendars: canonical });
                const handset = phone({ calendars: [], storage: stored === undefined ? {} : { [KEYS.feeds]: stored } });
                const requested: string[] = [];
                const fetchFeed = handset.host.fetch;
                handset.host.fetch = (async (...args: Parameters<typeof fetch>) => {
                    requested.push(String(args[0])); return fetchFeed(...args);
                }) as typeof fetch;
                const before = handset.snapshot(), contract = await openHost(handset.host);
                const feed = value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }));
                expect.soft(requested).toEqual([canonical[0].url]);
                expect.soft(feed.status === 'ready' ? feed.events.map((event) => event.title) : []).toEqual(['Planning', 'Review']);
                expect(handset.snapshot()).toEqual(before); expect(writes).toEqual([]);
            }
            await seed({ externalCalendars: [] });
            const handset = phone({ calendars: [], storage: { [KEYS.feeds]: JSON.stringify(canonical) } });
            const fetchFeed = vi.spyOn(handset.host, 'fetch'), before = handset.snapshot();
            const contract = await openHost(handset.host);
            expect(value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range }))).toMatchObject({ status: 'ready', events: [] });
            expect(fetchFeed).not.toHaveBeenCalled(); expect(handset.snapshot()).toEqual(before); expect(writes).toEqual([]);
        });

        it('retires a cancelled host load rather than caching its aborted HTTP failures as a partial refresh', async () => {
            await seed({});
            const feeds = [fixture.settings.synced.externalCalendars![0]];
            const handset = phone({ calendars: [], storage: { [KEYS.feeds]: JSON.stringify(feeds) } });
            const fetchFeed = handset.host.fetch;
            let fetches = 0;
            let rejectTransport: ((reason: unknown) => void) | undefined;
            handset.host.fetch = (async (...args: Parameters<typeof fetch>) => {
                fetches += 1;
                if (fetches === 1) {
                    await new Promise<void>((_resolve, reject) => {
                        rejectTransport = reject;
                        args[1]?.signal?.addEventListener('abort', () => reject(args[1]?.signal?.reason), { once: true });
                    });
                }
                return fetchFeed(...args);
            }) as typeof fetch;
            const contract = await openHost(handset.host);
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date(fixture.now));
            const owner = new AbortController();
            const joinedOwner = new AbortController();
            const request = { slot: 'calendar' as const, ...range, refresh: true };
            const pending = contract.loadExternalCalendarFeed(request, owner.signal);
            const joined = contract.loadExternalCalendarFeed(request, joinedOwner.signal);
            await settle();
            expect(fetches).toBe(1);
            joinedOwner.abort(new Error('The Calendar page closed'));
            // Native cancellation also rejects outstanding fetches independently
            // of their signal. This must not become a legitimate partial result.
            rejectTransport?.(Object.assign(new Error('The host operation timed out'), { name: 'AbortError' }));
            const cancelled = await pending;
            expect(await joined).toEqual(cancelled);
            vi.setSystemTime(new Date(Date.parse(fixture.now) + 999));
            const retried = value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }));
            expect.soft(cancelled).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect.soft(fetches).toBe(2);
            expect.soft(retried).toMatchObject({ status: 'ready' });
            if (retried.status !== 'ready') throw new Error('not ready');
            expect.soft(retried.warning).toBeUndefined();
            expect.soft(retried.events.map((event) => event.title)).toEqual(['Planning', 'Review']);
        });

        it('refuses a pre-cancelled host owner without joining or reading any device/network port', async () => {
            await seed({});
            const handset = phone({ calendars: ['primary'], storage: {
                [KEYS.feeds]: JSON.stringify([fixture.settings.synced.externalCalendars![0]]),
                [KEYS.system]: JSON.stringify({ enabled: true }),
            } });
            const reads = [vi.spyOn(handset.host.storage, 'getItem'), vi.spyOn(handset.host, 'fetch'),
                vi.spyOn(handset.host.calendars, 'getPermissions'), vi.spyOn(handset.host.calendars, 'getCalendars'),
                vi.spyOn(handset.host.calendars, 'getEvents')];
            const contract = await openHost(handset.host);
            const owner = new AbortController();
            owner.abort(new Error('Already closed'));
            expect(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }, owner.signal))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            for (const read of reads) expect(read).not.toHaveBeenCalled();
            value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }));
            const counts = reads.map((read) => read.mock.calls.length);
            expect(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }, owner.signal))
                .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(reads.map((read) => read.mock.calls.length)).toEqual(counts);
        });

        it('detaches cancelled old owners so they cannot evict a newer range or its healthy refresh', async () => {
            await seed({});
            const handset = phone({ calendars: [], storage: {
                [KEYS.feeds]: JSON.stringify([fixture.settings.synced.externalCalendars![0]]),
            } });
            const fetchFeed = handset.host.fetch;
            let fetches = 0;
            handset.host.fetch = (async (...args: Parameters<typeof fetch>) => {
                fetches += 1;
                if (fetches === 1) await new Promise<void>((_resolve, reject) => {
                    args[1]?.signal?.addEventListener('abort', () => reject(args[1]?.signal?.reason), { once: true });
                });
                return fetchFeed(...args);
            }) as typeof fetch;
            const contract = await openHost(handset.host);
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date(fixture.now));
            const oldOwner = new AbortController(), joinedOwner = new AbortController(), nextOwner = new AbortController();
            const oldRemoved = vi.spyOn(oldOwner.signal, 'removeEventListener');
            const joinedRemoved = vi.spyOn(joinedOwner.signal, 'removeEventListener');
            const nextRemoved = vi.spyOn(nextOwner.signal, 'removeEventListener');
            const old = contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }, oldOwner.signal);
            const joined = contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }, joinedOwner.signal);
            await settle();
            const next = { slot: 'calendar' as const, start: '2026-09-02T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z', refresh: true };
            const replaced = value(await contract.loadExternalCalendarFeed(next, nextOwner.signal));
            expect(await old).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await joined).toEqual(await old);
            expect(replaced.status).toBe('ready');
            expect(fetches).toBe(2);
            for (const removed of [oldRemoved, joinedRemoved, nextRemoved]) expect(removed).toHaveBeenCalledTimes(1);
            oldOwner.abort(); joinedOwner.abort(); nextOwner.abort();
            expect(value(await contract.loadExternalCalendarFeed(next))).toEqual(replaced);
            expect(fetches).toBe(2);
        });

        it('answers a refresh within a second from the last load, and loads again after it', async () => {
            await seed({});
            const handset = phone({ calendars: [], storage: { [KEYS.feeds]: JSON.stringify(fixture.settings.synced.externalCalendars) } });
            let fetches = 0;
            const fetchFeed = handset.host.fetch;
            handset.host.fetch = (async (...args: Parameters<typeof fetch>) => {
                fetches += 1;
                return fetchFeed(...args);
            }) as typeof fetch;
            const contract = await openHost(handset.host);
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date(fixture.now));
            value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range }));
            value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }));
            expect(fetches).toBe(2);
            vi.setSystemTime(new Date(Date.parse(fixture.now) + 999));
            expect(value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }))).toMatchObject({ status: 'ready' });
            expect(fetches).toBe(2);
            vi.setSystemTime(new Date(Date.parse(fixture.now) + 1_000));
            value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }));
            expect(fetches).toBe(3);
        });

        const deferred = () => {
            let release!: () => void;
            const promise = new Promise<void>((resolve) => { release = resolve; });
            return { promise, release };
        };
        const feedA = () => fixture.settings.synced.externalCalendars![0];
        const feedB = () => ({ ...feedA(), id: 'feed-new', name: 'New source', url: 'https://new.example/calendar.ics' });
        const titles = (feed: NativeCalendarFeed) =>
            feed.status === 'ready' ? feed.events.map((event) => event.title) : [];
        const methods = (host: () => NativeCalendarHost) => createCalendarSettingsMethods({
            readiness: () => ({ ok: true, value: null }), save: async () => ({ ok: true, value: null }),
            t: () => (key) => strings.en[key] ?? key, language: () => 'en',
            requestIdPattern: /^[0-9a-f-]{36}$/, host,
        });
        const observeFetches = (handset: ReturnType<typeof phone>) => {
            const urls: string[] = [];
            const original = handset.host.fetch;
            handset.host.fetch = (async (...args: Parameters<typeof fetch>) => {
                urls.push(String(args[0]));
                if (String(args[0]) === feedB().url) return { ok: true, status: 200, text: async () => fixture.feeds[feedA().url].replaceAll('Planning', 'New Planning') };
                return original(...args);
            }) as typeof fetch;
            return urls;
        };

        it('normalizes canonical metadata and exact identities once without reading the poison device subscriptions', async () => {
            const id = ' e\u0301 /漢+😀 ', areas = ['é', 'e\u0301'];
            const canonical = [{ ...feedA(), id, name: '  Source  ', url: `  ${feedA().url}  `, color: '#2563eb', areaIds: areas },
                { ...feedB(), enabled: false }];
            await seed({ externalCalendars: canonical });
            const handset = phone({ storage: { [KEYS.feeds]: JSON.stringify([feedB()]) } });
            const read = vi.spyOn(handset.host.storage, 'getItem'), urls = observeFetches(handset);
            const contract = await openHost(handset.host);
            const result = value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range }));
            expect(result.status).toBe('ready');
            if (result.status !== 'ready') throw new Error('not ready');
            expect(result.calendars).toEqual([{ id, name: 'Source', color: '#2563EB', areaIds: areas, enabled: true, url: feedA().url },
                { ...feedB(), enabled: false, color: undefined }]);
            expect(titles(result)).toEqual(['Planning', 'Review']);
            expect(result.events.every((event) => event.sourceId === id)).toBe(true);
            expect(urls).toEqual([feedA().url]);
            expect(read.mock.calls.every(([name]) => name === KEYS.system)).toBe(true);
            expect(useTaskStore.getState().settings.externalCalendars).toEqual(canonical);
            expect(writes).toEqual([]); expect(handset.life.step).toBe(0);
        });

        it.each([undefined, null, { invalid: true }])('retains legacy subscriptions for non-array canonical value %j', async (externalCalendars) => {
            await seed({ externalCalendars } as AppSettings);
            const handset = phone({ storage: { [KEYS.feeds]: JSON.stringify([feedA()]) } });
            const urls = observeFetches(handset), contract = await openHost(handset.host);
            expect(titles(value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range })))).toEqual(['Planning', 'Review']);
            expect(urls).toEqual([feedA().url]); expect(writes).toEqual([]); expect(handset.life.step).toBe(0);
        });

        it('refuses invalid canonical normalization without resurrecting a valid device copy', async () => {
            await seed({ externalCalendars: [{ ...feedB(), name: 5 }] } as unknown as AppSettings);
            const handset = phone({ storage: { [KEYS.feeds]: JSON.stringify([feedA()]) } });
            const urls = observeFetches(handset), read = vi.spyOn(handset.host.storage, 'getItem'), contract = await openHost(handset.host);
            expect(value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range }))).toEqual({ status: 'error', message: 'Calendar sources could not be read' });
            expect(urls).toEqual([]); expect(read.mock.calls.every(([name]) => name === KEYS.system)).toBe(true);
            expect(writes).toEqual([]); expect(handset.life.step).toBe(0);
        });

        it('source-read failure is bounded, not cached, and does not start HTTP', async () => {
            await seed({ externalCalendars: [feedA()] });
            const handset = phone({}), urls = observeFetches(handset), contract = await openHost(handset.host);
            const read = vi.spyOn(handset.host.storage, 'getItem').mockRejectedValueOnce(new Error('PRIVATE URL '.repeat(2000)));
            expect(value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }))).toEqual({ status: 'error', message: 'Calendar sources could not be read' });
            expect(urls).toEqual([]); read.mockRestore();
            expect(titles(value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true })))).toEqual(['Planning', 'Review']);
            expect(urls).toEqual([feedA().url]);
        });

        it('a cancelled admission starts no HTTP when its held fixed-cell read returns', async () => {
            await seed({ externalCalendars: [feedA()] });
            const handset = phone({}), gate = deferred(), entered = deferred();
            handset.host.storage.multiGet = async (names) => { entered.release(); await gate.promise; return names.map((name) => [name, null]); };
            const urls = observeFetches(handset), contract = await openHost(handset.host), owner = new AbortController();
            const pending = contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true }, owner.signal);
            await entered.promise; owner.abort(); gate.release();
            expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(urls).toEqual([]);
            delete handset.host.storage.multiGet;
            expect(titles(value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true })))).toEqual(['Planning', 'Review']);
            expect(urls).toEqual([feedA().url]); expect(writes).toEqual([]);
        });

        it('a late legacy A admission cannot install or evict an already accepted B admission', async () => {
            await seed({});
            const handset = phone({ storage: { [KEYS.feeds]: JSON.stringify([feedA()]) } }), gate = deferred(), entered = deferred();
            let reads = 0;
            handset.host.storage.multiGet = async (names) => {
                const rows: [string, string | null][] = names.map((name) => [name, handset.state.storage.get(name) ?? null]);
                if (++reads === 1) { entered.release(); await gate.promise; }
                return rows;
            };
            const urls = observeFetches(handset), contract = await openHost(handset.host); freezeClock();
            const request = { slot: 'calendar' as const, ...range, refresh: true };
            const old = contract.loadExternalCalendarFeed(request); await entered.promise;
            handset.state.storage.set(KEYS.feeds, JSON.stringify([feedB()]));
            const newer = value(await contract.loadExternalCalendarFeed(request));
            expect(titles(newer)).toEqual(['New Planning', 'Review']);
            gate.release(); expect(await old).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            vi.setSystemTime(new Date(Date.parse(fixture.now) + 999));
            expect(value(await contract.loadExternalCalendarFeed(request))).toEqual(newer);
            expect(urls).toEqual([feedB().url]); expect(writes).toEqual([]);
        });

        it('a rejected older legacy admission is stale after newer B succeeds and cannot disturb B reuse', async () => {
            await seed({});
            const handset = phone({ storage: { [KEYS.feeds]: JSON.stringify([feedA()]) } }), gate = deferred(), entered = deferred();
            let reads = 0;
            handset.host.storage.multiGet = async (names) => {
                if (++reads === 1) { entered.release(); await gate.promise; throw new Error('PRIVATE old cell failure'); }
                return names.map((name) => [name, handset.state.storage.get(name) ?? null]);
            };
            const urls = observeFetches(handset), contract = await openHost(handset.host); freezeClock();
            const request = { slot: 'calendar' as const, ...range, refresh: true };
            const old = contract.loadExternalCalendarFeed(request); await entered.promise;
            handset.state.storage.set(KEYS.feeds, JSON.stringify([feedB()]));
            const newer = value(await contract.loadExternalCalendarFeed(request));
            gate.release(); expect(await old).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(value(await contract.loadExternalCalendarFeed(request))).toEqual(newer); expect(urls).toEqual([feedB().url]);
        });

        it('same admitted raw sources share one fetch, generated fallback identity and complete result across outer promises', async () => {
            const canonical = [{ ...feedA(), id: undefined, areaIds: ['é', 'e\u0301'] }];
            await seed({ externalCalendars: canonical } as unknown as AppSettings);
            const handset = phone({}), gate = deferred(), entered = deferred(), original = handset.host.fetch;
            let fetches = 0;
            handset.host.fetch = (async (...args: Parameters<typeof fetch>) => { fetches += 1; entered.release(); await gate.promise; return original(...args); }) as typeof fetch;
            const contract = await openHost(handset.host); freezeClock();
            const request = { slot: 'calendar' as const, ...range, refresh: true };
            const first = contract.loadExternalCalendarFeed(request), joined = contract.loadExternalCalendarFeed(request);
            await entered.promise; await settle(); expect(fetches).toBe(1); gate.release();
            const result = value(await first); expect(value(await joined)).toEqual(result);
            if (result.status !== 'ready') throw new Error('not ready');
            expect(result.calendars[0].id).toMatch(/^[0-9a-f-]{36}$/);
            expect(result.events.every((event) => event.sourceId === result.calendars[0].id)).toBe(true);
            expect(result.calendars[0].areaIds).toEqual(['é', 'e\u0301']);
            expect(value(await contract.loadExternalCalendarFeed(request))).toEqual(result); expect(fetches).toBe(1);
        });

        it('canonical A-to-B-to-empty replaces held or throttled loads without a sync stamp', async () => {
            await seed({ externalCalendars: [feedA()] });
            const handset = phone({}), urls = observeFetches(handset), original = handset.host.fetch, entered = deferred();
            handset.host.fetch = (async (...args: Parameters<typeof fetch>) => {
                if (String(args[0]) === feedA().url) { entered.release(); await new Promise((_resolve, reject) => args[1]?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); }
                return original(...args);
            }) as typeof fetch;
            const contract = await openHost(handset.host); freezeClock();
            const request = { slot: 'calendar' as const, ...range, refresh: true };
            const old = contract.loadExternalCalendarFeed(request); await entered.promise;
            useTaskStore.setState({ settings: { externalCalendars: [feedB()] } });
            expect(titles(value(await contract.loadExternalCalendarFeed(request)))).toEqual(['New Planning', 'Review']);
            expect(await old).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            useTaskStore.setState({ settings: { externalCalendars: [] } });
            expect(value(await contract.loadExternalCalendarFeed(request))).toEqual({ status: 'ready', events: [], calendars: [] });
            expect(urls).toEqual([feedB().url]); expect(writes).toEqual([]);
        });

        it.each(['legacy', 'system', 'nested canonical'])('rejects held IO after a %s source change even without another read', async (kind) => {
            await seed(kind === 'legacy' ? {} : { externalCalendars: [{ ...feedA(), areaIds: ['old-area'] }] });
            const handset = phone({ storage: { [KEYS.feeds]: JSON.stringify([feedA()]) } }), gate = deferred(), entered = deferred();
            const original = handset.host.fetch;
            handset.host.fetch = (async (...args: Parameters<typeof fetch>) => { entered.release(); await gate.promise; return original(...args); }) as typeof fetch;
            const contract = await openHost(handset.host), pending = contract.loadExternalCalendarFeed({ slot: 'calendar', ...range, refresh: true });
            await entered.promise;
            if (kind === 'legacy') handset.state.storage.set(KEYS.feeds, JSON.stringify([feedB()]));
            else if (kind === 'system') handset.state.storage.set(KEYS.system, JSON.stringify({ enabled: true }));
            else useTaskStore.getState().settings.externalCalendars![0].areaIds!.push('new-area');
            gate.release(); expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(writes).toEqual([]); expect(handset.life.step).toBe(0);
        });

        it('retires a stale terminal so A-to-B-to-A before retry fetches again inside the throttle', async () => {
            await seed({ externalCalendars: [feedA()] });
            const handset = phone({}), gate = deferred(), entered = deferred(), original = handset.host.fetch;
            let fetches = 0;
            handset.host.fetch = (async (...args: Parameters<typeof fetch>) => {
                if (++fetches === 1) { entered.release(); await gate.promise; }
                return original(...args);
            }) as typeof fetch;
            const contract = await openHost(handset.host); freezeClock();
            const request = { slot: 'calendar' as const, ...range, refresh: true };
            const old = contract.loadExternalCalendarFeed(request); await entered.promise;
            useTaskStore.setState({ settings: { externalCalendars: [feedB()] } });
            gate.release(); expect(await old).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            useTaskStore.setState({ settings: { externalCalendars: [feedA()] } });
            expect(titles(value(await contract.loadExternalCalendarFeed(request)))).toEqual(['Planning', 'Review']);
            expect(fetches).toBe(2);
        });

        it('rejected held source reads respect newer adapter and Settings session owners', async () => {
            await seed({ externalCalendars: [feedA()] });
            const handset = phone({ permission: 'denied' }), contract = methods(() => handset.host), gate = deferred(), entered = deferred();
            handset.host.storage.multiGet = async () => { entered.release(); await gate.promise; throw new Error('PRIVATE old source failure'); };
            const urls = observeFetches(handset), old = contract.loadExternalCalendarFeed({ slot: 'calendar', ...range });
            await entered.promise; setStorageAdapter({ ...getStorageAdapter() }); delete handset.host.storage.multiGet;
            expect(titles(value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range })))).toEqual(['Planning', 'Review']);
            gate.release(); expect(await old).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } }); expect(urls).toHaveLength(1);
            value(await contract.openCalendarSettings());
            const testGate = deferred(), testEntered = deferred();
            handset.host.storage.multiGet = async () => { testEntered.release(); await testGate.promise; throw new Error('PRIVATE old Test failure'); };
            const oldTest = contract.testCalendarFeeds(); await testEntered.promise;
            value(contract.closeCalendarSettings()); delete handset.host.storage.multiGet;
            const reopened = value(await contract.openCalendarSettings()); expect(reopened.toasts).toEqual([]);
            const errorLog = vi.spyOn(handset.host.log, 'error');
            testGate.release(); expect(await oldTest).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(errorLog).not.toHaveBeenCalled();
        });

        it('system choice changes invalidate healthy reuse, including exact selected IDs and Area associations', async () => {
            await seed({ externalCalendars: [] });
            const handset = phone({ calendars: ['primary', 'phone'], storage: { [KEYS.system]: JSON.stringify({ enabled: false }) } });
            const getEvents = vi.spyOn(handset.host.calendars, 'getEvents'), contract = await openHost(handset.host); freezeClock();
            const request = { slot: 'calendar' as const, ...range, refresh: true };
            expect(titles(value(await contract.loadExternalCalendarFeed(request)))).toEqual([]);
            handset.state.storage.set(KEYS.system, JSON.stringify({ enabled: true, selectAll: false, selectedCalendarIds: ['g-primary'], areaIdsByCalendar: { 'g-primary': ['exact-area'] } }));
            const result = value(await contract.loadExternalCalendarFeed(request));
            expect(titles(result)).toEqual(['Stand-up', 'Offsite']);
            expect(getEvents.mock.calls[0][0]).toEqual(['g-primary']);
            if (result.status !== 'ready') throw new Error('not ready');
            expect(result.calendars.find((calendar) => calendar.id === 'system:g-primary')?.areaIds).toEqual(['exact-area']);
            expect(result.events.every((event) => event.sourceId === 'system:g-primary')).toBe(true);
            handset.state.storage.set(KEYS.system, JSON.stringify({ enabled: false }));
            expect(titles(value(await contract.loadExternalCalendarFeed(request)))).toEqual([]); expect(getEvents).toHaveBeenCalledTimes(1);
        });

        it('actual adapter and host replacements bypass the healthy throttle and retire held admissions', async () => {
            await seed({ externalCalendars: [feedA()] });
            const firstHost = phone({}), secondHost = phone({}); let host = firstHost.host;
            const firstUrls = observeFetches(firstHost), secondUrls = observeFetches(secondHost), contract = methods(() => host); freezeClock();
            const request = { slot: 'calendar' as const, ...range, refresh: true };
            value(await contract.loadExternalCalendarFeed(request));
            setStorageAdapter({ ...getStorageAdapter() });
            value(await contract.loadExternalCalendarFeed(request)); expect(firstUrls).toHaveLength(2);
            host = secondHost.host;
            value(await contract.loadExternalCalendarFeed(request)); expect(secondUrls).toHaveLength(1);
            const gate = deferred(), entered = deferred();
            host.storage.multiGet = async (names) => { entered.release(); await gate.promise; return names.map((name) => [name, null]); };
            const old = contract.loadExternalCalendarFeed(request); await entered.promise;
            setStorageAdapter({ ...getStorageAdapter() }); delete host.storage.multiGet;
            value(await contract.loadExternalCalendarFeed(request)); gate.release();
            expect(await old).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(secondUrls).toHaveLength(2); expect(writes).toEqual([]);
        });

        it.each([{ canonical: [feedA()] }, { canonical: [] }])('native passive Settings does not repair its copy and Test uses canonical sources $canonical', async ({ canonical }) => {
            await seed({ externalCalendars: canonical });
            const handset = phone({ os: 'ios', permission: 'denied', storage: { [KEYS.feeds]: JSON.stringify([feedB()]) } });
            handset.host.repairFeedDeviceCopyOnOpen = false;
            const urls = observeFetches(handset), before = handset.snapshot(), logs = vi.spyOn(handset.host.log, 'info'), contract = await openHost(handset.host);
            const shown = value(await contract.openCalendarSettings());
            expect(shown.feeds.items.map((item) => item.name)).toEqual(canonical.map((feed) => feed.name));
            value(await contract.testCalendarFeeds());
            expect(urls).toEqual(canonical.map((feed) => feed.url));
            expect(handset.snapshot()).toEqual(before); expect(handset.life.step).toBe(0); expect(writes).toEqual([]); expect(handset.state.prompts).toBe(0);
            expect(logs.mock.calls).toEqual([['Native iOS calendar source selected', { scope: 'calendar', extra: { releaseCheck: 'v1.3.5/ios-calendar-source', outcome: 'canonical' } }]]);
        });

        it('shared sandbox source admission touches no storage, HTTP, provider or log port', async () => {
            vi.resetModules();
            const sandbox = await import('./sandbox');
            const module = await import('./native-host-contract-settings-calendar');
            sandbox.initializeSandboxRuntime(true);
            const handset = phone({}), contract = module.createCalendarSettingsMethods({
                readiness: () => ({ ok: true, value: null }), save: async () => ({ ok: true, value: null }),
                t: () => (key) => key, language: () => 'en', requestIdPattern: /^[0-9a-f-]{36}$/, host: () => handset.host,
            });
            const reads = [vi.spyOn(handset.host.storage, 'getItem'), vi.spyOn(handset.host, 'fetch'), vi.spyOn(handset.host.calendars, 'getPermissions'),
                vi.spyOn(handset.host.calendars, 'getCalendars'), vi.spyOn(handset.host.calendars, 'getEvents'), vi.spyOn(handset.host.log, 'info')];
            try { expect(value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range }))).toEqual({ status: 'ready', calendars: [], events: [] }); }
            finally { vi.resetModules(); }
            for (const read of reads) expect(read).not.toHaveBeenCalled();
        });

        it('answers an error feed when the device calendars fail, and refuses bad input', async () => {
            await seed({});
            const handset = phone({ calendars: ['primary'], failEvents: true, storage: { [KEYS.system]: JSON.stringify({ enabled: true }) } });
            const contract = await openHost(handset.host);
            expect(value(await contract.loadExternalCalendarFeed({ slot: 'weeklyReview', ...range }))).toEqual({ status: 'error', message: 'Calendar provider unavailable' });
            expect(await contract.loadExternalCalendarFeed({ slot: 'calendar', start: range.end, end: range.start })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await contract.loadExternalCalendarFeed({ slot: 'other' as never, ...range })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        });

        it('keeps an oversized provider error inside the existing feed message bound without truncating it', async () => {
            await seed({ externalCalendars: [] });
            const handset = phone({ calendars: ['primary'], storage: { [KEYS.system]: JSON.stringify({ enabled: true }) } });
            handset.host.calendars.getEvents = async () => { throw new Error('PRIVATE CONTENT '.repeat(2000)); };
            const contract = await openHost(handset.host);
            expect(value(await contract.loadExternalCalendarFeed({ slot: 'calendar', ...range })))
                .toEqual({ status: 'error', message: 'Calendar events could not be read' });
            expect(writes).toEqual([]); expect(handset.life.step).toBe(0);
        });
    });
});
