import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';


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
