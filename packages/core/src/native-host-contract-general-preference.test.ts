import { afterEach, describe, expect, it } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { MOBILE_QUICK_ACCESS_VIEW_OPTIONS, SETTINGS_LANGUAGE_OPTIONS } from './general-settings-model';
import { SUPPORTED_LANGUAGES } from './i18n/i18n-constants';
import { SETTINGS_THEME_VALUES } from './settings-options';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { NativeGeneralPreferenceRequest } from './native-host-contract-general-preference';
import type { AppData, Task } from './types';

const ID = '00000000-0000-4000-8000-000000000097';
const AT = '2026-09-01T00:00:00.000Z';
const terminal: Task = { id: 'terminal', title: 'Terminal', status: 'done', tags: [], contexts: [],
    focusOrder: 9, deletedAt: AT, createdAt: AT, updatedAt: AT, rev: 7 };
const initial = (): AppData => ({ tasks: [terminal], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'preferences-device', appearance: { density: 'compact' },
        syncPreferencesUpdatedAt: { appearance: AT, language: AT },
        ai: { apiKey: 'private-value', baseUrl: 'https://private.invalid/x' },
        gtd: { focusTaskLimit: 6 }, calendarSystem: 'gregorian' } as AppData['settings'] });

async function open(start: AppData, fail?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data = structuredClone(start);
    let saves = 0;
    const adapter = { getData: async () => structuredClone(data), saveData: async (next: AppData) => {
        if (fail?.()) throw new Error('disk unavailable');
        data = structuredClone(next); saves += 1;
    } };
    setStorageAdapter(adapter);
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true }); await flushPendingSave(); saves = 0;
    data = structuredClone(start);
    const host = createNativeHostContract();
    expect(await host.activate({ writeSafetyReady: true })).toMatchObject({ ok: true });
    await flushPendingSave();
    data = structuredClone(start);
    saves = 0;
    return { host, data: () => data, saves: () => saves,
        changeSaved: (fn: (data: AppData) => AppData) => { data = fn(data); },
        reopen: async () => open(data, fail) };
}

async function planned(env: Awaited<ReturnType<typeof open>>,
    edit: NativeGeneralPreferenceRequest['edit']) {
    const options = await env.host.getGeneralPreferenceOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGeneralPreferenceRequest = { requestId: ID, edit,
        expected: options.value.expected[edit.type] };
    const plan = await env.host.prepareGeneralPreference(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('prepared General preferences', () => {
    it.each([
        { type: 'showTaskAge', value: true, group: 'appearance' },
        { type: 'weekStart', value: 'monday', group: 'language' },
        { type: 'dateFormat', value: 'ymd', group: 'language' },
        { type: 'timeFormat', value: '24h', group: 'language' },
    ] as const)('applies and cold-replays $type preserving all unrelated raw rows and settings', async ({ type, value, group }) => {
        const env = await open(initial());
        const { options, envelope, prepared } = await planned(env, { type, value } as NativeGeneralPreferenceRequest['edit']);
        expect(options.model.appearance.showTaskAge.value).toBe(false);
        expect(prepared.version).toBe(1);
        expect(env.host.validatePreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(JSON.stringify(envelope)).not.toContain('private-value');
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.saves()).toBe(1);
        expect(env.data().tasks).toEqual(initial().tasks);
        // The store's existing secure-storage rule strips API keys on every SQLite save.
        expect(env.data().settings.ai).toEqual({ apiKey: undefined, baseUrl: 'https://private.invalid/x' });
        expect(env.data().settings.gtd).toEqual(initial().settings.gtd);
        expect(env.data().settings.calendarSystem).toBe('gregorian');
        expect(env.data().settings.syncPreferencesUpdatedAt?.[group]).toBe(prepared.after.stamp);
        expect(env.data().settings.syncPreferencesUpdatedAt?.[group === 'language' ? 'appearance' : 'language']).toBe(AT);
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
    });

    it.each(MOBILE_QUICK_ACCESS_VIEW_OPTIONS)('offers and cold-replays Quick Access %s through the shared picker', async (value) => {
        const env = await open(initial());
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(Object.keys(options.value.expected).sort()).toEqual([
            'showTaskAge', 'quickAccessView', 'weekStart', 'dateFormat', 'timeFormat', 'calendarSystem', 'theme', 'language'].sort());
        expect(options.value.expected.quickAccessView).toMatchObject({ present: false, value: null,
            stampPresent: true, stamp: AT });
        expect(options.value.model.appearance.quickAccess.options.map((row) => row.value))
            .toEqual(MOBILE_QUICK_ACCESS_VIEW_OPTIONS);
        expect(options.value.model.appearance.quickAccess.options.find((row) => row.selected)?.value).toBe('review');
        const choice = options.value.model.appearance.quickAccess.options.find((row) => row.value === value);
        expect(choice?.edit).toEqual({ type: 'quickAccessView', value });
        const { envelope, prepared } = await planned(env, { type: 'quickAccessView', value });
        expect(prepared.version).toBe(1);
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.appearance).toMatchObject({ density: 'compact', mobileQuickAccessView: value });
        expect(env.data().settings.syncPreferencesUpdatedAt?.appearance).toBe(prepared.after.stamp);
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
        const current = await cold.host.getGeneralPreferenceOptions({});
        if (!current.ok) throw new Error(JSON.stringify(current));
        expect(current.value.model.appearance.quickAccess.options.find((row) => row.selected)?.value).toBe(value);
    });

    it.each(SETTINGS_THEME_VALUES)('offers, saves, and cold-replays shared Theme %s', async (value) => {
        const env = await open(initial());
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const groups = options.value.model.appearance.theme.groups;
        expect(groups).toHaveLength(2);
        expect(groups[0].map((row) => row.value)).toEqual(['system', 'system-oled', 'light', 'dark']);
        expect(groups[1].map((row) => row.value)).toEqual(['material3-light', 'material3-dark', 'eink',
            'nord', 'catppuccin-macchiato', 'dracula', 'gruvbox-light', 'gruvbox-dark', 'sepia', 'oled']);
        expect([...groups.flat().map((row) => row.value)].sort()).toEqual([...SETTINGS_THEME_VALUES].sort());
        expect(groups.flat().find((row) => row.value === value)?.edit).toEqual({ type: 'theme', value });
        expect(options.value.expected.theme).toEqual({ present: false, value: null,
            stampPresent: true, stamp: AT });
        const { envelope, prepared } = await planned(env, { type: 'theme', value });
        expect(prepared.version).toBe(1);
        expect(JSON.stringify(envelope)).not.toContain('private-value');
        expect(env.host.validatePreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.theme).toBe(value);
        expect(env.data().settings.syncPreferencesUpdatedAt?.appearance).toBe(prepared.after.stamp);
        expect(env.data().settings.syncPreferencesUpdatedAt?.language).toBe(AT);
        expect(env.data().settings.appearance).toEqual(initial().settings.appearance);
        expect(env.data().tasks).toEqual(initial().tasks);
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
    });

    it.each(SUPPORTED_LANGUAGES)('offers, saves, and cold-replays shared Language %s', async (value) => {
        const env = await open(initial());
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.model.language.options.map((row) => row.value))
            .toEqual(SETTINGS_LANGUAGE_OPTIONS.map((row) => row.id));
        expect(options.value.model.language.options.find((row) => row.value === value)?.edit)
            .toEqual({ type: 'language', value });
        expect(options.value.expected.language).toEqual({ present: false, value: null,
            stampPresent: true, stamp: AT });
        const { envelope, prepared } = await planned(env, { type: 'language', value });
        expect(prepared.version).toBe(1);
        expect(JSON.stringify(envelope)).not.toContain('private-value');
        expect(env.host.validatePreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.language).toBe(value);
        expect(env.data().settings.syncPreferencesUpdatedAt?.language).toBe(prepared.after.stamp);
        expect(env.data().settings.syncPreferencesUpdatedAt?.appearance).toBe(AT);
        expect(env.data().settings.calendarSystem).toBe('gregorian');
        expect(env.data().tasks).toEqual(initial().tasks);
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
        expect(await cold.host.setLanguage({ storedLanguage: value, systemLocale: 'en-US' }))
            .toMatchObject({ ok: true, value: { language: value } });
        const current = await cold.host.getGeneralPreferenceOptions({});
        if (!current.ok) throw new Error(JSON.stringify(current));
        expect(current.value.model.language.options.find((row) => row.selected)?.value).toBe(value);
    });

    it('distinguishes an absent synced Language from the local choice and preserves unknown raw values', async () => {
        const env = await open(initial());
        expect(await env.host.setLanguage({ storedLanguage: 'fa', systemLocale: 'en-US' }))
            .toMatchObject({ ok: true, value: { language: 'fa' } });
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.model.language.options.find((row) => row.selected)?.value).toBe('fa');
        expect(options.value.expected.language).toMatchObject({ present: false, value: null });
        const { envelope } = await planned(env, { type: 'language', value: 'fa' });
        expect(await env.host.commitPreparedGeneralPreference(envelope))
            .toMatchObject({ ok: true, value: { changed: true } });
        const current = await env.host.getGeneralPreferenceOptions({});
        if (!current.ok) throw new Error(JSON.stringify(current));
        expect(await env.host.prepareGeneralPreference({ requestId: ID, edit: { type: 'language', value: 'fa' },
            expected: current.value.expected.language }))
            .toMatchObject({ ok: true, value: { kind: 'noop', result: { changed: false } } });

        const start = initial(); start.settings.language = 'legacy-language' as never;
        const other = await open(start);
        const raw = await other.host.getGeneralPreferenceOptions({});
        if (!raw.ok) throw new Error(JSON.stringify(raw));
        expect(raw.value.expected.language).toMatchObject({ present: true, value: 'legacy-language' });
        expect(other.data().settings.language).toBe('legacy-language');
        const replace = await planned(other, { type: 'language', value: 'de' });
        expect(await other.host.commitPreparedGeneralPreference(replace.envelope)).toMatchObject({ ok: true });
        expect(other.data().settings.language).toBe('de');
    });

    it('rejects malformed Language raw values, choices, and forged numeric witnesses', async () => {
        const env = await open(initial());
        for (const value of ['constructor', '__proto__', 'unknown-language'])
            expect(await env.host.prepareGeneralPreference({ requestId: ID, edit: { type: 'language', value },
                expected: { present: false, value: null, stampPresent: true, stamp: AT } } as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const { envelope } = await planned(env, { type: 'language', value: 'fa' });
        const numeric = structuredClone(envelope);
        numeric.request.expected = { present: true, value: 1, stampPresent: true, stamp: AT };
        numeric.prepared.request.expected = numeric.request.expected;
        expect(env.host.validatePreparedGeneralPreference(numeric))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        for (const value of [null, 1, {}, 'x'.repeat(501)]) {
            const start = initial(); start.settings.language = value as never;
            const invalid = await open(start);
            expect(await invalid.host.getGeneralPreferenceOptions({}))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });

    it('refuses Language field and group-stamp conflicts, including an independent same target', async () => {
        const env = await open(initial());
        const { envelope } = await planned(env, { type: 'language', value: 'fa' });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings, language: 'fa',
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                language: '2026-09-02T00:00:00.000Z' } } }));
        expect(await env.host.commitPreparedGeneralPreference(envelope))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings, language: undefined,
            dateFormat: 'dmy' } }));
        expect(await env.host.commitPreparedGeneralPreference(envelope))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
    });

    it('keeps device Theme a display hint while pinning raw absent and unknown saved values', async () => {
        const env = await open(initial());
        const hinted = await env.host.getGeneralPreferenceOptions({ deviceTheme: 'nord' });
        if (!hinted.ok) throw new Error(JSON.stringify(hinted));
        expect(hinted.value.expected.theme).toMatchObject({ present: false, value: null });
        expect(hinted.value.model.appearance.theme.groups.flat().find((row) => row.selected)?.value).toBe('nord');
        const selected = await env.host.getGeneralPreferenceOptions({ deviceTheme: null });
        if (!selected.ok) throw new Error(JSON.stringify(selected));
        expect(selected.value.model.appearance.theme.groups.flat().find((row) => row.selected)?.value).toBe('system');
        const { envelope } = await planned(env, { type: 'theme', value: 'nord' });
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: true, value: { changed: true } });
        const same = await env.host.getGeneralPreferenceOptions({ deviceTheme: 'dark' });
        if (!same.ok) throw new Error(JSON.stringify(same));
        expect(same.value.model.appearance.theme.groups.flat().find((row) => row.selected)?.value).toBe('nord');
        expect(await env.host.prepareGeneralPreference({ requestId: ID, edit: { type: 'theme', value: 'nord' },
            expected: same.value.expected.theme })).toMatchObject({ ok: true, value: { kind: 'noop', result: { changed: false } } });

        const unknown = initial(); unknown.settings.theme = 'legacy-theme' as never;
        const other = await open(unknown);
        const raw = await other.host.getGeneralPreferenceOptions({ deviceTheme: 'dark' });
        if (!raw.ok) throw new Error(JSON.stringify(raw));
        expect(raw.value.expected.theme).toMatchObject({ present: true, value: 'legacy-theme' });
        expect(raw.value.model.appearance.theme.groups.flat().some((row) => row.selected)).toBe(false);
        expect(other.data().settings.theme).toBe('legacy-theme');
        const replace = await planned(other, { type: 'theme', value: 'dark' });
        expect(await other.host.commitPreparedGeneralPreference(replace.envelope)).toMatchObject({ ok: true });
        expect(other.data().settings.theme).toBe('dark');
    });

    it('rejects malformed Theme reads, raw values, choices, and forged frozen payloads', async () => {
        const env = await open(initial());
        for (const input of [{ deviceTheme: 1 }, { deviceTheme: 'x'.repeat(501) }, { extra: true }])
            expect(await env.host.getGeneralPreferenceOptions(input as never)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        for (const value of ['constructor', '__proto__', 'legacy-theme'])
            expect(await env.host.prepareGeneralPreference({ requestId: ID, edit: { type: 'theme', value },
                expected: { present: false, value: null, stampPresent: true, stamp: AT } } as never))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const { envelope } = await planned(env, { type: 'theme', value: 'dark' });
        const numeric = structuredClone(envelope);
        numeric.request.expected = { present: true, value: 1, stampPresent: true, stamp: AT };
        numeric.prepared.request.expected = numeric.request.expected;
        expect(env.host.validatePreparedGeneralPreference(numeric)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const forged = structuredClone(envelope); forged.prepared.after.value = 'light';
        expect(env.host.validatePreparedGeneralPreference(forged)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        for (const value of [null, 1, {}, 'x'.repeat(501)]) {
            const start = initial(); start.settings.theme = value as never;
            const invalid = await open(start);
            expect(await invalid.host.getGeneralPreferenceOptions({})).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
    });

    it('refuses Theme field or appearance sibling changes, including an independent same target', async () => {
        const env = await open(initial());
        const { envelope } = await planned(env, { type: 'theme', value: 'dark' });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings, theme: 'dark',
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                appearance: '2026-09-02T00:00:00.000Z' } } }));
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings, theme: undefined,
            appearance: { ...data.settings.appearance, showTaskAge: true } } }));
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings,
            appearance: { ...data.settings.appearance, showTaskAge: false },
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt, appearance: AT } } }));
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: true });
        expect(env.data().settings.theme).toBe('dark');
    });

    it.each([
        { storedLanguage: 'fa', systemLocale: 'en-US' },
        { storedLanguage: 'en', systemLocale: 'fa-IR' },
    ])('offers both Calendar systems for $storedLanguage language and $systemLocale locale', async (locale) => {
        const start = initial();
        start.tasks.push({ id: 'timed', title: 'Timed', status: 'next', tags: [], contexts: [],
            dueDate: '2026-09-30T15:30:00.000Z', createdAt: AT, updatedAt: AT });
        const env = await open(start);
        expect(await env.host.setLanguage(locale)).toMatchObject({ ok: true });
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const picker = options.value.model.regional.calendarSystem;
        expect(picker?.options.map((row) => row.value)).toEqual(['gregorian', 'jalali']);
        expect(options.value.expected.calendarSystem).toMatchObject({ present: true, value: 'gregorian',
            stampPresent: true, stamp: AT });
        const dueLabel = () => {
            const view = env.host.getTaskView({ id: 'timed' });
            if (!view.ok) throw new Error(JSON.stringify(view));
            const row = view.value.rows.find((item) => item.type === 'field' && item.field === 'dueDate');
            if (!row || row.type !== 'field') throw new Error('Due date row missing');
            return row.value;
        };
        const before = dueLabel();
        const { envelope, prepared } = await planned(env, { type: 'calendarSystem', value: 'jalali' });
        expect(prepared.version).toBe(1);
        expect(env.host.validatePreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(dueLabel()).not.toBe(before);
        expect(env.data().tasks).toEqual(start.tasks);
        expect(env.data().settings.calendarSystem).toBe('jalali');
        expect(env.data().settings.syncPreferencesUpdatedAt?.language).toBe(prepared.after.stamp);
        expect(env.data().settings.appearance).toEqual(start.settings.appearance);
    });

    it('hides Calendar system in English, refuses a stale offer, and cold-replays an accepted edit after locale change', async () => {
        const env = await open(initial());
        const english = await env.host.getGeneralPreferenceOptions({});
        if (!english.ok) throw new Error(JSON.stringify(english));
        expect(english.value.model.regional.calendarSystem).toBeNull();
        const hiddenRequest: NativeGeneralPreferenceRequest = { requestId: ID,
            edit: { type: 'calendarSystem', value: 'jalali' }, expected: english.value.expected.calendarSystem };
        expect(await env.host.prepareGeneralPreference(hiddenRequest)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(await env.host.setLanguage({ storedLanguage: 'fa', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        const accepted = await planned(env, { type: 'calendarSystem', value: 'jalali' });
        expect(await env.host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        expect(await env.host.prepareGeneralPreference(accepted.request)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(env.host.validatePreparedGeneralPreference(accepted.envelope)).toEqual({ ok: true, value: accepted.prepared.result });
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGeneralPreference(accepted.envelope)).toEqual({ ok: true,
            value: accepted.prepared.result });
        expect(cold.data().settings.calendarSystem).toBe('jalali');
        expect(cold.data().settings.syncPreferencesUpdatedAt?.language).toBe(accepted.prepared.after.stamp);
        expect(await cold.host.commitPreparedGeneralPreference(accepted.envelope)).toEqual({ ok: true,
            value: accepted.prepared.result });
        expect(cold.saves()).toBe(1);
    });

    it('pins unknown or absent raw Calendar system, preserves siblings, and no-ops an exact stored choice', async () => {
        const start = initial();
        start.settings = { ...start.settings, calendarSystem: 'legacy-calendar',
            timeFormat: '24h', weekStart: 'saturday' } as typeof start.settings;
        const env = await open(start);
        expect(await env.host.setLanguage({ storedLanguage: 'fa', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.expected.calendarSystem).toMatchObject({ present: true, value: 'legacy-calendar' });
        expect(env.data().settings.calendarSystem).toBe('legacy-calendar');
        const { envelope } = await planned(env, { type: 'calendarSystem', value: 'gregorian' });
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: true });
        expect(env.data().settings).toMatchObject({ calendarSystem: 'gregorian', timeFormat: '24h',
            weekStart: 'saturday' });
        const fresh = await env.host.getGeneralPreferenceOptions({});
        if (!fresh.ok) throw new Error(JSON.stringify(fresh));
        const noop = await env.host.prepareGeneralPreference({ requestId: ID,
            edit: { type: 'calendarSystem', value: 'gregorian' }, expected: fresh.value.expected.calendarSystem });
        expect(noop).toMatchObject({ ok: true, value: { kind: 'noop', result: { changed: false } } });
        const absent = initial(); absent.settings.calendarSystem = undefined;
        const other = await open(absent);
        expect(await other.host.setLanguage({ storedLanguage: 'fa', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        const absentOptions = await other.host.getGeneralPreferenceOptions({});
        if (!absentOptions.ok) throw new Error(JSON.stringify(absentOptions));
        expect(absentOptions.value.expected.calendarSystem).toMatchObject({ present: false, value: null });
        const absentWrite = await planned(other, { type: 'calendarSystem', value: 'gregorian' });
        expect(await other.host.commitPreparedGeneralPreference(absentWrite.envelope)).toMatchObject({ ok: true,
            value: { changed: true } });
    });

    it('refuses Calendar field and language-stamp conflicts including an independent same target', async () => {
        const env = await open(initial());
        expect(await env.host.setLanguage({ storedLanguage: 'fa', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        const { envelope } = await planned(env, { type: 'calendarSystem', value: 'jalali' });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings, calendarSystem: 'jalali',
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                language: '2026-09-02T00:00:00.000Z' } } }));
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings, calendarSystem: 'gregorian',
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                language: '2026-09-02T00:00:00.000Z' } } }));
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
        const bad = { ...envelope.request, expected: { ...envelope.request.expected, value: 1 } };
        expect(await env.host.prepareGeneralPreference(bad as never)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
    });

    it('treats own undefined Quick Access and appearance stamp as JSON-durable absence', async () => {
        const start = initial();
        start.settings.appearance!.mobileQuickAccessView = undefined;
        start.settings.syncPreferencesUpdatedAt!.appearance = undefined;
        const env = await open(start);
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.expected.quickAccessView).toEqual({ present: false, value: null,
            stampPresent: false, stamp: null });
        expect(options.value.model.appearance.quickAccess.options.find((row) => row.selected)?.value).toBe('review');
        const { envelope } = await planned(env, { type: 'quickAccessView', value: 'review' });
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: true,
            value: { changed: true } });
        expect(env.data().settings.appearance?.mobileQuickAccessView).toBe('review');
    });

    it('keeps raw unknown Quick Access and sibling appearance values until explicit choice', async () => {
        const start = initial();
        start.settings.appearance = { ...start.settings.appearance, mobileQuickAccessView: 'legacy-quick',
            unassignedAreaColor: '#abcdef' } as typeof start.settings.appearance;
        const env = await open(start);
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.expected.quickAccessView).toMatchObject({ present: true, value: 'legacy-quick' });
        expect(options.value.model.appearance.quickAccess.options.find((row) => row.selected)?.value).toBe('review');
        expect(env.data().settings.appearance?.mobileQuickAccessView).toBe('legacy-quick');
        const { envelope } = await planned(env, { type: 'quickAccessView', value: 'contexts' });
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: true });
        expect(env.data().settings.appearance).toMatchObject({ mobileQuickAccessView: 'contexts',
            density: 'compact', unassignedAreaColor: '#abcdef' });
        const fresh = await env.reopen();
        const next = await fresh.host.getGeneralPreferenceOptions({});
        if (!next.ok) throw new Error(JSON.stringify(next));
        const noop = await fresh.host.prepareGeneralPreference({ requestId: ID,
            edit: { type: 'quickAccessView', value: 'contexts' }, expected: next.value.expected.quickAccessView });
        expect(noop).toMatchObject({ ok: true, value: { kind: 'noop', result: { changed: false } } });
        expect(fresh.saves()).toBe(0);
    });

    it('refuses Quick Access field or appearance stamp conflicts even at the same target', async () => {
        const env = await open(initial());
        const { envelope } = await planned(env, { type: 'quickAccessView', value: 'projects' });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings,
            appearance: { ...data.settings.appearance, mobileQuickAccessView: 'projects' },
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                appearance: '2026-09-02T00:00:00.000Z' } } }));
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings,
            appearance: { ...data.settings.appearance, mobileQuickAccessView: 'calendar' },
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt, appearance: AT } } }));
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
        const malformed = { ...envelope.request, expected: { ...envelope.request.expected, value: 1, present: true } };
        expect(await env.host.prepareGeneralPreference(malformed as never)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
    });

    it('keeps absent and explicit system distinct, and no-op writes nothing', async () => {
        const start = initial();
        start.settings.weekStart = undefined;
        start.settings.syncPreferencesUpdatedAt!.language = undefined;
        const env = await open(start);
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.expected.weekStart).toMatchObject({ present: false, value: null,
            stampPresent: false, stamp: null });
        expect(options.value.model.regional.weekStart.options.find((row) => row.value === 'system')?.selected).toBe(true);
        const { envelope } = await planned(env, { type: 'weekStart', value: 'system' });
        expect((await env.host.commitPreparedGeneralPreference(envelope)).ok).toBe(true);
        expect(env.data().settings.weekStart).toBe('system');
        const fresh = await env.reopen();
        const newOptions = await fresh.host.getGeneralPreferenceOptions({});
        if (!newOptions.ok) throw new Error(JSON.stringify(newOptions));
        const noop = await fresh.host.prepareGeneralPreference({ requestId: ID, edit: { type: 'weekStart', value: 'system' },
            expected: newOptions.value.expected.weekStart });
        expect(noop).toMatchObject({ ok: true, value: { kind: 'noop', result: { changed: false } } });
        expect(fresh.saves()).toBe(0);
    });

    it('pins a bounded raw numeric legacy preference while editing another field and replacing it', async () => {
        const start = initial();
        start.settings = { ...start.settings, weekStart: 1 } as typeof start.settings;
        const env = await open(start);
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.expected.weekStart).toMatchObject({ present: true, value: 1 });
        const other = await planned(env, { type: 'showTaskAge', value: true });
        expect(await env.host.commitPreparedGeneralPreference(other.envelope)).toMatchObject({ ok: true });
        expect(env.data().settings.weekStart).toBe(1);
        const replace = await planned(env, { type: 'weekStart', value: 'monday' });
        expect(replace.envelope.request.expected.value).toBe(1);
        expect(await env.host.commitPreparedGeneralPreference(replace.envelope)).toMatchObject({ ok: true });
        expect(env.data().settings.weekStart).toBe('monday');
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGeneralPreference(replace.envelope)).toMatchObject({ ok: true });
    });

    it('refreshes the observable Task View date and time labels after each regional choice', async () => {
        const start = initial();
        start.settings = { ...start.settings, dateFormat: 'ymd', timeFormat: '12h' };
        start.tasks.push({ id: 'timed', title: 'Timed', status: 'next', tags: [], contexts: [],
            dueDate: '2026-09-30T15:30:00.000Z', createdAt: AT, updatedAt: AT });
        const env = await open(start);
        const dueLabel = () => {
            const view = env.host.getTaskView({ id: 'timed' });
            if (!view.ok) throw new Error(JSON.stringify(view));
            const row = view.value.rows.find((item) => item.type === 'field' && item.field === 'dueDate');
            if (!row || row.type !== 'field') throw new Error('Due date row missing');
            return row.value;
        };
        const original = dueLabel();
        const date = await planned(env, { type: 'dateFormat', value: 'dmy' });
        expect(await env.host.commitPreparedGeneralPreference(date.envelope)).toMatchObject({ ok: true });
        const dateChanged = dueLabel();
        expect(dateChanged).not.toBe(original);
        const time = await planned(env, { type: 'timeFormat', value: '24h' });
        expect(await env.host.commitPreparedGeneralPreference(time.envelope)).toMatchObject({ ok: true });
        expect(dueLabel()).not.toBe(dateChanged);
    });

    it('builds options from one fresh saved Settings baseline and refreshes independent raw row changes on commit', async () => {
        const start = initial();
        start.tasks.push({ id: 'live', title: 'Live', status: 'next', contexts: [], tags: [],
            description: 'old', createdAt: AT, updatedAt: AT });
        start.projects.push({ id: 'project', title: 'Old project', status: 'active', color: '#abcdef',
            order: 0, tagIds: [], createdAt: AT, updatedAt: AT });
        const env = await open(start);
        env.changeSaved((data) => ({ ...data,
            tasks: data.tasks.map((row) => row.id === 'live' ? { ...row, description: 'fresh from disk' } : row),
            projects: data.projects.map((row) => row.id === 'project' ? { ...row, title: 'Fresh project' } : row),
            settings: { ...data.settings, weekStart: 'saturday' } }));
        const options = await env.host.getGeneralPreferenceOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.expected.weekStart).toMatchObject({ present: true, value: 'saturday' });
        expect(options.value.model.regional.weekStart.options.find((row) => row.value === 'saturday')?.selected).toBe(true);
        const { envelope } = await planned(env, { type: 'quickAccessView', value: 'contexts' });
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._allTasks.find((row) => row.id === 'live')?.description).toBe('fresh from disk');
        expect(useTaskStore.getState()._allProjects.find((row) => row.id === 'project')?.title).toBe('Fresh project');
        expect(useTaskStore.getState()._allTasks.find((row) => row.id === 'terminal')?.focusOrder).toBeUndefined();
        expect(env.data().tasks.find((row) => row.id === 'terminal')?.focusOrder).toBe(9);
        expect(env.data().settings.weekStart).toBe('saturday');
    });

    it('refuses relevant field/group changes, including independent same-destination and ABA', async () => {
        const env = await open(initial());
        const { envelope, prepared } = await planned(env, { type: 'timeFormat', value: '24h' });
        const commit = () => env.host.commitPreparedGeneralPreference(envelope);
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings, timeFormat: '24h',
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt, language: '2026-09-02T00:00:00.000Z' } } }));
        expect(await commit()).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings, timeFormat: undefined,
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt, language: '2026-09-02T00:00:00.000Z' } } }));
        expect(await commit()).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings, timeFormat: '24h',
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt, language: prepared.after.stamp } } }));
        // The exact planned scalar/stamp is the only persisted receipt this bounded command permits.
        expect(await commit()).toMatchObject({ ok: true });
        expect(env.saves()).toBe(0);
    });

    it('rejects forged cold payloads and treats no-journal outcomes as unknown', async () => {
        const env = await open(initial());
        const { request, envelope } = await planned(env, { type: 'dateFormat', value: 'mdy' });
        const bad = structuredClone(envelope);
        bad.prepared.after.stamp = '2026-01-01T00:00:00.000Z';
        expect(env.host.validatePreparedGeneralPreference(bad)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const extra = { ...envelope, prepared: { ...envelope.prepared, extra: true } };
        expect(env.host.validatePreparedGeneralPreference(extra)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(env.host.probeGeneralPreferenceOutcome(request)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        const invalid = { ...request, edit: { type: 'appLock', value: true } };
        expect(await env.host.prepareGeneralPreference(invalid as never)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
    });

    it.each([
        { type: 'quickAccessView', value: 'contexts', group: 'appearance' },
        { type: 'calendarSystem', value: 'jalali', group: 'language' },
        { type: 'theme', value: 'material3-dark', group: 'appearance' },
        { type: 'language', value: 'fa', group: 'language' },
    ] as const)('retries frozen $type after a failed save even when locale changes', async ({ type, value, group }) => {
        let failing = false;
        const env = await open(initial(), () => failing);
        if (type === 'calendarSystem')
            expect(await env.host.setLanguage({ storedLanguage: 'fa', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        const { envelope } = await planned(env, { type, value });
        failing = true;
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        if (type === 'calendarSystem')
            expect(await env.host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        failing = false;
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: true });
        expect(env.data().settings.syncPreferencesUpdatedAt?.[group]).toBe(envelope.prepared.after.stamp);
        expect(env.data().tasks).toEqual(initial().tasks);
    });

    it.each([
        { timing: 'synchronous', type: 'quickAccessView', value: 'contexts' },
        { timing: 'microtask', type: 'quickAccessView', value: 'contexts' },
        { timing: 'synchronous', type: 'calendarSystem', value: 'jalali' },
        { timing: 'microtask', type: 'calendarSystem', value: 'jalali' },
        { timing: 'synchronous', type: 'theme', value: 'nord' },
        { timing: 'microtask', type: 'theme', value: 'nord' },
        { timing: 'synchronous', type: 'language', value: 'fa' },
        { timing: 'microtask', type: 'language', value: 'fa' },
    ] as const)('does not claim a $timing foreign failed Task save for $type', async ({ timing, type, value }) => {
        let failing = false;
        const start = initial();
        start.tasks.push({ id: 'foreign', title: 'Foreign', status: 'next', contexts: [], tags: [],
            description: 'before', createdAt: AT, updatedAt: AT });
        const env = await open(start, () => failing);
        if (type === 'calendarSystem')
            expect(await env.host.setLanguage({ storedLanguage: 'fa', systemLocale: 'en-US' })).toMatchObject({ ok: true });
        const { envelope } = await planned(env, { type, value });
        const before = structuredClone(env.data());
        let armed = true;
        let foreign: Promise<unknown> | undefined;
        const unsubscribe = useTaskStore.subscribe((current, previous) => {
            if (!armed || current.settings === previous.settings) return;
            armed = false;
            const edit = () => { foreign = useTaskStore.getState().updateTask('foreign', { description: 'after' }); };
            if (timing === 'microtask') queueMicrotask(edit); else edit();
        });
        failing = true;
        try {
            expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: false,
                error: { code: 'SAVE_FAILED' } });
        } finally { unsubscribe(); }
        expect(await foreign).toMatchObject({ success: true });
        expect(env.data()).toEqual(before);
        failing = false;
        expect(await env.host.commitPreparedGeneralPreference(envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
    });
});
