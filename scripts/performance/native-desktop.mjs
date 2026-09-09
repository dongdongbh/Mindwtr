// Linux only. Real Tauri/WebKitGTK UI with an isolated portable profile and DBus.
// No personal profile, keyring, sync account, install, reset, or cleanup deletion.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from './fixture.mjs';
import { summarizeNativeRun, validateNativeReadiness } from './native-desktop-report.mjs';
import { waitForNativeSaveIdle } from './native-save-idle.mjs';

assert.equal(process.platform, 'linux', 'Native desktop runner currently supports Linux only');
const root = resolve(import.meta.dirname, '../..');
const runs = Number(process.env.RUNS ?? 30);
const sizes = (process.env.SIZES ?? '0,1000,10000').split(',').map(Number);
assert(Number.isInteger(runs) && runs > 0 && runs <= 100, 'RUNS must be 1..100');
assert(new Set(sizes).size === sizes.length, 'SIZES must not repeat fixtures');
sizes.forEach(fixture);
// An archived Benchmark executable allows interleaved A/B checks without
// rebuilding (or mutating either checkout) between measurements.
const binary = process.env.NATIVE_BINARY
  ? resolve(process.env.NATIVE_BINARY)
  : join(root, 'apps/desktop/src-tauri/target/release/mindwtr');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const binaryHash = hash(binary);
assert.equal(binaryHash, process.env.EXPECTED_BINARY_SHA256, 'Supply EXPECTED_BINARY_SHA256 for the freshly built native release');
assert(process.env.DEVICE_LABEL, 'DEVICE_LABEL is required');
const driverPath = process.env.TAURI_DRIVER ?? 'tauri-driver';
const diagnostics = process.env.NATIVE_DIAGNOSTICS === '1';
const saveQueueMode = process.env.SAVE_QUEUE_MODE ?? 'idle';
assert(['idle', 'early-session'].includes(saveQueueMode), 'SAVE_QUEUE_MODE must be idle or early-session');
assert(!process.env.NATIVE_DIAGNOSTICS || ['0', '1'].includes(process.env.NATIVE_DIAGNOSTICS), 'NATIVE_DIAGNOSTICS must be 0 or 1');
const output = resolve(process.env.OUT_DIR ?? join(root, 'build/performance-native'));
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(join(output, 'desktop-'));
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ownedDrivers = new Set();
const stopDriver = driver => {
  if (driver.pid) { try { process.kill(-driver.pid, 'SIGTERM'); } catch { /* Already stopped. */ } }
  ownedDrivers.delete(driver);
};
process.once('exit', () => { for (const driver of ownedDrivers) stopDriver(driver); });
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
const availablePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
let failed = false;
for (const size of sizes) {
  const seed = fixture(size);
  const samples = [];
  let viewport;
  let capabilities;
  // Each iteration owns a fresh native process and data directory. The first
  // launch imports the fixture. Only refresh AFTER its canonical readiness:
  // refreshing earlier leaves native migration running behind the second load.
  for (let run = 0; run <= runs; run++) {
    const profileDir = mkdtempSync(join(directory, `${size}-${run}-`));
    const app = join(profileDir, 'mindwtr');
    copyFileSync(binary, app);
    assert.equal(hash(app), binaryHash, 'Binary changed before native launch');
    writeFileSync(join(profileDir, 'portable.txt'), 'Synthetic performance fixture only\n', { flag: 'wx' });
    mkdirSync(join(profileDir, 'profile/data'), { recursive: true });
    writeFileSync(join(profileDir, 'profile/data/data.json'), seed.payload, { flag: 'wx' });
    const port = await availablePort();
    let nativePort = await availablePort();
    while (nativePort === port) nativePort = await availablePort();
    const driver = spawn('dbus-run-session', ['--', driverPath, '--port', String(port), '--native-port', String(nativePort)], {
      env: { ...process.env, XDG_CONFIG_HOME: join(profileDir, 'xdg-config'), XDG_DATA_HOME: join(profileDir, 'xdg-data'),
        XDG_CACHE_HOME: join(profileDir, 'xdg-cache') },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    ownedDrivers.add(driver);
    const logPath = join(profileDir, 'driver.log');
    driver.stdout.on('data', data => appendFileSync(logPath, data));
    driver.stderr.on('data', data => appendFileSync(logPath, data));
    let driverError;
    driver.on('error', error => { driverError = error; });
    let session;
    const request = async (path, body, method = 'POST') => {
      assert(!driverError && driver.exitCode === null, `Native driver stopped: ${driverError ?? driver.exitCode}`);
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
        signal: AbortSignal.timeout(30000) });
      const result = await response.json();
      assert(response.ok && !result.value?.error, JSON.stringify(result));
      return result.value;
    };
    const execute = (script, ...args) => request(`/session/${session}/execute/sync`, { script, args });
    const invoke = (command, args = {}) => request(`/session/${session}/execute/async`, {
      script: 'const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({error:String(error)}));',
      args: [command, args],
    }).then(result => { assert(!result.error, result.error); return result.value; });
    const until = async work => {
      const start = Date.now();
      while (Date.now() - start < 30000) { if (await work()) return; await pause(25); }
      throw new Error('Native UI readiness timed out');
    };
    const visible = selector => execute('const el=document.querySelector(arguments[0]); return !!el && el.getClientRects().length>0;', selector);
    const click = async (using, value) => {
      const element = await request(`/session/${session}/element`, { using, value });
      await request(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
    };
    const ready = async () => {
      await until(() => execute("return performance.getEntriesByName('mindwtr.interactive_ready').length === 1"));
      return validateNativeReadiness(await execute('return performance.getEntriesByType("mark").map(m=>({name:m.name,startTime:m.startTime}))'));
    };
    const sample = { run, status: 'running' };
    try {
      await until(async () => { try { await request('/status', undefined, 'GET'); return true; } catch { return false; } });
      const created = await request('/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: app } } } });
      session = created.sessionId;
      capabilities = created.capabilities;
      await until(() => execute('return !!window.__TAURI_INTERNALS__ && !!document.body'));
      assert.equal(await invoke('get_data_path_cmd'), join(profileDir, 'profile/data/data.json'), 'Non-isolated native profile');
      assert.equal(await invoke('plugin:app|name'), 'Mindwtr Benchmark', 'Build with the Benchmark product name');
      // Onboarding suppresses the main-screen mark; dismiss it through its UI.
      await until(async () => {
        const dismissed = await execute('const b=[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Skip for now"); if(b){b.click();return true;} return performance.getEntriesByName("mindwtr.interactive_ready").length===1;');
        return dismissed;
      });
      sample.initialImportReady = await ready();
      const waitForSaves = () => waitForNativeSaveIdle(() => execute(
        'return typeof window.__mindwtrSaveStatus === "function" ? window.__mindwtrSaveStatus() : null'));
      sample.saveIdle = {};
      if (saveQueueMode === 'idle') sample.saveIdle.initialImport = await waitForSaves();
      await execute("localStorage.setItem('mindwtr:desktop:first-run-onboarding:v1','dismissed')");
      await request(`/session/${session}/refresh`, {});
      sample.readiness = await ready();
      const view = await execute('return {width:innerWidth,height:innerHeight,ratio:devicePixelRatio}');
      if (viewport) assert.deepEqual(view, viewport, 'Native viewport changed across samples');
      viewport = view;
      const canonical = await invoke('get_data');
      assert.equal(canonical.tasks.length, size, 'Unexpected native fixture size');
      assert(canonical.tasks.every(task => task.id.startsWith('perf-task-')), 'Non-synthetic native data');
      sample.countBefore = canonical.tasks.length;
      if (saveQueueMode === 'idle') sample.saveIdle.beforeSettings = await waitForSaves();
      await execute('window.__MINDWTR_DIAGNOSTICS__=arguments[0]', diagnostics);
      if (diagnostics) await execute(`
        const originalFetch = window.fetch.bind(window);
        window.__nativeBenchmarkIpc = [];
        window.fetch = async (...args) => {
          const command = String(args[0]).split('/').pop();
          if (!['save_data', 'save_task', 'get_data'].includes(command)) return originalFetch(...args);
          const entry = {command, startMs: performance.now()};
          window.__nativeBenchmarkIpc.push(entry);
          try { return await originalFetch(...args); }
          finally { entry.responseHeadersMs = performance.now() - entry.startMs; }
        };
      `);
      const settingsStart = performance.now();
      await click('xpath', '//button[@aria-label="Settings"]');
      await until(() => visible('[data-settings-key="appearance"]'));
      sample.settingsOpenAutomationMs = performance.now() - settingsStart;
      const integrationsStart = performance.now();
      await click('xpath', '//button[normalize-space(.)="Integrations"]');
      await until(() => visible('[data-settings-key="calendar"]'));
      sample.integrationsOpenAutomationMs = performance.now() - integrationsStart;
      await click('css selector', '[data-sidebar-item][data-view="inbox"]');
      const captureSelector = 'input[aria-label="Add Task" i]';
      await until(() => visible(captureSelector));
      const element = await request(`/session/${session}/element`, { using: 'css selector', value: captureSelector });
      const input = element['element-6066-11e4-a52e-4f735466cecf'];
      const title = `Native benchmark capture ${run}`;
      await request(`/session/${session}/element/${input}/value`, { text: title });
      if (saveQueueMode === 'idle') sample.saveIdle.beforeCapture = await waitForSaves();
      const captureStart = performance.now();
      await request(`/session/${session}/element/${input}/value`, { text: '\uE007' });
      await until(() => execute('return [...document.querySelectorAll("[data-task-id]")].some(el=>el.textContent.includes(arguments[0])&&el.getClientRects().length>0)', title));
      sample.captureVisibleAutomationMs = performance.now() - captureStart;
      // Separate SQLite connection, not optimistic React state or data.json.
      const database = join(profileDir, 'profile/data/mindwtr.db');
      // A reader can briefly contend with a native schema/write transaction.
      // Bound the normal SQLite busy wait instead of treating it as data loss.
      const readCount = () => Number(execFileSync('sqlite3', ['-readonly', '-cmd', '.timeout 5000', database,
        'SELECT count(*) FROM tasks;'], { encoding: 'utf8', timeout: 6000 }).trim());
      await until(() => readCount() === size + 1);
      sample.captureDurableAutomationMs = performance.now() - captureStart;
      sample.countAfter = readCount();
      const persisted = await invoke('get_data');
      assert.equal(persisted.tasks.filter(task => task.title === title).length, 1, 'Capture content was not persisted exactly once');
      assert.equal(await invoke('get_sync_backend'), 'off', 'Native baseline requires sync off');
      assert.equal(hash(app), binaryHash, 'Launched binary changed during measurement');
      if (diagnostics) sample.ipc = await execute('return window.__nativeBenchmarkIpc');
      if (saveQueueMode === 'idle') sample.saveIdle.afterCapture = await waitForSaves();
      // A new WebView loads the canonical native store again after the capture.
      await request(`/session/${session}/refresh`, {});
      await ready();
      assert.equal((await invoke('get_data')).tasks.filter(task => task.title === title).length, 1, 'Capture did not survive reload');
      sample.status = 'passed';
    } catch (error) {
      sample.status = 'failed';
      sample.error = String(error);
      failed = true;
      if (session) {
        const screenshot = await request(`/session/${session}/screenshot`, undefined, 'GET').catch(() => null);
        if (screenshot) writeFileSync(join(profileDir, 'failure.png'), Buffer.from(screenshot, 'base64'));
        const state = await execute('return {text:document.body.innerText,width:innerWidth,height:innerHeight}').catch(() => null);
        writeFileSync(join(profileDir, 'failure-state.json'), JSON.stringify(state, null, 2));
      }
    } finally {
      if (session) await request(`/session/${session}`, undefined, 'DELETE').catch(() => {});
      stopDriver(driver);
      writeFileSync(join(profileDir, 'sample.json'), JSON.stringify(sample, null, 2));
    }
    if (run) samples.push(sample);
    console.log(`${size}/${run}: ${sample.status}`);
    if (sample.status !== 'passed') break;
  }
  const report = { schemaVersion: 1, status: 'failed', metadata: {
    platform: 'desktop-native-linux', runtime: capabilities, os: release(), cpu: cpus()[0]?.model,
    device: process.env.DEVICE_LABEL, dataset: seed.id, buildType: 'release', binaryHash, sourceRevision, dirty,
    viewport, scenario: saveQueueMode === 'idle' ? 'portable-native-settings-capture-idle-v2' : 'portable-native-settings-capture-v1',
    saveQueueMode, network: 'host-network-sync-off',
    profiling: diagnostics ? 'settings-diagnostics-ipc-headers' : 'none', capturedAt: new Date().toISOString(),
  }, samples, warnings: ['Portable Linux Tauri with an isolated session bus; does not measure OS keyring access or macOS/Windows.',
    'Automation latency includes WebDriver dispatch/polling. SQLite readback is not a hardware power-loss test.',
    'Initial import and subsequent warm-database WebView readiness are separate; neither is native process TTID.',
    'Desktop viewport must remain unchanged. Fewer than 100 samples cannot establish a p95 release gate.'] };
  try { Object.assign(report, summarizeNativeRun(samples, runs, binaryHash, hash(binary), saveQueueMode)); }
  catch (error) { report.error = String(error); failed = true; }
  writeFileSync(join(directory, `${size}-report.json`), JSON.stringify(report, null, 2));
  if (failed) break;
}
console.log(`Native desktop reports: ${directory}`);
if (failed) process.exitCode = 1;
