import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

for (const density of ['comfortable', 'compact', 'condensed']) {
    test(`project completion rings stay concentric at ${density} density`, async ({ page }, testInfo) => {
        await dismissOnboarding(page);
        await seedAppData(page, {
            projects: [{ id: 'alignment', title: 'Alignment project' }],
            tasks: [{ id: 'alignment-task', title: 'Check completion alignment', status: 'next', projectId: 'alignment' }],
            settings: { appearance: { density } },
        });
        await page.goto('/?view=projects');
        await page.locator('[data-project-navigation-item][data-project-id="alignment"]').click();
        const button = page.locator('[data-task-id="alignment-task"] [data-task-complete]');
        await expect(button).toBeVisible();
        for (const state of ['hover', 'focus']) {
            if (state === 'hover') await button.hover();
            else {
                await page.mouse.move(0, 0);
                await page.keyboard.press('Tab');
                await button.focus();
            }
            await expect(button.locator('svg')).toHaveCSS('opacity', '1');
            const offset = await button.evaluate((element) => {
                const outer = element.getBoundingClientRect();
                const inner = element.querySelector('svg')!.getBoundingClientRect();
                return Math.max(Math.abs(outer.x + outer.width / 2 - inner.x - inner.width / 2),
                    Math.abs(outer.y + outer.height / 2 - inner.y - inner.height / 2));
            });
            expect(offset).toBeLessThan(0.1);
        }
        await button.screenshot({ path: testInfo.outputPath(`completion-${density}.png`) });
    });
}
