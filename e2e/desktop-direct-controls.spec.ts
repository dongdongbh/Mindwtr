import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData, seedTheme } from './seed';

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
        for (const route of ['agenda', 'inbox', 'next', 'someday', 'waiting', 'done', 'archived', 'reference', 'contexts', 'review']) {
            await page.setViewportSize({ width: 1440, height: 900 });
            await page.goto(`/?view=${route}`);
            // A full navigation reloads Vite's module graph. Wait for the app
            // shell before applying the normal five-second control assertions.
            await page.locator('#main-content').waitFor({ state: 'visible', timeout: 15_000 });
            const sort = page.getByRole('combobox', { name: 'Sort', exact: true });
            const group = page.getByRole('combobox', { name: route === 'agenda' ? 'Group next actions by' : 'Group', exact: true });
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
        await page.goto('/?view=agenda');
        const focusSort = page.getByRole('combobox', { name: 'Sort', exact: true });
        await focusSort.click();
        await page.locator('[role="option"][data-value="due"]').click();
        await expect(focusSort).toBeFocused();
        await expect(focusSort).toContainText('Due date');
        await expect(focusSort).toHaveClass(/(?:^|\s)border-primary(?:\s|$)/);
        const focusGroup = page.getByRole('combobox', { name: 'Group next actions by', exact: true });
        await focusGroup.click();
        const areaOption = page.locator('[role="option"][data-value="area"]');
        const areaLabel = await areaOption.innerText();
        await areaOption.click();
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr:list-options:v1') ?? '{}').focusGroupBy)).toBe('area');
        await page.reload();
        // Focus sort is intentionally view-local; grouping retains its existing
        // persisted preference. Exposing controls must not change either rule.
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
