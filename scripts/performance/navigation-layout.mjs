import { chromium, webkit, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture } from './fixture.mjs';
import { startPreview } from './preview-server.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.env.OUT_DIR ?? join(root, 'build/navigation-layout'));
const desktopRoot = resolve(process.env.DESKTOP_ROOT ?? join(root, 'apps/desktop'));
const engine = process.env.BROWSER_ENGINE ?? 'chromium';
if (!['chromium', 'webkit'].includes(engine)) throw new Error('Unsupported browser engine');
mkdirSync(output, { recursive: true });
const server = await startPreview(desktopRoot, Number(process.env.PORT ?? 4188));
const cases = [];
let browser;
const bounds = locator => locator.evaluate(element => {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
});
try {
  browser = await ({ chromium, webkit }[engine]).launch();
  for (const width of (process.env.WIDTHS ?? '1280,1920').split(',').map(Number)) {
    for (const destination of ['board', 'settings']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
      await context.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
      const data = fixture(10).data;
      data.settings.theme = 'dark';
      data.settings.features = { ...data.settings.features, timeline: true };
      await context.addInitScript(payload => {
        localStorage.setItem('mindwtr-data', payload);
        localStorage.setItem('mindwtr:desktop:first-run-onboarding:v1', 'dismissed');
      }, JSON.stringify(data));
      let releaseChunk;
      const chunkReady = new Promise(resolve => { releaseChunk = resolve; });
      let requested = false;
      const chunkName = destination === 'board' ? 'BoardView' : 'SettingsView';
      await context.route(`**/assets/${chunkName}-*.js`, async route => {
        requested = true;
        await chunkReady;
        await route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const entry = { engine, width, destination };
      try {
        await page.goto(server.url);
        const heading = page.getByRole('heading', { name: 'Focus', exact: true });
        await expect(heading).toBeVisible();
        const content = page.locator('[data-main-content] > div');
        entry.before = await bounds(content);
        entry.headingBefore = await bounds(heading);
        const nav = destination === 'settings'
          ? page.getByRole('button', { name: 'Settings', exact: true })
          : page.locator(`[data-sidebar-item][data-view="${destination}"]`);
        await nav.click();
        await expect.poll(() => requested).toBe(true);
        await expect(nav).toHaveAttribute('aria-current', 'page');
        await expect(heading).toBeVisible();
        entry.pending = await bounds(content);
        entry.headingPending = await bounds(heading);
        await page.screenshot({ path: join(output, `${engine}-${width}-${destination}-pending.png`) });
        expect(entry.pending).toEqual(entry.before);
        expect(entry.headingPending).toEqual(entry.headingBefore);
        releaseChunk();
        await expect(page.getByRole('heading', { name: destination === 'board' ? 'Board View' : 'General', exact: true })).toBeVisible();
        entry.completed = await bounds(content);
        expect(entry.completed.width).toBe((await bounds(page.locator('[data-main-content]'))).width);
        expect(errors).toEqual([]);
        entry.pass = true;
      } catch (error) {
        entry.pass = false;
        entry.error = String(error);
      } finally {
        releaseChunk();
        cases.push(entry);
        await context.close();
      }
    }
  }


  for (const width of [1920]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', colorScheme: 'dark' });
    await context.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort());
    const data = fixture(10).data;
    data.settings.theme = 'dark';
    data.settings.features = { ...data.settings.features, timeline: true };
    await context.addInitScript(payload => {
      localStorage.setItem('mindwtr-data', payload);
      localStorage.setItem('mindwtr:desktop:first-run-onboarding:v1', 'dismissed');
    }, JSON.stringify(data));
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
      await page.goto(server.url);
      await expect(page.getByRole('heading', { name: 'Focus', exact: true })).toBeVisible();
      const destinations = [
        ['inbox', 'Inbox'], ['projects', 'Projects'], ['someday', 'Someday/Maybe'],
        ['waiting', 'Waiting For'], ['reference', 'Reference'], ['calendar', 'Calendar'],
        ['review', 'Review'], ['contexts', 'Contexts & Tags'], ['board', 'Board View'],
        ['timeline', 'Timeline'], ['done', 'Completed'], ['archived', 'Archived'],
        ['trash', 'Trash'], ['settings', 'General'], ['agenda', 'Focus'],
      ];
      for (const [destination, title] of destinations) {
        const entry = { engine, width, destination, scenario: 'successive-navigation' };
        await page.evaluate(() => {
          const content = document.querySelector('[data-main-content] > div');
          const headings = [...content.querySelectorAll('h1,h2')];
          const heading = headings.find(node => node.getClientRects().length > 0);
          const text = heading?.textContent;
          const rect = content.getBoundingClientRect();
          const before = { x: rect.x, width: rect.width };
          const violations = [];
          const sample = () => {
            if (!heading?.isConnected || heading.textContent !== text || heading.getClientRects().length === 0) return;
            const next = content.getBoundingClientRect();
            if (next.x !== before.x || next.width !== before.width) {
              violations.push({ before, after: { x: next.x, width: next.width } });
            }
          };
          const observer = new MutationObserver(sample);
          observer.observe(content, { attributes: true, childList: true, subtree: true });
          let frame;
          const tick = () => { sample(); frame = requestAnimationFrame(tick); };
          frame = requestAnimationFrame(tick);
          window.__finishNavigationGeometry = () => {
            observer.disconnect(); cancelAnimationFrame(frame); return violations;
          };
        });
        try {
          const nav = destination === 'settings'
            ? page.getByRole('button', { name: 'Settings', exact: true })
            : page.locator(`[data-sidebar-item][data-view="${destination}"]`);
          await nav.click();
          await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeVisible();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          entry.violations = await page.evaluate(() => window.__finishNavigationGeometry());
          expect(entry.violations).toEqual([]);
          expect(pageErrors).toEqual([]);
          entry.pass = true;
        } catch (error) {
          entry.pass = false; entry.error = String(error);
          await page.evaluate(() => window.__finishNavigationGeometry());
          await page.screenshot({ path: join(output, `${engine}-${width}-${destination}-sequence-failure.png`) });
        }
        cases.push(entry);
      }
    } finally { await context.close(); }
  }

} finally {
  writeFileSync(join(output, 'report.json'), JSON.stringify({ engine, desktopRoot, cases }, null, 2));
  await browser?.close();
  await server.close();
}
const failures = cases.filter(entry => !entry.pass);
console.log(JSON.stringify({ passed: cases.length - failures.length, failed: failures.length, report: join(output, 'report.json') }));
if (failures.length) process.exitCode = 1;
