import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildGeneralSettingsModel, resolveGeneralThemeMode, type GeneralSettingsEdit } from './general-settings-model';
import { getSystemWeekStart, createDateFormatter } from './date';
import { loadTranslations } from './i18n/i18n-loader';
import { getTranslator } from './i18n';
import { buildManagePersonRow, isManageAreaNameTaken, isManageEditorSaveDisabled, sortManageAreas, sortManagePeople } from './manage-settings-model';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { paramsKey } from './native-host-contract-menu-views';
import type { NativeManageDeleteTarget, NativeManageEditorTarget, NativeManageSettings } from './native-host-contract-settings';
import { revisionOf } from './native-request-receipts';
import { getPersonTaskCounts } from './people';
import { replayAfterRestart } from './screen-parity.replay';
import { buildSettingsAdvancedMenu, buildSettingsMenu, getSettingsSyncBadge } from './settings-menu-model';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import type { AppSettings, Area, Person, Project, Task } from './types';
import { generateUUID } from './uuid';
import { getSavedTaxonomyTokens } from './taxonomy-catalog';

/**
 * The frozen React Native Settings screens (settings-screens-parity.fixtures.json,
 * captured by apps/mobile/components/settings/settings.parity.test.tsx), replayed
 * through the native host contract. The replay plays the native screen: it keeps
 * the screen's own state (search text, open picker, editor fields, pending
 * confirmation), reads the views, sends the commands, stores what the contract
 * says to store on the device, and lays the text out in the order React Native
 * draws it.
 */
type Device = {
    language?: string;
    systemLocale?: string;
    themeMode?: string;
    storage?: Record<string, string>;
    appSearch?: { supported: boolean; enabled: boolean };
    authOutcomes?: string[];
    params?: Record<string, string>;
};
type Scenario = {
    name: string;
    data: string;
    settings: string;
    device: Device;
    syncBadge?: 'hidden' | 'syncing' | 'healthy' | 'attention';
    actions: [string, ...unknown[]][];
};
type Fixture = {
    now: string;
    timeZone: string;
    data: Record<string, { tasks: Task[]; projects: Project[]; areas: Area[]; people: Person[] }>;
    settings: Record<string, AppSettings>;
    menu: Scenario[];
    general: Scenario[];
    manage: Scenario[];
    observations: Record<string, Record<string, unknown>[]>;
};
type Host = ReturnType<typeof createNativeHostContract>;

const fixture: Fixture = JSON.parse(readFileSync(new URL('./settings-screens-parity.fixtures.json', import.meta.url), 'utf8'));
const OPEN_SECTIONS_KEY = 'mindwtr:settings:manage:openSections';

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const normalize = (entry: unknown): unknown => JSON.parse(JSON.stringify(entry, (_key, item) => (item === undefined ? '<undefined>' : item)));

// ---------------------------------------------------------------------------
// The store: the fixture's data, with the writes recorded as the harness records them.

const RECORDED = [
    'updateSettings', 'addArea', 'updateArea', 'deleteArea', 'addPerson', 'updatePerson', 'renamePerson', 'deletePerson',
    'addContext', 'addTag', 'renameContext', 'deleteContext', 'renameTag', 'deleteTag',
] as const;
const writes: unknown[][] = [];
let realActions: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null;
/**
 * The host names a new area or person by its request UUID, so a replay finds it; React
 * Native lets the store name it. The record leaves that ID out.
 */
const recorded = (name: string, args: unknown[]): unknown[] => {
    const props = args[1] as Record<string, unknown> | undefined;
    if ((name !== 'addArea' && name !== 'addPerson') || !props || !('id' in props)) return args;
    const { id: _id, ...rest } = props;
    return [args[0], Object.keys(rest).length > 0 ? rest : undefined, ...args.slice(2)];
};

async function seed(scenario: Pick<Scenario, 'data' | 'settings'>, saveData?: (data: unknown) => Promise<void>) {
    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    realActions ??= Object.fromEntries(RECORDED.map((name) => [name, initial[name]]));
    const real = realActions;
    let data = JSON.parse(JSON.stringify({ ...fixture.data[scenario.data], sections: [], settings: fixture.settings[scenario.settings] }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            await saveData?.(next);
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        ...(real as object),
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    useTaskStore.setState(Object.fromEntries(RECORDED.map((name) => [name, async (...args: unknown[]) => {
        writes.push([name, ...(normalize(recorded(name, args)) as unknown[])]);
        return real[name](...args);
    }])) as never);
    writes.length = 0;
}

async function openHost(device: Device = {}): Promise<Host> {
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: device.language ?? 'en', systemLocale: device.systemLocale ?? 'en-US' }));
    expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
    return host;
}

// ---------------------------------------------------------------------------
// The native screens.

type Log = { device: unknown[][]; alerts: unknown[][]; navigations: unknown[]; links: string[]; writes: number };

function createLog() {
    const log: Log = { device: [], alerts: [], navigations: [], links: [], writes: 0 };
    const drain = () => {
        const out = {
            writes: writes.slice(log.writes),
            device: log.device,
            alerts: log.alerts,
            navigations: log.navigations,
            links: log.links,
        };
        log.writes = writes.length;
        log.device = [];
        log.alerts = [];
        log.navigations = [];
        log.links = [];
        return out;
    };
    return { log, drain };
}

function menuDriver(host: Host, scenario: Scenario) {
    const { log, drain } = createLog();
    let query = '';
    const screen = scenario.device.params?.settingsScreen ?? 'main';
    const read = () => value(host.getSettingsMenu({
        query,
        syncBadge: scenario.syncBadge,
        updateAvailable: scenario.device.storage?.['mindwtr-update-available'] === 'true',
    }));
    const rowParts = (row: { title: string; description?: string; icon: string; showIndicator?: boolean; indicatorColor?: string; accessibilityLabel: string }) => (
        [row.title, row.description ?? null, row.icon, row.showIndicator === true, row.indicatorColor ?? null, row.accessibilityLabel]
    );
    return {
        observe() {
            const menu = read();
            const rows = screen === 'advanced' ? [menu.advanced.rows] : menu.groups;
            const { writes: _writes, ...rest } = drain();
            return normalize({
                texts: [
                    screen === 'advanced' ? menu.advanced.title : menu.title,
                    ...rows.flat().flatMap((row) => [row.title, ...(row.description ? [row.description] : [])]),
                    ...(screen !== 'advanced' && menu.noMatches ? [menu.noMatches] : []),
                ],
                search: screen === 'advanced' ? null : [menu.searchPlaceholder, query],
                groups: rows.map((group) => group.map(rowParts)),
                ...rest,
            });
        },
        async perform([kind, target]: [string, ...unknown[]]) {
            if (kind === 'search') query = target as string;
            else if (kind === 'tap') log.navigations.push({ pathname: '/settings', params: { settingsScreen: target } });
            else throw new Error(`Unknown menu action ${kind}`);
        },
    };
}

const THEME_STYLE = (theme: string) => (theme === 'material3-light' || theme === 'material3-dark' ? 'material3' : 'default');

function generalDriver(host: Host, scenario: Scenario) {
    const { log, drain } = createLog();
    const device = scenario.device;
    let deviceTheme = device.themeMode ?? null;
    let appSearch = device.appSearch ?? { supported: false, enabled: false };
    const outcomes = [...(device.authOutcomes ?? [])];
    let expanded = false;
    let picker: string | null = null;
    let appLockError: 'unavailable' | 'cancelled' | 'failed' | null = null;
    const read = () => value(host.getGeneralSettings({ deviceTheme, appSearch }));
    const pickerOf = (model: ReturnType<typeof read>, control: string) => {
        if (control === 'theme') return { title: model.appearance.theme.pickerTitle, groups: model.appearance.theme.groups };
        const controls = {
            quickAccess: model.appearance.quickAccess,
            appLockRelock: model.privacy.appLockRelockDelay!,
            language: model.language,
            weekStart: model.regional.weekStart,
            dateFormat: model.regional.dateFormat,
            calendarSystem: model.regional.calendarSystem!,
            timeFormat: model.regional.timeFormat,
        } as Record<string, { pickerTitle: string; options: { label: string; selected: boolean; edit: GeneralSettingsEdit }[] }>;
        return { title: controls[control].pickerTitle, groups: [controls[control].options] };
    };
    /** Sends an edit and stores what the contract says to store on the device. */
    const send = async (edit: GeneralSettingsEdit) => {
        const result = value(await host.setGeneralSetting({ requestId: generateUUID(), edit }));
        for (const write of result.deviceWrites) {
            if (write.key === '@mindwtr_theme') {
                log.device.push(['setThemeMode', write.value]);
                deviceTheme = write.value;
            } else if (write.key === '@mindwtr_theme_style') {
                expect(write.value).toBe(THEME_STYLE(deviceTheme!));
            } else if (write.key === 'mindwtr-language') {
                log.device.push(['setLanguage', write.value]);
                value(await host.setLanguage({ storedLanguage: write.value, systemLocale: device.systemLocale ?? 'en-US' }));
            } else if (write.key === 'mindwtr:appSearchWipeOwed') {
                // RN's writeAppSearchIndexingEnabled(false) stores it first, inside the same call (pass O2c).
                expect(write.value).toBe('true');
            } else if (write.key === 'mindwtr:appSearchIndexingEnabled') {
                const enabled = write.value === 'true';
                log.device.push(['writeAppSearchIndexingEnabled', enabled]);
                // Platform wiring: index when turned on, wipe when turned off.
                log.device.push([enabled ? 'enableAppSearchIndexing' : 'wipeAppSearchIndex']);
                appSearch = { ...appSearch, enabled };
            } else {
                throw new Error(`Unexpected device write ${write.key}`);
            }
        }
        return result;
    };
    return {
        observe() {
            const model = read();
            const { appearance, privacy, language, regional } = model;
            const rows = (...pickers: ({ label: string; value: string } | null)[]) => pickers.flatMap((entry) => (entry ? [entry.label, entry.value] : []));
            return normalize({
                texts: [
                    model.title,
                    appearance.title, ...rows(appearance.theme),
                    appearance.showTaskAge.label, appearance.showTaskAge.description,
                    ...rows(appearance.quickAccess),
                    privacy.title, privacy.appLock.label, privacy.appLock.description,
                    ...(appLockError ? [privacy.appLock.errors[appLockError]] : []),
                    ...rows(privacy.appLockRelockDelay),
                    ...(privacy.appSearch ? [privacy.appSearch.label, privacy.appSearch.description] : []),
                    language.title, language.description, ...rows(language),
                    regional.label, regional.summary,
                    ...(expanded ? rows(regional.weekStart, regional.dateFormat, regional.calendarSystem, regional.timeFormat) : []),
                ],
                switches: [
                    [appearance.showTaskAge.value, false],
                    [privacy.appLock.value, false],
                    ...(privacy.appSearch ? [[privacy.appSearch.value, false]] : []),
                ],
                expanded,
                picker: picker ? (() => {
                    const open = pickerOf(model, picker);
                    return {
                        title: open.title,
                        groups: open.groups.map((group) => group.map((option) => [option.label, option.selected, 'icon' in option ? option.icon : null])),
                    };
                })() : null,
                ...drain(),
            });
        },
        async perform([kind, target]: [string, ...unknown[]]) {
            const model = read();
            switch (kind) {
                case 'regional':
                    expanded = !expanded;
                    return;
                case 'open':
                    picker = target as string;
                    return;
                case 'dismiss':
                    picker = null;
                    return;
                case 'pick': {
                    const option = pickerOf(model, picker!).groups.flat()[target as number];
                    const before = writes.length;
                    const result = await send(option.edit);
                    // Re-picking the stored value writes nothing, on React Native and here.
                    expect(result.changed).toBe(writes.length > before);
                    picker = null;
                    return;
                }
                case 'toggle': {
                    if (target === 'showTaskAge') {
                        await send(model.appearance.showTaskAge.edit);
                    } else if (target === 'appSearch') {
                        await send(model.privacy.appSearch!.edit);
                    } else if (target === 'appLock') {
                        appLockError = null;
                        const edit = model.privacy.appLock.edit;
                        if (edit.value === true) {
                            // The host asks the device lock first; only a success sends the edit.
                            log.device.push(['authenticate', model.privacy.appLock.enablePrompt]);
                            const outcome = outcomes.shift();
                            if (outcome === 'success') await send(edit);
                            else appLockError = outcome === 'throw' ? 'failed' : outcome as 'cancelled' | 'unavailable';
                        } else {
                            await send(edit);
                        }
                    }
                    return;
                }
                default:
                    throw new Error(`Unknown General action ${kind}`);
            }
        },
    };
}

type EditorState = { type: string; target: NativeManageEditorTarget; draft: { name: string; color: string; note: string; referenceLink: string } };
type Confirm = { title: string; message: string; cancelLabel: string; confirmLabel: string };

function manageDriver(host: Host, scenario: Scenario) {
    const { log, drain } = createLog();
    let raw = scenario.device.storage?.[OPEN_SECTIONS_KEY] ?? null;
    let editor: EditorState | null = null;
    let renaming: { id: string; title: string } | null = null;
    let pending: { confirm: Confirm; run: () => Promise<unknown> } | null = null;
    let restored = false;
    const strings = value(host.getStrings({ keys: ['common.back', 'common.edit', 'common.delete'] })).strings;
    const back = strings['common.back'];
    // A row's pencil and trash name the item they act on, as React Native's do.
    const named = (key: 'common.edit' | 'common.delete', name: string): unknown[] => [`${strings[key]}: ${name}`, false];
    const rowButtons = (name: string) => [named('common.edit', name), named('common.delete', name)];
    const read = (): NativeManageSettings => {
        const view = value(host.getManageSettings({ openSections: raw }));
        if (!restored) {
            restored = true;
            // React Native writes a stored value back, normalized, when the screen opens.
            if (view.openSectionsRestore) {
                log.device.push(['setItem', view.openSectionsRestore.key, view.openSectionsRestore.value]);
                raw = view.openSectionsRestore.value;
            }
        }
        return view;
    };
    const someday = () => value(host.getSomedaySections());
    const ask = (confirm: Confirm, run: () => Promise<unknown>) => {
        log.alerts.push([confirm.title, confirm.message, [[confirm.cancelLabel, 'cancel'], [confirm.confirmLabel, 'destructive']]]);
        pending = { confirm, run };
    };
    const openEditor = (type: string, edit: { target: NativeManageEditorTarget; draft: EditorState['draft'] }) => {
        editor = { type, target: edit.target, draft: { ...edit.draft } };
    };
    return {
        observe() {
            const view = read();
            const sections = someday();
            const texts: string[] = [view.title];
            const labels: unknown[][] = [[back, false]];
            for (const section of view.sections) {
                texts.push(section.title, String(section.count));
                if (!section.open) continue;
                if (section.key === 'areas') {
                    const { unassigned, rows, empty, newArea } = view.areas;
                    texts.push(unassigned.label, unassigned.description, ...(empty ? [empty] : []), ...rows.items.map((row) => row.name), newArea.label, newArea.hint, newArea.addLabel);
                    labels.push(named('common.edit', unassigned.label), ...rows.items.flatMap((row) => rowButtons(row.name)), [newArea.label, false]);
                } else if (section.key === 'somedaySections') {
                    if (view.somedaySections.emptyHint) texts.push(view.somedaySections.emptyHint);
                    for (const row of sections.rows) {
                        if (renaming?.id !== row.id) texts.push(row.title);
                        labels.push([row.moveUp.label, row.moveUp.disabled], [row.moveDown.label, row.moveDown.disabled]);
                        labels.push([renaming?.id === row.id ? sections.text.saveLabel : row.renameLabel, false], [row.deleteLabel, false]);
                    }
                } else if (section.key === 'people') {
                    const { rows, empty, newPerson, text } = view.people;
                    if (empty) texts.push(empty);
                    for (const row of rows.items) {
                        texts.push(row.initial, row.name, ...(row.detail ? [row.detail] : []), row.countLabel);
                        labels.push([row.countAccessibilityLabel, false], ...(row.referenceLink ? [[text.openReference, false]] : []), [text.editLabel, false], [text.deleteLabel, false]);
                    }
                    texts.push(newPerson.label, newPerson.hint, newPerson.addLabel);
                    labels.push([newPerson.label, false]);
                } else {
                    const list = view[section.key];
                    texts.push(...(list.empty ? [list.empty] : list.rows.items.map((row) => row.value)));
                    labels.push(...list.rows.items.flatMap((row) => rowButtons(row.value)));
                    texts.push(list.create.label, list.create.addLabel);
                    labels.push([list.create.label, false]);
                }
            }
            let editorView: unknown = null;
            if (editor) {
                const text = view.editor.text[editor.type as keyof NativeManageSettings['editor']['text']];
                const nameTestId = editor.type === 'newArea' ? 'manage-area-name-input'
                    : editor.type === 'newPerson' || editor.type === 'person' ? 'manage-person-name-input'
                        : editor.type === 'newContext' || editor.type === 'newTag' ? 'manage-token-name-input' : null;
                editorView = {
                    title: text.title,
                    inputs: [
                        ...(text.namePlaceholder !== null ? [[nameTestId, text.namePlaceholder, editor.draft.name]] : []),
                        ...(text.personFields ? [
                            ['manage-person-note-input', text.personFields.notePlaceholder, editor.draft.note],
                            ['manage-person-reference-input', text.personFields.referencePlaceholder, editor.draft.referenceLink],
                        ] : []),
                    ],
                    colors: text.changeColor ? view.editor.colors.map((entry) => [entry.color, entry.color === editor!.draft.color]) : [],
                    buttons: [[text.cancelLabel, text.saveLabel], value(host.checkManageEditor({ target: editor.target, name: editor.draft.name })).saveDisabled],
                };
            }
            return normalize({
                texts,
                labels,
                fields: renaming && view.sections.find((section) => section.key === 'somedaySections')?.open ? [[sections.text.nameLabel, renaming.title]] : [],
                editor: editorView,
                ...drain(),
            });
        },
        async perform([kind, target, extra]: [string, ...unknown[]]) {
            const view = read();
            const area = () => view.areas.rows.items.find((row) => row.name === target)!;
            const person = () => view.people.rows.items.find((row) => row.id === target)!;
            const token = () => [...view.contexts.rows.items, ...view.tags.rows.items].find((row) => row.value === target)!;
            const section = () => someday().rows.find((row) => row.title === target)!;
            const remove = (deleteTarget: NonNullable<ReturnType<typeof area>>['delete']) => async () => {
                value(await host.deleteManageItem({ requestId: generateUUID(), target: deleteTarget }));
            };
            switch (kind) {
                case 'toggle': {
                    const toggle = view.sections.find((entry) => entry.key === target)!.toggle;
                    log.device.push(['setItem', toggle.key, toggle.value]);
                    raw = toggle.value;
                    return;
                }
                case 'editUnassigned': return openEditor('unassignedArea', view.areas.unassigned.edit);
                case 'addArea': return openEditor('newArea', view.areas.newArea.edit);
                case 'editArea': return openEditor('area', area().edit);
                case 'addPerson': return openEditor('newPerson', view.people.newPerson.edit);
                case 'editPerson': return openEditor('person', person().edit);
                case 'renameValue': return openEditor(token().edit.target.type, token().edit);
                case 'deleteArea': return ask(area().deleteConfirm, remove(area().delete));
                case 'deletePerson': return ask(person().deleteConfirm, remove(person().delete));
                case 'deleteValue': return ask(token().deleteConfirm, remove(token().delete));
                case 'personCount':
                    log.navigations.push({ pathname: '/global-search', params: { q: person().searchQuery, includeCompleted: 'true' } });
                    return;
                case 'personLink': {
                    const link = person().referenceLink!;
                    log.links.push(link);
                    // The harness's device cannot open this one: the host says so.
                    if (link.includes('/fail')) log.alerts.push([view.people.text.openReference, view.people.text.openReferenceFailed, []]);
                    return;
                }
                case 'type': editor!.draft.name = target as string; return;
                case 'typeNote': editor!.draft.note = target as string; return;
                case 'typeLink': editor!.draft.referenceLink = target as string; return;
                case 'color': editor!.draft.color = target as string; return;
                case 'cancel': editor = null; return;
                case 'save': {
                    if (isManageEditorSaveDisabled(editor!.type as never, editor!.draft.name, view.areas.rows.items)) return;
                    value(await host.saveManageEditor({ requestId: generateUUID(), target: editor!.target, ...editor!.draft }));
                    editor = null;
                    return;
                }
                case 'alert': {
                    const confirm = pending!;
                    pending = null;
                    if (target === confirm.confirm.confirmLabel) await confirm.run();
                    return;
                }
                case 'somedayMove': {
                    const row = section();
                    value(await host.reorderSomedaySections({ ids: (extra === 'up' ? row.moveUp.ids : row.moveDown.ids)! }));
                    return;
                }
                case 'somedayRename': renaming = { id: section().id, title: section().title }; return;
                case 'somedayType': renaming!.title = target as string; return;
                case 'somedaySave':
                    value(await host.renameSomedaySection({ id: renaming!.id, title: renaming!.title }));
                    renaming = null;
                    return;
                case 'somedayDelete': {
                    const row = section();
                    return ask(row.deleteConfirm, async () => value(await host.deleteSomedaySection({ id: row.id })));
                }
                default:
                    throw new Error(`Unknown Manage action ${kind}`);
            }
        },
    };
}

describe('native host contract: Settings', () => {
    const originalTz = process.env.TZ;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        await loadTranslations('en');
        await loadTranslations('de');
    });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        vi.useRealTimers();
        await flushPendingSave();
        resetForTests();
        vi.restoreAllMocks();
    });
    const freezeClock = () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
    };

    type ManageKind = 'area' | 'person' | 'context' | 'tag';
    /** A Manage row's `edit.target` and `delete`, as the view shows them now. */
    const shown = (host: Host, type: ManageKind, key: string): { edit: NativeManageEditorTarget; delete: NativeManageDeleteTarget } => {
        const view = value(host.getManageSettings());
        const rows = type === 'area' ? view.areas.rows.items : type === 'person' ? view.people.rows.items : (type === 'context' ? view.contexts : view.tags).rows.items;
        const row = rows.find((entry) => ('id' in entry ? entry.id : entry.value) === key)!;
        return { edit: row.edit.target, delete: row.delete };
    };
    /** A target as a host sends it back: the row's own, for a row the view shows. */
    const asShown = (host: Host, target: { type: string; id?: string; name?: string }, which: 'edit' | 'delete' = 'edit') => (
        ['area', 'person', 'context', 'tag'].includes(target.type) ? shown(host, target.type as ManageKind, (target.id ?? target.name)!)[which] : target
    );

    const drivers = { menu: menuDriver, general: generalDriver, manage: manageDriver };
    const cases = (['menu', 'general', 'manage'] as const).flatMap((screen) => fixture[screen].map((scenario) => [scenario.name, screen, scenario] as const));

    it.each(cases)('replays the frozen React Native scenario through the contract: %s', async (name, screen, scenario) => {
        freezeClock();
        await seed(scenario);
        const host = await openHost(scenario.device);
        const driver = drivers[screen](host, scenario);
        const observed = [driver.observe()];
        for (const action of scenario.actions) {
            await driver.perform(action);
            await flushPendingSave();
            observed.push(driver.observe());
        }
        expect(observed).toEqual(fixture.observations[name]);
    });

    it('returns what core\'s settings models return when called directly', async () => {
        freezeClock();
        await seed({ data: 'manage', settings: 'stored' });
        const host = await openHost({ language: 'de', systemLocale: 'fa-IR' });
        const t = getTranslator('de');

        const menu = value(host.getSettingsMenu({ query: 'sprache', syncBadge: 'attention', updateAvailable: true }));
        const direct = buildSettingsMenu({ t, query: 'sprache', sync: getSettingsSyncBadge('attention', t) ?? undefined, updateAvailable: true });
        expect(menu.groups.map((group) => group.map(({ enabled: _enabled, ...row }) => row))).toEqual(direct.groups);
        expect(menu.advanced.rows.map(({ enabled: _enabled, ...row }) => row)).toEqual(buildSettingsAdvancedMenu(t).rows);
        expect(menu.groups.flat().filter((row) => row.enabled).map((row) => row.id)).toEqual(['general', 'gtd', 'advanced']);

        const general = value(host.getGeneralSettings({ deviceTheme: 'dark', appSearch: { supported: true, enabled: true } }));
        const settings = useTaskStore.getState().settings;
        const { version: _version, revision: _revision, ...model } = general;
        expect(model).toEqual(buildGeneralSettingsModel({
            settings,
            themeMode: resolveGeneralThemeMode(settings.theme, 'dark'),
            language: 'de',
            systemLocale: 'fa-IR',
            systemWeekStart: getSystemWeekStart('fa-IR'),
            systemDateSample: createDateFormatter({ language: 'de', dateFormat: 'system', calendarSystem: settings.calendarSystem, timeFormat: settings.timeFormat, systemLocale: 'fa-IR' })(new Date(), 'P'),
            appSearch: { supported: true, enabled: true },
            t,
        }));
        expect(general.regional.calendarSystem).not.toBeNull();

        const manage = value(host.getManageSettings({ openSections: null }));
        const state = useTaskStore.getState();
        expect(manage.areas.rows.items.map((row) => row.id)).toEqual(sortManageAreas(state.areas).map((area) => area.id));
        const counts = getPersonTaskCounts(state._allTasks);
        expect(manage.people.rows.items.map(({ id, name, edit: _edit, delete: _delete, deleteConfirm: _confirm, ...row }) => ({ id, name, row })))
            .toEqual(sortManagePeople(state.people).map((person) => ({ id: person.id, name: person.name, row: buildManagePersonRow(person, counts, t) })));
        expect(manage.contexts.rows.items.map((row) => row.value)).toEqual(state.getDerivedState().allContexts);
        expect(manage.tags.rows.items.map((row) => row.value)).toEqual(state.getDerivedState().allTags);
    });

    it.each(['context', 'tag'] as const)('creates an unused %s from Manage, keeps it durable, and rejects forged create targets', async (kind) => {
        await seed({ data: 'none', settings: 'base' });
        const host = await openHost();
        const type = kind === 'context' ? 'newContext' : 'newTag';
        const list = kind === 'context' ? 'contexts' : 'tags';
        const create = value(host.getManageSettings())[list].create;
        expect(create.edit.target).toEqual({ type });
        expect(create.edit.draft.name).toBe('');
        expect(value(host.checkManageEditor({ target: { type }, name: '#@' })).saveDisabled).toBe(true);
        expect(await host.saveManageEditor({ requestId: generateUUID(), target: { type }, name: '#' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await host.saveManageEditor({ requestId: generateUUID(), target: { type, revision: 'forged' } as never, name: 'unused' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const requestId = generateUUID();
        expect(value(await host.saveManageEditor({ requestId, target: create.edit.target, name: 'unused' })).changed).toBe(true);
        expect(getSavedTaxonomyTokens(useTaskStore.getState().settings, kind)).toEqual([kind === 'context' ? '@unused' : '#unused']);
        expect(value(host.getManageSettings())[list].rows.items.map(row => row.value)).toEqual([kind === 'context' ? '@unused' : '#unused']);
        await useTaskStore.getState().fetchData({ throwOnError: true });
        const restarted = await openHost();
        expect(value(await restarted.saveManageEditor({ requestId, target: create.edit.target, name: 'unused' })).changed).toBe(false);
        expect(getSavedTaxonomyTokens(useTaskStore.getState().settings, kind)).toHaveLength(1);
    });

    it.each(['context', 'tag'] as const)('renames and deletes saved unused %s with a catalogue revision guard', async (kind) => {
        await seed({ data: 'none', settings: 'base' });
        const host = await openHost();
        const list = kind === 'context' ? 'contexts' : 'tags';
        value(await host.saveManageEditor({ requestId: generateUUID(), target: { type: kind === 'context' ? 'newContext' : 'newTag' }, name: 'unused' }));
        const row = value(host.getManageSettings())[list].rows.items[0];
        expect(value(await host.saveManageEditor({ requestId: generateUUID(), target: row.edit.target, name: 'renamed' })).changed).toBe(true);
        const renamed = value(host.getManageSettings())[list].rows.items[0];
        expect(renamed.value).toBe(kind === 'context' ? '@renamed' : '#renamed');
        expect(value(await host.saveManageEditor({ requestId: generateUUID(), target: row.edit.target, name: 'stale' })).changed).toBe(false);
        expect(value(await host.saveManageEditor({ requestId: generateUUID(), target: renamed.edit.target, name: 'Renamed' })).changed).toBe(true);
        expect(await host.deleteManageItem({ requestId: generateUUID(), target: renamed.delete }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(value(await host.deleteManageItem({ requestId: generateUUID(), target: value(host.getManageSettings())[list].rows.items[0].delete })).changed).toBe(true);
        expect(getSavedTaxonomyTokens(useTaskStore.getState().settings, kind)).toEqual([]);
    });

    it('pages Manage lists under one revision and refuses a stale page', async () => {
        freezeClock();
        await seed({ data: 'manage', settings: 'manage' });
        const host = await openHost();
        const first = value(host.getManageSettings());
        const page = value(host.getManageSettingsList({ list: 'contexts', offset: 2, limit: 2, revision: first.revision }));
        expect(page).toMatchObject({ total: 5, items: [{ value: '@office' }, { value: '@phone' }] });
        expect(value(host.getManageSettings()).revision).toBe(first.revision);
        value(await host.saveManageEditor({ requestId: generateUUID(), target: shown(host, 'context', '@town').edit, name: '@city' }));
        const after = value(host.getManageSettings());
        expect(after.revision).not.toBe(first.revision);
        expect(host.getManageSettingsList({ list: 'contexts', offset: 0, limit: 2, revision: first.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        // A settings edit changes the General and Manage revisions too.
        const general = value(host.getGeneralSettings()).revision;
        value(await host.setGeneralSetting({ requestId: generateUUID(), edit: { type: 'timeFormat', value: '12h' } }));
        expect(value(host.getGeneralSettings()).revision).not.toBe(general);
        expect(value(host.getManageSettings()).revision).not.toBe(after.revision);
    });

    it('writes only the setting a control changes and keeps every other stored key', async () => {
        freezeClock();
        await seed({ data: 'none', settings: 'stored' });
        const host = await openHost();
        const before = useTaskStore.getState().settings;
        expect(value(await host.setGeneralSetting({ requestId: generateUUID(), edit: { type: 'quickAccessView', value: 'projects' } })))
            .toEqual({ changed: true, deviceWrites: [] });
        expect(writes).toEqual([['updateSettings', { appearance: { density: 'compact', showTaskAge: true, mobileQuickAccessView: 'projects' } }]]);
        const after = useTaskStore.getState().settings;
        expect({ ...after, appearance: before.appearance, syncPreferencesUpdatedAt: before.syncPreferencesUpdatedAt }).toEqual(before);
        expect(value(await host.setGeneralSetting({ requestId: generateUUID(), edit: { type: 'appSearch', value: true } })))
            .toEqual({ changed: false, deviceWrites: [{ key: 'mindwtr:appSearchIndexingEnabled', value: 'true' }] });
        // Off: the owed wipe is stored before the switch goes, so a start finishes a wipe that never landed (pass O2c).
        expect(value(await host.setGeneralSetting({ requestId: generateUUID(), edit: { type: 'appSearch', value: false } })))
            .toEqual({ changed: false, deviceWrites: [{ key: 'mindwtr:appSearchWipeOwed', value: 'true' }, { key: 'mindwtr:appSearchIndexingEnabled', value: null }] });
        expect(value(await host.setGeneralSetting({ requestId: generateUUID(), edit: { type: 'theme', value: 'material3-dark' } })).deviceWrites)
            .toEqual([{ key: '@mindwtr_theme', value: 'material3-dark' }, { key: '@mindwtr_theme_style', value: 'material3' }]);
        expect(writes).toHaveLength(2);
    });

    it('writes nothing for a new area named like a live area, whatever its color', async () => {
        freezeClock();
        await seed({ data: 'manage', settings: 'manage' });
        const host = await openHost();
        const areas = useTaskStore.getState()._allAreas;
        const newArea = value(host.getManageSettings()).editor.text.newArea;
        expect(newArea.nameTaken).toBe('An area with this name already exists.');
        expect(isManageEditorSaveDisabled('newArea', ' home ', value(host.getManageSettings()).areas.rows.items)).toBe(true);
        for (const color of ['#94a3b8', '#ef4444']) {
            expect(value(await host.saveManageEditor({ requestId: generateUUID(), target: { type: 'newArea' }, name: ' home ', color }))).toEqual({ changed: false });
        }
        expect(writes).toEqual([]);
        expect(useTaskStore.getState()._allAreas).toBe(areas);
    });

    it('checks the editor\'s name with core\'s own rule, so a host never copies it', async () => {
        freezeClock();
        await seed({ data: 'manage', settings: 'manage' });
        const host = await openHost();
        const { areas } = useTaskStore.getState();
        const text = value(host.getManageSettings()).editor.text;
        // The rows' own targets (with their revisions), and the same without one.
        const targets = [
            { type: 'newArea' }, shown(host, 'area', 'a-work').edit, { type: 'area', id: 'a-work' }, { type: 'unassignedArea' }, { type: 'newPerson' }, { type: 'newContext' }, { type: 'newTag' },
            shown(host, 'person', 'pe-alex').edit, shown(host, 'context', '@home').edit, { type: 'tag', name: '#web' }, shown(host, 'tag', '#web').edit,
        ] as NativeManageEditorTarget[];
        for (const target of targets) {
            for (const name of ['', '   ', 'Garden', ' home ', 'WORK', 'gone']) {
                const nameTaken = isManageAreaNameTaken(target.type, name, areas);
                expect(value(host.checkManageEditor({ target, name }))).toEqual({
                    nameTaken,
                    saveDisabled: isManageEditorSaveDisabled(target.type, name, areas),
                    message: nameTaken ? text[target.type].nameTaken : null,
                });
            }
        }
        expect(value(host.checkManageEditor({ target: { type: 'newArea' }, name: ' home ' })))
            .toEqual({ nameTaken: true, saveDisabled: true, message: 'An area with this name already exists.' });
        // A deleted area's name is free; the unassigned color needs no name.
        expect(value(host.checkManageEditor({ target: { type: 'newArea' }, name: 'Gone' })))
            .toEqual({ nameTaken: false, saveDisabled: false, message: null });
        expect(value(host.checkManageEditor({ target: { type: 'unassignedArea' }, name: '' })))
            .toEqual({ nameTaken: false, saveDisabled: false, message: null });
        expect(writes).toEqual([]);
    });

    it('writes nothing again for a target already reached, even after a restart', async () => {
        freezeClock();
        await seed({ data: 'manage', settings: 'manage' });
        const host = await openHost();
        // Each target as the row showed it when the first run sent it; the second run sends those again.
        const targets = new Map<string, NativeManageEditorTarget | NativeManageDeleteTarget>();
        const at = (target: Host, type: ManageKind, key: string, which: 'edit' | 'delete' = 'edit') => {
            if (!targets.has(`${which}:${key}`)) targets.set(`${which}:${key}`, shown(target, type, key)[which]);
            return targets.get(`${which}:${key}`)!;
        };
        const run = async (target: Host) => {
            value(await target.setGeneralSetting({ requestId: generateUUID(), edit: { type: 'weekStart', value: 'system' } }));
            value(await target.saveManageEditor({ requestId: generateUUID(), target: { type: 'unassignedArea' }, color: '#f97316' }));
            value(await target.saveManageEditor({ requestId: generateUUID(), target: { type: 'newArea' }, name: 'Garden', color: '#14b8a6' }));
            value(await target.saveManageEditor({ requestId: generateUUID(), target: at(target, 'area', 'a-work') as NativeManageEditorTarget, name: 'Office', color: '#ef4444' }));
            value(await target.saveManageEditor({ requestId: generateUUID(), target: { type: 'newPerson' }, name: 'Eve', note: 'Designer' }));
            value(await target.saveManageEditor({
                requestId: generateUUID(), target: at(target, 'person', 'pe-cy') as NativeManageEditorTarget, name: 'Cy', note: 'Contractor', referenceLink: 'javascript:alert(1)',
            }));
            value(await target.saveManageEditor({ requestId: generateUUID(), target: at(target, 'context', '@phone') as NativeManageEditorTarget, name: '@Phone' }));
            value(await target.saveManageEditor({ requestId: generateUUID(), target: at(target, 'tag', '#urgent') as NativeManageEditorTarget, name: 'later' }));
            value(await target.deleteManageItem({ requestId: generateUUID(), target: at(target, 'area', 'a-errands', 'delete') as NativeManageDeleteTarget }));
            value(await target.deleteManageItem({ requestId: generateUUID(), target: at(target, 'person', 'pe-dee', 'delete') as NativeManageDeleteTarget }));
            value(await target.deleteManageItem({ requestId: generateUUID(), target: at(target, 'context', '@town', 'delete') as NativeManageDeleteTarget }));
            value(await target.deleteManageItem({ requestId: generateUUID(), target: at(target, 'tag', '#web', 'delete') as NativeManageDeleteTarget }));
        };
        await run(host);
        await flushPendingSave();
        const written = writes.length;
        expect(written).toBeGreaterThanOrEqual(12);
        const snapshot = JSON.stringify([useTaskStore.getState()._allTasks, useTaskStore.getState()._allAreas, useTaskStore.getState()._allPeople, useTaskStore.getState()._allProjects]);
        // New request IDs on a new host: every write finds its target already stored.
        const restarted = await openHost();
        await run(restarted);
        // Adding a person who exists asks the store, which writes nothing.
        expect(writes.slice(written)).toEqual([['addPerson', 'Eve', { note: 'Designer' }]]);
        expect(JSON.stringify([useTaskStore.getState()._allTasks, useTaskStore.getState()._allAreas, useTaskStore.getState()._allPeople, useTaskStore.getState()._allProjects])).toBe(snapshot);
    });

    describe('exact retry after a failed save: one write, and the retry finishes the save', () => {
        const retry = async (
            run: (host: Host, requestId: string) => Promise<NativeHostResult<unknown>>,
            check: (saved: { settings: AppSettings; areas: Area[]; people: Person[]; tasks: Task[]; projects: Project[] }) => void,
        ) => {
            freezeClock();
            const saveData = vi.fn().mockResolvedValue(undefined);
            await seed({ data: 'manage', settings: 'manage' }, saveData);
            const host = await openHost();
            const requestId = generateUUID();
            saveData.mockRejectedValue(new Error('disk unavailable'));
            expect(await run(host, requestId)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: expect.stringContaining('disk unavailable') } });
            const count = writes.length;
            expect(count).toBeGreaterThan(0);
            saveData.mockResolvedValue(undefined);
            const retried = await run(host, requestId);
            expect(retried).toMatchObject({ ok: true, value: { changed: true } });
            expect(writes).toHaveLength(count);
            check(saveData.mock.lastCall?.[0]);
            // A lost reply repeats the request: no write, no save.
            const saves = saveData.mock.calls.length;
            expect(await run(host, requestId)).toEqual(retried);
            expect(saveData).toHaveBeenCalledTimes(saves);
        };

        it.each([
            ['setGeneralSetting: theme', (host: Host, requestId: string) => host.setGeneralSetting({ requestId, edit: { type: 'theme', value: 'nord' } }),
                (saved: { settings: AppSettings }) => expect(saved.settings.theme).toBe('nord')],
            ['setGeneralSetting: app lock', (host: Host, requestId: string) => host.setGeneralSetting({ requestId, edit: { type: 'appLock', value: true } }),
                (saved: { settings: AppSettings }) => expect(saved.settings.security?.mobileAppLockEnabled).toBe(true)],
            ['setGeneralSetting: week start', (host: Host, requestId: string) => host.setGeneralSetting({ requestId, edit: { type: 'weekStart', value: 'monday' } }),
                (saved: { settings: AppSettings }) => expect(saved.settings.weekStart).toBe('monday')],
        ] as const)('%s', async (_name, run, check) => {
            await retry(run, check as never);
        });

        // A device-only edit writes nothing to the store, so a failing disk cannot fail it.
        it('setGeneralSetting: Android system search (device only)', async () => {
            freezeClock();
            const saveData = vi.fn().mockResolvedValue(undefined);
            await seed({ data: 'manage', settings: 'manage' }, saveData);
            const host = await openHost();
            saveData.mockClear();
            saveData.mockRejectedValue(new Error('disk unavailable'));
            const requestId = generateUUID();
            const answer = { ok: true, value: { changed: false, deviceWrites: [{ key: 'mindwtr:appSearchIndexingEnabled', value: 'true' }] } };
            const run = () => host.setGeneralSetting({ requestId, edit: { type: 'appSearch', value: true } });
            expect(await run()).toEqual(answer);
            // A lost reply repeats the request: the same answer, no write, no save.
            expect(await run()).toEqual(answer);
            expect(writes).toEqual([]);
            expect(saveData).not.toHaveBeenCalled();
            expect(await host.setGeneralSetting({ requestId, edit: { type: 'appSearch', value: false } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        });

        it.each([
            ['saveManageEditor: new context', { target: { type: 'newContext' }, name: 'unused' },
                (saved: { settings: AppSettings }) => expect(getSavedTaxonomyTokens(saved.settings, 'context')).toContain('@unused')],
            ['saveManageEditor: new tag', { target: { type: 'newTag' }, name: 'unused' },
                (saved: { settings: AppSettings }) => expect(getSavedTaxonomyTokens(saved.settings, 'tag')).toContain('#unused')],
            ['saveManageEditor: unassigned color', { target: { type: 'unassignedArea' }, color: '#f97316' },
                (saved: { settings: AppSettings }) => expect(saved.settings.appearance).toEqual({ density: 'compact', unassignedAreaColor: '#f97316' })],
            ['saveManageEditor: new area', { target: { type: 'newArea' }, name: ' Garden ', color: '#14b8a6' },
                (saved: { areas: Area[] }) => expect(saved.areas.find((area) => area.name === 'Garden')?.color).toBe('#14b8a6')],
            ['saveManageEditor: area rename and color', { target: { type: 'area', id: 'a-work' }, name: 'Office', color: '#ef4444' },
                (saved: { areas: Area[] }) => expect(saved.areas.find((area) => area.id === 'a-work')).toMatchObject({ name: 'Office', color: '#ef4444' })],
            ['saveManageEditor: new person', { target: { type: 'newPerson' }, name: 'Eve', referenceLink: ' https://eve.example ' },
                (saved: { people: Person[] }) => expect(saved.people.find((person) => person.name === 'Eve')?.referenceLink).toBe('https://eve.example')],
            ['saveManageEditor: person note and rename', { target: { type: 'person', id: 'pe-alex' }, name: 'Alexis', note: 'QA', referenceLink: 'obsidian://people/alex' },
                (saved: { people: Person[]; tasks: Task[] }) => {
                    expect(saved.people.find((person) => person.id === 'pe-alex')).toMatchObject({ name: 'Alexis', note: 'QA' });
                    expect(saved.tasks.find((task) => task.id === 't-site')?.assignedTo).toBe('Alexis');
                }],
            ['saveManageEditor: context rename', { target: { type: 'context', name: '@phone' }, name: '@office' },
                (saved: { tasks: Task[] }) => expect(saved.tasks.find((task) => task.id === 't-call')?.contexts).toEqual(['@office'])],
            ['saveManageEditor: tag rename', { target: { type: 'tag', name: '#web' }, name: 'site' },
                (saved: { tasks: Task[]; projects: Project[] }) => {
                    expect(saved.tasks.find((task) => task.id === 't-site')?.tags).toEqual(['#site']);
                    expect(saved.projects.find((project) => project.id === 'p-site')?.tagIds).toEqual(['#site']);
                }],
        ] as const)('%s', async (_name, input, check) => {
            // The row's target as the view showed it once, sent again by the retries.
            let target: unknown;
            await retry((host, requestId) => host.saveManageEditor({ requestId, ...input, target: target ??= asShown(host, input.target) } as never), check as never);
        });

        it.each([
            ['deleteManageItem: area', { type: 'area', id: 'a-home' },
                (saved: { areas: Area[]; tasks: Task[] }) => {
                    expect(saved.areas.find((area) => area.id === 'a-home')?.deletedAt).toBe(fixture.now);
                    expect(saved.tasks.find((task) => task.id === 't-plant')?.areaId).toBeUndefined();
                }],
            ['deleteManageItem: person', { type: 'person', id: 'pe-dee' },
                (saved: { people: Person[] }) => expect(saved.people.find((person) => person.id === 'pe-dee')?.deletedAt).toBe(fixture.now)],
            ['deleteManageItem: context', { type: 'context', name: '@office' },
                (saved: { tasks: Task[] }) => expect(saved.tasks.find((task) => task.id === 't-plant')?.contexts).toEqual(['@home'])],
            ['deleteManageItem: tag', { type: 'tag', name: '#web' },
                (saved: { tasks: Task[]; projects: Project[] }) => {
                    expect(saved.tasks.find((task) => task.id === 't-site')?.tags).toEqual([]);
                    expect(saved.projects.find((project) => project.id === 'p-site')?.tagIds).toEqual([]);
                }],
        ] as const)('%s', async (_name, target, check) => {
            let shownTarget: unknown;
            await retry((host, requestId) => host.deleteManageItem({ requestId, target: (shownTarget ??= asShown(host, target, 'delete')) as never }), check as never);
        });
    });

    it('touches only the tasks and projects that carry a renamed or deleted token or area', async () => {
        freezeClock();
        await seed({ data: 'manage', settings: 'manage' });
        const host = await openHost();
        const before = new Map(useTaskStore.getState()._allTasks.map((task) => [task.id, task]));
        const projectsBefore = new Map(useTaskStore.getState()._allProjects.map((project) => [project.id, project]));
        value(await host.saveManageEditor({ requestId: generateUUID(), target: shown(host, 'context', '@phone').edit, name: '@office' }));
        value(await host.saveManageEditor({ requestId: generateUUID(), target: shown(host, 'tag', '#urgent').edit, name: 'Later' }));
        value(await host.deleteManageItem({ requestId: generateUUID(), target: shown(host, 'area', 'a-errands').delete }));
        const changed = useTaskStore.getState()._allTasks.filter((task) => before.get(task.id) !== task).map((task) => task.id);
        expect(changed.sort()).toEqual(['t-call', 't-errand']);
        expect(useTaskStore.getState()._allProjects.every((project) => projectsBefore.get(project.id) === project)).toBe(true);
    });

    describe('a replay after a restart, once its target changed since', () => {
        const stale = { ok: false, error: { code: 'STALE_REVISION' } };
        const unchanged = { ok: true, value: { changed: false } };
        const open = async () => {
            freezeClock();
            await seed({ data: 'manage', settings: 'manage' });
            return openHost();
        };
        const area = (id: string) => useTaskStore.getState()._allAreas.find((entry) => entry.id === id);
        const person = (id: string) => useTaskStore.getState()._allPeople.find((entry) => entry.id === id);
        const taskOf = (id: string) => useTaskStore.getState()._tasksById.get(id)!;

        it('setGeneralSetting: a landed setting answers changed: false and keeps a later change to another setting', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), edit: { type: 'weekStart' as const, value: 'monday' as const } };
            expect(value(await host.setGeneralSetting(input)).changed).toBe(true);
            await useTaskStore.getState().updateSettings({ timeFormat: '12h' });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.setGeneralSetting(input));
            expect(result).toEqual({ ok: true, value: { changed: false, deviceWrites: [] } });
            expect(wrote).toBe(false);
            expect(useTaskStore.getState().settings).toMatchObject({ weekStart: 'monday', timeFormat: '12h' });
        });

        it('saveManageEditor, unassigned color: a landed color answers changed: false and keeps a later appearance change', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: { type: 'unassignedArea' as const }, color: '#f97316' };
            expect(value(await host.saveManageEditor(input)).changed).toBe(true);
            await useTaskStore.getState().updateSettings({ appearance: { ...useTaskStore.getState().settings.appearance, density: 'comfortable' } });
            expect(await replayAfterRestart((restarted) => restarted.saveManageEditor(input))).toEqual({ result: unchanged, wrote: false });
            expect(useTaskStore.getState().settings.appearance).toEqual({ density: 'comfortable', unassignedAreaColor: '#f97316' });
        });

        it('saveManageEditor, new area: named by the request UUID, so a replay finds it renamed and adds nothing', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: { type: 'newArea' as const }, name: ' Garden ', color: '#14b8a6' };
            expect(value(await host.saveManageEditor(input))).toEqual({ changed: true });
            const id = input.requestId.toLowerCase();
            expect(area(id)).toMatchObject({ name: 'Garden', color: '#14b8a6' });
            await useTaskStore.getState().updateArea(id, { name: 'Yard' });
            expect(await replayAfterRestart((restarted) => restarted.saveManageEditor(input))).toEqual({ result: unchanged, wrote: false });
            expect(useTaskStore.getState()._allAreas.filter((entry) => entry.name === 'Garden')).toEqual([]);
            expect(area(id)?.name).toBe('Yard');
        });

        it('saveManageEditor, new area named like a deleted one: the store restores that area under its own ID', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: { type: 'newArea' as const }, name: 'Gone', color: '#14b8a6' };
            expect(value(await host.saveManageEditor(input))).toEqual({ changed: true });
            expect(area('a-gone')).toMatchObject({ name: 'Gone', deletedAt: undefined });
            expect(area(input.requestId.toLowerCase())).toBeUndefined();
        });

        // Fails with in-memory receipts only: the replay finds no row under its request UUID and
        // no live "Gone", so the store's addArea restores a-gone again (changed: true). Nothing in
        // the data tells "landed, then deleted" from "never landed". Durable request receipts close
        // it: the lead's durable-receipt test replays this request from its stored first reply
        // ("durable receipts: a Manage restore of a same-named deleted area, replayed after it was
        // deleted again and a restart, answers its first reply").
        it.fails('saveManageEditor, new area named like a deleted one: a replay after the restored area was deleted again keeps it deleted', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: { type: 'newArea' as const }, name: 'Gone', color: '#14b8a6' };
            expect(value(await host.saveManageEditor(input))).toEqual({ changed: true });
            expect(value(await host.deleteManageItem({ requestId: generateUUID(), target: shown(host, 'area', 'a-gone').delete }))).toEqual({ changed: true });
            const deleted = area('a-gone')!.deletedAt;
            expect(deleted).toEqual(expect.any(String));
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.saveManageEditor(input));
            expect({ result, wrote }).toEqual({ result: unchanged, wrote: false });
            expect(area('a-gone')?.deletedAt).toBe(deleted);
            expect(useTaskStore.getState().areas.filter((entry) => entry.name === 'Gone')).toEqual([]);
        });

        it('saveManageEditor, new person: named by the request UUID, so a replay finds them renamed and adds nothing', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: { type: 'newPerson' as const }, name: 'Eve', note: 'Designer' };
            expect(value(await host.saveManageEditor(input))).toEqual({ changed: true });
            const id = input.requestId.toLowerCase();
            expect(person(id)).toMatchObject({ name: 'Eve', note: 'Designer' });
            await useTaskStore.getState().renamePerson(id, 'Evelyn');
            expect(await replayAfterRestart((restarted) => restarted.saveManageEditor(input))).toEqual({ result: unchanged, wrote: false });
            expect(useTaskStore.getState()._allPeople.filter((entry) => entry.name === 'Eve')).toEqual([]);
        });

        it('saveManageEditor, area: never renames or recolors an area changed since', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: shown(host, 'area', 'a-work').edit, name: 'Office', color: '#ef4444' };
            expect(value(await host.saveManageEditor(input))).toEqual({ changed: true });
            await useTaskStore.getState().updateArea('a-work', { name: 'Job' });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.saveManageEditor(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(area('a-work')).toMatchObject({ name: 'Job', color: '#ef4444' });
        });

        it('saveManageEditor, person: never rewrites a person changed since', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: shown(host, 'person', 'pe-alex').edit, name: 'Alex', note: 'QA' };
            expect(value(await host.saveManageEditor(input))).toEqual({ changed: true });
            await useTaskStore.getState().updatePerson('pe-alex', { note: 'Release manager' });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.saveManageEditor(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(person('pe-alex')?.note).toBe('Release manager');
        });

        it('saveManageEditor, context: never renames the context of a task that took it since', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: shown(host, 'context', '@phone').edit, name: '@office' };
            expect(value(await host.saveManageEditor(input))).toEqual({ changed: true });
            await useTaskStore.getState().updateTask('t-errand', { contexts: ['@town', '@phone'] });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.saveManageEditor(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(taskOf('t-errand').contexts).toEqual(['@town', '@phone']);
        });

        it('saveManageEditor, tag: never renames the tag of a task that took it since', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: shown(host, 'tag', '#urgent').edit, name: 'later' };
            expect(value(await host.saveManageEditor(input))).toEqual({ changed: true });
            await useTaskStore.getState().updateTask('t-errand', { tags: ['#urgent'] });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.saveManageEditor(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(taskOf('t-errand').tags).toEqual(['#urgent']);
        });

        it('deleteManageItem, area: never deletes an area restored since', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: shown(host, 'area', 'a-errands').delete };
            expect(value(await host.deleteManageItem(input))).toEqual({ changed: true });
            await useTaskStore.getState().restoreArea('a-errands');
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.deleteManageItem(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(area('a-errands')?.deletedAt).toBeUndefined();
        });

        it('deleteManageItem, person: never deletes a person restored since', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: shown(host, 'person', 'pe-dee').delete };
            expect(value(await host.deleteManageItem(input))).toEqual({ changed: true });
            await useTaskStore.getState().restorePerson('pe-dee');
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.deleteManageItem(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(person('pe-dee')?.deletedAt).toBeUndefined();
        });

        it('deleteManageItem, context: never removes a context a task took since', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: shown(host, 'context', '@town').delete };
            expect(value(await host.deleteManageItem(input))).toEqual({ changed: true });
            // A landed delete answers changed: false.
            expect(await replayAfterRestart((restarted) => restarted.deleteManageItem(input))).toEqual({ result: unchanged, wrote: false });
            await useTaskStore.getState().updateTask('t-call', { contexts: ['@phone', '@town'] });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.deleteManageItem(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(taskOf('t-call').contexts).toEqual(['@phone', '@town']);
        });

        it('deleteManageItem, tag: never removes a tag a project took since', async () => {
            const host = await open();
            const input = { requestId: generateUUID(), target: shown(host, 'tag', '#web').delete };
            expect(value(await host.deleteManageItem(input))).toEqual({ changed: true });
            await useTaskStore.getState().updateProject('p-yard', { tagIds: ['#Garden', '#web'] });
            const { result, wrote } = await replayAfterRestart((restarted) => restarted.deleteManageItem(input));
            expect(result).toMatchObject(stale);
            expect(wrote).toBe(false);
            expect(useTaskStore.getState()._allProjects.find((project) => project.id === 'p-yard')?.tagIds).toEqual(['#Garden', '#web']);
        });

        it('saveManageEditor, tag: never renames the tag of a task synced to a revision the old 32-bit token could not tell apart', async () => {
            const host = await open();
            // Two revisions of t-call, #urgent's only carrier, whose old token (the count and a 32-bit FNV hash) was the same.
            const first = { rev: 1, revBy: 'd', updatedAt: '2026-09-24T00:02:43.758Z' };
            const second = { rev: 2, revBy: 'd', updatedAt: '2026-09-24T00:07:22.393Z' };
            expect(paramsKey([`t-call@${revisionOf(first)}`])).toBe(paramsKey([`t-call@${revisionOf(second)}`]));
            const sync = (revision: typeof first) => useTaskStore.setState({
                _allTasks: useTaskStore.getState()._allTasks.map((task) => (task.id === 't-call' ? { ...task, ...revision } : task)),
            });
            sync(first);
            const input = { requestId: generateUUID(), target: shown(host, 'tag', '#urgent').edit, name: 'later' };
            // Another device's version of the task arrives before the rename runs.
            sync(second);
            expect(await host.saveManageEditor(input)).toMatchObject(stale);
            expect(taskOf('t-call').tags).toEqual(['#urgent']);
        });

        it('checks a row\'s target as the view sent it, and refuses a write from a view read before a change', async () => {
            const host = await open();
            const target = shown(host, 'context', '@phone').edit;
            expect(target).toMatchObject({ type: 'context', name: '@phone', revision: expect.any(String) });
            expect(value(host.checkManageEditor({ target, name: '@office' }))).toEqual({ nameTaken: false, saveDisabled: false, message: null });
            await useTaskStore.getState().updateTask('t-call', { title: 'Call the bank' });
            expect(await host.saveManageEditor({ requestId: generateUUID(), target, name: '@office' })).toMatchObject(stale);
            expect(taskOf('t-call').contexts).toEqual(['@phone']);
        });
    });

    it('refuses input the screens do not offer', async () => {
        freezeClock();
        await seed({ data: 'manage', settings: 'manage' });
        const host = await openHost();
        const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };
        const id = () => generateUUID();
        expect(host.getSettingsMenu({ syncBadge: 'green' as never })).toMatchObject(invalid);
        expect(host.getSettingsMenu({ query: 5 as never })).toMatchObject(invalid);
        expect(host.getGeneralSettings({ appSearch: { supported: 'yes' } as never })).toMatchObject(invalid);
        expect(host.getManageSettings({ openSections: 7 as never })).toMatchObject(invalid);
        expect(host.getManageSettingsList({ list: 'projects' as never, offset: 0, limit: 1, revision: 'r' })).toMatchObject(invalid);
        expect(await host.setGeneralSetting({ requestId: id(), edit: { type: 'theme', value: 'neon' } as never })).toMatchObject(invalid);
        expect(await host.setGeneralSetting({ requestId: id(), edit: { type: 'weekStart', value: 'friday' } as never })).toMatchObject(invalid);
        expect(await host.setGeneralSetting({ requestId: id(), edit: { type: 'language', value: 'xx' } as never })).toMatchObject(invalid);
        // The calendar system is offered only for a Persian language or locale.
        expect(await host.setGeneralSetting({ requestId: id(), edit: { type: 'calendarSystem', value: 'jalali' } })).toMatchObject(invalid);
        expect(await host.setGeneralSetting({ requestId: id(), edit: { type: 'showTaskAge', value: 'on' } as never })).toMatchObject(invalid);
        expect(await host.setGeneralSetting({ requestId: 'not-a-uuid', edit: { type: 'showTaskAge', value: true } })).toMatchObject(invalid);
        expect(await host.saveManageEditor({ requestId: id(), target: { type: 'newArea' }, name: '   ' })).toMatchObject(invalid);
        expect(await host.saveManageEditor({ requestId: id(), target: { type: 'newArea' }, name: 'Garden', color: '#123456' })).toMatchObject(invalid);
        expect(await host.saveManageEditor({ requestId: id(), target: { type: 'area', id: 'a-gone', revision: '1' }, name: 'Back' })).toMatchObject(invalid);
        // A write to an area, person, context or tag carries the revision its row showed.
        const work = shown(host, 'area', 'a-work');
        for (const target of [{ type: 'area', id: 'a-work' }, { type: 'person', id: 'pe-cy', revision: '' }, { type: 'context', name: '@phone' }, { type: 'tag', name: '#web', revision: 5 }]) {
            expect(await host.saveManageEditor({ requestId: id(), target: target as never, name: 'x' })).toMatchObject(invalid);
            expect(await host.deleteManageItem({ requestId: id(), target: target as never })).toMatchObject(invalid);
        }
        expect(await host.saveManageEditor({ requestId: id(), target: { ...work.edit, extra: 1 } as never, name: 'x' })).toMatchObject(invalid);
        expect(await host.saveManageEditor({ requestId: id(), target: { type: 'newArea', revision: 'r' } as never, name: 'x' })).toMatchObject(invalid);
        expect(await host.saveManageEditor({ requestId: id(), target: { type: 'project', id: 'p-site' } as never, name: 'x' })).toMatchObject(invalid);
        expect(await host.deleteManageItem({ requestId: id(), target: { type: 'newArea' } as never })).toMatchObject(invalid);
        expect(host.checkManageEditor({ target: { type: 'project', id: 'p-site' } as never, name: 'x' })).toMatchObject(invalid);
        expect(host.checkManageEditor({ target: { type: 'area' } as never, name: 'x' })).toMatchObject(invalid);
        expect(host.checkManageEditor({ target: { type: 'newArea' }, name: 5 as never })).toMatchObject(invalid);
        expect(host.checkManageEditor({ target: { type: 'newArea' }, name: 'x'.repeat(501) })).toMatchObject(invalid);
        expect(host.checkManageEditor({ target: { type: 'newArea' } } as never)).toMatchObject(invalid);
        expect(host.checkManageEditor(null as never)).toMatchObject(invalid);
        expect(writes).toEqual([]);
    });

    it('is NOT_READY until storage is activated', async () => {
        setStorageAdapter(noopStorage);
        const host = createNativeHostContract();
        const notReady = { ok: false, error: { code: 'NOT_READY' } };
        const requestId = generateUUID();
        expect(host.getSettingsMenu()).toMatchObject(notReady);
        expect(host.getGeneralSettings()).toMatchObject(notReady);
        expect(host.getManageSettings()).toMatchObject(notReady);
        expect(host.getManageSettingsList({ list: 'areas', offset: 0, limit: 1, revision: 'r' })).toMatchObject(notReady);
        expect(await host.setGeneralSetting({ requestId, edit: { type: 'showTaskAge', value: true } })).toMatchObject(notReady);
        expect(await host.saveManageEditor({ requestId, target: { type: 'newArea' }, name: 'Garden' })).toMatchObject(notReady);
        expect(host.checkManageEditor({ target: { type: 'newArea' }, name: 'Garden' })).toMatchObject(notReady);
        expect(await host.deleteManageItem({ requestId, target: { type: 'context', name: '@home', revision: 'r' } })).toMatchObject(notReady);
    });
});
