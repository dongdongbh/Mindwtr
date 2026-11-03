import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

import { MindSweepLauncher } from './MindSweepModal';

const t = (key: string) => key;

const openFlow = (addTask = vi.fn().mockResolvedValue({ success: true })) => {
    const utils = render(<MindSweepLauncher t={t} addTask={addTask} />);
    fireEvent.click(utils.getByRole('button', { name: 'mindSweep.launchButton' }));
    return { ...utils, addTask };
};

describe('MindSweepLauncher', () => {
    it('opens the intro step with scope choices', () => {
        const { getByText } = openFlow();
        expect(getByText('mindSweep.intro')).toBeInTheDocument();
        expect(getByText('mindSweep.scopePersonal')).toBeInTheDocument();
        expect(getByText('mindSweep.scopeWork')).toBeInTheDocument();
    });

    it('traps focus inside the modal and restores focus on close', async () => {
        const { getByRole, queryByRole } = render(
            <MindSweepLauncher t={t} addTask={vi.fn().mockResolvedValue({ success: true })} />,
        );
        const launcher = getByRole('button', { name: 'mindSweep.launchButton' });
        launcher.focus();
        fireEvent.click(launcher);

        const start = getByRole('button', { name: 'mindSweep.start' });
        await waitFor(() => expect(start).toHaveFocus());

        fireEvent.keyDown(start, { key: 'Tab' });
        const close = getByRole('button', { name: 'mindSweep.close' });
        expect(close).toHaveFocus();

        fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
        expect(start).toHaveFocus();

        fireEvent.keyDown(start, { key: 'Escape' });
        await waitFor(() => expect(queryByRole('dialog')).toBeNull());
        expect(launcher).toHaveFocus();
    });

    it('steps into the first group and captures items to the inbox', async () => {
        const { addTask, getByText, getByPlaceholderText } = openFlow();
        fireEvent.click(getByText('mindSweep.start'));

        expect(getByText('mindSweep.group.homeStuff.title')).toBeInTheDocument();
        expect(getByText('mindSweep.group.homeStuff.p1')).toBeInTheDocument();

        const input = getByPlaceholderText('mindSweep.inputPlaceholder');
        fireEvent.change(input, { target: { value: 'Fix the dripping tap' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(addTask).toHaveBeenCalledWith('Fix the dripping tap', { status: 'inbox' });
        });
        expect(getByText('Fix the dripping tap')).toBeInTheDocument();
        expect((input as HTMLInputElement).value).toBe('');
    });

    it('keeps a rejected item out of the captured list and shows the failure', async () => {
        const addTask = vi.fn().mockResolvedValue({ success: false, error: 'Write rejected' });
        const { getByText, getByPlaceholderText, queryByText } = openFlow(addTask);
        fireEvent.click(getByText('mindSweep.start'));

        const input = getByPlaceholderText('mindSweep.inputPlaceholder');
        fireEvent.change(input, { target: { value: 'Rejected sweep item' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => expect(getByText('task.addFailed')).toBeInTheDocument());
        expect(queryByText('mindSweep.groupCaptured')).toBeNull();
        expect((input as HTMLInputElement).value).toBe('Rejected sweep item');
    });

    it('filters groups by scope and reaches the summary with a count', async () => {
        const { getByText, getByPlaceholderText, queryByText } = openFlow();
        fireEvent.click(getByText('mindSweep.scopeWork'));
        fireEvent.click(getByText('mindSweep.start'));


        expect(getByText('mindSweep.group.commitments.title')).toBeInTheDocument();
        expect(queryByText('mindSweep.group.homeStuff.title')).toBeNull();

        const input = getByPlaceholderText('mindSweep.inputPlaceholder');
        fireEvent.change(input, { target: { value: 'Reply to the vendor' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(getByText('Reply to the vendor')).toBeInTheDocument());


        fireEvent.click(getByText('mindSweep.next'));
        fireEvent.click(getByText('mindSweep.next'));
        fireEvent.click(getByText('mindSweep.next'));
        fireEvent.click(getByText('mindSweep.next'));
        expect(getByText('mindSweep.summaryTitle')).toBeInTheDocument();

        expect(getByText('mindSweep.summaryCount')).toBeInTheDocument();
    });
});
