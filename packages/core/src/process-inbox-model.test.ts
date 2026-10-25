import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    createCoreBackend,
    createWriteRecorder,
    frozenObservation,
    loadProcessInboxFixture,
    observeProcessInbox,
    performProcessInboxAction,
    seedProcessInboxStore,
} from './process-inbox-model.replay';
import { loadTranslations } from './i18n/i18n-loader';
import {
    addProcessInboxToken,
    answerProcessInboxStep,
    applyProcessInboxDraftEdit,
    createProcessInboxDraft,
    getProcessInboxNotePreview,
    getProcessInboxProgress,
    normalizeProcessInboxPickedDate,
    backProcessInboxStep,
    buildProcessInboxStepView,
    buildProcessInboxDecisionRequest,
    buildProcessInboxScheduleUpdates,
    prepareProcessInboxCommit,
    prepareProcessInboxDraftDecision,
    formatProcessInboxScheduleValue,
    getProcessInboxStepPrompt,
    INITIAL_PROCESS_INBOX_ANSWERS,
    resolveProcessInboxStep,
    type ProcessInboxAnswers,
} from './process-inbox-model';
import { resolveProcessInboxPlan } from './process-inbox-plan';
import { buildQuickAddParseOptions, parseProcessInboxTitleInput } from './quick-add';
import { resetForTests } from './store';
import type { Task } from './types';

const fixture = loadProcessInboxFixture();


it('retains progress when new work arrives and resets for a fresh session', () => {
    const session = { currentTaskId: 'c', visitedTaskIds: new Set(['a', 'b', 'c']),
        skippedTaskIds: new Set(['a']), currentStep: null, stepHistory: [] };
    const converted = getProcessInboxProgress({ total: 3, processed: 1 }, 3, session);
    expect(converted).toEqual({ total: 5, processed: 2 });
    const grown = getProcessInboxProgress(converted, 5, session);
    expect(grown).toEqual({ total: 7, processed: 2 });
    expect(getProcessInboxProgress(grown, 5, session)).toEqual(grown);
    // Work removed by another writer counted as progress under the RN policy;
    // a later capture must not erase that count either.
    const removed = getProcessInboxProgress(grown, 3, session);
    expect(removed).toEqual({ total: 7, processed: 4 });
    expect(getProcessInboxProgress(removed, 5, session)).toEqual({ total: 9, processed: 4 });
    expect(getProcessInboxProgress({ total: 0, processed: 0 }, 5,
        { ...session, visitedTaskIds: new Set(['c']), skippedTaskIds: new Set() })).toEqual({ total: 5, processed: 0 });
});

describe('Process Inbox model parity with the mobile modal', () => {
    const originalTz = process.env.TZ;
    let t: (key: string) => string = (key) => key;
    beforeAll(async () => {
        process.env.TZ = fixture.timeZone;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(fixture.now));
        const english = await loadTranslations('en');
        t = (key) => english[key] ?? key;
    });
    afterAll(() => {
        vi.useRealTimers();
        resetForTests();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    it.each(fixture.scenarios.map((scenario) => [scenario.name, scenario] as const))('replays "%s" exactly', async (_name, scenario) => {
        const recorder = createWriteRecorder();
        const toasts: unknown[] = [];
        await seedProcessInboxStore(fixture, scenario, recorder);
        const backend = createCoreBackend({ t, toasts });
        const observed = [observeProcessInbox(backend, recorder, toasts)];
        for (const action of scenario.actions) {
            await performProcessInboxAction(backend, action, t);
            observed.push(observeProcessInbox(backend, recorder, toasts));
        }
        expect(observed).toEqual(fixture.observations[scenario.name].map((observation) => frozenObservation(observation)));
    });

    // Mobile used to clear these after the next item had opened, so filing that item erased them.
    it('records the next item keeping its dates after Start later, Next, Incubate and Waiting', () => {
        const observations = fixture.observations['the next item keeps its dates after Start later, Next, Incubate and Waiting'];
        const dates = (taskId: string) => {
            const { draft } = observations.find((observation) => observation.taskId === taskId) as { draft: Record<string, { date: string } | null> };
            return [draft.startTime?.date, draft.dueDate?.date, draft.reviewAt?.date];
        };
        expect(dates('dated-1')).toEqual(['2026-10-01', '2026-10-10', '2026-10-03']);
        expect(dates('dated-2')).toEqual(['2026-10-02', '2026-10-11', '2026-10-04']);
        expect(dates('dated-3')).toEqual(['2026-10-06', '2026-10-12', '2026-10-07']);
        expect(dates('dated-4')).toEqual(['2026-10-08', '2026-10-13', '2026-10-09']);
        const startLater = fixture.observations['start later needs a date; date-only and default time'];
        expect((startLater.at(-1)!.writes[0] as unknown[])[2]).toMatchObject({ startTime: '2026-09-25T14:30', dueDate: '2026-09-30' });
    });
});

describe('Process Inbox steps', () => {
    const plan = (inboxProcessing: Record<string, unknown>, hidden?: string[]) => resolveProcessInboxPlan({
        gtd: { inboxProcessing, ...(hidden ? { taskEditor: { hidden: hidden as never } } : {}) },
    });
    const answers = (overrides: Partial<ProcessInboxAnswers>): ProcessInboxAnswers => ({ ...INITIAL_PROCESS_INBOX_ANSWERS, ...overrides });

    it('orders the guided questions by the two-minute settings and the project field', () => {
        const base = plan({});
        const first = plan({ twoMinuteFirst: true });
        const noTwoMinute = plan({ twoMinuteEnabled: false }, ['project']);
        expect(resolveProcessInboxStep(answers({}), 'guided', base)).toBe('actionable');
        expect(resolveProcessInboxStep(answers({ actionability: 'actionable' }), 'guided', base)).toBe('twoMinute');
        expect(resolveProcessInboxStep(answers({}), 'guided', first)).toBe('twoMinute');
        expect(resolveProcessInboxStep(answers({ twoMinute: 'no' }), 'guided', first)).toBe('actionable');
        expect(resolveProcessInboxStep(answers({ actionability: 'actionable' }), 'guided', noTwoMinute)).toBe('execution');
        expect(resolveProcessInboxStep(answers({ actionability: 'actionable', execution: 'defer' }), 'guided', noTwoMinute)).toBe('file');
        expect(resolveProcessInboxStep(answers({ actionability: 'actionable', twoMinute: 'no', execution: 'defer' }), 'guided', base)).toBe('oneAction');
        expect(resolveProcessInboxStep(answers({ actionability: 'actionable', twoMinute: 'no', execution: 'delegate' }), 'quick', base)).toBe('waiting');
        expect(resolveProcessInboxStep(answers({ actionability: 'incubate' }), 'quick', base)).toBe('incubate');
    });

    it('opens the file step for quick "I\'ll do it" instead of filing to Next at once (#1445)', () => {
        const base = plan({});
        const task = { id: 't1', title: 'Call bank', status: 'inbox', createdAt: '', updatedAt: '' } as Task;
        const outcome = answerProcessInboxStep({ choice: 'next', answers: INITIAL_PROCESS_INBOX_ANSWERS,
            draft: createProcessInboxDraft(task), mode: 'quick', plan: base, task,
            parseTitle: (title) => ({ title }) as never });
        expect(outcome.type).toBe('flow');
        if (outcome.type !== 'flow') return;
        expect(resolveProcessInboxStep(outcome.answers, 'quick', base)).toBe('file');
    });

    it('opens the project setup for quick Project without asking "More than one step?" (#1445)', () => {
        const base = plan({});
        const task = { id: 't1', title: 'Plan trip', status: 'inbox', createdAt: '', updatedAt: '' } as Task;
        const draft = createProcessInboxDraft(task);
        const outcome = answerProcessInboxStep({ choice: 'project', answers: INITIAL_PROCESS_INBOX_ANSWERS,
            draft, mode: 'quick', plan: base, task, parseTitle: (title) => ({ title }) as never });
        expect(outcome.type).toBe('flow');
        if (outcome.type !== 'flow') return;
        expect(resolveProcessInboxStep(outcome.answers, 'quick', base)).toBe('file');
        expect(outcome.draft).toMatchObject({ convertToProject: true, nextAction: 'Plan trip', projectId: null });
        // Back returns to the choices and drops the split.
        const back = answerProcessInboxStep({ choice: 'back', answers: outcome.answers,
            draft: outcome.draft, mode: 'quick', plan: base, task, parseTitle: (title) => ({ title }) as never });
        expect(back).toMatchObject({ type: 'flow', answers: INITIAL_PROCESS_INBOX_ANSWERS, draft: { convertToProject: false, nextAction: '' } });
    });

    it('starts a capture with no project or area in the default area (#1445)', () => {
        const task = { id: 't1', title: 'Call bank', status: 'inbox', createdAt: '', updatedAt: '' } as Task;
        expect(createProcessInboxDraft(task, 'a-work').areaId).toBe('a-work');
        expect(createProcessInboxDraft({ ...task, areaId: 'a-home' }, 'a-work').areaId).toBe('a-home');
        expect(createProcessInboxDraft({ ...task, projectId: 'p1' }, 'a-work').areaId).toBeNull();
    });

    it('steps back one question and drops a project split from the file step', () => {
        const base = plan({});
        const file = answers({ actionability: 'actionable', twoMinute: 'no', execution: 'defer', oneActionAnswered: true });
        expect(backProcessInboxStep(file, 'guided', base)).toEqual({ answers: { ...file, oneActionAnswered: false }, cancelProjectConversion: true });
        // Quick mode returns to its entry screen; only Project starts a split there, so Back drops it.
        expect(backProcessInboxStep(file, 'quick', base)).toEqual({ answers: INITIAL_PROCESS_INBOX_ANSWERS, cancelProjectConversion: true });
    });

    it('keeps only the calendar day of a picked date, then adds the default time unless date-only', () => {
        expect(formatProcessInboxScheduleValue('2026-10-05', false, '09:00')).toBe('2026-10-05T09:00');
        expect(formatProcessInboxScheduleValue(new Date(2026, 9, 5, 15, 45), true, '09:00')).toBe('2026-10-05');
        expect(formatProcessInboxScheduleValue('2026-10-05', false, '')).toBe('2026-10-05');
    });

    it('keeps an untouched stored start clock when filing to Next or Start later', () => {
        const task = { id: 'inbox', status: 'inbox', startTime: '2026-10-05T15:45' } as Task;
        const dates = { startTime: { value: '2026-10-05', dateOnly: false }, dueDate: { value: null, dateOnly: false }, reviewAt: { value: null, dateOnly: false } };
        expect(buildProcessInboxScheduleUpdates(plan({ scheduleEnabled: true }), dates, '09:00', task, new Set()).startTime).toBe(task.startTime);
        const later = buildProcessInboxDecisionRequest('later', { task, defaultScheduleTime: '09:00', somedaySectionId: undefined,
            startDate: dates.startTime, reviewDate: dates.reviewAt, followUpDate: dates.reviewAt, delegateWho: '', assignedTo: '', projectId: null,
        });
        expect(later.ok && later.options.fields?.startTime).toBe(task.startTime);
        expect(buildProcessInboxScheduleUpdates(plan({ scheduleEnabled: true }),
            { ...dates, startTime: { value: '2026-10-06', dateOnly: false } }, '', task, new Set(['startTime'])).startTime).toBe('2026-10-06T15:45');
        expect(buildProcessInboxScheduleUpdates(plan({ scheduleEnabled: true }),
            { ...dates, startTime: { value: '2026-10-06', dateOnly: true } }, '09:00', task, new Set(['startTime'])).startTime).toBe('2026-10-06');
    });

    it('uses the default clock after an explicit default-time tap', () => {
        const task = { id: 'inbox', status: 'inbox', startTime: '2026-10-05T15:45' } as Task;
        const dates = { startTime: { value: '2026-10-05', dateOnly: false, useDefaultTime: true },
            dueDate: { value: null, dateOnly: false }, reviewAt: { value: null, dateOnly: false } };
        expect(buildProcessInboxScheduleUpdates(plan({ scheduleEnabled: true }), dates, '09:00', task,
            new Set(['startTime'])).startTime).toBe('2026-10-05T09:00');
        const later = buildProcessInboxDecisionRequest('later', { task, defaultScheduleTime: '09:00', somedaySectionId: undefined,
            startDate: dates.startTime, reviewDate: dates.reviewAt, followUpDate: dates.reviewAt,
            delegateWho: '', assignedTo: '', projectId: null });
        expect(later.ok && later.options.fields?.startTime).toBe('2026-10-05T09:00');
    });

    it('prepares a Skip from the edited draft without replacing untouched timed dates', () => {
        const task = { id: 'inbox', title: 'Original', description: 'Old note', status: 'inbox',
            startTime: '2026-10-05T15:45', dueDate: '2026-10-07T11:30', reviewAt: '2026-10-08T08:15' } as Task;
        const draft = { ...createProcessInboxDraft(task), title: 'Edited title', description: 'Edited note' };
        const parseTitle = vi.fn((title: string) => ({ title, props: {} }));
        const prepared = prepareProcessInboxDraftDecision({ task, draft, plan: plan({ scheduleEnabled: true }),
            settings: { gtd: { defaultScheduleTime: '09:00' } } as never, parseTitle }, { type: 'skip' });
        expect(parseTitle).toHaveBeenCalledExactlyOnceWith('Edited title');
        expect(prepared).toMatchObject({ ok: true, event: { type: 'skip', fields: {
            startTime: task.startTime, dueDate: task.dueDate, reviewAt: task.reviewAt,
        } }, taskUpdates: { title: 'Edited title', description: 'Edited note' } });
    });

    it('keeps an explicit date-only picker over a parsed date token while merging title tokens', () => {
        const task = { id: 'inbox', title: 'Original', status: 'inbox', dueDate: '2026-10-07T11:30' } as Task;
        const draft = { ...createProcessInboxDraft(task), title: 'Renew /due:2026-11-01 @phone',
            contexts: ['@desk'], dueDate: { date: '2026-11-02', dateOnly: true },
            dirtyScheduleFields: ['dueDate' as const] };
        const prepared = prepareProcessInboxDraftDecision({ task, draft, plan: plan({ scheduleEnabled: true }),
            settings: { gtd: { defaultScheduleTime: '09:00' } } as never,
            parseTitle: () => ({ title: 'Renew', props: { dueDate: '2026-11-01', contexts: ['@phone'] } }),
        }, { type: 'next' });
        expect(prepared).toMatchObject({ ok: true, event: { type: 'next', fields: {
            contexts: ['@desk', '@phone'], dueDate: '2026-11-02',
        } }, taskUpdates: { title: 'Renew' } });
    });

    it('returns the existing invalid-date notice data before any decision action', () => {
        const task = { id: 'inbox', title: 'Original', status: 'inbox' } as Task;
        const draft = { ...createProcessInboxDraft(task), title: 'Renew /due:impossible' };
        const prepared = prepareProcessInboxDraftDecision({ task, draft, plan: plan({}), settings: undefined,
            parseTitle: () => ({ title: 'Renew', props: {}, invalidDateCommands: ['/due:impossible'] }),
        }, { type: 'next' });
        expect(prepared).toEqual({ ok: false, reason: 'invalid-date-command', invalidDateCommands: ['/due:impossible'] });
        expect(prepared).not.toHaveProperty('event');
        expect(prepared).not.toHaveProperty('taskUpdates');
    });

    it('asks the incubate question with its own translation key', () => {
        const strings = { 'inbox.deferWhen': 'When should it start?', 'process.incubateWhen': 'When should it come back?' };
        expect(getProcessInboxStepPrompt('incubate', plan({}), (key) => strings[key as keyof typeof strings] ?? key).question).toBe('When should it come back?');
    });

    it('localizes the time-estimate chips through the step translator', () => {
        const task = { id: 'inbox', title: 'Inbox', status: 'inbox', timeEstimate: '5min' } as Task;
        const view = buildProcessInboxStepView({ task, draft: createProcessInboxDraft(task),
            answers: { ...INITIAL_PROCESS_INBOX_ANSWERS, actionability: 'actionable', twoMinute: 'no', execution: 'defer', oneActionAnswered: true },
            mode: 'quick', plan: resolveProcessInboxPlan({ features: { timeEstimates: true }, gtd: { taskEditor: { hidden: [] } } } as never),
            settings: undefined, tasks: [task], projects: [], areas: [], people: [], similarityIndex: null,
            t: (key) => ({ 'units.minutesShort': '{{minutes}} min.', 'units.hoursShort': '{{hours}} h' }[key] ?? key),
            formatDate: () => '', now: new Date(2026, 8, 23),
        });
        expect(view.moreOptions.organization?.timeEstimates.map(({ label }) => label)).toContain('5 min.');
    });

    it('clears an overdue review date when filing to Someday, but keeps a future date', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 23, 10));
        try {
            const request = (reviewAt: string) => buildProcessInboxDecisionRequest('someday', {
                task: { id: 'inbox', status: 'inbox', reviewAt } as Task, defaultScheduleTime: '', somedaySectionId: undefined,
                startDate: { value: null, dateOnly: false }, reviewDate: { value: reviewAt, dateOnly: true },
                followUpDate: { value: null, dateOnly: false }, delegateWho: '', assignedTo: '', projectId: null,
            });
            const past = request('2026-09-22');
            const today = request('2026-09-23');
            const future = request('2026-09-25');
            expect(past.ok && past.options.clearStaleReviewAt).toBe(true);
            expect(today.ok && today.options.clearStaleReviewAt).toBe(true);
            expect(future.ok && future.options.clearStaleReviewAt).toBe(false);
        } finally { vi.useRealTimers(); }
    });

    it.each([
        ['title token', '2026-10-20', undefined, new Set<'startTime' | 'dueDate' | 'reviewAt'>()],
        ['review picker', undefined, '2026-10-20', new Set<'startTime' | 'dueDate' | 'reviewAt'>(['reviewAt'])],
        ['untouched stale date', undefined, undefined, new Set<'startTime' | 'dueDate' | 'reviewAt'>()],
    ] as const)('keeps a new %s when refiling a stale Someday item', (_case, titleDate, pickerDate, dirty) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 23, 10));
        try {
            const task = { id: 'inbox', title: 'Learn piano', status: 'inbox', reviewAt: '2026-09-20' } as Task;
            const request = buildProcessInboxDecisionRequest('someday', {
                task, defaultScheduleTime: '', somedaySectionId: undefined,
                startDate: { value: null, dateOnly: false }, reviewDate: { value: pickerDate ?? task.reviewAt, dateOnly: true },
                followUpDate: { value: null, dateOnly: false }, delegateWho: '', assignedTo: '', projectId: null,
            });
            if (!request.ok) throw new Error('Expected Someday request');
            const prepared = prepareProcessInboxCommit({ task, plan: plan({ scheduleEnabled: true }),
                decision: request.decision, title: titleDate ? `Learn piano /review:${titleDate}` : 'Learn piano',
                description: '', parseTitle: (title) => ({ title: 'Learn piano', props: titleDate && title.includes('/review:') ? { reviewAt: titleDate } : {} }),
                selection: { projectId: null, areaId: null, contexts: [], tags: [], priority: undefined,
                    energyLevel: undefined, assignedTo: '', timeEstimate: undefined },
                scheduleUpdates: pickerDate ? { reviewAt: pickerDate } : { reviewAt: task.reviewAt },
                dirtyScheduleFields: dirty, options: request.options,
            });
            expect(prepared.ok && prepared.event.type === 'someday' && prepared.event.fields?.reviewAt)
                .toBe(titleDate ?? pickerDate);
            if (!titleDate && !pickerDate) {
                expect(prepared.ok && prepared.event.type === 'someday'
                    && Object.hasOwn(prepared.event.fields ?? {}, 'reviewAt')).toBe(true);
            }
        } finally { vi.useRealTimers(); }
    });

    it('files an unprefixed token by the section that asked for it', () => {
        const visible = { contexts: true, tags: true };
        expect(addProcessInboxToken({ tokenInput: ' focus ', kind: 'tag', visible, contexts: [], tags: [] })).toEqual({ contexts: [], tags: ['#focus'] });
        expect(addProcessInboxToken({ tokenInput: 'desk', visible, contexts: ['@desk'], tags: [] })).toEqual({ contexts: ['@desk'], tags: [] });
        expect(addProcessInboxToken({ tokenInput: '   ', visible, contexts: [], tags: [] })).toBeNull();
    });
});


describe('captured RN note and date controls', () => {
    const captured = JSON.parse(readFileSync(new URL('./process-inbox-model-controls.fixtures.json', import.meta.url), 'utf8')) as {
        notes: Array<{ description: string; preview: string }>;
        dates: Array<{ timeZone: string; day: string; input: string; picked: string }>;
    };

    it('preserves preview bytes, including whitespace and the UTF-16 truncation boundary', () => {
        for (const { description, preview } of captured.notes) {
            expect(getProcessInboxNotePreview(description)).toBe(preview);
        }
    });

    it('normalizes picked dates exactly like RN and resets the draft date-only mode for every date field', () => {
        const oldTz = process.env.TZ;
        const plan = resolveProcessInboxPlan({});
        const draft = createProcessInboxDraft(fixture.tasks[0]);
        try {
            for (const { timeZone, day, input, picked } of captured.dates) {
                process.env.TZ = timeZone;
                const original = new Date(input);
                expect(normalizeProcessInboxPickedDate(original).toISOString()).toBe(picked);
                expect(original.toISOString()).toBe(input);
                for (const field of ['startTime', 'dueDate', 'reviewAt', 'followUp'] as const) {
                    const next = applyProcessInboxDraftEdit({ ...draft, [field]: { date: '2026-01-01', dateOnly: true } }, {
                        type: 'setPickedDate', field, day,
                    }, plan);
                    expect(next[field]).toEqual({ date: day, dateOnly: false });
                    expect(next.dirtyScheduleFields).toEqual(field === 'followUp' ? [] : [field]);
                    expect(formatProcessInboxScheduleValue(next[field]!.date, false, '14:35')).toBe(`${day}T14:35`);
                }
            }
        } finally {
            if (oldTz === undefined) delete process.env.TZ;
            else process.env.TZ = oldTz;
        }
    });
});

// Priority, energy, and person controls are hidden by default, so the typed
// tokens are the only way the user said anything. They must reach the write.
describe('typed single-value tokens with hidden controls', () => {
    const title = 'Call bank /priority:high /energy:low %Alice';
    const commit = (settings: Parameters<typeof resolveProcessInboxPlan>[0], decision: 'next' | 'someday') => {
        const task = { id: 'inbox', title, status: 'inbox' } as Task;
        const parseOptions = buildQuickAddParseOptions(settings);
        return prepareProcessInboxCommit({ task, plan: resolveProcessInboxPlan(settings),
            decision: { type: decision }, title, description: '',
            parseTitle: (input) => parseProcessInboxTitleInput(input, { parseOptions }),
            selection: { projectId: null, areaId: null, contexts: [], tags: [], priority: undefined,
                energyLevel: undefined, assignedTo: '', timeEstimate: undefined },
            scheduleUpdates: {}, dirtyScheduleFields: new Set() });
    };
    const write = (prepared: ReturnType<typeof commit>) => {
        if (!prepared.ok || prepared.event.type === 'discard') throw new Error('Expected an update');
        return { ...prepared.event.fields, ...prepared.taskUpdates };
    };

    it.each(['next', 'someday'] as const)('saves typed priority, energy, and person on %s with default settings', (decision) => {
        expect(write(commit(undefined, decision))).toMatchObject({
            title: 'Call bank', priority: 'high', energyLevel: 'low', assignedTo: 'Alice',
        });
    });

    it('never writes a priority while Priorities are turned off', () => {
        const written = write(commit({ features: { priorities: false } } as never, 'next'));
        expect(written).not.toHaveProperty('priority');
        expect(written).toMatchObject({ energyLevel: 'low', assignedTo: 'Alice' });
    });
});
