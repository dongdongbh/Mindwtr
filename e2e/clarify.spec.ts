import { expect, test, type Page } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

const PROJECT_TITLE = 'Kitchen Renovation';
const TASK_TITLE = 'E2E Clarify Task';

/** Each guided step is identified by its own label before its choice is made. */
const chooseAtStep = async (page: Page, step: string, choice: string) => {
    await expect(page.getByText(step, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: choice, exact: true }).click();
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
    await chooseAtStep(page, 'Is this actionable?', "✅ Yes, it's actionable");
    await chooseAtStep(page, 'More than one step?', 'No, single action');
    await chooseAtStep(page, '⏱️ Will it take less than 2 minutes?', 'Takes longer');
    await chooseAtStep(page, "What's next?", "📋 I'll do it");
    await chooseAtStep(page, 'Where will you do this?', 'Next (No context)');
    await chooseAtStep(page, 'Assign to a project?', PROJECT_TITLE);

    // Clarifying the last capture ends the session and empties the Inbox.
    await expect(page.locator('[data-task-id]', { hasText: TASK_TITLE })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Process Inbox/ })).toHaveCount(0);

    await page.goto('/?view=next');
    await expect(page.locator('[data-task-id]', { hasText: TASK_TITLE })).toBeVisible();

    // The Next list hides the project badge unless row details are on, so the
    // project choice is read back from the persisted document instead.
    const clarified = await page.evaluate((title: string) => {
        const raw = window.localStorage.getItem('mindwtr-data');
        const tasks = raw ? (JSON.parse(raw).tasks as Array<Record<string, string>>) : [];
        return tasks.find((task) => task.title === title) ?? null;
    }, TASK_TITLE);
    expect(clarified).toMatchObject({ status: 'next', projectId: 'project-kitchen' });
});
