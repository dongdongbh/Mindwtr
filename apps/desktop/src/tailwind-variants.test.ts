import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

// postcss-selector-parser 6.1.3 (pinned in 1.2.7 for GHSA-w9m9-85wc-3x92) made
// Tailwind drop every variant built on `:merge()` — group-hover, named groups,
// peer-* — so the hover-revealed task row buttons shipped invisible. The pin is
// a root override, invisible to component tests; this compiles the variants
// through the real pipeline so a dependency bump cannot silently repeat it.
describe('tailwind variant pipeline', () => {
    it('still emits group-hover, named-group and peer variants', async () => {
        const raw = '<div class="group group/row peer"><i class="group-hover:opacity-100 group-hover/row:opacity-50 peer-checked:hidden"></i></div>';
        const result = await postcss([
            tailwindcss({
                content: [{ raw, extension: 'html' }],
                corePlugins: { preflight: false },
            }),
        ]).process('@tailwind utilities;', { from: undefined });
        expect(result.css).toContain('.group:hover .group-hover\\:opacity-100');
        expect(result.css).toContain('.group\\/row:hover .group-hover\\/row\\:opacity-50');
        expect(result.css).toContain('.peer:checked ~ .peer-checked\\:hidden');
    });
});
