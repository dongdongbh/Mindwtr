import { describe, it, expect } from 'vitest';
import { stripMarkdown } from './markdown';

describe('stripMarkdown', () => {
    it('removes common markdown markers', () => {
        const input = '# Title\n\n- **Bold** and *italic* with `code`\n\n[Link](https://example.com)';
        const output = stripMarkdown(input);
        expect(output).toContain('Title');
        expect(output).toContain('Bold and italic with code');
        expect(output).toContain('Link');
        expect(output).not.toContain('**');
        expect(output).not.toContain('`');
        expect(output).not.toContain('[');
    });
});

