import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('toolbar popovers own letter keys without mutating the task list behind them', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'protected-task', title: 'Protected task', status: 'next' }],
        settings: { keybindingStyle: 'standard' },
    });
    await page.goto('/?view=next');

    const task = page.locator('[data-task-id="protected-task"]');
    const sort = page.getByRole('combobox', { name: 'Sort', exact: true });
    await expect(task).toBeVisible();
    await sort.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox', { name: 'Sort', exact: true })).toBeVisible();

    await page.keyboard.press('e');

    await expect(task).toBeVisible();
    await expect(page.getByRole('listbox', { name: 'Sort', exact: true })).toBeVisible();
    const persistedTask = await page.evaluate(() => (
        JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').tasks
            .find((candidate: { id: string }) => candidate.id === 'protected-task')
    ));
    expect(persistedTask).toMatchObject({ status: 'next' });
    expect(persistedTask.deletedAt).toBeUndefined();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox', { name: 'Sort', exact: true })).toHaveCount(0);
    await expect(sort).toBeFocused();
});

const keyboardStyles = [
    {
        style: 'standard',
        next: 'ArrowDown',
        previous: 'ArrowUp',
        navigateInbox: ['g', 'i'],
        search: '/',
    },
    {
        style: 'vim',
        next: 'j',
        previous: 'k',
        navigateInbox: ['g', 'i'],
        search: '/',
    },
    {
        style: 'emacs',
        next: 'Control+n',
        previous: 'Control+p',
        navigateInbox: ['Alt+i'],
        search: 'Control+s',
    },
] as const;

for (const keys of keyboardStyles) {
    test(`${keys.style} navigation reaches visible sidebar, list, project, search, and capture targets`, async ({ page }) => {
        await dismissOnboarding(page);
        await seedAppData(page, {
            tasks: [
                { id: 'first-task', title: 'First task', status: 'next', projectId: 'alpha' },
                { id: 'second-task', title: 'Second task', status: 'next', projectId: 'beta' },
            ],
            projects: [
                { id: 'alpha', title: 'Alpha project' },
                { id: 'beta', title: 'Beta project' },
            ],
            settings: { keybindingStyle: keys.style },
        });
        await page.goto('/?view=next');

        const firstTask = page.locator('[data-task-id="first-task"] [data-task-view-toggle]');
        const secondTask = page.locator('[data-task-id="second-task"] [data-task-view-toggle]');
        await firstTask.focus();
        await page.keyboard.press(keys.next);
        await expect(secondTask).toBeFocused();
        await page.keyboard.press(keys.previous);
        await expect(firstTask).toBeFocused();

        const main = page.locator('[data-main-content]');
        await main.focus();
        for (const key of keys.navigateInbox) await page.keyboard.press(key);
        await expect(page.locator('[data-sidebar-item][data-view="inbox"]')).toHaveAttribute('aria-current', 'page');


        const inboxAddInput = main.getByRole('combobox', { name: 'Add Task', exact: true });
        await expect(inboxAddInput).toBeVisible();

        await main.focus();
        await page.keyboard.press(keys.search);
        const searchDialog = page.getByRole('dialog');
        await expect(searchDialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(searchDialog).toHaveCount(0);
        await expect(main).toBeFocused();

        await page.keyboard.press('a');
        await expect(inboxAddInput).toBeFocused();
        await expect(page.getByRole('dialog', { name: 'Add Task', exact: true })).toHaveCount(0);

        const contexts = page.locator('[data-sidebar-item][data-view="contexts"]');
        const more = page.getByRole('button', { name: 'More', exact: true });
        await expect(more).toHaveAttribute('aria-expanded', 'false');
        await contexts.focus();
        await page.keyboard.press(keys.next);
        await expect(more).toBeFocused();
        await page.keyboard.press(keys.next);
        await expect(more).toBeFocused();
        await more.press('Enter');
        await expect(more).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press(keys.next);
        await expect(page.locator('[data-sidebar-item][data-view="reference"]')).toBeFocused();
        await page.keyboard.press(keys.previous);
        await expect(more).toBeFocused();

        await page.goto('/?view=projects');
        const alpha = page.locator('[data-project-navigation-item][data-project-id="alpha"]');
        const beta = page.locator('[data-project-navigation-item][data-project-id="beta"]');
        await alpha.focus();
        await page.keyboard.press(keys.next);
        await expect(beta).toBeFocused();
        await page.keyboard.press(keys.previous);
        await expect(alpha).toBeFocused();
    });
}

test('direct toolbar controls and disclosures keep keyboard focus and shortcut state coherent', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'toolbar-task', title: 'Toolbar task', status: 'next' }],
        settings: {
            keybindingStyle: 'standard',
            appearance: { density: 'comfortable' },
            gtd: { taskEditor: { presentation: 'modal' } },
        },
    });
    await page.goto('/?view=next');

    const sort = page.getByRole('combobox', { name: 'Sort', exact: true });
    const initialSort = await sort.textContent();
    await sort.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(sort).toBeFocused();
    expect(await sort.textContent()).not.toBe(initialSort);
    const chosenSort = await sort.textContent();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(sort).toBeFocused();
    expect(await sort.textContent()).toBe(chosenSort);

    const group = page.getByRole('combobox', { name: 'Group', exact: true });
    const initialGroup = await group.textContent();
    await group.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(group).toBeFocused();
    expect(await group.textContent()).not.toBe(initialGroup);
    const chosenGroup = await group.textContent();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(group).toBeFocused();
    expect(await group.textContent()).toBe(chosenGroup);

    const filters = page.getByRole('button', { name: 'Filters', exact: true });
    await filters.focus();
    await filters.press('Enter');
    await expect(filters).toHaveAttribute('aria-expanded', 'true');
    await filters.press('Space');
    await expect(filters).toHaveAttribute('aria-expanded', 'false');
    await expect(filters).toBeFocused();

    const main = page.locator('[data-main-content]');
    await main.focus();
    await page.keyboard.press('Control+Shift+d');
    await expect(page.getByRole('button', { name: 'Hide details', exact: true })).toBeVisible();
    await page.keyboard.press('Control+Shift+c');
    await expect.poll(() => page.evaluate(() => (
        JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').settings.appearance.density
    ))).toBe('compact');

    await page.getByText('Toolbar task', { exact: true }).dblclick();
    const editor = page.getByRole('dialog').filter({ has: page.getByRole('combobox', { name: 'Title', exact: true }) });
    const title = editor.getByRole('combobox', { name: 'Title', exact: true });
    await title.fill('exdd remains text');
    await title.press('Control+Shift+c');
    await title.press('Control+Shift+d');
    await expect.poll(() => page.evaluate(() => (
        JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').settings.appearance.density
    ))).toBe('compact');
    await expect(page.getByRole('button', { name: 'Hide details', exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
        .getByRole('button', { name: 'Discard', exact: true })
        .click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByText('Toolbar task', { exact: true })).toBeVisible();

    await main.focus();
    await page.keyboard.press('Control+k');
    const searchDialog = page.getByRole('dialog');
    await expect(searchDialog).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('e');
    await page.keyboard.press('#');
    await page.keyboard.press('Escape');
    await expect(searchDialog).toHaveCount(0);
    const persistedTask = await page.evaluate(() => (
        JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').tasks
            .find((candidate: { id: string }) => candidate.id === 'toolbar-task')
    ));
    expect(persistedTask).toMatchObject({ status: 'next', title: 'Toolbar task' });
    expect(persistedTask.deletedAt).toBeUndefined();
});

test('project row controls, details, and menus stay separate from row selection', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [
            { id: 'alpha-task', title: 'Alpha action', status: 'next', projectId: 'alpha' },
            { id: 'beta-task', title: 'Beta action', status: 'next', projectId: 'beta' },
        ],
        projects: [
            { id: 'alpha', title: 'Alpha project' },
            { id: 'beta', title: 'Beta project' },
        ],
        settings: { keybindingStyle: 'vim' },
    });
    await page.goto('/?view=projects');

    const alpha = page.locator('[data-project-navigation-item][data-project-id="alpha"]');
    const beta = page.locator('[data-project-navigation-item][data-project-id="beta"]');
    await alpha.click();
    await expect(alpha).toHaveAttribute('aria-pressed', 'true');
    const betaStar = beta.getByRole('button', { name: 'Add to focus', exact: true });
    await betaStar.focus();
    await betaStar.press('Enter');
    await expect(beta.getByRole('button', { name: 'Remove from focus', exact: true })).toBeFocused();
    await expect(alpha).toHaveAttribute('aria-pressed', 'true');
    await expect(beta).toHaveAttribute('aria-pressed', 'false');

    const workspace = page.locator('[data-project-workspace]');
    const details = workspace.getByRole('button', { name: 'Details', exact: true });
    await details.focus();
    await details.press('Enter');
    await expect(details).toHaveAttribute('aria-expanded', 'true');
    await expect(details).toBeFocused();

    const menuTrigger = workspace.getByRole('button', { name: 'More options: Alpha project', exact: true });
    await menuTrigger.focus();
    await menuTrigger.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('e');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(menuTrigger).toBeFocused();

    const betaTask = await page.evaluate(() => (
        JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').tasks
            .find((candidate: { id: string }) => candidate.id === 'beta-task')
    ));
    expect(betaTask).toMatchObject({ status: 'next' });
    expect(betaTask.deletedAt).toBeUndefined();
});
