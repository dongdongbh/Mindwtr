import React, { act } from 'react';
import { describe, expect, it } from 'vitest';
import renderer, { type ReactTestRenderer } from 'react-test-renderer';

import { PriorityFlag } from './priority-flag';
import { ThemeContext } from '../contexts/theme-context';

let themePreset: 'default' | 'eink' = 'default';

const flagColor = (priority: 'urgent' | 'high' | 'medium' | 'low') => {
    let tree!: ReactTestRenderer;
    act(() => {
        tree = renderer.create(
            <ThemeContext.Provider value={{ themePreset, themeMode: 'system', themeStyle: 'default', colorScheme: 'light', isDark: false, isReady: true, setThemeMode: () => {}, setThemeStyle: () => {} }}>
                <PriorityFlag priority={priority} />
            </ThemeContext.Provider>,
        );
    });
    const node = tree.root.findByProps({ testID: `priority-flag-${priority}` });
    const color = node.props.color;
    act(() => tree.unmount());
    return color;
};

describe('PriorityFlag', () => {
    it('keeps the canonical palette on a default theme', () => {
        themePreset = 'default';
        expect(flagColor('high')).toBe('#f97316');
        expect(flagColor('low')).toBe('#3b82f6');
    });

    it('renders monochrome on the eink preset', () => {
        themePreset = 'eink';
        expect(flagColor('urgent')).toBe('#000000');
        expect(flagColor('high')).toBe('#000000');
        expect(flagColor('medium')).toBe('#000000');
        expect(flagColor('low')).toBe('#000000');
    });
});
