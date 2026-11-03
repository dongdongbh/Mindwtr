import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('unused contexts and tags survive reload and a saved context is offered in the task editor', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'catalogue-task', title: 'Plan next visit', status: 'inbox' }],
        settings: { language: 'en' },
    });
    await page.goto('/?view=settings');
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    for (const [section, label, value] of [
        ['manageContexts', 'New context', 'garden'],
        ['manageTags', 'New tag', 'seasonal'],
    ]) {
        const heading = page.locator(`[data-settings-key="${section}"]`);
        await heading.click();
        await page.getByRole('textbox', { name: label, exact: true }).fill(value);
        await heading.locator('..').getByRole('button', { name: 'Add', exact: true }).click();
        await expect(page.getByRole('textbox', { name: label, exact: true })).toHaveValue('');
    }
    const savedNames = () => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data')!);
        const active = (entries: { token: string; deletedAt?: string }[] = []) =>
            entries.filter(entry => !entry.deletedAt).map(entry => entry.token);
        return {
            contexts: active(data.settings.taxonomy?.contexts),
            tags: active(data.settings.taxonomy?.tags),
            assigned: data.tasks[0].contexts,
        };
    });
    await expect.poll(savedNames).toEqual({ contexts: ['@garden'], tags: ['#seasonal'], assigned: [] });
    await page.goto('/?view=inbox');
    await page.getByText('Plan next visit', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Contexts…', exact: true }).click();
    await page.getByRole('textbox', { name: 'Contexts', exact: true }).fill('gard');
    await page.getByRole('option', { name: '@garden', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(savedNames).toEqual({ contexts: ['@garden'], tags: ['#seasonal'], assigned: ['@garden'] });
});
