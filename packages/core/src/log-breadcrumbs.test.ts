import { beforeEach, describe, expect, it } from 'vitest';
import { addBreadcrumb, clearBreadcrumbs, getBreadcrumbs } from './log-breadcrumbs';

describe('log breadcrumbs', () => {
    beforeEach(() => {
        clearBreadcrumbs();
    });

    it('keeps only the latest breadcrumbs', () => {
        for (let index = 0; index < 25; index += 1) {
            addBreadcrumb(`view:test-${index}`);
        }
        const breadcrumbs = getBreadcrumbs();
        expect(breadcrumbs).toHaveLength(20);
        expect(breadcrumbs[0]).toContain('view:test-5');
        expect(breadcrumbs.at(-1)).toContain('view:test-24');
    });
});
