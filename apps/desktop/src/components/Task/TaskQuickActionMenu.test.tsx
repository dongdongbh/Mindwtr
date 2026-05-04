import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Task } from '@mindwtr/core';

import { TaskQuickActionMenu } from './TaskQuickActionMenu';

const now = '2026-02-01T00:00:00.000Z';

const task: Task = {
    id: 'task-1',
    title: 'Task',
    status: 'next',
    contexts: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
};

const t = (key: string) => ({
    'areas.create': 'Create area',
    'areas.search': 'Search areas',
    'common.cancel': 'Cancel',
    'common.clear': 'Clear',
    'common.delete': 'Delete',
    'common.noMatches': 'No matches',
    'common.save': 'Save',
    'projects.duplicate': 'Duplicate',
    'task.aria.dueTime': 'Due time',
    'task.aria.reviewTime': 'Review time',
    'taskEdit.areaLabel': 'Area',
    'taskEdit.contextsLabel': 'Contexts',
    'taskEdit.dueDateLabel': 'Due Date',
    'taskEdit.moreOptions': 'More options',
    'taskEdit.noAreaOption': 'No Area',
    'taskEdit.reviewDateLabel': 'Review Date',
}[key] ?? key);

const renderMenu = (overrides: Partial<ComponentProps<typeof TaskQuickActionMenu>> = {}) => {
    const props: ComponentProps<typeof TaskQuickActionMenu> = {
        task,
        x: 16,
        y: 16,
        t,
        nativeDateInputLocale: 'en-US',
        contextOptions: [],
        areas: [],
        readOnly: false,
        onClose: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        onCreateArea: vi.fn(async () => null),
        onUpdateTask: vi.fn(async () => ({ success: true })),
        ...overrides,
    };
    render(<TaskQuickActionMenu {...props} />);
    return props;
};

describe('TaskQuickActionMenu', () => {
    it('opens one panel at a time and exposes dialog state without pressed state', () => {
        renderMenu();

        const dueButton = screen.getByRole('menuitem', { name: /due date/i });
        expect(dueButton).toHaveAttribute('aria-haspopup', 'dialog');
        expect(dueButton).toHaveAttribute('aria-expanded', 'false');
        expect(dueButton).not.toHaveAttribute('aria-pressed');

        fireEvent.click(dueButton);

        expect(dueButton).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('dialog', { name: /due date/i })).toBeInTheDocument();

        const reviewButton = screen.getByRole('menuitem', { name: /review date/i });
        fireEvent.click(reviewButton);

        expect(dueButton).toHaveAttribute('aria-expanded', 'false');
        expect(reviewButton).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('dialog', { name: /review date/i })).toBeInTheDocument();
    });

    it('uses Escape to close the active panel before closing the menu', () => {
        const props = renderMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: /due date/i }));

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: /due date/i })).not.toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });
});
