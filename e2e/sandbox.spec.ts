import { test, expect, type Page } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

const openSandbox = async (page: Page) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^Data\b/ }).click();
    await page.locator('[data-open-sandbox]').click();
    await expect(page.getByRole('dialog')).toContainText('record a bug or give a demo');
    await page.locator('[data-sandbox-confirm-enter]').click();
    await expect(page.locator('[data-sandbox-banner]')).toContainText('Sandbox · Sample data');
};

const personalEntities = (page: Page) => page.evaluate(() => {
    const { tasks, projects, areas, sections, people } = JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}');
    return { tasks, projects, areas, sections, people };
});

const openInbox = async (page: Page) => {
    await page.locator('[data-sidebar-item][data-view="inbox"]').click();
};

test('sandbox editing, reset and exit preserve the personal workspace', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    page.setDefaultTimeout(10_000);
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'personal-sentinel', title: 'Personal workspace sentinel 1196', status: 'inbox', projectId: 'personal-project' }],
        projects: [{ id: 'personal-project', title: 'Personal project sentinel 1196' }],
        settings: { theme: 'dark', appearance: { textSize: 'large' } },
    });
    await page.goto('/');
    await openInbox(page);
    await expect(page.locator('[data-task-id="personal-sentinel"]')).toBeVisible();
    const before = await personalEntities(page);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /^Data\b/ }).click();
    await page.locator('[data-open-sandbox]').click();
    await page.locator('[data-sandbox-confirm-cancel]').click();
    await expect(page.locator('[data-sandbox-banner]')).toHaveCount(0);
    expect(await personalEntities(page)).toEqual(before);
    await openInbox(page);

    await openSandbox(page);
    await openInbox(page);
    await expect(page.locator('[data-task-id="personal-sentinel"]')).toHaveCount(0);
    await expect(page.locator('[data-task-id]').first()).toBeVisible();
    expect(await personalEntities(page)).toEqual(before);

    const addedTitle = 'Only in this sandbox 1196';
    const input = page.getByRole('combobox', { name: 'Add Task', exact: true });
    await input.fill(addedTitle);
    await input.press('Enter');
    await expect(page.locator('[data-task-id]', { hasText: addedTitle })).toBeVisible();
    expect(await personalEntities(page)).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath('sandbox-desktop.png'), fullPage: true });

    await page.locator('[data-sandbox-reset]').click();
    await expect(page.locator('[data-sandbox-banner]')).toBeVisible();
    await openInbox(page);
    await expect(page.locator('[data-task-id]', { hasText: addedTitle })).toHaveCount(0);
    await expect(page.locator('[data-task-id]').first()).toBeVisible();
    expect(await personalEntities(page)).toEqual(before);

    await page.locator('[data-sandbox-exit]').click();
    await expect(page.locator('[data-sandbox-banner]')).toHaveCount(0);
    await openInbox(page);
    await expect(page.locator('[data-task-id="personal-sentinel"]')).toContainText('Personal workspace sentinel 1196');
    expect(await personalEntities(page)).toEqual(before);

    await openSandbox(page);
    await page.reload();
    await expect(page.locator('[data-sandbox-banner]')).toHaveCount(0);
    await openInbox(page);
    await expect(page.locator('[data-task-id="personal-sentinel"]')).toBeVisible();
    expect(await personalEntities(page)).toEqual(before);
});
