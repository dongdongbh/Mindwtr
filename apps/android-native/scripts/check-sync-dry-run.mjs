


import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostDevice, serveWebdav, startCloud, webdavDocument } from './sync-harness.mjs';

const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
const bundle = resolve(app, 'android/app/src/main/assets/core-host.js');
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const WEBDAV_PORT = Number(process.env.MINDWTR_SYNC_WEBDAV_PORT ?? 18774);
const CLOUD_PORT = Number(process.env.MINDWTR_SYNC_CLOUD_PORT ?? 18775);
const FOLDER = `/dav/mindwtr-dry-${run}`;
const USER = `dry${run}`;
const PASSWORD = `pw${run}secret`;
const TOKEN = `nativesyncdryrun${run}token`;
const webdav = { url: `http://127.0.0.1:${WEBDAV_PORT}${FOLDER}`, username: USER, password: PASSWORD, allowInsecureHttp: true };
const cloudFields = { url: `http://127.0.0.1:${CLOUD_PORT}`, token: TOKEN, allowInsecureHttp: true };
const titles = { a: `A ✓ Grüße 😀 ${run}`, b: `B 雲 😀 ${run}`, down: `down ${run}`, failed: `failed ${run}`, cloud: `cloud 😀 ${run}`, offline: `offline ${run}` };

let failures = 0;
const check = (ok, message) => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok' : 'NOT OK'} - ${message}`);
};
const until = async (description, holds, timeoutMs) => {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(1_000)) if (await holds()) return true;
    check(false, `timed out waiting for ${description}`);
    return false;
};
const remoteTitles = () => (webdavDocument(dav, FOLDER)?.tasks ?? []).filter((task) => !task.deletedAt).map((task) => task.title);
const lastState = (device) => device.events.filter((event) => event.type === 'sync').at(-1) ?? {};

const dav = await serveWebdav({ port: WEBDAV_PORT, username: USER, password: PASSWORD });
let cloud = await startCloud({ repo, port: CLOUD_PORT, token: TOKEN, dataDir: resolve(app, `android/build/sync-dry-run/cloud-${run}`) });
const log = (line) => { if (/Sync failed|error/i.test(line)) console.log(`note - ${line.slice(0, 200)}`); };
const a = await hostDevice({ bundle, name: 'A', log });
const b = await hostDevice({ bundle, name: 'B', log });
try {
    await a.boot();
    await b.boot();
    await a.capture(titles.a);
    const saved = await a.configure('webdav', webdav);
    check(saved.toasts.at(-1)?.message === 'Sync completed!', 'WebDAV Save proved the folder with a sync');
    check(remoteTitles().includes(titles.a), 'the first sync uploaded the emoji title');
    check(a.keyValue.get('@mindwtr_sync_backend') === 'webdav' && a.keyValue.get('@mindwtr_webdav_url') === webdav.url
        && ![...a.keyValue.values()].some((value) => value.includes(PASSWORD)), 'RN\'s keys are stored; the password is not in the key-value store');
    check(a.secrets.get('mindwtr_webdav_password') === PASSWORD, 'the password is in the secret store under RN\'s name');

    await b.configure('webdav', webdav);
    check((await b.titles()).includes(titles.a), 'the second device joined and has the emoji title exactly');
    await b.capture(titles.b);
    await b.syncNow('webdav', { ...webdav, password: null });
    await a.syncNow('webdav', { ...webdav, password: null });
    check((await a.titles()).includes(titles.b), 'Sync now brought the second device\'s title back exactly');

    await a.capture(titles.down);
    await until('A\'s data change to sync by itself', () => remoteTitles().includes(titles.down), 60_000);
    check(true, 'a data change synced by itself (core\'s data-change trigger)');

    dav.state.down = true;
    const before = JSON.stringify((await a.titles()).sort());
    await a.capture(titles.failed);
    await until('the automatic sync to fail', () => lastState(a).badge === 'attention', 180_000);
    const failed = (await a.view()).panel.lastSync;
    check(failed.status.endsWith(' (failed)') && Boolean(failed.error), `the status line shows the failure ("${failed.status}", "${failed.error}")`);
    check(!remoteTitles().includes(titles.failed), 'nothing reached the server while it was down');
    check(JSON.stringify((await a.titles()).filter((title) => title !== titles.failed).sort()) === before, 'no local data changed');
    check(a.events.some((event) => event.type === 'toast' && event.open === 'sync'), 'the automatic failure showed RN\'s warning with Open');

    dav.state.down = false;
    dav.state.failWrites = 10_000;
    const cycles = lastState(a).cycles;
    await until('a sync whose writes fail', () => lastState(a).cycles > cycles && lastState(a).badge === 'attention', 240_000);
    check(!remoteTitles().includes(titles.failed), 'failing writes left the folder unchanged');
    dav.state.failWrites = 0;
    await until('the retry to succeed by itself', () => remoteTitles().includes(titles.failed), 300_000);
    check(true, 'the failed write kept its retry, which succeeded once the server took writes again');

    await a.configure('selfhosted', cloudFields);
    await b.configure('selfhosted', cloudFields);
    check((await b.titles()).includes(titles.failed), 'the second device joined the cloud and has A\'s tasks');
    await b.capture(titles.cloud);
    await b.syncNow('selfhosted', { ...cloudFields, token: null });
    await a.syncNow('selfhosted', { ...cloudFields, token: null });
    check((await a.titles()).includes(titles.cloud), 'the cloud brought the second device\'s emoji title exactly');
    await cloud.stop();
    const skips = () => a.lines.filter((line) => line.includes('Sync skipped after offline detection')).length;
    const skipped = skips();
    await a.capture(titles.offline);
    await until('the automatic sync to meet the stopped cloud', () => skips() > skipped, 180_000);
    check((await a.titles()).includes(titles.offline), 'the stopped cloud read as offline and lost nothing');
    cloud = await startCloud({ repo, port: CLOUD_PORT, token: TOKEN, dataDir: resolve(app, `android/build/sync-dry-run/cloud-${run}`) });
    await a.syncNow('selfhosted', { ...cloudFields, token: null });
    await b.syncNow('selfhosted', { ...cloudFields, token: null });
    check((await b.titles()).includes(titles.offline), 'the cloud back, Sync now uploaded what was captured while it was stopped');
} catch (error) {
    check(false, `stopped: ${error.stack ?? error}`);
} finally {
    a.stop();
    b.stop();
    await dav.close();
    await cloud.stop();
}
console.log(failures ? `Sync dry run: ${failures} failed` : 'Sync dry run passed');
process.exit(failures ? 1 : 0);
