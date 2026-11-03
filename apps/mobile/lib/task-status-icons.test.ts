import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';


describe('task status icons', () => {
    it('gives every status, Start later and Incubate a glyph of its own', () => {
        const source = readFileSync(path.join(__dirname, 'task-status-icons.ts'), 'utf8');
        const statusBlock = source.slice(source.indexOf('TASK_STATUS_ICONS'), source.indexOf('};'));
        const statusGlyphs = Array.from(statusBlock.matchAll(/^\s+\w+: (\w+),$/gm), (match) => match[1]);
        const extraGlyphs = Array.from(source.matchAll(/_ICON: LucideIcon = (\w+);/g), (match) => match[1]);

        expect(statusGlyphs).toHaveLength(7);
        expect(extraGlyphs).toHaveLength(2);
        const glyphs = [...statusGlyphs, ...extraGlyphs];
        expect(new Set(glyphs).size).toBe(glyphs.length);

        expect(glyphs).not.toContain('Hourglass');
    });
});
