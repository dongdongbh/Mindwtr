import { test, expect } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('task menu creates a project without assigning the task until Save', async ({ page }, testInfo) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'menu-project-task', title: 'Plan the garden', status: 'inbox' }],
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.locator('[data-sidebar-item][data-view="inbox"]').click();
    await page.getByText('Plan the garden', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Project…', exact: true }).click();
    await page.getByRole('button', { name: 'No Project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search projects', exact: true }).fill('Garden redesign');
    await page.screenshot({ path: testInfo.outputPath('project-create-option.png') });
    await page.getByRole('option', { name: 'Create "Garden redesign"', exact: true }).click();
    const storedData = () => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}'));
    await expect.poll(async () => (await storedData()).projects?.some((project: { title: string }) => project.title === 'Garden redesign')).toBe(true);
    expect((await storedData()).tasks[0].projectId).toBeFalsy();
    await expect(page.getByRole('button', { name: 'Garden redesign', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await storedData()).tasks[0].projectId).toBeFalsy();
    await page.getByRole('menuitem', { name: 'Project…', exact: true }).click();
    await page.getByRole('button', { name: 'No Project', exact: true }).click();
    await page.getByRole('option', { name: 'Garden redesign', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => {
        const data = await storedData();
        return data.tasks[0].projectId === data.projects.find((project: { title: string }) => project.title === 'Garden redesign')?.id;
    }).toBe(true);
});
