import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { useConfirmDialog } from './useConfirmDialog';

function ConfirmDialogHarness() {
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const [result, setResult] = useState('pending');

    return (
        <>
            <button
                type="button"
                onClick={() => {
                    void requestConfirmation({
                        title: 'Delete task',
                        description: 'Delete this task?',
                        confirmLabel: 'Delete',
                        cancelLabel: 'Cancel',
                    }).then((confirmed) => setResult(String(confirmed)));
                }}
            >
                Open
            </button>
            <div data-testid="result">{result}</div>
            {confirmModal}
        </>
    );
}

describe('useConfirmDialog', () => {
    it('resolves true when confirmed', async () => {
        render(<ConfirmDialogHarness />);

        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

        await waitFor(() => {
            expect(screen.getByTestId('result')).toHaveTextContent('true');
        });
    });

    it('resolves false when cancelled', async () => {
        render(<ConfirmDialogHarness />);

        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => {
            expect(screen.getByTestId('result')).toHaveTextContent('false');
        });
    });
});
