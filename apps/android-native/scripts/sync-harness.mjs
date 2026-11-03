


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


export { serveWebdav, webdavDocument } from './webdav-harness.mjs';


export const startCloud = async ({ repo, port, token, dataDir }) => {
    mkdirSync(dataDir, { recursive: true });
    const child = spawn(process.env.BUN ?? 'bun', ['run', resolve(repo, 'apps/cloud/src/server.ts'), '--port', String(port), '--host', '127.0.0.1'], {
        cwd: resolve(repo, 'apps/cloud'),
        env: { ...process.env, MINDWTR_CLOUD_AUTH_TOKENS: token, MINDWTR_CLOUD_DATA_DIR: dataDir, MINDWTR_CLOUD_MAX_BODY_BYTES: '64000000', NODE_ENV: 'development' },
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


export const hostDevice = async ({
    bundle, name, log = () => {}, filesRoot, automaticSync = true, trace, onSql,
    database: databasePath = ':memory:', keyValue = new Map(), secrets = new Map(), nativeSubscribers = false, gmail = false,
}) => {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(databasePath);
    let dead = false;
    const answers = [];
    const events = [];
    const lines = [];
    const published = [];
    let taken = '';
    let ids = 0;
    const controllers = new Map();
    const params = (json) => JSON.parse(json).map((value) => (typeof value === 'boolean' ? Number(value) : value));
    const guarded = (work) => (...args) => {
        try { return work(...args); } catch (error) { return `!MindwtrNativeError:${error.message}`; }
    };

    const fault = (sql, phase, json) => {
        if (dead) throw new Error('the process is dead');
        const answer = onSql?.(sql, phase, json);
        if (answer === 'kill') { device.kill(); throw new Error('the process is dead'); }
        if (answer === 'fail') throw new Error(`injected fault at: ${sql.slice(0, 60)}`);
    };
    const statement = (sql, run, json = '') => { fault(sql, 'before', json); const result = run(); fault(sql, 'after', json); return result; };
    const bridge = {
        sqlRun: guarded((sql, json) => statement(sql, () => { database.prepare(sql).all(...params(json)); return null; }, json)),
        sqlAll: guarded((sql, json) => statement(sql, () => JSON.stringify(database.prepare(sql).all(...params(json))), json)),
        sqlExec: guarded((sql) => statement(sql, () => { database.exec(sql); return null; })),
        nowMs: () => performance.now(),
        randomBytes: (n) => JSON.stringify([...randomBytes(n)]),
        log: (line) => { lines.push(String(line)); log(`${name}: ${line}`); },
        ...(trace ? { trace: (section) => { trace(section); return null; } } : {}),
        ...(nativeSubscribers ? {
            widgetInputs: () => JSON.stringify({ systemColorScheme: 'light', systemLocale: 'en-US', listSelections: [] }),
            widgetPublish: (payload) => { published.push(['widget', payload.length]); return null; },
            widgetAppState: () => 'active',
            alarmApply: (plan) => { published.push(['alarms', plan.length]); return null; },
            notificationsAllowed: () => true,
            rnAlarmCleanup: () => 0,
            reminderReceiverCounts: () => JSON.stringify({ dropped: 0, notQueued: 0 }),
            reminderLedger: () => JSON.stringify({ fired: [], shown: [] }),
        } : {}),
        ...(gmail ? {
            gmailCall(json) {
                const id = String(++ids);
                const { op } = JSON.parse(json);
                setTimeout(() => answers.push({ json: JSON.stringify(op === 'status'
                    ? { id, value: { available: false, connected: false, account: null, accountId: null } } : { id, error: 'E_GMAIL_CONFIG' }) }), 1);
                return id;
            },
            gmailFile: guarded(() => { throw new Error('No Gmail receipts file in this build'); }),
            gmailSql: guarded(() => { throw new Error('No Gmail receipts file in this build'); }),
        } : {}),
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


        fileDirectories: () => JSON.stringify({ document: `file://${files.dir}/`, cache: `file://${files.cache}/` }),
        fileCall: (json) => files.answer(json, files.call),
        installerCall: (json) => files.answer(json, files.install),
        fileDeleteNow: (uri) => { rmSync(files.path(uri), { recursive: true, force: true }); return null; },

        fileList: guarded((path) => {
            const dir = files.relative(path);
            if (!existsSync(dir) || !statSync(dir).isDirectory()) return 'null';
            return JSON.stringify(readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name));
        }),
        fileRead: guarded((path) => readFileSync(files.relative(path), 'utf8')),
        fileDelete: guarded((path) => { rmSync(files.relative(path), { force: true }); return null; }),
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
        relative: (path) => {
            const [top, ...rest] = path.split('/');
            const base = top === 'files' ? files.dir : top === 'cache' ? files.cache : null;
            if (!base) throw new Error(`Not an app file: ${path}`);
            const file = resolve(base, rest.join('/'));

            if (!file.startsWith(`${base}/`)) throw new Error(`Not an app file: ${path}`);
            return file;
        },
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
                if (dead) return;
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

    for (const [method, work] of Object.entries(bridge)) {
        if (typeof work === 'function') bridge[method] = (...args) => { if (dead) throw new Error('the process is dead'); return work(...args); };
    }
    const context = vm.createContext({ console: {}, Intl: undefined, __mindwtrNative: bridge });
    vm.runInContext(readFileSync(bundle, 'utf8'), context);
    const host = context.MindwtrHost;


    let pumping = true;
    const pump = setInterval(() => { if (!pumping || dead) return; try { context.__pumpTimers(); } catch (error) { log(`${name}: pump ${error}`); } }, 10);
    const call = async (method, ...args) => {
        if (dead) throw new Error(`${name}: killed`);
        const id = host[method](...args);
        for (const deadline = Date.now() + 10 * 60_000; Date.now() < deadline; await sleep(5)) {
            if (dead) throw new Error(`${name}: killed`);
            if (pumping) context.__pumpTimers();
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
        name, keyValue, secrets, events, lines, files, published,

        tasks: () => database.prepare("SELECT id, title, status, rev FROM tasks WHERE COALESCE(deletedAt, '') = '' ORDER BY id").all().map((row) => ({ ...row })),

        methods: Object.keys(host),
        call,
        stop: () => { clearInterval(pump); if (!dead) database.close(); },
        freeze: () => { pumping = false; },
        thaw: () => { pumping = true; },

        pumpOnce: () => context.__pumpTimers(),
        inTransaction: () => database.isTransaction,
        query: (sql, ...values) => database.prepare(sql).all(...values).map((row) => ({ ...row })),

        kill: () => {
            if (dead) return;
            dead = true;
            clearInterval(pump);
            database.close();
        },


        async boot(writeJournal = '') {
            await call('boot', '', '', writeJournal);
            await call('language', 'en', 'en-US');
            await call('syncNetwork', JSON.stringify({ isConnected: true, isInternetReachable: true }));
            return automaticSync ? call('syncStart', 'active') : null;
        },

        sync: (command, input = {}) => call('menuCommand', command, JSON.stringify(input)),
        view: (draft = {}) => call('menuRead', 'syncSettings', JSON.stringify({ draft })),

        async capture(title) {
            const opened = await call('captureOpen');
            return call('captureSubmit', JSON.stringify({ text: title, options: opened.options, captureId: randomUUID(), openAfterSave: false }));
        },


        async titles() {
            for (let attempt = 0; ; attempt += 1) {
                try {
                    const first = await call('window', 0, 100, '');
                    const rows = [...first.rows];
                    while (rows.length < first.total) {
                        const next = await call('window', rows.length, 100, first.revision);
                        if (next.rows.length === 0) break;
                        rows.push(...next.rows);
                    }
                    return rows.map((row) => row.title);
                } catch (error) {
                    if (attempt >= 10 || !String(error.message).startsWith('STALE_REVISION')) throw error;
                    log(`${name}: the Inbox changed while paging; restarting at offset zero`);
                }
            }
        },

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
