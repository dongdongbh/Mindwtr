import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding, seedAppData, seedTheme } from './seed';

const navigateWithinApp = async (page: Page, view: string) => {
    await page.evaluate((nextView) => {
        window.dispatchEvent(new CustomEvent('mindwtr:navigate', { detail: { view: nextView } }));
    }, view);
    await expect.poll(() => new URL(page.url()).searchParams.get('view')).toBe(view);
    await page.evaluate(() => new Promise(requestAnimationFrame));
};

for (const theme of ['dark', 'light']) {
    test(`desktop presentation controls are direct and responsive (${theme})`, async ({ page }, testInfo) => {
        test.setTimeout(90_000);
        await dismissOnboarding(page);
        await seedTheme(page, theme);
        await seedAppData(page, {
            tasks: [
                { id: 'next-direct', title: 'Write the proposal', status: 'next' },
                { id: 'inbox-direct', title: 'Check the letter', status: 'inbox' },
                { id: 'someday-direct', title: 'Learn pottery', status: 'someday' },
                { id: 'waiting-direct', title: 'Wait for the quote', status: 'waiting' },
                { id: 'reference-direct', title: 'Garden notes', status: 'reference' },
            ],
            settings: { appearance: { density: 'compact' }, gtd: { autoArchiveDays: 0 } },
        });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/?view=agenda');
        await page.locator('#main-content').waitFor({ state: 'visible', timeout: 15_000 });
        for (const route of ['agenda', 'inbox', 'next', 'someday', 'waiting', 'done', 'archived', 'reference', 'contexts', 'review']) {
            await page.setViewportSize({ width: 1440, height: 900 });
            if (route !== 'agenda') await navigateWithinApp(page, route);
            const sort = page.getByRole('combobox', { name: 'Sort', exact: true });
            const group = page.getByRole('combobox', { name: 'Group', exact: true });
            await expect(sort).toBeVisible();
            await expect(group).toBeVisible();
            await expect(page.getByRole('button', { name: 'View options', exact: true })).toHaveCount(0);
            for (const control of [sort, group]) {
                await expect(control).toBeVisible();
                await expect(control).not.toHaveClass(/(?:^|\s)border-primary(?:\s|$)/);
                await control.click();
                await expect(page.getByRole('listbox', { name: await control.getAttribute('aria-label') ?? '', exact: true })).toBeVisible();
                await page.keyboard.press('Escape');
                await expect(control).toBeFocused();
            }
            for (const width of [1440, 900, 600]) {
                await page.setViewportSize({ width, height: 900 });
                for (const control of [sort, group]) {
                    const bounds = await control.boundingBox();
                    expect(bounds).not.toBeNull();
                    expect(bounds!.x).toBeGreaterThanOrEqual(0);
                    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
                }
                expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
                if (['agenda', 'review', 'someday'].includes(route) && width !== 900) {
                    await page.screenshot({ path: testInfo.outputPath(`${route}-${theme}-${width}.png`) });
                }
            }
        }
        await navigateWithinApp(page, 'agenda');
        const focusSort = page.getByRole('combobox', { name: 'Sort', exact: true });
        await focusSort.click();
        await page.locator('[role="option"][data-value="due"]').click();
        await expect(focusSort).toBeFocused();
        await expect(focusSort).toContainText('Due date');
        await expect(focusSort).toHaveClass(/(?:^|\s)border-primary(?:\s|$)/);
        const focusGroup = page.getByRole('combobox', { name: 'Group', exact: true });
        await focusGroup.click();
        const areaOption = page.locator('[role="option"][data-value="area"]');
        const areaLabel = await areaOption.innerText();
        await areaOption.click();
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr:list-options:v1') ?? '{}').focusGroupBy)).toBe('area');
        await page.reload();


        await expect(focusSort).toContainText('Default');
        await expect(focusGroup).toContainText(areaLabel);
        await expect(focusGroup).toHaveClass(/(?:^|\s)border-primary(?:\s|$)/);
        const data = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}'));
        expect(data.tasks.map((task: { id: string }) => task.id).sort()).toEqual([
            'inbox-direct', 'next-direct', 'reference-direct', 'someday-direct', 'waiting-direct',
        ]);
        expect(data.settings.appearance.density).toBe('compact');
    });
}
