import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatTimeEstimateLabel } from './calendar-scheduling';
import { safeFormatDate } from './date';
import { loadTranslations } from './i18n/i18n-loader';
import {
    createMarkdownLinkLookup,
    parseMarkdownBlocks,
    resolveMarkdownBlocks,
    resolveMarkdownInline,
    type MarkdownInline,
    type ResolvedMarkdownBlock,
} from './markdown-blocks';
import {
    applyTaskChecklistEdit,
    buildTaskChecklistFieldModel,
    getChecklistEditStatus,
    reorderChecklistItems,
    type TaskChecklistEdit,
} from './task-checklist-model';
import { formatTaskEditorDate } from './task-editor-schedule';
import { buildTaskViewModel, type TaskViewRow } from './task-view-model';
import type { Area, ChecklistItem, Project, Section, Task } from './types';

/**
 * The frozen React Native View tab, Markdown preview, checklist field and checklist
 * rules (task-view-parity.fixtures.json, captured by
 * apps/mobile/components/task-edit/TaskEditViewTab.parity.test.tsx), replayed through
 * core's models. Each model's output is read the way the harness read React Native's
 * rendered tree.
 */
type Handlers = { project: boolean; context: boolean; tag: boolean; status: boolean };
type Fixture = {
    now: string;
    store: { tasks: Task[]; projects: Project[]; sections: Section[]; areas: Area[] };
    markdownScenarios: Array<{ name: string; markdown: string; inline?: object }>;
    viewTabScenarios: Array<{
        name: string; task: Task; prioritiesEnabled: boolean; timeEstimatesEnabled: boolean; showStatusField: boolean; readOnly: boolean;
        handlers: Handlers; actions: unknown[][];
    }>;
    checklistFieldScenarios: Array<{ name: string; checklist?: ChecklistItem[]; draftStatus: Task['status'] | null; taskStatus: Task['status']; actions: unknown[][] }>;
    cascadeScenarios: Array<{ name: string; taskMode?: Task['taskMode']; taskStatus: Task['status']; draftStatus: Task['status'] | null; next: ChecklistItem[]; canMutate: boolean }>;
    resetScenarios: Array<{ name: string; taskMode?: Task['taskMode']; draftStatus: Task['status']; draftChecklist?: ChecklistItem[]; storeResult: { success: boolean; error?: string } }>;
    observations: Record<'markdown' | 'viewTab' | 'checklistField' | 'cascade' | 'reset', Record<string, any>>;
};

const fixture: Fixture = JSON.parse(readFileSync(new URL('./task-view-parity.fixtures.json', import.meta.url), 'utf8'));
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const lookup = createMarkdownLinkLookup(fixture.store.tasks, fixture.store.projects);

let t: (key: string) => string = (key) => key;
const originalTimezone = process.env.TZ;
beforeAll(async () => {
    // Match the frozen RN harness instead of the developer machine's timezone.
    process.env.TZ = 'UTC';
    const english = await loadTranslations('en');
    t = (key) => english[key] || key;
});
afterAll(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
});

// ---------------------------------------------------------------------------
// Reading core's models as the harness read React Native's tree.

const readInline = (inline: MarkdownInline[]) => inline.map((node) => {
    if (node.type === 'deletedReference') return ['deleted', node.text, ` (${t(node.entityType === 'task' ? 'markdown.referenceDeletedTask' : 'markdown.referenceDeletedProject')})`];
    if (node.type !== 'link') return [node.type, node.text];
    const { target } = node;
    const opened = target.kind === 'project' ? ['openProjectScreen', target.id]
        : target.kind === 'task' ? ['openTaskScreen', target.id, target.projectId] : ['openURL', target.href];
    return ['link', node.text, [opened]];
});
const readBlocks = (blocks: ResolvedMarkdownBlock[]) => blocks.map((block) => {
    switch (block.type) {
        case 'blank': case 'rule': return [block.type];
        case 'heading': return ['heading', block.level, readInline(block.inline)];
        case 'paragraph': return ['paragraph', readInline(block.inline)];
        case 'code': return ['code', block.text, t('markdown.copyCode'), [['copy', block.text]]];
        case 'taskList': return ['list', 'task', block.items.map((item) => [item.checked ? '☑' : '☐', item.depth, readInline(item.inline)])];
        case 'bulletList': return ['list', 'bullet', block.items.map((item) => [item.marker, item.depth, readInline(item.inline)])];
        case 'orderedList': return ['list', 'ordered', block.items.map((item) => [item.marker, item.depth, readInline(item.inline)])];
        default: return ['unknown'];
    }
});

const readViewTab = (rows: TaskViewRow[], handlers: Handlers) => rows.map((row) => {
    switch (row.type) {
        case 'title': return ['title', row.label, row.value, null];
        case 'status': return ['row', row.label, row.editable && handlers.status ? ['badge', row.status, true, true] : row.value, null];
        case 'field': return ['row', row.label, row.value, row.project && handlers.project ? [row.project.accessibilityLabel, [['onProjectPress', row.project.id]]] : null];
        case 'tokens': {
            const [handler, name] = row.field === 'contexts' ? [handlers.context, 'onContextPress'] : [handlers.tag, 'onTagPress'];
            return ['pills', row.label, row.items.map((item) => [item.value, handler ? [item.accessibilityLabel, [[name, item.value]]] : null])];
        }
        case 'description': return ['description', row.label, readBlocks(resolveMarkdownBlocks(row.markdown, lookup))];
        case 'checklist': return ['checklist', row.label, [
            ...row.items.map((item) => [
                row.tappable ? 'tap' : 'static',
                item.completed ? 'CheckSquare' : 'Square',
                readInline(resolveMarkdownInline(item.title, lookup)),
                item.accessibilityLabel,
                row.tappable ? 'checkbox' : null,
                row.tappable ? item.completed : null,
            ]),
            ...(row.add ? [['input', row.add.placeholder, row.add.label]] : []),
        ]];
        case 'attachments': return ['attachments', row.label, row.items.map((item) => [
            item.disabled,
            item.image ? ['image', item.attachment.uri] : ['file', item.title, ...(item.note ? [item.note] : []), 'AttachmentProgressIndicator'],
            [['openAttachment', item.attachment.id]],
        ])];
        default: return ['unknown'];
    }
});

const readChecklistField = (checklist: ChecklistItem[] | undefined, isReference: boolean, orderMode: boolean) => {
    const model = buildTaskChecklistFieldModel({ checklist, isReference, t });
    const color = (struck: boolean) => (struck ? 'tc.secondaryText' : 'tc.text');
    const toggle = model.canReorder ? [orderMode ? model.labels.done : model.labels.reorder, orderMode ? model.labels.done : model.labels.reorder] : null;
    if (orderMode) {
        const button = (label: string, enabled: boolean) => [label, !enabled, enabled ? 'tc.tint' : 'tc.secondaryText'];
        return {
            label: model.label,
            orderToggle: toggle,
            order: model.items.map((item) => [item.orderTitle, color(item.struck), button(item.moveUpLabel, item.canMoveUp), button(item.moveDownLabel, item.canMoveDown)]),
        };
    }
    return {
        label: model.label,
        orderToggle: toggle,
        items: model.items.map((item) => [
            ['checkbox', item.checkboxLabel, item.completed, item.completed],
            item.title,
            color(item.struck),
            item.struck,
            item.inputLabel,
            model.labels.placeholder,
            '×',
        ]),
        add: model.labels.add,
        ...(model.canReset ? { reset: model.labels.reset } : {}),
    };
};

const ids = () => {
    let next = 0;
    return () => `uuid-${++next}`;
};

// ---------------------------------------------------------------------------

describe('task view parity with the frozen React Native editor', () => {
    it('covers every scenario the fixture froze', () => {
        expect(fixture.markdownScenarios.map((scenario) => scenario.name)).toEqual(Object.keys(fixture.observations.markdown));
        expect(fixture.viewTabScenarios.map((scenario) => scenario.name)).toEqual(Object.keys(fixture.observations.viewTab));
        expect(fixture.checklistFieldScenarios.map((scenario) => scenario.name)).toEqual(Object.keys(fixture.observations.checklistField));
        expect(fixture.cascadeScenarios.map((scenario) => scenario.name)).toEqual(Object.keys(fixture.observations.cascade));
        expect(fixture.resetScenarios.map((scenario) => scenario.name)).toEqual(Object.keys(fixture.observations.reset));
    });

    it.each(fixture.markdownScenarios.map((scenario) => [scenario.name, scenario] as const))('Markdown: %s', (name, scenario) => {
        const read = scenario.inline
            ? readInline(resolveMarkdownInline(scenario.markdown, lookup))
            : readBlocks(resolveMarkdownBlocks(scenario.markdown, lookup));
        expect(json(read)).toEqual(fixture.observations.markdown[name].read);
    });

    it.each(fixture.viewTabScenarios.map((scenario) => [scenario.name, scenario] as const))('View tab: %s', (name, scenario) => {
        const formatDate = (value: string) => formatTaskEditorDate(value, safeFormatDate, t('common.notSet'));
        const rows = buildTaskViewModel({
            task: scenario.task,
            projects: fixture.store.projects.filter((project) => !project.deletedAt),
            sections: fixture.store.sections.filter((section) => section.projectId === scenario.task.projectId),
            areas: fixture.store.areas,
            attachments: (scenario.task.attachments ?? []).filter((attachment) => !attachment.deletedAt),
            prioritiesEnabled: scenario.prioritiesEnabled,
            timeEstimatesEnabled: scenario.timeEstimatesEnabled,
            showStatusField: scenario.showStatusField,
            readOnly: scenario.readOnly,
            t,
            formatDate,
            formatDueDate: (value) => formatTaskEditorDate(value, safeFormatDate, t('common.notSet'), { due: true }),
            formatTimeEstimateLabel: (value) => formatTimeEstimateLabel(value, { t }),
            now: new Date(fixture.now),
        });
        const frozen = fixture.observations.viewTab[name];
        expect(json(readViewTab(rows, scenario.handlers))).toEqual(frozen.read);

        const checklist = rows.find((row) => row.type === 'checklist');
        const actions = scenario.actions.map((action) => {
            const [kind, arg] = action as [string, unknown];
            const edit = (change: TaskChecklistEdit) => applyTaskChecklistEdit(scenario.task.checklist, change, { newId: ids() });
            if (kind === 'tick') {
                const item = checklist?.type === 'checklist' && checklist.tappable ? checklist.items[arg as number] : undefined;
                const result = item ? edit({ kind: 'toggle', index: item.index }) : null;
                return [action, result ? [['applyChecklistUpdate', result.checklist]] : [], '', ''];
            }
            if (kind === 'type') return [action, [], arg, arg];
            if (kind === 'submit') {
                const result = edit({ kind: 'append', title: arg as string });
                return result ? [action, [['applyChecklistUpdate', result.checklist]], '', ''] : [action, [['blur']], arg, arg];
            }
            const attachments = rows.find((row) => row.type === 'attachments');
            return [action, attachments?.type === 'attachments' ? [['openAttachment', attachments.items[arg as number].attachment.id]] : [], '', ''];
        });
        expect(json(actions)).toEqual(frozen.actions);
    });

    it.each(fixture.checklistFieldScenarios.map((scenario) => [scenario.name, scenario] as const))('checklist field: %s', (name, scenario) => {
        const isReference = (scenario.draftStatus ?? scenario.taskStatus) === 'reference';
        const frozen = fixture.observations.checklistField[name];
        expect(json(readChecklistField(scenario.checklist, isReference, false))).toEqual(frozen.read);
        const field = buildTaskChecklistFieldModel({ checklist: scenario.checklist, isReference, t });
        const actions = scenario.actions.map((action) => {
            const [kind, index, value] = action as [string, number, string];
            const apply = (edit: TaskChecklistEdit, onNull: unknown[][] = []) => {
                const result = applyTaskChecklistEdit(scenario.checklist, edit, { newId: ids() });
                return [action, result ? [['applyChecklistUpdate', result.checklist]] : onNull, null];
            };
            switch (kind) {
                case 'toggle': return apply({ kind: 'toggle', index });
                case 'change': return apply({ kind: 'rename', index, text: value });
                case 'submit': return apply({ kind: 'insertAfter', index }, [['blur']]);
                case 'remove': return apply({ kind: 'remove', index });
                case 'add': return apply({ kind: 'add' });
                case 'reset': return [action, field.canReset ? [['handleResetChecklist']] : [], null];
                case 'order': return [action, [], field.canReorder ? readChecklistField(scenario.checklist, isReference, true) : null];
                case 'orderMove': return apply({ kind: 'move', from: index, to: value === 'up' ? index - 1 : index + 1 });
                default: return [action, [], null];
            }
        });
        expect(json(actions)).toEqual(frozen.actions);
    });

    it.each(fixture.cascadeScenarios.map((scenario) => [scenario.name, scenario] as const))('checklist status rule: %s', (name, scenario) => {
        const status = scenario.draftStatus ?? scenario.taskStatus;
        const next = getChecklistEditStatus({ taskMode: scenario.taskMode, status, checklist: scenario.next });
        const calls = scenario.canMutate
            ? [['setChecklist', scenario.next], ...(next !== status ? [['setDraftField', 'status', next]] : [])]
            : [];
        expect(json(calls)).toEqual(fixture.observations.cascade[name]);
    });

    it.each(fixture.resetScenarios.map((scenario) => [scenario.name, scenario] as const))('Reset checklist: %s', (name, scenario) => {
        const draftChecklist = scenario.draftChecklist ?? [];
        let calls: unknown[][] = [];
        if (draftChecklist.length > 0) {
            calls.push(['resetTaskChecklist', 'task-actions']);
            if (scenario.storeResult.success) {
                const result = applyTaskChecklistEdit(draftChecklist, { kind: 'uncheckAll' }, { newId: ids() });
                const next = getChecklistEditStatus({ taskMode: scenario.taskMode, status: scenario.draftStatus, checklist: result!.checklist });
                calls = [...calls, ['setChecklist', result!.checklist], ...(next !== scenario.draftStatus ? [['setDraftField', 'status', next]] : [])];
            } else {
                calls.push(['showToast', 'error', t('common.error'), scenario.storeResult.error]);
            }
        }
        expect(json(calls)).toEqual(fixture.observations.reset[name]);
    });
});

describe('Markdown blocks', () => {
    it('keeps each block\'s first line and the line after it', () => {
        expect(parseMarkdownBlocks('a\nb\n\n- x\n- y\n```\ncode').map(({ type, start, end }) => [type, start, end])).toEqual([
            ['paragraph', 0, 2], ['blank', 2, 3], ['bulletList', 3, 5], ['code', 5, 7],
        ]);
    });
});

describe('checklist edits', () => {
    const list: ChecklistItem[] = [{ id: 'a', title: 'A', isCompleted: false }, { id: 'b', title: 'B', isCompleted: true }];
    it('reorders within range only', () => {
        expect(reorderChecklistItems(list, 0, 1).map((item) => item.id)).toEqual(['b', 'a']);
        expect(reorderChecklistItems(list, 0, 2)).toBe(list);
        expect(reorderChecklistItems(undefined, 0, 1)).toEqual([]);
    });
    it('makes no change where React Native makes none', () => {
        const newId = ids();
        expect(applyTaskChecklistEdit(list, { kind: 'move', from: 0, to: -1 }, { newId })).toBeNull();
        expect(applyTaskChecklistEdit(list, { kind: 'move', from: 1, to: 1 }, { newId })).toBeNull();
        expect(applyTaskChecklistEdit(list, { kind: 'append', title: '  ' }, { newId })).toBeNull();
        expect(applyTaskChecklistEdit(list, { kind: 'rename', index: 5, text: 'a\nb' }, { newId })).toBeNull();
    });
    it('focuses the new empty item', () => {
        expect(applyTaskChecklistEdit(list, { kind: 'add' }, { newId: () => 'new' })).toEqual({
            checklist: [...list, { id: 'new', title: '', isCompleted: false }],
            focusId: 'new',
        });
    });
    it('lets every item finish a list task, except a Reference list, which keeps its status', () => {
        const allDone = list.map((item) => ({ ...item, isCompleted: true }));
        expect(getChecklistEditStatus({ taskMode: 'list', status: 'reference', checklist: allDone })).toBe('reference');
        expect(getChecklistEditStatus({ taskMode: 'list', status: 'someday', checklist: allDone })).toBe('done');
        expect(getChecklistEditStatus({ taskMode: 'list', status: 'waiting', checklist: allDone })).toBe('done');
    });
});


describe('a Reference list ticks like a checklist (#1416)', () => {
    const list: ChecklistItem[] = [{ id: 'a', title: 'Alien', isCompleted: true }, { id: 'b', title: 'Brazil', isCompleted: false }];
    const viewRow = (readOnly: boolean) => buildTaskViewModel({
        task: { status: 'reference', checklist: list }, projects: [], sections: [], areas: [], attachments: [],
        prioritiesEnabled: false, timeEstimatesEnabled: false, showStatusField: false, readOnly,
        t: (key) => key, formatDate: (value) => value, formatDueDate: (value) => value, formatTimeEstimateLabel: (value) => value,
    }).find((row) => row.type === 'checklist');

    it('gives the Form tab field checkboxes, strikes a checked entry and offers Reset', () => {
        const field = buildTaskChecklistFieldModel({ checklist: list, isReference: true, t: (key) => key });
        expect(field).not.toHaveProperty('bullets');
        expect(field.label).toBe('taskEdit.tab.list');
        expect(field.canReset).toBe(true);
        expect(field.items.map((item) => [item.completed, item.struck])).toEqual([[true, true], [false, false]]);
        expect(buildTaskChecklistFieldModel({ checklist: [], isReference: true, t: (key) => key }).canReset).toBe(false);
    });

    it('makes the View tab entries tappable, and a read-only list still names each state', () => {
        const editable = viewRow(false);
        expect(editable).not.toHaveProperty('bullets');
        expect(editable).toMatchObject({ type: 'checklist', tappable: true, add: { label: 'taskEdit.addItem' } });
        const readOnly = viewRow(true);
        expect(readOnly).toMatchObject({ tappable: false, add: null });
        expect(readOnly?.type === 'checklist' && readOnly.items.map((item) => item.accessibilityLabel))
            .toEqual(['Alien. common.done', 'Brazil. status.active']);
    });

    it('keeps pasted - [x] entries checked', () => {
        const result = applyTaskChecklistEdit([{ id: 'a', title: '', isCompleted: false }], { kind: 'rename', index: 0, text: '- [x] Alien\n- [ ] Brazil\n- [x] Casablanca' }, { newId: ids() });
        expect(result?.checklist.map((item) => [item.title, item.isCompleted])).toEqual([['Alien', true], ['Brazil', false], ['Casablanca', true]]);
    });
});

describe('effective reminders in the task View tab', () => {
    it.each([['inherit', 'skip', true], ['inherit', 'send', false], ['send', 'skip', false], ['skip', 'send', true]] as const)(
        'shows suppression for policy %s and default %s: %s', (reminderPolicy, taskReminderDefault, skipped) => {
            const rows = buildTaskViewModel({
                task: { status: 'next', dueDate: '2026-10-15T10:00', reminderPolicy, suppressMindwtrReminders: true },
                settings: { taskReminderDefault }, projects: [], sections: [], areas: [], attachments: [],
                prioritiesEnabled: false, timeEstimatesEnabled: false, showStatusField: false, readOnly: true,
                t: (key) => key, formatDate: (value) => value, formatDueDate: (value) => value, formatTimeEstimateLabel: (value) => value,
            });
            expect(rows.some((row) => row.type === 'field' && row.field === 'reminders')).toBe(skipped);
        },
    );
});
