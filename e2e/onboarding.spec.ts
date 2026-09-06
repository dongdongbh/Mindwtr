import { expect, test } from '@playwright/test';

// No fixture and no dismissal flag: first run is exactly the empty profile the
// other specs seed past, so this is the one walk that sees the modal at all.
test('first run offers the three onboarding choices and stays dismissed', async ({ page }) => {
    await page.goto('/');

    const onboarding = page.getByRole('dialog', { name: 'Welcome to Mindwtr' });
    await expect(onboarding).toBeVisible();
    await expect(onboarding.getByRole('button', { name: /Set up sync/ })).toBeVisible();
    await expect(onboarding.getByRole('button', { name: /Import tasks/ })).toBeVisible();
    await expect(onboarding.getByRole('button', { name: /Start fresh/ })).toBeVisible();

    await onboarding.getByRole('button', { name: 'Skip for now' }).click();
    await expect(onboarding).toBeHidden();

    // The profile is still empty, so only the persisted dismissal can keep the
    // modal away on the next launch.
    await page.reload();
    await expect(page.locator('[data-sidebar-item][data-view="agenda"]')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Welcome to Mindwtr' })).toHaveCount(0);
});
