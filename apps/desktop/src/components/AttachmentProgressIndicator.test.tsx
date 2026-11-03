import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { globalProgressTracker } from '@mindwtr/core';

import { AttachmentProgressIndicator } from './AttachmentProgressIndicator';
import { LanguageProvider } from '../contexts/language-context';


describe('AttachmentProgressIndicator', () => {
    it('names the progress bar from the shared translation key', () => {
        globalProgressTracker.updateProgress('att-1', {
            attachmentId: 'att-1',
            bytesTransferred: 50,
            totalBytes: 100,
            status: 'active',
        });

        const { getByRole } = render(
            <LanguageProvider>
                <AttachmentProgressIndicator attachmentId="att-1" />
            </LanguageProvider>
        );

        const bar = getByRole('progressbar');
        expect(bar).toHaveAttribute('aria-label', 'Attachment transfer progress');
        expect(bar).toHaveAttribute('aria-valuetext', '50%');
    });
});
