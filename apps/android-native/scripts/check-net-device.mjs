


import './device-lock.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const SECRET_KEY = 'mindwtr_native_net_check';

export const LIMIT_BYTES = 64 * 1024;
export const DOC = { check: 'net', text: 'Grüße ✓ 😀' };

export const BODIES = {
    nul: Buffer.from([0x61, 0x00, 0x62]),
    marker: Buffer.from('!MindwtrNativeError:not an error'),
    astral: Buffer.from('😀 Grüße \u{10ffff} 𝄞'),
    bom: Buffer.from('\ufeff{"a":1}'),
    invalid: Buffer.from([0x20, 0xe2, 0x20]),
};


export const cleanupOnExit = (steps) => {
    let done = false;
    const cleanup = () => {
        if (done) return;
        done = true;
        for (const step of steps) {
            try { step(); } catch {                         }
        }
    };
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
        process.once(signal, () => {
            cleanup();
            process.exit(code);
        });
    }
    return cleanup;
};


export const serve = (port, readSecretFile) => {
    const seen = [];
    const files = new Map();
    const slow = new Map();
    const state = { seen, files, slow, secret: null };
    const doc = Buffer.from(JSON.stringify(DOC));
    const etag = (body) => `"${createHash('sha1').update(body).digest('hex')}"`;
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const key = `${req.method} ${req.url}`;
            seen.push({ key, headers: req.headers, body });
            const file = files.get(req.url);
            if (req.url.startsWith('/slow/') || req.url === '/cut/oversize.json' || req.url === '/cut/stream.json') {


                slow.set(req.url, 'open');
                res.on('close', () => slow.set(req.url, res.writableEnded ? 'answered' : 'closed'));
                if (req.url === '/slow/body') res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1000 }).write('{"check":1');
                if (req.url === '/cut/oversize.json') res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': LIMIT_BYTES + 1 }).write('{');
                if (req.url === '/cut/stream.json') {
                    res.writeHead(200, { 'Content-Type': 'application/json' }).write(`{"pad":"${'x'.repeat(2 * LIMIT_BYTES)}`);
                }
            } else if (key === 'PUT /dav/data.json' || key === 'PUT /dav/bytes.bin') {
                files.set(req.url, { body, type: req.headers['content-type'] });
                res.writeHead(201, { ETag: etag(body) }).end();
            } else if ((req.method === 'GET' || req.method === 'HEAD') && (req.url === '/dav/data.json' || req.url === '/dav/bytes.bin')) {
                if (!file) res.writeHead(404).end();
                else res.writeHead(200, { ETag: etag(file.body), 'Content-Type': file.type, 'Content-Length': file.body.length }).end(req.method === 'GET' ? file.body : undefined);
            } else if (key === 'MKCOL /dav/folder/') {
                res.writeHead(409).end();
            } else if (key === 'PROPFIND /dav/folder/') {
                res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
                    .end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/folder/</d:href></d:response></d:multistatus>');
            } else if (key === 'PUT /dav/redirect.json') {
                res.writeHead(307, { Location: '/dav/other.json' }).end();
            } else if (key === 'GET /dav/moved.json') {
                res.writeHead(301, { Location: '/dav/data.json' }).end();
            } else if (key === 'DELETE /dav/data.json') {
                files.delete(req.url);
                res.writeHead(204).end();
            } else if (key === 'GET /cut/half.json') {

                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': doc.length })
                    .write(doc.subarray(0, doc.length >> 1), () => res.socket.end());
            } else if (key === 'GET /cut/reset.json') {

                res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
                res.flushHeaders();
                res.socket.write(Buffer.concat([Buffer.from(`${doc.length.toString(16)}\r\n`), doc.subarray(0, doc.length >> 1)]),
                    () => setTimeout(() => res.socket.resetAndDestroy(), 50));
            } else if (key === 'GET /cut/gzip.json') {

                const zipped = gzipSync(JSON.stringify(DOC)).subarray(0, -12);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': zipped.length }).end(zipped);
            } else if (key === 'GET /cut/utf8.json') {

                res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 6 }).end(Buffer.from([0x20, 0xe2, 0x20, 0xc0, 0xa0, 0x0a]));
            } else if (req.method === 'GET' && BODIES[req.url.replace('/body/', '')] && req.url.startsWith('/body/')) {
                const bytes = BODIES[req.url.replace('/body/', '')];
                res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }).end(bytes);
            } else if (key === 'HEAD /gz/data.json') {

                res.writeHead(200, { ETag: '"gz"', 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': 40 }).end();
            } else if (key === 'GET /secret-stored') {
                state.secret = secretItem(readSecretFile());
                res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ found: Boolean(state.secret?.item) }));
            } else {
                res.writeHead(404).end();
            }
        });
    });
    return new Promise((done, failed) => {
        server.once('error', failed);
        server.listen(port, '127.0.0.1', () => done({ state, close: () => { server.closeAllConnections(); server.close(); } }));
    });
};


export const secretItem = (xml) => {
    const decode = (value) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const raw = new RegExp(`<string name="key_v1-${SECRET_KEY}">([^<]*)</string>`).exec(xml)?.[1];
    return { xml, item: raw === undefined ? null : JSON.parse(decode(raw)) };
};


export const verify = async (steps, state, secretFile, log, { check, fail }) => {
    const { seen, files, slow } = state;
    const saw = (key) => seen.filter((entry) => entry.key === key);
    const step = (name) => steps[name] ?? fail(`no ${name} step in ${JSON.stringify(steps)}`);
    const failedWith = (name) => `${step(name).name}: ${step(name).error}`;


    const put = saw('PUT /dav/data.json')[0];
    check(step('put').ok && put?.body.toString('utf8') === JSON.stringify(DOC, null, 2), `core's PUT arrived as sent (${JSON.stringify(step('put'))})`);
    check(put.headers['content-type'] === 'application/json' && put.headers['accept-encoding'] === 'identity' && put.headers['x-nc-webdav-automkcol'] === '1',
        `the PUT carried core's headers (${JSON.stringify(put.headers)})`);
    check(step('put').value === `"${createHash('sha1').update(put.body).digest('hex')}"`, 'core read the ETag the server sent');
    check(JSON.stringify(step('get').value) === JSON.stringify(DOC), `core's GET read the document back (${JSON.stringify(step('get'))})`);
    check(step('head').ok && step('head').value === String(put.body.length) && saw('HEAD /dav/data.json').length === 1, `core's HEAD read Content-Length (${JSON.stringify(step('head'))})`);

    const bytes = saw('PUT /dav/bytes.bin')[0]?.body;
    check(step('putBytes').ok && bytes?.equals(Buffer.from(Array.from({ length: 256 }, (_, i) => i))), 'the 256 byte values arrived as sent');
    check(step('getBytes').value === true, `core read the 256 byte values back (${JSON.stringify(step('getBytes'))})`);

    const propfind = saw('PROPFIND /dav/folder/')[0];
    check(step('mkcol').ok && saw('MKCOL /dav/folder/').length === 1 && propfind?.headers.depth === '0', `MKCOL then PROPFIND (Depth 0) (${JSON.stringify(step('mkcol'))})`);

    check(!step('redirectPut').ok && step('redirectPut').error === 'fetch failed: unexpected redirect' && saw('PUT /dav/other.json').length === 0,
        `the redirected PUT was refused, its body never replayed (${failedWith('redirectPut')})`);
    check(JSON.stringify(step('redirectGet').value) === JSON.stringify(DOC) && saw('GET /dav/moved.json').length === 1, `the redirected GET followed (${JSON.stringify(step('redirectGet'))})`);
    check(step('delete').ok && saw('DELETE /dav/data.json').length === 1 && !files.has('/dav/data.json'), 'core\'s DELETE removed the document');

    check(step('headGzipDav').value === '"gz"' && step('headGzipCloud').value === '"gz"' && saw('HEAD /gz/data.json').length === 2,
        `both gzip-labelled HEADs read their ETag (${JSON.stringify([step('headGzipDav'), step('headGzipCloud')])})`);


    const cuts = [['half', /^Network request failed: /], ['reset', /^Network request failed: /],
        ['oversize', new RegExp(`^Response exceeds the ${LIMIT_BYTES} byte download limit$`)],
        ['stream', new RegExp(`^Response exceeds the ${LIMIT_BYTES} byte download limit$`)], ['gzip', /^Network request failed: /],
        ['utf8', /^The encoded data was not valid for encoding utf-8$/]];
    for (const [cut, error] of cuts) {
        check(step(`cut-${cut}`).ok === false && error.test(step(`cut-${cut}`).error) && saw(`GET /cut/${cut}.json`).length === 1,
            `a ${cut} body makes core's sync read reject (${failedWith(`cut-${cut}`)})`);
    }

    for (const [name, bytes] of Object.entries(BODIES)) {
        const read = step('bodies').value?.[name];
        const text = name === 'invalid' ? undefined : bytes.toString('utf8');
        check(read?.hex === bytes.toString('hex') && read?.text === text, `the ${name} body read back exactly (${JSON.stringify(read)})`);
    }
    const firstCut = seen.findIndex((entry) => entry.key.includes('/cut/'));
    check(seen.filter((entry) => entry.key.includes('/cut/')).length === cuts.length && seen.slice(firstCut).every((entry) => entry.key.startsWith('GET ')),
        `nothing but the ${cuts.length} reads reached /cut/, and nothing was written after them`);

    for (let i = 0; i < 10 && [...slow.values()].some((value) => value === 'open'); i += 1) await sleep(500);
    for (const [name, path, error, [low, high]] of [
        ['abort', '/slow/abort', 'AbortError: This operation was aborted', [400, 3000]],
        ['abortBody', '/slow/body', 'AbortError: This operation was aborted', [400, 3000]],
        ['timeout', '/slow/timeout', 'Error: WebDAV request timed out', [1400, 4000]],
        ['signalTimeout', '/slow/signal', 'TimeoutError: The operation timed out.', [900, 4000]],
    ]) {
        check(failedWith(name) === error && step(name).ms >= low && step(name).ms <= high, `${name}: ${failedWith(name)} after ${step(name).ms} ms`);
        check(slow.get(path) === 'closed', `${name}: the phone closed ${path} (${slow.get(path)})`);
    }
    for (const path of ['/cut/oversize.json', '/cut/stream.json']) check(slow.get(path) === 'closed', `the phone closed ${path} (${slow.get(path)})`);

    const { item, xml } = state.secret ?? {};
    check(step('secretSet').ok && step('secretGet').value === DOC.text, `the secret read back (${JSON.stringify([step('secretSet'), step('secretGet')])})`);
    check(step('secretStored').value?.found === true && item?.scheme === 'aes' && item.usesKeystoreSuffix === true && item.keystoreAlias === 'key_v1'
        && item.requireAuthentication === false && item.tlen === 128 && Buffer.from(item.iv, 'base64').length === 12
        && Buffer.from(item.ct, 'base64').length === Buffer.byteLength(DOC.text) + 16, `SecureStore.xml held expo-secure-store's item (${JSON.stringify(item)})`);
    check(!xml.includes(DOC.text), 'the saved file holds no plaintext');
    check(step('secretDelete').ok && step('secretGone').ok && step('secretGone').value === null, `the deleted secret reads as none (${JSON.stringify(step('secretGone'))})`);
    check(secretItem(secretFile()).item === null, 'SecureStore.xml no longer holds the secret');


    const limit = /Native Android fetch limit bytes=(\d+) ceiling=(\d+) heap=(\d+)/.exec(log);
    check(Number(limit?.[1]) === LIMIT_BYTES && Number(limit?.[2]) === Math.min(2 ** 30, Math.floor(Number(limit?.[3]) / 5)),
        `the host's limit is the check's, under its heap-bounded ceiling (${limit?.[0]})`);


    check(log.includes('Native Android net deadline drain events=["signal","fetch:AbortError","write:AbortError"]'),
        'the drained operation saw its signal, its cancelled fetch and its refused write');
    check(log.includes('Native Android net deadline drain: Core netDeadline timed out'), 'the host reported the drained operation as timed out');
    check(log.includes('Native Android net deadline stuck: Core host stopped: netDeadline did not end after its deadline'), 'the host stopped for the stuck operation');
    check(!log.includes('net deadline stuck events='), 'the stuck operation never ran again');
    for (const mode of ['drain', 'stuck']) {
        check(slow.get(`/slow/deadline-${mode}`) === 'closed', `${mode}: the phone closed its unanswered request (${slow.get(`/slow/deadline-${mode}`)})`);
        check(seen.every((entry) => !entry.key.includes(`/dav/after-${mode}.json`)), `${mode}: its write never reached the server`);
    }
};

const main = async () => {
    const { check, connect, evidenced, fail, Stopped } = await import('./device.mjs');
    const [serial, apkArg] = process.argv.slice(2);
    if (!serial) {
        console.error('usage: node check-net-device.mjs <adb-serial> [apk]');
        process.exit(2);
    }
    const app = resolve(import.meta.dirname, '..');
    const apk = apkArg ?? resolve(app, 'android/app/build/outputs/apk/play/debug/app-play-debug.apk');
    const adbBin = process.env.ADB ?? '/home/dd/Android/Sdk/platform-tools/adb';
    const aapt2 = process.env.AAPT2 ?? '/home/dd/Android/Sdk/build-tools/36.1.0/aapt2';
    const PKG = 'tech.dongdongbh.mindwtr.nativeclient.dev';

    const apkPackage = execFileSync(aapt2, ['dump', 'packagename', apk], { encoding: 'utf8' }).trim();
    if (apkPackage !== PKG) {
        console.error(`REFUSED: ${apk} is package "${apkPackage}", not ${PKG}`);
        process.exit(2);
    }
    const port = Number(process.env.MINDWTR_NET_CHECK_PORT ?? 18765);
    const ACTIVITY = `${PKG}/${PKG}.MainActivity`;
    const TAG = 'MindwtrNativeDev';
    const UI_FILE = '/data/local/tmp/mindwtr-native-dev-ui.xml';
    const PROPS = ['fail_commit', 'delay_before_ms', 'delay_after_ms', 'net_check', 'net_max_bytes'];

    const device = connect({ serial, pkg: PKG, uiFile: UI_FILE, adb: adbBin });
    const { sh, adbRaw, home, front, pid } = device;
    const setProp = (name, value) => sh(`setprop debug.mindwtr.native.${name} '${value}'`);
    const secretFile = () => {
        try { return adbRaw('shell', `run-as ${PKG} cat shared_prefs/SecureStore.xml`).toString('utf8'); } catch { return ''; }
    };
    let server;
    let mapped = false;
    const cleanup = cleanupOnExit([
        ...PROPS.map((name) => () => setProp(name, '')),
        () => { if (mapped) adbRaw('reverse', '--remove', `tcp:${port}`); },
        () => server?.close(),

        () => sh(`am force-stop ${PKG}`),
    ]);
    try {
        console.log(`device: ${sh('getprop ro.product.model')} / Android ${sh('getprop ro.build.version.release')} (API ${sh('getprop ro.build.version.sdk')})`);
        console.log(`apk: ${apk}\napk sha256: ${createHash('sha256').update(readFileSync(apk)).digest('hex')}`);
        for (const name of PROPS) setProp(name, '');
        const beforeInstall = front();
        if (!beforeInstall.includes(`${PKG}/`) && !beforeInstall.includes(`${home}/`)) throw new Stopped(`another app is in front: ${beforeInstall.trim()}`);
        execFileSync(adbBin, ['-s', serial, 'install', '-r', apk], { stdio: 'inherit' });
        server = await serve(port, secretFile);
        adbRaw('reverse', `tcp:${port}`, `tcp:${port}`);
        mapped = true;
        setProp('net_check', String(port));
        setProp('net_max_bytes', String(LIMIT_BYTES));


        sh(`am force-stop ${PKG}`);
        for (let i = 0; i < 20 && pid(); i += 1) await sleep(500);
        for (let i = 0; i < 20 && !front().includes(`${home}/`); i += 1) await sleep(500);
        device.launch(ACTIVITY);
        const appPid = await (async () => {
            for (let i = 0; i < 20; i += 1, await sleep(500)) if (pid()) return pid();
            return fail('the app did not start');
        })();
        const logLine = async (text, ms) => {
            for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(1000)) {
                const log = device.logs(appPid, TAG);
                const failed = log.split('\n').find((entry) => entry.includes('Native Android net check failed'));
                if (failed) fail(`the app's net check failed: ${failed}`);
                const found = log.split('\n').find((entry) => entry.includes(text));
                if (found) return found;
            }
            return fail(`timed out waiting for the app's "${text}" line`);
        };
        const line = await logLine('Native Android net check {', 90_000);

        setProp('net_check', '');
        await logLine('Native Android net deadline stuck:', 30_000);

        await sleep(8_000);
        await verify(JSON.parse(line.slice(line.indexOf('{'))), server.state, secretFile, device.logs(appPid, TAG), { check, fail });
        console.log('Net device check passed');
    } catch (error) {
        evidenced(error);
        console.error(error instanceof Stopped ? `STOPPED: ${error.message}` : `FAIL: ${error.message}`);
        process.exitCode = error instanceof Stopped ? 3 : 1;
    } finally {
        cleanup();
    }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
