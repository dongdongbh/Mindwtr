import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PromptModal } from './PromptModal';

vi.mock('../contexts/language-context', () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));

const baseProps = {
    isOpen: true,
    title: 'Add link',
    confirmLabel: 'Save',
    cancelLabel: 'Cancel',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
};

describe('PromptModal browse', () => {
    it('fills the input from onBrowse and confirms with the picked value', async () => {
        const onConfirm = vi.fn();
        const onBrowse = vi.fn(async () => 'C:\\docs\\report.pdf');
        render(
            <PromptModal
                {...baseProps}
                onConfirm={onConfirm}
                browseLabel="Link to file…"
                onBrowse={onBrowse}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: 'Link to file…' }));
        await waitFor(() => {
            expect(screen.getByRole('combobox')).toHaveValue('C:\\docs\\report.pdf');
        });

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onConfirm).toHaveBeenCalledWith('C:\\docs\\report.pdf');
    });

    it('prevents the input blur on footer button mousedown so the first click is not swallowed', () => {
        render(
            <PromptModal
                {...baseProps}
                defaultValue="https://example.com"
                browseLabel="Link to file…"
                onBrowse={vi.fn(async () => null)}
            />
        );


        expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Link to file…' }))).toBe(false);
        expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Cancel' }))).toBe(false);
        expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Save' }))).toBe(false);
        expect(screen.queryByText('common.validationRequired')).toBeNull();
    });
});

describe('PromptModal refused value', () => {
    it('keeps confirm off and says why while validate refuses the typed value', () => {
        const onConfirm = vi.fn();
        render(
            <PromptModal
                {...baseProps}
                onConfirm={onConfirm}
                validate={(value) => (value.trim().toLowerCase() === 'home' ? 'Taken' : null)}
            />
        );

        const input = screen.getByRole('combobox');
        fireEvent.change(input, { target: { value: ' Home ' } });
        expect(screen.getByText('Taken')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onConfirm).not.toHaveBeenCalled();
        expect(input).toHaveValue(' Home ');
        expect(screen.queryByText('common.validationRequired')).toBeNull();

        fireEvent.change(input, { target: { value: 'Garden' } });
        expect(screen.queryByText('Taken')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onConfirm).toHaveBeenCalledWith('Garden');
    });
});

describe('PromptModal multiline', () => {
    it('uses a textarea only when opted in and submits with the button', () => {
        const onConfirm = vi.fn();
        render(<PromptModal {...baseProps} multiline onConfirm={onConfirm} />);
        const input = screen.getByRole('textbox');
        fireEvent.change(input, { target: { value: 'https://a.test\nhttps://b.test' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(onConfirm).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onConfirm).toHaveBeenCalledWith('https://a.test\nhttps://b.test');
    });
});

describe('PromptModal datetime-local field', () => {
    const dateTimeProps = {
        ...baseProps,
        title: 'Completion time',
        inputType: 'datetime-local' as const,
        defaultValue: '2026-04-22T09:30',
    };


    it('renders the shared calendar popover rather than a native datetime input', () => {
        render(<PromptModal {...dateTimeProps} />);

        expect(screen.queryByRole('dialog', { name: /nav\.calendar/ })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: /nav\.calendar/ }));

        const calendar = screen.getByRole('dialog', { name: /nav\.calendar/ });
        expect(within(calendar).getByRole('button', { name: 'Today' })).toBeInTheDocument();
    });


    it('focuses the date input on open and confirms on Enter from it', () => {
        const onConfirm = vi.fn();
        render(<PromptModal {...dateTimeProps} onConfirm={onConfirm} />);

        const dateInput = screen.getByLabelText('Date');
        expect(document.activeElement).toBe(dateInput);

        fireEvent.keyDown(dateInput, { key: 'Enter', bubbles: true });

        expect(onConfirm).toHaveBeenCalledWith('2026-04-22T09:30');
    });

    it('keeps the date when only the time is edited', () => {
        const onConfirm = vi.fn();
        render(<PromptModal {...dateTimeProps} onConfirm={onConfirm} />);

        const time = screen.getByLabelText('Time') as HTMLInputElement;
        expect(time.value).toBe('9:30 AM');

        fireEvent.change(time, { target: { value: '17:45' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(onConfirm).toHaveBeenCalledWith('2026-04-22T17:45');
    });

    it('keeps manual time entry editable instead of forcing the native picker on click', () => {
        const onConfirm = vi.fn();
        render(<PromptModal {...dateTimeProps} onConfirm={onConfirm} />);

        const time = screen.getByLabelText('Time') as HTMLInputElement;
        const showPicker = vi.fn();
        Object.defineProperty(time, 'showPicker', { configurable: true, value: showPicker });

        fireEvent.click(time);
        fireEvent.change(time, { target: { value: '17:45' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(showPicker).not.toHaveBeenCalled();
        expect(onConfirm).toHaveBeenCalledWith('2026-04-22T17:45');
    });

    it('keeps the time when a day is picked from the calendar', () => {
        const onConfirm = vi.fn();
        render(<PromptModal {...dateTimeProps} onConfirm={onConfirm} />);

        fireEvent.click(screen.getByRole('button', { name: /nav\.calendar/ }));
        const calendar = screen.getByRole('dialog', { name: /nav\.calendar/ });


        const dayLabel = new Intl.DateTimeFormat(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        }).format(new Date(2026, 3, 17));
        fireEvent.click(within(calendar).getByRole('button', { name: dayLabel }));

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(onConfirm).toHaveBeenCalledWith('2026-04-17T09:30');
    });
});

describe('PromptModal numericField', () => {
    it('does not render a numeric field or widen onConfirm when the prop is absent', () => {
        const onConfirm = vi.fn();
        render(<PromptModal {...baseProps} defaultValue="Task title" onConfirm={onConfirm} />);

        expect(screen.queryByLabelText('Time Spent')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onConfirm).toHaveBeenCalledWith('Task title');
        expect(onConfirm.mock.calls[0]).toHaveLength(1);
    });

    it('renders the numeric field, seeds it from defaultValue, and normalizes on confirm', () => {
        const onConfirm = vi.fn();
        render(
            <PromptModal
                {...baseProps}
                defaultValue="Task title"
                onConfirm={onConfirm}
                numericField={{ label: 'Time Spent', placeholder: 'minutes', defaultValue: '30' }}
            />
        );

        const numericInput = screen.getByLabelText('Time Spent') as HTMLInputElement;
        expect(numericInput.value).toBe('30');

        fireEvent.change(numericInput, { target: { value: '45' } });
        expect(numericInput.value).toBe('45');

        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onConfirm).toHaveBeenCalledWith('Task title', 45);
    });


    it('rounds a fractional entry on confirm instead of concatenating its digits', () => {
        const onConfirm = vi.fn();
        render(
            <PromptModal
                {...baseProps}
                defaultValue="Task title"
                onConfirm={onConfirm}
                numericField={{ label: 'Time Spent', defaultValue: '30' }}
            />
        );

        fireEvent.change(screen.getByLabelText('Time Spent'), { target: { value: '2.5' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(onConfirm).toHaveBeenCalledWith('Task title', 3);
    });


    it('confirms on Enter from the numeric field, not just the main input', () => {
        const onConfirm = vi.fn();
        render(
            <PromptModal
                {...baseProps}
                defaultValue="Task title"
                onConfirm={onConfirm}
                numericField={{ label: 'Time Spent', defaultValue: '30' }}
            />
        );

        fireEvent.keyDown(screen.getByLabelText('Time Spent'), { key: 'Enter' });

        expect(onConfirm).toHaveBeenCalledWith('Task title', 30);
    });

    it('cancels on Escape from the numeric field', () => {
        const onCancel = vi.fn();
        render(
            <PromptModal
                {...baseProps}
                defaultValue="Task title"
                onCancel={onCancel}
                numericField={{ label: 'Time Spent', defaultValue: '30' }}
            />
        );

        fireEvent.keyDown(screen.getByLabelText('Time Spent'), { key: 'Escape' });

        expect(onCancel).toHaveBeenCalled();
    });


    it('accepts a minute count that is not a multiple of five', () => {
        render(
            <PromptModal
                {...baseProps}
                defaultValue="Task title"
                numericField={{ label: 'Time Spent', defaultValue: '30' }}
            />
        );

        const numericInput = screen.getByLabelText('Time Spent') as HTMLInputElement;
        expect(numericInput).toHaveAttribute('type', 'number');
        expect(numericInput).toHaveAttribute('min', '0');

        fireEvent.change(numericInput, { target: { value: '7' } });

        expect(numericInput.validity.stepMismatch).toBe(false);
        expect(numericInput.validity.valid).toBe(true);
    });

    it('normalizes a blank numeric field to undefined instead of 0', () => {
        const onConfirm = vi.fn();
        render(
            <PromptModal
                {...baseProps}
                defaultValue="Task title"
                onConfirm={onConfirm}
                numericField={{ label: 'Time Spent', defaultValue: '30' }}
            />
        );

        fireEvent.change(screen.getByLabelText('Time Spent'), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onConfirm).toHaveBeenCalledWith('Task title', undefined);
    });
});
