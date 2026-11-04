import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

for (const view of ['projects', 'contexts']) {
    test(`${view} keeps a separate collapsible pane and compact navigation`, async ({ page }) => {
        await dismissOnboarding(page);
        await seedAppData(page, {
            projects: Array.from({ length: 45 }, (_, index) => ({ id: `p${index}`, title: `Project ${index}` })),
            tasks: Array.from({ length: 45 }, (_, index) => ({ id: `t${index}`, title: `Task ${index}`, status: 'next', contexts: [`@context${index}`] })),
        });
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto(`/?view=${view}`);
        const navigation = page.locator(view === 'projects' ? '[data-project-navigation-root]' : '[data-context-navigation-root]');
        const globalNavigation = page.locator('[data-sidebar-nav]');
        await expect(navigation).toBeVisible();
        expect(await navigation.evaluate(element => element.closest('[data-sidebar-nav]'))).toBeNull();
        expect((await navigation.boundingBox())!.x).toBeGreaterThan((await globalNavigation.boundingBox())!.x);
        await expect(page.getByRole('separator', { name: 'Resize navigation and submenu' })).toHaveCount(0);
        const item = view === 'projects' ? navigation.locator('[data-project-navigation-item]').first() : navigation.getByRole('button', { name: '@context0 (1)' });
        await item.click();
        await page.getByRole('button', { name: `Collapse ${view} panel` }).click();
        await expect(navigation).toBeHidden();
        await page.reload();
        await expect(navigation).toBeHidden();
        await page.getByRole('button', { name: `Expand ${view} panel` }).click();
        await expect(navigation).toBeVisible();
        if (view === 'contexts') await expect(item).toHaveAttribute('aria-pressed', 'true');
        await page.setViewportSize({ width: 700, height: 768 });
        await expect(navigation).toBeHidden();
        if (view === 'contexts') {
            await expect(page.locator('#contexts-token-select')).toBeVisible();
            await page.locator('#contexts-token-select').selectOption('@context1');
            await expect(page.getByRole('heading', { name: '@context0 + @context1', exact: true })).toBeVisible();
            await expect(page.locator('[data-task-id]')).toHaveCount(0);
            await expect(page.getByText('No active tasks for this context', { exact: true })).toBeVisible();
        } else {
            await page.getByRole('button', { name: 'Expand projects panel' }).click();
            await expect(navigation).toBeVisible();
        }
        await page.setViewportSize({ width: 1600, height: 600 });
        await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
        await expect(navigation).toBeVisible();
        await expect(page.locator('[data-sidebar-item][data-view="projects"]')).toBeVisible();
    });
}
