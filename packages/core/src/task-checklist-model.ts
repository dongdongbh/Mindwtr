import { parsePastedChecklistItems } from './markdown';
import type { ChecklistItem, Task, TaskStatus } from './types';

/**
 * The task editor's checklist, as the React Native editor edits it: the Form
 * tab's checklist field and the View tab's ticks and add input. Every edit
 * changes the editor's unsaved checklist; the editor saves it with the rest of
 * the task. Item IDs stay as they are; new items get a new ID.
 */

export type TaskChecklistEdit =
    /** The Form tab's checkbox and the View tab's tick: the item at this position (item IDs can repeat). */
    | { kind: 'toggle'; index: number }
    /** An item's text as typed. Text with line breaks becomes one item per line (a paste). */
    | { kind: 'rename'; index: number; text: string }
    /**
     * Return on an item: an empty item after it. On an empty item it only ends editing.
     * `text`: the item's text as typed, when the input is ahead of the checklist.
     */
    | { kind: 'insertAfter'; index: number; text?: string }
    | { kind: 'remove'; index: number }
    /** "+ Add item": an empty item at the end, unless an item is empty already. */
    | { kind: 'add' }
    /** Reorder mode's Move up (to = from - 1) and Move down (to = from + 1). */
    | { kind: 'move'; from: number; to: number }
    /** The View tab's add input on submit. Blank text only ends editing. */
    | { kind: 'append'; title: string }
    /** After Reset checklist has reset the saved task: every item open. */
    | { kind: 'uncheckAll' };

export type TaskChecklistEditResult = {
    checklist: ChecklistItem[];
    /** The new empty item, to focus. */
    focusId: string | null;
};

/** The React Native editor's reorder: the item at `fromIndex` moves to `toIndex`; out of range changes nothing. */
export function reorderChecklistItems(checklist: Task['checklist'], fromIndex: number, toIndex: number): ChecklistItem[] {
    const items = checklist || [];
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) return items;
    const next = [...items];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return items;
    next.splice(toIndex, 0, moved);
    return next;
}

/**
 * The checklist after one edit, as the React Native editor makes it; null when it
 * makes no change (it then ends editing, or does nothing). A Reference list edits
 * like a checklist: pasted `- [x]` lines stay checked.
 */
export function applyTaskChecklistEdit(
    checklist: Task['checklist'],
    edit: TaskChecklistEdit,
    options: { newId: () => string },
): TaskChecklistEditResult | null {
    const list = checklist || [];
    const done = (next: ChecklistItem[], focusId: string | null = null) => ({ checklist: next, focusId });
    const emptyItem = (): ChecklistItem => ({ id: options.newId(), title: '', isCompleted: false });
    switch (edit.kind) {
        case 'toggle':
            return done(list.map((entry, index) => (index === edit.index ? { ...entry, isCompleted: !entry.isCompleted } : entry)));
        case 'rename': {
            if (!/[\r\n]/.test(edit.text)) {
                return done(list.map((entry, index) => (index === edit.index ? { ...entry, title: edit.text } : entry)));
            }
            // A paste: the first line renames this item, the rest follow it.
            const [first, ...rest] = parsePastedChecklistItems(edit.text);
            const current = list[edit.index];
            if (!current) return null;
            const updated = {
                ...current,
                title: first?.title ?? '',
                isCompleted: current.isCompleted || (first?.isCompleted ?? false),
            };
            const inserted = rest.map((item) => ({ id: options.newId(), title: item.title, isCompleted: item.isCompleted }));
            return done([...list.slice(0, edit.index), updated, ...inserted, ...list.slice(edit.index + 1)]);
        }
        case 'insertAfter': {
            const current = list[edit.index];
            if (!current || !(edit.text ?? current.title).trim()) return null;
            const item = emptyItem();
            return done([...list.slice(0, edit.index + 1), item, ...list.slice(edit.index + 1)], item.id);
        }
        case 'remove':
            return done(list.filter((_, index) => index !== edit.index));
        case 'add': {
            if (list.some((item) => item.title.trim().length === 0)) return null;
            const item = emptyItem();
            return done([...list, item], item.id);
        }
        case 'move':
            if (edit.from === edit.to || edit.to < 0) return null;
            return done(reorderChecklistItems(list, edit.from, edit.to));
        case 'append': {
            const title = edit.title.trim();
            if (!title) return null;
            return done([...list, { id: options.newId(), title, isCompleted: false }]);
        }
        case 'uncheckAll':
            return done(list.map((item) => ({ ...item, isCompleted: false })));
        default:
            return null;
    }
}

/**
 * The draft status after a checklist edit. A list task (taskMode 'list') is Done
 * once every item is; an open item takes a Done list task back to Next. Other
 * tasks keep their status, and so does a Reference: its items tick like a
 * checklist, but the reference itself never completes (#1416).
 */
export function getChecklistEditStatus(input: {
    taskMode: Task['taskMode'];
    status: TaskStatus;
    checklist: readonly ChecklistItem[];
}): TaskStatus {
    if (input.taskMode !== 'list' || input.status === 'reference') return input.status;
    if (input.checklist.length > 0 && input.checklist.every((item) => item.isCompleted)) return 'done';
    return input.status === 'done' ? 'next' : input.status;
}

export type TaskChecklistFieldItem = {
    index: number;
    id: string;
    title: string;
    completed: boolean;
    /** A completed item is struck and muted (a reference list too). */
    struck: boolean;
    /** The checkbox's name: the title, or the placeholder when blank. */
    checkboxLabel: string;
    /** The text input's name: "Checklist 2". */
    inputLabel: string;
    /** Reorder mode's row text and its buttons' names. */
    orderTitle: string;
    moveUpLabel: string;
    moveDownLabel: string;
    canMoveUp: boolean;
    canMoveDown: boolean;
};

export type TaskChecklistFieldModel = {
    /** "Checklist", or "List" for a reference. */
    label: string;
    /** The Reorder toggle shows with two items or more. */
    canReorder: boolean;
    /** "+ Add item" adds nothing while an item is empty. */
    canAdd: boolean;
    /** Reset checklist shows under a list with items (a reference list too). */
    canReset: boolean;
    labels: { reorder: string; done: string; add: string; reset: string; placeholder: string };
    items: TaskChecklistFieldItem[];
};

/** The Form tab's checklist field for the editor's checklist. */
export function buildTaskChecklistFieldModel(input: {
    checklist: Task['checklist'];
    isReference: boolean;
    t: (key: string) => string;
}): TaskChecklistFieldModel {
    const { t, isReference } = input;
    const items = input.checklist || [];
    const label = t(isReference ? 'taskEdit.tab.list' : 'taskEdit.checklist');
    const placeholder = t('taskEdit.itemNamePlaceholder');
    return {
        label,
        canReorder: items.length > 1,
        canAdd: !items.some((item) => item.title.trim().length === 0),
        canReset: items.length > 0,
        labels: {
            reorder: t('projects.reorderTasks'),
            done: t('common.done'),
            add: t('taskEdit.addItem'),
            reset: t('taskEdit.resetChecklist'),
            placeholder,
        },
        items: items.map((item, index) => {
            const orderTitle = item.title.trim() || placeholder;
            return {
                index,
                id: item.id,
                title: item.title,
                completed: item.isCompleted,
                struck: item.isCompleted,
                checkboxLabel: orderTitle,
                inputLabel: `${label} ${index + 1}`,
                orderTitle,
                moveUpLabel: `${t('projects.moveUp')}: ${orderTitle}`,
                moveDownLabel: `${t('projects.moveDown')}: ${orderTitle}`,
                canMoveUp: index > 0,
                canMoveDown: index < items.length - 1,
            };
        }),
    };
}
