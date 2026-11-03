import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

for (const view of ['projects', 'contexts']) {
    test(`${view} navigation stays usable after resizing and enlarging text`, async ({ page }) => {
        await dismissOnboarding(page);
        await seedAppData(page, {
            projects: Array.from({ length: 45 }, (_, index) => ({ id: `p${index}`, title: `Project ${index}` })),
            tasks: Array.from({ length: 45 }, (_, index) => ({ id: `t${index}`, title: `Task ${index}`, status: 'next', contexts: [`@context${index}`] })),
        });
        await page.setViewportSize({ width: 1366, height: 1200 });
        await page.goto(`/?view=${view}`);
        const separator = page.getByRole('separator', { name: 'Resize navigation and submenu' });
        await expect(separator).toBeVisible();
        await separator.focus();
        await page.keyboard.press('End');
        await expect(separator).toHaveAttribute('aria-valuenow', '80');
        const submenu = page.locator('#view-sidebar-panel');
        expect(await submenu.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(288);
        await page.setViewportSize({ width: 1366, height: 768 });
        await expect(separator).toHaveCount(0);
        const navigation = page.locator(view === 'projects' ? '[data-project-navigation-root]' : '[data-context-navigation-root]');
        await expect(navigation).toBeVisible();
        const item = view === 'projects' ? navigation.locator('[data-project-navigation-item]').first() : navigation.getByRole('button').first();
        await item.focus();
        await expect(item).toBeFocused();
        await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
        await expect(separator).toHaveCount(0);
        await expect(item).toBeVisible();
        await page.setViewportSize({ width: 1366, height: 1400 });
        await expect(separator).toBeVisible();
        expect(await submenu.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(360);
        await page.reload();
        await expect(separator).toHaveAttribute('aria-valuenow', '80');
    });
}
