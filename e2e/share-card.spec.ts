import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('weekly review exports a private PNG offline and resets the personal note', async ({ page, context }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [{ id: 'private-task', title: 'Private appointment details', status: 'inbox' }],
        settings: { ai: { enabled: false } },
    });
    await page.goto('/?view=review');
    await page.getByRole('button', { name: 'Weekly Review', exact: true }).click();
    const shareAction = page.getByRole('button', { name: 'Share my reflection', exact: true });
    for (let step = 0; step < 8 && !(await shareAction.isVisible()); step += 1) {
        await page.getByRole('button', { name: /Next/ }).last().click();
    }
    await expect(shareAction).toBeVisible();
    await context.setOffline(true);
    await shareAction.click();
    const dialog = page.getByRole('dialog', { name: 'My weekly reflection', exact: true });
    await expect(dialog).toBeVisible();
    const preview = dialog.getByRole('img', { name: 'Image preview', exact: true });
    const source = await preview.getAttribute('src');
    const svg = decodeURIComponent(source!.split(',').slice(1).join(','));
    expect(svg).toContain('https://mindwtr.app/get?ref=share');
    expect(svg).not.toContain('Private appointment details');
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await dialog.getByRole('textbox').fill('Less rushing. More room for the people I care about.');
    await expect(preview).toHaveAttribute('src', /Less%20rushing/);
    await dialog.getByRole('button', { name: 'Ripple', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Ripple', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(preview).toHaveAttribute('src', /%23102e52/);
    const downloaded = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save image…', exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe('mindwtr-review.png');
    await download.saveAs('.orchestrator/tasks/share-cards-20260912/review-export.png');
    await page.screenshot({ path: '.orchestrator/tasks/share-cards-20260912/desktop-review-share.png' });
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(shareAction).toBeVisible();
    await shareAction.click();
    await expect(page.getByRole('dialog', { name: 'My weekly reflection', exact: true }).getByRole('textbox')).toHaveValue('');
    await expect(dialog.getByRole('button', { name: 'Reflection', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
