import { expect, test } from '@playwright/test';

// No fixture and no dismissal flag: first run is exactly the empty profile the
// other specs seed past, so this is the one walk that sees the modal at all.
test('first run offers the three onboarding choices and stays dismissed', async ({ page }) => {
    await page.goto('/');

    const onboarding = page.getByRole('dialog', { name: 'Welcome to Mindwtr' });
    await expect(onboarding).toBeVisible();
    await expect(onboarding.getByRole('button', { name: /Set up sync/ })).toBeVisible();
    await expect(onboarding.getByRole('button', { name: /Import tasks/ })).toBeVisible();
    await expect(onboarding.getByRole('button', { name: /Start using Mindwtr/ })).toBeVisible();

    await onboarding.getByRole('button', { name: 'Skip for now' }).click();
    await expect(onboarding).toBeHidden();

    // The profile is still empty, so only the persisted dismissal can keep the
    // modal away on the next launch.
    await page.reload();
    await expect(page.locator('[data-sidebar-item][data-view="agenda"]')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Welcome to Mindwtr' })).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: /^Help:/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Help:/ })).toHaveCount(0);
});

test('Getting Started opens real capture, Inbox processing, and Focus', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Start using Mindwtr/ }).click();
    const actions = page.getByRole('region', { name: 'Getting Started', exact: true });
    await expect(actions).toBeVisible();
    await actions.getByRole('button', { name: 'Capture to Inbox', exact: true }).click();
    const capture = page.getByRole('dialog');
    await capture.getByPlaceholder('Add Task', { exact: true }).fill('Plan a weekend walk');
    await capture.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(capture).toBeHidden();
    await actions.getByRole('button', { name: 'Open Inbox', exact: true }).click();
    await expect(page.locator('[data-task-id]', { hasText: 'Plan a weekend walk' })).toBeVisible();
    // Learning actions live in onboarding, not persistent main-page panels.
    await expect(page.getByRole('complementary', { name: 'Help: Inbox' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Help: Inbox', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /Process Inbox \(3\)/ }).click();
    await expect(page.getByText('Refine the task', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Help: Inbox', exact: true })).toHaveCount(0);
    await page.locator('[data-sidebar-item][data-view="projects"]').click();
    await page.getByRole('button', { name: /Drag Add to focus Getting Started/ }).click();
    await actions.getByRole('button', { name: 'Open Focus', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Focus', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Help: Focus' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Help: Focus', exact: true })).toHaveCount(0);
});
