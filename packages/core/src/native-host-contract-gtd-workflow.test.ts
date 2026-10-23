import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeHostContract } from './native-host-contract';
import { canStarNewCapture } from './focus-star';
import { normalizeFocusTaskLimit } from './focus-utils';
import { DEFAULT_TASK_EDITOR_HIDDEN, DEFAULT_TASK_EDITOR_ORDER, TASK_EDITOR_SECTIONABLE_FIELDS } from './task-editor-layout';
import { getProcessInboxDefaultScheduleTime } from './process-inbox-model';
import { createQuickCaptureOptions, resolveQuickCaptureDefaultAreaId } from './quick-capture-model';
import type { GtdWorkflowEdit, NativeGtdWorkflowRequest } from './native-host-contract-gtd-workflow';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Area, Task } from './types';
import { generateUUID } from './uuid';
import { buildGtdSettingsModel, resolveGtdPomodoroDurations } from './gtd-settings-model';

const ID = '00000000-0000-4000-8000-000000000103';
const AT = '2026-09-01T00:00:00.000Z';
const terminal: Task = { id: 'gtd-terminal', title: 'Terminal', status: 'done', tags: [], contexts: [],
    focusOrder: 9, deletedAt: AT, createdAt: AT, updatedAt: AT, rev: 7 };
const workArea: Area = { id: 'area-work', name: 'Work', order: 0, createdAt: AT, updatedAt: AT, rev: 1, revBy: 'gtd-device' };
const homeArea: Area = { id: 'area-home', name: 'Home', order: 1, createdAt: AT, updatedAt: AT };
const initial = (): AppData => ({ tasks: [terminal], projects: [], sections: [], areas: [], people: [],
    settings: { deviceId: 'gtd-device', gtd: { focusGroupBy: 'project', legacySibling: { marker: 103 } },
        syncPreferencesUpdatedAt: { gtd: AT, appearance: AT },
        ai: { apiKey: 'private-value', baseUrl: 'https://private.invalid/x' } } as AppData['settings'] });

async function open(start: AppData, fail?: () => boolean, failRead?: () => boolean) {
    await flushPendingSave(); resetForTests();
    let data = structuredClone(start);
    let saves = 0;
    let reads = 0;
    const adapter = { getData: async () => {
        reads += 1;
        if (failRead?.()) throw new Error('read unavailable');
        return structuredClone(data);
    }, saveData: async (next: AppData) => {
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
    await flushPendingSave(); data = structuredClone(start); saves = 0; reads = 0;
    return { host, data: () => data, saves: () => saves, reads: () => reads,
        changeSaved: (fn: (data: AppData) => AppData) => { data = fn(data); },
        reopen: async () => open(data, fail) };
}

async function planned(env: Awaited<ReturnType<typeof open>>,
    edit: Extract<GtdWorkflowEdit, { type: 'defaultScheduleTime' | 'focusTaskLimit' | 'focusIncludeStartDates' | 'defaultProjectFlowMode' }>) {
    const options = await env.host.getGtdWorkflowOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit, expected: options.value.expected[edit.type] };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

async function plannedPomodoro(env: Awaited<ReturnType<typeof open>>,
    edit: Extract<GtdWorkflowEdit, { type: 'pomodoro' | 'pomodoroLinkTask' | 'pomodoroAutoStartBreaks'
        | 'pomodoroAutoStartFocus' | 'pomodoroCompletionAlert' | 'pomodoroDurations' }>) {
    const options = await env.host.getGtdPomodoroOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const expected = options.value.expected[edit.type];
    if (!expected) throw new Error('Selected Pomodoro setting is unavailable');
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit, expected };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

async function plannedArchive(env: Awaited<ReturnType<typeof open>>, value: number) {
    const options = await env.host.getGtdArchiveOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'autoArchiveDays', value }, expected: options.value.expected };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

async function plannedReview(env: Awaited<ReturnType<typeof open>>,
    edit: { type: 'dailyReviewFocusStep' | 'weeklyReviewContextStep'; value: boolean }) {
    const options = await env.host.getGtdReviewOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit, expected: options.value.expected[edit.type] };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

type InboxType = 'inboxTwoMinute' | 'inboxProjectFirst' | 'inboxContextStep' | 'inboxSchedule';
const inboxField: Record<InboxType, string> = {
    inboxTwoMinute: 'twoMinuteEnabled', inboxProjectFirst: 'projectFirst',
    inboxContextStep: 'contextStepEnabled', inboxSchedule: 'scheduleEnabled',
};
const inboxToggle = { inboxTwoMinute: 'twoMinute', inboxProjectFirst: 'projectFirst',
    inboxContextStep: 'contextStep', inboxSchedule: 'schedule' } as const;
async function plannedInbox(env: Awaited<ReturnType<typeof open>>,
    edit: { type: InboxType; value: boolean }) {
    const options = await env.host.getGtdInboxOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit, expected: options.value.expected[edit.type] };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

async function plannedArea(env: Awaited<ReturnType<typeof open>>, value: string) {
    const options = await env.host.getGtdCaptureAreaOptions({ offset: 0, limit: 50 });
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit: { type: 'defaultArea', value },
        expected: options.value.expected };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

type CaptureParseType = 'quickAddAutoClean' | 'naturalLanguageDates';
async function plannedCaptureParse(env: Awaited<ReturnType<typeof open>>,
    edit: { type: CaptureParseType; value: boolean }) {
    const options = await env.host.getGtdCaptureParseOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID, edit, expected: options.value.expected[edit.type] };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

type EditorSection = 'scheduling' | 'organization' | 'details';
async function plannedEditorSection(env: Awaited<ReturnType<typeof open>>, section: EditorSection, value: boolean) {
    const options = await env.host.getGtdTaskEditorOpenOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'taskEditorSectionOpen', section, value }, expected: options.value.expected[section] };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

async function plannedPreset(env: Awaited<ReturnType<typeof open>>, value: 'simple' | 'standard' | 'full') {
    const options = await env.host.getGtdTaskEditorPresetOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'taskEditorPreset', value }, expected: options.value.expected };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

async function plannedReset(env: Awaited<ReturnType<typeof open>>, requestId = generateUUID()) {
    const options = await env.host.getGtdTaskEditorPresetOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId, edit: { type: 'taskEditorReset' },
        expected: options.value.expected };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

async function plannedField(env: Awaited<ReturnType<typeof open>>, field: 'description' | 'priority', value: boolean) {
    const options = await env.host.getGtdTaskEditorFieldOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId: ID,
        edit: { type: 'taskEditorFieldVisible', field, value }, expected: options.value.expected };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

async function plannedSection(env: Awaited<ReturnType<typeof open>>,
    field: 'description', value: 'basic' | 'scheduling' | 'details', requestId = generateUUID()) {
    const options = await env.host.getGtdTaskEditorFieldOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const request: NativeGtdWorkflowRequest = { requestId,
        edit: { type: 'taskEditorFieldSection', field, value }, expected: options.value.expected };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

async function plannedOrder(env: Awaited<ReturnType<typeof open>>, field: 'status' | 'priority' | 'description',
    direction: 'moveUp' | 'moveDown', requestId = generateUUID()) {
    const options = await env.host.getGtdTaskEditorFieldOptions({});
    if (!options.ok) throw new Error(JSON.stringify(options));
    const row = options.value.taskEditor.groups.flatMap((group) => group.fields)
        .find((entry) => entry.id === field);
    const offered = row?.sheet.order[direction].edit;
    if (!offered || offered.type !== 'taskEditorOrder') throw new Error('Expected an offered shared move');
    const request: NativeGtdWorkflowRequest = { requestId,
        edit: { type: 'taskEditorOrder', field, value: offered.value }, expected: options.value.expected };
    const plan = await env.host.prepareGtdWorkflow(request);
    if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
    return { options: options.value, request, prepared: plan.value.prepared,
        envelope: { request, prepared: plan.value.prepared } };
}

afterEach(async () => { vi.useRealTimers(); await flushPendingSave(); resetForTests(); });

describe('prepared GTD Task Editor field order', () => {
    it('uses the shared offered within-group move across interleaved slots, retaining tasks and fold defaults', async () => {
        const start = initial();
        const interleaved = ['status', 'startTime', ...DEFAULT_TASK_EDITOR_ORDER.filter((id) =>
            id !== 'status' && id !== 'startTime')] as typeof DEFAULT_TASK_EDITOR_ORDER;
        start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            order: interleaved, hidden: [...DEFAULT_TASK_EDITOR_HIDDEN], sections: {}, sectionOpen: { scheduling: true },
            legacy: 'keep' } as never };
        const env = await open(start);
        const first = await env.host.getGtdTaskEditorFieldOptions({});
        if (!first.ok) throw new Error(JSON.stringify(first));
        const status = first.value.taskEditor.groups.flatMap((group) => group.fields)
            .find((row) => row.id === 'status');
        expect(status?.sheet.order.moveUp).toMatchObject({ disabled: true, edit: null });
        expect(status?.sheet.order.moveDown).toMatchObject({ disabled: false,
            edit: { type: 'taskEditorOrder' } });
        expect(status?.sheet.order.moveDown.edit?.value).toEqual([
            'project', 'startTime', 'status', ...interleaved.slice(3)]);
        const planned = await plannedOrder(env, 'status', 'moveDown');
        expect(new TextEncoder().encode(JSON.stringify(first.value)).length).toBeLessThanOrEqual(65_536);
        expect(new TextEncoder().encode(JSON.stringify(planned.envelope)).length).toBeLessThanOrEqual(8192);
        expect(planned.prepared.result).toEqual({ type: 'taskEditorOrder', field: 'status',
            value: planned.request.edit.value, changed: true });
        expect(planned.prepared.after.selected?.order.value).toEqual(planned.request.edit.value);
        expect(env.host.validatePreparedGtdWorkflow(planned.envelope)).toEqual({ ok: true,
            value: planned.prepared.result });
        expect(await env.host.commitPreparedGtdWorkflow(planned.envelope)).toEqual({ ok: true,
            value: planned.prepared.result });
        expect(env.data().settings.gtd?.taskEditor?.order).toEqual(planned.request.edit.value);
        expect(env.data().settings.gtd?.taskEditor?.sections).toEqual({});
        expect(env.data().settings.gtd?.taskEditor?.sectionOpen).toEqual({ scheduling: true });
        expect(env.data().settings.gtd?.taskEditor?.legacy).toBe('keep');
        expect(env.data().tasks).toEqual(start.tasks);
        const next = await env.host.getGtdTaskEditorFieldOptions({});
        if (!next.ok) throw new Error(JSON.stringify(next));
        expect(next.value.taskEditor.expandedResetKey).toBe(first.value.taskEditor.expandedResetKey);
        expect(next.value.taskEditor.groups.flatMap((group) => group.fields)
            .find((row) => row.id === 'status')?.sheet.order.moveUp.disabled).toBe(false);
    });

    it('materializes a partial legacy order while keeping hidden feature-off fields orderable', async () => {
        const start = initial(); start.settings.features = { priorities: false, timeEstimates: false };
        start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            order: ['status', 'project', 'priority'], hidden: [...DEFAULT_TASK_EDITOR_HIDDEN] } };
        const env = await open(start);
        const planned = await plannedOrder(env, 'priority', 'moveDown');
        expect(planned.request.edit.value).toHaveLength(DEFAULT_TASK_EDITOR_ORDER.length);
        expect(new Set(planned.request.edit.value).size).toBe(DEFAULT_TASK_EDITOR_ORDER.length);
        expect(planned.request.edit.value[2]).toBe('tags');
        expect(planned.request.edit.value[10]).toBe('priority');
        expect(await env.host.commitPreparedGtdWorkflow(planned.envelope)).toEqual({ ok: true,
            value: planned.prepared.result });
        expect(env.data().settings.gtd?.taskEditor?.order).toEqual(planned.request.edit.value);
        expect(env.data().settings.features).toEqual(start.settings.features);
        expect(env.data().settings.gtd?.taskEditor?.hidden).toEqual(start.settings.gtd?.taskEditor?.hidden);
        expect(env.data().tasks).toEqual(start.tasks);
    });

    it('keeps the maximal one-group English move projection within existing byte limits', async () => {
        const start = initial(); start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            sections: Object.fromEntries(TASK_EDITOR_SECTIONABLE_FIELDS.map((field) => [field, 'basic'])) } as never };
        const env = await open(start);
        const planned = await plannedOrder(env, 'status', 'moveDown');
        expect(planned.options.taskEditor.groups.map((group) => [group.id, group.count]))
            .toEqual([['basic', DEFAULT_TASK_EDITOR_ORDER.length]]);
        expect(new TextEncoder().encode(JSON.stringify(planned.options)).length).toBeLessThanOrEqual(65_536);
        expect(new TextEncoder().encode(JSON.stringify(planned.envelope)).length).toBeLessThanOrEqual(8192);
        expect(env.saves()).toBe(0);
    });

    it('rejects boundary, wrong-field, cross-group, malformed, and same-order edits before saving', async () => {
        const env = await open(initial());
        const options = await env.host.getGtdTaskEditorFieldOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const rows = options.value.taskEditor.groups.flatMap((group) => group.fields);
        const status = rows.find((row) => row.id === 'status');
        const location = rows.find((row) => row.id === 'location');
        expect(location?.sheet.order.moveDown).toMatchObject({ disabled: true, edit: null });
        const down = status?.sheet.order.moveDown.edit;
        if (!down || down.type !== 'taskEditorOrder') throw new Error('Expected shared Status move');
        const current = [...DEFAULT_TASK_EDITOR_ORDER];
        const crossGroup = [...current]; [crossGroup[0], crossGroup[6]] = [crossGroup[6], crossGroup[0]];
        const duplicate = [...down.value]; duplicate[1] = duplicate[0];
        for (const edit of [
            { type: 'taskEditorOrder', field: 'status', value: current },
            { type: 'taskEditorOrder', field: 'description', value: down.value },
            { type: 'taskEditorOrder', field: 'status', value: crossGroup },
            { type: 'taskEditorOrder', field: 'status', value: duplicate },
            { type: 'taskEditorOrder', field: 'status', value: down.value.slice(1) },
            { type: 'taskEditorOrder', field: 'status', value: [...down.value, 'status'] },
            { type: 'taskEditorOrder', field: 'status', value: [...down.value.slice(0, -1), 'unknown'] },
            { type: 'taskEditorOrder', field: 'textDirection', value: down.value },
            { type: 'taskEditorOrder', field: 'status', value: down.value, direction: 'down' },
        ]) expect(await env.host.prepareGtdWorkflow({ requestId: generateUUID(), edit,
            expected: options.value.expected })).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);
    });

    it('recomputes a field\'s offered boundaries after a shared section reassignment', async () => {
        const env = await open(initial());
        const before = await env.host.getGtdTaskEditorFieldOptions({});
        if (!before.ok) throw new Error(JSON.stringify(before));
        const descriptionBefore = before.value.taskEditor.groups.flatMap((group) => group.fields)
            .find((row) => row.id === 'description');
        expect(descriptionBefore?.sheet.order.moveUp).toMatchObject({ disabled: true, edit: null });
        expect(descriptionBefore?.sheet.order.moveDown.disabled).toBe(false);
        const section = await plannedSection(env, 'description', 'scheduling');
        expect(await env.host.commitPreparedGtdWorkflow(section.envelope)).toEqual({ ok: true,
            value: section.prepared.result });
        const after = await env.host.getGtdTaskEditorFieldOptions({});
        if (!after.ok) throw new Error(JSON.stringify(after));
        const descriptionAfter = after.value.taskEditor.groups.flatMap((group) => group.fields)
            .find((row) => row.id === 'description');
        expect(descriptionAfter?.sheet.order.moveUp.disabled).toBe(false);
        expect(descriptionAfter?.sheet.order.moveDown).toMatchObject({ disabled: true, edit: null });
        expect(after.value.taskEditor.expandedResetKey).toBe(before.value.taskEditor.expandedResetKey);
    });

    it('rejects forged frozen results and receipts, plus stale layout, feature, and stamp witnesses', async () => {
        const env = await open(initial());
        const { envelope } = await plannedOrder(env, 'status', 'moveDown');
        for (const mutate of [
            (copy: typeof envelope) => { copy.prepared.after.value = [...DEFAULT_TASK_EDITOR_ORDER]; },
            (copy: typeof envelope) => { copy.prepared.after.selected!.order.value = [...DEFAULT_TASK_EDITOR_ORDER]; },
            (copy: typeof envelope) => { copy.prepared.result.field = 'description'; },
            (copy: typeof envelope) => { copy.prepared.result.value = [...DEFAULT_TASK_EDITOR_ORDER]; },
            (copy: typeof envelope) => { copy.prepared.request.edit.field = 'description'; },
        ]) {
            const forged = structuredClone(envelope); mutate(forged);
            expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await env.host.commitPreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        expect(env.saves()).toBe(0);
        for (const change of [
            (data: AppData) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
                taskEditor: { ...data.settings.gtd?.taskEditor, order: [...DEFAULT_TASK_EDITOR_ORDER].reverse() } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
                taskEditor: { ...data.settings.gtd?.taskEditor, hidden: ['description'] } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
                taskEditor: { ...data.settings.gtd?.taskEditor, sections: { description: 'basic' as const } } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
                taskEditor: { ...data.settings.gtd?.taskEditor, sectionOpen: { details: true } } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                features: { ...data.settings.features, priorities: true } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                    gtd: '2026-09-02T00:00:00.000Z' } } }),
        ]) {
            const other = await open(initial());
            const planned = await plannedOrder(other, 'status', 'moveDown');
            other.changeSaved(change);
            expect(await other.host.commitPreparedGtdWorkflow(planned.envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(other.saves()).toBe(0);
        }
    });

    it('cold-replays one exact order receipt while preserving later unrelated task and settings changes', async () => {
        const env = await open(initial());
        const { envelope, prepared } = await plannedOrder(env, 'status', 'moveDown');
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        env.changeSaved((data) => ({ ...data, tasks: data.tasks.map((task) => ({ ...task, title: 'later edit' })),
            settings: { ...data.settings, language: 'ko', gtd: { ...data.settings.gtd,
                legacySibling: { marker: 145 } } } }));
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
        expect(cold.data().tasks[0].title).toBe('later edit');
        expect(cold.data().settings.language).toBe('ko');
        expect(cold.data().settings.gtd?.legacySibling).toEqual({ marker: 145 });
    });
});

describe('GTD Task Editor field-options RN expansion metadata', () => {
    it('projects default and saved fold states, raw reset keys, and visible group counts without saving', async () => {
        const env = await open(initial());
        const defaults = await env.host.getGtdTaskEditorFieldOptions({});
        if (!defaults.ok) throw new Error(JSON.stringify(defaults));
        expect(defaults.value.taskEditor.initiallyExpanded).toEqual({ basic: true,
            scheduling: false, organization: false, details: false });
        expect(defaults.value.taskEditor.expandedResetKey).toBe('[null,null,null]');
        expect(defaults.value.taskEditor.groups.reduce((sum, group) => sum + group.count, 0))
            .toBe(DEFAULT_TASK_EDITOR_ORDER.length);
        for (const group of defaults.value.taskEditor.groups) expect(group.count).toBe(group.fields.length);
        expect(env.saves()).toBe(0);

        env.changeSaved((data) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
            taskEditor: { sectionOpen: { scheduling: true, organization: false, details: true } } } } }));
        const custom = await env.host.getGtdTaskEditorFieldOptions({});
        if (!custom.ok) throw new Error(JSON.stringify(custom));
        expect(custom.value.taskEditor.initiallyExpanded).toEqual({ basic: true,
            scheduling: true, organization: false, details: true });
        expect(custom.value.taskEditor.expandedResetKey).toBe('[true,false,true]');
        expect(env.saves()).toBe(0);
    });

    it('changes reset key for an explicit default, keeps omitted groups in fold state, and ignores field moves', async () => {
        const start = initial(); start.settings.gtd = { ...start.settings.gtd,
            taskEditor: { sections: Object.fromEntries(TASK_EDITOR_SECTIONABLE_FIELDS.map((field) => [field, 'basic'])),
                sectionOpen: { scheduling: true, details: false } } as never };
        const empty = await open(start);
        const first = await empty.host.getGtdTaskEditorFieldOptions({});
        if (!first.ok) throw new Error(JSON.stringify(first));
        expect(first.value.taskEditor.groups.map((group) => [group.id, group.count]))
            .toEqual([['basic', DEFAULT_TASK_EDITOR_ORDER.length]]);
        expect(first.value.taskEditor.initiallyExpanded).toEqual({ basic: true,
            scheduling: true, organization: false, details: false });
        expect(first.value.taskEditor.expandedResetKey).toBe('[true,null,false]');
        empty.changeSaved((data) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
            taskEditor: { ...data.settings.gtd?.taskEditor,
                sectionOpen: { scheduling: true, organization: false, details: false } } } } }));
        const explicitDefault = await empty.host.getGtdTaskEditorFieldOptions({});
        if (!explicitDefault.ok) throw new Error(JSON.stringify(explicitDefault));
        expect(explicitDefault.value.taskEditor.initiallyExpanded).toEqual(first.value.taskEditor.initiallyExpanded);
        expect(explicitDefault.value.taskEditor.expandedResetKey).toBe('[true,false,false]');
        expect(empty.saves()).toBe(0);

        const moved = await open(initial());
        const original = await moved.host.getGtdTaskEditorFieldOptions({});
        if (!original.ok) throw new Error(JSON.stringify(original));
        const section = await plannedSection(moved, 'description', 'scheduling');
        expect(await moved.host.commitPreparedGtdWorkflow(section.envelope)).toEqual({ ok: true,
            value: section.prepared.result });
        const afterMove = await moved.host.getGtdTaskEditorFieldOptions({});
        if (!afterMove.ok) throw new Error(JSON.stringify(afterMove));
        expect(afterMove.value.taskEditor.expandedResetKey).toBe(original.value.taskEditor.expandedResetKey);
        expect(afterMove.value.taskEditor.initiallyExpanded).toEqual(original.value.taskEditor.initiallyExpanded);
        expect(afterMove.value.taskEditor.groups.find((group) => group.id === 'scheduling')?.count)
            .toBe((original.value.taskEditor.groups.find((group) => group.id === 'scheduling')?.count ?? 0) + 1);
        const visible = await plannedField(moved, 'description', false);
        expect(await moved.host.commitPreparedGtdWorkflow(visible.envelope)).toEqual({ ok: true,
            value: visible.prepared.result });
        const afterHide = await moved.host.getGtdTaskEditorFieldOptions({});
        if (!afterHide.ok) throw new Error(JSON.stringify(afterHide));
        expect(afterHide.value.taskEditor.expandedResetKey).toBe(original.value.taskEditor.expandedResetKey);
        expect(afterHide.value.taskEditor.groups.find((group) => group.id === 'scheduling')?.count)
            .toBe(afterMove.value.taskEditor.groups.find((group) => group.id === 'scheduling')?.count);
        expect(moved.saves()).toBe(2);
    });
});

describe('prepared GTD Task Editor field section assignment', () => {
    it('moves Description to Scheduling and restores its default Details assignment', async () => {
        const start = initial();
        start.tasks.push({ id: 'section-editor', title: 'Section editor', status: 'next',
            tags: [], contexts: [], createdAt: AT, updatedAt: AT });
        start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            order: [...DEFAULT_TASK_EDITOR_ORDER], hidden: [...DEFAULT_TASK_EDITOR_HIDDEN],
            sections: {}, sectionOpen: {}, legacy: 'keep' } as never };
        start.settings.features = { priorities: false, timeEstimates: false };
        const env = await open(start);
        const first = await plannedSection(env, 'description', 'scheduling');
        const field = first.options.taskEditor.groups.flatMap((group) => group.fields)
            .find((row) => row.id === 'description');
        expect(field?.sheet.sections?.options.map((row) => row.value)).toEqual([
            'basic', 'scheduling', 'organization', 'details']);
        expect(field?.sheet.sections?.options.find((row) => row.selected)?.value).toBe('details');
        expect(first.prepared.result).toEqual({ type: 'taskEditorFieldSection',
            field: 'description', value: 'scheduling', changed: true });
        expect(first.prepared.after.selected?.sections.value).toEqual({ description: 'scheduling' });
        expect(env.host.validatePreparedGtdWorkflow(first.envelope)).toEqual({ ok: true,
            value: first.prepared.result });
        expect(await env.host.commitPreparedGtdWorkflow(first.envelope)).toEqual({ ok: true,
            value: first.prepared.result });
        expect(env.data().settings.gtd?.taskEditor).toEqual({ ...start.settings.gtd?.taskEditor,
            sections: { description: 'scheduling' } });
        expect(env.data().tasks).toEqual(start.tasks);
        const editor = env.host.getTaskEditorModel({ id: 'section-editor' });
        if (!editor.ok) throw new Error(JSON.stringify(editor));
        expect(editor.value.layout.sections.find((group) => group.id === 'scheduling')?.fields)
            .toContain('description');
        const second = await plannedSection(env, 'description', 'details');
        expect(second.options.taskEditor.groups.find((group) => group.id === 'scheduling')?.fields
            .some((row) => row.id === 'description')).toBe(true);
        expect(second.prepared.after.selected?.sections.value).toEqual({});
        expect(await env.host.commitPreparedGtdWorkflow(second.envelope)).toEqual({ ok: true,
            value: second.prepared.result });
        expect(env.data().settings.gtd?.taskEditor?.sections).toEqual({});
        expect(env.data().tasks).toEqual(start.tasks);
    });

    it('uses shared field sheets, permits Basic for sectionable fields, and refuses fixed or malformed moves', async () => {
        const env = await open(initial());
        const options = await env.host.getGtdTaskEditorFieldOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const fields = options.value.taskEditor.groups.flatMap((group) => group.fields);
        expect(fields).toHaveLength(DEFAULT_TASK_EDITOR_ORDER.length);
        for (const field of fields) {
            expect(field.sheet).toMatchObject({ title: field.label, visible: {
                edit: field.visibility.edit }, doneLabel: expect.any(String) });
            if (['status', 'project', 'section', 'area'].includes(field.id))
                expect(field.sheet.sections).toBeNull();
            else {
                expect(field.sheet.sections?.options.map((row) => row.value)).toEqual([
                    'basic', 'scheduling', 'organization', 'details']);
                for (const row of field.sheet.sections!.options)
                    expect(row.edit).toEqual({ type: 'taskEditorFieldSection', field: field.id, value: row.value });
            }
        }
        for (const edit of [
            { type: 'taskEditorFieldSection', field: 'status', value: 'scheduling' },
            { type: 'taskEditorFieldSection', field: 'project', value: 'details' },
            { type: 'taskEditorFieldSection', field: 'section', value: 'organization' },
            { type: 'taskEditorFieldSection', field: 'area', value: 'scheduling' },
            { type: 'taskEditorFieldSection', field: 'textDirection', value: 'details' },
            { type: 'taskEditorFieldSection', field: 'description', value: 'unknown' },
            { type: 'taskEditorFieldSection', field: 'description', value: 3 },
            { type: 'taskEditorFieldSection', field: 'description', value: 'basic', extra: true },
        ]) expect(await env.host.prepareGtdWorkflow({ requestId: generateUUID(), edit,
            expected: options.value.expected })).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);

        const basic = await plannedSection(env, 'description', 'basic');
        expect(await env.host.commitPreparedGtdWorkflow(basic.envelope)).toEqual({ ok: true,
            value: basic.prepared.result });
        expect(env.data().settings.gtd?.taskEditor?.sections?.description).toBe('basic');
        const next = await env.host.getGtdTaskEditorFieldOptions({});
        if (!next.ok) throw new Error(JSON.stringify(next));
        expect(next.value.taskEditor.groups.find((group) => group.id === 'basic')?.fields
            .some((field) => field.id === 'description')).toBe(true);
        expect(next.value.taskEditor.groups.flatMap((group) => group.fields)
            .find((field) => field.id === 'description')?.sheet.sections?.options
            .find((row) => row.selected)?.value).toBe('basic');
    });

    it('refuses forged field results and composite receipts, plus stale layout, features, or GTD stamp', async () => {
        const start = initial(); start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            order: [...DEFAULT_TASK_EDITOR_ORDER], hidden: [...DEFAULT_TASK_EDITOR_HIDDEN],
            sections: {}, sectionOpen: {} } };
        start.settings.features = { priorities: false, timeEstimates: false };
        const env = await open(start);
        const { envelope } = await plannedSection(env, 'description', 'scheduling');
        for (const mutate of [
            (copy: typeof envelope) => { copy.prepared.result.field = 'priority'; },
            (copy: typeof envelope) => { copy.prepared.result.value = 'basic'; },
            (copy: typeof envelope) => { copy.prepared.after.selected!.sections.value = { description: 'basic' }; },
            (copy: typeof envelope) => { copy.prepared.request.edit.value = 'basic'; },
        ]) {
            const forged = structuredClone(envelope); mutate(forged);
            expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await env.host.commitPreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        expect(env.saves()).toBe(0);
        for (const change of [
            (data: AppData) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
                taskEditor: { ...data.settings.gtd?.taskEditor, hidden: ['description'] } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                features: { ...data.settings.features, priorities: true } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                    gtd: '2026-09-02T00:00:00.000Z' } } }),
        ]) {
            const other = await open(start);
            const planned = await plannedSection(other, 'description', 'scheduling');
            other.changeSaved(change);
            expect(await other.host.commitPreparedGtdWorkflow(planned.envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(other.saves()).toBe(0);
        }
    });

    it('cold-replays the exact section receipt after unrelated later settings and task edits', async () => {
        const start = initial(); start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            order: [...DEFAULT_TASK_EDITOR_ORDER], hidden: [...DEFAULT_TASK_EDITOR_HIDDEN],
            sections: {}, sectionOpen: {}, legacy: 'keep' } as never };
        start.settings.features = { priorities: false, timeEstimates: false };
        const env = await open(start);
        const { envelope, prepared } = await plannedSection(env, 'description', 'scheduling');
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        env.changeSaved((data) => ({ ...data, tasks: data.tasks.map((task) => ({ ...task, title: 'later edit' })),
            settings: { ...data.settings, language: 'ko',
                gtd: { ...data.settings.gtd, legacySibling: { marker: 205 } } } }));
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
        expect(cold.data().tasks[0].title).toBe('later edit');
        expect(cold.data().settings.language).toBe('ko');
        expect(cold.data().settings.gtd?.legacySibling).toEqual({ marker: 205 });
    });
});

describe('prepared GTD Task Editor field visibility', () => {
    it('hides Description through the shared field edit while retaining layout and task rows', async () => {
        const start = initial();
        start.tasks.push({ id: 'field-editor', title: 'Field editor', status: 'next',
            tags: [], contexts: [], createdAt: AT, updatedAt: AT });
        start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            order: [...DEFAULT_TASK_EDITOR_ORDER], hidden: [...DEFAULT_TASK_EDITOR_HIDDEN],
            sections: {}, sectionOpen: {}, legacy: 'keep' } as never };
        start.settings.features = { priorities: false, timeEstimates: false, legacy: 'keep' } as never;
        const env = await open(start);
        const beforeEditor = env.host.getTaskEditorModel({ id: 'field-editor' });
        if (!beforeEditor.ok) throw new Error(JSON.stringify(beforeEditor));
        expect(beforeEditor.value.layout.sections.flatMap((section) => section.fields)).toContain('description');
        const { options, envelope, prepared } = await plannedField(env, 'description', false);
        const field = options.taskEditor.groups.flatMap((group) => group.fields)
            .find((row) => row.id === 'description');
        expect(options.taskEditor.groups[0].id).toBe('basic');
        expect(field).toMatchObject({ visible: true, visibility: {
            edit: { type: 'taskEditorFieldVisible', field: 'description', value: false } } });
        expect(prepared.result).toEqual({ type: 'taskEditorFieldVisible', field: 'description',
            value: false, changed: true });
        expect(prepared.after.selected?.hidden.value).toContain('description');
        expect(env.host.validatePreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.gtd?.taskEditor).toEqual({ ...start.settings.gtd?.taskEditor,
            hidden: [...DEFAULT_TASK_EDITOR_HIDDEN, 'description'] });
        expect(env.data().settings.features).toEqual(start.settings.features);
        expect(env.data().tasks).toEqual(start.tasks);
        const editor = env.host.getTaskEditorModel({ id: 'field-editor' });
        if (!editor.ok) throw new Error(JSON.stringify(editor));
        expect(editor.value.layout.sections.flatMap((section) => section.fields)).not.toContain('description');
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
    });

    it('offers all shared fields, rejects unavailable edits, and treats an already stored choice as a no-op', async () => {
        const env = await open(initial());
        const options = await env.host.getGtdTaskEditorFieldOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const groups = options.value.taskEditor.groups;
        expect(groups[0].id).toBe('basic');
        const fields = groups.flatMap((group) => group.fields);
        expect(fields.map((row) => row.id).sort()).toEqual([...DEFAULT_TASK_EDITOR_ORDER].sort());
        for (const row of fields) expect(row.visibility.edit).toEqual({
            type: 'taskEditorFieldVisible', field: row.id, value: !row.visible });
        expect(fields.find((row) => row.id === 'priority')).toMatchObject({ visible: false,
            visibility: { edit: { value: true } } });
        const expected = options.value.expected;
        for (const edit of [
            { type: 'taskEditorFieldVisible', field: 'textDirection', value: true },
            { type: 'taskEditorFieldVisible', field: 'unknown', value: false },
            { type: 'taskEditorFieldVisible', field: 'description', value: 'false' },
            { type: 'taskEditorFieldVisible', field: 'description', value: false, extra: true },
            { type: 'taskEditorFieldVisible', field: 'description', value: true },
        ]) expect(await env.host.prepareGtdWorkflow({ requestId: ID, edit, expected }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);

        const start = initial(); start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            order: [...DEFAULT_TASK_EDITOR_ORDER], hidden: [...DEFAULT_TASK_EDITOR_HIDDEN],
            sections: {}, sectionOpen: {} } };
        start.settings.features = { priorities: false, timeEstimates: false };
        const stored = await open(start);
        const current = await stored.host.getGtdTaskEditorFieldOptions({});
        if (!current.ok) throw new Error(JSON.stringify(current));
        expect(await stored.host.prepareGtdWorkflow({ requestId: ID,
            edit: { type: 'taskEditorFieldVisible', field: 'description', value: true },
            expected: current.value.expected })).toMatchObject({ ok: true,
                value: { kind: 'noop', result: { type: 'taskEditorFieldVisible', field: 'description',
                    value: true, changed: false } } });
        expect(stored.saves()).toBe(0);
    });

    it('enables and hides the Priority field through the shared feature flag policy', async () => {
        for (const row of [
            { initiallyVisible: false, value: true, enabled: true },
            { initiallyVisible: true, value: false, enabled: false },
        ]) {
            const start = initial();
            start.tasks.push({ id: 'feature-editor', title: 'Feature editor', status: 'next',
                tags: [], contexts: [], createdAt: AT, updatedAt: AT });
            start.settings.gtd = { ...start.settings.gtd, taskEditor: {
                order: [...DEFAULT_TASK_EDITOR_ORDER],
                hidden: row.initiallyVisible ? DEFAULT_TASK_EDITOR_HIDDEN.filter((field) => field !== 'priority')
                    : [...DEFAULT_TASK_EDITOR_HIDDEN],
                sections: {}, sectionOpen: {} } };
            start.settings.features = { priorities: row.initiallyVisible, timeEstimates: false };
            const env = await open(start);
            const { options, envelope, prepared } = await plannedField(env, 'priority', row.value);
            expect(options.taskEditor.groups.flatMap((group) => group.fields)
                .find((field) => field.id === 'priority')?.visible).toBe(row.initiallyVisible);
            expect(prepared.after.selected?.priorities.value).toBe(row.enabled);
            expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
            expect(env.data().settings.features?.priorities).toBe(row.enabled);
            const editor = env.host.getTaskEditorModel({ id: 'feature-editor' });
            if (!editor.ok) throw new Error(JSON.stringify(editor));
            expect(editor.value.layout.sections.flatMap((section) => section.fields).includes('priority'))
                .toBe(row.enabled);
            expect(env.data().tasks).toEqual(start.tasks);
        }
    });

    it('rejects forged field identity, receipt, and changed layout/feature witnesses before writing', async () => {
        const start = initial(); start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            order: [...DEFAULT_TASK_EDITOR_ORDER], hidden: [...DEFAULT_TASK_EDITOR_HIDDEN],
            sections: {}, sectionOpen: {} } };
        start.settings.features = { priorities: false, timeEstimates: false };
        const env = await open(start);
        const { envelope } = await plannedField(env, 'description', false);
        for (const mutate of [
            (copy: typeof envelope) => { copy.prepared.result.field = 'priority'; },
            (copy: typeof envelope) => { copy.prepared.after.selected!.hidden.value = ['tags']; },
            (copy: typeof envelope) => { copy.prepared.request.edit.field = 'priority'; },
        ]) {
            const forged = structuredClone(envelope); mutate(forged);
            expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await env.host.commitPreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        expect(env.saves()).toBe(0);
        for (const change of [
            (data: AppData) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
                taskEditor: { ...data.settings.gtd?.taskEditor, order: [...DEFAULT_TASK_EDITOR_ORDER].reverse() } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings, features: {
                ...data.settings.features, priorities: true } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                    gtd: '2026-09-02T00:00:00.000Z' } } }),
        ]) {
            const other = await open(start);
            const planned = await plannedField(other, 'description', false);
            other.changeSaved(change);
            expect(await other.host.commitPreparedGtdWorkflow(planned.envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(other.saves()).toBe(0);
        }
    });

    it('replays the exact field receipt after unrelated settings and task edits', async () => {
        const start = initial(); start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            order: [...DEFAULT_TASK_EDITOR_ORDER], hidden: [...DEFAULT_TASK_EDITOR_HIDDEN],
            sections: {}, sectionOpen: {} } };
        start.settings.features = { priorities: false, timeEstimates: false };
        const env = await open(start);
        const { envelope, prepared } = await plannedField(env, 'description', false);
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        env.changeSaved((data) => ({ ...data, tasks: data.tasks.map((task) => ({ ...task, title: 'later task edit' })),
            settings: { ...data.settings, language: 'ko',
                gtd: { ...data.settings.gtd, legacySibling: { marker: 204 } } } }));
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
        expect(cold.data().tasks[0].title).toBe('later task edit');
        expect(cold.data().settings.language).toBe('ko');
        expect(cold.data().settings.gtd?.legacySibling).toEqual({ marker: 204 });
    });
});

describe('native task opening read', () => {
    it.each([
        [null, 'task', false, false, 'task'],
        ['unknown', 'view', false, false, 'view'],
        ['preview', 'task', false, false, 'view'],
        ['edit', 'view', false, false, 'task'],
        ['preview', 'view', true, false, 'task'],
        ['edit', 'task', true, true, 'view'],
    ] as const)('resolves %s / %s / explicit %s / readOnly %s', async (
        rawMode, automaticTab, explicitEdit, readOnly, tab,
    ) => {
        const env = await open(initial());
        expect(env.host.getTaskOpenTab({ rawMode, automaticTab, explicitEdit, readOnly }))
            .toEqual({ ok: true, value: { tab } });
        expect(env.saves()).toBe(0);
    });

    it('rejects malformed or unbounded requests before any read or write', async () => {
        const env = await open(initial());
        const valid = { rawMode: 'preview', automaticTab: 'task', explicitEdit: false, readOnly: false };
        for (const input of [null, {}, { ...valid, automaticTab: 'other' },
            { ...valid, explicitEdit: 1 }, { ...valid, readOnly: null },
            { ...valid, rawMode: 1 }, { ...valid, rawMode: 'x'.repeat(201) },
            { ...valid, extra: true }]) {
            expect(env.host.getTaskOpenTab(input)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        expect(env.host.getTaskOpenTab({ ...valid, rawMode: 'x'.repeat(200) }))
            .toEqual({ ok: true, value: { tab: 'task' } });
        expect(env.saves()).toBe(0);
    });
});

describe('prepared GTD Task Editor presets', () => {
    it('projects device-local opening choices without changing the GTD witness or saved data', async () => {
        const env = await open(initial());
        const absent = await env.host.getGtdTaskEditorPresetOptions({});
        if (!absent.ok) throw new Error(JSON.stringify(absent));
        for (const rawMode of [null, 'automatic', 'preview', 'edit', 'unexpected']) {
            const read = await env.host.getGtdTaskEditorPresetOptions({ rawMode });
            if (!read.ok) throw new Error(JSON.stringify(read));
            const { openMode } = read.value.taskEditor;
            expect(Object.keys(openMode).sort()).toEqual(['description', 'label', 'options']);
            expect(openMode.options.map((option) => option.value)).toEqual(['automatic', 'preview', 'edit']);
            expect(openMode.options.map((option) => option.edit)).toEqual([
                { type: 'taskOpenMode', value: 'automatic' },
                { type: 'taskOpenMode', value: 'preview' },
                { type: 'taskOpenMode', value: 'edit' },
            ]);
            expect(openMode.options.filter((option) => option.selected).map((option) => option.value))
                .toEqual([rawMode === 'preview' || rawMode === 'edit' ? rawMode : 'automatic']);
            expect(read.value.expected).toEqual(absent.value.expected);
        }
        expect(env.saves()).toBe(0);
        expect(env.data()).toEqual(initial());
    });

    it('rejects malformed opening read requests but falls back for bounded unknown mode text', async () => {
        const env = await open(initial());
        for (const input of [{ rawMode: 1 }, { rawMode: false }, { rawMode: {} },
            { rawMode: 'x'.repeat(201) }, { rawMode: null, extra: 1 }]) {
            expect(await env.host.getGtdTaskEditorPresetOptions(input)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        expect((await env.host.getGtdTaskEditorPresetOptions({ rawMode: 'x'.repeat(200) })).ok).toBe(true);
        expect(env.saves()).toBe(0);
    });

    it.each(['simple', 'standard', 'full'] as const)('uses shared %s preset layout and exact composite receipt', async (value) => {
        const start = initial();
        start.tasks.push({ id: 'preset-editor', title: 'Preset editor', status: 'next', tags: [], contexts: [],
            createdAt: AT, updatedAt: AT });
        start.settings.features = { priorities: false, timeEstimates: false };
        const env = await open(start);
        const { options, envelope, prepared } = await plannedPreset(env, value);
        expect(options.taskEditor.presets.options).toHaveLength(3);
        expect(options.taskEditor.presets.options.find((option) => option.value === value)?.edit)
            .toEqual({ type: 'taskEditorPreset', value });
        expect(options.expected).toMatchObject({ taskEditorPresent: false, featuresPresent: true,
            priorities: { present: true, value: false }, timeEstimates: { present: true, value: false } });
        expect(Object.keys(prepared.after).sort()).toEqual(['selected', 'stamp', 'value']);
        expect(prepared.after.selected).toMatchObject({ taskEditorPresent: true, featuresPresent: true,
            priorities: { present: true, value: false }, timeEstimates: { present: true, value: false },
            order: { present: true }, hidden: { present: true }, sections: { present: true },
            sectionOpen: { present: true } });
        expect(env.host.validatePreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(JSON.stringify(envelope)).not.toContain('private-value');
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.features).toEqual(start.settings.features);
        expect(env.data().settings.gtd?.taskEditor).toMatchObject({
            order: prepared.after.selected?.order.value, hidden: prepared.after.selected?.hidden.value,
            sections: prepared.after.selected?.sections.value, sectionOpen: prepared.after.selected?.sectionOpen.value });
        expect(env.data().tasks).toEqual(start.tasks);
        const editor = env.host.getTaskEditorModel({ id: 'preset-editor' });
        if (!editor.ok) throw new Error(JSON.stringify(editor));
        const visible = editor.value.layout.sections.flatMap((section) => section.fields);
        expect(visible.includes('description')).toBe(value !== 'simple');
        expect(visible).not.toContain('priority');
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
    });

    it('preserves unknown siblings, exposes custom layout, and rejects forged composite receipts', async () => {
        const start = initial();
        start.settings.gtd = { ...start.settings.gtd, taskEditor: { order: ['description'],
            hidden: ['tags'], sections: {}, sectionOpen: {}, legacy: 'keep' } as never };
        start.settings.features = { priorities: false, timeEstimates: true, legacy: 'keep' } as never;
        const env = await open(start);
        const { options, envelope, prepared } = await plannedPreset(env, 'full');
        expect(options.taskEditor.presets.custom).toBeTruthy();
        const forged = structuredClone(envelope);
        forged.prepared.after.selected!.hidden.value = ['tags'];
        expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.gtd?.taskEditor).toMatchObject({ legacy: 'keep' });
        expect(env.data().settings.features).toEqual(start.settings.features);
    });

    it('distinguishes absent feature flags from explicit false and rejects every forged layout field', async () => {
        const env = await open(initial());
        const { options, envelope } = await plannedPreset(env, 'full');
        expect(options.expected).toMatchObject({ featuresPresent: false,
            priorities: { present: false, value: null }, timeEstimates: { present: false, value: null } });
        for (const field of ['order', 'hidden', 'sections', 'sectionOpen'] as const) {
            const forged = structuredClone(envelope);
            forged.prepared.after.selected![field].present = false;
            expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        const forgedFeature = structuredClone(envelope);
        forgedFeature.request.expected.featuresPresent = true;
        expect(env.host.validatePreparedGtdWorkflow(forgedFeature)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);
    });

    it('keeps no-op and raw validation exact without reading unrelated GTD siblings', async () => {
        const malformed = await open(initial());
        malformed.changeSaved((data) => ({ ...data, settings: { ...data.settings,
            gtd: { ...data.settings.gtd, taskEditor: { order: 'malformed-relevant' } as never } } }));
        expect(await malformed.host.getGtdTaskEditorPresetOptions({})).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(malformed.saves()).toBe(0);
        const env = await open(initial());
        const first = await plannedPreset(env, 'standard');
        expect(await env.host.commitPreparedGtdWorkflow(first.envelope)).toMatchObject({ ok: true });
        const options = await env.host.getGtdTaskEditorPresetOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.taskEditor.presets.options.find((option) => option.value === 'standard')?.selected).toBe(true);
        expect(await env.host.prepareGtdWorkflow({ requestId: ID,
            edit: { type: 'taskEditorPreset', value: 'standard' }, expected: options.value.expected })).toMatchObject({ ok: true,
            value: { kind: 'noop', result: { changed: false } } });
        expect(env.saves()).toBe(1);
    });
});

describe('prepared GTD Task Editor reset', () => {
    it('uses shared reset to restore full defaults and feature flags while retaining unknown siblings', async () => {
        const start = initial(); start.settings.gtd = { ...start.settings.gtd,
            taskEditor: { order: ['description', 'status'], hidden: ['status'],
                sections: { description: 'basic' }, sectionOpen: { details: true },
                defaultsVersion: 5, presentation: 'modal' } as never };
        start.settings.features = { priorities: true, timeEstimates: true, legacy: 'keep' } as never;
        const env = await open(start);
        const before = await env.host.getGtdTaskEditorFieldOptions({});
        if (!before.ok) throw new Error(JSON.stringify(before));
        expect(before.value.taskEditor.expandedResetKey).toBe('[null,null,true]');
        const { options, envelope, prepared } = await plannedReset(env);
        expect(new TextEncoder().encode(JSON.stringify(options)).length).toBeLessThanOrEqual(65_536);
        expect(new TextEncoder().encode(JSON.stringify(envelope)).length).toBeLessThanOrEqual(8192);
        expect(options.taskEditor.reset.edit).toEqual({ type: 'taskEditorReset' });
        expect(options.taskEditor.reset.label).toEqual(expect.any(String));
        expect(prepared.result).toEqual({ type: 'taskEditorReset', changed: true });
        expect(Object.keys(prepared.after).sort()).toEqual(['selected', 'stamp']);
        expect(prepared.after.selected).toMatchObject({ order: { present: true, value: DEFAULT_TASK_EDITOR_ORDER },
            hidden: { present: true, value: DEFAULT_TASK_EDITOR_HIDDEN },
            sections: { present: true, value: {} }, sectionOpen: { present: true, value: {} },
            priorities: { present: true, value: false }, timeEstimates: { present: true, value: false } });
        expect(env.host.validatePreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.gtd?.taskEditor).toMatchObject({
            order: DEFAULT_TASK_EDITOR_ORDER, hidden: DEFAULT_TASK_EDITOR_HIDDEN,
            sections: {}, sectionOpen: {}, defaultsVersion: 5, presentation: 'modal' });
        expect(env.data().settings.features).toEqual({ priorities: false, timeEstimates: false, legacy: 'keep' });
        expect(env.data().settings.gtd?.legacySibling).toEqual(start.settings.gtd?.legacySibling);
        expect(env.data().tasks).toEqual(start.tasks);
        const after = await env.host.getGtdTaskEditorFieldOptions({});
        if (!after.ok) throw new Error(JSON.stringify(after));
        expect(after.value.taskEditor.expandedResetKey).toBe('[null,null,null]');
    });

    it('materializes absent raw defaults once, stamps GTD, then returns a type-only no-op without saving', async () => {
        const env = await open(initial());
        const first = await plannedReset(env);
        expect(first.options.expected).toMatchObject({ taskEditorPresent: false, featuresPresent: false,
            order: { present: false, value: null }, hidden: { present: false, value: null },
            sections: { present: false, value: null }, sectionOpen: { present: false, value: null },
            priorities: { present: false, value: null }, timeEstimates: { present: false, value: null } });
        expect(await env.host.commitPreparedGtdWorkflow(first.envelope)).toEqual({ ok: true,
            value: first.prepared.result });
        expect(env.data().settings.gtd?.taskEditor).toMatchObject({
            order: DEFAULT_TASK_EDITOR_ORDER, hidden: DEFAULT_TASK_EDITOR_HIDDEN,
            sections: {}, sectionOpen: {} });
        expect(env.data().settings.features).toEqual({ priorities: false, timeEstimates: false });
        expect(env.data().settings.syncPreferencesUpdatedAt?.gtd).toBe(first.prepared.after.stamp);
        expect(env.saves()).toBe(1);
        const options = await env.host.getGtdTaskEditorPresetOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(await env.host.prepareGtdWorkflow({ requestId: generateUUID(),
            edit: { type: 'taskEditorReset' }, expected: options.value.expected })).toEqual({ ok: true,
                value: { kind: 'noop', result: { type: 'taskEditorReset', changed: false } } });
        expect(env.saves()).toBe(1);
    });

    it('refuses shaped extras, forged frozen reset receipts, and stale raw layout/features/stamp', async () => {
        const env = await open(initial());
        const options = await env.host.getGtdTaskEditorPresetOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        for (const edit of [
            { type: 'taskEditorReset', value: null },
            { type: 'taskEditorReset', value: 'standard' },
            { type: 'taskEditorReset', field: 'description' },
            { type: 'taskEditorReset', extra: true },
        ]) expect(await env.host.prepareGtdWorkflow({ requestId: generateUUID(), edit,
            expected: options.value.expected })).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        const { envelope } = await plannedReset(env);
        for (const mutate of [
            (copy: typeof envelope) => { copy.prepared.after.value = 'fabricated'; },
            (copy: typeof envelope) => { copy.prepared.after.selected!.order.present = false; },
            (copy: typeof envelope) => { copy.prepared.after.selected!.hidden.value = ['description']; },
            (copy: typeof envelope) => { copy.prepared.after.selected!.sections.value = { description: 'basic' }; },
            (copy: typeof envelope) => { copy.prepared.after.selected!.sectionOpen.value = { details: true }; },
            (copy: typeof envelope) => { copy.prepared.after.selected!.priorities.value = true; },
            (copy: typeof envelope) => { copy.prepared.after.selected!.timeEstimates.value = true; },
            (copy: typeof envelope) => { copy.prepared.after.stamp = '2026-09-03T00:00:00.000Z'; },
            (copy: typeof envelope) => { copy.prepared.result.changed = false; },
            (copy: typeof envelope) => { (copy.prepared.result as never).value = null; },
            (copy: typeof envelope) => { (copy.request.edit as never).value = null; },
        ]) {
            const forged = structuredClone(envelope); mutate(forged);
            expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await env.host.commitPreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        expect(env.saves()).toBe(0);

        const start = initial(); start.settings.gtd = { ...start.settings.gtd, taskEditor: {
            order: ['description'], hidden: ['tags'], sections: { description: 'basic' },
            sectionOpen: { details: true } } };
        start.settings.features = { priorities: true, timeEstimates: true };
        for (const change of [
            (data: AppData) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
                taskEditor: { ...data.settings.gtd?.taskEditor, order: ['status'] } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
                taskEditor: { ...data.settings.gtd?.taskEditor, hidden: ['description'] } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
                taskEditor: { ...data.settings.gtd?.taskEditor, sections: {} } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings, gtd: { ...data.settings.gtd,
                taskEditor: { ...data.settings.gtd?.taskEditor, sectionOpen: {} } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                features: { ...data.settings.features, priorities: false } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                features: { ...data.settings.features, timeEstimates: false } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                    gtd: '2026-09-02T00:00:00.000Z' } } }),
        ]) {
            const other = await open(start);
            const planned = await plannedReset(other);
            other.changeSaved(change);
            expect(await other.host.commitPreparedGtdWorkflow(planned.envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(other.saves()).toBe(0);
        }
    });

    it('cold-replays only its own reset receipt and retains later unrelated settings and task edits', async () => {
        const env = await open(initial());
        const { envelope, prepared } = await plannedReset(env);
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: prepared.result });
        env.changeSaved((data) => ({ ...data, tasks: data.tasks.map((task) => ({ ...task, title: 'later edit' })),
            settings: { ...data.settings, language: 'ko', gtd: { ...data.settings.gtd,
                legacySibling: { marker: 146 } } } }));
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true,
            value: prepared.result });
        expect(cold.saves()).toBe(0);
        expect(cold.data().tasks[0].title).toBe('later edit');
        expect(cold.data().settings.language).toBe('ko');
        expect(cold.data().settings.gtd?.legacySibling).toEqual({ marker: 146 });
    });
});

describe('prepared GTD workflow defaults', () => {
    it.each(['scheduling', 'organization', 'details'] as const)('uses the shared $section section default and a selected-key receipt', async (section) => {
        const start = initial();
        start.tasks.push({ id: 'editor-empty', title: 'Empty editor', status: 'next', tags: [], contexts: [],
            createdAt: AT, updatedAt: AT });
        const env = await open(start);
        const { options, envelope, prepared } = await plannedEditorSection(env, section, true);
        expect(Object.keys(options.expected).sort()).toEqual(['scheduling', 'organization', 'details'].sort());
        expect(options.expected[section]).toEqual({ taskEditorPresent: false, sectionOpenPresent: false,
            present: false, value: null, stampPresent: true, stamp: AT });
        const row = options.taskEditor.groups.find((group) => group.id === section);
        expect(row?.defaultOpen).toMatchObject({ value: false,
            edit: { type: 'taskEditorSectionOpen', section, value: true } });
        expect(prepared.after).toMatchObject({ value: true,
            selected: { taskEditorPresent: true, sectionOpenPresent: true, present: true, value: true } });
        expect(prepared.result).toEqual({ type: 'taskEditorSectionOpen', section, value: true, changed: true });
        expect(env.host.validatePreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(JSON.stringify(envelope)).not.toContain('private-value');
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.gtd?.taskEditor?.sectionOpen?.[section]).toBe(true);
        expect(env.data().settings.gtd).toMatchObject({ focusGroupBy: 'project', legacySibling: { marker: 103 } });
        expect(env.data().tasks).toEqual(start.tasks);
        const editor = env.host.getTaskEditorModel({ id: 'editor-empty' });
        if (!editor.ok) throw new Error(JSON.stringify(editor));
        expect(editor.value.layout.sections.find((group) => group.id === section)?.open).toBe(true);
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
    });

    it('deletes the selected default key via the shared update while retaining sibling layout', async () => {
        const start = initial();
        start.settings.gtd = { ...start.settings.gtd, taskEditor: { sectionOpen: { scheduling: true,
            organization: true, legacy: 'keep' } } as never };
        const env = await open(start);
        const { envelope, prepared } = await plannedEditorSection(env, 'scheduling', false);
        expect(prepared.after.selected).toEqual({ taskEditorPresent: true, sectionOpenPresent: true,
            present: false, value: null });
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.gtd?.taskEditor?.sectionOpen).toEqual({ organization: true, legacy: 'keep' });
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
    });

    it('rejects unoffered and forged section plans without saving', async () => {
        const env = await open(initial());
        const options = await env.host.getGtdTaskEditorOpenOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        const request: NativeGtdWorkflowRequest = { requestId: ID,
            edit: { type: 'taskEditorSectionOpen', section: 'details', value: false },
            expected: options.value.expected.details };
        expect(await env.host.prepareGtdWorkflow(request)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const { envelope } = await plannedEditorSection(env, 'details', true);
        const wrongSection = structuredClone(envelope); wrongSection.prepared.result = {
            type: 'taskEditorSectionOpen', section: 'scheduling', value: true, changed: true };
        expect(env.host.validatePreparedGtdWorkflow(wrongSection)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const wrongParent = structuredClone(envelope); wrongParent.prepared.after.selected!.taskEditorPresent = false;
        expect(env.host.validatePreparedGtdWorkflow(wrongParent)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const wrongMap = structuredClone(envelope); wrongMap.prepared.after.selected!.sectionOpenPresent = false;
        expect(env.host.validatePreparedGtdWorkflow(wrongMap)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const wrongKey = structuredClone(envelope); wrongKey.prepared.after.selected!.present = false;
        expect(env.host.validatePreparedGtdWorkflow(wrongKey)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);
    });

    it('keeps shared exact no-op behavior and refuses malformed relevant raw section values', async () => {
        const empty = initial(); empty.settings.gtd = { ...empty.settings.gtd,
            taskEditor: { sectionOpen: {} } };
        const env = await open(empty);
        const options = await env.host.getGtdTaskEditorOpenOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(await env.host.prepareGtdWorkflow({ requestId: ID,
            edit: { type: 'taskEditorSectionOpen', section: 'details', value: false },
            expected: options.value.expected.details })).toMatchObject({ ok: true,
            value: { kind: 'noop', result: { type: 'taskEditorSectionOpen', section: 'details', value: false, changed: false } } });
        expect(env.saves()).toBe(0);
        for (const bad of [
            { taskEditor: 'bad-parent' },
            { taskEditor: { sectionOpen: 'bad-map' } },
            { taskEditor: { sectionOpen: { details: 'false' } } },
        ]) {
            const start = initial(); start.settings.gtd = { ...start.settings.gtd, ...bad } as never;
            const malformed = await open(start);
            expect(await malformed.host.getGtdTaskEditorOpenOptions({})).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(malformed.saves()).toBe(0);
        }
        const unrelated = initial(); unrelated.settings.gtd = { ...unrelated.settings.gtd,
            taskEditor: { order: 'bad-legacy-order', sectionOpen: { details: false } } as never };
        const preserved = await open(unrelated);
        const { envelope } = await plannedEditorSection(preserved, 'details', true);
        expect(await preserved.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: true });
        expect(preserved.data().settings.gtd?.taskEditor).toMatchObject({ order: 'bad-legacy-order',
            sectionOpen: { details: true } });
    });

    it('opens a filled Details section despite its closed default without writing a Task', async () => {
        const start = initial(); start.tasks.push({ id: 'editor-filled', title: 'Filled editor', status: 'next',
            description: 'Already has content', tags: [], contexts: [], createdAt: AT, updatedAt: AT });
        const env = await open(start);
        const editor = env.host.getTaskEditorModel({ id: 'editor-filled' });
        if (!editor.ok) throw new Error(JSON.stringify(editor));
        expect(editor.value.layout.sections.find((group) => group.id === 'details')).toMatchObject({ open: true });
        expect(env.saves()).toBe(0);
        expect(env.data().tasks).toEqual(start.tasks);
    });
    it.each([
        { type: 'defaultScheduleTime', value: '09:30' },
        { type: 'focusTaskLimit', value: 5 },
        { type: 'focusIncludeStartDates', value: false },
        { type: 'defaultProjectFlowMode', value: 'sequential' },
    ] as const)('saves and cold-replays $type with only the chosen raw field and GTD stamp', async (edit) => {
        const env = await open(initial());
        const { options, envelope, prepared } = await planned(env, edit);
        expect(Object.keys(options.expected).sort()).toEqual([
            'defaultScheduleTime', 'focusTaskLimit', 'focusIncludeStartDates', 'defaultProjectFlowMode', 'pomodoro'].sort());
        expect(options.expected[edit.type]).toMatchObject({ present: false, value: null, stampPresent: true, stamp: AT });
        expect(options.hub[edit.type].label).toEqual(expect.any(String));
        expect(env.host.validatePreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(Object.keys(envelope.request.expected).sort()).toEqual(['present', 'stamp', 'stampPresent', 'value']);
        expect(JSON.stringify(envelope)).not.toContain('private-value');
        expect(JSON.stringify(envelope)).not.toContain('legacySibling');
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.saves()).toBe(1);
        expect(env.data().settings.gtd?.[edit.type]).toBe(edit.value);
        expect(env.data().settings.gtd).toMatchObject({ focusGroupBy: 'project', legacySibling: { marker: 103 } });
        expect(env.data().settings.syncPreferencesUpdatedAt?.gtd).toBe(prepared.after.stamp);
        expect(env.data().settings.syncPreferencesUpdatedAt?.appearance).toBe(AT);
        expect(env.data().tasks).toEqual(initial().tasks);
        if (edit.type === 'defaultScheduleTime') {
            expect(getProcessInboxDefaultScheduleTime(env.data().settings)).toBe('09:30');
        } else if (edit.type === 'focusTaskLimit') {
            const limit = normalizeFocusTaskLimit(env.data().settings.gtd?.focusTaskLimit);
            expect(canStarNewCapture({ focusedCount: 4, focusTaskLimit: limit })).toBe(true);
            expect(canStarNewCapture({ focusedCount: 5, focusTaskLimit: limit })).toBe(false);
        } else if (edit.type === 'focusIncludeStartDates') {
            const after = await env.host.getGtdWorkflowOptions({});
            expect(after).toMatchObject({ ok: true, value: { hub: {
                focusIncludeStartDates: { value: false, edit: { type: 'focusIncludeStartDates', value: true } },
            } } });
            env.changeSaved((data) => ({ ...data, settings: { ...data.settings, language: 'ko' } }));
        } else {
            const project = env.host.prepareProjectCreate({ requestId: '10300000-0000-4000-8000-000000000103',
                title: 'Uses saved GTD flow', areaId: null });
            expect(project).toMatchObject({ ok: true, value: { kind: 'prepared',
                prepared: { defaultProjectFlowMode: 'sequential', project: { isSequential: true } } } });
        }
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
        if (edit.type === 'focusIncludeStartDates') expect(cold.data().settings.language).toBe('ko');
    });

    it('uses the shared time parser for drafts and only accepts normalized time edits', async () => {
        const env = await open(initial());
        expect(env.host.normalizeGtdWorkflowDraft({ value: ' 7:05 ' })).toEqual({ ok: true,
            value: { valid: true, value: '07:05' } });
        expect(env.host.normalizeGtdWorkflowDraft({ value: '1745' })).toEqual({ ok: true,
            value: { valid: true, value: '17:45' } });
        expect(env.host.normalizeGtdWorkflowDraft({ value: '' })).toEqual({ ok: true,
            value: { valid: true, value: '' } });
        expect(env.host.normalizeGtdWorkflowDraft({ value: '25:00' })).toEqual({ ok: true,
            value: { valid: false, value: null } });
        expect(env.host.normalizeGtdWorkflowDraft({ value: 'x'.repeat(51) })).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const options = await env.host.getGtdWorkflowOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        for (const value of ['7:05', '25:00', 705, null])
            expect(await env.host.prepareGtdWorkflow({ requestId: ID,
                edit: { type: 'defaultScheduleTime', value }, expected: options.value.expected.defaultScheduleTime }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('uses shared offered choices and distinguishes stored defaults from absence', async () => {
        const env = await open(initial());
        const options = await env.host.getGtdWorkflowOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        for (const option of options.value.hub.focusTaskLimit.options) {
            expect(option.edit).toEqual({ type: 'focusTaskLimit', value: option.value });
        }
        expect(options.value.hub.defaultProjectFlowMode.options.map((row) => row.value))
            .toEqual(['parallel', 'sequential']);
        for (const value of [0, 6, 100, '5'])
            expect(await env.host.prepareGtdWorkflow({ requestId: ID,
                edit: { type: 'focusTaskLimit', value }, expected: options.value.expected.focusTaskLimit }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const absentDefault = await env.host.prepareGtdWorkflow({ requestId: ID,
            edit: { type: 'defaultScheduleTime', value: '' }, expected: options.value.expected.defaultScheduleTime });
        expect(absentDefault).toMatchObject({ ok: true, value: { kind: 'noop', result: { changed: false } } });
        expect(env.saves()).toBe(0);
        const start = initial(); start.settings.gtd = { ...start.settings.gtd, focusTaskLimit: 6 };
        const legacy = await open(start);
        const raw = await legacy.host.getGtdWorkflowOptions({});
        expect(raw).toMatchObject({ ok: true, value: { expected: { focusTaskLimit: { present: true, value: 6 } } } });
        const replacement = await planned(legacy, { type: 'focusTaskLimit', value: 5 });
        expect(await legacy.host.commitPreparedGtdWorkflow(replacement.envelope)).toMatchObject({ ok: true });
        expect(legacy.data().settings.gtd?.focusTaskLimit).toBe(5);
    });

    it('offers only the inverse Focus start-date toggle and accepts strict saved booleans', async () => {
        const absent = await open(initial());
        const options = await absent.host.getGtdWorkflowOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.hub.focusIncludeStartDates).toMatchObject({ value: true,
            edit: { type: 'focusIncludeStartDates', value: false } });
        for (const value of [null, 0, 1, 'false'])
            expect(await absent.host.prepareGtdWorkflow({ requestId: ID,
                edit: { type: 'focusIncludeStartDates', value },
                expected: options.value.expected.focusIncludeStartDates }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(await absent.host.prepareGtdWorkflow({ requestId: ID,
            edit: { type: 'focusIncludeStartDates', value: true },
            expected: options.value.expected.focusIncludeStartDates }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const { envelope } = await planned(absent, { type: 'focusIncludeStartDates', value: false });
        const forged = structuredClone(envelope);
        forged.request.edit.value = true;
        forged.prepared.request.edit.value = true;
        forged.prepared.after.value = true;
        forged.prepared.result.value = true;
        expect(absent.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(absent.saves()).toBe(0);

        const start = initial(); start.settings.gtd = { ...start.settings.gtd, focusIncludeStartDates: false };
        const off = await open(start);
        const offered = await off.host.getGtdWorkflowOptions({});
        expect(offered).toMatchObject({ ok: true, value: { hub: { focusIncludeStartDates: {
            value: false, edit: { type: 'focusIncludeStartDates', value: true } } } } });
        const enabled = await planned(off, { type: 'focusIncludeStartDates', value: true });
        expect(await off.host.commitPreparedGtdWorkflow(enabled.envelope)).toMatchObject({ ok: true });
        expect(off.data().settings.gtd?.focusIncludeStartDates).toBe(true);
        for (const bad of [null, 1, 'true']) {
            const malformed = initial(); malformed.settings.gtd = { ...malformed.settings.gtd,
                focusIncludeStartDates: bad as never };
            const env = await open(malformed);
            expect(await env.host.getGtdWorkflowOptions({})).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
    });

    it('updates Focus schedule membership without changing task rows', async () => {
        const today = new Date();
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9).toISOString();
        const start = initial(); start.tasks.push(
            { id: 'gtd-start-only', title: 'Start only', status: 'next', startTime: date,
                tags: [], contexts: [], createdAt: AT, updatedAt: AT },
            { id: 'gtd-due-only', title: 'Due only', status: 'next', dueDate: date,
                tags: [], contexts: [], createdAt: AT, updatedAt: AT },
        );
        const env = await open(start);
        const scheduled = (host: typeof env.host) => {
            const focus = host.getFocus({ limit: 20 });
            if (!focus.ok) throw new Error(JSON.stringify(focus));
            return focus.value.sections.find((section) => section.key === 'schedule')?.rows.map((row) => row.id) ?? [];
        };
        expect(scheduled(env.host)).toContain('gtd-start-only');
        expect(scheduled(env.host)).toContain('gtd-due-only');
        const { envelope } = await planned(env, { type: 'focusIncludeStartDates', value: false });
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: true });
        expect(scheduled(env.host)).not.toContain('gtd-start-only');
        expect(scheduled(env.host)).toContain('gtd-due-only');
        expect(env.data().tasks).toEqual(start.tasks);
        const cold = await env.reopen();
        expect(scheduled(cold.host)).not.toContain('gtd-start-only');
        expect(scheduled(cold.host)).toContain('gtd-due-only');
    });

    it('refuses a stale Focus start-date field or GTD stamp before commit', async () => {
        for (const change of [
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                gtd: { ...data.settings.gtd, focusIncludeStartDates: false } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                    gtd: '2026-09-02T00:00:00.000Z' } } }),
        ]) {
            const env = await open(initial());
            const { envelope } = await planned(env, { type: 'focusIncludeStartDates', value: false });
            env.changeSaved(change);
            expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(env.saves()).toBe(0);
        }
    });

    it('refuses malformed relevant raw fields and forged prepared effects before storage', async () => {
        const env = await open(initial());
        const { envelope } = await planned(env, { type: 'defaultProjectFlowMode', value: 'sequential' });
        for (const change of [
            (copy: typeof envelope) => { copy.prepared.after.stamp = AT; },
            (copy: typeof envelope) => { copy.prepared.after.value = 'parallel'; },
            (copy: typeof envelope) => { copy.prepared.result.changed = false; },
            (copy: typeof envelope) => { copy.prepared.request.requestId = '00000000-0000-4000-8000-000000000000'; },
        ]) {
            const forged = structuredClone(envelope); change(forged);
            expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await env.host.commitPreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        for (const bad of [null, [], 1]) {
            const start = initial(); start.settings.gtd = bad as never;
            const other = await open(start);
            expect(await other.host.getGtdWorkflowOptions({})).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        for (const [type, bad] of [['focusTaskLimit', '5'], ['defaultScheduleTime', 930],
            ['defaultProjectFlowMode', null]] as const) {
            const start = initial(); start.settings.gtd = { ...start.settings.gtd, [type]: bad };
            const other = await open(start);
            expect(await other.host.getGtdWorkflowOptions({})).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
    });

    it('refuses forged shared-policy no-ops and keeps malformed unrelated GTD siblings raw', async () => {
        const env = await open(initial());
        const { envelope } = await planned(env, { type: 'defaultScheduleTime', value: '09:30' });
        const absentDefault = structuredClone(envelope);
        absentDefault.request.edit.value = '';
        absentDefault.prepared.request.edit.value = '';
        absentDefault.prepared.after.value = '';
        absentDefault.prepared.result.value = '';
        expect(env.host.validatePreparedGtdWorkflow(absentDefault)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const normalizedNoop = structuredClone(envelope);
        normalizedNoop.request.expected = { ...normalizedNoop.request.expected, present: true, value: '930' };
        normalizedNoop.prepared.request.expected = normalizedNoop.request.expected;
        expect(env.host.validatePreparedGtdWorkflow(normalizedNoop)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);

        const start = initial(); start.settings.gtd = { ...start.settings.gtd,
            taskEditor: { order: 'bad-legacy-order' } as never, pomodoro: 'bad-legacy-pomodoro' as never };
        const other = await open(start);
        expect(await other.host.getGtdWorkflowOptions({})).toMatchObject({ ok: true,
            value: { expected: { defaultScheduleTime: { present: false } } } });
        const action = await planned(other, { type: 'focusTaskLimit', value: 5 });
        expect(await other.host.commitPreparedGtdWorkflow(action.envelope)).toMatchObject({ ok: true });
        expect(other.data().settings.gtd?.taskEditor).toEqual({ order: 'bad-legacy-order' });
        expect(other.data().settings.gtd?.pomodoro).toBe('bad-legacy-pomodoro');
    });

    it('refuses changed raw field or group stamp, including independently written same destination', async () => {
        const env = await open(initial());
        const { envelope } = await planned(env, { type: 'defaultProjectFlowMode', value: 'sequential' });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings,
            gtd: { ...data.settings.gtd, defaultProjectFlowMode: 'sequential' },
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                gtd: '2026-09-02T00:00:00.000Z' } } }));
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings,
            gtd: { ...data.settings.gtd, defaultProjectFlowMode: undefined, focusTaskLimit: 3 } } }));
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
        expect(env.host.probeGtdWorkflowOutcome(envelope.request)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
    });
});

describe('prepared GTD Auto-archive', () => {
    it('shows the shared seven choices, defaults to seven, and accepts only an offered integer', async () => {
        const env = await open(initial());
        const options = await env.host.getGtdArchiveOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.archive.options.map((row) => row.value)).toEqual([0, 1, 3, 7, 14, 30, 60]);
        expect(options.value.archive.options.find((row) => row.selected)?.value).toBe(7);
        expect(options.value.expected).toEqual({ present: false, value: null, stampPresent: true, stamp: AT });
        for (const row of options.value.archive.options)
            expect(row.edit).toEqual({ type: 'autoArchiveDays', value: row.value });
        for (const value of [-1, 2, 7.5, 90, '7', null, true])
            expect(await env.host.prepareGtdWorkflow({ requestId: ID,
                edit: { type: 'autoArchiveDays', value }, expected: options.value.expected }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        const start = initial(); start.settings.gtd = { ...start.settings.gtd, autoArchiveDays: 0 };
        const never = await open(start);
        const current = await never.host.getGtdArchiveOptions({});
        if (!current.ok) throw new Error(JSON.stringify(current));
        expect(await never.host.prepareGtdWorkflow({ requestId: ID,
            edit: { type: 'autoArchiveDays', value: 0 }, expected: current.value.expected }))
            .toMatchObject({ ok: true, value: { kind: 'noop', result: { changed: false } } });
        expect(never.saves()).toBe(0);
        const malformed = initial(); malformed.settings.gtd = { ...malformed.settings.gtd,
            autoArchiveDays: '7' as never };
        const bad = await open(malformed);
        expect(await bad.host.getGtdArchiveOptions({})).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
    });

    it.each([
        { raw: 10.6, selected: null, replacement: 7 },
        { raw: 90, selected: null, replacement: 30 },
        { raw: -0.4, selected: 0, replacement: 0 },
    ])('corrects legacy raw Auto-archive $raw while preserving its exact witness and replay', async (row) => {
        const start = initial(); start.settings.gtd = { ...start.settings.gtd, autoArchiveDays: row.raw };
        const env = await open(start);
        const options = await env.host.getGtdArchiveOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.expected).toMatchObject({ present: true, value: row.raw });
        expect(options.value.archive.options.find((option) => option.selected)?.value ?? null).toBe(row.selected);
        const { envelope, prepared } = await plannedArchive(env, row.replacement);
        expect(prepared.archiveEffects).toEqual([]);
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.gtd?.autoArchiveDays).toBe(row.replacement);
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
    });

    it('archives old Done tasks immediately with the selected preference and no other task changes', async () => {
        const now = Date.now();
        const old = new Date(now - 40 * 86_400_000).toISOString();
        const recent = new Date(now - 2 * 86_400_000).toISOString();
        const start = initial();
        start.settings.gtd = { ...start.settings.gtd, autoArchiveDays: 0 };
        start.tasks = [
            { ...terminal, id: 'archive-old', status: 'done', deletedAt: undefined,
                completedAt: old, updatedAt: old, rev: 7 },
            { ...terminal, id: 'archive-recent', status: 'done', deletedAt: undefined,
                completedAt: recent, updatedAt: recent },
            { ...terminal, id: 'archive-active', status: 'next', deletedAt: undefined,
                completedAt: old, updatedAt: old },
            { ...terminal, id: 'archive-deleted', status: 'done', completedAt: old, updatedAt: old },
            { ...terminal, id: 'archive-already', status: 'archived', deletedAt: undefined,
                archivedAt: old, completedAt: old, updatedAt: old },
        ];
        const env = await open(start);
        const options = await env.host.getGtdArchiveOptions({});
        if (!options.ok) throw new Error(JSON.stringify(options));
        expect(options.value.archive.options.map((row) => row.value)).toEqual([0, 1, 3, 7, 14, 30, 60]);
        const request: NativeGtdWorkflowRequest = { requestId: ID,
            edit: { type: 'autoArchiveDays', value: 7 }, expected: options.value.expected };
        const planned = await env.host.prepareGtdWorkflow(request);
        if (!planned.ok || planned.value.kind !== 'prepared') throw new Error(JSON.stringify(planned));
        const { prepared } = planned.value;
        expect(prepared.archiveEffects).toHaveLength(1);
        expect(prepared.archiveEffects?.[0].before).toEqual(start.tasks[0]);
        expect(prepared.archiveEffects?.[0].after).toMatchObject({ id: 'archive-old', status: 'archived',
            archivedAt: prepared.preparedAt, updatedAt: prepared.preparedAt, rev: 8, revBy: 'gtd-device' });
        const envelope = { request, prepared };
        expect(env.host.validatePreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().settings.gtd).toEqual({ ...start.settings.gtd, autoArchiveDays: 7 });
        expect(env.data().tasks[0]).toEqual(prepared.archiveEffects?.[0].after);
        expect(env.data().tasks.slice(1)).toEqual(start.tasks.slice(1));
    });

    it('Never preserves already archived tasks and has an empty frozen effect batch', async () => {
        const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
        const start = initial(); start.settings.gtd = { ...start.settings.gtd, autoArchiveDays: 30 };
        start.tasks = [{ ...terminal, id: 'already-archived', status: 'archived',
            deletedAt: undefined, archivedAt: old, completedAt: old, updatedAt: old }];
        const env = await open(start);
        const { envelope, prepared } = await plannedArchive(env, 0);
        expect(prepared.archiveEffects).toEqual([]);
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.data().tasks).toEqual(start.tasks);
        expect(env.data().settings.gtd?.autoArchiveDays).toBe(0);
    });

    it('rejects noncanonical or malformed frozen task effects before storage and incomplete batches at commit', async () => {
        const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
        const start = initial(); start.settings.gtd = { ...start.settings.gtd, autoArchiveDays: 30 };
        start.tasks = [{ ...terminal, id: 'archive-old', status: 'done', deletedAt: undefined,
            completedAt: old, updatedAt: old }];
        const env = await open(start);
        const { envelope } = await plannedArchive(env, 7);
        for (const mutate of [
            (copy: typeof envelope) => { copy.prepared.archiveEffects![0].after.rev = 999; },
            (copy: typeof envelope) => { delete (copy.prepared.archiveEffects![0].before as Partial<Task>).title; },
            (copy: typeof envelope) => { (copy.prepared.archiveEffects![0] as never).extra = true; },
        ]) {
            const forged = structuredClone(envelope); mutate(forged);
            expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(await env.host.commitPreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        const omitted = structuredClone(envelope);
        omitted.prepared.archiveEffects = [];
        expect(await env.host.commitPreparedGtdWorkflow(omitted)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
    });

    it('refuses changed eligible tasks, newly eligible tasks, and newer GTD stamps before any write', async () => {
        const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
        const seed = initial(); seed.settings.gtd = { ...seed.settings.gtd, autoArchiveDays: 30 };
        seed.tasks = [{ ...terminal, id: 'archive-old', status: 'done', deletedAt: undefined,
            completedAt: old, updatedAt: old }];
        for (const change of [
            (data: AppData) => ({ ...data, tasks: data.tasks.map((row) => ({ ...row, title: 'changed' })) }),
            (data: AppData) => ({ ...data, tasks: [...data.tasks,
                { ...data.tasks[0], id: 'newly-eligible' }] }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                    gtd: '2026-09-02T00:00:00.000Z' } } }),
        ]) {
            const env = await open(seed);
            const { envelope } = await plannedArchive(env, 7);
            env.changeSaved(change);
            expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(env.saves()).toBe(0);
        }
    });

    it('replays exact archived rows after unrelated saved edits without overwriting them', async () => {
        const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
        const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
        const seed = initial(); seed.settings.gtd = { ...seed.settings.gtd, autoArchiveDays: 30 };
        seed.tasks = [
            { ...terminal, id: 'archive-old', status: 'done', deletedAt: undefined,
                completedAt: old, updatedAt: old },
            { ...terminal, id: 'archive-recent', status: 'done', deletedAt: undefined,
                completedAt: recent, updatedAt: recent },
        ];
        const env = await open(seed);
        const { envelope, prepared } = await plannedArchive(env, 7);
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        env.changeSaved((data) => ({ ...data, tasks: data.tasks.map((row) => row.id === 'archive-recent'
            ? { ...row, title: 'unrelated later edit' } : row),
        settings: { ...data.settings, language: 'ko' } }));
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
        expect(cold.data().settings.language).toBe('ko');
        expect(cold.data().tasks.find((row) => row.id === 'archive-recent')?.title).toBe('unrelated later edit');
        expect(cold.data().tasks.find((row) => row.id === 'archive-old'))
            .toEqual(prepared.archiveEffects?.[0].after);
    });
});

describe('GTD Capture Default Area in the v1 workflow journal', () => {
    it('pages shared choices with an Area-sensitive revision and a coherent saved pair witness', async () => {
        const start = initial(); start.areas = [homeArea, workArea];
        const env = await open(start);
        const first = await env.host.getGtdCaptureAreaOptions({ offset: 0, limit: 2 });
        if (!first.ok) throw new Error(JSON.stringify(first));
        expect(first.value).toMatchObject({ offset: 0, total: 4,
            expected: { modePresent: false, mode: null, idPresent: false, id: null, stampPresent: true, stamp: AT },
            capture: { defaultArea: { value: expect.any(String), options: [
                { value: '', edit: { type: 'defaultArea', value: '' } },
                { value: '__active-area__', edit: { type: 'defaultArea', value: '__active-area__' } }] } } });
        const next = await env.host.getGtdCaptureAreaOptions({ offset: 2, limit: 2, revision: first.value.revision });
        expect(next).toMatchObject({ ok: true, value: { offset: 2, total: 4,
            expected: first.value.expected, capture: { defaultArea: { options: [
                { value: 'area-work' }, { value: 'area-home' }] } } } });
        expect(await env.host.getGtdCaptureAreaOptions({ offset: 2, limit: 2 })).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        env.changeSaved((data) => ({ ...data, areas: data.areas.map((area) => area.id === 'area-home'
            ? { ...area, order: -1, updatedAt: '2026-09-02T00:00:00.000Z' } : area) }));
        expect(await env.host.getGtdCaptureAreaOptions({ offset: 2, limit: 2, revision: first.value.revision }))
            .toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('writes only the raw pair/stamp, cold-replays, and changes a fresh Quick Capture default', async () => {
        const start = initial(); start.areas = [workArea, homeArea];
        start.settings.gtd = { ...start.settings.gtd, taskEditor: { order: 'bad-legacy' } as never };
        const env = await open(start);
        const beforeDraft = env.host.openQuickCapture();
        expect(beforeDraft).toMatchObject({ ok: true, value: { options: { areaId: null } } });
        const { envelope, prepared } = await plannedArea(env, 'area-work');
        expect(prepared.targetArea).toEqual({ id: 'area-work', createdAt: AT, updatedAt: AT,
            revPresent: true, rev: 1, revByPresent: true, revBy: 'gtd-device' });
        expect(Object.keys(prepared.request.expected).sort()).toEqual([
            'modePresent', 'mode', 'idPresent', 'id', 'stampPresent', 'stamp'].sort());
        expect(env.host.validatePreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(JSON.stringify(envelope)).not.toContain('bad-legacy');
        expect(JSON.stringify(envelope)).not.toContain('Work');
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.saves()).toBe(1);
        expect(env.data().settings.gtd).toEqual({ ...start.settings.gtd,
            defaultAreaMode: 'fixed', defaultAreaId: 'area-work' });
        expect(env.data().settings.syncPreferencesUpdatedAt?.gtd).toBe(prepared.after.stamp);
        expect(env.data().tasks).toEqual(start.tasks);
        expect(beforeDraft).toMatchObject({ ok: true, value: { options: { areaId: null } } });
        expect(env.host.openQuickCapture()).toMatchObject({ ok: true, value: { options: { areaId: 'area-work' } } });
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
        expect(cold.host.openQuickCapture()).toMatchObject({ ok: true, value: { options: { areaId: 'area-work' } } });
    });

    it('uses Active filter only for a fresh capture and explicitly clears a stale fixed Area', async () => {
        const start = initial(); start.areas = [workArea, homeArea];
        start.settings.filters = { areaId: 'area-home' };
        const env = await open(start);
        const active = await plannedArea(env, '__active-area__');
        expect(active.prepared.targetArea).toBeNull();
        expect(await env.host.commitPreparedGtdWorkflow(active.envelope)).toMatchObject({ ok: true });
        expect(env.data().settings.gtd).toMatchObject({ defaultAreaMode: 'active', defaultAreaId: null });
        expect(env.host.openQuickCapture()).toMatchObject({ ok: true, value: { options: { areaId: 'area-home' } } });
        const cold = await env.reopen();
        expect(cold.host.openQuickCapture()).toMatchObject({ ok: true, value: { options: { areaId: 'area-home' } } });

        const gone = initial(); gone.areas = [{ ...workArea, deletedAt: AT }];
        gone.settings.gtd = { ...gone.settings.gtd, defaultAreaMode: 'fixed', defaultAreaId: 'area-work' };
        const missing = await open(gone);
        const page = await missing.host.getGtdCaptureAreaOptions({ offset: 0, limit: 10 });
        expect(page).toMatchObject({ ok: true, value: { expected: { modePresent: true, mode: 'fixed',
            idPresent: true, id: 'area-work' }, capture: { defaultArea: { options: [
                { value: '', selected: true }, { value: '__active-area__', selected: false }] } } } });
        const clear = await plannedArea(missing, '');
        expect(await missing.host.commitPreparedGtdWorkflow(clear.envelope)).toMatchObject({ ok: true });
        expect(missing.data().settings.gtd).toMatchObject({ defaultAreaMode: 'none', defaultAreaId: null });
    });

    it('refuses forged plans, stale selected Areas, and independent same-destination pair writes', async () => {
        const start = initial(); start.areas = [workArea, homeArea];
        const env = await open(start);
        const { envelope } = await plannedArea(env, 'area-work');
        for (const change of [
            (copy: typeof envelope) => { copy.prepared.targetArea = null; },
            (copy: typeof envelope) => { copy.prepared.targetArea = { ...copy.prepared.targetArea!, id: 'area-home' }; },
            (copy: typeof envelope) => { copy.prepared.after.stamp = AT; },
            (copy: typeof envelope) => { copy.prepared.result.changed = false; },
            (copy: typeof envelope) => { delete copy.prepared.targetArea; },
        ]) {
            const forged = structuredClone(envelope); change(forged);
            expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        env.changeSaved((data) => ({ ...data, areas: data.areas.map((area) => area.id === 'area-work'
            ? { ...area, updatedAt: '2026-09-02T00:00:00.000Z', rev: 2 } : area) }));
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
        env.changeSaved((data) => ({ ...data, areas: start.areas,
            settings: { ...data.settings, gtd: { ...data.settings.gtd,
                defaultAreaMode: 'fixed', defaultAreaId: 'area-work' },
                syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                    gtd: '2026-09-03T00:00:00.000Z' } } }));
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(cold.saves()).toBe(0);
    });

    it('keeps raw absence/null/unknown distinct and ignores malformed unrelated GTD siblings', async () => {
        const start = initial(); start.areas = [workArea];
        start.settings.gtd = { ...start.settings.gtd, defaultAreaMode: 'legacy-unknown' as never,
            defaultAreaId: null, pomodoro: 7 as never };
        const env = await open(start);
        const options = await env.host.getGtdCaptureAreaOptions({ offset: 0, limit: 10 });
        expect(options).toMatchObject({ ok: true, value: { expected: { modePresent: true,
            mode: 'legacy-unknown', idPresent: true, id: null } } });
        const plan = await plannedArea(env, 'area-work');
        expect(await env.host.commitPreparedGtdWorkflow(plan.envelope)).toMatchObject({ ok: true });
        expect(env.data().settings.gtd?.pomodoro).toBe(7);
        for (const bad of [{ defaultAreaMode: {} }, { defaultAreaId: 9 }, { defaultAreaId: [] }]) {
            const malformed = initial(); malformed.settings.gtd = { ...malformed.settings.gtd, ...bad } as never;
            const other = await open(malformed);
            expect(await other.host.getGtdCaptureAreaOptions({ offset: 0, limit: 10 })).toMatchObject({
                ok: false, error: { code: 'INVALID_INPUT' } });
        }
        const storedNone = initial(); storedNone.settings.gtd = { defaultAreaMode: 'none', defaultAreaId: null };
        const none = await open(storedNone);
        const read = await none.host.getGtdCaptureAreaOptions({ offset: 0, limit: 10 });
        if (!read.ok) throw new Error(JSON.stringify(read));
        expect(await none.host.prepareGtdWorkflow({ requestId: ID, edit: { type: 'defaultArea', value: '' },
            expected: read.value.expected })).toMatchObject({ ok: true,
                value: { kind: 'noop', result: { type: 'defaultArea', value: '', changed: false } } });
    });

    it('resolves Active from live/All/None filters without overriding an explicit capture preset', async () => {
        for (const [filter, expected] of [
            ['area-work', 'area-work'], ['__all__', null], ['__none__', null],
        ] as const) {
            const start = initial(); start.areas = [workArea, homeArea];
            start.settings.gtd = { ...start.settings.gtd, defaultAreaMode: 'active', defaultAreaId: null };
            start.settings.filters = { areaId: filter };
            const env = await open(start);
            expect(env.host.openQuickCapture()).toMatchObject({ ok: true, value: { options: { areaId: expected } } });
            const resolved = resolveQuickCaptureDefaultAreaId(env.data().settings, env.data().areas);
            expect(resolved).toBe(expected);
            expect(createQuickCaptureOptions({ projects: [], defaultAreaId: resolved,
                initialProps: { areaId: 'area-home' } }).areaId).toBe('area-home');
        }
    });
});

describe('GTD Review variants in the original v1 workflow journal', () => {
    it.each([
        { type: 'dailyReviewFocusStep', value: false, parent: 'dailyReview', field: 'includeFocusStep' },
        { type: 'weeklyReviewContextStep', value: false, parent: 'weeklyReview', field: 'includeContextStep' },
    ] as const)('saves $type and cold-replays only its nested boolean and stamp', async (edit) => {
        const start = initial();
        start.settings.gtd = { ...start.settings.gtd,
            dailyReview: { legacyDaily: 'keep' } as never,
            weeklyReview: { legacyWeekly: 'keep' } as never };
        const env = await open(start);
        const { options, envelope, prepared } = await plannedReview(env, { type: edit.type, value: edit.value });
        expect(Object.keys(options.expected).sort()).toEqual(['dailyReviewFocusStep', 'weeklyReviewContextStep']);
        expect(options.expected[edit.type]).toEqual({ parentPresent: true, present: false,
            value: null, stampPresent: true, stamp: AT });
        const toggle = edit.type === 'dailyReviewFocusStep' ? options.review.dailyFocusStep : options.review.weeklyContextStep;
        expect(toggle).toMatchObject({ value: true, edit: { type: edit.type, value: false } });
        expect(prepared.version).toBe(1);
        expect(Object.keys(envelope.request.expected).sort()).toEqual(['parentPresent', 'present', 'stamp', 'stampPresent', 'value']);
        expect(env.host.validatePreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(JSON.stringify(envelope)).not.toContain('legacyDaily');
        expect(JSON.stringify(envelope)).not.toContain('legacyWeekly');
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(env.saves()).toBe(1);
        const saved = env.data();
        expect((saved.settings.gtd?.[edit.parent] as Record<string, unknown>)[edit.field]).toBe(false);
        expect(saved.settings.gtd?.dailyReview).toMatchObject({ legacyDaily: 'keep' });
        expect(saved.settings.gtd?.weeklyReview).toMatchObject({ legacyWeekly: 'keep' });
        expect(saved.settings.syncPreferencesUpdatedAt?.gtd).toBe(prepared.after.stamp);
        expect(saved.tasks).toEqual(start.tasks);
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
    });

    it('removes and restores real Daily focus and Weekly contexts steps, reconciling saved checkpoints', async () => {
        const start = initial();
        start.tasks.push({ ...terminal, id: 'gtd-action', title: 'Context action', status: 'next',
            contexts: ['@Home'], deletedAt: undefined, focusOrder: undefined });
        const env = await open(start);
        const startedAt = new Date().toISOString();
        const dailyCheckpoint = JSON.stringify({ step: 'focus', startedAt });
        const weeklyCheckpoint = JSON.stringify({ step: 'contexts', startedAt });
        expect(env.host.getDailyReview({ checkpoint: dailyCheckpoint, offset: 0, limit: 1 }))
            .toMatchObject({ ok: true, value: { step: { id: 'focus' } } });
        const beforeWeekly = env.host.getWeeklyReview({ checkpoint: weeklyCheckpoint, offset: 0, limit: 1 });
        expect(beforeWeekly).toMatchObject({ ok: true, value: { step: { id: 'contexts' } } });
        if (!beforeWeekly.ok) throw new Error(JSON.stringify(beforeWeekly));
        expect(beforeWeekly.value.rail.map((step) => step.id)).toContain('contexts');
        const daily = await plannedReview(env, { type: 'dailyReviewFocusStep', value: false });
        expect(await env.host.commitPreparedGtdWorkflow(daily.envelope)).toMatchObject({ ok: true });
        const weekly = await plannedReview(env, { type: 'weeklyReviewContextStep', value: false });
        expect(await env.host.commitPreparedGtdWorkflow(weekly.envelope)).toMatchObject({ ok: true });
        const noFocus = env.host.getDailyReview({ checkpoint: dailyCheckpoint, offset: 0, limit: 1 });
        expect(noFocus).toMatchObject({ ok: true });
        if (!noFocus.ok) throw new Error(JSON.stringify(noFocus));
        expect(noFocus.value.step.id).not.toBe('focus');
        const noContexts = env.host.getWeeklyReview({ checkpoint: weeklyCheckpoint, offset: 0, limit: 1 });
        expect(noContexts).toMatchObject({ ok: true });
        if (!noContexts.ok) throw new Error(JSON.stringify(noContexts));
        expect(noContexts.value.step.id).not.toBe('contexts');
        expect(noContexts.value.rail.map((step) => step.id)).not.toContain('contexts');
        const restoreDaily = await plannedReview(env, { type: 'dailyReviewFocusStep', value: true });
        expect(await env.host.commitPreparedGtdWorkflow(restoreDaily.envelope)).toMatchObject({ ok: true });
        const restoreWeekly = await plannedReview(env, { type: 'weeklyReviewContextStep', value: true });
        expect(await env.host.commitPreparedGtdWorkflow(restoreWeekly.envelope)).toMatchObject({ ok: true });
        expect(env.host.getDailyReview({ checkpoint: dailyCheckpoint, offset: 0, limit: 1 }))
            .toMatchObject({ ok: true, value: { step: { id: 'focus' } } });
        const restored = env.host.getWeeklyReview({ checkpoint: weeklyCheckpoint, offset: 0, limit: 1 });
        expect(restored).toMatchObject({ ok: true });
        if (!restored.ok) throw new Error(JSON.stringify(restored));
        expect(restored.value.rail.map((step) => step.id)).toContain('contexts');
    });

    it('binds absent parent, raw boolean and group stamp; malformed relevant rows refuse', async () => {
        const env = await open(initial());
        const option = await env.host.getGtdReviewOptions({});
        expect(option).toMatchObject({ ok: true, value: { expected: {
            dailyReviewFocusStep: { parentPresent: false, present: false, value: null },
            weeklyReviewContextStep: { parentPresent: false, present: false, value: null },
        } } });
        const { envelope } = await plannedReview(env, { type: 'dailyReviewFocusStep', value: false });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings,
            gtd: { ...data.settings.gtd, dailyReview: {} } } }));
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
        for (const bad of [null, [], 'bad', { includeFocusStep: 'false' }]) {
            const start = initial(); start.settings.gtd = { ...start.settings.gtd, dailyReview: bad as never };
            const other = await open(start);
            expect(await other.host.getGtdReviewOptions({})).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        for (const bad of [null, [], 'bad', { includeContextStep: 'false' }]) {
            const start = initial(); start.settings.gtd = { ...start.settings.gtd, weeklyReview: bad as never };
            const other = await open(start);
            expect(await other.host.getGtdReviewOptions({})).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        const start = initial(); start.settings.gtd = { ...start.settings.gtd,
            taskEditor: { order: 'bad-order' } as never, pomodoro: 'bad-pomodoro' as never };
        const other = await open(start);
        expect(await other.host.getGtdReviewOptions({})).toMatchObject({ ok: true });
    });

    it('keeps shared Review default and exact stored no-write policy', async () => {
        for (const type of ['dailyReviewFocusStep', 'weeklyReviewContextStep'] as const) {
            const absent = await open(initial());
            const options = await absent.host.getGtdReviewOptions({});
            if (!options.ok) throw new Error(JSON.stringify(options));
            const toggle = type === 'dailyReviewFocusStep'
                ? options.value.review.dailyFocusStep : options.value.review.weeklyContextStep;
            expect(toggle).toMatchObject({ value: true, edit: { type, value: false } });
            // Materializing true from absence differs from raw storage and is
            // not the edit offered by RN's shared toggle model.
            expect(await absent.host.prepareGtdWorkflow({ requestId: ID,
                edit: { type, value: true }, expected: options.value.expected[type] }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(absent.saves()).toBe(0);
            for (const value of [true, false]) {
                const start = initial();
                start.settings.gtd = { ...start.settings.gtd,
                    [type === 'dailyReviewFocusStep' ? 'dailyReview' : 'weeklyReview']:
                        { [type === 'dailyReviewFocusStep' ? 'includeFocusStep' : 'includeContextStep']: value } };
                const env = await open(start);
                const current = await env.host.getGtdReviewOptions({});
                if (!current.ok) throw new Error(JSON.stringify(current));
                expect(await env.host.prepareGtdWorkflow({ requestId: ID,
                    edit: { type, value }, expected: current.value.expected[type] }))
                    .toMatchObject({ ok: true, value: { kind: 'noop', result: { changed: false } } });
                expect(env.saves()).toBe(0);
            }
        }
    });

    it('refuses an independently changed selected bool or GTD group stamp', async () => {
        for (const change of [
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                gtd: { ...data.settings.gtd, dailyReview: { includeFocusStep: true } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                    gtd: '2026-09-02T00:00:00.000Z' } } }),
        ]) {
            const env = await open(initial());
            const { envelope } = await plannedReview(env, { type: 'dailyReviewFocusStep', value: false });
            env.changeSaved(change);
            expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(env.saves()).toBe(0);
        }
    });

    it('rejects forged nested no-ops and changed field/group receipts', async () => {
        const env = await open(initial());
        const { envelope, request } = await plannedReview(env, { type: 'weeklyReviewContextStep', value: false });
        const unavailable = structuredClone(envelope);
        unavailable.request.edit.value = true;
        unavailable.prepared.request.edit.value = true;
        unavailable.prepared.after.value = true;
        unavailable.prepared.result.value = true;
        expect(env.host.validatePreparedGtdWorkflow(unavailable)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(await env.host.commitPreparedGtdWorkflow(unavailable)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const forged = structuredClone(envelope);
        forged.request.expected = { parentPresent: true, present: true, value: false,
            stampPresent: true, stamp: AT };
        forged.prepared.request.expected = forged.request.expected;
        expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const malformed = structuredClone(envelope);
        (malformed.request.expected as Record<string, unknown>).parentPresent = false;
        (malformed.request.expected as Record<string, unknown>).present = true;
        expect(env.host.validatePreparedGtdWorkflow(malformed)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        env.changeSaved((data) => ({ ...data, settings: { ...data.settings,
            gtd: { ...data.settings.gtd, weeklyReview: { includeContextStep: false } },
            syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                gtd: '2026-09-02T00:00:00.000Z' } } }));
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.host.probeGtdWorkflowOutcome(request)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
    });
});

describe('GTD Inbox variants in the original v1 workflow journal', () => {
    it.each([
        { type: 'inboxTwoMinute', value: false, defaultValue: true },
        { type: 'inboxProjectFirst', value: true, defaultValue: false },
        { type: 'inboxContextStep', value: false, defaultValue: true },
        { type: 'inboxSchedule', value: true, defaultValue: false },
    ] as const)('saves $type with its shared default and only selected raw field', async (edit) => {
        const start = initial();
        start.settings.gtd = { ...start.settings.gtd,
            inboxProcessing: { legacyInbox: { marker: 105 } } as never,
            pomodoro: 'malformed-unrelated' as never };
        const env = await open(start);
        const { options, envelope, prepared } = await plannedInbox(env, { type: edit.type, value: edit.value });
        expect(Object.keys(options.expected).sort()).toEqual(Object.keys(inboxField).sort());
        expect(options.expected[edit.type]).toEqual({ parentPresent: true, present: false,
            value: null, stampPresent: true, stamp: AT });
        expect(options.inbox[inboxToggle[edit.type]]).toMatchObject({ value: edit.defaultValue,
            edit: { type: edit.type, value: edit.value } });
        expect(prepared.version).toBe(1);
        expect(Object.keys(envelope.request.expected).sort()).toEqual([
            'parentPresent', 'present', 'stamp', 'stampPresent', 'value']);
        expect(JSON.stringify(envelope)).not.toContain('legacyInbox');
        expect(env.host.validatePreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        const saved = env.data();
        expect((saved.settings.gtd?.inboxProcessing as Record<string, unknown>)[inboxField[edit.type]]).toBe(edit.value);
        expect(saved.settings.gtd?.inboxProcessing).toMatchObject({ legacyInbox: { marker: 105 } });
        expect(saved.settings.syncPreferencesUpdatedAt?.gtd).toBe(prepared.after.stamp);
        expect(saved.tasks).toEqual(start.tasks);
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
    });

    it('applies the two on and two off defaults as offered flips, refusing absent materialization', async () => {
        for (const type of Object.keys(inboxField) as InboxType[]) {
            const env = await open(initial());
            const options = await env.host.getGtdInboxOptions({});
            if (!options.ok) throw new Error(JSON.stringify(options));
            const offered = options.value.inbox[inboxToggle[type]].edit;
            expect(options.value.expected[type]).toEqual({ parentPresent: false, present: false,
                value: null, stampPresent: true, stamp: AT });
            expect(await env.host.prepareGtdWorkflow({ requestId: ID,
                edit: { type, value: !offered.value }, expected: options.value.expected[type] }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const { envelope } = await plannedInbox(env, { type, value: offered.value });
            const forged = structuredClone(envelope);
            forged.request.edit.value = !offered.value;
            forged.prepared.request.edit.value = !offered.value;
            forged.prepared.after.value = !offered.value;
            forged.prepared.result.value = !offered.value;
            expect(env.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(env.saves()).toBe(0);
            for (const value of [true, false]) {
                const start = initial();
                start.settings.gtd = { ...start.settings.gtd,
                    inboxProcessing: { [inboxField[type]]: value } };
                const present = await open(start);
                const current = await present.host.getGtdInboxOptions({});
                if (!current.ok) throw new Error(JSON.stringify(current));
                expect(await present.host.prepareGtdWorkflow({ requestId: ID,
                    edit: { type, value }, expected: current.value.expected[type] }))
                    .toMatchObject({ ok: true, value: { kind: 'noop', result: { changed: false } } });
                expect(present.saves()).toBe(0);
            }
        }
    });

    it('refuses malformed relevant rows and a changed parent, field, or GTD stamp', async () => {
        for (const bad of [null, [], 'bad', { twoMinuteEnabled: 'false' }, { scheduleEnabled: 1 }]) {
            const start = initial(); start.settings.gtd = { ...start.settings.gtd, inboxProcessing: bad as never };
            const env = await open(start);
            expect(await env.host.getGtdInboxOptions({})).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        for (const change of [
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                gtd: { ...data.settings.gtd, inboxProcessing: {} } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                gtd: { ...data.settings.gtd, inboxProcessing: { scheduleEnabled: true } } } }),
            (data: AppData) => ({ ...data, settings: { ...data.settings,
                syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                    gtd: '2026-09-02T00:00:00.000Z' } } }),
        ]) {
            const env = await open(initial());
            const { envelope } = await plannedInbox(env, { type: 'inboxSchedule', value: true });
            env.changeSaved(change);
            expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                error: { code: 'STALE_REVISION' } });
            expect(env.saves()).toBe(0);
        }
    });

    it('makes all four saved choices visible in a fresh real Process Inbox session', async () => {
        const start = initial();
        start.tasks.push({ ...terminal, id: 'gtd-inbox-candidate', title: 'Sort mail', status: 'inbox',
            deletedAt: undefined, focusOrder: undefined });
        const env = await open(start);
        const baseline = env.host.startInboxProcessing({ mode: 'quick' });
        if (!baseline.ok || !baseline.value.view) throw new Error(JSON.stringify(baseline));
        expect(baseline.value.view.choices.map((choice) => choice.id)).toContain('done');
        expect(baseline.value.view.projectFirst).toBe(false);
        for (const edit of [
            { type: 'inboxTwoMinute', value: false }, { type: 'inboxProjectFirst', value: true },
            { type: 'inboxContextStep', value: false }, { type: 'inboxSchedule', value: true },
        ] as const) {
            const { envelope } = await plannedInbox(env, edit);
            expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: true });
        }
        const cold = await env.reopen();
        const quick = cold.host.startInboxProcessing({ mode: 'quick' });
        if (!quick.ok || !quick.value.view) throw new Error(JSON.stringify(quick));
        expect(quick.value.view.choices.map((choice) => choice.id)).not.toContain('done');
        expect(quick.value.view.projectFirst).toBe(true);
        const guided = cold.host.startInboxProcessing({ mode: 'guided' });
        if (!guided.ok || !guided.value.view) throw new Error(JSON.stringify(guided));
        const sessionId = guided.value.sessionId!;
        let view = guided.value.view;
        const choose = async (choice: string) => {
            const next = await cold.host.commitInboxProcessingStep({ sessionId, taskId: view.taskId,
                step: view.step, decision: { choice }, requestId: generateUUID() });
            if (!next.ok || !next.value.view) throw new Error(JSON.stringify(next));
            view = next.value.view;
        };
        expect(view.step).toBe('actionable');
        await choose('actionable');
        expect(view.step).toBe('execution');
        await choose('defer');
        await choose('single');
        expect(view.step).toBe('file');
        expect(view.contexts).toBeNull();
        expect(view.projectFirst).toBe(true);
        const expanded = cold.host.getInboxProcessingStep({ sessionId, taskId: view.taskId,
            step: view.step, edit: { type: 'toggleAdvancedOptions' } });
        if (!expanded.ok) throw new Error(JSON.stringify(expanded));
        expect(expanded.value.moreOptions?.scheduling?.rows.map((row) => row.field))
            .toEqual(['startTime', 'dueDate', 'reviewAt']);
    });
});

describe('GTD Capture parser toggles in the original v1 workflow journal', () => {
    it.each([
        { type: 'naturalLanguageDates', value: false, shown: true },
        { type: 'quickAddAutoClean', value: true, shown: false },
    ] as const)('saves $type and preserves unrelated raw siblings', async (edit) => {
        const start = initial();
        start.settings.gtd = { ...start.settings.gtd, taskEditor: 'malformed-unrelated' as never };
        const env = await open(start);
        const { options, envelope, prepared } = await plannedCaptureParse(env,
            { type: edit.type, value: edit.value });
        expect(Object.keys(options.capture).sort()).toEqual([
            'title', 'description', 'quickAddAutoClean', 'naturalLanguageDates'].sort());
        expect(Object.keys(options.expected).sort()).toEqual(['naturalLanguageDates', 'quickAddAutoClean']);
        expect(options.capture[edit.type]).toMatchObject({ value: edit.shown, edit: { type: edit.type, value: edit.value } });
        expect(options.expected[edit.type]).toEqual({ present: false, value: null, stampPresent: true, stamp: AT });
        expect(Object.keys(envelope.request.expected).sort()).toEqual(['present', 'stamp', 'stampPresent', 'value']);
        expect(Object.keys(prepared).sort()).toEqual([
            'version', 'request', 'preparedAt', 'deviceIdBefore', 'deviceIdToInitialize', 'after', 'result'].sort());
        expect(JSON.stringify(envelope)).not.toContain('legacySibling');
        expect(env.host.validatePreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(await env.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        const saved = env.data();
        expect(edit.type === 'naturalLanguageDates'
            ? saved.settings.gtd?.naturalLanguageDates : saved.settings.quickAddAutoClean).toBe(edit.value);
        expect(saved.settings.gtd).toMatchObject({ legacySibling: { marker: 103 }, taskEditor: 'malformed-unrelated' });
        expect(saved.settings.syncPreferencesUpdatedAt?.gtd).toBe(prepared.after.stamp);
        expect(saved.tasks).toEqual(start.tasks);
        const cold = await env.reopen();
        expect(await cold.host.commitPreparedGtdWorkflow(envelope)).toEqual({ ok: true, value: prepared.result });
        expect(cold.saves()).toBe(0);
    });

    it('uses shared displayed defaults, refusing absent materialization and present no-ops', async () => {
        for (const type of ['naturalLanguageDates', 'quickAddAutoClean'] as const) {
            const absent = await open(initial());
            const options = await absent.host.getGtdCaptureParseOptions({});
            if (!options.ok) throw new Error(JSON.stringify(options));
            const offered = options.value.capture[type].edit as { type: CaptureParseType; value: boolean };
            expect(await absent.host.prepareGtdWorkflow({ requestId: ID,
                edit: { type, value: !offered.value }, expected: options.value.expected[type] }))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            const { envelope } = await plannedCaptureParse(absent, { type, value: offered.value });
            const forged = structuredClone(envelope);
            forged.request.edit.value = !offered.value;
            forged.prepared.request.edit.value = !offered.value;
            forged.prepared.after.value = !offered.value;
            forged.prepared.result.value = !offered.value;
            expect(absent.host.validatePreparedGtdWorkflow(forged)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
            expect(absent.saves()).toBe(0);
            for (const value of [true, false]) {
                const start = initial();
                if (type === 'quickAddAutoClean') start.settings.quickAddAutoClean = value;
                else start.settings.gtd = { ...start.settings.gtd, naturalLanguageDates: value };
                const present = await open(start);
                const current = await present.host.getGtdCaptureParseOptions({});
                if (!current.ok) throw new Error(JSON.stringify(current));
                expect(await present.host.prepareGtdWorkflow({ requestId: ID,
                    edit: { type, value }, expected: current.value.expected[type] }))
                    .toMatchObject({ ok: true, value: { kind: 'noop', result: { changed: false } } });
                expect(present.saves()).toBe(0);
            }
        }
    });

    it('separates relevant malformed fields from unrelated GTD data and checks field/group CAS', async () => {
        for (const type of ['naturalLanguageDates', 'quickAddAutoClean'] as const) {
            for (const bad of [null, 'yes', 1]) {
                const start = initial();
                if (type === 'quickAddAutoClean') start.settings.quickAddAutoClean = bad as never;
                else start.settings.gtd = { ...start.settings.gtd, naturalLanguageDates: bad as never };
                const env = await open(start);
                expect(await env.host.getGtdCaptureParseOptions({})).toMatchObject({ ok: false,
                    error: { code: 'INVALID_INPUT' } });
            }
        }
        const malformed = initial(); malformed.settings.gtd = 'bad-unrelated' as never;
        const top = await open(malformed);
        expect(await top.host.getGtdCaptureParseOptions({})).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        const request: NativeGtdWorkflowRequest = { requestId: ID,
            edit: { type: 'quickAddAutoClean', value: true },
            expected: { present: false, value: null, stampPresent: true, stamp: AT } };
        const plan = await top.host.prepareGtdWorkflow(request);
        if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(JSON.stringify(plan));
        expect(await top.host.commitPreparedGtdWorkflow({ request, prepared: plan.value.prepared }))
            .toMatchObject({ ok: true });
        expect(top.data().settings.gtd).toBe('bad-unrelated');
        expect(top.data().settings.quickAddAutoClean).toBe(true);

        for (const type of ['naturalLanguageDates', 'quickAddAutoClean'] as const) {
            for (const change of [
                (data: AppData) => ({ ...data, settings: { ...data.settings,
                    ...(type === 'quickAddAutoClean' ? { quickAddAutoClean: true }
                        : { gtd: { ...data.settings.gtd, naturalLanguageDates: false } }) } }),
                (data: AppData) => ({ ...data, settings: { ...data.settings,
                    syncPreferencesUpdatedAt: { ...data.settings.syncPreferencesUpdatedAt,
                        gtd: '2026-09-02T00:00:00.000Z' } } }),
            ]) {
                const env = await open(initial());
                const { envelope } = await plannedCaptureParse(env,
                    { type, value: type === 'quickAddAutoClean' });
                env.changeSaved(change);
                expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: false,
                    error: { code: 'STALE_REVISION' } });
                expect(env.saves()).toBe(0);
            }
        }
    });

    it.each([
        { dates: true, clean: false, bareDue: true, bareTitle: 'Task107 parser tomorrow' },
        { dates: true, clean: true, bareDue: true, bareTitle: 'Task107 parser' },
        { dates: false, clean: false, bareDue: false, bareTitle: 'Task107 parser tomorrow' },
        { dates: false, clean: true, bareDue: false, bareTitle: 'Task107 parser tomorrow' },
    ])('applies saved parser flags to a fresh Quick Capture ($dates, $clean)', async (row) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'));
        const env = await open(initial());
        if (!row.dates) {
            const { envelope } = await plannedCaptureParse(env, { type: 'naturalLanguageDates', value: false });
            expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: true });
        }
        if (row.clean) {
            const { envelope } = await plannedCaptureParse(env, { type: 'quickAddAutoClean', value: true });
            expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: true });
        }
        const cold = await env.reopen();
        const opened = cold.host.openQuickCapture();
        if (!opened.ok) throw new Error(JSON.stringify(opened));
        const text = 'Task107 parser tomorrow';
        const preview = cold.host.getQuickCaptureView({ text, options: opened.value.options });
        if (!preview.ok) throw new Error(JSON.stringify(preview));
        expect(preview.value.preview.some((chip) => chip.kind === 'due')).toBe(row.bareDue);
        const captureId = generateUUID();
        expect(await cold.host.submitQuickCapture({ text, options: opened.value.options, captureId }))
            .toMatchObject({ ok: true, value: { kind: 'saved', taskId: captureId } });
        const task = cold.data().tasks.find((entry) => entry.id === captureId);
        expect(task?.title).toBe(row.bareTitle);
        expect(Boolean(task?.dueDate)).toBe(row.bareDue);
        if (row.bareDue) expect(task?.dueDate).toContain('2026-10-01');

        const explicit = cold.host.openQuickCapture();
        if (!explicit.ok) throw new Error(JSON.stringify(explicit));
        const explicitId = generateUUID();
        expect(await cold.host.submitQuickCapture({ text: 'Explicit /due:tomorrow',
            options: explicit.value.options, captureId: explicitId })).toMatchObject({ ok: true,
            value: { kind: 'saved', taskId: explicitId } });
        const explicitTask = cold.data().tasks.find((entry) => entry.id === explicitId);
        expect(explicitTask?.title).toBe('Explicit');
        expect(explicitTask?.dueDate).toContain('2026-10-01');
    });

    it('keeps an open draft and prepared capture bound to their original parse options', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'));
        const env = await open(initial());
        const opened = env.host.openQuickCapture();
        if (!opened.ok) throw new Error(JSON.stringify(opened));
        const text = 'Task107 parser tomorrow';
        const request = { text, options: opened.value.options, captureId: generateUUID() };
        const prepared = env.host.prepareQuickCapture(request);
        if (!prepared.ok || prepared.value.kind !== 'prepared') throw new Error(JSON.stringify(prepared));
        const taskCount = env.data().tasks.length;
        for (const edit of [
            { type: 'naturalLanguageDates', value: false },
            { type: 'quickAddAutoClean', value: true },
        ] as const) {
            const { envelope } = await plannedCaptureParse(env, edit);
            expect(await env.host.commitPreparedGtdWorkflow(envelope)).toMatchObject({ ok: true });
        }
        expect(env.data().tasks).toHaveLength(taskCount);
        const retained = env.host.getQuickCaptureView({ text, options: opened.value.options });
        if (!retained.ok) throw new Error(JSON.stringify(retained));
        expect(retained.value.preview.some((chip) => chip.kind === 'due')).toBe(true);
        expect(await env.host.commitPreparedQuickCapture({ request, prepared: prepared.value.prepared }))
            .toMatchObject({ ok: true });
        const saved = env.data().tasks.find((task) => task.id === request.captureId);
        expect(saved?.title).toBe(text);
        expect(saved?.dueDate).toContain('2026-10-01');
        const cold = await env.reopen();
        const fresh = cold.host.openQuickCapture();
        if (!fresh.ok) throw new Error(JSON.stringify(fresh));
        const after = cold.host.getQuickCaptureView({ text, options: fresh.value.options });
        if (!after.ok) throw new Error(JSON.stringify(after));
        expect(after.value.preview.some((chip) => chip.kind === 'due')).toBe(false);
    });
});


const pomodoroFields = {
    pomodoroLinkTask: 'linkTask', pomodoroAutoStartBreaks: 'autoStartBreaks',
    pomodoroAutoStartFocus: 'autoStartFocus', pomodoroCompletionAlert: 'completionAlert',
} as const;
const pomodoroStart = (): AppData => {
    const data = initial(); data.settings.features = { pomodoro: true, priorities: true };
    data.settings.gtd = { ...data.settings.gtd, pomodoro: { legacySibling: 'preserve' } } as AppData['settings']['gtd'];
    return data;
};

describe('durable Pomodoro Settings', () => {
    it('projects absent raw defaults and keeps disabled dependent controls unavailable', async () => {
        const env = await open(initial());
        const read = await env.host.getGtdPomodoroOptions({});
        expect(read.ok).toBe(true); if (!read.ok) return;
        expect(read.value.pomodoro).toEqual(buildGtdSettingsModel({ settings: initial().settings,
            areas: [], taskOpenMode: 'automatic', t: (key) => key }).pomodoro);
        expect(read.value.expected.pomodoro).toEqual({ parentPresent: false, present: false,
            value: null, stampPresent: true, stamp: AT });
        for (const type of [...Object.keys(pomodoroFields), 'pomodoroDurations'])
            expect(read.value.expected[type as keyof typeof read.value.expected]).toBeNull();
        const hub = await env.host.getGtdWorkflowOptions({});
        expect(hub.ok && hub.value.expected.pomodoro).toEqual(read.value.expected.pomodoro);
        const enabled = await plannedPomodoro(env, { type: 'pomodoro', value: true });
        expect(await env.host.commitPreparedGtdWorkflow(enabled.envelope)).toEqual({ ok: true,
            value: { type: 'pomodoro', value: true, changed: true } });
        expect(env.data().settings.features?.pomodoro).toBe(true);
    });

    it.each(Object.entries(pomodoroFields))('preserves default polarity and exact inverse for %s', async (type, field) => {
        const env = await open(pomodoroStart());
        const options = await env.host.getGtdPomodoroOptions({});
        expect(options.ok).toBe(true); if (!options.ok) return;
        expect(options.value.expected[type as keyof typeof pomodoroFields]).toMatchObject({
            parentPresent: true, present: false, value: null,
            gate: { featuresPresent: true, enabled: { present: true, value: true } } });
        const value = type !== 'pomodoroCompletionAlert';
        const edit = { type, value } as { type: keyof typeof pomodoroFields; value: boolean };
        const frozen = await plannedPomodoro(env, edit);
        expect(await env.host.commitPreparedGtdWorkflow(frozen.envelope)).toEqual({ ok: true,
            value: { type, value, changed: true } });
        expect(env.data().settings.gtd?.pomodoro).toEqual({ legacySibling: 'preserve', [field]: value });
        expect(env.data().settings.features).toEqual(pomodoroStart().settings.features);
    });

    it.each(Object.entries(pomodoroFields).flatMap(([type, field]) =>
        [false, true].map((value) => ({ type: type as keyof typeof pomodoroFields, field, value }))))(
        'retains explicit raw $type=$value presence and offers its inverse', async ({ type, field, value }) => {
            const start = pomodoroStart(); Object.assign(start.settings.gtd!.pomodoro!, { [field]: value });
            const env = await open(start); const read = await env.host.getGtdPomodoroOptions({});
            expect(read.ok).toBe(true); if (!read.ok) return;
            expect(read.value.expected[type]).toMatchObject({ parentPresent: true, present: true, value });
            const frozen = await plannedPomodoro(env, { type, value: !value });
            expect(await env.host.commitPreparedGtdWorkflow(frozen.envelope)).toMatchObject({ ok: true });
            expect((env.data().settings.gtd?.pomodoro as Record<string, unknown>)[field]).toBe(!value);
        });

    it('disables only unsupported selected shapes and never repairs malformed siblings', async () => {
        const start = pomodoroStart();
        start.settings.gtd!.pomodoro = { linkTask: 'wrong', customDurations: { focusMinutes: 25, alien: 2 },
            completionAlert: false } as never;
        const env = await open(start);
        const read = await env.host.getGtdPomodoroOptions({});
        expect(read.ok).toBe(true); if (!read.ok) return;
        expect(read.value.expected.pomodoroLinkTask).toBeNull();
        expect(read.value.expected.pomodoroDurations).toBeNull();
        expect(read.value.expected.pomodoroCompletionAlert).not.toBeNull();
        const frozen = await plannedPomodoro(env, { type: 'pomodoroCompletionAlert', value: true });
        expect(await env.host.commitPreparedGtdWorkflow(frozen.envelope)).toMatchObject({ ok: true });
        expect(env.data().settings.gtd?.pomodoro).toEqual({ ...start.settings.gtd?.pomodoro, completionAlert: true });
        expect(await env.host.prepareGtdWorkflow({ requestId: ID, edit: { type: 'pomodoroLinkTask', value: true },
            expected: null })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('reads one durable options snapshot and propagates read failures instead of unavailable witnesses', async () => {
        let failed = false; const env = await open(pomodoroStart(), undefined, () => failed);
        expect(await env.host.getGtdPomodoroOptions({})).toMatchObject({ ok: true });
        expect(env.reads()).toBe(1); expect(env.saves()).toBe(0);
        expect(await env.host.getGtdPomodoroOptions({ extra: true })).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(env.reads()).toBe(1);
        failed = true;
        expect(await env.host.getGtdPomodoroOptions({})).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(env.reads()).toBe(2);
    });

    it.each([false, { pomodoro: 'bad' }, { pomodoro: false }])('does not grant availability through malformed/off features %j', async (features) => {
        const start = pomodoroStart(); start.settings.features = features as never;
        const env = await open(start);
        const read = await env.host.getGtdPomodoroOptions({});
        expect(read.ok).toBe(true); if (!read.ok) return;
        expect(read.value.pomodoro.controls).toBeNull();
        for (const type of [...Object.keys(pomodoroFields), 'pomodoroDurations'])
            expect(read.value.expected[type as keyof typeof read.value.expected]).toBeNull();
        const hub = await env.host.getGtdWorkflowOptions({});
        expect(hub.ok).toBe(true);
    });

    it('feature toggles ignore malformed unrelated GTD subpages and preserve their raw bytes', async () => {
        const start = initial(); start.settings.gtd = 'legacy' as never;
        const env = await open(start);
        const frozen = await plannedPomodoro(env, { type: 'pomodoro', value: true });
        expect(await env.host.commitPreparedGtdWorkflow(frozen.envelope)).toMatchObject({ ok: true });
        expect(env.data().settings.gtd).toBe('legacy');
    });

    it.each([
        [{}, 'bad', '', { focusMinutes: 25, breakMinutes: 5 }],
        [{ focusMinutes: 41.6 }, 'wrong', '0', { focusMinutes: 42, breakMinutes: 1 }],
        [{ focusMinutes: 900, breakMinutes: -4 }, '2.9', '999', { focusMinutes: 2, breakMinutes: 180 }],
        [{ focusMinutes: 11, breakMinutes: 7 }, ' 0012xyz', 'bad', { focusMinutes: 12, breakMinutes: 7 }],
    ] as const)('normalizes both duration drafts using the captured raw RN baseline %j', async (raw, focusMinutes, breakMinutes, expectedValue) => {
        const start = pomodoroStart(); start.settings.gtd!.pomodoro!.customDurations = { ...raw } as never;
        const env = await open(start); const read = await env.host.getGtdPomodoroOptions({});
        expect(read.ok).toBe(true); if (!read.ok) return;
        expect(read.value.expected.pomodoroDurations?.value).toEqual(raw);
        const draft = env.host.normalizeGtdWorkflowDraft({ type: 'pomodoroDurations', focusMinutes,
            breakMinutes, expected: read.value.expected.pomodoroDurations });
        expect(draft).toEqual({ ok: true, value: { valid: true, value: expectedValue } });
        expect(expectedValue).toEqual(resolveGtdPomodoroDurations(start.settings, focusMinutes, breakMinutes));
        expect(env.saves()).toBe(0);
    });

    it('leaves absent and partial noncanonical duration rows untouched for a display no-op', async () => {
        for (const raw of [undefined, { focusMinutes: 25 }, { focusMinutes: 25.2, breakMinutes: 5 }]) {
            const start = pomodoroStart(); start.settings.gtd!.pomodoro!.customDurations = raw;
            const env = await open(start); const read = await env.host.getGtdPomodoroOptions({});
            expect(read.ok).toBe(true); if (!read.ok) return;
            expect(await env.host.prepareGtdWorkflow({ requestId: ID,
                edit: { type: 'pomodoroDurations', value: { focusMinutes: 25, breakMinutes: 5 } },
                expected: read.value.expected.pomodoroDurations })).toEqual({ ok: true,
                value: { kind: 'noop', result: { type: 'pomodoroDurations',
                    value: { focusMinutes: 25, breakMinutes: 5 }, changed: false } } });
            expect(env.saves()).toBe(0); expect(env.data()).toEqual(start);
        }
    });

    it('bounds UTF8 drafts independently and preserves the original schedule draft grammar', async () => {
        const env = await open(pomodoroStart()); const read = await env.host.getGtdPomodoroOptions({});
        if (!read.ok) throw new Error(JSON.stringify(read));
        const input = { type: 'pomodoroDurations', focusMinutes: 'a'.repeat(512), breakMinutes: '5',
            expected: read.value.expected.pomodoroDurations };
        expect(env.host.normalizeGtdWorkflowDraft(input)).toMatchObject({ ok: true });
        expect(env.host.normalizeGtdWorkflowDraft({ ...input, focusMinutes: '😀'.repeat(128) })).toMatchObject({ ok: true });
        for (const extra of [ { focusMinutes: 'a'.repeat(513) }, { breakMinutes: '界'.repeat(171) },
            { focusMinutes: '😀'.repeat(129) }, { extra: true }, { expected: null }, { focusMinutes: 25 } ])
            expect(env.host.normalizeGtdWorkflowDraft({ ...input, ...extra })).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        expect(env.host.normalizeGtdWorkflowDraft({ value: '930' })).toEqual({ ok: true,
            value: { valid: true, value: '09:30' } });
    });

    it('rejects open duration edits, witnesses, receipts and oversized prepared frames purely', async () => {
        const env = await open(pomodoroStart());
        const frozen = await plannedPomodoro(env, { type: 'pomodoroDurations',
            value: { focusMinutes: 33, breakMinutes: 8 } });
        expect(env.host.validatePreparedGtdWorkflow(frozen.envelope)).toMatchObject({ ok: true });
        const mutations = [
            (v: typeof frozen.envelope) => { v.request.edit = { type: 'pomodoroDurations', value: { focusMinutes: 0, breakMinutes: 8 } }; },
            (v: typeof frozen.envelope) => { v.request.edit = { type: 'pomodoroDurations', value: { focusMinutes: 1.5, breakMinutes: 8 } }; },
            (v: typeof frozen.envelope) => { Object.assign(v.request.edit, { alien: true }); },
            (v: typeof frozen.envelope) => { Object.assign(v.request.expected, { alien: true }); },
            (v: typeof frozen.envelope) => { Object.assign(v.prepared.result, { alien: true }); },
            (v: typeof frozen.envelope) => { v.prepared.after.value = { focusMinutes: 34, breakMinutes: 8 }; },
            (v: typeof frozen.envelope) => { Object.assign(v.prepared.result.value as object, { alien: true }); },
        ];
        for (const mutate of mutations) {
            const invalid = structuredClone(frozen.envelope); mutate(invalid);
            expect(env.host.validatePreparedGtdWorkflow(invalid)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        expect(env.host.validatePreparedGtdWorkflow({ ...frozen.envelope, padding: 'x'.repeat(8193) }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);
    });

    it('refuses disabled-gate no-ops and closes every gate and raw duration member', async () => {
        const env = await open(pomodoroStart());
        const frozen = await plannedPomodoro(env, { type: 'pomodoroDurations', value: { focusMinutes: 33, breakMinutes: 8 } });
        for (const changed of [
            { ...frozen.request.expected, gate: { featuresPresent: true, enabled: { present: true, value: false } } },
            { ...frozen.request.expected, gate: { featuresPresent: true, enabled: { present: false, value: true } } },
            { ...frozen.request.expected, gate: { featuresPresent: true, enabled: { present: true, value: true }, alien: 1 } },
            { ...frozen.request.expected, present: true, value: { focusMinutes: 25, alien: 1 } },
            { ...frozen.request.expected, present: true, value: { focusMinutes: '25' } },
            { ...frozen.request.expected, parentPresent: false, present: true, value: {} },
        ]) {
            const invalid = structuredClone(frozen.envelope);
            invalid.request.expected = changed as NativeGtdWorkflowRequest['expected'];
            invalid.prepared.request.expected = invalid.request.expected;
            expect(env.host.validatePreparedGtdWorkflow(invalid)).toMatchObject({ ok: false,
                error: { code: 'INVALID_INPUT' } });
        }
        env.changeSaved((data) => { data.settings.features!.pomodoro = false; return data; });
        const disabled = structuredClone(frozen.request);
        (disabled.expected as { gate: { enabled: { value: boolean } } }).gate.enabled.value = false;
        disabled.edit = { type: 'pomodoroDurations', value: { focusMinutes: 25, breakMinutes: 5 } };
        expect(await env.host.prepareGtdWorkflow(disabled)).toMatchObject({ ok: false,
            error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);
    });

    it.each(['gate', 'stamp', 'device', 'selected'] as const)('refuses a selected %s race without a write', async (race) => {
        const env = await open(pomodoroStart());
        const frozen = await plannedPomodoro(env, { type: 'pomodoroDurations',
            value: { focusMinutes: 33, breakMinutes: 8 } });
        env.changeSaved((data) => {
            if (race === 'gate') data.settings.features!.pomodoro = false;
            if (race === 'stamp') data.settings.syncPreferencesUpdatedAt!.gtd = '2026-09-02T00:00:00.000Z';
            if (race === 'device') data.settings.deviceId = 'other';
            if (race === 'selected') data.settings.gtd!.pomodoro!.customDurations = { focusMinutes: 12, breakMinutes: 4 };
            return data;
        });
        const before = structuredClone(env.data());
        expect(await env.host.commitPreparedGtdWorkflow(frozen.envelope)).toMatchObject({ ok: false,
            error: { code: 'STALE_REVISION' } });
        expect(env.data()).toEqual(before); expect(env.saves()).toBe(0);
    });

    it('merges unrelated raw edits and leaves timer/session and task rows untouched', async () => {
        const start = pomodoroStart(); start.settings.local = { pomodoroSession: 'opaque RN cell',
            pomodoroTaskId: 'retained selection' } as never;
        const env = await open(start);
        const frozen = await plannedPomodoro(env, { type: 'pomodoroDurations',
            value: { focusMinutes: 33, breakMinutes: 8 } });
        env.changeSaved((data) => { data.settings.language = 'ko'; data.settings.gtd!.focusGroupBy = 'status';
            data.tasks[0].title = 'Concurrent raw task'; return data; });
        const before = structuredClone(env.data());
        expect(await env.host.commitPreparedGtdWorkflow(frozen.envelope)).toMatchObject({ ok: true });
        expect(env.data().tasks).toEqual(before.tasks);
        expect(env.data().settings.local).toEqual(before.settings.local);
        expect(env.data().settings.gtd).toEqual({ ...before.settings.gtd, pomodoro: {
            ...before.settings.gtd?.pomodoro, customDurations: { focusMinutes: 33, breakMinutes: 8 } } });
        expect(env.data().settings.language).toBe('ko');
        // The existing settings owner strips the API credential on every save.
        expect(env.data().settings.ai).toEqual({ ...before.settings.ai, apiKey: undefined });
    });

    it('retains exact failed-save ownership and settles only the frozen retry', async () => {
        let failed = false; const env = await open(pomodoroStart(), () => failed);
        const frozen = await plannedPomodoro(env, { type: 'pomodoroDurations',
            value: { focusMinutes: 33, breakMinutes: 8 } });
        const before = structuredClone(env.data()); failed = true;
        expect(await env.host.commitPreparedGtdWorkflow(frozen.envelope)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        expect(env.data()).toEqual(before);
        const another = structuredClone(frozen.envelope); another.request.requestId = generateUUID();
        another.prepared.request.requestId = another.request.requestId;
        expect(await env.host.commitPreparedGtdWorkflow(another)).toMatchObject({ ok: false,
            error: { code: 'SAVE_FAILED' } });
        failed = false;
        expect(await env.host.commitPreparedGtdWorkflow(frozen.envelope)).toEqual({ ok: true,
            value: frozen.prepared.result });
        expect(env.data().settings.gtd?.pomodoro?.customDurations).toEqual({ focusMinutes: 33, breakMinutes: 8 });
        expect(env.data().tasks).toEqual(before.tasks);
    });
});
