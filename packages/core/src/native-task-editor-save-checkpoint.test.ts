import { describe, expect, it } from 'vitest';
import { validateNativeTaskEditorSaveCheckpoint, type NativeTaskEditorSaveCheckpointInput } from './native-task-editor-save-checkpoint';
import { validateNativeTaskEditorOpeningFields } from './native-host-contract-task-editor-resume';
import { readNativeTaskLinkHalf } from './native-host-contract-attachments';
import { ASSOCIATIONS, RECURRENCE, SCHEDULE, getNativeTaskRecurrenceBase, getNativeTaskScheduleBase } from './native-host-contract-task-save';
import { createTaskDraft, type TaskDraft, type TaskDraftField } from './task-draft';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeTimeSpentMinutes } from './time-spent';
import { getTaskEditorDailyInterval, getTaskEditorSuggestions } from './task-editor-model';
import { getTaskEditorRecurrenceInputValues, getTaskEditorRelativeStart, getTaskEditorTimeEstimate } from './task-editor-schedule';
import { taskEditValuesEqual } from './json-value-equality';
import type { Attachment, Task } from './types';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const initial = (patch: Partial<Task> = {}): Task => ({ id: 'task', title: 'Opening', status: 'next',
    contexts: ['home'], tags: ['one'], createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z', ...patch });
const file: Attachment = { id: '00000000-0000-4000-8000-000000000001', kind: 'file', title: 'Owned file',
    uri: 'file:///private/library/attachments/file.pdf', createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z' };
const validateField = (field: TaskDraftField, value: unknown): boolean => {
    if (['timeSpentMinutes', 'relativeStartOffset'].includes(field)) return value === undefined
        || field === 'timeSpentMinutes' && typeof value === 'number' && Number.isFinite(value) && value >= 0
        || field === 'relativeStartOffset' && typeof value === 'object' && value !== null;
    if ((field === 'showFutureRecurrence' || field === 'preserveChecklistOnRepeat')) return typeof value === 'boolean';
    return typeof value === 'string';
};
const draftFor = (task: Task) => createTaskDraft({ ...task, recurrence: normalizeRecurrenceForLoad(task.recurrence),
    timeSpentMinutes: normalizeTimeSpentMinutes(task.timeSpentMinutes) });
function fixture(edits: Partial<TaskDraft> = {}, task = initial(), tokenEdited: string[] = []) {
    const draft = draftFor(task);
    const edited: Record<string, unknown> = Object.fromEntries(Object.entries(edits).map(([field, value]) => [field, value ?? null]));
    for (const group of [SCHEDULE, RECURRENCE, ASSOCIATIONS]) if (group.some((field) => Object.hasOwn(edited, field)))
        for (const field of group) if (!Object.hasOwn(edited, field)) edited[field] = draft[field] ?? null;
    const touched = Object.keys(edited);
    const base = Object.fromEntries(touched.map((field) => [field, draft[field as keyof TaskDraft] ?? null]));
    const current = { ...draft, ...edited } as TaskDraft;
    const scheduleOwned = SCHEDULE.some((field) => touched.includes(field));
    const recurrenceOwned = RECURRENCE.some((field) => touched.includes(field));
    const tokens = Object.fromEntries(['contexts', 'tags', 'assignedTo'].filter((field) => touched.includes(field)).map((field) => [field, edited[field]]));
    const relative = scheduleOwned ? getTaskEditorRelativeStart(current, (key) => key) : null;
    const recurrence = getTaskEditorRecurrenceInputValues(current, getTaskEditorDailyInterval(current.recurrence, current.recurrenceRRule));
    const estimate = touched.includes('timeEstimate') ? getTaskEditorTimeEstimate(current.timeEstimate, (key) => key).customText : '';
    const timeSpent = touched.includes('timeSpentMinutes') && current.timeSpentMinutes != null ? String(current.timeSpentMinutes) : '';
    const payload = { version: 2, taskID: task.id, tab: 'task', touchedBase: base, edited,
        raw: { title: touched.includes('title') ? edited.title : '', note: touched.includes('description') ? edited.description : '',
            location: touched.includes('location') ? edited.location : '', estimate, estimateResolved: estimate, timeSpent, timeSpentResolved: timeSpent,
            tokens: clone(tokens), tokenCanonical: clone(tokens), tokenResolved: clone(tokens), tokenEdited,
            checklistInputs: {}, checklistAppend: '', relativeAmount: relative ? String(relative.amount) : '', relativeUnit: relative?.unit ?? '',
            relativeOwned: false, relativeCommitRequested: false, recurrenceInputs: recurrenceOwned ? { interval: String(recurrence.interval), count: String(recurrence.count) } : {},
            recurrenceOwned: [], recurrenceCommitRequested: [] },
        scheduleEdits: [], scheduleFailedID: null, attachmentsOwned: true, attachmentsBase: task.attachments ?? [],
        attachments: [...(task.attachments ?? []), clone(file)], linkSheet: {},
        ...(scheduleOwned ? { scheduleBase: getNativeTaskScheduleBase(task) } : {}),
        ...(recurrenceOwned ? { recurrenceBase: getNativeTaskRecurrenceBase({ ...task, recurrence: normalizeRecurrenceForLoad(task.recurrence) }) } : {}) };
    const changed = new Set(touched.filter((field) => !taskEditValuesEqual(base[field], edited[field])));
    for (const group of [RECURRENCE, ASSOCIATIONS]) if (group.some((field) => changed.has(field))) group.forEach((field) => changed.add(field));
    const saveRequest = { id: task.id, base: Object.fromEntries([...changed].map((field) => [field, base[field]])),
        patch: Object.fromEntries([...changed].map((field) => [field, edited[field]])), scheduleBase: getNativeTaskScheduleBase(task),
        ...(RECURRENCE.some((field) => changed.has(field)) ? { recurrenceBase: payload.recurrenceBase } : {}),
        attachments: { base: payload.attachmentsBase, value: payload.attachments } };
    return { payload, input: clone({ payloadJSON: JSON.stringify(payload), saveRequest, beforeTask: task }) };
}
const check = (input: NativeTaskEditorSaveCheckpointInput) => validateNativeTaskEditorSaveCheckpoint(input, validateField);
const ready = (input: NativeTaskEditorSaveCheckpointInput) => expect(check(input)).toEqual({ ok: true, value: { kind: 'ready' } });
const refused = (input: NativeTaskEditorSaveCheckpointInput, code = 'INVALID_INPUT') => expect(check(input)).toMatchObject({ ok: false, error: { code } });
function changePayload(input: NativeTaskEditorSaveCheckpointInput, mutate: (payload: ReturnType<typeof fixture>['payload']) => void) {
    const payload = JSON.parse(input.payloadJSON) as ReturnType<typeof fixture>['payload'];
    mutate(payload); input.payloadJSON = JSON.stringify(payload); return input;
}

describe('real native ordinary Save checkpoint correspondence (pure, unbound)', () => {
    it('matches the full producer envelope with only an added file without granting ownership or performing IO', () => {
        const { input } = fixture(); const original = JSON.stringify(input);
        ready(input); expect(JSON.stringify(input)).toBe(original);
        changePayload(input, (payload) => { payload.tab = 'view'; }); ready(input);
        // Correspondence is deliberately not a URI/library/workspace ownership check.
        changePayload(input, (payload) => { payload.attachments[0].uri = 'file:///elsewhere/file.pdf'; });
        (input.saveRequest as { attachments: { value: Attachment[] } }).attachments.value[0].uri = 'file:///elsewhere/file.pdf'; ready(input);
    });
    it('accounts for combined actual ordinary editor fields, schedule/recurrence and associations', () => {
        const { input } = fixture({ title: 'Edited', description: 'Notes\nTwo', location: 'Office', timeEstimate: 'custom:45',
            contexts: '@home @office', tags: '#one #two', assignedTo: 'Literal Person', timeSpentMinutes: 12,
            projectId: 'project', areaId: 'area', sectionId: 'section', dueDate: '2026-10-06',
            relativeStartOffset: { amount: -2, unit: 'day' }, recurrence: 'weekly', recurrenceRRule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4',
            recurrenceStrategy: 'strict', showFutureRecurrence: true, priority: 'high', energyLevel: 'low' }, initial(), ['contexts', 'tags', 'assignedTo']);
        ready(input);
    });
    it('checks touched normalized no-ops against the opening row despite no patch entry', () => {
        const task = initial({ timeSpentMinutes: 17.6, recurrence: { rule: 'daily', strategy: 'strict', rrule: 'FREQ=DAILY' } });
        const draft = draftFor(task);
        const { input } = fixture({ title: 'Opening', timeSpentMinutes: 18, recurrence: draft.recurrence,
            recurrenceStrategy: draft.recurrenceStrategy, recurrenceRRule: draft.recurrenceRRule, showFutureRecurrence: draft.showFutureRecurrence }, task);
        ready(input); expect((input.saveRequest as { patch: object }).patch).toEqual({});
        input.beforeTask.title = 'Intervening'; refused(input, 'STALE_REVISION');
    });
    it('preserves raw witness distinctions and ignores unrelated unowned current changes', () => {
        const { input } = fixture({ title: 'Edited' }); input.beforeTask.description = 'Unowned'; ready(input);
        input.beforeTask.dueDate = '2026-10-10'; refused(input);
        const schedule = fixture({ dueDate: '2026-10-10' }).input;
        schedule.beforeTask.reviewAt = '2026-10-05T12:00:00.000Z'; refused(schedule, 'STALE_REVISION');
    });
    it.each(['projectId', 'areaId', 'sectionId', ...RECURRENCE])('requires changed group companion %s even when its value is a no-op', (field) => {
        const { input } = fixture(field === 'projectId' || field === 'areaId' || field === 'sectionId' ? { projectId: 'new' } : { recurrence: 'weekly' });
        delete (input.saveRequest as { patch: Record<string, unknown> }).patch[field];
        delete (input.saveRequest as { base: Record<string, unknown> }).base[field]; refused(input);
    });
    it.each(['title', 'description', 'location', 'timeEstimate', 'timeSpentMinutes', 'priority', 'energyLevel'])('refuses omitted or forged changed owned %s', (field) => {
        const values = { title: 'New', description: 'Note', location: 'Place', timeEstimate: '30m', timeSpentMinutes: 1, priority: 'high', energyLevel: 'low' };
        const { input } = fixture({ [field]: values[field as keyof typeof values] });
        delete (input.saveRequest as { patch: Record<string, unknown> }).patch[field];
        delete (input.saveRequest as { base: Record<string, unknown> }).base[field]; refused(input);
    });
    it('rejects injected unowned edits, wrong opening/patch values, id, witnesses and request extras', () => {
        for (const mutate of [
            (request: Record<string, unknown>) => { (request.patch as Record<string, unknown>).location = 'Injected'; (request.base as Record<string, unknown>).location = ''; },
            (request: Record<string, unknown>) => { (request.patch as Record<string, unknown>).title = 'Wrong'; },
            (request: Record<string, unknown>) => { (request.base as Record<string, unknown>).title = 'Wrong'; },
            (request: Record<string, unknown>) => { request.id = 'other'; },
            (request: Record<string, unknown>) => { request.recurrenceBase = { recurrence: null, showFutureRecurrence: null }; },
            (request: Record<string, unknown>) => { request.extra = true; },
        ]) { const { input } = fixture({ title: 'New' }); mutate(input.saveRequest as Record<string, unknown>); refused(input); }
    });
    it('matches exact attachment list values and order; files remain refused by the old URL-only resume half', () => {
        for (const mutate of [
            (half: { base: Attachment[]; value: Attachment[] }) => { half.value[0].title = 'Forged'; },
            (half: { base: Attachment[]; value: Attachment[] }) => { half.value.reverse(); },
            (half: { base: Attachment[]; value: Attachment[] }) => { half.base = []; },
        ]) {
            const { input } = fixture({}, initial({ attachments: [{ ...file, id: '00000000-0000-4000-8000-000000000002' }] }));
            mutate((input.saveRequest as { attachments: { base: Attachment[]; value: Attachment[] } }).attachments); refused(input);
        }
        const { input } = fixture();
        expect(readNativeTaskLinkHalf((input.saveRequest as Record<string, unknown>).attachments)).toBeNull();
        delete (input.saveRequest as Record<string, unknown>).attachments; refused(input);
    });
    it.each(['title', 'note', 'location', 'estimate', 'estimateResolved', 'timeSpent', 'timeSpentResolved', 'relativeAmount', 'relativeUnit', 'checklistAppend'])('refuses nonempty unowned raw %s', (field) => {
        const { input } = fixture(); changePayload(input, (payload) => { Object.assign(payload.raw, { [field]: 'pending' }); }); refused(input);
    });
    it.each(['relativeOwned', 'relativeCommitRequested', 'recurrenceOwned', 'recurrenceCommitRequested', 'checklistInputs', 'tokens', 'tokenCanonical', 'tokenResolved', 'tokenEdited', 'recurrenceInputs'])('refuses pending/unowned raw %s', (field) => {
        const { input } = fixture(); changePayload(input, (payload) => { Object.assign(payload.raw, { [field]: field.startsWith('relative') ? true : field.endsWith('Owned') || field.endsWith('Requested') || field === 'tokenEdited' ? ['interval'] : { pending: 'text' } }); }); refused(input);
    });
    it.each(Object.keys(fixture().payload.raw))('requires every raw field %s', (field) => {
        const { input } = fixture(); changePayload(input, (payload) => { delete (payload.raw as Record<string, unknown>)[field]; }); refused(input);
    });
    it.each(['future', 'checklistBase', 'checklistValue'])('refuses extra payload %s', (field) => {
        const { input } = fixture(); changePayload(input, (payload) => { Object.assign(payload, { [field]: [] }); }); refused(input);
    });
    it.each(['status', 'focusedToday', 'completedAt', 'checklist', 'repeatReminderMinutes', 'suppressMindwtrReminders'])('does not silently drop separate intent/unsupported ownership %s', (field) => {
        const { input } = fixture(); changePayload(input, (payload) => { payload.touchedBase[field] = ''; payload.edited[field] = ''; }); refused(input);
    });
    it('requires empty drained schedule queues, exact closed link sheet and supported tab', () => {
        for (const mutation of [{ scheduleEdits: [{}] }, { scheduleFailedID: 'pending' }, { linkSheet: { error: '' } }, { tab: 'notes' }, { attachmentsOwned: false }]) {
            const { input } = fixture(); changePayload(input, (payload) => Object.assign(payload, mutation)); refused(input);
        }
    });
    it('keeps unknown raw fields and incomplete owned groups outside the ordinary Save grammar', () => {
        const { input } = fixture({ dueDate: '2026-10-10' });
        changePayload(input, (payload) => { delete payload.edited.startTime; delete payload.touchedBase.startTime; }); refused(input);
        const extra = fixture().input; changePayload(extra, (payload) => { Object.assign(payload.raw, { unexpected: '' }); }); refused(extra);
    });
    it.each(['12', '12.0', '+1.2e1', '00012', '1.200E+1'])('accepts equivalent finite Foundation minute display %s without strip-digit parsing', (display) => {
        const { input } = fixture({ timeSpentMinutes: 12 }); changePayload(input, (payload) => { payload.raw.timeSpent = display; payload.raw.timeSpentResolved = display; }); ready(input);
    });
    it.each(['12 minutes', '1e', ' 12 ', 'Infinity', '0xC', '-12', '', '1.2'])('refuses unresolved/wrong numeric minute display %s', (display) => {
        const { input } = fixture({ timeSpentMinutes: 12 }); changePayload(input, (payload) => { payload.raw.timeSpent = display; payload.raw.timeSpentResolved = display; }); refused(input);
    });
    it('accepts absent optional minutes and checks estimate canonical display rather than typed input', () => {
        ready(fixture({ timeSpentMinutes: undefined } as Partial<TaskDraft>).input);
        const { input } = fixture({ timeEstimate: 'custom:45' }); ready(input);
        changePayload(input, (payload) => { payload.raw.estimate = '45'; payload.raw.estimateResolved = '45'; }); refused(input);
    });
    it('preserves unmarked legacy token spelling and validates only actually edited token fields', () => {
        const old = initial({ contexts: ['legacy!', 'legacy!'] }); const spelling = draftFor(old).contexts;
        ready(fixture({ contexts: spelling }, old).input);
        const unmarked = fixture({ contexts: '@changed' }).input; refused(unmarked);
        ready(fixture({ contexts: '@changed' }, initial(), ['contexts']).input);
        refused(fixture({ contexts: 'changed changed' }, initial(), ['contexts']).input);
        ready(fixture({ assignedTo: '  Literal, @name!  ' }, initial(), ['assignedTo']).input);
    });
    it.each(['contexts', 'tags'] as const)('refuses long noncanonical marked %s at every bounded display length', (field) => {
        const text = 'raw duplicate '.repeat(160); expect(text.length).toBeGreaterThan(2000);
        refused(fixture({ [field]: text }, initial(), [field]).input);
    });
    it.each(['contexts', 'tags'] as const)('accepts long canonical marked %s expanded from a bounded suggestions query', (field) => {
        const query = Array.from({ length: 380 }, (_, index) => `t${index}`).join(',');
        expect(query.length).toBeLessThanOrEqual(2000);
        const text = getTaskEditorSuggestions({ field, text: query, limit: 4,
            knownTokens: [], usage: [], people: [], tasks: [] }).draftValue;
        expect(text.length).toBeGreaterThan(2000);
        ready(fixture({ [field]: text }, initial(), [field]).input);
    });
    it.each(['contexts', 'tags'] as const)('retains unmarked long historical %s opening spelling', (field) => {
        const task = initial({ [field]: ['raw duplicate '.repeat(160)] });
        const text = draftFor(task)[field]; expect(text.length).toBeGreaterThan(2000);
        ready(fixture({ [field]: text }, task).input);
    });
    it('preserves the actual native long assignee literal bypass', () => {
        const text = '  Literal, @name! '.repeat(160); expect(text.length).toBeGreaterThan(2000);
        ready(fixture({ assignedTo: text }, initial(), ['assignedTo']).input);
    });
    it('requires unique/subset tokenEdited and exact raw token dictionaries', () => {
        for (const fields of [['tags', 'tags'], ['title']]) {
            const { input } = fixture({ tags: '#new' }, initial(), fields); refused(input);
        }
        const { input } = fixture({ tags: '#new' }, initial(), ['tags']);
        changePayload(input, (payload) => { payload.raw.tokenResolved.tags = '#old'; }); refused(input);
    });
    it('requires exact recurrence counters and relative display without calling time-dependent defaults', () => {
        const { input } = fixture({ dueDate: '2026-10-10', relativeStartOffset: { amount: -3, unit: 'week' },
            recurrence: 'monthly', recurrenceRRule: 'FREQ=MONTHLY;INTERVAL=3;COUNT=5' }); ready(input);
        changePayload(input, (payload) => { payload.raw.recurrenceInputs.interval = '03'; }); refused(input);
        const relative = fixture({ dueDate: '2026-10-10' }).input;
        changePayload(relative, (payload) => { payload.raw.relativeAmount = '2'; }); refused(relative);
    });
    it('refuses unsupported non-safe-integer display counters while preserving the input', () => {
        const { input } = fixture({ dueDate: '2026-10-10', relativeStartOffset: { amount: -0.5, unit: 'day' } });
        const original = JSON.stringify(input); refused(input); expect(JSON.stringify(input)).toBe(original);
        const recurrence = fixture({ recurrence: 'weekly', recurrenceRRule: 'FREQ=WEEKLY;COUNT=99999999999999999' }).input; refused(recurrence);
    });
    it('factors opening projection without weakening stale schedule/recurrence/no-op checks', () => {
        const task = initial({ timeSpentMinutes: 17.6 });
        expect(validateNativeTaskEditorOpeningFields({ id: task.id, touchedBase: { timeSpentMinutes: 18 } }, task, validateField)).toMatchObject({ ok: true, value: { freshDraft: { timeSpentMinutes: 18 } } });
        expect(validateNativeTaskEditorOpeningFields({ id: task.id, touchedBase: { timeSpentMinutes: 17 } }, task, validateField)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });
    it('returns fixed refusal for malformed scalar/object types rather than throwing', () => {
        const tab = fixture().input; changePayload(tab, (payload) => { Object.assign(payload, { tab: {} }); }); refused(tab);
        const status = fixture().input; Object.assign(status.beforeTask, { status: {} }); refused(status);
        const invalidCallback = fixture({ title: 'New' }).input; expect(validateNativeTaskEditorSaveCheckpoint(invalidCallback, () => { throw new Error('secret'); })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
    it.each(['title', 'note', 'location', 'estimate', 'estimateResolved', 'timeSpentResolved'])('refuses wrong drained owned raw %s', (field) => {
        const { input } = fixture({ title: 'Edited', description: 'Note', location: 'Office', timeEstimate: 'custom:45', timeSpentMinutes: 12 });
        changePayload(input, (payload) => { Object.assign(payload.raw, { [field]: 'Different' }); }); refused(input);
    });
    it.each(['version', 'taskID', 'tab', 'touchedBase', 'edited', 'raw', 'scheduleEdits', 'scheduleFailedID', 'attachmentsOwned', 'attachmentsBase', 'attachments', 'linkSheet'])('requires the full producer checkpoint key %s', (field) => {
        const { input } = fixture(); changePayload(input, (payload) => { delete (payload as Record<string, unknown>)[field]; }); refused(input);
    });
    it('does not include touched semantic no-ops in the ordinary request or omit changed attachment halves', () => {
        const { input } = fixture({ title: 'Opening' }); ready(input);
        Object.assign(input.saveRequest as object, { base: { title: 'Opening' }, patch: { title: 'Opening' } }); refused(input);
        const unchanged = fixture({ title: 'Edited' }).input;
        changePayload(unchanged, (payload) => { payload.attachments = []; });
        (unchanged.saveRequest as { attachments: { value: Attachment[] } }).attachments.value = []; refused(unchanged);
        delete (unchanged.saveRequest as Record<string, unknown>).attachments; ready(unchanged);
    });
    it('admits an exactly 1,000,000-byte checkpoint frame and refuses the next byte', () => {
        const { input } = fixture(); input.payloadJSON += ' '.repeat(1_000_000 - input.payloadJSON.length); ready(input);
        input.payloadJSON += ' '; refused(input);
    });
    it('rejects separately shaped checklist and lifecycle request intents even with a valid file half', () => {
        for (const field of ['checklist', 'checklistIntent', 'lifecycleIntent']) {
            const { input } = fixture(); (input.saveRequest as Record<string, unknown>)[field] = {}; refused(input);
        }
        const { input } = fixture(); Object.assign(input.saveRequest as object, {
            base: { status: 'next', focusedToday: false, completedAt: '' }, patch: { status: 'done', focusedToday: false, completedAt: '2026-10-05' },
        }); refused(input);
    });
    it('never runs input getters or toJSON hooks', () => {
        let calls = 0;
        const input = fixture().input;
        Object.defineProperty(input, 'beforeTask', { enumerable: true, get: () => { calls++; throw new Error('getter'); } }); refused(input);
        const hook = fixture().input; Object.assign(hook.beforeTask, { toJSON: () => { calls++; throw new Error('hook'); } }); refused(hook);
        expect(calls).toBe(0);
    });
    it('refuses aliases/cycles, exotic prototypes, sparse arrays and non-data properties', () => {
        const alias = fixture().input; alias.beforeTask.tags = alias.beforeTask.contexts; refused(alias);
        const cycle = fixture().input; (cycle.saveRequest as Record<string, unknown>).cycle = cycle; refused(cycle);
        const exotic = fixture().input; Object.setPrototypeOf(exotic.beforeTask, new Date()); refused(exotic);
        const sparse = fixture().input; sparse.beforeTask.tags = Array(2); refused(sparse);
        const hidden = fixture().input; Object.defineProperty(hidden.beforeTask, 'hidden', { value: 1 }); refused(hidden);
    });
    it('bounds capture depth, aliases, node work and each UTF8 frame without executing hooks', () => {
        const deep = fixture().input; let value: unknown = 'leaf'; for (let index = 0; index < 42; index++) value = { value };
        (deep.saveRequest as Record<string, unknown>).extra = value; refused(deep);
        const many = fixture().input; (many.saveRequest as Record<string, unknown>).extra = Array.from({ length: 10_000 }, () => Array.from({ length: 10 }, () => 0)); refused(many);
        const payload = fixture().input; payload.payloadJSON = ' '.repeat(1_000_001); refused(payload);
        const unicode = fixture().input; unicode.payloadJSON = JSON.stringify({ text: '界'.repeat(340_000) }); refused(unicode);
        const request = fixture().input; (request.saveRequest as Record<string, unknown>).extra = 'a'.repeat(8 * 1024 * 1024); refused(request);
        const task = fixture().input; task.beforeTask.description = 'a'.repeat(16 * 1024 * 1024); refused(task);
    });
});
