import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaskItem } from '../components/TaskItem';
import { Task } from '@focus-gtd/core';

// Mock store
const mocks = vi.hoisted(() => ({
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    moveTask: vi.fn(),
}));

vi.mock('@focus-gtd/core', async () => {
    const actual = await vi.importActual('@focus-gtd/core');
    return {
        ...actual,
        useTaskStore: () => ({
            updateTask: mocks.updateTask,
            deleteTask: mocks.deleteTask,
            moveTask: mocks.moveTask,
            projects: [],
        }),
    };
});

const mockTask: Task = {
    id: '1',
    title: 'Test Task',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
};

describe('TaskItem', () => {
    it('renders task title', () => {
        render(<TaskItem task={mockTask} />);
        expect(screen.getByText('Test Task')).toBeInTheDocument();
    });

    it('enters edit mode on click', () => {
        render(<TaskItem task={mockTask} />);
        fireEvent.click(screen.getByText('Test Task'));
        expect(screen.getByDisplayValue('Test Task')).toBeInTheDocument();
    });

    it('calls moveTask when checkbox is clicked', () => {
        render(<TaskItem task={mockTask} />);
        const checkbox = screen.getByRole('checkbox');
        fireEvent.click(checkbox);
        expect(mocks.moveTask).toHaveBeenCalledWith('1', 'done');
    });
});
