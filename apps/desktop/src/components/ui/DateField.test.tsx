/**
 * DateField is the one desktop date input (see DateField.tsx). These cover the
 * two things the extraction had to keep working everywhere it is now adopted:
 * the calendar popover escaping a Dialog-hosted parent, and the label/clear
 * chrome staying optional for hosts that supply their own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JALALI_LOCALE_TAG, useTaskStore } from '@mindwtr/core';

import { LanguageProvider } from '../../contexts/language-context';
import { useNativeDateInputLocale } from '../../hooks/use-native-date-input-locale';

import { Dialog, DialogBody } from './Dialog';
import { DateField } from './DateField';

const translations: Record<string, string> = {
    'calendar.date': 'Date',
    'calendar.nextMonth': 'Next month',
    'calendar.prevMonth': 'Previous month',
    'common.clear': 'Clear',
    'nav.calendar': 'Calendar',
    'taskEdit.dateOnly': 'Date only',
};

const t = (key: string) => translations[key] ?? key;

async function pressButtonLikeMac(button: HTMLElement, input: HTMLInputElement) {
    input.focus();
    fireEvent.pointerDown(button);
    if (fireEvent.mouseDown(button)) input.blur();
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
}

afterEach(() => {
    cleanup();
});

describe('DateField', () => {
    it('opens and edits dates when WebKit reports navigator.language as C', () => {
        const previousSettings = useTaskStore.getState().settings;
        const language = vi.spyOn(navigator, 'language', 'get').mockReturnValue('C');
        const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['C']);
        const onDateChange = vi.fn();
        function SystemDateField() {
            const locale = useNativeDateInputLocale();
            return <DateField
                t={t}
                dateAriaLabel="Due"
                dateValue="2026-04-19"
                selectedDate={new Date(2026, 3, 19)}
                {...locale}
                dateInputClassName="border"
                onDateChange={onDateChange}
            />;
        }
        try {
            useTaskStore.setState({ settings: { dateFormat: 'system', timeFormat: 'system' } });
            render(<LanguageProvider><SystemDateField /></LanguageProvider>);
            fireEvent.click(screen.getByRole('button', { name: 'Due Calendar' }));
            expect(screen.getByRole('dialog', { name: 'Due Calendar' })).toHaveTextContent('April 2026');
            fireEvent.change(screen.getByRole('textbox', { name: 'Due' }), { target: { value: '04/20/2026' } });
            expect(onDateChange).toHaveBeenCalledWith('2026-04-20');
        } finally {
            cleanup();
            useTaskStore.setState({ settings: previousSettings });
            language.mockRestore();
            languages.mockRestore();
        }
    });

    it('opens its calendar popover from inside a Dialog', () => {
        // The popover is position:fixed rather than its own portal, so a Dialog
        // panel's overflow-hidden must not be allowed to swallow it. jsdom
        // cannot measure the escape; asserting it mounts under the panel is the
        // part a test can pin.
        render(
            <Dialog onClose={vi.fn()} label="Host dialog">
                <DialogBody>
                    <DateField
                        t={t}
                        label="Due"
                        dateAriaLabel="Due"
                        dateValue="2026-04-19"
                        selectedDate={new Date(2026, 3, 19)}
                        nativeDateInputLocale="en-US"
                        dateInputClassName="border"
                        hasValue
                        onDateChange={vi.fn()}
                        onClear={vi.fn()}
                    />
                </DialogBody>
            </Dialog>
        );

        expect(screen.queryByRole('dialog', { name: 'Due Calendar' })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Due Calendar' }));

        const popover = screen.getByRole('dialog', { name: 'Due Calendar' });
        expect(popover).toBeTruthy();
        expect(screen.getByRole('dialog', { name: 'Host dialog' }).contains(popover)).toBe(true);
    });

    // #1254, macOS only: WebKit there does not focus a button on click. Pressing a month arrow
    // blurred the field to nothing and the popover closed instead of paging. Every popover
    // button has to cancel the press so the field keeps focus; jsdom cannot play WebKit's focus
    // rule, so the cancelled mousedown is the part a test can pin.
    it('keeps the calendar open and pages it when a month arrow is pressed', () => {
        render(
            <DateField
                t={t}
                label="Due"
                dateAriaLabel="Due"
                dateValue="2026-04-19"
                selectedDate={new Date(2026, 3, 19)}
                nativeDateInputLocale="en-US"
                dateInputClassName="border"
                hasValue
                onDateChange={vi.fn()}
                onClear={vi.fn()}
            />
        );
        fireEvent.click(screen.getByRole('button', { name: 'Due Calendar' }));
        const popover = screen.getByRole('dialog', { name: 'Due Calendar' });

        for (const name of ['Calendar: Next month', 'Calendar: Previous month']) {
            // fireEvent returns false when the handler called preventDefault.
            expect(fireEvent.mouseDown(screen.getByRole('button', { name }))).toBe(false);
        }
        for (const button of Array.from(popover.querySelectorAll('button'))) {
            expect(fireEvent.mouseDown(button)).toBe(false);
        }

        expect(popover.textContent).toContain('April 2026');
        fireEvent.click(screen.getByRole('button', { name: 'Calendar: Next month' }));
        expect(screen.getByRole('dialog', { name: 'Due Calendar' }).textContent).toContain('May 2026');
    });

    it('keeps the calendar open on the first macOS-style button press (#1265)', async () => {
        render(
            <DateField
                t={t}
                label="Due"
                dateAriaLabel="Due"
                dateValue="2026-04-19"
                selectedDate={new Date(2026, 3, 19)}
                nativeDateInputLocale="en-US"
                dateInputClassName="border"
                hasValue
                onDateChange={vi.fn()}
                onClear={vi.fn()}
            />
        );

        await pressButtonLikeMac(
            screen.getByRole('button', { name: 'Due Calendar' }),
            screen.getByRole('textbox', { name: 'Due' }) as HTMLInputElement,
        );

        expect(screen.getByRole('dialog', { name: 'Due Calendar' })).toBeTruthy();
    });

    it('keeps a cleared value empty after a macOS-style button press (#1266)', async () => {
        const onClear = vi.fn();
        render(
            <DateField
                t={t}
                label="Due"
                dateAriaLabel="Due"
                dateValue="2026-04-19"
                selectedDate={new Date(2026, 3, 19)}
                nativeDateInputLocale="en-US"
                dateInputClassName="border"
                hasValue
                onDateChange={vi.fn()}
                onClear={onClear}
            />
        );
        const input = screen.getByRole('textbox', { name: 'Due' }) as HTMLInputElement;

        await pressButtonLikeMac(screen.getByRole('button', { name: 'Clear Due' }), input);

        expect(onClear).toHaveBeenCalledOnce();
        expect(input.value).toBe('');
    });

    it('preserves the date draft through a macOS-style Date only press', async () => {
        const onDateOnly = vi.fn();
        render(
            <DateField
                t={t}
                label="Due"
                dateAriaLabel="Due"
                dateValue="2026-04-19"
                selectedDate={new Date(2026, 3, 19)}
                nativeDateInputLocale="en-US"
                dateInputClassName="border"
                hasValue
                onDateChange={vi.fn()}
                onClear={vi.fn()}
                onDateOnly={onDateOnly}
            />
        );
        const input = screen.getByRole('textbox', { name: 'Due' }) as HTMLInputElement;
        fireEvent.change(input, { target: { value: '04/' } });

        await pressButtonLikeMac(screen.getByRole('button', { name: 'Date only: Due' }), input);

        expect(onDateOnly).toHaveBeenCalledOnce();
        expect(input.value).toBe('04/');
    });

    it('drops the label and the clear control when the host owns them', () => {
        const { container } = render(
            <DateField
                t={t}
                dateAriaLabel="Ends on"
                dateValue="2026-04-19"
                selectedDate={new Date(2026, 3, 19)}
                nativeDateInputLocale="en-US"
                dateInputClassName="border"
                onDateChange={vi.fn()}
            />
        );

        expect(container.querySelector('label')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Clear Ends on' })).toBeNull();
        expect(screen.getByLabelText('Ends on')).toBeTruthy();
    });

    it('marks unparseable typed text invalid without committing it (#1050)', () => {
        const onDateChange = vi.fn();
        render(
            <DateField
                t={t}
                label="Due"
                dateAriaLabel="Due"
                dateValue="2026-04-19"
                selectedDate={new Date(2026, 3, 19)}
                nativeDateInputLocale="en-US"
                dateInputClassName="border"
                hasValue
                onDateChange={onDateChange}
                onClear={vi.fn()}
            />
        );

        const input = screen.getByRole('textbox', { name: 'Due' });
        fireEvent.change(input, { target: { value: 'saasdjfasdj' } });
        // The visual cue is immediate, but a half-typed date is unparseable on
        // nearly every keystroke — announcing "invalid" that often is noise, so
        // aria-invalid waits until the field is left.
        expect(input.className).toContain('border-warning');
        expect(input).not.toHaveAttribute('aria-invalid');
        expect(onDateChange).not.toHaveBeenCalled();

        fireEvent.blur(input);
        expect(input).toHaveAttribute('aria-invalid', 'true');

        fireEvent.change(input, { target: { value: '04/20/2026' } });
        expect(input).not.toHaveAttribute('aria-invalid');
        expect(input.className).not.toContain('border-warning');
        expect(onDateChange).toHaveBeenCalledWith('2026-04-20');
    });

    it('typing the field empty reverts on blur when the host passes no onClear', async () => {
        const onDateChange = vi.fn();
        render(
            <DateField
                t={t}
                dateAriaLabel="Ends on"
                dateValue="2026-04-19"
                selectedDate={new Date(2026, 3, 19)}
                nativeDateInputLocale="en-US"
                dateInputClassName="border"
                onDateChange={onDateChange}
            />
        );

        const input = screen.getByLabelText('Ends on') as HTMLInputElement;
        expect(input.value).toBe('04/19/2026');

        fireEvent.change(input, { target: { value: '' } });
        expect(onDateChange).not.toHaveBeenCalled();

        // The reset is deferred past any in-flight pointer press (#901).
        fireEvent.blur(input);
        await waitFor(() => expect(input.value).toBe('04/19/2026'));
    });

    it('completes year-less and 2-digit-year entry only when leaving the field (#1050)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 7, 22));
        try {
            const onDateChange = vi.fn();
            render(
                <DateField
                    t={t}
                    dateAriaLabel="Due"
                    dateValue="2026-04-19"
                    selectedDate={new Date(2026, 3, 19)}
                    dateFormatSetting="mdy"
                    nativeDateInputLocale="en-US"
                    dateInputClassName="border"
                    onDateChange={onDateChange}
                />
            );

            const input = screen.getByLabelText('Due') as HTMLInputElement;
            // Never mid-typing: completing "1/1" on the keystroke rewrote the
            // text under the user and made "1/1/27" impossible to type.
            fireEvent.change(input, { target: { value: '1/1' } });
            expect(onDateChange).not.toHaveBeenCalled();
            expect(input.className).not.toContain('border-warning');
            fireEvent.blur(input);
            await waitFor(() => expect(onDateChange).toHaveBeenLastCalledWith('2027-01-01'));

            // Still ahead this year, so no rollover.
            onDateChange.mockClear();
            fireEvent.change(input, { target: { value: '12/25' } });
            fireEvent.blur(input);
            await waitFor(() => expect(onDateChange).toHaveBeenLastCalledWith('2026-12-25'));

            onDateChange.mockClear();
            fireEvent.change(input, { target: { value: '1/1/27' } });
            expect(onDateChange).not.toHaveBeenCalled();
            fireEvent.blur(input);
            await waitFor(() => expect(onDateChange).toHaveBeenLastCalledWith('2027-01-01'));

            // A complete date still applies while typing, no blur needed.
            onDateChange.mockClear();
            fireEvent.change(input, { target: { value: '04/20/2026' } });
            expect(onDateChange).toHaveBeenLastCalledWith('2026-04-20');
        } finally {
            vi.useRealTimers();
        }
    });

    it('reads year-less entry day-first under a d/m/y format, and still rejects 31/2', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 7, 22));
        try {
            const onDateChange = vi.fn();
            render(
                <DateField
                    t={t}
                    dateAriaLabel="Due"
                    dateValue="2026-04-19"
                    selectedDate={new Date(2026, 3, 19)}
                    dateFormatSetting="dmy"
                    nativeDateInputLocale="en-GB"
                    dateInputClassName="border"
                    onDateChange={onDateChange}
                />
            );

            const input = screen.getByLabelText('Due') as HTMLInputElement;
            fireEvent.change(input, { target: { value: '20/4' } });
            expect(onDateChange).not.toHaveBeenCalled();
            fireEvent.blur(input);
            await waitFor(() => expect(onDateChange).toHaveBeenLastCalledWith('2027-04-20'));

            onDateChange.mockClear();
            fireEvent.change(input, { target: { value: '31/2' } });
            expect(onDateChange).not.toHaveBeenCalled();
            expect(input.className).toContain('border-warning');
            // An unparseable draft still reverts to the saved value on leave.
            fireEvent.blur(input);
            await waitFor(() => expect(input.value).toBe('19/04/2026'));
            expect(onDateChange).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows and parses Jalali dates when the resolved locale is the Persian calendar', () => {
        const onDateChange = vi.fn();
        render(
            <DateField
                t={t}
                dateAriaLabel="Due"
                dateValue="2026-04-19"
                selectedDate={new Date(2026, 3, 19)}
                nativeDateInputLocale={JALALI_LOCALE_TAG}
                dateInputClassName="border"
                onDateChange={onDateChange}
            />
        );

        const input = screen.getByLabelText('Due') as HTMLInputElement;
        expect(input.value).toBe('1405-01-30');

        fireEvent.change(input, { target: { value: '1405-02-01' } });
        expect(onDateChange).toHaveBeenCalledWith('2026-04-21');
    });
});
