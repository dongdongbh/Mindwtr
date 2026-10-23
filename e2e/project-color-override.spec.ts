import { expect, test } from '@playwright/test';
import { dismissOnboarding } from './seed';

test('project color persists an explicit matching hue and resets to live Area inheritance', async ({ page }) => {
    await dismissOnboarding(page);
    await page.addInitScript(() => {
        if (localStorage.getItem('mindwtr-data')) return;
        const stamp = '2026-10-01T12:00:00.000Z';
        const base = { createdAt: stamp, updatedAt: stamp };
        localStorage.setItem('mindwtr-data', JSON.stringify({
            tasks: [], sections: [], people: [], settings: { language: 'en' },
            areas: [{ ...base, id: 'work', name: 'Work', color: '#3b82f6' }],
            projects: [{ ...base, id: 'alpha', title: 'Alpha project', status: 'active', areaId: 'work', color: '#3b82f6' }],
        }));
    });
    const openDetails = async () => {
        await page.locator('[data-project-navigation-item][data-project-id="alpha"]').click();
        const details = page.locator('[data-project-workspace]').getByRole('button', { name: 'Details', exact: true });
        if (await details.getAttribute('aria-expanded') !== 'true') await details.click();
    };
    const savedOverride = () => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data')!).projects[0].colorOverride);
    await page.goto('/?view=projects');
    await openDetails();
    const color = page.locator('[data-project-workspace]').getByRole('button', { name: 'Color', exact: true });
    await color.click();
    await page.getByRole('button', { name: 'Color: #3b82f6', exact: true }).click();
    await expect.poll(savedOverride).toBe('#3b82f6');
    await page.reload();
    await openDetails();
    await expect.poll(savedOverride).toBe('#3b82f6');
    // Simulate the persisted Area recolor arriving from another client.
    await page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data')!);
        data.areas[0].color = '#ef4444';
        localStorage.setItem('mindwtr-data', JSON.stringify(data));
    });
    await page.reload();
    await openDetails();
    await expect.poll(savedOverride).toBe('#3b82f6');
    await color.click();
    await page.getByRole('button', { name: 'Use Area color', exact: true }).click();
    await expect.poll(savedOverride).toBeNull();
    await page.reload();
    await openDetails();
    await expect.poll(savedOverride).toBeNull();
    await expect(page.locator('[data-project-workspace]').getByText('Use Area color', { exact: true })).toBeVisible();
    await expect(page.locator('.project-details-header [style*="background-color"]').first()).toHaveCSS('background-color', 'rgb(239, 68, 68)');
});
