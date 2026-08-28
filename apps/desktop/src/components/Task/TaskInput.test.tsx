import { useState } from 'react';
import { act, createEvent, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@mindwtr/core';

import { TaskInput } from './TaskInput';

const buildProject = (title: string, status: Project['status'] = 'active'): Project => ({
    id: title.toLowerCase().replace(/\s+/g, '-'),
    title,
    status,
    color: '#3b82f6',
    order: 0,
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
});

function TaskInputHarness({
    initialValue = '',
    contexts = [],
    onAcceptSuggestion,
}: {
    initialValue?: string;
    contexts?: string[];
    onAcceptSuggestion?: Parameters<typeof TaskInput>[0]['onAcceptSuggestion'];
}) {
    const [value, setValue] = useState(initialValue);

    return (
        <TaskInput
            value={value}
            onChange={setValue}
            projects={[]}
            contexts={contexts}
            onAcceptSuggestion={onAcceptSuggestion}
        />
    );
}

describe('TaskInput autocomplete', () => {
    it('suggests custom contexts for @ trigger', () => {
        const onChange = vi.fn();
        const { getByRole } = render(
            <TaskInput
                value="@per"
                onChange={onChange}
                projects={[]}
                contexts={['@home', '@work', '@personal']}
            />
        );
        const input = getByRole('combobox') as HTMLInputElement;
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        expect(getByRole('option', { name: '@personal' })).toBeInTheDocument();
    });

    it('hides archived projects from project suggestions', () => {
        const onChange = vi.fn();
        const { getByRole, queryByRole } = render(
            <TaskInput
                value="+Arc"
                onChange={onChange}
                projects={[buildProject('Active Roadmap'), buildProject('Arc', 'archived')]}
                contexts={[]}
            />
        );
        const input = getByRole('combobox') as HTMLInputElement;
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        expect(queryByRole('option', { name: 'Arc' })).not.toBeInTheDocument();
        expect(getByRole('option', { name: /Create Project "Arc"/ })).toBeInTheDocument();
    });

    it('prioritizes prefix matches before substring matches', () => {
        const onChange = vi.fn();
        const { getAllByRole, getByRole } = render(
            <TaskInput
                value="@ho"
                onChange={onChange}
                projects={[]}
                contexts={['@school', '@home', '@chores']}
            />
        );
        const input = getByRole('combobox') as HTMLInputElement;
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        expect(getAllByRole('option').map((option) => option.textContent)).toEqual([
            '@home',
            '@chores',
            '@school',
        ]);
    });

    it('suggests tags for # trigger and inserts selected tag', () => {
        const onChange = vi.fn();
        const { getByRole } = render(
            <TaskInput
                value="#urg"
                onChange={onChange}
                projects={[]}
                contexts={['#urgent', '#ops', '@work']}
            />
        );
        const input = getByRole('combobox') as HTMLInputElement;
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        fireEvent.click(getByRole('option', { name: '#urgent' }));

        expect(onChange).toHaveBeenCalledWith('#urgent ');
    });

    it('accepts a hotkey suggestion with Enter and advances the caret for continued typing', async () => {
        const { getByRole } = render(<TaskInputHarness initialValue="@wo" contexts={['@work']} />);
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(input.value).toBe('@work ');
            expect(input.selectionStart).toBe('@work '.length);
            expect(input.selectionEnd).toBe('@work '.length);
        });
    });

    it('removes an explicitly accepted token when the parent applies metadata', async () => {
        const onAcceptSuggestion = vi.fn(() => true);
        const { getByRole } = render(
            <TaskInputHarness
                initialValue="Email @wo today"
                contexts={['@work']}
                onAcceptSuggestion={onAcceptSuggestion}
            />
        );
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange('Email @wo'.length, 'Email @wo'.length);
        fireEvent.click(input);

        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(onAcceptSuggestion).toHaveBeenCalledWith({
                kind: 'context',
                label: '@work',
                value: '@work',
            });
            expect(input.value).toBe('Email today');
            expect(input.selectionStart).toBe('Email '.length);
            expect(input.selectionEnd).toBe('Email '.length);
        });
    });

    it('offers slash command suggestions and removes accepted slash commands when metadata is applied', async () => {
        const onAcceptSuggestion = vi.fn(() => true);
        const { getByRole } = render(
            <TaskInputHarness
                initialValue="Email /due:2026-05-01 today"
                onAcceptSuggestion={onAcceptSuggestion}
            />
        );
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange('Email /due:2026-05-01'.length, 'Email /due:2026-05-01'.length);
        fireEvent.click(input);

        expect(getByRole('option', { name: '/due:2026-05-01' })).toBeInTheDocument();
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(onAcceptSuggestion).toHaveBeenCalledWith({
                kind: 'command',
                command: 'due',
                label: '/due:2026-05-01',
                value: '2026-05-01',
            });
            expect(input.value).toBe('Email today');
            expect(input.selectionStart).toBe('Email '.length);
            expect(input.selectionEnd).toBe('Email '.length);
        });
    });

    it('completes an accepted slash command prefix when no argument is present', async () => {
        const { getByRole } = render(<TaskInputHarness initialValue="/du" />);
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(input.value).toBe('/due:');
            expect(input.selectionStart).toBe('/due:'.length);
            expect(input.selectionEnd).toBe('/due:'.length);
        });
    });

    it('lists every parser-supported slash command in the popup', () => {
        const { getByRole } = render(<TaskInputHarness initialValue="/" />);
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        for (const name of ['/link:<url>', '/energy:<level>', '/area:<name>', '/reference', '/archived', '/*']) {
            expect(getByRole('option', { name })).toBeInTheDocument();
        }
    });

    it('suggests the valid energy levels after /energy: and inserts the canonical token', async () => {
        const { getByRole, getAllByRole } = render(<TaskInputHarness initialValue="/energy:" />);
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        expect(getAllByRole('option').map((option) => option.textContent)).toEqual([
            '/energy:low',
            '/energy:medium',
            '/energy:high',
        ]);

        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(input.value).toBe('/energy:medium ');
        });
    });

    it('completes the /* focus command from the popup', async () => {
        const { getByRole } = render(<TaskInputHarness initialValue="/*" />);
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        expect(getByRole('option', { name: '/*' })).toBeInTheDocument();
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(input.value).toBe('/* ');
        });
    });

    it('keeps the metadata-applied caret when the parent value update is delayed', async () => {
        const onAcceptSuggestion = vi.fn(() => true);
        const rafCallbacks: FrameRequestCallback[] = [];
        const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            rafCallbacks.push(callback);
            return rafCallbacks.length;
        });
        let commitChange: (() => void) | null = null;

        function DelayedTaskInputHarness() {
            const [value, setValue] = useState('Email @wo today');

            return (
                <TaskInput
                    value={value}
                    onChange={(nextValue) => {
                        commitChange = () => setValue(nextValue);
                    }}
                    projects={[]}
                    contexts={['@work']}
                    onAcceptSuggestion={onAcceptSuggestion}
                />
            );
        }

        try {
            const { getByRole } = render(<DelayedTaskInputHarness />);
            const input = getByRole('combobox') as HTMLInputElement;
            input.focus();
            input.setSelectionRange('Email @wo'.length, 'Email @wo'.length);
            fireEvent.click(input);

            fireEvent.keyDown(input, { key: 'Enter' });

            await waitFor(() => {
                expect(onAcceptSuggestion).toHaveBeenCalled();
                expect(commitChange).not.toBeNull();
            });
            expect(input.value).toBe('Email @wo today');

            act(() => {
                rafCallbacks.shift()?.(0);
            });

            await act(async () => {
                commitChange?.();
            });

            await waitFor(() => {
                expect(input.value).toBe('Email today');
                expect(input.selectionStart).toBe('Email '.length);
                expect(input.selectionEnd).toBe('Email '.length);
            });
        } finally {
            requestAnimationFrameSpy.mockRestore();
        }
    });

    it('accepts a hotkey suggestion with Tab', async () => {
        const { getByRole } = render(<TaskInputHarness initialValue="@wo" contexts={['@work']} />);
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        fireEvent.keyDown(input, { key: 'Tab' });

        await waitFor(() => {
            expect(input.value).toBe('@work ');
            expect(input.selectionStart).toBe('@work '.length);
            expect(input.selectionEnd).toBe('@work '.length);
        });
    });

    it('uses Tab to choose an existing project before creating one', async () => {
        const onChange = vi.fn();
        const onCreateProject = vi.fn();
        const { getAllByRole, getByRole } = render(
            <TaskInput
                value="+La"
                onChange={onChange}
                projects={[buildProject('Launch'), buildProject('Archive')]}
                contexts={[]}
                onCreateProject={onCreateProject}
            />
        );
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        expect(getAllByRole('option').map((option) => option.textContent)).toEqual([
            'Launch',
            '✨ Create Project "La"',
        ]);
        fireEvent.keyDown(input, { key: 'Tab' });

        await waitFor(() => {
            expect(onChange).toHaveBeenLastCalledWith('+Launch ');
        });
        expect(onCreateProject).not.toHaveBeenCalled();
    });

    it('accepts a hotkey suggestion against the live input value during rapid typing', async () => {
        const onChange = vi.fn();
        const { getByRole } = render(
            <TaskInput
                value="@wo"
                onChange={onChange}
                projects={[]}
                contexts={['@work']}
            />
        );
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        input.value = '@wo today';
        input.setSelectionRange('@wo'.length, '@wo'.length);
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(onChange).toHaveBeenLastCalledWith('@work today');
        });
    });

    it('does not accept a hotkey suggestion while an IME composition is active', () => {
        const { getByRole } = render(<TaskInputHarness initialValue="@wo" contexts={['@work']} />);
        const input = getByRole('combobox') as HTMLInputElement;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        const enter = createEvent.keyDown(input, { key: 'Enter' });
        Object.defineProperty(enter, 'isComposing', { value: true });
        fireEvent(input, enter);

        expect(input.value).toBe('@wo');
    });

    it('keeps the highlighted suggestion scrolled into view while navigating with arrows', async () => {
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            writable: true,
            value: scrollIntoView,
        });

        try {
            const { getByRole } = render(
                <TaskInputHarness initialValue="@t" contexts={['@t1', '@t2', '@t3', '@t4', '@t5']} />
            );
            const input = getByRole('combobox') as HTMLInputElement;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            fireEvent.click(input);

            fireEvent.keyDown(input, { key: 'ArrowDown' });
            fireEvent.keyDown(input, { key: 'ArrowDown' });

            await waitFor(() => {
                expect(getByRole('option', { name: '@t3' }).getAttribute('aria-selected')).toBe('true');
                expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
            });
        } finally {
            delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
        }
    });

    it('undoes task title edits with Ctrl+Z', async () => {
        const { getByRole } = render(<TaskInputHarness initialValue="Draft task" />);
        const input = getByRole('combobox') as HTMLInputElement;

        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.change(input, { target: { value: 'Draft task updated' } });

        expect(input.value).toBe('Draft task updated');

        fireEvent.keyDown(input, { key: 'z', ctrlKey: true });

        await waitFor(() => {
            expect(input.value).toBe('Draft task');
        });
    });
});
