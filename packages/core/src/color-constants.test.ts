import { describe, expect, it } from 'vitest';
import { AREA_PRESET_COLORS, DEFAULT_AREA_COLOR, DEFAULT_PROJECT_COLOR, getTaskPriorityColors, TASK_PRIORITY_COLORS, TASK_PRIORITY_COLORS_BY_THEME } from './color-constants';

describe('AREA_PRESET_COLORS', () => {
    it('keeps the original six swatches first and in order', () => {


        expect(AREA_PRESET_COLORS.slice(0, 6)).toEqual([
            '#3b82f6',
            '#10b981',
            '#f59e0b',
            '#ef4444',
            '#8b5cf6',
            '#ec4899',
        ]);
    });

    it('offers twelve distinct swatches', () => {
        expect(AREA_PRESET_COLORS).toHaveLength(12);
        expect(new Set(AREA_PRESET_COLORS).size).toBe(12);
    });

    it('stores every swatch as a lowercase six-digit hex', () => {
        for (const color of AREA_PRESET_COLORS) {
            expect(color).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it('keeps the neutral default out of the pickable palette', () => {
        expect(DEFAULT_AREA_COLOR).toBe(DEFAULT_PROJECT_COLOR);
        expect(AREA_PRESET_COLORS).not.toContain(DEFAULT_AREA_COLOR);
    });
});

describe('TASK_PRIORITY_COLORS_BY_THEME', () => {
    it('stays monochrome on eink and keeps the canonical palette elsewhere', () => {
        for (const priority of ['urgent', 'high', 'medium', 'low'] as const) {
            expect(TASK_PRIORITY_COLORS_BY_THEME.eink[priority]).toBe('#000000');
        }
        expect(TASK_PRIORITY_COLORS_BY_THEME.light).toBe(TASK_PRIORITY_COLORS);
        expect(TASK_PRIORITY_COLORS_BY_THEME.dark).toBe(TASK_PRIORITY_COLORS);
        expect(TASK_PRIORITY_COLORS_BY_THEME.sepia).toBe(TASK_PRIORITY_COLORS);
    });

    it('resolves every theme through getTaskPriorityColors, defaulting unknown themes to the canonical palette', () => {
        expect(getTaskPriorityColors('eink')).toBe(TASK_PRIORITY_COLORS_BY_THEME.eink);
        expect(getTaskPriorityColors('default')).toBe(TASK_PRIORITY_COLORS);
        expect(getTaskPriorityColors(null)).toBe(TASK_PRIORITY_COLORS);
        expect(getTaskPriorityColors('nonsense')).toBe(TASK_PRIORITY_COLORS);
    });
});
