import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('mouse Back and Forward stay inside Mindwtr and restore the selected context', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Mouse side buttons are dispatched through Chromium DevTools.');
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'call', title: 'Call the clinic', status: 'next', contexts: ['@phone'] }],
        settings: { savedSearches: [{ id: 'calls', name: 'Calls', query: 'clinic' }] },
    });
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto('/?view=inbox');
    await page.locator('[data-sidebar-item][data-view="contexts"]').click();
    const phone = page.locator('[data-context-navigation-root]').getByRole('button', { name: '@phone (1)' });
    await phone.click();
    await page.getByRole('button', { name: 'Calls', exact: true }).click();
    await expect(page).toHaveURL(/view=savedSearch(%3A|:)calls/);

    const mouse = await page.context().newCDPSession(page);
    const pressSideButton = async (button: 'back' | 'forward') => {
        const point = { x: 900, y: 500, button, clickCount: 1 };
        await mouse.send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed', buttons: button === 'back' ? 8 : 16 });
        await mouse.send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', buttons: 0 });
    };

    await pressSideButton('back');
    await expect(phone).toHaveAttribute('aria-pressed', 'true');
    await pressSideButton('forward');
    await expect(page).toHaveURL(/view=savedSearch(%3A|:)calls/);
    await expect(page.getByText('Call the clinic', { exact: true })).toBeVisible();
});
