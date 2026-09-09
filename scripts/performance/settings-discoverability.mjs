import { chromium, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture } from './fixture.mjs';
import { startPreview } from './preview-server.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.env.OUT_DIR ?? join(root, 'build/settings-discoverability'));
mkdirSync(output, { recursive: true });
const server = await startPreview(join(root, 'apps/desktop'), 4181);
let browser;
try {
  browser = await chromium.launch();
  for (const width of [800, 1280]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', colorScheme: theme });
    await context.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
    const data = fixture(10).data;
    data.settings.theme = theme;
    await context.addInitScript(payload => {
      localStorage.setItem('mindwtr-data', payload);
      localStorage.setItem('mindwtr:desktop:first-run-onboarding:v1', 'dismissed');
    }, JSON.stringify(data));
    const page = await context.newPage();
    let releaseSettings;
    let settingsRequested = false;
    const settingsReady = new Promise(resolve => { releaseSettings = resolve; });
    await context.route('**/assets/SettingsView-*.js', async route => {
      settingsRequested = true;
      await settingsReady;
      await route.continue();
    });
    try {
      await page.goto(server.url);
      await expect(page.locator('[data-sidebar-item][data-view="agenda"]')).toHaveAttribute('aria-current', 'page');
      await expect(page.getByText('Help: Focus', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect.poll(() => settingsRequested).toBe(true);
      // Retain the current screen while the real Settings route is unavailable,
      // including a first click before its background preload has completed.
      await expect(page.getByRole('heading', { name: 'Focus', exact: true })).toBeVisible();
      await page.screenshot({ path: join(output, `${width}-${theme}-route-pending.png`) });
      // A later navigation wins over a still-pending Settings transition.
      await page.locator('[data-sidebar-item][data-view="inbox"]').click();
      const captureInput = page.getByPlaceholder(/add task/i);
      await expect(captureInput).toBeVisible();
      const settingsResponse = page.waitForResponse(response => /\/SettingsView-[^/]+\.js$/.test(response.url()));
      releaseSettings();
      await (await settingsResponse).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(page.locator('[data-sidebar-item][data-view="inbox"]')).toHaveAttribute('aria-current', 'page');
      await expect(captureInput).toBeVisible();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.locator('[data-settings-key="appearance"]')).toBeVisible();
      const input = page.getByRole('combobox', { name: /Search settings/i });
      await expect(input).toBeVisible();
      await input.fill('theme');
      const options = page.getByRole('listbox').getByRole('option');
      await expect(options.first()).toBeVisible();
      await page.screenshot({ path: join(output, `${width}-${theme}-search.png`) });
      await input.press('ArrowDown');
      const activeId = await input.getAttribute('aria-activedescendant');
      await expect(page.locator(`[id="${activeId}"]`)).toHaveAttribute('aria-selected', 'true');
      await input.press('Escape');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await input.fill('appearance');
      await page.getByRole('listbox').getByRole('option', { name: /^Appearance / }).first().click();
      await expect(page.locator('[data-settings-key="appearance"]')).toHaveAttribute('data-settings-highlight', 'true');
      await expect(input).toHaveValue('');
      await page.screenshot({ path: join(output, `${width}-${theme}-selected.png`) });

      // A slow, previously unopened lazy page must not hide the current page.
      // Hold the actual production chunk, not a component mock or fixed sleep.
      let releaseChunk;
      let chunkRequested = false;
      const chunkReady = new Promise(resolve => { releaseChunk = resolve; });
      await context.route('**/assets/SettingsIntegrationsPage-*.js', async route => {
        chunkRequested = true;
        await chunkReady;
        await route.continue();
      });
      try {
        if (width < 1024) await page.getByRole('combobox', { name: 'Settings', exact: true }).selectOption('integrations');
        else await page.getByRole('button', { name: 'Integrations', exact: true }).click();
        await expect.poll(() => chunkRequested).toBe(true);
        await expect(page.locator('main[aria-busy="true"]')).toBeVisible();
        await expect(page.locator('[data-settings-key="appearance"]')).toBeVisible();
        await page.screenshot({ path: join(output, `${width}-${theme}-pending.png`) });
      } finally { releaseChunk(); }
      await expect(page.locator('[data-settings-key="calendar"]')).toBeVisible();
      await expect(page.locator('main[aria-busy="false"]')).toBeVisible();
      await page.screenshot({ path: join(output, `${width}-${theme}-integrations.png`) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      console.log(`Settings search passed: ${width}px ${theme}`);
    } catch (error) {
      await page.screenshot({ path: join(output, `${width}-${theme}-failure.png`) });
      throw error;
    } finally { releaseSettings(); await context.close(); }
  }
} finally { await browser?.close(); await server.close(); }
