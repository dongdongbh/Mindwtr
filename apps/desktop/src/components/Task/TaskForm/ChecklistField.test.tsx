import { afterEach, describe, it, expect, vi } from 'vitest';
import { createEvent, fireEvent, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useTaskStore, type Task } from '@mindwtr/core';
import { ChecklistField, reorderChecklistItems } from './ChecklistField';

const initialTaskState = useTaskStore.getState();

const initialChecklist: NonNullable<Task['checklist']> = [
    { id: '1', title: 'Item 1', isCompleted: false },
    { id: '2', title: 'Item 2', isCompleted: false },
    { id: '3', title: 'Item 3', isCompleted: false },
];

function ChecklistHarness({
    initial = initialChecklist,
    onUpdateTask,
}: {
    initial?: Task['checklist'];
    onUpdateTask?: (updates: Partial<Task>) => void;
}) {
    const [checklist, setChecklist] = useState<Task['checklist']>(initial);
    return (
        <ChecklistField
            t={(key) => key}
            taskId="task-1"
            checklist={checklist}
            updateTask={(_taskId, updates) => {
                onUpdateTask?.(updates);
                setChecklist(updates.checklist ?? []);
            }}
            resetTaskChecklist={() => setChecklist([])}
        />
    );
}

describe('ChecklistField', () => {
    afterEach(() => {
        useTaskStore.setState(initialTaskState, true);
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
        expect(updates[updates.length - 1]).toEqual({
            checklist: [{ id: '1', title: 'Item 1', isCompleted: false }],
        });
    });

    it('keeps the blank row minted by Enter while focus moves between checklist rows (#1045)', async () => {
        const { getAllByRole } = render(
            <ChecklistHarness initial={[{ id: '1', title: 'Item 1', isCompleted: false }]} />
        );

        const input = getAllByRole('textbox')[0];
        fireEvent.focus(input);
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => {
            expect(getAllByRole('textbox')).toHaveLength(2);
        }, { timeout: 500 });

        fireEvent.blur(getAllByRole('textbox')[0], { relatedTarget: getAllByRole('textbox')[1] });

        expect(getAllByRole('textbox')).toHaveLength(2);
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
            updateTask: () => {},
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
            updateTask: () => {},
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
