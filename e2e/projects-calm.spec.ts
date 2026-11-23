import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedTheme } from './seed';

for (const theme of ['dark', 'light']) {
    test(`Projects keeps navigation compact and organization accessible (${theme})`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await dismissOnboarding(page);
        await seedTheme(page, theme);
        await page.addInitScript(() => {
            if (localStorage.getItem('mindwtr-data')) return;
            const stamp = '2026-09-17T12:00:00.000Z';
            const base = { createdAt: stamp, updatedAt: stamp };
            localStorage.setItem('mindwtr:view:projects:v1', JSON.stringify({ showDeferredProjects: true }));
            localStorage.setItem('mindwtr-data', JSON.stringify({
                tasks: [
                    { ...base, id: 'design-action', title: 'Agree the refund contract', status: 'next', projectId: 'payments', sectionId: 'design', contexts: ['@computer'], tags: [] },
                    { ...base, id: 'build-action', title: 'Build the partial refund endpoint', status: 'next', projectId: 'payments', sectionId: 'build', contexts: [], tags: ['deep-work'] },
                    { ...base, id: 'done-action', title: 'Write the migration checklist', status: 'done', completedAt: stamp, projectId: 'payments', sectionId: 'design', contexts: [], tags: [] },
                    { ...base, id: 'waiting-tom', title: 'Quote from Tom', status: 'waiting', assignedTo: 'Tom', contexts: [], tags: [] },
                    { ...base, id: 'waiting-maya', title: 'Reply from Maya', status: 'waiting', assignedTo: 'Maya', contexts: [], tags: [] },
                ],
                projects: [
                    { ...base, id: 'payments', title: 'Payments API v2', status: 'active', areaId: 'work', color: '#4f8cf7', isFocused: true, isSequential: true, tagIds: ['deep-work'], startDate: '2026-09-01', dueDate: '2026-10-20', reviewAt: '2026-10-10T12:00:00.000Z', supportNotes: '## Why\nSupport partial refunds without a manual workaround.' },
                    { ...base, id: 'hiring', title: 'Hire a backend engineer', status: 'active', areaId: 'work', color: '#4f8cf7' },
                    { ...base, id: 'garden', title: 'Build a kitchen garden', status: 'active', areaId: 'home', color: '#f59e0b', isFocused: true },
                    { ...base, id: 'conference', title: 'Prepare a conference talk', status: 'someday', areaId: 'work', color: '#4f8cf7' },
                ],
                sections: [{ ...base, id: 'design', projectId: 'payments', title: 'Design', order: 0 }, { ...base, id: 'build', projectId: 'payments', title: 'Build', order: 1 }],
                areas: [{ ...base, id: 'work', name: 'Work', color: '#4f8cf7' }, { ...base, id: 'home', name: 'Home', color: '#f59e0b' }],
                people: [], settings: { gtd: { autoArchiveDays: 0 } },
            }));
        });
        await page.goto('/?view=projects');
        const sidebar = page.locator('[data-project-navigation-root]');
        const project = page.locator('[data-project-navigation-item][data-project-id="payments"]');
        await project.click();
        const workspace = page.locator('[data-project-workspace]');
        await expect(workspace.getByText('Agree the refund contract', { exact: true })).toBeVisible();
        await expect(workspace.getByRole('button', { name: 'View options', exact: true })).toHaveCount(0);
        const sort = workspace.getByRole('combobox', { name: 'Sort', exact: true });
        await expect(sort).toBeVisible();
        await sort.click();
        await expect(page.getByRole('option', { name: 'Due date', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(sort).toBeFocused();
        await expect(sidebar.getByText('Agree the refund contract', { exact: true })).toHaveCount(0);
        const tagFilter = sidebar.getByRole('combobox', { name: 'Tag filter', exact: true });
        await expect(tagFilter).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(tagFilter).toHaveCSS('appearance', 'none');
        await expect(sidebar.getByRole('textbox', { name: 'Project Name', exact: true })).toHaveCount(0);
        const before = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data')!).projects);

        await sidebar.getByRole('button', { name: 'New project', exact: true }).click();
        const name = sidebar.getByRole('textbox', { name: 'Project Name', exact: true });
        await expect(name).toBeFocused();
        await name.fill('Unsubmitted planning draft');
        await page.keyboard.press('Escape');
        await expect(name).toHaveCount(0);
        await sidebar.getByRole('button', { name: 'New project', exact: true }).click();
        await expect(name).toHaveValue('Unsubmitted planning draft');
        await page.keyboard.press('Escape');

        await page.screenshot({ path: testInfo.outputPath(`projects-${theme}-compact.png`) });
        await sidebar.getByRole('button', { name: 'Collapse projects panel' }).click();
        const expandPanel = workspace.locator('header').getByRole('button', { name: 'Expand projects panel' });
        await expect(expandPanel).toBeVisible();
        const panelTop = await expandPanel.evaluate(button => button.getBoundingClientRect().top);
        const notes = workspace.locator('[data-project-notes-disclosure]');
        await expect(notes).toHaveAttribute('aria-expanded', 'false');
        await notes.click();
        await expect(workspace.getByText('Support partial refunds without a manual workaround.', { exact: true })).toBeVisible();
        const details = workspace.locator('header').getByRole('button', { name: 'Details', exact: true });
        await details.click();
        await expect(workspace.getByText('Review Date', { exact: true })).toBeVisible();
        expect(await expandPanel.evaluate(button => button.getBoundingClientRect().top)).toBe(panelTop);
        await details.click();
        await notes.click();
        await expandPanel.click();
        await expect(sidebar).toBeVisible();
        await expect(workspace.getByText('Support partial refunds without a manual workaround.', { exact: true })).toHaveCount(0);

        const sectionMenu = workspace.getByRole('button', { name: 'More options: Design', exact: true });
        await sectionMenu.click();
        await expect(page.getByRole('menuitem', { name: /Move.*down.*Design/i })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(sectionMenu).toBeFocused();
        await page.setViewportSize({ width: 1440, height: 480 });
        await sectionMenu.click();
        const sectionMenuBounds = await page.getByRole('menu').boundingBox();
        expect(sectionMenuBounds).not.toBeNull();
        expect(sectionMenuBounds!.y).toBeGreaterThanOrEqual(0);
        expect(sectionMenuBounds!.y + sectionMenuBounds!.height).toBeLessThanOrEqual(480);
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 1440, height: 1000 });
        const taskMenu = workspace.locator('[data-project-task-toolbar]').getByRole('button', { name: /^More options:/ });
        await taskMenu.click();
        await expect(page.getByRole('menuitemcheckbox', { name: 'Columns', exact: true })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Add Section', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(taskMenu).toBeFocused();
        await taskMenu.click();
        await page.getByRole('menuitemcheckbox', { name: 'Columns', exact: true }).click();
        await expect(taskMenu).toBeFocused();
        await taskMenu.click();
        await expect(page.getByRole('menuitemcheckbox', { name: 'Columns', exact: true })).toHaveAttribute('aria-checked', 'true');
        await page.getByRole('menuitemcheckbox', { name: 'Columns', exact: true }).click();
        await workspace.locator('.project-details-header').getByRole('button', { name: 'Details', exact: true }).click();
        await expect(workspace.getByText('Review Date', { exact: true })).toBeVisible();
        const reviewDate = workspace.getByRole('textbox', { name: 'Review Date', exact: true });
        const reviewTime = workspace.locator('input[aria-describedby="project-review-date-hint"]');
        for (const width of [1920, 1280, 900, 1920]) {
            await page.setViewportSize({ width, height: 1000 });
            await reviewTime.focus();
            const date = (await reviewDate.boundingBox())!;
            const time = (await reviewTime.boundingBox())!;
            const dateFits = await reviewDate.evaluate(input => {
                const field = input as HTMLInputElement;
                const style = getComputedStyle(field);
                const context = document.createElement('canvas').getContext('2d')!;
                context.font = `${style.fontSize} ${style.fontFamily}`;
                return field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
                    >= context.measureText(field.value).width;
            });
            expect(dateFits, `Selected review date at ${width}px`).toBe(true);
            expect(time.x >= date.x + date.width + 4 || time.y >= date.y + date.height + 4).toBe(true);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({ path: testInfo.outputPath(`projects-${theme}-details.png`) });
        const after = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data')!).projects);
        expect(after).toEqual(before);
        await page.setViewportSize({ width: 900, height: 900 });
        await page.screenshot({ path: testInfo.outputPath(`projects-${theme}-narrow.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto('/?view=waiting');
        const who = page.getByRole('combobox', { name: 'Who? (optional)', exact: true });
        await expect(who).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(who).toHaveCSS('appearance', 'none');
        await who.selectOption('Tom');
        await expect(page.getByText('Quote from Tom', { exact: true })).toBeVisible();
        await expect(page.getByText('Reply from Maya', { exact: true })).toHaveCount(0);
        await who.selectOption('');
        await expect(page.getByText('Reply from Maya', { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`waiting-${theme}-quiet-filter.png`) });
    });
}
