import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('partial Focus work survives pause, resume and completing the linked task', async ({ page }, testInfo) => {
    await page.clock.install({ time: new Date('2026-11-16T10:00:00Z') });
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'work', title: 'Read the proposal', status: 'next', isFocusedToday: true }],
        settings: { features: { pomodoro: true }, gtd: { pomodoro: { linkTask: true, completionAlert: false } } },
    });
    await page.goto('/?view=agenda');
    await page.getByRole('button', { name: 'Timer task', exact: true }).click();
    await page.getByRole('option', { name: 'Read the proposal', exact: true }).click();
    const timer = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Pomodoro Focus', exact: true }) });
    await timer.getByRole('button', { name: 'Start', exact: true }).click();
    await page.clock.fastForward(8 * 60 * 1000);
    await timer.getByRole('button', { name: 'Pause', exact: true }).click();
    const savedTask = () => page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data') || '{}').tasks?.find((task: { id: string }) => task.id === 'work'));
    await expect.poll(async () => (await savedTask())?.timeSpentMinutes).toBe(8);
    await page.clock.fastForward(10 * 60 * 1000);
    await timer.getByRole('button', { name: 'Start', exact: true }).click();
    await page.clock.fastForward(4 * 60 * 1000);
    await page.getByRole('button', { name: 'Mark task done', exact: true }).click();
    await expect.poll(async () => {
        const task = await savedTask();
        return { status: task?.status, minutes: task?.timeSpentMinutes };
    }).toEqual({ status: 'done', minutes: 12 });
    await expect(timer.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Timer task', exact: true })).toContainText('Timer only');
    await page.screenshot({ path: testInfo.outputPath('partial-work-recorded.png') });
    await page.reload();
    await expect.poll(async () => (await savedTask())?.timeSpentMinutes).toBe(12);
    await expect(timer.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
});

test('a recovered linked timer settles when its task is completed in Inbox', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-11-16T10:00:00Z') });
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'captured', title: 'Read captured note', status: 'inbox' }],
        settings: { features: { pomodoro: true }, gtd: { pomodoro: { linkTask: true, completionAlert: false } } },
    });
    await page.addInitScript(() => {
        if (localStorage.getItem('mindwtr:pomodoro:session:v1')) return;
        localStorage.setItem('mindwtr:pomodoro:session:v1', JSON.stringify({
            durations: { focusMinutes: 25, breakMinutes: 5 },
            timerState: { phase: 'focus', remainingSeconds: 1500, isRunning: true, completedFocusSessions: 0 },
            selectedTaskId: 'captured', updatedAtMs: Date.now(), workSecondsByTaskId: {},
            sessionHistory: { totalCompletedFocusSessions: 0, completedFocusSessionsByTaskId: {} },
        }));
    });
    await page.goto('/?view=inbox');
    const row = page.locator('[data-task-id="captured"]');
    await expect(row).toBeVisible();
    await page.clock.fastForward(12 * 60 * 1000);
    await row.locator('[data-task-complete]').click();
    await expect.poll(() => page.evaluate(() => {
        const task = JSON.parse(localStorage.getItem('mindwtr-data') || '{}').tasks?.find((item: { id: string }) => item.id === 'captured');
        return { status: task?.status, minutes: task?.timeSpentMinutes };
    })).toEqual({ status: 'done', minutes: 12 });
    await expect.poll(() => page.evaluate(() => {
        const session = JSON.parse(localStorage.getItem('mindwtr:pomodoro:session:v1') || '{}');
        return { running: session.timerState?.isRunning, linked: session.selectedTaskId };
    })).toEqual({ running: false, linked: undefined });
});
