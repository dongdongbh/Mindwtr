import { act, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '@mindwtr/core';

import { ProjectSelector } from './ProjectSelector';

const projects: Project[] = [
    { id: 'p1', title: 'Alpha', status: 'active', color: '#3b82f6', order: 0, tagIds: [], createdAt: '', updatedAt: '' },
    { id: 'p2', title: 'Work Project', status: 'active', color: '#10b981', order: 1, tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' },
];
const originalInnerHeight = window.innerHeight;
let restoreGeometryMock: (() => void) | undefined;

/**
 * Simulate typing into a controlled React input under bun + JSDOM.
 * React 19 intercepts the value property descriptor to track changes;
 * we must call the *native* setter so React sees a new value, then
 * dispatch an `input` event inside `act()` so the state update flushes.
 */
function setInputValue(input: HTMLInputElement, value: string) {
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(input));
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    act(() => {
        if (nativeSetter) {
            nativeSetter.call(input, value);
        } else {
            (input as any).value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

function mockSelectorGeometry({
    dropdownHeight,
    triggerBottom,
    triggerTop,
    viewportHeight,
}: {
    dropdownHeight: number;
    triggerBottom: number;
    triggerTop: number;
    viewportHeight: number;
}) {
    Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: viewportHeight,
    });
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        if (this instanceof HTMLElement && this.classList.contains('relative')) {
            return {
                bottom: triggerBottom,
                height: triggerBottom - triggerTop,
                left: 0,
                right: 320,
                top: triggerTop,
                width: 320,
                x: 0,
                y: triggerTop,
                toJSON: () => ({}),
            } as DOMRect;
        }
        if (this instanceof HTMLElement && this.dataset.selectorDropdown === 'true') {
            return {
                bottom: triggerBottom + dropdownHeight,
                height: dropdownHeight,
                left: 0,
                right: 320,
                top: triggerBottom,
                width: 320,
                x: 0,
                y: triggerBottom,
                toJSON: () => ({}),
            } as DOMRect;
        }
        return new DOMRect();
    });
    restoreGeometryMock = () => spy.mockRestore();
}

afterEach(() => {
    restoreGeometryMock?.();
    restoreGeometryMock = undefined;
    Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
    });
});

describe('ProjectSelector', () => {
    it('offers a distinct leading Keep choice alongside No project', () => {
        const onChange = vi.fn();
        const { getByRole } = render(
            <ProjectSelector
                projects={projects}
                value="__KEEP__"
                onChange={onChange}
                leadingOption={{ value: '__KEEP__', label: 'Keep project' }}
                noProjectValue="__NONE__"
                noProjectLabel="No project"
                ariaLabel="Project"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Project' }));

        expect(getByRole('option', { name: 'Keep project' })).toHaveAttribute('aria-selected', 'true');
        fireEvent.click(getByRole('option', { name: 'No project' }));
        expect(onChange).toHaveBeenCalledWith('__NONE__');
    });

    it('hides archived and legacy completed projects from the selectable options', () => {
        const inactiveProjects: Project[] = [
            ...projects,
            { id: 'p3', title: 'Archived Project', status: 'archived', color: '#64748b', order: 2, tagIds: [], createdAt: '', updatedAt: '' },
            { id: 'p4', title: 'Completed Project', status: 'completed' as Project['status'], color: '#64748b', order: 3, tagIds: [], createdAt: '', updatedAt: '' },
        ];

        const { getByRole, queryByRole } = render(
            <ProjectSelector
                projects={inactiveProjects}
                value=""
                onChange={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select project' }));

        expect(getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
        expect(queryByRole('option', { name: 'Archived Project' })).not.toBeInTheDocument();
        expect(queryByRole('option', { name: 'Completed Project' })).not.toBeInTheDocument();
    });

    it('renders the dropdown above nearby panels', () => {
        const { getByRole } = render(
            <ProjectSelector
                projects={projects}
                value=""
                onChange={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select project' }));

        const dropdown = getByRole('listbox', { name: 'Select project' }).closest('[data-selector-dropdown="true"]');
        expect(dropdown).toHaveClass('z-[70]');
        expect(dropdown?.parentElement).toBe(document.body);
        expect(dropdown).toHaveStyle({ position: 'fixed' });
    });

    it('keeps the menu below the selector when compact vertical space is available', async () => {
        mockSelectorGeometry({
            dropdownHeight: 260,
            triggerBottom: 280,
            triggerTop: 250,
            viewportHeight: 520,
        });
        const { getByRole } = render(
            <ProjectSelector
                projects={projects}
                value=""
                onChange={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select project' }));

        const listbox = getByRole('listbox', { name: 'Select project' });
        const dropdown = listbox.closest('[data-selector-dropdown="true"]');
        await waitFor(() => {
            expect(listbox.querySelector('[style*="max-height"]')).toHaveStyle({ maxHeight: '148px' });
            expect(dropdown).toHaveStyle({
                position: 'fixed',
                top: '284px',
                bottom: 'auto',
                left: '0px',
                width: '320px',
            });
        });
    });

    it('opens above only when the minimum usable menu cannot fit below', async () => {
        mockSelectorGeometry({
            dropdownHeight: 260,
            triggerBottom: 300,
            triggerTop: 260,
            viewportHeight: 420,
        });
        const { getByRole } = render(
            <ProjectSelector
                projects={projects}
                value=""
                onChange={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select project' }));

        const listbox = getByRole('listbox', { name: 'Select project' });
        const dropdown = listbox.closest('[data-selector-dropdown="true"]');
        await waitFor(() => {
            expect(listbox.querySelector('[style*="max-height"]')).toHaveStyle({ maxHeight: '168px' });
            expect(dropdown).toHaveStyle({
                position: 'fixed',
                top: 'auto',
                bottom: '164px',
                left: '0px',
                width: '320px',
            });
        });
    });

    it('suppresses create when an exact match exists outside the filtered list', () => {
        const { getByRole, getByLabelText, queryByText } = render(
            <ProjectSelector
                projects={[projects[0]]}
                allProjects={projects}
                value=""
                onChange={vi.fn()}
                onCreateProject={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
                createProjectLabel="Create project"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select project' }));
        setInputValue(getByLabelText('Search projects') as HTMLInputElement, 'Work Project');

        expect(queryByText(/Create project/i)).not.toBeInTheDocument();
    });

    it('searches every selectable project while the browse list stays area-scoped (#987)', () => {
        const archivedElsewhere: Project = {
            id: 'p3', title: 'Archived Elsewhere', status: 'archived', color: '#64748b', order: 2, tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '',
        };
        const { getByRole, getByLabelText, queryByRole } = render(
            <ProjectSelector
                projects={[projects[0]]}
                allProjects={[...projects, archivedElsewhere]}
                value=""
                onChange={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select project' }));

        expect(getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
        expect(queryByRole('option', { name: 'Work Project' })).not.toBeInTheDocument();

        const input = getByLabelText('Search projects') as HTMLInputElement;
        setInputValue(input, 'Work');
        expect(getByRole('option', { name: 'Work Project' })).toBeInTheDocument();

        setInputValue(input, 'Archived');
        expect(queryByRole('option', { name: 'Archived Elsewhere' })).not.toBeInTheDocument();

        setInputValue(input, '');
        expect(queryByRole('option', { name: 'Work Project' })).not.toBeInTheDocument();
    });

    it('selects the first matching project from the search input with Enter', () => {
        const onChange = vi.fn();
        const { getByRole, getByLabelText } = render(
            <ProjectSelector
                projects={projects}
                value=""
                onChange={onChange}
                onCreateProject={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
                createProjectLabel="Create project"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select project' }));
        const input = getByLabelText('Search projects') as HTMLInputElement;
        setInputValue(input, 'Work');
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(onChange).toHaveBeenCalledWith('p2');
    });

    it('moves from typed search to the first matching project with ArrowDown', () => {
        const { getByRole, getByLabelText } = render(
            <ProjectSelector
                projects={projects}
                value=""
                onChange={vi.fn()}
                onCreateProject={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
                createProjectLabel="Create project"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select project' }));
        const input = getByLabelText('Search projects') as HTMLInputElement;
        setInputValue(input, 'Work');
        fireEvent.keyDown(input, { key: 'ArrowDown' });

        expect(getByRole('option', { name: 'Work Project' })).toHaveFocus();
    });

    it('keeps matching project results reachable in the tab order', async () => {
        const user = userEvent.setup();
        const { getByRole, getByLabelText } = render(
            <ProjectSelector
                projects={projects}
                value=""
                onChange={vi.fn()}
                onCreateProject={vi.fn()}
                placeholder="Select project"
                noProjectLabel="No project"
                searchPlaceholder="Search projects"
                createProjectLabel="Create project"
            />
        );

        await user.click(getByRole('button', { name: 'Select project' }));
        setInputValue(getByLabelText('Search projects') as HTMLInputElement, 'Work');

        await user.tab();
        expect(getByRole('option', { name: 'No project' })).toHaveFocus();
        await user.tab();
        expect(getByRole('option', { name: 'Create project "Work"' })).toHaveFocus();
        await user.tab();
        expect(getByRole('option', { name: 'Work Project' })).toHaveFocus();
    });

    it('prefers the empty label and falls back to the no-matches label', () => {
        const first = render(
            <ProjectSelector
                projects={[]}
                allProjects={projects}
                value=""
                onChange={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
                noMatchesLabel="No matches"
                emptyLabel="No projects in this area."
            />
        );

        fireEvent.click(first.getByRole('button', { name: 'Select project' }));
        first.getByText('No projects in this area.');
        first.unmount();

        const second = render(
            <ProjectSelector
                projects={[]}
                allProjects={projects}
                value=""
                onChange={vi.fn()}
                placeholder="Select project"
                searchPlaceholder="Search projects"
                noMatchesLabel="No matches"
            />
        );

        fireEvent.click(second.getByRole('button', { name: 'Select project' }));
        second.getByText('No matches');
    });
});
