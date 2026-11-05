import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useDropdownPosition } from './use-dropdown-position';

const elementWithWidth = (width: number) => {
    const element = document.createElement('div');
    element.getBoundingClientRect = () => ({
        width, height: 24, left: 100, right: 100 + width, top: 100, bottom: 124, x: 100, y: 100, toJSON: () => ({}),
    });
    return element;
};

const widthFor = (triggerWidth: number) => {
    const containerRef = { current: elementWithWidth(triggerWidth) };
    const dropdownRef = { current: elementWithWidth(0) };
    const { result } = renderHook(() => useDropdownPosition({ open: true, containerRef, dropdownRef }));
    return result.current.fixedDropdownStyle.width;
};

describe('useDropdownPosition', () => {
    it('gives a small trigger a menu wide enough for names (#1470)', () => {
        expect(widthFor(60)).toBe(240);
    });

    it('keeps a wide trigger at its own width', () => {
        expect(widthFor(400)).toBe(400);
    });
});
