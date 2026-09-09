import { test, expect } from '@playwright/test';
import { dismissOnboarding, seedAppData, seedTasks } from './seed';

for (const locale of [
    { language: 'en', title: 'Someday/Maybe', density: 'Density', labels: ['Comfortable', 'Compact', 'Condensed'] },
    { language: 'de', title: 'Irgendwann/Vielleicht', density: 'Dichte', labels: ['Komfortabel', 'Kompakt', 'Verdichtet'] },
]) {
    test(`Someday density layout stays stable across widths (${locale.language})`, async ({ page }, testInfo) => {
        await dismissOnboarding(page);
        await page.addInitScript((language) => localStorage.setItem('mindwtr-language', language), locale.language);
        await seedAppData(page, {
            tasks: seedTasks('Someday layout', 29, { status: 'someday' }),
            settings: { appearance: { density: 'comfortable' } },
        });
        await page.goto('/');
        await page.locator('[data-sidebar-item][data-view="someday"]').click();
        const header = page.locator('header').filter({ has: page.getByRole('heading', { name: locale.title, exact: true }) });
        const density = header.getByTitle(locale.density, { exact: true });
        await expect(density).toHaveAccessibleName(locale.labels[0]);
        await page.evaluate(() => document.fonts.ready);

        for (const width of [1758, 1920, 1440, 1280, 800]) {
            await page.setViewportSize({ width, height: 900 });
            const boxes = () => header.locator('button').evaluateAll((buttons) => buttons.map((button) => {
                const { x, y, width, height } = button.getBoundingClientRect();
                return { x, y, width, height };
            }));
            const before = await boxes();
            for (const label of [locale.labels[1], locale.labels[2], locale.labels[0]]) {
                await density.click();
                await expect(density).toHaveAccessibleName(label);
                expect(await boxes(), `toolbar geometry at ${width}px in ${label}`).toEqual(before);
            }
            const bounds = await header.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
            await page.screenshot({ path: testInfo.outputPath(`toolbar-${width}.png`) });
        }
    });
}
