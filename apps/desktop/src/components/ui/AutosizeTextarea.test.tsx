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

describe('AutosizeTextarea height reset', () => {
    // The reset to `auto` relayouts the whole editor; on WebKitGTK it made each
    // keystroke in a Today's Focus task take about a quarter second (#1454).
    it('grows without resetting the height while text is added, and resets when text is removed', () => {
        const { getByRole, rerender } = render(
            <AutosizeTextarea aria-label="Description" value="a" onChange={() => {}} minHeight={96} />
        );
        const textarea = getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
        const heights: string[] = [];
        const style = textarea.style;
        const native = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(style), 'height')!;
        Object.defineProperty(style, 'height', {
            configurable: true,
            get: () => native.get!.call(style),
            set: (value: string) => {
                heights.push(value);
                native.set!.call(style, value);
            },
        });
        Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 200 });

        rerender(<AutosizeTextarea aria-label="Description" value="ab" onChange={() => {}} minHeight={96} />);
        expect(heights).toEqual(['200px']);

        heights.length = 0;
        rerender(<AutosizeTextarea aria-label="Description" value="a" onChange={() => {}} minHeight={96} />);
        expect(heights).toEqual(['auto', '200px']);
    });
});
