import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

const PROJECT_TITLE = 'Kitchen Renovation';
const TASK_TITLE = 'E2E Clarify Task';

test('quick processing keeps each new title visible after fresh captures', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await dismissOnboarding(page);
    await seedAppData(page, { tasks: [], settings: { language: 'en' } });
    await page.goto('/?view=inbox');

    const capture = page.getByPlaceholder(/Add Task.*Call mom/);
    for (let index = 1; index <= 5; index += 1) {
        await capture.fill(`Capture ${index}`);
        await capture.press('Enter');
        await expect(capture).toHaveValue('');
    }
    await page.getByRole('button', { name: 'Process Inbox (5)' }).click();
    await page.getByRole('button', { name: 'Quick', exact: true }).click();

    const title = page.getByRole('textbox', { name: 'Title', exact: true });
    const next = page.getByRole('button', { name: 'Next', exact: true });
    for (let index = 0; index < 3; index += 1) {
        const previousTitle = await title.inputValue();
        await next.scrollIntoViewIfNeeded();
        expect((await title.boundingBox())!.y).toBeLessThan(0);
        await next.click();
        await expect(title).not.toHaveValue(previousTitle);

        await page.waitForTimeout(500);
        await expect(title).toBeInViewport({ ratio: 1 });
    }
});


const chooseAtStep = async (page: Page, step: string, choice: string) => {
    const main = page.getByRole('main');
    await expect(main.getByText(step, { exact: true })).toBeVisible();
    await main.getByRole('button', { name: choice, exact: true }).click();
};

test('clarifies an inbox capture into a project next action', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, { projects: [{ id: 'project-kitchen', title: PROJECT_TITLE }] });
    await page.goto('/');

    const inboxNav = page.locator('[data-sidebar-item][data-view="inbox"]');
    await inboxNav.click();
    await expect(inboxNav).toHaveAttribute('aria-current', 'page');

    const quickAddInput = page.getByPlaceholder(/add task/i);
    await quickAddInput.fill(TASK_TITLE);
    await quickAddInput.press('Enter');
    await expect(page.locator('[data-task-id]', { hasText: TASK_TITLE })).toBeVisible();

    await page.getByRole('button', { name: 'Process Inbox (1)' }).click();

    await chooseAtStep(page, 'Refine the task', 'Next');
    await chooseAtStep(page, 'Is this actionable?', "Yes, it's actionable");
    await chooseAtStep(page, 'More than one step?', 'No, single action');
    await chooseAtStep(page, 'Will it take less than 2 minutes?', 'Takes longer');
    await chooseAtStep(page, "What's next?", "I'll do it");
    await chooseAtStep(page, 'Contexts', 'Next (No context)');
    await chooseAtStep(page, 'Assign to a project?', PROJECT_TITLE);


    await expect(page.locator('[data-task-id]', { hasText: TASK_TITLE })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Process Inbox/ })).toHaveCount(0);

    await page.goto('/?view=next');
    await expect(page.locator('[data-task-id]', { hasText: TASK_TITLE })).toBeVisible();


    const clarified = await page.evaluate((title: string) => {
        const raw = window.localStorage.getItem('mindwtr-data');
        const tasks = raw ? (JSON.parse(raw).tasks as Array<Record<string, string>>) : [];
        return tasks.find((task) => task.title === title) ?? null;
    }, TASK_TITLE);
    expect(clarified).toMatchObject({ status: 'next', projectId: 'project-kitchen' });
});
