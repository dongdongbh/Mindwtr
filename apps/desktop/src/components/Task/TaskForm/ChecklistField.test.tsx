import { describe, it, expect } from 'vitest';
import { createEvent, fireEvent, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { Task } from '@mindwtr/core';
import { ChecklistField } from './ChecklistField';

const initialChecklist: NonNullable<Task['checklist']> = [
    { id: '1', title: 'Item 1', isCompleted: false },
    { id: '2', title: 'Item 2', isCompleted: false },
    { id: '3', title: 'Item 3', isCompleted: false },
];

function ChecklistHarness() {
    const [checklist, setChecklist] = useState<Task['checklist']>(initialChecklist);
    return (
        <ChecklistField
            t={(key) => key}
            taskId="task-1"
            checklist={checklist}
            updateTask={(_taskId, updates) => setChecklist(updates.checklist ?? [])}
            resetTaskChecklist={() => setChecklist([])}
        />
    );
}

describe('ChecklistField', () => {
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
});
