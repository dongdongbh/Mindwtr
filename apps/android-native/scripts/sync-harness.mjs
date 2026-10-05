// Local sync servers and a second device on this computer, for check-sync-device.mjs (and its --dry-run, which plays the
// phone with a second device too). Nothing here reaches a real server.
//
// - serveWebdav: a WebDAV folder in memory with strong ETags and RN's conditional writes (If-Match, If-None-Match: *,
//   412), Basic auth (`open`: none, for measure-merge-device.mjs), and three faults a check can switch on: `failWrites` (a PUT of the sync document answers 500),
//   `down` (every request answers 503, as a server that went away behind a proxy) and `weakEtags` (every ETag is weak,
//   W/"…", as a server that cannot promise byte-equal versions; sync encryption must refuse it).
// - startCloud: the real self-hosted Mindwtr cloud (apps/cloud) under Bun, with one token and a scratch data folder.
// - hostDevice: the real native bundle (core-host.js) in a Node VM, on node:sqlite, an in-memory RKStorage and secret
//   store, node:http for its fetch, and @noble/hashes and node:crypto for its sync crypto: core running as a second device,
//   bound exactly as the Android host binds it.
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';

// ---- WebDAV ----

export const serveWebdav = ({ port, username, password, open = false }) => new Promise((ready) => {
    const files = new Map();
    let version = 0;
    // `requests`: every request as it arrived; `authorized`: only those that carried the folder's user and password.
    // `delayMs`: every answer waits that long (a slow server).
    const state = { files, requests: [], authorized: [], failWrites: 0, down: false, delayMs: 0, weakEtags: false };
    const authorized = (req) => open || req.headers.authorization === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => setTimeout(() => {
            const body = Buffer.concat(chunks);
            const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
            state.requests.push(`${req.method} ${path}`);
            const answer = (status, headers = {}, data = '') => {
                res.writeHead(status, headers);
                res.end(req.method === 'HEAD' ? undefined : data);
            };
            if (state.down) return answer(503, { 'Content-Type': 'text/plain' }, 'down');
            if (!authorized(req)) return answer(401, { 'WWW-Authenticate': 'Basic realm="mindwtr-test"' });
            state.authorized.push(`${req.method} ${path}`);
            const file = files.get(path);
            const ifMatch = req.headers['if-match'];
            const ifNoneMatch = req.headers['if-none-match'];
            const preconditionFails = () => (ifMatch !== undefined && (!file || file.dir || ifMatch !== file.etag))
                || (ifNoneMatch === '*' && file !== undefined);
            switch (req.method) {
                case 'GET':
                case 'HEAD':
                    if (!file || file.dir) return answer(404);
                    return answer(200, { ETag: file.etag, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.body.length) }, file.body);
                case 'PUT': {
                    if (preconditionFails()) return answer(412);
                    if (state.failWrites > 0 && path.endsWith('/data.json')) {
                        state.failWrites -= 1;
                        return answer(500, { 'Content-Type': 'text/plain' }, 'write failed');
                    }
                    const etag = `${state.weakEtags ? 'W/' : ''}"${++version}-${createHash('sha1').update(body).digest('hex').slice(0, 12)}"`;
                    files.set(path, { body, etag });
                    return answer(file ? 204 : 201, { ETag: etag });
                }
                case 'DELETE':
                    if (!file) return answer(404);
                    if (preconditionFails()) return answer(412);
                    files.delete(path);
                    return answer(204);
                case 'MKCOL':
                    if (file) return answer(405);
                    files.set(path, { dir: true });
                    return answer(201);
                case 'PROPFIND': {
                    const prefix = path.endsWith('/') ? path : `${path}/`;
                    const entries = [...files].filter(([name]) => name === path || (name.startsWith(prefix) && !name.slice(prefix.length).includes('/')));
                    if (entries.length === 0 && path !== '/') return answer(404);
                    const xml = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${entries.map(([name, entry]) => (
                        `<d:response><d:href>${encodeURI(name)}</d:href><d:propstat><d:prop>${entry.dir ? '<d:resourcetype><d:collection/></d:resourcetype>'
                            : `<d:resourcetype/><d:getetag>${entry.etag}</d:getetag><d:getcontentlength>${entry.body.length}</d:getcontentlength>`}</d:prop>`
                        + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
                    )).join('')}</d:multistatus>`;
                    return answer(207, { 'Content-Type': 'application/xml; charset=utf-8' }, xml);
                }
                default:
                    return answer(405);
            }
        }, state.delayMs));
    });
    server.listen(port, '127.0.0.1', () => ready({ server, state, close: () => new Promise((done) => server.close(done)) }));
});

/** The sync document the WebDAV folder holds now, parsed; null when there is none. */
export const webdavDocument = (dav, folder) => {
    const file = dav.state.files.get(`${folder}/data.json`);
    return file && !file.dir ? JSON.parse(file.body.toString('utf8')) : null;
};

// ---- The self-hosted cloud ----

/** apps/cloud under Bun on 127.0.0.1:[port], allowing only [token], its data under [dataDir]. */
export const startCloud = async ({ repo, port, token, dataDir }) => {
    mkdirSync(dataDir, { recursive: true });
    const child = spawn(process.env.BUN ?? 'bun', ['run', resolve(repo, 'apps/cloud/src/server.ts'), '--port', String(port), '--host', '127.0.0.1'], {
        cwd: resolve(repo, 'apps/cloud'),
        env: { ...process.env, MINDWTR_CLOUD_AUTH_TOKENS: token, MINDWTR_CLOUD_DATA_DIR: dataDir, NODE_ENV: 'development' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    for (let tries = 0; tries < 100; tries += 1) {
        if (/cloud server listening/.test(output)) {
            return { child, output: () => output, stop: () => new Promise((done) => { child.once('exit', done); child.kill('SIGTERM'); }) };
        }
        if (child.exitCode !== null) throw new Error(`cloud server exited: ${output}`);
        await sleep(100);
    }
    child.kill('SIGTERM');
    throw new Error(`cloud server did not start: ${output}`);
};

// ---- A second device: the native bundle in a Node VM ----

/**
 * core-host.js as the Android host runs it, with Node standing in for its Kotlin bridges: SqliteBridge (node:sqlite, one
 * connection), RnKeyValue (a Map), SecretStore (a Map), HostIo's fetch (node:http, OkHttp's redirect rules, whole bodies
 * only), and CoreHost's pumps: [call] waits on its own operation as callAsync does; an idle pump runs timers and settles
 * answers between calls, as CoreHost's does.
 */
export const hostDevice = async ({ bundle, name, log = () => {}, filesRoot }) => {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(':memory:');
    const keyValue = new Map();
    const secrets = new Map();
    const answers = [];
    const events = [];
    const lines = [];
    let taken = '';
    let ids = 0;
    const controllers = new Map();
    const params = (json) => JSON.parse(json).map((value) => (typeof value === 'boolean' ? Number(value) : value));
    const guarded = (work) => (...args) => {
        try { return work(...args); } catch (error) { return `!MindwtrNativeError:${error.message}`; }
    };
    const bridge = {
        sqlRun: guarded((sql, json) => { database.prepare(sql).all(...params(json)); return null; }),
        sqlAll: guarded((sql, json) => JSON.stringify(database.prepare(sql).all(...params(json)))),
        sqlExec: guarded((sql) => { database.exec(sql); return null; }),
        nowMs: () => performance.now(),
        randomBytes: (n) => JSON.stringify([...randomBytes(n)]),
        log: (line) => { lines.push(String(line)); log(`${name}: ${line}`); },
        collationKey: (text) => text,
        rnStateCommit: () => null,
        logFile: () => '',
        kvGet: (key) => JSON.stringify([keyValue.get(key) ?? null]),
        kvSet: (key, value) => { keyValue.set(key, value); return null; },
        kvRemove: (key) => { keyValue.delete(key); return null; },
        kvMultiGet: (json) => JSON.stringify(JSON.parse(json).map((key) => [key, keyValue.get(key) ?? null])),
        kvMultiSet: (json) => { for (const [key, value] of JSON.parse(json)) keyValue.set(key, value); return null; },
        kvMultiRemove: (json) => { for (const key of JSON.parse(json)) keyValue.delete(key); return null; },
        hostEvent: (json) => { events.push(JSON.parse(json)); return null; },
        netFetch(json) {
            const request = JSON.parse(json);
            const id = String(++ids);
            const controller = new AbortController();
            controllers.set(id, controller);
            let body = request.text !== undefined ? Buffer.from(request.text) : request.base64 !== undefined ? Buffer.from(request.base64, 'base64') : undefined;
            const send = (url, method, hops) => new Promise((done, failed) => {
                const req = httpRequest(url, { method, headers: Object.fromEntries(request.headers), signal: controller.signal }, (res) => {
                    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                        res.resume();
                        if (request.redirect === 'error') return failed(Object.assign(new Error('fetch failed: unexpected redirect'), { own: true }));
                        if (request.redirect === 'follow' && hops < 20) {
                            if (res.statusCode < 307 && method !== 'PROPFIND') { method = 'GET'; body = undefined; }
                            return send(new URL(res.headers.location, url).toString(), method, hops + 1).then(done, failed);
                        }
                    }
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('error', failed);
                    res.on('end', () => {
                        if (!res.complete) return failed(new Error('unexpected end of stream'));
                        try {
                            let bytes = Buffer.concat(chunks);
                            const bodiless = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304 || res.headers['content-length'] === '0';
                            if (!bodiless && res.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes);
                            done({ id, status: res.statusCode, statusText: res.statusMessage, url, redirected: hops > 0,
                                headers: Object.entries(res.headers).map(([header, value]) => [header, String(value)]), base64: bytes.toString('base64') });
                        } catch (error) { failed(error); }
                    });
                });
                req.on('error', failed);
                req.end(method === 'GET' || method === 'HEAD' ? undefined : body);
            });
            send(request.url, request.method, 0)
                .catch((error) => ({ id, error: error.own ? error.message : controller.signal.aborted ? 'Request cancelled' : `Network request failed: ${error.message}` }))
                .then(({ base64, ...answer }) => answers.push(base64 === undefined ? { json: JSON.stringify(answer) } : { json: JSON.stringify({ ...answer, body: true }), body: base64 }));
            return id;
        },
        netAbort(id) { controllers.get(id)?.abort(); return null; },
        // HostCrypto.kt's Argon2id and AES-GCM with core's reference implementations (@noble/hashes, as core's own default, and
        // OpenSSL's AES-GCM): what this device seals, the phone's BouncyCastle must open, and the other way round.
        cryptoCall(json) {
            const request = JSON.parse(json);
            const id = String(++ids);
            const b = (field) => Buffer.from(request[field], 'base64');
            setTimeout(() => {
                const auth = () => Object.assign(new Error('wrong passphrase or corrupted data'), { auth: true });
                try {
                    let out;
                    if (request.op === 'argon2id') out = argon2id(b('pass'), b('salt'), { m: request.m, t: request.t, p: request.p, dkLen: request.dkLen });
                    else if (request.op === 'aesGcmSeal') {
                        const cipher = createCipheriv('aes-256-gcm', b('key'), b('nonce')).setAAD(b('aad'));
                        out = Buffer.concat([cipher.update(b('data')), cipher.final(), cipher.getAuthTag()]);
                    } else if (request.op === 'aesGcmOpen') {
                        const data = b('data');
                        if (data.length < 16) throw auth();
                        const decipher = createDecipheriv('aes-256-gcm', b('key'), b('nonce')).setAAD(b('aad'));
                        decipher.setAuthTag(data.subarray(data.length - 16));
                        try { out = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]); } catch { throw auth(); }
                    } else throw new Error(`Unsupported crypto call ${request.op}`);
                    answers.push({ json: JSON.stringify({ id, body: true }), body: Buffer.from(out).toString('base64') });
                } catch (error) {
                    answers.push({ json: JSON.stringify({ id, error: error.message, ...(error.auth ? { auth: true } : {}) }) });
                }
            }, 1);
            return id;
        },
        secretCall(json) {
            const { op, key, value } = JSON.parse(json);
            const id = String(++ids);
            if (op === 'set') secrets.set(key, value);
            if (op === 'delete') secrets.delete(key);
            setTimeout(() => answers.push({ json: JSON.stringify({ id, value: op === 'get' ? secrets.get(key) ?? null : null }) }), 2);
            return id;
        },
        // HostFiles.kt's attachment file port and HostInstaller.kt's install and hash, on a folder of this computer: the second
        // device's files/ and cache/ (each call answered through the pump, as on the phone).
        fileDirectories: () => JSON.stringify({ document: `file://${files.dir}/`, cache: `file://${files.cache}/` }),
        fileCall: (json) => files.answer(json, files.call),
        installerCall: (json) => files.answer(json, files.install),
        fileDeleteNow: (uri) => { rmSync(files.path(uri), { recursive: true, force: true }); return null; },
        fileAbort: () => null,
        ioNext: () => {
            const next = answers.shift();
            taken = next?.body ?? '';
            return next?.json ?? '';
        },
        ioBody: () => taken,
    };
    const root = filesRoot ?? mkdtempSync(resolve(tmpdir(), `mindwtr-${name}-`));
    const files = {
        dir: resolve(root, 'files'),
        cache: resolve(root, 'cache'),
        path: (uri) => {
            if (!uri.startsWith('file:///')) throw new Error('Not an app file URI');
            const path = decodeURIComponent(uri.slice('file://'.length));
            if (!path.startsWith(`${root}/`)) throw new Error('Not an app file URI');
            return path;
        },
        missing: () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
        call: (request, bytes) => {
            if (request.op === 'sha256') return { value: createHash('sha256').update(bytes ?? Buffer.alloc(0)).digest('hex') };
            if (request.op === 'barrier' || request.op === 'syncParent') return { value: null };
            const path = files.path(request.uri);
            switch (request.op) {
                case 'sha256File': if (!existsSync(path)) throw files.missing(); return { value: createHash('sha256').update(readFileSync(path)).digest('hex') };
                case 'getInfo': {
                    if (!existsSync(path)) return { value: { exists: false, isDirectory: false, uri: request.uri } };
                    const info = statSync(path);
                    return { value: { exists: true, isDirectory: info.isDirectory(), uri: request.uri, size: info.isDirectory() ? 0 : info.size, modificationTime: Math.floor(info.mtimeMs) / 1000 } };
                }
                case 'makeDirectory': mkdirSync(path, { recursive: true }); return { value: null };
                case 'readDirectory': if (!existsSync(path)) throw files.missing(); return { value: readdirSync(path) };
                case 'readBytes': if (!existsSync(path)) throw files.missing(); return { bytes: readFileSync(path) };
                case 'readBytesRange': if (!existsSync(path)) throw files.missing(); return { bytes: readFileSync(path).subarray(request.position, request.position + request.length) };
                case 'writeBytes': writeFileSync(path, bytes ?? Buffer.alloc(0)); return { value: null };
                case 'copy': copyFileSync(path, files.path(request.to)); return { value: null };
                case 'move': if (!existsSync(path)) throw files.missing(); renameSync(path, files.path(request.to)); return { value: null };
                case 'delete': rmSync(path, { recursive: true, force: true }); return { value: null };
                default: throw new Error(`Unsupported file call ${request.op}`);
            }
        },
        // RN's installer's outcomes for a fresh install: the staged bytes become the target unless another generation is there.
        install: (request) => {
            const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
            if (request.op === 'hash') {
                const path = files.path(request.path.startsWith('file://') ? request.path : `file://${request.path}`);
                const info = statSync(path);
                return { value: { sha256: sha(path), size: info.size, modificationTimeMs: info.mtimeMs } };
            }
            const staged = files.path(request.staged.startsWith('file://') ? request.staged : `file://${request.staged}`);
            const target = files.path(request.target.startsWith('file://') ? request.target : `file://${request.target}`);
            if (sha(staged) !== request.expectedDownloadSha256) throw new Error('Staged attachment changed before native snapshot');
            if (existsSync(target) && (request.expected.kind === 'absent' ? sha(target) !== request.expectedDownloadSha256 : sha(target) !== request.expected.sha256)) {
                return { value: { status: 'conflict', preservedPath: `file://${staged}` } };
            }
            renameSync(staged, target);
            return { value: { status: 'installed' } };
        },
        answer: (json, run) => {
            const id = String(++ids);
            setTimeout(() => {
                const request = JSON.parse(json);
                const bytes = request.base64 === undefined ? undefined : Buffer.from(request.base64, 'base64');
                delete request.base64;
                try {
                    const result = run(request, bytes);
                    answers.push(result.bytes ? { json: JSON.stringify({ id, value: null, body: true }), body: Buffer.from(result.bytes).toString('base64') }
                        : { json: JSON.stringify({ id, value: result.value ?? null }) });
                } catch (error) {
                    answers.push({ json: JSON.stringify({ id, error: error.message }) });
                }
            }, 1);
            return id;
        },
    };
    mkdirSync(files.dir, { recursive: true });
    mkdirSync(files.cache, { recursive: true });
    const context = vm.createContext({ console: {}, Intl: undefined, __mindwtrNative: bridge });
    vm.runInContext(readFileSync(bundle, 'utf8'), context);
    const host = context.MindwtrHost;
    // CoreHost's idle pump, and callAsync's wait on one operation.
    const pump = setInterval(() => { try { context.__pumpTimers(); } catch (error) { log(`${name}: pump ${error}`); } }, 10);
    const call = async (method, ...args) => {
        const id = host[method](...args);
        for (const deadline = Date.now() + 10 * 60_000; Date.now() < deadline; await sleep(5)) {
            context.__pumpTimers();
            const answer = host.poll(id);
            if (answer) {
                const reply = JSON.parse(answer);
                if (!reply.ok) throw new Error(reply.error);
                return reply.value;
            }
        }
        throw new Error(`${name}: ${method} timed out`);
    };
    const device = {
        name, keyValue, secrets, events, lines, files,
        /** Live task rows straight from this device's database: id, title, status, rev. */
        tasks: () => database.prepare("SELECT id, title, status, rev FROM tasks WHERE COALESCE(deletedAt, '') = '' ORDER BY id").all().map((row) => ({ ...row })),
        call,
        stop: () => { clearInterval(pump); database.close(); },
        /** Boots on an empty database, reports the network online, and starts sync as ProcessCoreHost does. */
        async boot() {
            await call('boot', '', '', '');
            await call('language', 'en', 'en-US');
            await call('syncNetwork', JSON.stringify({ isConnected: true, isInternetReachable: true }));
            return call('syncStart', 'active');
        },
        /** A Sync screen command (CoreHost.syncCommand). */
        sync: (command, input = {}) => call('menuCommand', command, JSON.stringify(input)),
        view: (draft = {}) => call('menuRead', 'syncSettings', JSON.stringify({ draft })),
        /** RN's quick capture: one new Inbox task titled [title]. */
        async capture(title) {
            const opened = await call('captureOpen');
            return call('captureSubmit', JSON.stringify({ text: title, options: opened.options, captureId: randomUUID(), openAfterSave: false }));
        },
        /** Every Inbox title, window by window at one revision (the phone's library outgrows one window). */
        async titles() {
            const first = await call('window', 0, 100, '');
            const rows = [...first.rows];
            while (rows.length < first.total) {
                const next = await call('window', rows.length, 100, first.revision);
                if (next.rows.length === 0) break;
                rows.push(...next.rows);
            }
            return rows.map((row) => row.title);
        },
        /** Configures [kind] ('webdav' or 'selfhosted') from the Sync screen as a user does: choose, fill, Save. */
        async configure(kind, fields) {
            await device.sync('openSyncSettings');
            await device.sync('selectSyncBackend', { requestId: randomUUID(), option: kind });
            const view = await device.view();
            return device.sync('saveSyncBackend', { requestId: randomUUID(), revision: view.configRevision, [kind === 'webdav' ? 'webdav' : 'selfHosted']: fields });
        },
        async syncNow(kind, fields) {
            const view = await device.view();
            return device.sync('syncNow', { requestId: randomUUID(), revision: view.configRevision, [kind === 'webdav' ? 'webdav' : 'selfHosted']: fields });
        },
    };
    return device;
};

export const newTitle = (prefix) => `${prefix} ✓ Grüße 😀 ${randomUUID().slice(0, 8)}`;
