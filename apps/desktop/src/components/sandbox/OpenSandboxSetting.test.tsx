import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenSandboxSetting } from './OpenSandboxSetting';

const labels = {
    cancel: 'Cancel',
    sandboxWorkspace: 'Open sandbox',
    sandboxDescription: 'Try fictional sample data.',
    sandboxSwitching: 'Switching workspace…',
    sandboxSwitchFailed: 'Could not switch workspaces.',
    sandboxConfirmTitle: 'Enter sandbox?',
    sandboxConfirmDescription: 'Use fictional tasks and projects to record a bug or give a demo.',
    sandboxEnter: 'Enter sandbox',
};

describe('OpenSandboxSetting', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('cancels without starting the workspace transition', () => {
        const enterSandbox = vi.fn().mockResolvedValue(undefined);
        render(<OpenSandboxSetting t={labels} onEnterSandbox={enterSandbox} />);

        fireEvent.click(screen.getByRole('button', { name: 'Open sandbox' }));
        expect(screen.getByRole('dialog', { name: 'Enter sandbox?' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(enterSandbox).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: 'Enter sandbox?' })).not.toBeInTheDocument();
    });

    it('does not offer sandbox entry while a data transfer is active', () => {
        const enterSandbox = vi.fn().mockResolvedValue(undefined);
        render(<OpenSandboxSetting t={labels} onEnterSandbox={enterSandbox} disabled />);

        const button = screen.getByRole('button', { name: 'Open sandbox' });
        expect(button).toBeDisabled();
        fireEvent.click(button);
        expect(screen.queryByRole('dialog', { name: 'Enter sandbox?' })).not.toBeInTheDocument();
        expect(enterSandbox).not.toHaveBeenCalled();
    });

    it('disables Enter when a data operation starts after confirmation opens', () => {
        const enterSandbox = vi.fn().mockResolvedValue(undefined);
        const { rerender } = render(
            <OpenSandboxSetting t={labels} onEnterSandbox={enterSandbox} />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Open sandbox' }));

        rerender(<OpenSandboxSetting t={labels} onEnterSandbox={enterSandbox} disabled />);
        const enter = screen.getByRole('button', { name: 'Enter sandbox' });
        expect(enter).toBeDisabled();
        fireEvent.click(enter);
        expect(enterSandbox).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'Enter sandbox?' })).toBeInTheDocument();
    });

    it('starts the workspace transition only after explicit confirmation', async () => {
        const enterSandbox = vi.fn().mockResolvedValue(undefined);
        render(<OpenSandboxSetting t={labels} onEnterSandbox={enterSandbox} />);

        fireEvent.click(screen.getByRole('button', { name: 'Open sandbox' }));
        expect(enterSandbox).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Enter sandbox' }));

        await waitFor(() => expect(enterSandbox).toHaveBeenCalledOnce());
        expect(screen.getByRole('dialog', { name: 'Switching workspace…' })).toBeInTheDocument();
    });
});
