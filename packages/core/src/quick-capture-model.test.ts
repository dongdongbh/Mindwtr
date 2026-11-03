import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTranslations } from './i18n/i18n-loader';
import { createNativeHostContract } from './native-host-contract';
import {
    loadQuickCaptureFixture,
    projectQuickCaptureObservation,
    replayQuickCaptureScenario,
    seedQuickCaptureStore,
} from './quick-capture-model.replay';
import { safeFormatDate } from './date';
import { buildQuickAddParseOptions } from './quick-add';
import {
    applyQuickCaptureEdit,
    buildQuickCaptureContextPicker,
    buildQuickCaptureView,
    createQuickCaptureOptions,
    getQuickCaptureContextPicker,
    normalizeQuickCaptureContext,
    parseQuickCaptureContextQuery,
    saveQuickCapture,
    saveQuickCaptureBulk,
    type QuickCaptureContext,
    type QuickCaptureEdit,
    type QuickCaptureOptions,
} from './quick-capture-model';
import type { Area, Project, Task } from './types';
import { resetForTests } from './store';

const fixture = loadQuickCaptureFixture();

const contractScenarios = fixture.scenarios.filter((scenario) => !scenario.initialProps && scenario.initialValue === undefined);

describe('capture popup parity with the frozen React Native fixture', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        const strings = await loadTranslations('en');
        t = (key) => strings[key] ?? key;
    });
    afterAll(() => {
        vi.useRealTimers();
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    const expected = (name: string) => fixture.observations[name].map(projectQuickCaptureObservation);

    it('was captured from React Native before the popup changed', () => {
        expect(fixture.provenance.capturedAt).toMatch(/^[0-9a-f]{40}$/);
        expect(fixture.scenarios.length).toBe(Object.keys(fixture.observations).length);

        expect(contractScenarios.length).toBeGreaterThanOrEqual(fixture.scenarios.length - 6);
    });

    for (const scenario of fixture.scenarios) {
        it(`core reproduces "${scenario.name}"`, async () => {
            const recorder = await seedQuickCaptureStore(fixture, scenario);
            const observed = await replayQuickCaptureScenario({ fixture, scenario, recorder, t });
            expect(observed).toEqual(expected(scenario.name));
        });
    }

    for (const scenario of contractScenarios) {
        it(`the native host contract reproduces "${scenario.name}"`, async () => {
            const recorder = await seedQuickCaptureStore(fixture, scenario);
            const contract = createNativeHostContract();
            expect((await contract.setLanguage({ storedLanguage: 'en', systemLocale: null })).ok).toBe(true);
            expect((await contract.activate({ writeSafetyReady: true })).ok).toBe(true);
            recorder.log.splice(0);
            const observed = await replayQuickCaptureScenario({ fixture, scenario, recorder, t, contract });
            expect(observed).toEqual(expected(scenario.name));
        });
    }
});

describe('capture popup model', () => {
    it('matches the current comma-separated context while keeping Add semantics', () => {
        const choices = ['@home'];
        const history = ['@archived'];
        expect(getQuickCaptureContextPicker(choices, '@home, arch', [], history)).toEqual({
            items: ['@archived'], addable: true,
        });
        expect(getQuickCaptureContextPicker(choices, '@home, ', [], history)).toEqual({
            items: ['@home'], addable: true,
        });
    });
    const context = {
        settings: {}, focusedCount: 0, defaultAreaId: 'a-home', contextChoices: ['@Phone'], t: (key: string) => key, now: new Date(2026, 8, 23, 10, 0),
    };
    const options = createQuickCaptureOptions({ projects: [], defaultAreaId: null });
    const edit = (current: QuickCaptureOptions, change: QuickCaptureEdit) => applyQuickCaptureEdit(current, change, context)!.options;

    it('normalizes picker contexts and splits the query on commas', () => {
        expect(normalizeQuickCaptureContext(' @Work ')).toBe('@Work');
        expect(normalizeQuickCaptureContext('＠home')).toBe('@home');
        expect(normalizeQuickCaptureContext('@@')).toBe('');
        expect(parseQuickCaptureContextQuery(' @work,home,@Work,, ＠errands ')).toEqual(['@work', '@home', '@errands']);

        expect(edit({ ...options, contexts: ['@home'] }, { type: 'addContexts', query: 'phone, HOME, desk' }).contexts)
            .toEqual(['@home', '@Phone', '@desk']);
    });

    it('offers keyboard submit for an already-selected context without duplicating it', () => {
        const selected = { ...options, contexts: ['@Phone'] };
        const picker = buildQuickCaptureContextPicker(selected, context, ' phone ', ['@Phone']);
        expect(picker.add).toBeNull();
        expect(picker.submit).toEqual({ type: 'addContexts', query: ' phone ' });
        expect(edit(selected, picker.submit!).contexts).toEqual(['@Phone']);
        expect(buildQuickCaptureContextPicker(selected, context, ' @@, ', ['@Phone']).submit).toBeNull();
    });

    it('keeps a chosen time when the day changes, and clears it to local midnight', () => {
        const timed = edit(edit(options, { type: 'setDueDay', day: '2026-10-05' }), { type: 'setDueTime', time: '15:30' });
        expect(timed).toMatchObject({ dueDate: new Date(2026, 9, 5, 15, 30).toISOString(), dueDateHasTime: true });
        expect(edit(timed, { type: 'setDueDay', day: '2026-10-09' }).dueDate).toBe(new Date(2026, 9, 9, 15, 30).toISOString());
        expect(edit(timed, { type: 'clearDueTime' })).toMatchObject({ dueDate: new Date(2026, 9, 5).toISOString(), dueDateHasTime: false });
        expect(edit(options, { type: 'setDueTime', time: '07:00' }).dueDate).toBe(new Date(2026, 8, 23, 7, 0).toISOString());
        expect(applyQuickCaptureEdit(options, { type: 'setDueTime', time: '7:00' }, context)).toBeNull();
    });

    it('keeps one container: a project clears the area, and resetting the project restores the default area', () => {
        const inProject = edit({ ...options, areaId: 'a-work' }, { type: 'selectProject', projectId: 'p-launch' });
        expect(inProject).toMatchObject({ projectId: 'p-launch', areaId: null });
        expect(edit(inProject, { type: 'resetProject' })).toMatchObject({ projectId: null, areaId: 'a-home' });
        expect(edit(inProject, { type: 'selectArea', areaId: 'a-work' })).toMatchObject({ projectId: null, areaId: 'a-work' });
        expect(edit(inProject, { type: 'selectArea', areaId: null })).toMatchObject({ projectId: 'p-launch', areaId: null });
    });
});

describe('capture popup save: what the popup shows is what is saved', () => {
    const at = '2026-09-01T12:00:00.000Z';
    const projects: Project[] = [
        { id: 'p-home', title: 'Home Repairs', status: 'active', color: '#94a3b8', order: 0, tagIds: [], createdAt: at, updatedAt: at, areaId: 'a-home' },
        { id: 'p-old', title: 'Old stuff', status: 'archived', color: '#94a3b8', order: 1, tagIds: [], createdAt: at, updatedAt: at },
        { id: 'p-gone', title: 'Removed', status: 'active', color: '#94a3b8', order: 2, tagIds: [], createdAt: at, updatedAt: at, deletedAt: at },
    ];
    const areas: Area[] = [{ id: 'a-home', name: 'Home', color: '#16a34a', order: 0, createdAt: at, updatedAt: at }];
    const contextFor = (initialProps: Partial<Task>, settings: QuickCaptureContext['settings'] = {}): QuickCaptureContext => ({
        settings,
        projects: projects.filter((project) => !project.deletedAt),
        areas,
        parseOptions: buildQuickAddParseOptions(settings, {}),
        focusedCount: 0,
        defaultAreaId: null,
        initialProps,
        t: (key) => key,
        formatDate: safeFormatDate,
        now: new Date(2026, 8, 23, 10, 0),
    });
    const save = async (initialProps: Partial<Task>, settings: QuickCaptureContext['settings'] = {}, change?: (options: QuickCaptureOptions) => QuickCaptureOptions) => {
        const context = contextFor(initialProps, settings);
        const shown = createQuickCaptureOptions({ initialProps, projects: context.projects, defaultAreaId: null });
        const addTask = vi.fn(async () => ({ success: true, id: 'task-1' }));
        const addProject = vi.fn(async () => null);
        await saveQuickCapture({ text: 'Fix fence', options: change ? change(shown) : shown, context, actions: { addTask, addProject } });
        return { shown, props: (addTask.mock.calls[0] as unknown[] | undefined)?.[1] as Partial<Task> };
    };

    it('does not save a preset project the popup dropped (archived or deleted); it saves the area it shows', async () => {
        for (const projectId of ['p-old', 'p-gone']) {
            const { shown, props } = await save({ projectId, areaId: 'a-home', status: 'next' });
            expect(shown).toMatchObject({ projectId: null, areaId: 'a-home' });
            expect(props.projectId).toBeUndefined();
            expect(props).toMatchObject({ areaId: 'a-home', status: 'next' });
        }

        expect((await save({ projectId: 'p-home', status: 'next' })).props).toMatchObject({ projectId: 'p-home', status: 'next' });
    });

    it('does not save a preset priority while Priorities are off, nor one the popup cleared', async () => {
        expect((await save({ priority: 'high' }, { features: { priorities: false } })).props.priority).toBeUndefined();
        expect((await save({ priority: 'high' })).props.priority).toBe('high');
        expect((await save({ priority: 'high' }, {}, (options) => ({ ...options, priority: null }))).props.priority).toBeUndefined();
    });

    it('does not save a preset project, due date, star or context the popup cleared', async () => {
        const { props } = await save(
            { projectId: 'p-home', dueDate: '2026-09-30', isFocusedToday: true, contexts: ['@home', 'errands'] },
            {},
            (options) => ({ ...options, projectId: null, areaId: null, dueDate: null, focus: false, contexts: ['@home'] }),
        );
        expect(props.projectId).toBeUndefined();
        expect(props.dueDate).toBeUndefined();
        expect(props.isFocusedToday).toBeUndefined();
        expect(props.contexts).toEqual(['@home']);
    });

    it('opens the date and time pickers where mobile does: on the due date, or on today', () => {
        const context = contextFor({});
        const blank = createQuickCaptureOptions({ projects, defaultAreaId: null });
        expect(buildQuickCaptureView('Fix fence', blank, context).due).toMatchObject({ custom: { startDay: '2026-09-23' }, time: null });
        const timed = { ...blank, dueDate: new Date(2026, 9, 5, 14, 30).toISOString(), dueDateHasTime: true };
        expect(buildQuickCaptureView('Fix fence', timed, context).due).toMatchObject({ custom: { startDay: '2026-10-05' }, time: { start: '14:30' } });
        const dateOnly = { ...blank, dueDate: new Date(2026, 9, 5).toISOString(), dueDateHasTime: false };
        expect(buildQuickCaptureView('Fix fence', dateOnly, context).due).toMatchObject({ custom: { startDay: '2026-10-05' }, time: { start: '00:00' } });
    });

    it('checks every line of a batch before it writes anything', async () => {
        const context = contextFor({});
        const addProject = vi.fn(async (title: string) => ({ ...projects[0], id: 'p-new', title }));
        const addTasks = vi.fn(async () => ({ success: true, ids: [] }));
        const outcome = await saveQuickCaptureBulk({
            lines: ['Plan beds +Garden', 'Pay rent /due:whenever'],
            options: createQuickCaptureOptions({ projects, defaultAreaId: null }),
            context,
            actions: { addProject, addTasks },
        });
        expect(outcome).toEqual({
            kind: 'refused',
            notice: { tone: 'warning', title: 'common.notice', message: 'quickAdd.invalidDateCommand: /due:whenever', durationMs: 4200 },
        });
        expect(addProject).not.toHaveBeenCalled();
        expect(addTasks).not.toHaveBeenCalled();
    });
});
