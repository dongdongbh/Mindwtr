import { test, expect } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('typing and selecting the same context store one canonical context', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, { tasks: [
        { id: 'typed-context-task', title: 'First context task', status: 'inbox' },
        { id: 'selected-context-task', title: 'Second context task', status: 'inbox' },
    ] });
    await page.goto('/');
    await page.locator('[data-sidebar-item][data-view="inbox"]').click();
    await page.getByText('First context task', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Contexts…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Contexts', exact: true }).fill('garden');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByText('Second context task', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Contexts…', exact: true }).click();
    await page.getByRole('button', { name: '@garden', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}');
        return ['typed-context-task', 'selected-context-task'].map((id) => data.tasks?.find((task: { id: string }) => task.id === id)?.contexts);
    })).toEqual([['@garden'], ['@garden']]);
});
