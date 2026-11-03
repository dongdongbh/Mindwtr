


import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostDevice, serveWebdav } from './sync-harness.mjs';
import { encryptionCard, remoteArtifacts, runEncryption } from './encryption-harness.mjs';

const app = resolve(import.meta.dirname, '..');
const repo = resolve(app, '../..');
const bundle = resolve(app, 'android/app/src/main/assets/core-host.js');
const { en } = await import(resolve(repo, 'packages/core/src/i18n/locales/en.ts'));
const run = `${String(Date.now()).slice(-6)}${String(randomInt(1_000_000)).padStart(6, '0')}`;
const WEBDAV_PORT = Number(process.env.MINDWTR_SYNC_WEBDAV_PORT ?? 18776);
const WEAK_PORT = WEBDAV_PORT + 1;
const FOLDER = `/dav/mindwtr-enc-dry-${run}`;
const USER = `dry${run}`;
const PASSWORD = `pw${run}secret`;
const PASSPHRASE = `9${run}7`;
const webdav = (port) => ({ url: `http://127.0.0.1:${port}${FOLDER}`, username: USER, password: PASSWORD, allowInsecureHttp: true });
const titles = { a: `A ✓ Grüße 😀 ${run}`, b: `B 雲 😀 ${run}`, after: `after ${run}` };

let failures = 0;
const check = (ok, message) => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'ok' : 'NOT OK'} - ${message}`);
};
const until = async (description, holds, timeoutMs) => {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(500)) if (await holds()) return true;
    check(false, `timed out waiting for ${description}`);
    return false;
};

const dav = await serveWebdav({ port: WEBDAV_PORT, username: USER, password: PASSWORD });
const weak = await serveWebdav({ port: WEAK_PORT, username: USER, password: PASSWORD });
weak.state.weakEtags = true;
const log = (line) => { if (/Sync failed|error/i.test(line)) console.log(`note - ${line.slice(0, 200)}`); };
const a = await hostDevice({ bundle, name: 'A', log });
const b = await hostDevice({ bundle, name: 'B', log });
const c = await hostDevice({ bundle, name: 'C', log });
try {
    for (const device of [a, b, c]) await device.boot();
    await a.capture(titles.a);
    await a.configure('webdav', webdav(WEBDAV_PORT));
    check(remoteArtifacts(dav, FOLDER).plain.some((file) => file.text.includes(titles.a)), 'the first sync uploaded the task in plaintext');


    const off = encryptionCard(await a.view());
    check(off?.rows.some((row) => row.text === en['settings.syncEncryptionDesc']), 'the card reads RN\'s description while off');
    const enabled = await runEncryption(a, 'enable', { next: PASSPHRASE, confirm: PASSPHRASE });
    const enabledCard = encryptionCard(await a.view());
    check(enabledCard.rows.some((row) => row.text === en['settings.syncEncryptionStatusOn']), `encryption reads On after Enable (${JSON.stringify(enabled.toasts ?? [])})`);
    const encrypted = remoteArtifacts(dav, FOLDER);
    check(encrypted.plain.length === 0 && encrypted.encrypted.some((file) => file.path.endsWith('/data.json.enc')),
        `the folder holds only MWENC1 files (${encrypted.encrypted.map((file) => file.path.split('/').pop()).join(', ')})`);
    check(!encrypted.all.some((file) => file.body.includes(Buffer.from(titles.a.slice(0, 8)))), 'no task title is readable on the server');
    check(![...a.keyValue.values(), ...a.lines].some((value) => value.includes(PASSPHRASE)), 'the passphrase is in no key-value entry and no log line');
    check(![...a.secrets.values()].some((value) => value.includes(PASSPHRASE)), 'the passphrase is not stored, only the derived key');


    await b.configure('webdav', webdav(WEBDAV_PORT)).catch((error) => console.log(`note - B's Save: ${error.message.slice(0, 160)}`));
    await until('B to see the locked card', async () => encryptionCard(await b.view())?.rows.some((row) => row.text === en['settings.syncEncryptionLockedTitle']), 30_000);
    check(!(await b.titles()).includes(titles.a), 'B reads nothing from the encrypted folder without the passphrase');
    const before = remoteArtifacts(dav, FOLDER).fingerprint;
    const wrong = await runEncryption(b, 'unlock', { current: `${PASSPHRASE}x` });
    const wrongCard = encryptionCard(await b.view());
    check(wrongCard.rows.some((row) => row.text === en['settings.syncEncryptionErrorWrongPassphrase'] && row.tone === 'danger'),
        `a wrong passphrase reads RN's words (${JSON.stringify(wrong)})`);
    check(remoteArtifacts(dav, FOLDER).fingerprint === before && !(await b.titles()).includes(titles.a), 'a wrong passphrase changes no file and no task');
    await runEncryption(b, 'unlock', { current: PASSPHRASE }, { open: false });
    await b.syncNow('webdav', webdav(WEBDAV_PORT));
    check((await b.titles()).includes(titles.a), 'B reads A\'s emoji title after unlocking');


    await b.capture(titles.b);
    await b.syncNow('webdav', webdav(WEBDAV_PORT));
    await a.syncNow('webdav', webdav(WEBDAV_PORT));
    check((await a.titles()).includes(titles.b), 'A reads B\'s title through the encrypted folder');
    check(remoteArtifacts(dav, FOLDER).plain.length === 0, 'the folder still holds no plaintext');


    const NEXT = `${PASSPHRASE}n`;
    const changed = await runEncryption(b, 'change', { current: PASSPHRASE, next: NEXT, confirm: NEXT });
    check(!changed.error && remoteArtifacts(dav, FOLDER).plain.length === 0, `B changed the passphrase (${JSON.stringify(changed).slice(0, 120)})`);
    await a.syncNow('webdav', webdav(WEBDAV_PORT)).catch(() => null);
    check(encryptionCard(await a.view())?.rows.some((row) => row.text === en['settings.syncEncryptionLockedTitle']), 'A asks for the passphrase once B changed it');
    const beforeStale = remoteArtifacts(dav, FOLDER).fingerprint;
    await runEncryption(a, 'unlock', { current: PASSPHRASE });
    check(encryptionCard(await a.view())?.rows.some((row) => row.tone === 'danger' && row.text === en['settings.syncEncryptionErrorWrongPassphrase'])
        && remoteArtifacts(dav, FOLDER).fingerprint === beforeStale, 'the old passphrase is refused in RN\'s words and changes no file');
    await runEncryption(a, 'unlock', { current: NEXT }, { open: false });
    await a.syncNow('webdav', webdav(WEBDAV_PORT));
    check(encryptionCard(await a.view())?.rows.some((row) => row.text === en['settings.syncEncryptionStatusOn']), 'the new passphrase unlocks A');


    await runEncryption(a, 'disable', {});
    const plain = remoteArtifacts(dav, FOLDER);
    check(plain.encrypted.length === 0 && plain.plain.some((file) => file.path.endsWith('/data.json') && file.text.includes(titles.b)),
        `after Disable the folder is plaintext again (${plain.all.map((file) => file.path.split('/').pop()).join(', ')})`);
    await a.capture(titles.after);
    await a.syncNow('webdav', webdav(WEBDAV_PORT));
    await b.syncNow('webdav', webdav(WEBDAV_PORT)).catch((error) => console.log(`note - B after disable: ${error.message.slice(0, 160)}`));
    console.log(`note - B's card after A disabled: ${JSON.stringify(encryptionCard(await b.view())?.rows.map((row) => row.text ?? row.label))}`);


    await c.capture(`weak ${run}`);
    const weakSave = await c.configure('webdav', webdav(WEAK_PORT)).catch((error) => ({ error: error.message }));
    console.log(`note - weak-ETag Save: ${JSON.stringify(weakSave).slice(0, 300)}`);
    const weakEnable = await runEncryption(c, 'enable', { next: PASSPHRASE, confirm: PASSPHRASE });
    const weakCard = encryptionCard(await c.view());
    const danger = weakCard?.rows.filter((row) => row.tone === 'danger').map((row) => row.text) ?? [];
    console.log(`note - weak-ETag Enable: ${JSON.stringify(weakEnable).slice(0, 300)}; danger rows: ${JSON.stringify(danger)}`);
    check(danger.includes(en['settings.syncEncryptionErrorBackendIncompatible']), 'Enable on a weak-ETag server is refused with RN\'s words');
    const weakFiles = remoteArtifacts(weak, FOLDER);
    check(weakFiles.encrypted.length === 0 && !weakFiles.all.some((file) => file.path.includes('fence')),
        `nothing on the weak-ETag server was encrypted or fenced (${weakFiles.all.map((file) => file.path.split('/').pop()).join(', ')})`);
    const afterWeak = await c.syncNow('webdav', webdav(WEAK_PORT)).catch((error) => ({ error: error.message }));
    check(afterWeak.toasts?.at(-1)?.message === 'Sync completed!', 'plaintext sync on the weak-ETag server still works after the refusal');
} catch (error) {
    check(false, `unexpected: ${error.stack}`);
} finally {
    for (const device of [a, b, c]) device.stop();
    await dav.close();
    await weak.close();
}
console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
