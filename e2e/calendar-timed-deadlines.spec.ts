import { expect, test } from '@playwright/test';
import { dismissOnboarding, localDateKey, seedAppData } from './seed';

test('timed deadlines stay separate from work blocks and open the same task', async ({ page }) => {
    const day = localDateKey();

    await page.clock.setFixedTime(new Date(`${day}T17:18:00`));
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [
            { id: 'proposal', title: 'Submit proposal', status: 'next', startTime: `${day}T10:00:00`, dueDate: `${day}T17:00:00` },
            { id: 'date-only', title: 'Date only deadline', status: 'next', dueDate: day },
            { id: 'midnight', title: 'Midnight deadline', status: 'next', dueDate: `${day}T00:00:00` },
        ],
        settings: { language: 'en', timeFormat: '24h' },
    });
    await page.goto('/?view=calendar');
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    const proposal = page.locator('[data-calendar-deadline-marker][data-task-id="proposal"]');
    await expect(proposal).toHaveCount(1);
    await expect(proposal).toContainText('17:00');
    await expect(page.locator('[data-calendar-block][data-task-id="proposal"]')).toHaveCount(1);
    await expect(page.locator('[data-calendar-deadline-marker][data-task-id="date-only"]')).toHaveCount(0);
    await expect(page.locator('[data-calendar-deadline-marker][data-task-id="midnight"]')).toContainText('00:00');
    await expect(proposal).not.toHaveAttribute('draggable', 'true');

    await page.getByRole('button', { name: 'Starts', exact: true }).click();
    await expect(page.locator('[data-calendar-block][data-task-id="proposal"]')).toHaveCount(0);
    await expect(proposal).toHaveCount(1);
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(proposal).toHaveCount(1);
    await proposal.click();
    const editor = page.getByRole('dialog', { name: 'Edit Task', exact: true });
    await expect(editor.getByRole('button', { name: 'Toggle task details: Submit proposal', exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Toggle task details: Submit proposal', exact: true }).dblclick();
    await expect(editor.getByRole('combobox', { name: 'Title', exact: true })).toHaveValue('Submit proposal');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mindwtr-data')!).tasks.find((task: { id: string }) => task.id === 'proposal'));
    expect(stored.startTime).toBe(`${day}T10:00:00`);
    expect(stored.dueDate).toBe(`${day}T17:00:00`);
    expect(stored.timeEstimate).toBeUndefined();
});

test('dense deadline labels stay separate and scroll within their group', async ({ page }, testInfo) => {
    const day = localDateKey();
    await page.setViewportSize({ width: 1280, height: 900 });
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: Array.from({ length: 10 }, (_, index) => ({
            id: `dense-${index}`, title: `Deadline ${index + 1}`, status: 'next' as const,
            dueDate: `${day}T17:${index < 8 ? '00' : '02'}:00`,
        })),
        settings: { language: 'en', timeFormat: '24h' },
    });
    await page.goto('/?view=calendar');
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    const markers = page.locator('[data-calendar-deadline-marker]');
    await expect(markers).toHaveCount(10);
    const group = page.locator('[data-calendar-deadline-group]').first();
    await group.scrollIntoViewIfNeeded();
    const geometry = await markers.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
    }).sort((a, b) => a.top - b.top));
    for (let index = 1; index < geometry.length; index++) {
        expect(geometry[index].top).toBeGreaterThanOrEqual(geometry[index - 1].bottom - 1);
    }
    expect(geometry.every(({ height }) => height >= 20)).toBe(true);
    await markers.last().scrollIntoViewIfNeeded();
    await expect(markers.last()).toBeVisible();
    await expect(markers.last()).toContainText('17:02');
    await page.screenshot({ path: testInfo.outputPath('deadline-stack-day.png') });
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(markers).toHaveCount(10);
    await markers.first().scrollIntoViewIfNeeded();
    const gutter = page.locator('[data-calendar-hour-gutter]');
    const gutterBox = await gutter.boundingBox();
    expect(gutterBox).not.toBeNull();
    expect(gutterBox!.x).toBeGreaterThanOrEqual(0);
    expect(gutterBox!.x + gutterBox!.width).toBeLessThan(1280);
    await page.screenshot({ path: testInfo.outputPath('deadline-stack-week.png') });
});
