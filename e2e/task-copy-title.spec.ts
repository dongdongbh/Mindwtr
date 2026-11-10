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


test('Copy task details includes organizing fields and checklist while title copying stays unchanged', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'details-task', title: 'Renew certificate', status: 'inbox', projectId: 'homeserver', startTime: '2026-11-16', dueDate: '2026-11-20T15:30:00+01:00' }],
        projects: [{ id: 'homeserver', title: 'Homeserver' }],
        settings: { language: 'en', keybindingStyle: 'standard' },
    });
    await page.addInitScript(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}');
        const task = data.tasks.find((candidate: { id: string }) => candidate.id === 'details-task');
        task.description = '  Check expiry first.\nKeep the backup.  ';
        task.checklist = [
            { id: 'backup', title: 'Back up', isCompleted: true },
            { id: 'renew', title: 'Renew', isCompleted: false },
        ];
        localStorage.setItem('mindwtr-data', JSON.stringify(data));
    });
    await page.goto('/?view=inbox');
    const task = page.locator('[data-task-id="details-task"] [data-task-view-toggle]');
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await task.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy task details', exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(clipboard).toBe('Renew certificate\n\nProject: Homeserver\nStart Date: 2026-11-16\nDue Date: 2026-11-20T15:30:00+01:00\n\n  Check expiry first.\nKeep the backup.  \n\n[x] Back up\n[ ] Renew');
    await expect(page.getByText('Task copied to clipboard', { exact: true })).toBeVisible();
    await task.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy Title', exact: true }).click();
    await expect.poll(clipboard).toBe('Renew certificate');
    await task.focus();
    await page.keyboard.press('Control+c');
    await expect.poll(clipboard).toBe('Renew certificate');
});
