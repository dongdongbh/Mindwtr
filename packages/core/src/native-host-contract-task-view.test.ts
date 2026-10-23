import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import { createDateFormatter } from './date';
import { loadTranslations } from './i18n/i18n-loader';
import { createMarkdownLinkLookup, resolveMarkdownBlocks, resolveMarkdownInline } from './markdown-blocks';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { taskRevisionOf, setNativeReplayTokens } from './native-request-receipts';
import { replayAfterRestart } from './screen-parity.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { noopStorage } from './storage';
import { applyTaskChecklistEdit, buildTaskChecklistFieldModel } from './task-checklist-model';
import { createTaskDraft, setTaskDraftField } from './task-draft';
import { formatTaskEditorDate } from './task-editor-schedule';
import { buildTaskViewModel } from './task-view-model';
import type { ChecklistItem, Project, Task } from './types';
import { generateUUID } from './uuid';

const NOW = '2026-09-26T15:00:00.000Z';
const T0 = '2026-09-01T10:00:00.000Z';
const item = (id: string, isCompleted = false, title = id): ChecklistItem => ({ id, title, isCompleted });
const task = (fields: Partial<Task> & Pick<Task, 'id' | 'title' | 'status'>): Task => ({ tags: [], contexts: [], createdAt: T0, updatedAt: T0, ...fields });
const project = (id: string, status: Project['status'] = 'active'): Project => ({
    id, title: `Project ${id}`, status, color: '#94a3b8', order: 0, tagIds: [], createdAt: T0, updatedAt: T0,
});

const TASKS: Task[] = [
    task({
        id: 't-list', title: 'Groceries', status: 'next', taskMode: 'list', projectId: 'p-live', priority: 'high', dueDate: '2026-09-30',
        contexts: ['@shop'], description: '# Notes\n- [ ] [[task:t-open|Open task]] and [[task:t-gone|Gone]]\n```\ncode\n```',
        checklist: [item('c1', true, 'Milk **2%**'), item('c2', false, 'Bread')],
        attachments: [{ id: 'a1', kind: 'link', title: 'Site', uri: 'https://example.com', createdAt: T0, updatedAt: T0 }],
    }),
    task({ id: 't-done', title: 'Packed', status: 'done', completedAt: '2026-09-26T08:00:00.000Z', taskMode: 'list', checklist: [item('d1', true), item('d2', true)] }),
    task({ id: 't-open', title: 'Open list', status: 'next', checklist: [item('o1'), item('o2')] }),
    task({ id: 't-empty', title: 'No list', status: 'next' }),
    task({ id: 't-archived', title: 'Old', status: 'next', projectId: 'p-archived', checklist: [item('x1')] }),
    task({ id: 't-long', title: 'Long', status: 'next', checklist: Array.from({ length: 150 }, (_, index) => item(`l${index}`)) }),
];

type Host = ReturnType<typeof createNativeHostContract>;
const writes: unknown[][] = [];
let realActions: { updateTask: (...args: any[]) => Promise<any>; resetTaskChecklist: (id: string) => Promise<any> } | null = null;

async function openHost(saveData?: (data: unknown) => Promise<void>): Promise<Host> {
    await flushPendingSave();
    resetForTests();
    const initial = useTaskStore.getState();
    realActions ??= { updateTask: initial.updateTask, resetTaskChecklist: initial.resetTaskChecklist };
    const real = realActions;
    let data = JSON.parse(JSON.stringify({ tasks: TASKS, projects: [project('p-live'), project('p-archived', 'archived')], sections: [], areas: [], people: [], settings: {} }));
    setStorageAdapter({
        getData: async () => data,
        saveData: async (next) => {
            await saveData?.(next);
            data = JSON.parse(JSON.stringify(next));
        },
    });
    useTaskStore.setState({
        ...real,
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, editLockCount: 0, lastDataChangeAt: 0,
    } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    useTaskStore.setState({
        updateTask: async (id: string, updates: Partial<Task>) => { writes.push(['updateTask', id, updates]); return real.updateTask(id, updates); },
        resetTaskChecklist: async (id: string) => { writes.push(['resetTaskChecklist', id]); return real.resetTaskChecklist(id); },
    } as never);
    writes.length = 0;
    const host = createNativeHostContract();
    expect(await host.setLanguage({ storedLanguage: 'en', systemLocale: 'en-US' })).toMatchObject({ ok: true });
    expect(await host.activate({ writeSafetyReady: true })).toEqual({ ok: true, value: null });
    return host;
}

const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const stored = (id: string) => useTaskStore.getState()._tasksById.get(id) as Task;
const draftOf = (id: string) => createTaskDraft(stored(id));
const invalid = { ok: false, error: { code: 'INVALID_INPUT' } };

let t: (key: string) => string = (key) => key;
beforeAll(async () => {
    const english = await loadTranslations('en');
    t = (key) => english[key] || key;
});
afterEach(async () => {
    vi.useRealTimers();
    await flushPendingSave();
    resetForTests();
    vi.restoreAllMocks();
});
const freezeClock = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
};

describe('native host contract: task View tab', () => {
    /** The View tab as core's model builds it straight from the store. */
    const direct = (shown: Task, readOnly = false) => {
        const state = useTaskStore.getState();
        const format = createDateFormatter({ language: 'en', systemLocale: 'en-US' });
        return buildTaskViewModel({
            task: shown,
            projects: state.projects,
            sections: [],
            areas: state.areas,
            attachments: (shown.attachments ?? []).filter((attachment) => !attachment.deletedAt),
            prioritiesEnabled: true,
            timeEstimatesEnabled: true,
            showStatusField: true,
            readOnly,
            t,
            formatDate: (value) => formatTaskEditorDate(value, format, t('common.notSet')),
            formatDueDate: (value) => formatTaskEditorDate(value, format, t('common.notSet'), { due: true }),
            formatTimeEstimateLabel: (value) => formatTimeEstimateLabel(value, { t }),
            now: new Date(NOW),
        });
    };

    it('returns core\'s View tab, with the notes and item titles as resolved Markdown', async () => {
        freezeClock();
        const host = await openHost();
        const view = value(host.getTaskView({ id: 't-list' }));
        const lookup = createMarkdownLinkLookup(useTaskStore.getState()._allTasks, useTaskStore.getState()._allProjects);
        const expected = direct(stored('t-list')).map((row) => {
            if (row.type === 'description') return { type: 'description', label: row.label, blocks: resolveMarkdownBlocks(row.markdown, lookup) };
            if (row.type === 'checklist') {
                return { ...row, total: row.items.length, items: row.items.map((entry) => ({ ...entry, inline: resolveMarkdownInline(entry.title, lookup) })) };
            }
            if (row.type === 'attachments') {
                return { type: 'attachments', label: row.label, items: row.items.map(({ attachment, title, image, note, disabled }) => ({
                    id: attachment.id, kind: attachment.kind, title, uri: attachment.uri, mimeType: attachment.mimeType ?? null, image, note, disabled,
                })) };
            }
            return row;
        });
        expect(view.rows).toEqual(expected);
        expect(view.rows.map((row) => (row.type === 'field' ? row.field : row.type)))
            .toEqual(['title', 'status', 'priority', 'project', 'dueDate', 'tokens', 'description', 'checklist', 'attachments']);
        expect(view).toMatchObject({ id: 't-list', readOnly: false, readOnlyHint: null, checklistBase: TASKS[0].checklist, taskRevision: taskRevisionOf(stored('t-list')) });
        expect(view.markdownLabels).toEqual({ deletedTask: 'deleted task', deletedProject: 'deleted project', copyCode: 'Copy code' });
        const description = view.rows.find((row) => row.type === 'description');
        expect(JSON.stringify(description)).toContain('"kind":"task","id":"t-open"');
        expect(JSON.stringify(description)).toContain('"type":"deletedReference","text":"Gone","entityType":"task"');
    });

    it('shows the host\'s unsaved draft and checklist, as React Native\'s editor does', async () => {
        freezeClock();
        const host = await openHost();
        const draft = setTaskDraftField(draftOf('t-list'), 'title', 'Groceries today');
        const checklist = [item('c1', true, 'Milk **2%**'), item('new', false, 'Eggs')];
        const view = value(host.getTaskView({ id: 't-list', draft, checklist }));
        expect(view.rows[0]).toEqual({ type: 'title', label: 'Title', value: 'Groceries today' });
        const row = view.rows.find((entry) => entry.type === 'checklist');
        expect(row?.type === 'checklist' && row.items.map((entry) => [entry.id, entry.title, entry.completed])).toEqual([['c1', 'Milk **2%**', true], ['new', 'Eggs', false]]);
        expect(view.checklistBase).toEqual(TASKS[0].checklist);
        // The draft rides in the revision.
        expect(view.revision).not.toBe(value(host.getTaskView({ id: 't-list' })).revision);
        expect(writes).toEqual([]);
    });

    it('shows the editor\'s draft attachments and answers the saved records as attachmentsBase', async () => {
        freezeClock();
        const host = await openHost();
        const saved = TASKS[0].attachments!;
        expect(value(host.getTaskView({ id: 't-list' })).attachmentsBase).toEqual(saved);
        const draftAttachments = [
            { ...saved[0], deletedAt: NOW },
            { id: 'a2', kind: 'link' as const, title: 'Docs', uri: 'https://docs.example.com', createdAt: NOW, updatedAt: NOW },
        ];
        const view = value(host.getTaskView({ id: 't-list', draft: draftOf('t-list'), checklist: TASKS[0].checklist!, attachments: draftAttachments }));
        const row = view.rows.find((entry) => entry.type === 'attachments');
        expect(row?.type === 'attachments' && row.items.map((entry) => [entry.id, entry.title])).toEqual([['a2', 'Docs']]);
        expect(view.attachmentsBase).toEqual(saved);
        // The draft list rides in the revision, as the draft and checklist do.
        expect(view.revision).not.toBe(value(host.getTaskView({ id: 't-list', draft: draftOf('t-list'), checklist: TASKS[0].checklist! })).revision);
        // A read-only task shows its saved attachments; a list that is not one is refused.
        expect(value(host.getTaskView({ id: 't-archived', attachments: draftAttachments })).rows.some((entry) => entry.type === 'attachments')).toBe(false);
        expect(host.getTaskView({ id: 't-list', attachments: [{ id: 'x' }] as never })).toMatchObject(invalid);
        expect(writes).toEqual([]);
    });

    it('shows a task in an archived project as saved, read-only', async () => {
        freezeClock();
        const host = await openHost();
        const view = value(host.getTaskView({ id: 't-archived', draft: setTaskDraftField(draftOf('t-archived'), 'title', 'Ignored') }));
        expect(view.readOnly).toBe(true);
        expect(view.readOnlyHint).toBe('Archived project. Reactivate it to edit this task.');
        expect(view.rows[0]).toMatchObject({ value: 'Old' });
        expect(view.rows.find((row) => row.type === 'status')).toMatchObject({ editable: false });
        expect(view.rows.find((row) => row.type === 'checklist')).toMatchObject({ tappable: false, add: null });
    });

    it.each([false, true])('round-trips a stored archived draft through View and supported edits without changing its lifecycle (cancelled: %s)', async (cancelled) => {
        const host = await openHost();
        const archived = task({
            id: 'history', title: 'History task', status: 'archived', rev: 7,
            ...(cancelled ? { cancelledAt: T0 } : { completedAt: T0 }),
        });
        useTaskStore.setState({ _allTasks: [...useTaskStore.getState()._allTasks, archived] });
        const editor = value(host.getTaskEditorModel({ id: archived.id }));
        const draft = JSON.parse(JSON.stringify(editor.draft));
        expect(editor.options.statuses).not.toContain('archived');
        expect(value(host.getTaskView({ id: archived.id, draft, checklist: [] })).rows[0])
            .toMatchObject({ type: 'title', value: archived.title });
        const edited = value(host.editTaskDraft({ id: archived.id, draft, edit: { type: 'fields', patch: {
            title: 'Renamed history', description: 'Notes', priority: 'high', energyLevel: 'low', timeEstimate: '30min',
        } } })).draft;
        expect(edited).toMatchObject({
            status: 'archived', title: 'Renamed history', description: 'Notes', priority: 'high', energyLevel: 'low', timeEstimate: '30min',
        });
        expect(value(host.editTaskChecklist({ id: archived.id, draft, checklist: [] })).draft).toEqual(editor.draft);
        expect(writes).toEqual([]);
        expect(stored(archived.id)).toBe(archived);

        const saved = value(await host.saveTaskDraft({ id: archived.id, base: { title: draft.title }, patch: { title: edited.title } }));
        expect(writes).toEqual([['updateTask', archived.id, { title: 'Renamed history' }]]);
        expect(stored(archived.id)).toMatchObject({ status: 'archived', title: 'Renamed history', rev: 8 });
        expect(stored(archived.id).completedAt).toBe(archived.completedAt);
        expect(stored(archived.id).cancelledAt).toBe(archived.cancelledAt);
        expect(saved.draft.status).toBe('archived');
    });

    it('keeps archived status patches, malformed whole drafts and protected-parent writes refused', async () => {
        const host = await openHost();
        const archived = task({ id: 'history', title: 'History task', status: 'archived', projectId: 'p-archived', completedAt: T0 });
        useTaskStore.setState({ _allTasks: [...useTaskStore.getState()._allTasks, archived] });
        const draft = value(host.getTaskEditorModel({ id: archived.id })).draft;
        expect(value(host.getTaskView({ id: archived.id, draft: { ...draft, title: 'Ignored' } })))
            .toMatchObject({ readOnly: true, rows: expect.arrayContaining([{ type: 'title', label: 'Title', value: archived.title }]) });
        expect(host.editTaskChecklist({ id: archived.id, draft, checklist: [] })).toMatchObject(invalid);
        expect(await host.saveTaskDraft({ id: archived.id, base: { title: archived.title }, patch: { title: 'Ignored' } })).toMatchObject(invalid);
        const activeDraft = draftOf('t-open');
        expect(host.editTaskDraft({ id: 't-open', draft: activeDraft, edit: { type: 'fields', patch: { status: 'archived' } } })).toMatchObject(invalid);
        expect(await host.saveTaskDraft({ id: 't-open', base: { status: activeDraft.status }, patch: { status: 'archived' } })).toMatchObject(invalid);
        for (const patch of [{ status: 'cancelled' }, { status: 'unknown' }, { status: null }, { energyLevel: 'unknown' }, { dueDate: 'tomorrow' }, { extra: 'unknown' }]) {
            const malformed = { ...draft, ...patch } as never;
            expect(host.getTaskView({ id: archived.id, draft: malformed })).toMatchObject(invalid);
            expect(host.editTaskDraft({ id: archived.id, draft: malformed })).toMatchObject(invalid);
            expect(host.editTaskChecklist({ id: archived.id, draft: malformed, checklist: [] })).toMatchObject(invalid);
        }
        expect(writes).toEqual([]);
        expect(stored(archived.id)).toBe(archived);
    });

    it('pages a long checklist under one revision and refuses a stale window', async () => {
        freezeClock();
        const host = await openHost();
        const first = value(host.getTaskView({ id: 't-long' }));
        const firstRow = first.rows.find((row) => row.type === 'checklist');
        expect(firstRow).toMatchObject({ total: 150 });
        expect(firstRow?.type === 'checklist' && firstRow.items.map((entry) => entry.index)).toEqual(Array.from({ length: 100 }, (_, index) => index));
        const second = value(host.getTaskView({ id: 't-long', offset: 100, limit: 100, revision: first.revision }));
        const secondRow = second.rows.find((row) => row.type === 'checklist');
        expect(secondRow?.type === 'checklist' && secondRow.items.map((entry) => entry.id)).toEqual(Array.from({ length: 50 }, (_, index) => `l${index + 100}`));
        expect(host.getTaskView({ id: 't-long', offset: 100, limit: 100 })).toMatchObject(invalid);
        expect(host.getTaskView({ id: 't-long', limit: 101 })).toMatchObject(invalid);
        await useTaskStore.getState().updateTask('t-empty', { title: 'Renamed elsewhere' });
        expect(host.getTaskView({ id: 't-long', offset: 100, limit: 100, revision: first.revision })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });
});

describe('native host contract: checklist edits', () => {
    it('edits the host\'s draft checklist as core does, and writes nothing', async () => {
        freezeClock();
        const host = await openHost();
        const draft = draftOf('t-open');
        const checklist = stored('t-open').checklist as ChecklistItem[];
        const edits = [
            { kind: 'toggle', index: 0 }, { kind: 'toggle', index: 1 }, { kind: 'rename', index: 1, text: 'Two\n[x] Three' },
            { kind: 'remove', index: 0 }, { kind: 'move', from: 0, to: 1 }, { kind: 'append', title: '  Tail ' }, { kind: 'uncheckAll' },
        ] as const;
        for (const edit of edits) {
            const result = value(host.editTaskChecklist({ id: 't-open', draft, checklist, edit }));
            const expected = applyTaskChecklistEdit(checklist, edit, { newId: generateUUID });
            expect(result.checklist.map((entry) => [entry.title, entry.isCompleted])).toEqual(expected?.checklist.map((entry) => [entry.title, entry.isCompleted]));
            expect(result.checklist.filter((entry) => checklist.some((old) => old.id === entry.id)).map((entry) => entry.id))
                .toEqual(expected?.checklist.filter((entry) => checklist.some((old) => old.id === entry.id)).map((entry) => entry.id));
            expect(result.draft).toEqual(draft);
            expect(result.changed).toBe(true);
            expect(result.field).toEqual(buildTaskChecklistFieldModel({ checklist: result.checklist, isReference: false, t }));
        }
        const added = value(host.editTaskChecklist({ id: 't-open', draft, checklist, edit: { kind: 'add' } }));
        expect(added.focusId).toBe(added.checklist[2].id);
        expect(added.checklist[2]).toEqual({ id: added.focusId, title: '', isCompleted: false });
        // Return on an empty item and a blank add input only end editing.
        const blank = [...checklist, item('b', false, ' ')];
        expect(value(host.editTaskChecklist({ id: 't-open', draft, checklist: blank, edit: { kind: 'insertAfter', index: 2 } })))
            .toMatchObject({ changed: false, checklist: blank, focusId: null });
        expect(value(host.editTaskChecklist({ id: 't-open', draft, checklist: blank, edit: { kind: 'add' } }))).toMatchObject({ changed: false });
        // Without an edit: the Form tab's field.
        expect(value(host.editTaskChecklist({ id: 't-open', draft, checklist })).field).toEqual(buildTaskChecklistFieldModel({ checklist, isReference: false, t }));
        expect(writes).toEqual([]);
        expect(stored('t-open').checklist).toEqual(TASKS[2].checklist);
    });

    it('moves a list task\'s draft to Done when every item is, and back to Next when one opens', async () => {
        freezeClock();
        const host = await openHost();
        const draft = draftOf('t-list');
        const checklist = stored('t-list').checklist as ChecklistItem[];
        const allDone = value(host.editTaskChecklist({ id: 't-list', draft, checklist, edit: { kind: 'toggle', index: 1 } }));
        expect(allDone.draft).toEqual(setTaskDraftField(draft, 'status', 'done'));
        const reopened = value(host.editTaskChecklist({ id: 't-list', draft: allDone.draft, checklist: allDone.checklist, edit: { kind: 'append', title: 'Butter' } }));
        expect(reopened.draft.status).toBe('next');
        // Reset's draft half on a done list task.
        const reset = value(host.editTaskChecklist({ id: 't-done', draft: draftOf('t-done'), checklist: stored('t-done').checklist as ChecklistItem[], edit: { kind: 'uncheckAll' } }));
        expect(reset.draft.status).toBe('next');
        expect(reset.checklist.every((entry) => !entry.isCompleted)).toBe(true);
    });

    it('ticks a Reference list without moving the reference: no Done, no completedAt, no Focus (#1416)', async () => {
        freezeClock();
        const host = await openHost();
        expect(await useTaskStore.getState().updateTask('t-list', { status: 'reference' })).toMatchObject({ success: true });
        const draft = draftOf('t-list');
        const checklist = stored('t-list').checklist as ChecklistItem[];
        const ticked = value(host.editTaskChecklist({ id: 't-list', draft, checklist, edit: { kind: 'toggle', index: 1 } }));
        expect(ticked.checklist.every((entry) => entry.isCompleted)).toBe(true);
        expect(ticked.draft).toEqual(draft);
        expect(ticked.field).toMatchObject({ label: 'List', canReset: true });
        expect(ticked.field.items.map((entry) => entry.struck)).toEqual([true, true]);
        // The store write the editor saves, and a direct one, leave it a reference.
        expect(await useTaskStore.getState().updateTask('t-list', { checklist: ticked.checklist })).toMatchObject({ success: true });
        expect(stored('t-list')).toMatchObject({ status: 'reference', checklist: ticked.checklist });
        expect(stored('t-list').completedAt).toBeUndefined();
        expect(stored('t-list').isFocusedToday).toBeFalsy();
        // Reset unchecks every entry and keeps it a reference.
        writes.length = 0;
        const reset = await host.resetTaskChecklist({ id: 't-list', requestId: generateUUID(), taskRevision: taskRevisionOf(stored('t-list')) });
        expect(reset).toMatchObject({ ok: true });
        expect(writes).toEqual([['resetTaskChecklist', 't-list']]);
        expect(stored('t-list').status).toBe('reference');
        expect(stored('t-list').checklist?.every((entry) => !entry.isCompleted)).toBe(true);
    });

    it('refuses invalid edits and a read-only task', async () => {
        freezeClock();
        const host = await openHost();
        const draft = draftOf('t-open');
        const checklist = stored('t-open').checklist as ChecklistItem[];
        for (const edit of [
            { kind: 'toggle', index: 2 }, { kind: 'toggle', index: -1 }, { kind: 'remove', index: 1.5 }, { kind: 'move', from: 0, to: 2 },
            { kind: 'append' }, { kind: 'explode' }, null,
        ]) {
            expect(host.editTaskChecklist({ id: 't-open', draft, checklist, edit: edit as never })).toMatchObject(invalid);
        }
        const longTitle = 'x'.repeat(10_001);
        const edited = value(host.editTaskChecklist({ id: 't-open', draft, checklist,
            edit: { kind: 'rename', index: 0, text: longTitle } }));
        expect(edited.checklist[0].title).toBe(longTitle);
        expect(host.getTaskView({ id: 't-open', draft: edited.draft, checklist: edited.checklist })).toMatchObject({ ok: true });
        expect(host.editTaskChecklist({ id: 't-open', draft, checklist,
            edit: { kind: 'rename', index: 0, text: '漢'.repeat(700_000) } })).toMatchObject(invalid);
        expect(writes).toEqual([]);
        expect(host.editTaskChecklist({ id: 't-open', draft: { ...draft, status: 'nope' } as never, checklist })).toMatchObject(invalid);
        expect(host.editTaskChecklist({ id: 't-open', draft, checklist: [{ id: 'a', title: 'A' }] as never })).toMatchObject(invalid);
        expect(host.editTaskChecklist({ id: 't-open', draft, checklist: [{ ...checklist[0], extra: 1 }] as never })).toMatchObject(invalid);
        expect(host.editTaskChecklist({ id: 't-archived', draft: draftOf('t-archived'), checklist: [], edit: { kind: 'add' } })).toMatchObject(invalid);
        expect(host.editTaskChecklist({ id: 'missing', draft, checklist })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        expect(host.getTaskView({ id: '' })).toMatchObject(invalid);
        expect(host.getTaskView({ id: 't-open', draft: {} as never })).toMatchObject(invalid);
        expect(host.getTaskView({ id: 'missing' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
    });
});

describe('native host contract: saving the checklist with the draft (saveTaskDraft)', () => {
    it('writes the checklist and a list task\'s status in one update: one row version', async () => {
        freezeClock();
        const host = await openHost();
        const draft = draftOf('t-list');
        const base = stored('t-list').checklist as ChecklistItem[];
        const edited = value(host.editTaskChecklist({ id: 't-list', draft, checklist: base, edit: { kind: 'toggle', index: 1 } }));
        expect(edited.draft.status).toBe('done');
        const rev = stored('t-list').rev ?? 0;
        const saved = value(await host.saveTaskDraft({
            requestId: generateUUID(),
            id: 't-list', base: { status: 'next' }, patch: { status: 'done' }, checklist: { base, value: edited.checklist },
        }));
        const done = [item('c1', true, 'Milk **2%**'), item('c2', true, 'Bread')];
        expect(writes).toHaveLength(1);
        expect(writes[0][2]).toMatchObject({ status: 'done', checklist: done });
        expect(stored('t-list')).toMatchObject({ status: 'done', checklist: done, rev: rev + 1 });
        expect(saved).toEqual({ id: 't-list', draft: createTaskDraft(stored('t-list')) });
        expect(value(host.getTaskView({ id: 't-list' })).checklistBase).toEqual(done);
    });

    it('keeps a status the user set back by hand: no status rule at save, and empty items dropped', async () => {
        freezeClock();
        const host = await openHost();
        const draft = draftOf('t-list');
        const base = stored('t-list').checklist as ChecklistItem[];
        // Tick every item (the draft turns Done), then set the status back to the loaded Next.
        const ticked = value(host.editTaskChecklist({ id: 't-list', draft, checklist: base, edit: { kind: 'toggle', index: 1 } }));
        expect(ticked.draft.status).toBe('done');
        const edited = value(host.editTaskDraft({ id: 't-list', draft: ticked.draft, edit: { type: 'fields', patch: { status: 'next' } } })).draft;
        expect(edited.status).toBe('next');
        // Status equals the loaded value, so the host sends no status.
        value(await host.saveTaskDraft({
            requestId: generateUUID(),
            id: 't-list', base: {}, patch: {}, checklist: { base, value: [...ticked.checklist, item('blank', true, '  ')] },
        }));
        expect(writes).toEqual([['updateTask', 't-list', { checklist: [item('c1', true, 'Milk **2%**'), item('c2', true, 'Bread')] }]]);
        expect(stored('t-list').status).toBe('next');
        // A checklist already saved, with no other change, writes nothing.
        writes.length = 0;
        const rev = stored('t-list').rev;
        const current = stored('t-list').checklist as ChecklistItem[];
        expect(await host.saveTaskDraft({ id: 't-list', base: {}, patch: {}, checklist: { base, value: current }, requestId: generateUUID() })).toMatchObject({ ok: true });
        expect(writes).toEqual([]);
        expect(stored('t-list').rev).toBe(rev);
    });

    it('refuses a checklist another writer changed under the draft, like any other field', async () => {
        freezeClock();
        const host = await openHost();
        const base = stored('t-open').checklist as ChecklistItem[];
        await useTaskStore.getState().updateTask('t-open', { checklist: [item('o1', true), item('o2')] });
        writes.length = 0;
        expect(await host.saveTaskDraft({
            requestId: generateUUID(),
            id: 't-open', base: { title: 'Open list' }, patch: { title: 'Renamed' }, checklist: { base, value: [...base, item('o3')] },
        })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION', message: 'Task changed while editing: checklist' } });
        expect(writes).toEqual([]);
        expect(stored('t-open').title).toBe('Open list');
        // A checklist that already holds the new value is no conflict.
        expect(await host.saveTaskDraft({
            requestId: generateUUID(),
            id: 't-open', base: { title: 'Open list' }, patch: { title: 'Renamed' }, checklist: { base, value: [item('o1', true), item('o2')] },
        })).toMatchObject({ ok: true });
        expect(writes).toEqual([['updateTask', 't-open', { title: 'Renamed' }]]);
    });

    it('retries a failed save exactly: one write', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const host = await openHost(saveData);
        const base = stored('t-list').checklist as ChecklistItem[];
        const input = { id: 't-list', base: { status: 'next' as const }, patch: { status: 'done' as const }, checklist: { base, value: [item('c1', true, 'Milk **2%**'), item('c2', true, 'Bread')] }, requestId: generateUUID() };
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.saveTaskDraft(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        expect(writes).toHaveLength(1);
        saveData.mockResolvedValue(undefined);
        expect(await host.saveTaskDraft(input)).toMatchObject({ ok: true, value: { draft: { status: 'done' } } });
        expect(writes).toHaveLength(1);
        expect((saveData.mock.lastCall?.[0] as { tasks: Task[] }).tasks.find((entry) => entry.id === 't-list')).toMatchObject({ status: 'done', checklist: input.checklist.value });
    }, 30_000);

    it('refuses an invalid checklist half', async () => {
        freezeClock();
        const host = await openHost();
        const base = TASKS[2].checklist as ChecklistItem[];
        for (const checklist of [
            null, { base }, { base: null, value: base }, { base, value: [{ id: 'a', title: 'A' }] }, { base, value: [{ ...base[0], extra: 1 }] },
            { base, value: Array.from({ length: 1_001 }, (_, index) => item(`i${index}`)) },
        ]) {
            expect(await host.saveTaskDraft({ id: 't-open', base: {}, patch: {}, checklist: checklist as never, requestId: generateUUID() })).toMatchObject(invalid);
        }
        expect(await host.saveTaskDraft({ id: 't-open', base: {}, patch: {}, requestId: generateUUID() })).toMatchObject(invalid);
        expect(await host.saveTaskDraft({ id: 't-archived', base: {}, patch: {}, checklist: { base: [item('x1')], value: [] }, requestId: generateUUID() })).toMatchObject(invalid);
        expect(writes).toEqual([]);
    });
});

describe('native host contract: Reset checklist', () => {
    /** The reset's input: the saved task's revision as the View tab showed it. */
    const reset = (host: Host, id: string, requestId = generateUUID()) => ({ id, requestId, taskRevision: value(host.getTaskView({ id })).taskRevision });

    it('resets the saved checklist and reopens a Done task; an open checklist writes nothing', async () => {
        freezeClock();
        const host = await openHost();
        expect(value(await host.resetTaskChecklist(reset(host, 't-done'))))
            .toEqual({ id: 't-done', checklist: [item('d1'), item('d2')] });
        expect(stored('t-done')).toMatchObject({ status: 'next', checklist: [item('d1'), item('d2')] });
        expect(stored('t-done').completedAt).toBeUndefined();
        writes.length = 0;
        const rev = stored('t-open').rev;
        expect(value(await host.resetTaskChecklist(reset(host, 't-open')))).toEqual({ id: 't-open', checklist: TASKS[2].checklist });
        expect(writes).toEqual([]);
        expect(stored('t-open').rev).toBe(rev);
        // No saved checklist (items added in this editor only): nothing to write; the host reopens its draft items.
        expect(value(await host.resetTaskChecklist(reset(host, 't-empty')))).toEqual({ id: 't-empty', checklist: [] });
        expect(writes).toEqual([]);
        expect(await host.resetTaskChecklist(reset(host, 't-archived'))).toMatchObject(invalid);
    });

    it('retries a failed save exactly: one write, and the retry finishes the save', async () => {
        freezeClock();
        const saveData = vi.fn().mockResolvedValue(undefined);
        const host = await openHost(saveData);
        const input = reset(host, 't-done');
        saveData.mockRejectedValue(new Error('disk unavailable'));
        expect(await host.resetTaskChecklist(input)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED', message: 'disk unavailable' } });
        expect(writes).toHaveLength(1);
        saveData.mockResolvedValue(undefined);
        // The receipt answers before the revision, which the write moved.
        const retried = await host.resetTaskChecklist(input);
        expect(retried.ok).toBe(true);
        expect(writes).toHaveLength(1);
        expect((saveData.mock.lastCall?.[0] as { tasks: Task[] }).tasks.find((entry) => entry.id === 't-done')).toMatchObject({ status: 'next', checklist: [item('d1'), item('d2')] });
        // A lost reply repeats the request: the same answer, no write, no save.
        const saves = saveData.mock.calls.length;
        expect(await host.resetTaskChecklist(input)).toEqual(retried);
        expect(saveData).toHaveBeenCalledTimes(saves);
        expect(writes).toHaveLength(1);
    }, 30_000);

    it('a replay after a restart never undoes a later edit: STALE once the task changed since', async () => {
        freezeClock();
        const host = await openHost();
        const input = reset(host, 't-done');
        value(await host.resetTaskChecklist(input));
        // The user ticks an item again.
        await useTaskStore.getState().updateTask('t-done', { checklist: [item('d1', true), item('d2')] });
        writes.length = 0;
        const { result, wrote } = await replayAfterRestart((restarted) => restarted.resetTaskChecklist(input));
        expect(result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(wrote).toBe(false);
        expect(writes).toEqual([]);
        expect(stored('t-done').checklist).toEqual([item('d1', true), item('d2')]);
    });

    it('refuses a request ID reused for another task, and invalid input', async () => {
        freezeClock();
        const host = await openHost();
        // As the journaling Android host: each write must carry its replay tokens.
        setNativeReplayTokens('required');
        const done = reset(host, 't-done');
        value(await host.resetTaskChecklist(done));
        expect(await host.resetTaskChecklist({ ...reset(host, 't-list'), requestId: done.requestId })).toMatchObject(invalid);
        expect(await host.resetTaskChecklist({ ...reset(host, 't-done'), requestId: 'not-a-uuid' })).toMatchObject(invalid);
        expect(await host.resetTaskChecklist({ id: 'missing', requestId: generateUUID(), taskRevision: 'r' })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } });
        // The reset carries the revision the View tab showed.
        expect(await host.resetTaskChecklist({ id: 't-list', requestId: generateUUID() } as never)).toMatchObject(invalid);
    });
});

it('is NOT_READY until storage is activated', async () => {
    await flushPendingSave();
    resetForTests();
    setStorageAdapter(noopStorage);
    const host = createNativeHostContract();
    const notReady = { ok: false, error: { code: 'NOT_READY' } };
    const draft = createTaskDraft(TASKS[2]);
    expect(host.getTaskView({ id: 't-open' })).toMatchObject(notReady);
    expect(host.editTaskChecklist({ id: 't-open', draft, checklist: [], edit: { kind: 'add' } })).toMatchObject(notReady);
    expect(await host.saveTaskDraft({ id: 't-open', base: {}, patch: {}, checklist: { base: [], value: [] }, requestId: generateUUID() })).toMatchObject(notReady);
    expect(await host.resetTaskChecklist({ id: 't-open', requestId: generateUUID(), taskRevision: 'r' })).toMatchObject(notReady);
});
