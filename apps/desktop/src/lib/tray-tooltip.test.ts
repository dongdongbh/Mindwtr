import { describe, expect, it } from 'vitest';

import { TRAY_TOOLTIP_MAX_LENGTH, buildTrayTooltip } from './tray-tooltip';

const build = (titles: string[], appName = 'Mindwtr', focusLabel = "Today's Focus") =>
    buildTrayTooltip({ appName, focusLabel, titles });

describe('buildTrayTooltip', () => {
    it('falls back to the app name when nothing is in Focus', () => {


        expect(build([])).toBe('Mindwtr');
        expect(build(['   ', ''])).toBe('Mindwtr');
    });

    it('lists the focus titles under a heading carrying the total', () => {
        expect(build(['Write report', 'Call Bob'])).toBe(
            "Mindwtr — Today's Focus (2)\n• Write report\n• Call Bob"
        );
    });

    it('collapses newlines and runs of whitespace inside a title', () => {
        expect(build(['Write\n  the   report'])).toBe(
            "Mindwtr — Today's Focus (1)\n• Write the report"
        );
    });

    it('marks unlisted tasks with an ellipsis and never exceeds the Windows buffer', () => {
        const titles = Array.from({ length: 12 }, (_, i) => `Task number ${i + 1} with a long title`);

        const tooltip = build(titles);

        expect(tooltip.length).toBeLessThanOrEqual(TRAY_TOOLTIP_MAX_LENGTH);
        expect(tooltip.endsWith('…')).toBe(true);
        expect(tooltip.startsWith("Mindwtr — Today's Focus (12)")).toBe(true);
    });

    it('keeps every title when they all fit, with no trailing ellipsis', () => {
        const tooltip = build(['A', 'B', 'C']);

        expect(tooltip).toBe("Mindwtr — Today's Focus (3)\n• A\n• B\n• C");
        expect(tooltip.endsWith('…')).toBe(false);
    });

    it('truncates a single overlong title rather than dropping it', () => {
        const tooltip = build(['x'.repeat(300)]);

        expect(tooltip.length).toBeLessThanOrEqual(TRAY_TOOLTIP_MAX_LENGTH);
        expect(tooltip).toContain('• xxxx');
        expect(tooltip.endsWith('…')).toBe(true);
    });

    it('stays within budget even when the heading itself is verbose', () => {
        const tooltip = buildTrayTooltip({
            appName: 'Mindwtr',
            focusLabel: 'F'.repeat(200),
            titles: ['Anything'],
        });

        expect(tooltip.length).toBeLessThanOrEqual(TRAY_TOOLTIP_MAX_LENGTH);
    });

    it('never exceeds the buffer across a spread of realistic Focus lists', () => {
        for (let count = 1; count <= 25; count += 1) {
            for (const width of [3, 12, 40, 90]) {
                const titles = Array.from({ length: count }, (_, i) => `${'t'.repeat(width)}${i}`);
                const tooltip = build(titles);
                expect(tooltip.length, `count=${count} width=${width}`).toBeLessThanOrEqual(
                    TRAY_TOOLTIP_MAX_LENGTH
                );
            }
        }
    });
});
