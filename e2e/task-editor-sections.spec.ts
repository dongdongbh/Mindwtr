import { expect, test, type Locator } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

async function sectionGeometry(header: Locator) {
    return header.evaluate((button) => {
        const section = button.parentElement!;
        let top = 0;
        let bottom = window.innerHeight;
        let availableHeight = window.innerHeight;
        for (let parent = section.parentElement; parent; parent = parent.parentElement) {
            if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
                const rect = parent.getBoundingClientRect();
                top = Math.max(top, rect.top + parent.clientTop);
                bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
                availableHeight = Math.min(availableHeight, parent.clientHeight);
            }
        }
        const rect = section.getBoundingClientRect();
        const headerRect = button.getBoundingClientRect();
        return {
            fits: rect.height <= availableHeight,
            sectionVisible: rect.top >= top - 1 && rect.bottom <= bottom + 1,
            headerVisible: headerRect.top >= top - 1 && headerRect.bottom <= bottom + 1,
            headerHeight: headerRect.height,
            top, bottom, availableHeight, sectionTop: rect.top, sectionBottom: rect.bottom,
        };
    });
}

for (const presentation of ['inline', 'modal']) {
    for (const height of presentation === 'modal' ? [900, 500, 300] : [900, 500]) {
        test(`${presentation} editor sections at ${height}px`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width: 1280, height: 900 });
            await dismissOnboarding(page);
            await seedAppData(page, {
                tasks: [{ id: 'editor-task', title: 'Plan the garden', status: 'inbox', startTime: '2026-10-01' }],
                settings: { gtd: { taskEditor: { presentation } } },
            });
            await page.goto('/');
            await page.locator('[data-sidebar-item][data-view="inbox"]').click();
            await page.getByText('Plan the garden', { exact: true }).dblclick();
            const editor = page.locator('form').filter({ has: page.getByRole('combobox', { name: 'Title', exact: true }) });
            const scheduling = editor.getByRole('button', { name: /^Scheduling/ });
            const details = editor.getByRole('button', { name: /^Details/ });
            await expect(scheduling).toHaveAttribute('aria-expanded', 'true');
            await expect(details).toHaveAttribute('aria-expanded', 'false');

            // Populated sections open once; later edits respect manual collapse.
            await scheduling.click();
            await editor.getByRole('combobox', { name: 'Title', exact: true }).fill('Plan the spring garden');
            await expect(scheduling).toHaveAttribute('aria-expanded', 'false');

            await page.setViewportSize({ width: 1280, height });

            // The padding is part of the target, including just below the border.
            expect((await sectionGeometry(details)).headerHeight).toBeGreaterThanOrEqual(40);
            await details.click({ position: { x: 10, y: 3 } });
            await expect(details).toHaveAttribute('aria-expanded', 'true');
            await expect.poll(async () => {
                const geometry = await sectionGeometry(details);
                return geometry.fits ? geometry.sectionVisible : geometry.headerVisible;
            }).toBe(true);
            await expect(details).toBeFocused();
            await page.screenshot({ path: testInfo.outputPath(`${presentation}-${height}-details.png`) });

            // Keyboard opening also reveals the section and retains toggle focus.
            await details.press('Space');
            await scheduling.focus();
            await scheduling.press('Enter');
            await expect(scheduling).toHaveAttribute('aria-expanded', 'true');
            await expect.poll(async () => {
                const geometry = await sectionGeometry(scheduling);
                return geometry.fits ? geometry.sectionVisible : geometry.headerVisible;
            }).toBe(true);
            await expect(scheduling).toBeFocused();
            await editor.getByRole('button', { name: 'Save', exact: true }).click();
            await page.setViewportSize({ width: 1280, height: 900 });
            await expect(page.getByText('Plan the spring garden', { exact: true })).toBeVisible();
            await page.getByText('Plan the spring garden', { exact: true }).dblclick();
            await expect(scheduling).toHaveAttribute('aria-expanded', 'true');
            await expect(details).toHaveAttribute('aria-expanded', 'false');
            await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
        });
    }
}
