import { renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { describe, expect, it } from 'vitest';

import { useMiddleMousePan } from './use-column-pan';

const pointerDown = (button: number, clientX: number) => ({
    button,
    clientX,
    preventDefault: () => undefined,
} as unknown as ReactPointerEvent);

const movePointer = (clientX: number) => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX }));
};

const releasePointer = () => {
    window.dispatchEvent(new MouseEvent('pointerup'));
};

const renderPan = () => {
    const element = { scrollLeft: 0 } as HTMLElement;
    const { result } = renderHook(() => useMiddleMousePan({ current: element }));
    return { element, onPointerDown: result.current };
};

describe('useMiddleMousePan', () => {
    it('pans the strip with the pointer while the middle button is held', () => {
        const { element, onPointerDown } = renderPan();

        onPointerDown(pointerDown(1, 100));
        movePointer(140);


        expect(element.scrollLeft).toBe(-40);

        movePointer(120);
        expect(element.scrollLeft).toBe(-20);
    });

    it('stops panning once the button is released', () => {
        const { element, onPointerDown } = renderPan();

        onPointerDown(pointerDown(1, 100));
        movePointer(90);
        releasePointer();
        movePointer(10);

        expect(element.scrollLeft).toBe(10);
    });

    it('ignores presses from other buttons so left-drag and right-click are untouched', () => {
        const { element, onPointerDown } = renderPan();

        onPointerDown(pointerDown(0, 100));
        movePointer(200);

        expect(element.scrollLeft).toBe(0);
    });

    it('stops listening on window after unmount mid-drag', () => {
        const element = { scrollLeft: 0 } as HTMLElement;
        const { result, unmount } = renderHook(() => useMiddleMousePan({ current: element }));

        result.current(pointerDown(1, 100));
        unmount();
        movePointer(140);

        expect(element.scrollLeft).toBe(0);
    });
});
