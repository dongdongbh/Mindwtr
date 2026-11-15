import { expect, test } from '@playwright/test';
import { dismissOnboarding, localDateKey, seedAppData } from './seed';

test('Focus keeps the shortlist first and Review Due between Today and Next Actions', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {
        tasks: [
            { id: 'starred', title: 'Chosen action', status: 'next', isFocusedToday: true },
            { id: 'scheduled', title: 'Scheduled action', status: 'next', dueDate: localDateKey() },
            { id: 'review', title: 'Review reminder', status: 'waiting', reviewAt: localDateKey(-1) },
            { id: 'next', title: 'Available action', status: 'next' },
            { id: 'upcoming', title: 'Future action', status: 'next', startTime: localDateKey(2) },
        ],
        settings: { language: 'en' },
    });
    await page.goto('/?view=agenda');
    const sectionIds = ['focus', 'schedule', 'reviewDue', 'nextActions', 'upcoming'];
    const sectionSelector = sectionIds.map((id) => `#agenda-section-${id}`).join(', ');
    await expect(page.locator(sectionSelector)).toHaveCount(sectionIds.length);
    expect(await page.locator(sectionSelector).evaluateAll((sections) => sections.map(({ id }) => id)))
        .toEqual(sectionIds.map((id) => `agenda-section-${id}`));
    expect(await page.locator(sectionSelector).locator('[data-task-id]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-task-id'))))
        .toEqual(['starred', 'scheduled', 'review', 'next', 'upcoming']);
});
