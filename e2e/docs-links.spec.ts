import { expect, test } from '@playwright/test';
import { dismissOnboarding, seedAppData } from './seed';

test('documentation links follow live app language changes and fall back to English', async ({ page }) => {
    await dismissOnboarding(page);
    await seedAppData(page, {});
    await page.context().route('https://docs.mindwtr.app/**', (route) => route.fulfill({ body: 'Documentation destination' }));
    await page.goto('/?view=settings');

    const expectDocsDestination = async (url: string) => {
        const popupPromise = page.waitForEvent('popup');
        await page.locator('[data-settings-key="documentation"] button').click();
        const popup = await popupPromise;
        await expect(popup).toHaveURL(url);
        await popup.close();
    };

    await page.locator('[data-settings-key="language"] select').selectOption('zh-Hant');
    await page.getByRole('button', { name: '集成', exact: true }).click();
    await page.getByRole('button', { name: /^外部日曆/ }).click();
    await expect(page.getByRole('link', { name: '行事曆整合指南', exact: true })).toHaveAttribute('href', 'https://docs.mindwtr.app/zh-Hant/use/calendar-integration');
    await expect(page.getByRole('link', { name: 'Obsidian 整合指南', exact: true })).toHaveAttribute('href', 'https://docs.mindwtr.app/zh-Hant/power-users/obsidian');
    await expect(page.getByRole('link', { name: '郵件收集指南', exact: true })).toHaveAttribute('href', 'https://docs.mindwtr.app/zh-Hant/power-users/email-capture');
    await page.getByRole('button', { name: '同步', exact: true }).click();
    await expect(page.getByRole('link', { name: '資料與同步設定指南', exact: true })).toHaveAttribute('href', 'https://docs.mindwtr.app/zh-Hant/data-sync/');
    await page.getByRole('button', { name: '關於', exact: true }).click();
    await expectDocsDestination('https://docs.mindwtr.app/zh-Hant/');

    await page.getByRole('button', { name: '通用', exact: true }).click();
    await page.locator('[data-settings-key="language"] select').selectOption('uk');
    await page.getByRole('button', { name: 'Інтеграції', exact: true }).click();
    await page.getByRole('button', { name: /^Зовнішні календарі/ }).click();
    await expect(page.getByRole('link', { name: 'Посібник з інтеграції календаря', exact: true })).toHaveAttribute('href', 'https://docs.mindwtr.app/use/calendar-integration');
    await expect(page.getByRole('link', { name: 'Посібник з інтеграції Obsidian', exact: true })).toHaveAttribute('href', 'https://docs.mindwtr.app/power-users/obsidian');
    await expect(page.getByRole('link', { name: 'Посібник із захоплення електронної пошти', exact: true })).toHaveAttribute('href', 'https://docs.mindwtr.app/power-users/email-capture');
    await page.getByRole('button', { name: 'Синхронізувати', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Посібник із налаштування даних і синхронізації', exact: true })).toHaveAttribute('href', 'https://docs.mindwtr.app/data-sync/');
    await page.getByRole('button', { name: 'про', exact: true }).click();
    await expectDocsDestination('https://docs.mindwtr.app/');
});
