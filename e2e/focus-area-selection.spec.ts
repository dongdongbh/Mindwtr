import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('Area selection hides Focus rows without releasing their global slots', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        areas: [{ id: 'work', name: 'Work' }, { id: 'private', name: 'Private' }, { id: 'empty', name: 'Empty area' }],
        projects: [{ id: 'work-project', title: 'Work project', areaId: 'work' }],
        tasks: [
            { id: 'work-direct', title: 'Work direct', status: 'next', areaId: 'work', isFocusedToday: true },
            { id: 'work-project-task', title: 'Work project task', status: 'next', projectId: 'work-project', isFocusedToday: true },
            { id: 'private-task', title: 'Private task', status: 'next', areaId: 'private', isFocusedToday: true },
            { id: 'private-next', title: 'Private next', status: 'next', areaId: 'private' },
        ],
        settings: { language: 'en', gtd: { focusTaskLimit: 3 } },
    });
    await page.goto('/?view=agenda');
    const section = page.getByTestId('todays-focus-section');
    await expect(section).toContainText('(3/3)');
    await expect(section.locator('[data-task-id]')).toHaveCount(3);
    const filter = page.getByRole('button', { name: 'Area filter', exact: true });
    await filter.click();
    const options = page.getByRole('group', { name: 'Area filter', exact: true });
    await options.getByRole('button', { name: 'Private', exact: true }).click();
    await filter.click();
    await expect(section.locator('[data-task-id="private-task"]')).toBeVisible();
    await expect(section.locator('[data-task-id="work-direct"]')).toHaveCount(0);
    await expect(section.locator('[data-task-id="work-project-task"]')).toHaveCount(0);
    await expect(section).toContainText('(3/3)');
    await expect(page.getByTestId('focus-hidden-by-area')).toHaveText('2 selected in other areas');
    await filter.click();
    await options.getByRole('button', { name: 'All areas', exact: true }).click();
    await options.getByRole('button', { name: 'Empty area', exact: true }).click();
    await filter.click();
    await expect(section).toBeVisible();
    await expect(section.locator('[data-task-id]')).toHaveCount(0);
    await expect(section).toContainText('(3/3)');
    await expect(page.getByTestId('focus-hidden-by-area')).toHaveText('3 selected in other areas');
    const starredIds = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data')!).tasks
        .filter((task: { isFocusedToday?: boolean }) => task.isFocusedToday)
        .map((task: { id: string }) => task.id).sort());
    expect(starredIds).toEqual(['private-task', 'work-direct', 'work-project-task']);
    await filter.click();
    await options.getByRole('button', { name: 'All areas', exact: true }).click();
    await filter.click();
    await expect(section.locator('[data-task-id]')).toHaveCount(3);
    await expect(page.getByTestId('focus-hidden-by-area')).toHaveCount(0);
});
