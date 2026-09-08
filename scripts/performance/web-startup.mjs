import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.mjs';
import { summarize } from './report.mjs';
import { startPreview } from './preview-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runs = Number(process.env.RUNS ?? 30);
const sizes = (process.env.SIZES ?? '0,1000,10000').split(',').map(Number);
const port = Number(process.env.PORT ?? 4179);
if (!Number.isInteger(runs) || runs < 1 || runs > 1000) throw new Error('RUNS must be 1..1000');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024..65535');
sizes.forEach(fixture);
const output = resolve(process.env.OUT_DIR ?? join(root, 'build/performance-web', new Date().toISOString().replaceAll(':', '-')));
mkdirSync(output, { recursive: true });
const dist = join(root, 'apps/desktop/dist');
const hash = createHash('sha256');
function hashTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) hashTree(path);
    else { hash.update(path.slice(dist.length)); hash.update(readFileSync(path)); }
  }
}
hashTree(dist);
const artifactHash = hash.digest('hex');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
const url = `http://127.0.0.1:${port}`;
// strictPort prevents accidentally measuring someone else's server.
let server;
let browser;
let failed = false;
try {
  server = await startPreview(join(root, 'apps/desktop'), port);
  appendFileSync(join(output, 'server.log'), `Preview listening: ${server.url}\n`);
  browser = await chromium.launch();
  for (const size of sizes) {
    const seed = fixture(size);
    const samples = [];
    // One unmeasured warm-up per fixture, then sequential fresh contexts (cold browser cache).
    // This is NOT a cold OS/process benchmark: browser process and server caches are warm.
    for (let run = 0; run <= runs; run++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/*', (route) => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
      await context.addInitScript((payload) => {
        localStorage.setItem('mindwtr-data', payload);
        localStorage.setItem('mindwtr:desktop:first-run-onboarding:v1', 'dismissed');
      }, seed.payload);
      try {
        await page.goto(url);
        await page.waitForFunction(() => performance.getEntriesByName('mindwtr.interactive_ready').length === 1, { }, { timeout: 20000 });
        await expect(page.locator('[data-sidebar-item][data-view="agenda"]')).toHaveAttribute('aria-current', 'page');
        const marks = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark')
          .filter((mark) => mark.name.startsWith('mindwtr.')).map((mark) => [mark.name.slice(8), mark.startTime])));
        if (!Number.isFinite(marks.local_data_ready) || marks.interactive_ready < marks.local_data_ready) throw new Error('Invalid readiness ordering');

        // End-to-end automation latency includes Playwright dispatch/polling. Keep it
        // separate from app-only startup marks and compare only this same harness.
        const navigationStart = performance.now();
        await page.locator('[data-sidebar-item][data-view="inbox"]').click();
        const input = page.getByPlaceholder(/add task/i);
        await expect(input).toBeVisible();
        const navigationMs = performance.now() - navigationStart;
        const title = `Benchmark capture ${run}`;
        await input.fill(title);
        const captureStart = performance.now();
        await input.press('Enter');
        await expect(page.locator('[data-task-id]', { hasText: title })).toBeVisible();
        const captureVisibleMs = performance.now() - captureStart;
        await page.waitForFunction((title) => JSON.parse(localStorage.getItem('mindwtr-data') ?? '{}').tasks?.some((task) => task.title === title), title);
        const capturePersistedMs = performance.now() - captureStart;
        // Assert real production virtualization, including after scrolling; a
        // jsdom mount alone cannot establish that the browser window is bounded.
        const taskList = page.getByRole('list', { name: 'Task list', exact: true });
        const mountedRowsBefore = await taskList.locator('[data-task-id]').count();
        let mountedRowsAfter = mountedRowsBefore;
        let scrollAutomationMs = null;
        if (size >= 1000) {
          await expect(page.getByTestId('virtualized-task-list')).toBeVisible();
          const firstIds = await taskList.locator('[data-task-id]').evaluateAll((rows) => rows.map((row) => row.dataset.taskId));
          const scrollStart = performance.now();
          // Capture scrolls to the newly added bottom row; traverse back to
          // the top (or the bottom when a future UI leaves capture at the top).
          await taskList.evaluate((list) => { list.scrollTop = list.scrollTop > list.clientHeight ? 0 : list.scrollHeight; });
          await expect.poll(() => taskList.locator('[data-task-id]').evaluateAll((rows) => rows.map((row) => row.dataset.taskId))).not.toEqual(firstIds);
          await taskList.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          scrollAutomationMs = performance.now() - scrollStart;
          mountedRowsAfter = await taskList.locator('[data-task-id]').count();
          if (!mountedRowsBefore || !mountedRowsAfter || Math.max(mountedRowsBefore, mountedRowsAfter) > 100) {
            throw new Error(`Unbounded or blank virtual list: ${mountedRowsBefore}/${mountedRowsAfter} rows`);
          }
        }
        const settingsStart = performance.now();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(page.locator('[data-settings-key="appearance"]')).toBeVisible();
        const settingsOpenMs = performance.now() - settingsStart;
        const integrationsStart = performance.now();
        await page.getByRole('button', { name: 'Integrations', exact: true }).click();
        await expect(page.locator('[data-settings-key="calendar"]')).toBeVisible();
        const integrationsOpenMs = performance.now() - integrationsStart;
        if (errors.length) throw new Error(errors.join('; '));
        if (run) samples.push({ run, quality: 'ok', marks, navigationMs, captureVisibleMs, capturePersistedMs,
          scrollAutomationMs, mountedRowsBefore, mountedRowsAfter, settingsOpenMs, integrationsOpenMs });
      } catch (error) {
        failed = true;
        if (run) samples.push({ run, quality: 'invalid', error: String(error) });
        await page.screenshot({ path: join(output, `${size}-${run}-failure.png`) }).catch(() => undefined);
        if (!run) throw new Error(`Warm-up failed for ${seed.id}: ${error}`);
      } finally { await context.close(); }
    }
    const valid = samples.filter((sample) => sample.quality === 'ok');
    const report = {
      schemaVersion: 1,
      metadata: { platform: 'desktop-web', runtime: `chromium-${browser.version()}`, device: process.env.DEVICE_LABEL ?? `local-${cpus()[0]?.model}-${cpus().length}cpu`,
        deviceModel: cpus()[0]?.model, cpuCount: cpus().length,
        os: `${platform()}-${release()}`, buildType: 'production', dataset: seed.id, network: 'loopback-external-blocked',
        scenario: 'fresh-context-focus-inbox-capture-scroll-settings-v2', revision, dirty, artifactHash, capturedAt: new Date().toISOString() },
      sampleCount: samples.length, invalidSamples: samples.length - valid.length,
      metrics: Object.fromEntries([
        ['webInteractive', valid.map((sample) => sample.marks.interactive_ready)],
        ['localDataReady', valid.map((sample) => sample.marks.local_data_ready)],
        ['navigationAutomation', valid.map((sample) => sample.navigationMs)],
        ['captureVisibleAutomation', valid.map((sample) => sample.captureVisibleMs)],
        ['capturePersistedAutomation', valid.map((sample) => sample.capturePersistedMs)],
        ['scrollAutomation', valid.map((sample) => sample.scrollAutomationMs).filter(Number.isFinite)],
        ['settingsOpenAutomation', valid.map((sample) => sample.settingsOpenMs)],
        ['integrationsOpenAutomation', valid.map((sample) => sample.integrationsOpenMs)],
      ].filter(([, values]) => values.length > 0).map(([name, values]) => [name, summarize(values)])),
      warnings: ['Browser production UI, not native Tauri launch or SQLite durability.', ...(runs < 100 ? ['Fewer than 100 runs: do not gate on p95.'] : [])],
    };
    writeFileSync(join(output, `${size}-samples.json`), `${JSON.stringify(samples, null, 2)}\n`);
    writeFileSync(join(output, `${size}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${seed.id}: ${JSON.stringify(report.metrics)}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n### Production browser — ${size} tasks\n\nValid: ${valid.length}/${runs}. Revision: ${revision}. Reporting only; hosted hardware varies.\n\n| Metric | Median ms | p95 ms |\n|---|---:|---:|\n`
      + Object.entries(report.metrics).map(([name, value]) => `| ${name} | ${value.medianMs?.toFixed(1) ?? 'n/a'} | ${value.p95Ms?.toFixed(1) ?? 'n/a'} |`).join('\n') + '\n');
  }
} finally {
  await browser?.close();
  await server?.close();
}
console.log(`Performance reports: ${output}`);
if (failed) process.exitCode = 1;
