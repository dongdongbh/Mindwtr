import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AutosizeTextarea } from './AutosizeTextarea';

describe('AutosizeTextarea', () => {
    it('uses a larger minimum height while focused', () => {
        const { getByRole } = render(
            <AutosizeTextarea
                aria-label="Description"
                value="Short note"
                onChange={() => {}}
                minHeight={96}
                focusedMinHeight={160}
            />
        );

        const textarea = getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
        Object.defineProperty(textarea, 'scrollHeight', {
            configurable: true,
            value: 80,
        });

        fireEvent.focus(textarea);

        expect(textarea.style.height).toBe('160px');

        fireEvent.blur(textarea);

        expect(textarea.style.height).toBe('96px');
    });

    it('caps the textarea height and enables internal scrolling for very long content', () => {
        const { getByRole } = render(
            <AutosizeTextarea
                aria-label="Description"
                value={'Long note'}
                onChange={() => {}}
                minHeight={96}
                focusedMinHeight={160}
                maxHeight={320}
            />
        );

        const textarea = getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
        Object.defineProperty(textarea, 'scrollHeight', {
            configurable: true,
            value: 640,
        });

        fireEvent.focus(textarea);

        expect(textarea.style.height).toBe('320px');
        expect(textarea.style.overflowY).toBe('auto');
    });
});
