import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { useTaskStore, type Task } from '@mindwtr/core';
import { ChecklistField, reorderChecklistItems } from './ChecklistField';
import { useUiStore } from '../../../store/ui-store';
import { holdSyncSave } from '../../../test/hold-sync-save';

const initialTaskState = useTaskStore.getState();
const initialUiState = useUiStore.getState();

const initialChecklist: NonNullable<Task['checklist']> = [
    { id: '1', title: 'Item 1', isCompleted: false },
    { id: '2', title: 'Item 2', isCompleted: false },
    { id: '3', title: 'Item 3', isCompleted: false },
];

const AT = new Date(Date.now() - 60_000).toISOString();
const storedTask = (checklist: Task['checklist'], extra: Partial<Task> = {}): Task => ({
    id: 'task-1', title: 'Task', status: 'next', tags: [], contexts: [], checklist, rev: 1, createdAt: AT, updatedAt: AT, ...extra,
} as Task);
const seedChecklist = (checklist: Task['checklist']) => useTaskStore.setState({ _allTasks: [storedTask(checklist)] });

/** Reports each checklist the field writes to the store for task-1. */
const onStoredChecklist = (report: (updates: Partial<Task>) => void) => useTaskStore.subscribe((state, previous) => {
    const next = state._tasksById.get('task-1')?.checklist;
    if (next !== previous._tasksById.get('task-1')?.checklist) report({ checklist: next });
});

function ChecklistHarness({
    initial = initialChecklist,
    onUpdateTask,
    plainList = false,
}: {
    initial?: Task['checklist'];
    onUpdateTask?: (updates: Partial<Task>) => void;
    plainList?: boolean;
}) {
    useState(() => seedChecklist(initial));
    const checklist = useTaskStore((state) => state._tasksById.get('task-1')?.checklist);
    useEffect(() => onStoredChecklist((updates) => onUpdateTask?.(updates)), []);
    return (
        <ChecklistField
            t={(key) => key}
            taskId="task-1"
            checklist={checklist}
            plainList={plainList}
            resetTaskChecklist={() => seedChecklist([])}
        />
    );
}

describe('ChecklistField', () => {
    let unsubscribe: (() => void) | undefined;
    afterEach(() => {
        unsubscribe?.();
        unsubscribe = undefined;
        useTaskStore.setState(initialTaskState, true);
        useUiStore.setState(initialUiState, true);
    });

    it('reorders checklist items without changing completion state', () => {
        const reordered = reorderChecklistItems(
            [
                { id: 'first', title: 'First', isCompleted: false },
                { id: 'second', title: 'Second', isCompleted: true },
                { id: 'third', title: 'Third', isCompleted: false },
            ],
            'third',
            'first',
        );

        expect(reordered?.map((item) => item.id)).toEqual(['third', 'first', 'second']);
        expect(reordered?.map((item) => item.isCompleted)).toEqual([false, false, true]);
    });

    it('never touches the description when checklist completion changes', () => {
        const updates: Partial<Task>[] = [];
        const { getByRole } = render(
            <ChecklistHarness onUpdateTask={(next) => updates.push(next)} />
        );

        fireEvent.click(getByRole('button', { name: 'taskEdit.checklist 1' }));

        expect(updates[updates.length - 1]).toEqual({
            checklist: [
                { id: '1', title: 'Item 1', isCompleted: true },
                { id: '2', title: 'Item 2', isCompleted: false },
                { id: '3', title: 'Item 3', isCompleted: false },
            ],
        });
    });

    it('merges the field\'s change onto the list a sync save published since the field opened, keeping the synced item', async () => {
        render(<ChecklistHarness initial={[{ id: 'c1', title: 'One', isCompleted: false }]} />);
        const finish = holdSyncSave(() => useTaskStore.setState({ _allTasks: [storedTask(
            [{ id: 'c1', title: 'One', isCompleted: false }, { id: 'c2', title: 'Two', isCompleted: false }],
            { rev: 3 },
        )] }));
        fireEvent.click(screen.getByRole('button', { name: 'taskEdit.checklist 1' }));
        await act(finish);

        await waitFor(() => expect(useTaskStore.getState()._tasksById.get('task-1')?.checklist?.map((item) => [item.id, item.isCompleted]))
            .toEqual([['c1', true], ['c2', false]]));
        expect(useUiStore.getState().toasts.map((toast) => toast.message)).not.toContainEqual(expect.stringMatching(/^STALE_REVISION/));
    });

    it('edits a reference list without completion controls and preserves item metadata', () => {
        const updates: Partial<Task>[] = [];
        const resetTaskChecklist = vi.fn();
        const referenceItems: NonNullable<Task['checklist']> = [
            { id: 'done', title: 'Completed source item', isCompleted: true },
            { id: 'pending', title: 'Pending source item', isCompleted: false },
        ];
        seedChecklist(referenceItems);
        unsubscribe = onStoredChecklist((update) => updates.push(update));
        const props = {
            t: (key: string) => key,
            taskId: 'task-1',
            checklist: referenceItems,
            resetTaskChecklist,
        };
        const { getAllByRole, getByRole, getByText, queryByRole, queryByText, rerender } = render(
            <div>
                <ChecklistField {...props} />
                <button type="button">outside</button>
            </div>
        );

        fireEvent.change(getAllByRole('textbox')[0], { target: { value: 'Edited source item' } });
        rerender(
            <div>
                <ChecklistField {...props} plainList />
                <button type="button">outside</button>
            </div>
        );

        expect(getByText('taskEdit.tab.list')).toBeInTheDocument();
        expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('Edited source item');
        expect(queryByRole('button', { name: 'taskEdit.checklist 1' })).not.toBeInTheDocument();
        expect(queryByText('taskEdit.resetChecklist')).not.toBeInTheDocument();
        expect(getAllByRole('textbox')[0]).not.toHaveClass('line-through');

        fireEvent.blur(getAllByRole('textbox')[0], { relatedTarget: getByRole('button', { name: 'outside' }) });

        expect(updates).toEqual([{
            checklist: [
                { id: 'done', title: 'Edited source item', isCompleted: true },
                { id: 'pending', title: 'Pending source item', isCompleted: false },
            ],
        }]);
        expect(resetTaskChecklist).not.toHaveBeenCalled();
    });

    it('renders desktop drag handles only when checklist order can change', () => {
        const multiItem = render(<ChecklistHarness />);
        expect(multiItem.getAllByLabelText('Drag checklist item')).toHaveLength(3);

        multiItem.unmount();

        const singleItem = render(<ChecklistHarness initial={[initialChecklist[0]]} />);
        expect(singleItem.queryByLabelText('Drag checklist item')).not.toBeInTheDocument();
    });

    it('wraps selected checklist text with Markdown character pairs', async () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(0, input.value.length);
        fireEvent.select(input);

        const pairEvent = createEvent.keyDown(input, { key: '[', cancelable: true });
        fireEvent(input, pairEvent);

        expect(pairEvent.defaultPrevented).toBe(true);
        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('[Item 1]');
        });
    });

    it('types a literal "(" with no auto-close when typing help is disabled (#742)', async () => {
        useTaskStore.setState({ settings: { ...initialTaskState.settings, markdownEditorAssist: false } });
        const { getAllByRole } = render(<ChecklistHarness initial={[{ id: '1', title: '', isCompleted: false }]} />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        fireEvent.change(input, { target: { value: '(' } });

        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('(');
        });
    });

    it('keeps repeated checklist backticks on the selected text when the input selection briefly collapses', async () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(0, input.value.length);
        fireEvent.select(input);
        fireEvent.keyDown(input, { key: '`' });

        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('`Item 1`');
        });

        const onceInput = getAllByRole('textbox')[0] as HTMLInputElement;
        onceInput.setSelectionRange(onceInput.value.length, onceInput.value.length);
        fireEvent.keyDown(onceInput, { key: '`' });

        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('``Item 1``');
        });
    });

    it('applies Markdown bold and italic shortcuts inside checklist items', async () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(0, input.value.length);
        fireEvent.select(input);

        const boldEvent = createEvent.keyDown(input, { key: 'b', ctrlKey: true, cancelable: true });
        fireEvent(input, boldEvent);

        expect(boldEvent.defaultPrevented).toBe(true);
        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('**Item 1**');
        });

        const updatedInput = getAllByRole('textbox')[0] as HTMLInputElement;
        updatedInput.setSelectionRange(2, updatedInput.value.length - 2);
        fireEvent.select(updatedInput);

        const italicEvent = createEvent.keyDown(updatedInput, { key: 'i', metaKey: true, cancelable: true });
        fireEvent(updatedInput, italicEvent);

        expect(italicEvent.defaultPrevented).toBe(true);
        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('***Item 1***');
        });
    });

    it('keeps native selected-text replacements paired in checklist items', async () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(0, input.value.length);
        fireEvent.select(input);

        fireEvent.change(input, { target: { value: '`' } });

        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('`Item 1`');
        });
    });

    it('keeps Tab and Shift+Tab navigation working after inserting with Enter', async () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const initialInputs = getAllByRole('textbox');
        fireEvent.focus(initialInputs[1]);
        fireEvent.keyDown(initialInputs[1], { key: 'Enter' });

        await waitFor(() => {
            expect(getAllByRole('textbox')).toHaveLength(4);
        }, { timeout: 500 });

        const afterInsert = getAllByRole('textbox');
        const tabEvent = createEvent.keyDown(afterInsert[2], { key: 'Tab', cancelable: true });
        fireEvent(afterInsert[2], tabEvent);
        expect(tabEvent.defaultPrevented).toBe(true);

        const shiftTabEvent = createEvent.keyDown(getAllByRole('textbox')[3], {
            key: 'Tab',
            shiftKey: true,
            cancelable: true,
        });
        fireEvent(getAllByRole('textbox')[3], shiftTabEvent);
        expect(shiftTabEvent.defaultPrevented).toBe(true);
    });

    it('drops blank checklist rows when focus leaves the checklist (#1045)', async () => {
        const updates: Partial<Task>[] = [];
        const { getAllByRole, getByRole } = render(
            <div>
                <ChecklistHarness
                    initial={[{ id: '1', title: 'Item 1', isCompleted: false }]}
                    onUpdateTask={(next) => updates.push(next)}
                />
                <button type="button">outside</button>
            </div>
        );

        const input = getAllByRole('textbox')[0];
        fireEvent.focus(input);
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => {
            expect(getAllByRole('textbox')).toHaveLength(2);
        }, { timeout: 500 });

        const blankInput = getAllByRole('textbox')[1];
        fireEvent.blur(blankInput, { relatedTarget: getByRole('button', { name: 'outside' }) });

        await waitFor(() => {
            expect(getAllByRole('textbox')).toHaveLength(1);
        }, { timeout: 500 });
        expect(updates).toEqual([]);
    });

    it('keeps the blank row minted by Enter while focus moves between checklist rows (#1045)', async () => {
        const updates: Partial<Task>[] = [];
        const { getAllByRole } = render(
            <ChecklistHarness
                initial={[{ id: '1', title: 'Item 1', isCompleted: false }]}
                onUpdateTask={(next) => updates.push(next)}
            />
        );

        const input = getAllByRole('textbox')[0];
        fireEvent.focus(input);
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => {
            expect(getAllByRole('textbox')).toHaveLength(2);
        }, { timeout: 500 });

        fireEvent.blur(getAllByRole('textbox')[0], { relatedTarget: getAllByRole('textbox')[1] });

        expect(getAllByRole('textbox')).toHaveLength(2);
        expect(updates).toEqual([]);
    });

    it('commits a newly titled checklist row once when focus leaves the checklist', async () => {
        const updates: Partial<Task>[] = [];
        const { getAllByRole, getByRole } = render(
            <div>
                <ChecklistHarness
                    initial={[{ id: '1', title: 'Item 1', isCompleted: false }]}
                    onUpdateTask={(next) => updates.push(next)}
                />
                <button type="button">outside</button>
            </div>
        );

        const input = getAllByRole('textbox')[0];
        fireEvent.focus(input);
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => {
            expect(getAllByRole('textbox')).toHaveLength(2);
        }, { timeout: 500 });

        const newInput = getAllByRole('textbox')[1];
        fireEvent.change(newInput, { target: { value: 'Item 2' } });
        fireEvent.blur(newInput, { relatedTarget: getByRole('button', { name: 'outside' }) });

        expect(updates).toHaveLength(1);
        expect(updates[0]?.checklist?.map((item) => item.title)).toEqual(['Item 1', 'Item 2']);
    });

    it('focuses inserted checklist items without scrolling the editor container', async () => {
        const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(() => {});
        try {
            const { getByRole } = render(<ChecklistHarness />);

            fireEvent.click(getByRole('button', { name: /taskEdit.addItem/i }));

            await waitFor(() => {
                expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
            }, { timeout: 500 });
        } finally {
            focusSpy.mockRestore();
        }
    });

    it('splits multi-line pasted text into separate checklist items', () => {
        const updates: Partial<Task>[] = [];
        const { getAllByRole } = render(<ChecklistHarness onUpdateTask={(next) => updates.push(next)} />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(0, input.value.length);
        fireEvent.paste(input, {
            clipboardData: { getData: () => 'buy milk\nbuy bread\n- [x] call mom' },
        });

        const titles = (getAllByRole('textbox') as HTMLInputElement[]).map((node) => node.value);
        expect(titles).toEqual(['buy milk', 'buy bread', 'call mom', 'Item 2', 'Item 3']);

        const committed = updates[updates.length - 1]?.checklist;
        expect(committed?.map((item) => item.title)).toEqual(['buy milk', 'buy bread', 'call mom', 'Item 2', 'Item 3']);
        expect(committed?.[0]?.id).toBe('1');
        expect(committed?.[2]?.isCompleted).toBe(true);
    });

    it('strips pasted checklist markers in a reference list without changing hidden completion state', () => {
        const updates: Partial<Task>[] = [];
        const initial: NonNullable<Task['checklist']> = [
            { id: 'existing-open', title: 'Replace me', isCompleted: false },
            { id: 'existing-done', title: 'Keep completed', isCompleted: true },
        ];
        const renderField = (plainList: boolean) => (
            <ChecklistHarness
                initial={initial}
                plainList={plainList}
                onUpdateTask={(next) => updates.push(next)}
            />
        );
        const { getAllByRole, queryByRole, rerender } = render(renderField(true));

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(0, input.value.length);
        fireEvent.paste(input, {
            clipboardData: {
                getData: () => '- [x] Imported checked\n- [ ] Imported open\n[x] Also checked',
            },
        });

        const committed = updates[updates.length - 1]?.checklist;
        expect(committed?.map((item) => item.title)).toEqual([
            'Imported checked',
            'Imported open',
            'Also checked',
            'Keep completed',
        ]);
        expect(committed?.map((item) => item.isCompleted)).toEqual([false, false, false, true]);
        expect(committed?.[0]?.id).toBe('existing-open');

        rerender(renderField(false));
        expect(getAllByRole('button', { name: /^taskEdit\.checklist \d$/ })).toHaveLength(4);
        rerender(renderField(true));
        expect(queryByRole('button', { name: /^taskEdit\.checklist \d$/ })).not.toBeInTheDocument();
        expect(updates).toHaveLength(1);
    });

    it('inserts pasted lines at the cursor position within the current item title', () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.paste(input, {
            clipboardData: { getData: () => ' extended\nsecond line' },
        });

        const titles = (getAllByRole('textbox') as HTMLInputElement[]).map((node) => node.value);
        expect(titles).toEqual(['Item 1 extended', 'second line', 'Item 2', 'Item 3']);
    });

    it('leaves single-line pastes to the native input behavior', () => {
        const updates: Partial<Task>[] = [];
        const { getAllByRole } = render(<ChecklistHarness onUpdateTask={(next) => updates.push(next)} />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        fireEvent.paste(input, {
            clipboardData: { getData: () => 'just one line' },
        });

        expect(updates).toHaveLength(0);
        expect(getAllByRole('textbox')).toHaveLength(3);
    });

    it('keeps in-progress checklist typing when the checklist prop refreshes with a new identity', () => {
        const props = {
            t: (key: string) => key,
            taskId: 'task-1',
            checklist: initialChecklist,
            resetTaskChecklist: () => {},
        };
        const { getAllByRole, rerender } = render(<ChecklistField {...props} />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'Item 1 edited' } });
        expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('Item 1 edited');

        // Simulate a background store refresh (e.g. after sync) delivering an
        // equal checklist with fresh object identity while the user is typing.
        rerender(<ChecklistField {...props} checklist={initialChecklist.map((item) => ({ ...item }))} />);

        expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('Item 1 edited');
    });

    it('resets the checklist draft when switching to another task', () => {
        const props = {
            t: (key: string) => key,
            taskId: 'task-1',
            checklist: initialChecklist,
            resetTaskChecklist: () => {},
        };
        const { getAllByRole, rerender } = render(<ChecklistField {...props} />);

        fireEvent.change(getAllByRole('textbox')[0], { target: { value: 'Item 1 edited' } });

        rerender(
            <ChecklistField
                {...props}
                taskId="task-2"
                checklist={[{ id: '9', title: 'Other task item', isCompleted: false }]}
            />
        );

        expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('Other task item');
    });

    it('keeps the add-item click from blurring the current editor control first', () => {
        const { getByRole } = render(<ChecklistHarness />);
        const addButton = getByRole('button', { name: /taskEdit.addItem/i });
        const mouseDown = createEvent.mouseDown(addButton, { cancelable: true });

        fireEvent(addButton, mouseDown);

        expect(mouseDown.defaultPrevented).toBe(true);
    });
});
