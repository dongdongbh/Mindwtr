import { describe, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { TaskItem } from '../components/TaskItem';
import { Task } from '@focus-gtd/core';

// Mock store
vi.mock('../store/store', () => ({
    useTaskStore: () => ({
        projects: [],
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
        moveTask: vi.fn(),
    }),
}));

const mockTask: Task = {
    id: '1',
    title: 'Test Task',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
};

describe('Accessibility', () => {
    it('TaskItem should have no violations', async () => {
        const { container } = render(<TaskItem task={mockTask} />);
        const results = await axe(container);
        // @ts-expect-error - vitest-axe types not picked up by tsc
        expect(results).toHaveNoViolations();
    });
});
