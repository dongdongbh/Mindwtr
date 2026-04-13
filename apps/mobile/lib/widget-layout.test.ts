import { describe, expect, it } from 'vitest';

import {
    getAdaptiveAndroidWidgetTaskLimit,
    getAdaptiveWidgetTaskLimit,
    getAndroidWidgetLayoutMode,
} from './widget-layout';

describe('widget-layout', () => {
    it('keeps iOS/default widget families at three items for smaller sizes', () => {
        expect(getAdaptiveWidgetTaskLimit(0)).toBe(3);
        expect(getAdaptiveWidgetTaskLimit(120)).toBe(3);
        expect(getAdaptiveWidgetTaskLimit(180)).toBe(3);
    });

    it('increases item count as widget height grows', () => {
        expect(getAdaptiveWidgetTaskLimit(249)).toBe(3);
        expect(getAdaptiveWidgetTaskLimit(250)).toBe(4);
        expect(getAdaptiveWidgetTaskLimit(320)).toBe(5);
    });

    it('caps item count to avoid overfilling very tall widgets', () => {
        expect(getAdaptiveWidgetTaskLimit(1000)).toBe(8);
    });

    it('uses Android widget height more aggressively so 3x3 widgets do not waste space', () => {
        expect(getAdaptiveAndroidWidgetTaskLimit(0, 250)).toBe(4);
        expect(getAdaptiveAndroidWidgetTaskLimit(180, 250)).toBe(4);
        expect(getAdaptiveAndroidWidgetTaskLimit(220, 250)).toBe(5);
        expect(getAdaptiveAndroidWidgetTaskLimit(250, 250)).toBe(6);
        expect(getAdaptiveAndroidWidgetTaskLimit(320, 250)).toBe(8);
    });

    it('switches narrow Android widgets into compact mode', () => {
        expect(getAndroidWidgetLayoutMode(180)).toBe('compact');
        expect(getAndroidWidgetLayoutMode(200)).toBe('compact');
        expect(getAndroidWidgetLayoutMode(201)).toBe('standard');
    });

    it('lets shorter compact Android widgets fall back to two tasks', () => {
        expect(getAdaptiveAndroidWidgetTaskLimit(120, 180)).toBe(2);
        expect(getAdaptiveAndroidWidgetTaskLimit(179, 180)).toBe(2);
        expect(getAdaptiveAndroidWidgetTaskLimit(180, 180)).toBe(3);
    });

    it('reserves more chrome for compact Android widgets so the button remains visible', () => {
        expect(getAdaptiveAndroidWidgetTaskLimit(0, 180)).toBe(3);
        expect(getAdaptiveAndroidWidgetTaskLimit(180, 180)).toBe(3);
        expect(getAdaptiveAndroidWidgetTaskLimit(220, 180)).toBe(4);
    });
});
