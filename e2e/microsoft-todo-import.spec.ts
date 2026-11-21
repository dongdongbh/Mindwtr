import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('Microsoft To Do import previews before writing and preserves tasks on repeat import', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, { tasks: [{ title: 'Existing task', status: 'inbox' }] });
    await page.goto('/?view=settings');
    await page.getByRole('button', { name: 'Data', exact: true }).click();
    await page.getByRole('button', { name: /Import data/i }).click();

    const openPreview = async () => {
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: /Microsoft To Do/i }).click();
        await (await chooser).setFiles({
            name: 'Errands.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from('Subject,Status,% Complete,Notes\r\nBuy apples,Not Started,0%,Fruit aisle\r\n'),
        });
        const preview = page.getByRole('dialog');
        await expect(preview).toContainText('Errands.csv');
        await expect(preview).toContainText('Errands: 1');
        return preview;
    };
    const taskTitles = () => page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('mindwtr-data')!);
        return data.tasks.map((task: { title: string }) => task.title).sort();
    });

    const preview = await openPreview();
    await preview.getByRole('button', { name: 'Cancel' }).click();
    await expect(preview).toBeHidden();
    expect(await taskTitles()).toEqual(['Existing task']);

    for (const newlyImported of [1, 0]) {
        const confirmation = await openPreview();
        await confirmation.getByRole('button', { name: /^(continue|import|confirm)$/i }).click();
        await expect(page.getByRole('button', { name: /Microsoft To Do/i })).toBeEnabled();
        await expect(page.getByText(`Imported ${newlyImported} task(s),`, { exact: false })).toBeVisible();
        await expect.poll(taskTitles).toEqual(['Buy apples', 'Existing task']);
    }
});
