import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('copy with sidebar focus leaves the clipboard alone when no task is highlighted', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'context-copy', title: 'Unselected context task', status: 'next', contexts: ['@home'] }],
        settings: { language: 'en', keybindingStyle: 'standard' },
    });
    await page.goto('/?view=contexts');
    await expect(page.locator('[data-task-id="context-copy"]')).toBeVisible();
    await page.locator('[data-sidebar-item][data-view="contexts"]').focus();
    await page.evaluate(() => navigator.clipboard.writeText('Keep existing clipboard'));
    await page.keyboard.press('Control+c');

    await page.waitForTimeout(150);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Keep existing clipboard');
    await expect(page.getByText('Title copied', { exact: true })).toHaveCount(0);
});

test('task titles copy from the menu and selection without replacing editor text copy', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [
            { id: 'copy-first', title: 'First captured thought', status: 'inbox' },
            { id: 'copy-second', title: 'Second captured thought', status: 'inbox' },
        ],
        settings: { language: 'en', keybindingStyle: 'standard' },
    });
    await page.goto('/?view=inbox');
    const first = page.locator('[data-task-id="copy-first"] [data-task-view-toggle]');
    const second = page.locator('[data-task-id="copy-second"] [data-task-view-toggle]');
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    await first.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy Title', exact: true }).click();
    await expect.poll(clipboard).toBe('First captured thought');
    await expect(page.getByText('Title copied', { exact: true })).toBeVisible();

    await second.focus();
    await page.keyboard.press('Control+c');
    await expect.poll(clipboard).toBe('Second captured thought');

    await second.click({ modifiers: ['Control'] });
    await first.click({ modifiers: ['Control'] });
    const visibleTitles = await page.locator('[data-task-view-toggle]').allTextContents();
    await page.keyboard.press('Control+c');
    await expect.poll(clipboard).toBe(visibleTitles.map((title) => title.trim()).join('\n'));

    const input = page.locator('[data-main-content]').getByRole('combobox', { name: 'Add Task', exact: true });
    await input.fill('Ordinary editor text');
    await input.press('Control+a');
    await input.press('Control+c');
    await expect.poll(clipboard).toBe('Ordinary editor text');
});
