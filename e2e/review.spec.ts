import { expect, test, type Locator, type Page } from '@playwright/test';
import { dismissOnboarding, localDateKey, seedAppData, seedTasks } from './seed';

// Every bucket is seeded past any slice a step has ever applied, so a step that
// silently caps its list disagrees with its own header count and fails here.
const BUCKET_SIZE = 12;
// Deliberately not the default 3: the focus header must read the configured
// limit rather than a hardcoded one.
const FOCUS_LIMIT = 5;

const ADD_TO_FOCUS = "Add to today's focus";
const REMOVE_FROM_FOCUS = 'Remove from focus';

const seedReviewFixture = async (page: Page) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        settings: { gtd: { focusTaskLimit: FOCUS_LIMIT } },
        tasks: [
            ...seedTasks('Overdue', BUCKET_SIZE, { status: 'next', dueDate: localDateKey(-3) }),
            ...seedTasks('Due today', BUCKET_SIZE, { status: 'next', dueDate: localDateKey(0) }),
            ...seedTasks('Inbox item', BUCKET_SIZE, { status: 'inbox' }),
            ...seedTasks('Waiting on', BUCKET_SIZE, { status: 'waiting' }),
            ...seedTasks('Next action', BUCKET_SIZE, { status: 'next' }),
        ],
    });
};

const openDailyReview = async (page: Page): Promise<Locator> => {
    const reviewNav = page.getByRole('complementary').getByRole('button', { name: 'Review', exact: true });
    await expect(reviewNav).toBeVisible();
    await reviewNav.click();

    await page.getByRole('button', { name: 'Daily Review', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Daily Review' });
    await expect(dialog).toBeVisible();
    return dialog;
};

/**
 * The step header states a count; the step below it renders rows. They are two
 * derivations of the same bucket, so a slice applied to one and not the other
 * is exactly the drift this walk exists to catch.
 */
const expectHeaderCountToMatchRows = async (dialog: Locator, step: string) => {
    const header = dialog.locator('p', { hasText: /^\d+ tasks$/ });
    await expect(header, `${step} step should render one "<n> tasks" header`).toHaveCount(1);
    const headerCount = Number((await header.innerText()).trim().split(/\s+/)[0]);
    expect(headerCount, `${step} step header should count the seeded bucket`).toBeGreaterThanOrEqual(BUCKET_SIZE);
    await expect(
        dialog.locator('[data-task-id]'),
        `${step} step should render every task its header counts`,
    ).toHaveCount(headerCount);
};

const goToNextStep = async (dialog: Locator, expectedTitle: string) => {
    await dialog.getByRole('button', { name: 'Next Step' }).click();
    await expect(dialog.getByRole('heading', { name: expectedTitle, level: 1 })).toBeVisible();
};

test('daily review renders every task each step counts', async ({ page }) => {
    await seedReviewFixture(page);
    await page.goto('/');
    const dialog = await openDailyReview(page);

    await expect(dialog.getByRole('heading', { name: 'Today & Calendar', level: 1 })).toBeVisible();
    await expectHeaderCountToMatchRows(dialog, 'Today & Calendar');

    await goToNextStep(dialog, 'Process Inbox');
    await expectHeaderCountToMatchRows(dialog, 'Process Inbox');

    await goToNextStep(dialog, 'Waiting For');
    await expectHeaderCountToMatchRows(dialog, 'Waiting For');
});

test('daily review focus step honours the configured limit', async ({ page }) => {
    await seedReviewFixture(page);
    await page.goto('/');
    const dialog = await openDailyReview(page);

    await goToNextStep(dialog, 'Process Inbox');
    await goToNextStep(dialog, 'Waiting For');
    await goToNextStep(dialog, 'Today’s Focus');

    const focusHeader = dialog.locator('p', { hasText: /^\d+ \/ \d+$/ });
    await expect(focusHeader).toHaveText(`0 / ${FOCUS_LIMIT}`);

    const addButtons = dialog.getByRole('button', { name: ADD_TO_FOCUS });
    await expect(addButtons.first()).toBeEnabled();
    const candidateCount = await addButtons.count();
    expect(candidateCount, 'focus step should offer more candidates than the limit').toBeGreaterThan(FOCUS_LIMIT);

    for (let starred = 0; starred < FOCUS_LIMIT; starred += 1) {
        await addButtons.first().click();
        await expect(focusHeader).toHaveText(`${starred + 1} / ${FOCUS_LIMIT}`);
    }

    await expect(dialog.getByRole('button', { name: REMOVE_FROM_FOCUS })).toHaveCount(FOCUS_LIMIT);
    await expect(addButtons.first(), 'starring must stop at the configured limit').toBeDisabled();
});


test('daily review focus cards show dates without changing the star action', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        settings: { language: 'en', dateFormat: 'ymd' },
        tasks: [
            { id: 'focus-dated', title: 'Send revised proposal', status: 'next', dueDate: localDateKey(-1), startTime: localDateKey(-2) },
            { id: 'focus-undated', title: 'Choose a book', status: 'next' },
        ],
    });
    await page.goto('/');
    const dialog = await openDailyReview(page);
    await dialog.getByRole('button', { name: 'Next Step' }).click();
    await expect(dialog.getByRole('heading', { name: 'Today’s Focus', level: 1 })).toBeVisible();
    const card = dialog.locator('div.rounded-lg').filter({ hasText: 'Send revised proposal' }).filter({ has: page.getByRole('button', { name: /Add to today's focus|Remove from focus/ }) });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(localDateKey(-1));
    await expect(card).toContainText(localDateKey(-2));
    await card.getByRole('button', { name: ADD_TO_FOCUS }).click();
    await expect(card.getByRole('button', { name: REMOVE_FROM_FOCUS })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data')!);
        return data.tasks.find((task: { id: string }) => task.id === 'focus-dated').isFocusedToday;
    })).toBe(true);
});


test('weekly review confirms remaining work and completes a project in place', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        settings: { language: 'en', ai: { enabled: false } },
        projects: [{ id: 'review-project', title: 'Prepare garden' }],
        tasks: [{ id: 'future-work', title: 'Plant in spring', status: 'next', projectId: 'review-project', startTime: localDateKey(90) }],
    });
    await page.goto('/?view=review');
    await page.getByRole('button', { name: 'Weekly Review', exact: true }).click();
    const complete = page.getByRole('button', { name: 'Complete project', exact: true });
    for (let step = 0; step < 8 && !(await complete.isVisible()); step += 1) {
        await page.getByRole('button', { name: /Next/ }).last().click();
    }
    await complete.click();
    await expect(page.getByText('Mark this project completed and finish all its tasks?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(complete).toBeEnabled();
    await complete.click();
    await page.getByRole('dialog').filter({ hasText: 'Mark this project completed and finish all its tasks?' }).getByRole('button', { name: 'Complete project', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review Projects', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data')!);
        return [data.projects.find((p: { id: string }) => p.id === 'review-project').status,
            data.tasks.find((t: { id: string }) => t.id === 'future-work').status];
    })).toEqual(['archived', 'done']);
});
