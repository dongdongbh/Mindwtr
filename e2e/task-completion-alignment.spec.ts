import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

for (const density of ['comfortable', 'compact', 'condensed']) {
    test(`project completion circle fills on hover and keyboard focus at ${density} density`, async ({ page }, testInfo) => {
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
        const idleFill = await button.evaluate(element => getComputedStyle(element).backgroundColor);
        for (const state of ['hover', 'focus']) {
            if (state === 'hover') await button.hover();
            else {
                await page.mouse.move(0, 0);
                await page.keyboard.press('Tab');
                await button.focus();
            }
            await expect(button.locator('svg')).toBeHidden();
            await expect(button).not.toHaveCSS('background-color', idleFill);
            if (state === 'focus') {
                expect(await button.evaluate(element => element.matches(':focus-visible'))).toBe(true);
            }
        }
        await button.screenshot({ path: testInfo.outputPath(`completion-${density}.png`) });
    });
}
