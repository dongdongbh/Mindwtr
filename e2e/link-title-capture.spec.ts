import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('saves a bare URL before the page replies and keeps the link after renaming', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {});
    await page.goto('/');
    await page.locator('[data-sidebar-item][data-view="inbox"]').click();
    const url = 'https://example.org/articles/42#section';
    const title = 'An article /due:tomorrow #reading';
    let release!: () => void;
    const holdResponse = new Promise<void>((resolve) => { release = resolve; });
    await page.route('https://example.org/articles/42', async (route) => {
        await holdResponse;
        await route.fulfill({ contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: '<title>An article /due:tomorrow #reading</title>' });
    });
    const input = page.getByPlaceholder(/add task/i);
    await input.fill(url);
    await input.press('Enter');
    const task = () => page.evaluate((uri) => JSON.parse(localStorage.getItem('mindwtr-data') || '{}').tasks
        ?.find((item: { attachments?: { uri: string }[] }) => item.attachments?.some((attachment) => attachment.uri === uri)), url);
    try {
        await expect.poll(async () => (await task())?.title).toBe(url);
    } finally {
        release();
    }
    await expect.poll(async () => (await task())?.title).toBe(title);
    await page.reload();
    await expect(page.locator('[data-task-id]', { hasText: title })).toBeVisible();
    expect((await task()).dueDate).toBeFalsy();
    expect((await task()).tags ?? []).toEqual([]);
});
