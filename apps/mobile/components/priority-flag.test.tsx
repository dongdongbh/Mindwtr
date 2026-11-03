import React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { type ReactTestRenderer } from 'react-test-renderer';

import { PriorityFlag } from './priority-flag';

const useThemeMock = vi.hoisted(() => vi.fn(() => ({ themePreset: 'default' })));
vi.mock('../contexts/theme-context', () => ({ useTheme: () => useThemeMock() }));

const flagColor = (priority: 'urgent' | 'high' | 'medium' | 'low') => {
    let tree!: ReactTestRenderer;
    act(() => {
        tree = renderer.create(<PriorityFlag priority={priority} />);
    });
    const node = tree.root.findByProps({ testID: `priority-flag-${priority}` });
    const color = node.props.color;
    act(() => tree.unmount());
    return color;
};

describe('PriorityFlag', () => {
    it('keeps the canonical palette on a default theme', () => {
        useThemeMock.mockReturnValue({ themePreset: 'default' });
        expect(flagColor('high')).toBe('#f97316');
        expect(flagColor('low')).toBe('#3b82f6');
    });

    it('renders monochrome on the eink preset', () => {
        useThemeMock.mockReturnValue({ themePreset: 'eink' });
        expect(flagColor('urgent')).toBe('#000000');
        expect(flagColor('high')).toBe('#000000');
        expect(flagColor('medium')).toBe('#000000');
        expect(flagColor('low')).toBe('#000000');
    });
});
